// CLI 轉接器：以子程序執行 claude / codex / gemini 等已登入的命令列工具。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const isWin = process.platform === 'win32';

function buildArgs(cli, agent, prompt) {
  const model = (agent.model || '').trim();
  const modelArgs = model ? (cli.modelArgs || []).map((a) => a.replace('{model}', model)) : [];
  const out = [];
  let placed = false;
  for (const a of cli.args || []) {
    if (a === '{modelArgs}') { out.push(...modelArgs); placed = true; continue; }
    out.push(cli.promptVia === 'arg' ? a.replace('{prompt}', prompt) : a);
  }
  if (!placed) out.push(...modelArgs);
  return out;
}

/*
 * Windows：找出指令真正的位置，盡量不經過 cmd.exe（cmd 會弄壞換行、引號與中文長參數）。
 *  - .exe（例如原生安裝的 claude.exe）→ 直接執行
 *  - npm 安裝的 .cmd 外殼 → 解析出背後的 .js，用 node 直接執行
 *  - 其他 → 退回用 shell 執行
 */
function resolveCommand(command) {
  if (!isWin) return { file: command, prefix: [], shell: false };
  const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT').toLowerCase().split(';').filter(Boolean);
  const dirs = (process.env.PATH || '').split(';').filter(Boolean);
  dirs.push(path.join(os.homedir(), '.local', 'bin'));
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
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
  return { file: command, prefix: [], shell: true };
}

// 退回 shell 時才需要：把參數加上引號
function quoteForCmd(arg) {
  if (/^[\w\-./:=@\\]+$/.test(arg)) return arg;
  return '"' + String(arg).replace(/\r?\n/g, ' ').replace(/"/g, '\\"') + '"';
}

function spawnResolved(command, args, opts) {
  const r = resolveCommand(command);
  let finalArgs = r.prefix.concat(args);
  if (r.shell) finalArgs = finalArgs.map(quoteForCmd);
  const file = r.shell && r.file.includes(' ') ? `"${r.file}"` : r.file;
  return spawn(file, finalArgs, { ...opts, shell: r.shell, windowsHide: true });
}

function runCli({ cli, agent, prompt, cwd, env, signal, onChunk, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    if (!cli) return reject(new Error(`${agent.engine} 沒有 CLI 接法，請改用 API 模式`));
    const args = buildArgs(cli, agent, prompt);

    let child;
    try {
      child = spawnResolved(cli.command, args, { cwd, env: { ...process.env, NO_COLOR: '1', ...env } });
    } catch (e) {
      return reject(new Error(`無法啟動 ${cli.command}：${e.message}`));
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, val) => { if (!settled) { settled = true; clearTimeout(timer); fn(val); } };
    const kill = () => { try { child.kill(); } catch (_) { /* ignore */ } };

    const timer = setTimeout(() => { kill(); finish(reject, new Error(`${cli.command} 逾時（${Math.round(timeoutMs / 1000)} 秒）`)); }, timeoutMs);
    if (signal) signal.addEventListener('abort', () => { kill(); finish(reject, new Error('aborted')); }, { once: true });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; if (onChunk) onChunk(d); });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      const hint = e.code === 'ENOENT' ? `找不到指令「${cli.command}」，請確認已安裝；剛裝好的話請關掉 AI Office 再重開` : e.message;
      finish(reject, new Error(hint));
    });
    child.on('close', (code) => {
      if (code === 0) return finish(resolve, stdout);
      const msg = (stderr || stdout).trim().slice(-800);
      const notFound = isWin && /is not recognized|不是內部或外部命令/.test(msg);
      finish(reject, new Error(notFound
        ? `找不到指令「${cli.command}」，請確認已安裝；剛裝好的話請關掉 AI Office 再重開`
        : `${cli.command} 結束碼 ${code}：${msg}`));
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
    } catch (e) { return resolve({ ok: false, detail: e.message }); }
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

module.exports = { runCli, checkCommand, buildArgs, resolveCommand };
