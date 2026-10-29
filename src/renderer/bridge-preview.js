/*
 * 瀏覽器預覽模式：沒有 Electron 時（直接用瀏覽器開 index.html），
 * 用同一套協調核心＋模擬轉接器提供相同的 window.aiOffice 介面，方便改畫面。
 * 需要用本機 HTTP 伺服器開啟（例如在專案根目錄執行 npx serve 或 python -m http.server），
 * 因為瀏覽器不允許 file:// 讀取 JSON。
 */
(function () {
  'use strict';
  if (window.aiOffice) return;

  const base = '../../config/';
  let cfg = null;
  const listeners = [];
  let orch = null;
  const settings = { mockMode: true, workspace: '（預覽模式無工作目錄）', timeoutMinutes: 10 };

  async function load() {
    if (cfg) return cfg;
    const names = ['agents', 'engines', 'rooms', 'workflows'];
    const vals = await Promise.all(names.map((n) => fetch(base + n + '.json').then((r) => r.json())));
    cfg = {};
    names.forEach((n, i) => { cfg[n] = vals[i]; });
    orch = window.OrchestratorCore.createOrchestrator({
      getAgents: () => cfg.agents,
      getWorkflows: () => cfg.workflows,
      runAgent: (a, p, o) => window.MockAdapter.run(a, p, o),
    });
    orch.on('*', (t, d) => listeners.forEach((cb) => cb(t, d)));
    return cfg;
  }

  function snapshot() {
    const keys = {};
    Object.values(cfg.engines).forEach((e) => { if (e && e.api) keys[e.api.keyEnv] = 'none'; });
    return { ...cfg, settings: { ...settings }, workspace: settings.workspace, keys, running: orch.isRunning() };
  }

  window.aiOffice = {
    isPreview: true,
    getState: async () => { await load(); return snapshot(); },
    saveAgents: async (agents) => { cfg.agents = agents; return snapshot(); },
    saveWorkflows: async (wfs) => { cfg.workflows = wfs; return snapshot(); },
    saveEngines: async (e) => { cfg.engines = e; return snapshot(); },
    saveSettings: async (s) => { Object.assign(settings, s, { mockMode: true }); return snapshot(); },
    resetConfig: async () => { cfg = null; await load(); return snapshot(); },
    saveKey: async () => snapshot(),
    startRun: async (workflowId, task) => { const r = await orch.run(workflowId, task); return { final: r.final, file: null }; },
    stopRun: async () => { orch.stop(); return true; },
    testAgent: async () => ({ ok: false, text: '預覽模式無法測試，請用 AI Office 捷徑開啟' }),
    checkCli: async () => ({ _preview: { ok: false, detail: '預覽模式無法檢查 CLI，請用 Electron 執行' } }),
    openWorkspace: async () => {},
    chooseWorkspace: async () => snapshot(),
    openFile: async () => {},
    onEvent: (cb) => { listeners.push(cb); return () => listeners.splice(listeners.indexOf(cb), 1); },
  };
})();
