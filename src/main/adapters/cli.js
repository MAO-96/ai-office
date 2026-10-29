// CLI 轉接器：以子程序執行 claude / codex / gemini 等已登入的命令列工具。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const isWin = process.platform === 'win32';

function buildArgs(cli, agent, prompt, { write = false } = {}) {
  const model = (agent.model || '').trim();
  const modelArgs = model ? (cli.modelArgs || []).map((a) => a.replace('{model}', model)) : [];
  // 只有「改版」流程會開啟寫入權限（例如 Claude 的 acceptEdits、Codex 的 workspace-write）
  const writeArgs = write ? (cli.writeArgs || []) : [];
  const out = [];
  let placedModel = false;
  let placedWrite = false;
  for (const a of cli.args || []) {
    if (a === '{modelArgs}') { out.push(...modelArgs); placedModel = true; continue; }
    if (a === '{writeArgs}') { out.push(...writeArgs); placedWrite = true; continue; }
    out.push(cli.promptVia === 'arg' ? a.replace('{prompt}', prompt) : a);
  }
  if (!placedModel) out.push(...modelArgs);
  if (!placedWrite) out.push(...writeArgs);
  return out;
}

/*
 * Windows：找出指令真正的位置，盡量不經過 cmd.exe（cmd 會弄壞換行、引號與中文長參數）。
 *  - .exe（例如原生安裝的 claude.exe）→ 直接執行
 *  - npm 安裝的 .cmd 外殼 → 解析出背後的 .js，用 node 直接執行
 *  - 其他 → 退回用 shell 執行
 */
