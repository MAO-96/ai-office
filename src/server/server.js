// 瀏覽器版：不需要 Electron，只用 Node.js 內建模組。
// 執行：node src/server/server.js  → 自動開啟 http://127.0.0.1:3939
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createService } = require('../main/service');
const updater = require('./updater');
const { buildApi } = require('../main/api');

const ROOT = path.join(__dirname, '..', '..');
const PORT = Number(process.env.AI_OFFICE_PORT) || 3939;
const HOST = '127.0.0.1';
const USER_DIR = path.join(os.homedir(), '.ai-office');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
const STATIC_DIRS = ['src', 'config', 'docs'].map((d) => path.join(ROOT, d) + path.sep);

const APP_MODE = process.argv.includes('--app');
const RESTARTED = process.argv.includes('--restarted');
fs.mkdirSync(USER_DIR, { recursive: true });

// 隱藏視窗執行時看不到輸出，所以同時寫進記錄檔
const LOG_FILE = path.join(USER_DIR, 'server.log');
try { if (fs.statSync(LOG_FILE).size > 1e6) fs.writeFileSync(LOG_FILE, ''); } catch (_) { /* 檔案不存在 */ }
function log(...a) {
  const line = a.join(' ');
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toLocaleString()}] ${line}\n`); } catch (_) { /* ignore */ }
}
process.on('uncaughtException', (e) => { log('錯誤：', e.stack || e.message); });

function openPath(p) {
  const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(cmd, [p], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return '';
}

// 用 Edge / Chrome 的「應用程式模式」開成獨立視窗（沒有網址列與分頁）
function findAppBrowser() {
  if (process.env.AI_OFFICE_BROWSER) return process.env.AI_OFFICE_BROWSER;
  const e = process.env;
  const candidates = process.platform === 'win32' ? [
    path.join(e['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(e.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(e.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(e['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(e.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ] : process.platform === 'darwin' ? [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ] : ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((c) => c && fs.existsSync(c)) || null;
}

function openWindow(url) {
  const browser = APP_MODE ? findAppBrowser() : null;
  if (!browser) { log(APP_MODE ? '找不到 Edge 或 Chrome，改用預設瀏覽器開啟' : '用預設瀏覽器開啟'); return openPath(url); }
  spawn(browser, [`--app=${url}`, '--window-size=1440,920', '--no-first-run', '--no-default-browser-check'],
    { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  log('已開啟視窗：', path.basename(browser));
  return '';
}

// 即時事件（Server-Sent Events）
const clients = new Set();
let everConnected = false;
let exitTimer = null;
function emit(type, data) {
  const msg = `data: ${JSON.stringify({ type, data })}\n\n`;
  clients.forEach((res) => res.write(msg));
}
// 應用程式模式：視窗關掉（連線全部斷開）10 秒後自動結束，重新整理不會誤關
function onClientsChanged() {
  if (!APP_MODE) return;
  clearTimeout(exitTimer);
  if (clients.size === 0 && everConnected) {
    exitTimer = setTimeout(() => { log('視窗已關閉，結束程式'); svc.stopRun(); process.exit(0); }, 10000);
  }
}

const svc = createService({ userDataDir: USER_DIR, defaultsDir: path.join(ROOT, 'config'), crypto: null, openPath, emit });

function currentVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch (_) { return '?'; }
}

// 更新後重新啟動：開一個新的自己，舊的關閉；新程序會等連接埠釋放，不會再開新視窗
function restart() {
  const args = [path.join(__dirname, 'server.js'), ...process.argv.slice(2).filter((a) => a !== '--restarted'), '--restarted'];
  spawn(process.execPath, args, { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  clients.forEach((res) => res.end());
  server.close();
  setTimeout(() => process.exit(0), 200);
}

const API = {
  ...buildApi(svc),
  getState: () => ({ ...svc.getState(), version: currentVersion(), updatable: true }),
  checkUpdate: () => updater.check(),
  applyUpdate: async () => {
    if (svc.orchestrator.isRunning()) throw new Error('有任務正在進行，請等任務完成或停止後再更新');
    if (svc.devStatus && ['clarifying', 'planning', 'implementing', 'testing', 'fixing', 'reviewing', 'publishing', 'preparing'].includes(svc.devStatus().phase)) throw new Error('正在改版，請等改版完成再更新');
    const r = await updater.apply();
    if (r.updated) {
      log(`已更新到 v${r.latest}（${r.files} 個檔案），重新啟動中`);
      emit('updated', { version: r.latest });
      setTimeout(restart, 300);
    }
    return r;
  },
  listBackups: () => updater.listBackups(),
  rollback: async () => {
    if (svc.orchestrator.isRunning()) throw new Error('有任務正在進行，請先停止');
    const r = updater.rollback();
    log(`已回復到 v${r.version}，重新啟動中`);
    emit('updated', { version: r.version });
    setTimeout(restart, 300);
    return r;
  },
};

// 只接受本機來源，避免其他網站呼叫這個本機服務
function isLocal(req) {
  const host = (req.headers.host || '').split(':')[0];
  return host === '127.0.0.1' || host === 'localhost';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { s += c; if (s.length > 3e7) { reject(new Error('內容過大（附件上限 20 MB）')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : null); } catch (e) { reject(e); } });
  });
}

const server = http.createServer(async (req, res) => {
  if (!isLocal(req)) { res.writeHead(403); return res.end(); }
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/') {
    res.writeHead(302, { location: '/src/renderer/index.html?mode=server' });
    return res.end();
  }

  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': ok\n\n');
    clients.add(res);
    everConnected = true;
    onClientsChanged();
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); onClientsChanged(); });
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    const fn = API[url.pathname.slice(5)];
    // 自訂標頭會觸發瀏覽器的跨站預檢，我們不回應預檢，所以外部網站無法呼叫
    if (req.method !== 'POST' || req.headers['x-ai-office'] !== '1' || !fn) { res.writeHead(404); return res.end(); }
    try {
      const data = await fn(await readBody(req));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, data }));
    } catch (e) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
    }
    return;
  }

  // 靜態檔案
  const file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
  if (!STATIC_DIRS.some((d) => file.startsWith(d)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('Not found');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

server.on('error', (e) => {
  const url = `http://${HOST}:${PORT}`;
  if (e.code === 'EADDRINUSE' && RESTARTED && listenTries < 40) {
    listenTries++;
    setTimeout(() => server.listen(PORT, HOST), 500);
    return;
  }
  if (e.code === 'EADDRINUSE') {
    // 已經在執行：直接再開一個視窗就好
    log(`AI 辦公室已在執行中，開啟視窗：${url}`);
    if (!process.argv.includes('--no-open')) openWindow(url);
    setTimeout(() => process.exit(0), 500);
    return;
  }
  log('啟動失敗：', e.message);
  process.exit(1);
});

let listenTries = 0;
server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  log(`AI 辦公室已啟動：${url}`);
  log(`設定與金鑰存放在：${USER_DIR}`);
  if (!process.argv.includes('--no-open') && !RESTARTED) openWindow(url);
  // 啟動時順便在背景檢查一次更新，結果推給畫面
  if (!process.env.AI_OFFICE_NO_UPDATE_CHECK) setTimeout(() => updater.check().then((r) => { if (r.available) emit('update', r); }).catch((e) => log('檢查更新失敗：', e.message)), 3000);
});
