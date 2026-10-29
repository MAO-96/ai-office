// 設定儲存：預設設定放在專案 config/，第一次啟動複製到使用者資料夾，之後都改那份。
const fs = require('fs');
const path = require('path');

const FILES = ['agents.json', 'engines.json', 'rooms.json', 'workflows.json'];
const DEFAULT_SETTINGS = { mockMode: true, workspace: '', timeoutMinutes: 10 };

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * @param {object} o
 * @param {string} o.userDataDir   使用者資料夾（Electron 的 app.getPath('userData')）
 * @param {string} o.defaultsDir   專案內的 config 資料夾
 * @param {object} [o.crypto]      { available(), encrypt(str)->base64, decrypt(base64)->str }
 */
function createStore({ userDataDir, defaultsDir, crypto }) {
  const cfgDir = path.join(userDataDir, 'config');
  fs.mkdirSync(cfgDir, { recursive: true });
  for (const f of FILES) {
    const dst = path.join(cfgDir, f);
    if (!fs.existsSync(dst)) fs.copyFileSync(path.join(defaultsDir, f), dst);
  }
  // 引擎設定改版時（_version 變大）自動套用新版，角色與流程不受影響
  {
    const def = readJson(path.join(defaultsDir, 'engines.json'), {});
    const cur = readJson(path.join(cfgDir, 'engines.json'), {});
    if ((def._version || 0) > (cur._version || 0)) fs.copyFileSync(path.join(defaultsDir, 'engines.json'), path.join(cfgDir, 'engines.json'));
  }
  const p = (f) => path.join(cfgDir, f);
  const settingsFile = path.join(userDataDir, 'settings.json');
  const keysFile = path.join(userDataDir, 'keys.json');

  const cache = {};
  const load = (f) => (cache[f] = cache[f] || readJson(p(f), readJson(path.join(defaultsDir, f), null)));

  function getSettings() { return { ...DEFAULT_SETTINGS, ...readJson(settingsFile, {}) }; }
  function getWorkspace() {
    const ws = getSettings().workspace || path.join(userDataDir, 'workspace');
    fs.mkdirSync(ws, { recursive: true });
    return ws;
  }

  function loadKeys() { return readJson(keysFile, {}); }
  function getKey(name) {
    if (process.env[name]) return process.env[name];
    const entry = loadKeys()[name];
    if (!entry) return '';
    if (entry.enc && crypto && crypto.available()) {
      try { return crypto.decrypt(entry.value); } catch (_) { return ''; }
    }
    return entry.enc ? '' : entry.value;
  }
  function setKey(name, value) {
    const keys = loadKeys();
    if (!value) delete keys[name];
    else if (crypto && crypto.available()) keys[name] = { enc: true, value: crypto.encrypt(value) };
    else keys[name] = { enc: false, value };
    writeJson(keysFile, keys);
  }
  function keyStatus() {
    const out = {};
    for (const e of Object.values(load('engines.json'))) {
      if (e && e.api && e.api.keyEnv) out[e.api.keyEnv] = process.env[e.api.keyEnv] ? 'env' : (getKey(e.api.keyEnv) ? 'saved' : 'none');
    }
    return out;
  }

  function validateAgents(agents) {
    if (!Array.isArray(agents)) throw new Error('角色資料格式錯誤');
    const ids = new Set();
    for (const a of agents) {
      if (!a.id || !/^[\w-]+$/.test(a.id)) throw new Error(`角色 ID 只能用英數、底線、連字號：${a.id}`);
      if (ids.has(a.id)) throw new Error(`角色 ID 重複：${a.id}`);
      ids.add(a.id);
      if (!a.name) throw new Error(`角色 ${a.id} 缺少名字`);
    }
  }
  function validateWorkflows(wfs, agents) {
    if (!Array.isArray(wfs)) throw new Error('流程資料格式錯誤');
    const ids = new Set(agents.map((a) => a.id));
    for (const w of wfs) {
      const refs = w.type === 'meeting' ? [...(w.participants || []), w.moderator].filter(Boolean) : (w.steps || []).map((s) => s.agent);
      for (const r of refs) if (!ids.has(r)) throw new Error(`流程「${w.name}」引用了不存在的角色：${r}`);
    }
  }

  return {
    getAgents: () => load('agents.json'),
    getEngines: () => load('engines.json'),
    getRooms: () => load('rooms.json'),
    getWorkflows: () => load('workflows.json'),
    getSettings,
    getWorkspace,
    getKey,
    setKey,
    keyStatus,
    saveAgents(agents) { validateAgents(agents); validateWorkflows(load('workflows.json'), agents); writeJson(p('agents.json'), agents); cache['agents.json'] = agents; },
    saveWorkflows(wfs) { validateWorkflows(wfs, load('agents.json')); writeJson(p('workflows.json'), wfs); cache['workflows.json'] = wfs; },
    saveEngines(engines) { writeJson(p('engines.json'), engines); cache['engines.json'] = engines; },
    saveSettings(s) { writeJson(settingsFile, { ...getSettings(), ...s }); },
    resetToDefaults() { for (const f of FILES) { fs.copyFileSync(path.join(defaultsDir, f), p(f)); delete cache[f]; } },
    saveRunReport(result) {
      const dir = path.join(getWorkspace(), 'runs');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${result.runId}.md`);
      const body = [
        `# ${result.workflow.name}`,
        '',
        `- 任務：${result.task}`,
        `- 時間：${new Date().toLocaleString()}`,
        '',
        ...result.outputs.map((o, i) => `## ${i + 1}\n\n${o}\n`),
        '## 最終結果',
        '',
        result.final,
        '',
      ].join('\n');
      fs.writeFileSync(file, body, 'utf8');
      return file;
    },
  };
}

module.exports = { createStore };