// 從登錄檔讀最新的 PATH（剛安裝的程式會改登錄檔，但已開著的程式拿到的還是舊 PATH）
function expandEnv(str) {
  return str.replace(/%([^%]+)%/g, (m, k) => {
    const hit = Object.keys(process.env).find((x) => x.toLowerCase() === k.toLowerCase());
    return hit ? process.env[hit] : m;
  });
}
function registryPath(key) {
  try {
    const r = spawnSync('reg', ['query', key, '/v', 'Path'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const m = (r.stdout || '').match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i);
    return m ? expandEnv(m[1].trim()).split(';') : [];
  } catch (_) { return []; }
}
function searchDirs() {
  const dirs = []
    .concat((process.env.PATH || '').split(';'))
    .concat(registryPath('HKCU\\Environment'))
    .concat(registryPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'))
    .concat([
      path.join(os.homedir(), '.local', 'bin'),
      process.env.APPDATA && path.join(process.env.APPDATA, 'npm'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'agy', 'bin'),
    ]);
  return [...new Set(dirs.filter(Boolean).map((d) => d.trim().replace(/[\\/]+$/, '')))].filter(Boolean);
}

function resolveCommand(command) {
  if (!isWin) return { file: command, prefix: [], shell: false };
  const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT').toLowerCase().split(';').filter(Boolean);
  const dirs = searchDirs();
  const hasExt = path.extname(command) !== '';
  for (const dir of dirs) {
    for (const ext of hasExt ? [''] : exts) {
      const full = path.join(dir, command + ext);
      if (!fs.existsSync(full)) continue;
      const e = path.extname(full).toLowerCase();
      if (e === '.exe' || e === '.com') return { file: full, prefix: [], shell: false };
      if (e === '.cmd' || e === '.bat') {
        try {
          const text = fs.readFileSync(full, 'utf8');
          const m = text.match(/"%(?:~)?dp0%?\\?([^"%]+\.(?:js|mjs|cjs))"/i);
          if (m) {
            const js = path.join(dir, m[1]);
            if (fs.existsSync(js)) {
              const node = process.versions.electron ? 'node' : process.execPath;
              return { file: node, prefix: [js], shell: false };
            }
          }
        } catch (_) { /* 讀不到就用 shell */ }
        return { file: full, prefix: [], shell: true };
      }
    }
  }
  return { notFound: true };
}

// 退回 shell 時才需要：把參數加上引號
function quoteForCmd(arg) {
  if (/^[\w\-./:=@\\]+$/.test(arg)) return arg;
  return '"' + String(arg).replace(/\r?\n/g, ' ').replace(/"/g, '\\"') + '"';
}

class NotFoundError extends Error {}

// CLI 輸出是 UTF-8，但中文 Windows 系統訊息是 Big5；先試 UTF-8，失敗再用 Big5
function decode(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (_) { /* 非 UTF-8 */ }
  if (isWin) { try { return new TextDecoder('big5').decode(buf); } catch (_) { /* 沒有 big5 支援 */ } }
  return buf.toString('utf8');
}

function spawnResolved(command, args, opts) {
  const r = resolveCommand(command);
  if (r.notFound) throw new NotFoundError(command);
  let finalArgs = r.prefix.concat(args);
  if (r.shell) finalArgs = finalArgs.map(quoteForCmd);
  const file = r.shell && r.file.includes(' ') ? `"${r.file}"` : r.file;
  return spawn(file, finalArgs, { ...opts, shell: r.shell, windowsHide: true });
}

function notInstalledMsg(cli) {
  const how = cli.install ? `\n請開 PowerShell 執行：${cli.install}\n裝好後執行一次「${cli.command}」完成登入，再回來重新測試。` : '';
  return `這台電腦找不到「${cli.command}」，還沒安裝。${how}`;
}

function runCli({ cli, agent, prompt, cwd, env, signal, onChunk, timeoutMs = DEFAULT_TIMEOUT_MS, write = false }) {
  return new Promise((resolve, reject) => {
    if (!cli) return reject(new Error(`${agent.engine} 沒有 CLI 接法，請改用 API 模式`));
    const args = buildArgs(cli, agent, prompt, { write });

    let child;
    try {
      child = spawnResolved(cli.command, args, { cwd, env: { ...process.env, NO_COLOR: '1', ...env } });
    } catch (e) {
      if (e instanceof NotFoundError) return reject(new Error(notInstalledMsg(cli)));
      return reject(new Error(`無法啟動 ${cli.command}：${e.message}`));
    }

    let stdout = '';
    const errBufs = [];
    let settled = false;
    const finish = (fn, val) => { if (!settled) { settled = true; clearTimeout(timer); fn(val); } };
    const kill = () => { try { child.kill(); } catch (_) { /* ignore */ } };

    const timer = setTimeout(() => { kill(); finish(reject, new Error(`${cli.command} 逾時（${Math.round(timeoutMs / 1000)} 秒）`)); }, timeoutMs);
    if (signal) signal.addEventListener('abort', () => { kill(); finish(reject, new Error('aborted')); }, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; if (onChunk) onChunk(d); });
    child.stderr.on('data', (d) => { errBufs.push(d); });
    child.on('error', (e) => {
      const hint = e.code === 'ENOENT' ? notInstalledMsg(cli) : e.message;
      finish(reject, new Error(hint));
    });
    child.on('close', (code) => {
      if (code === 0) return finish(resolve, stdout);
      const msg = (decode(Buffer.concat(errBufs)) || stdout).trim().slice(-800);
      if (/\b429\b|quota|rate.?limit|exceeded your current|usage limit/i.test(msg)) {
        const detail = (msg.match(/limit:\s*\d+[^\n]*?(?:per day|per minute)?/i) || [''])[0];
        return finish(reject, new Error(`${cli.command} 的使用額度用完了（429）。${cli.quotaHint || '請稍後再試，或到該服務的帳號頁面查看方案額度。'}${detail ? `\n（${detail.slice(0, 120)}）` : ''}`));
      }
      if (/not (?:logged|signed) in|unauthori[sz]ed|\b401\b|please (?:log ?in|sign in|authenticate)|authentication required/i.test(msg)) {
        return finish(reject, new Error(`${cli.command} 尚未登入或登入已過期。請在 PowerShell 執行「${cli.command}」重新登入一次，再回來測試。`));
      }
      finish(reject, new Error(`${cli.command} 執行失敗（結束碼 ${code}）：${(msg || '沒有錯誤訊息').slice(-400)}`));
    });
    child.stdin.on('error', () => { /* 程式提早結束時忽略 */ });

    if (cli.promptVia === 'arg') child.stdin.end();
    else child.stdin.end(prompt, 'utf8');
  });
}

function checkCommand(command) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawnResolved(command, ['--version'], {});
    } catch (e) { return resolve({ ok: false, detail: e instanceof NotFoundError ? '未安裝' : e.message }); }
    const t = setTimeout(() => { try { child.kill(); } catch (_) { /* ignore */ } resolve({ ok: false, detail: '逾時' }); }, 20000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(t); resolve({ ok: false, detail: '未安裝' }); });
    child.on('close', (code) => {
      clearTimeout(t);
      const first = out.trim().split('\n')[0] || `結束碼 ${code}`;
      resolve(code === 0 ? { ok: true, detail: first } : { ok: false, detail: /not recognized|不是內部/.test(out) ? '未安裝' : first });
    });
  });
}

module.exports = { runCli, checkCommand, buildArgs, resolveCommand, spawnResolved };
