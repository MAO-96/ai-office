// 內建更新器：從 GitHub 倉庫檢查新版本、下載、解壓並覆蓋程式檔案。
// 使用者資料（角色、流程、金鑰、報告）放在 ~/.ai-office，不在程式資料夾，所以更新不會動到。
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');

function readPkg(dir = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
}

function source() {
  const pkg = readPkg();
  const s = (pkg.aiOffice && pkg.aiOffice.update) || {};
  return { repo: process.env.AI_OFFICE_REPO || s.repo, branch: process.env.AI_OFFICE_BRANCH || s.branch || 'main' };
}

function cmpVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  return 0;
}

async function fetchOk(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { 'user-agent': 'ai-office-updater', ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(`下載失敗（HTTP ${res.status}）：${url}`);
  return res;
}

async function remotePackage() {
  const { repo, branch } = source();
  if (!repo) throw new Error('尚未設定更新來源');
  if (process.env.AI_OFFICE_UPDATE_DIR) return readPkg(process.env.AI_OFFICE_UPDATE_DIR); // 測試用
  // 先用 API（較即時），失敗再用 raw
  try {
    const r = await fetchOk(`https://api.github.com/repos/${repo}/contents/package.json?ref=${encodeURIComponent(branch)}`, { headers: { accept: 'application/vnd.github.raw+json' } });
    return JSON.parse(await r.text());
  } catch (_) {
    const r = await fetchOk(`https://raw.githubusercontent.com/${repo}/${branch}/package.json?t=${Date.now()}`);
    return JSON.parse(await r.text());
  }
}

async function check() {
  const local = readPkg();
  const remote = await remotePackage();
  const notes = (remote.aiOffice && remote.aiOffice.notes) || '';
  return {
    current: local.version,
    latest: remote.version,
    available: cmpVersion(remote.version, local.version) > 0,
    notes,
    repo: source().repo,
  };
}

// --- 極簡 tar 解析（只用 Node 內建 zlib，不依賴外部工具） ---
function parseTar(buf, onFile) {
  let off = 0;
  let paxPath = null;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const str = (s, l) => header.subarray(s, s + l).toString('utf8').replace(/\0.*$/s, '');
    let name = str(0, 100);
    const prefix = str(345, 155);
    if (prefix) name = prefix + '/' + name;
    const size = parseInt(str(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      const m = body.toString('utf8').match(/\d+ path=([^\n]+)\n/);
      paxPath = m ? m[1] : null;
      continue;
    }
    if (type === 'g' || type === 'L' || type === 'K') continue;
    if (paxPath) { name = paxPath; paxPath = null; }
    if (type === '0' || type === '\0' || type === '7') onFile(name, body);
  }
}

async function download() {
  const { repo, branch } = source();
  if (process.env.AI_OFFICE_UPDATE_DIR) return { dir: process.env.AI_OFFICE_UPDATE_DIR, cleanup: () => {} };
  const res = await fetchOk(`https://codeload.github.com/${repo}/tar.gz/refs/heads/${encodeURIComponent(branch)}`);
  const tar = zlib.gunzipSync(Buffer.from(await res.arrayBuffer()));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-update-'));
  parseTar(tar, (name, body) => {
    const rel = name.split('/').slice(1).join('/'); // 去掉最外層「倉庫名-分支」資料夾
    if (!rel || rel.split('/').includes('..') || path.isAbsolute(rel)) return;
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, body);
  });
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function copyTree(src, dst) {
  let n = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) { fs.mkdirSync(d, { recursive: true }); n += copyTree(s, d); }
    else { fs.copyFileSync(s, d); n++; }
  }
  return n;
}

async function apply() {
  const info = await check();
  if (!info.available) return { updated: false, ...info };
  const { dir, cleanup } = await download();
  try {
    // 確認下載內容完整，避免覆蓋成壞掉的版本
    for (const must of ['package.json', 'src/server/server.js', 'src/renderer/index.html', 'config/agents.json']) {
      if (!fs.existsSync(path.join(dir, must))) throw new Error(`下載的版本不完整（缺少 ${must}），已取消更新`);
    }
    const files = copyTree(dir, ROOT);
    return { updated: true, files, ...info, current: readPkg().version };
  } finally {
    cleanup();
  }
}

module.exports = { check, apply, cmpVersion, parseTar };
