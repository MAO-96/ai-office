// 改版引擎：讓 AI Office 的成員修改 AI Office 自己的程式碼，測試通過、你確認後發布到 GitHub。
//
// 流程：準備開發副本 → 企劃寫規格 → 工程改程式 → 自動測試（失敗則修一輪）→ 審查 → 等你確認 → commit + push
// 開發副本放在 <使用者資料夾>/dev/ai-office，和正在執行的 AI Office 分開，改壞不影響使用。
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const APP_ROOT = path.join(__dirname, '..', '..');
const MAX_DIFF_CHARS = 40000;

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function bumpPatch(v) {
  const p = String(v || '0.0.0').split('.').map((n) => parseInt(n, 10) || 0);
  return `${p[0] || 0}.${p[1] || 0}.${(p[2] || 0) + 1}`;
}
function tail(s, n) { s = String(s || ''); return s.length > n ? '…' + s.slice(-n) : s; }

function createDevOps({ store, board, emit, runner, userDataDir, isOrchestratorBusy, remoteOverride }) {
  const devDir = path.join(userDataDir, 'dev', 'ai-office');
  let state = idle();
  let ctrl = null;
  const children = new Set();

  function idle() { return { phase: 'idle', request: '', steps: [], result: null, error: null, startedAt: null, roles: null }; }
  function snapshot() { return JSON.parse(JSON.stringify({ ...state, devDir })); }
  function push() { emit('devops', snapshot()); }
  function log(text, kind = 'system', agentId = null) { emit('log', { agentId, kind, text: `［改版］${text}` }); }

  const STEP_NAMES = { prepare: '準備開發副本', plan: '撰寫規格', implement: '修改程式', test: '自動測試', fix: '修正錯誤', review: '審查修改', confirm: '等你確認發布', publish: '發布到 GitHub' };
  function setStep(key, status, detail) {
    let s = state.steps.find((x) => x.key === key);
    if (!s) { s = { key, name: STEP_NAMES[key], status: 'todo', detail: '' }; state.steps.push(s); }
    s.status = status;
    if (detail != null) s.detail = String(detail).slice(0, 4000);
    push();
    syncBoard(key, status, detail);
  }

  // ---------- 任務板同步 ----------
  let boardIds = {};
  function initBoard(request, roles) {
    boardIds = {};
    try {
      const proj = board.upsertProject({ title: `改版：${request.slice(0, 60)}` });
      boardIds.project = proj.id;
      const mk = (key, title, agentId, room) => {
        const t = board.upsertTask({ title, agentId, room, projectId: proj.id });
        boardIds[key] = t.id;
      };
      mk('plan', '撰寫改版規格', roles.planner, null);
      mk('implement', '修改 AI Office 程式', roles.implementer, null);
      mk('test', '自動測試', null, 'review');
      mk('review', '審查修改', roles.reviewer, null);
      mk('confirm', '確認並發布到 GitHub', null, 'planning');
    } catch (e) { console.error(e); }
  }
  function syncBoard(key, status, detail) {
    const map = { fix: 'implement', publish: 'confirm' };
    const id = boardIds[map[key] || key];
    if (!id) return;
    const st = { running: 'doing', ok: 'done', failed: 'blocked', todo: 'todo', waiting: 'doing', skipped: 'done' }[status] || 'todo';
    try {
      board.upsertTask({ id, status: st, ...(st === 'doing' ? { progress: 50 } : {}), ...(status === 'failed' ? { note: tail(detail, 200) } : {}) });
    } catch (_) { /* 任務被刪掉就算了 */ }
  }

  // ---------- 指令執行 ----------
  function run(cmd, args, { cwd, env, timeoutMs = 120000, input } = {}) {
    return new Promise((resolve) => {
      let child;
      try {
        if (cmd === 'git') {
          const { spawnResolved } = require('./adapters/cli');
          child = spawnResolved('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } });
        } else {
          child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, windowsHide: true });
        }
      } catch (e) { return resolve({ code: -1, out: '', err: e.message }); }
      children.add(child);
      let out = '';
      let err = '';
      const t = setTimeout(() => { try { child.kill(); } catch (_) { /* ignore */ } }, timeoutMs);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => { err += e.message; });
      child.on('close', (code) => { clearTimeout(t); children.delete(child); resolve({ code: code == null ? -1 : code, out, err }); });
      if (child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(input || ''); }
    });
  }
  const git = (args, opts = {}) => run('git', args, { cwd: devDir, ...opts });
  const nodeBin = process.versions.electron ? 'node' : process.execPath;

  function remoteUrl() {
    if (remoteOverride) return remoteOverride;
    const pkg = readJson(path.join(APP_ROOT, 'package.json'));
    const repo = pkg.aiOffice && pkg.aiOffice.update && pkg.aiOffice.update.repo;
    if (!repo) throw new Error('package.json 沒有設定更新來源倉庫');
    return `https://github.com/${repo}.git`;
  }
  function branch() {
    const pkg = readJson(path.join(APP_ROOT, 'package.json'));
    return (pkg.aiOffice && pkg.aiOffice.update && pkg.aiOffice.update.branch) || 'main';
  }

  function checkStop() { if (ctrl && ctrl.signal.aborted) throw Object.assign(new Error('已取消改版'), { cancelled: true }); }

  // ---------- 呼叫 AI 成員（並驅動辦公室動畫與紀錄） ----------
  async function callAgent(agent, prompt, { write = false } = {}) {
    checkStop();
    emit('agent', { id: agent.id, state: write ? 'working' : 'thinking' });
    emit('log', { agentId: agent.id, kind: 'prompt', text: prompt });
    try {
      const out = await runner(agent, prompt, {
        signal: ctrl.signal,
        cwd: devDir,
        write,
        timeoutMs: 30 * 60 * 1000,
        onChunk: (c) => emit('log', { agentId: agent.id, kind: 'chunk', text: c }),
      });
      emit('log', { agentId: agent.id, kind: 'output', text: String(out).trim() });
      emit('agent', { id: agent.id, state: 'idle' });
      return String(out).trim();
    } catch (e) {
      emit('agent', { id: agent.id, state: ctrl.signal.aborted ? 'idle' : 'error' });
      checkStop();
      throw e;
    }
  }

  // ---------- 自動測試 ----------
  function listJs(dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...listJs(p));
      else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
  }
  function httpJson(port, pathname, body) {
    return new Promise((resolve) => {
      const data = body ? JSON.stringify(body) : null;
      const req = http.request({ host: '127.0.0.1', port, path: pathname, method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json', 'x-ai-office': '1' } : {} }, (res) => {
        let s = '';
        res.on('data', (d) => { s += d; });
        res.on('end', () => resolve({ status: res.statusCode, body: s }));
      });
      req.on('error', () => resolve(null));
      req.setTimeout(3000, () => { req.destroy(); resolve(null); });
      if (data) req.write(data);
      req.end();
    });
  }
  async function bootTest() {
    const port = 41000 + Math.floor(Math.random() * 8000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-boot-'));
    const child = spawn(nodeBin, ['src/server/server.js', '--no-open'], {
      cwd: devDir, windowsHide: true,
      env: { ...process.env, AI_OFFICE_PORT: String(port), HOME: home, USERPROFILE: home, AI_OFFICE_NO_UPDATE_CHECK: '1' },
    });
    children.add(child);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    try {
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 400));
        const st = await httpJson(port, '/api/getState', {});
        if (st && st.status === 200) {
          const j = JSON.parse(st.body);
          if (!j.ok) return { ok: false, out: '啟動後 getState 回傳錯誤：' + j.error };
          const page = await httpJson(port, '/src/renderer/index.html');
          if (!page || page.status !== 200) return { ok: false, out: '畫面檔案 index.html 讀不到' };
          return { ok: true, out: '啟動測試通過（伺服器可啟動、狀態與畫面可讀取）' };
        }
        if (child.exitCode != null) break;
      }
      return { ok: false, out: '伺服器無法啟動：\n' + tail(out, 3000) };
    } finally {
      try { child.kill(); } catch (_) { /* ignore */ }
      children.delete(child);
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
  async function runTests() {
    const lines = [];
    let ok = true;
    // 1. 語法檢查（包含畫面程式）
    const bad = [];
    for (const f of listJs(path.join(devDir, 'src')).concat(listJs(path.join(devDir, 'scripts')))) {
      const r = await run(nodeBin, ['--check', f], { cwd: devDir, timeoutMs: 20000 });
      if (r.code !== 0) bad.push(`${path.relative(devDir, f)}\n${tail(r.err, 600)}`);
    }
    if (bad.length) { ok = false; lines.push('✗ 語法錯誤：\n' + bad.join('\n')); } else lines.push('✓ 語法檢查');
    // 2. JSON 設定檔
    for (const f of fs.readdirSync(path.join(devDir, 'config')).filter((x) => x.endsWith('.json'))) {
      try { readJson(path.join(devDir, 'config', f)); } catch (e) { ok = false; lines.push(`✗ 設定檔格式錯誤 config/${f}：${e.message}`); }
    }
    // 3. 專案自己的測試腳本
    for (const s of ['scripts/smoke-test.js', 'scripts/board-test.js']) {
      if (!fs.existsSync(path.join(devDir, s))) continue;
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-test-'));
      const r = await run(nodeBin, [s], { cwd: devDir, timeoutMs: 180000, env: { HOME: home, USERPROFILE: home } });
      fs.rmSync(home, { recursive: true, force: true });
      if (r.code === 0) lines.push(`✓ ${s}`);
      else { ok = false; lines.push(`✗ ${s}\n${tail(r.out + r.err, 2500)}`); }
    }
    // 4. 實際啟動一次
    if (ok) {
      const b = await bootTest();
      if (!b.ok) ok = false;
      lines.push((b.ok ? '✓ ' : '✗ ') + b.out);
    }
    return { ok, output: lines.join('\n') };
  }

  // ---------- 主流程 ----------
  function fileTree() {
    const keep = [];
    const walk = (d, rel) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'docs') continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), r); else keep.push(r);
      }
    };
    walk(devDir, '');
    return keep.join('\n');
  }

  async function start({ request, planner, implementer, reviewer }) {
    if (['preparing', 'planning', 'implementing', 'testing', 'fixing', 'reviewing', 'publishing'].includes(state.phase)) throw new Error('已有改版正在進行');
    if (isOrchestratorBusy()) throw new Error('有協作任務正在進行，請等它完成再改版');
    if (store.getSettings().mockMode) throw new Error('改版需要真的 AI 改程式碼，請先到「設定」關閉模擬模式');
    request = String(request || '').trim();
    if (request.length < 4) throw new Error('請具體描述想要新增或修改什麼');
    const agents = store.getAgents();
    const find = (id, label) => { const a = agents.find((x) => x.id === id); if (!a) throw new Error(`請選擇${label}`); return a; };
    const roles = { planner: find(planner, '企劃'), implementer: find(implementer, '工程師'), reviewer: find(reviewer, '審查者') };
    if (roles.implementer.mode !== 'cli') throw new Error('工程師必須是 CLI 模式（例如 Claude 或 Codex），API 模式無法直接修改檔案');

    state = { ...idle(), phase: 'preparing', request, startedAt: new Date().toISOString(), roles: { planner: roles.planner.id, implementer: roles.implementer.id, reviewer: roles.reviewer.id } };
    ctrl = new AbortController();
    initBoard(request, state.roles);
    push();
    emit('run', { status: 'started', runId: 'dev-' + Date.now(), workflowId: '__devops', label: '改版 AI Office', task: request });
    // 背景執行，畫面透過 devops 事件看進度
    pipeline(roles).catch((e) => {
      const cancelled = e && e.cancelled;
      state.phase = cancelled ? 'cancelled' : 'failed';
      state.error = cancelled ? '已取消' : (e.message || String(e));
      const cur = state.steps.find((s) => s.status === 'running');
      if (cur) setStep(cur.key, 'failed', state.error);
      log(cancelled ? '改版已取消' : `改版失敗：${state.error}`, cancelled ? 'system' : 'error');
      emit('run', { status: cancelled ? 'stopped' : 'failed', runId: 'dev', workflowId: '__devops', error: state.error });
      push();
    });
    return snapshot();
  }

  async function pipeline(roles) {
    // 1. 準備開發副本
    setStep('prepare', 'running');
    const br = branch();
    const ver = await git(['--version'], { cwd: os.homedir() });
    if (ver.code !== 0) throw new Error('找不到 Git，請先安裝：winget install --id Git.Git -e');
    if (!fs.existsSync(path.join(devDir, '.git'))) {
      fs.mkdirSync(path.dirname(devDir), { recursive: true });
      fs.rmSync(devDir, { recursive: true, force: true });
      const r = await git(['clone', remoteUrl(), devDir], { cwd: path.dirname(devDir), timeoutMs: 300000 });
      if (r.code !== 0) throw new Error('下載原始碼失敗：' + tail(r.err, 500));
    } else {
      const f = await git(['fetch', 'origin'], { timeoutMs: 180000 });
      if (f.code !== 0) throw new Error('同步原始碼失敗：' + tail(f.err, 500));
      await git(['checkout', '-f', br]);
      await git(['reset', '--hard', `origin/${br}`]);
      await git(['clean', '-fd']);
    }
    const base = readJson(path.join(devDir, 'package.json')).version;
    setStep('prepare', 'ok', `開發副本已同步到 GitHub 最新版 v${base}`);
    checkStop();

    // 2. 規格
    state.phase = 'planning'; setStep('plan', 'running');
    let readme = '';
    try { readme = fs.readFileSync(path.join(devDir, 'README.md'), 'utf8').slice(0, 4000); } catch (_) { /* 沒有 README */ }
    const spec = await callAgent(roles.planner, [
      '你要替「AI Office」規劃一次改版。AI Office 是一個只用 Node.js 內建模組的桌面工具（沒有 npm 相依套件），畫面是 src/renderer 裡的 HTML/CSS/JS（Canvas 繪圖），後端是 src/server 與 src/main。',
      `\n檔案清單：\n${fileTree()}`,
      `\nREADME 摘要：\n${readme}`,
      `\n使用者的需求：${state.request}`,
      '\n請寫出實作規格：1) 要改哪些檔案、各改什麼 2) 畫面與操作的變化 3) 驗收方式。條列、精簡，不要寫完整程式碼。',
    ].join('\n'));
    setStep('plan', 'ok', spec);

    // 3. 實作
    state.phase = 'implementing'; setStep('implement', 'running');
    emit('handoff', { from: roles.planner.id, to: roles.implementer.id, label: '改版規格' });
    const rules = [
      '你在 AI Office 的原始碼資料夾中工作（就是目前的工作目錄），請直接修改檔案完成需求。規則：',
      '- 只能修改這個資料夾裡的檔案，不要動 .git。',
      '- 不可新增任何 npm 相依套件，只能用 Node.js 內建模組與瀏覽器原生 API。',
      '- 不要修改 package.json 的 version（發布時會自動處理）。',
      '- 畫面文字使用繁體中文，風格與現有程式一致。',
      '- 如果改了 config/engines.json，請把其中的 _version 加一。',
      '- 完成後條列說明改了哪些檔案、做了什麼。',
    ].join('\n');
    const impl = await callAgent(roles.implementer, `${rules}\n\n使用者需求：${state.request}\n\n規格：\n${spec}`, { write: true });
    const changed = await git(['status', '--porcelain']);
    if (!changed.out.trim()) throw new Error(`${roles.implementer.name} 沒有修改任何檔案。可能是 CLI 沒有寫入權限，或需求不夠具體。`);
    setStep('implement', 'ok', impl);

    // 4. 測試（失敗就修一輪）
    state.phase = 'testing'; setStep('test', 'running');
    let tests = await runTests();
    if (!tests.ok) {
      setStep('test', 'failed', tests.output);
      state.phase = 'fixing'; setStep('fix', 'running');
      const fix = await callAgent(roles.implementer, `${rules}\n\n剛才的修改沒有通過自動測試，請修正。測試輸出：\n${tail(tests.output, 6000)}\n\n原始需求：${state.request}`, { write: true });
      setStep('fix', 'ok', fix);
      state.phase = 'testing'; setStep('test', 'running');
      tests = await runTests();
    }
    setStep('test', tests.ok ? 'ok' : 'failed', tests.output);

    // 5. 差異與審查
    await git(['add', '-A']);
    const stat = (await git(['diff', '--cached', '--stat'])).out.trim();
    const diff = (await git(['diff', '--cached'], { timeoutMs: 60000 })).out;
    const files = (await git(['diff', '--cached', '--name-status'])).out.trim().split('\n').filter(Boolean);
    state.result = { baseVersion: base, stat, files, diff: diff.length > MAX_DIFF_CHARS ? diff.slice(0, MAX_DIFF_CHARS) + '\n…（差異太長，已截斷）' : diff, tests, spec, review: '' };
    push();
    state.phase = 'reviewing'; setStep('review', 'running');
    emit('handoff', { from: roles.implementer.id, to: roles.reviewer.id, label: '程式修改' });
    let review = '';
    try {
      review = await callAgent(roles.reviewer, [
        `請審查以下對 AI Office 的修改。使用者需求：${state.request}`,
        `自動測試結果：${tests.ok ? '全部通過' : '有失敗'}\n${tail(tests.output, 2000)}`,
        `修改摘要：\n${stat}`,
        `完整差異：\n${diff.slice(0, MAX_DIFF_CHARS)}`,
        '請指出錯誤、風險、是否符合需求。最後一行只寫「結論：可以發布」或「結論：建議修正」。',
      ].join('\n\n'));
      state.result.review = review;
      state.result.verdict = /結論：\s*可以發布/.test(review) ? 'ok' : /結論：\s*建議修正/.test(review) ? 'fix' : 'unknown';
      setStep('review', 'ok', review);
    } catch (e) {
      checkStop();
      // 審查失敗不影響改版本身（自動測試才是發布門檻），只記下原因
      review = `審查者 ${roles.reviewer.name} 無法完成審查：${e.message}`;
      state.result.review = review;
      state.result.verdict = 'unknown';
      setStep('review', 'failed', review);
    }

    // 6. 等你確認
    state.phase = 'awaiting';
    setStep('confirm', 'waiting', tests.ok ? '測試通過，等你確認後發布' : '測試沒有全部通過，不建議發布');
    emit('run', { status: 'finished', runId: 'dev', workflowId: '__devops' });
    log(`改版完成，修改了 ${files.length} 個檔案，等你在「改版」分頁確認是否發布`);
    push();
  }

  async function publish({ force = false } = {}) {
    if (state.phase !== 'awaiting') throw new Error('目前沒有等待發布的改版');
    if (!state.result.tests.ok && !force) throw new Error('自動測試沒有通過，不能發布');
    state.phase = 'publishing'; setStep('publish', 'running');
    try {
      const pkgFile = path.join(devDir, 'package.json');
      const pkg = readJson(pkgFile);
      // 版本以 GitHub 上最新的為準再加一
      await git(['fetch', 'origin'], { timeoutMs: 120000 });
      let remoteVer = pkg.version;
      const show = await git(['show', `origin/${branch()}:package.json`]);
      if (show.code === 0) { try { remoteVer = JSON.parse(show.out).version; } catch (_) { /* 用本地 */ } }
      const next = bumpPatch(remoteVer);
      pkg.version = next;
      pkg.aiOffice = pkg.aiOffice || {};
      pkg.aiOffice.notes = state.request.slice(0, 120);
      fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
      await git(['add', '-A']);
      const email = (await git(['config', 'user.email'])).out.trim();
      const id = email ? [] : ['-c', 'user.name=AI Office', '-c', 'user.email=ai-office@users.noreply.github.com'];
      const names = state.roles;
      const nm = (aid) => (store.getAgents().find((a) => a.id === aid) || { name: aid }).name;
      const msg = `v${next}：${state.request.slice(0, 60)}\n\n由 AI Office 自動改版：企劃 ${nm(names.planner)}、實作 ${nm(names.implementer)}、審查 ${nm(names.reviewer)}。`;
      const c = await git([...id, 'commit', '-m', msg]);
      if (c.code !== 0) throw new Error('建立版本紀錄失敗：' + tail(c.err || c.out, 500));
      // 若 GitHub 上已有更新的提交，先疊上去再推
      const rb = await git(['pull', '--rebase', 'origin', branch()], { timeoutMs: 180000 });
      if (rb.code !== 0) { await git(['rebase', '--abort']); throw new Error('GitHub 上有衝突的新修改，請重新改版：' + tail(rb.err, 400)); }
      const p = await git(['push', 'origin', `HEAD:${branch()}`], { timeoutMs: 300000 });
      if (p.code !== 0) {
        const auth = /auth|403|401|denied|could not read Username/i.test(p.err);
        throw new Error(auth ? '推送被 GitHub 拒絕：需要登入。請開 PowerShell 執行一次「git -C ' + devDir + ' push」完成 GitHub 登入後，再按一次發布。' : '推送失敗：' + tail(p.err, 500));
      }
      state.phase = 'published';
      state.result.publishedVersion = next;
      setStep('publish', 'ok', `已發布 v${next} 到 GitHub`);
      setStep('confirm', 'ok');
      log(`已發布 v${next} 到 GitHub，按右上角更新按鈕即可套用`);
      push();
      return snapshot();
    } catch (e) {
      state.phase = 'awaiting';
      // 還原 package.json 版本，避免下次重複加一
      await git(['reset', '--soft', `origin/${branch()}`]).catch(() => {});
      setStep('publish', 'failed', e.message);
      throw e;
    }
  }

  async function discard() {
    if (['preparing', 'planning', 'implementing', 'testing', 'fixing', 'reviewing', 'publishing'].includes(state.phase)) throw new Error('改版進行中，請先按取消');
    if (fs.existsSync(path.join(devDir, '.git'))) {
      await git(['reset', '--hard', `origin/${branch()}`]);
      await git(['clean', '-fd']);
    }
    if (boardIds.project) { try { board.deleteProject(boardIds.project); } catch (_) { /* ignore */ } }
    state = idle();
    push();
    return snapshot();
  }

  function cancel() {
    if (ctrl) ctrl.abort();
    children.forEach((c) => { try { c.kill(); } catch (_) { /* ignore */ } });
    return snapshot();
  }

  const isBusy = () => ['preparing', 'planning', 'implementing', 'testing', 'fixing', 'reviewing', 'publishing'].includes(state.phase);
  return { start, publish, discard, cancel, status: snapshot, isBusy, runTests, devDir };
}

module.exports = { createDevOps, bumpPatch };
