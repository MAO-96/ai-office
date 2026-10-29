// 共用服務層：Electron 版與瀏覽器版共用同一套設定、協調核心與轉接器。
const fs = require('fs');
const path = require('path');
const { createStore } = require('./store');
const { createRunner } = require('./adapters');
const { checkCommand } = require('./adapters/cli');
const { createOrchestrator } = require('../shared/orchestrator-core');

function createService({ userDataDir, defaultsDir, crypto, openPath, emit }) {
  const store = createStore({ userDataDir, defaultsDir, crypto });
  const orchestrator = createOrchestrator({
    getAgents: () => store.getAgents(),
    getWorkflows: () => store.getWorkflows(),
    runAgent: createRunner(store),
  });
  orchestrator.on('*', (type, data) => emit(type, data));
  const realRunner = createRunner(store, { forceReal: true });
  const testRunner = (agent, prompt, opts) => realRunner(agent, prompt, opts);

  function getState() {
    return {
      agents: store.getAgents(),
      engines: store.getEngines(),
      rooms: store.getRooms(),
      workflows: store.getWorkflows(),
      settings: store.getSettings(),
      workspace: store.getWorkspace(),
      keys: store.keyStatus(),
      running: orchestrator.isRunning(),
    };
  }

  function insideWorkspace(file) {
    const ws = path.resolve(store.getWorkspace());
    const f = path.resolve(file);
    return f === ws || f.startsWith(ws + path.sep);
  }

  return {
    store,
    orchestrator,
    getState,
    saveAgents(agents) { store.saveAgents(agents); return getState(); },
    saveWorkflows(wfs) { store.saveWorkflows(wfs); return getState(); },
    saveEngines(engines) { store.saveEngines(engines); return getState(); },
    saveSettings(s) {
      const allowed = {};
      if ('mockMode' in s) allowed.mockMode = !!s.mockMode;
      if ('timeoutMinutes' in s) allowed.timeoutMinutes = Math.max(1, Math.min(120, Number(s.timeoutMinutes) || 10));
      store.saveSettings(allowed);
      return getState();
    },
    setWorkspace(dir) {
      if (!dir || !path.isAbsolute(dir)) throw new Error('請輸入完整路徑，例如 C:\\Users\\你\\Documents\\ai-work');
      fs.mkdirSync(dir, { recursive: true });
      store.saveSettings({ workspace: dir });
      return getState();
    },
    resetConfig() { store.resetToDefaults(); return getState(); },
    saveKey({ name, value }) { store.setKey(name, value); return getState(); },
    async startRun({ workflowId, task }) {
      const result = await orchestrator.run(workflowId, task);
      const file = store.saveRunReport(result);
      emit('report', { file, final: result.final });
      return { final: result.final, file };
    },
    stopRun() { orchestrator.stop(); return true; },
    // 單獨測試一個角色能否連上（不受模擬模式影響）
    async testAgent(id) {
      const agent = store.getAgents().find((a) => a.id === id);
      if (!agent) throw new Error('找不到角色');
      const started = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 180000);
      try {
        const out = await testRunner(agent, '這是連線測試。請只回覆「連線成功」四個字。', { signal: ctrl.signal });
        return { ok: true, text: String(out).trim().slice(0, 300), seconds: Math.round((Date.now() - started) / 1000) };
      } catch (e) {
        return { ok: false, text: ctrl.signal.aborted ? '超過 3 分鐘沒有回應' : (e.message || String(e)).slice(0, 600) };
      } finally { clearTimeout(timer); }
    },
    async checkCli() {
      const out = {};
      for (const [id, e] of Object.entries(store.getEngines())) {
        if (!e || !e.cli) continue;
        out[id] = await checkCommand(e.cli.command);
      }
      return out;
    },
    openWorkspace() { return openPath(store.getWorkspace()); },
    openFile(file) {
      if (!file || !insideWorkspace(file)) throw new Error('只能開啟工作目錄內的檔案');
      return openPath(file);
    },
  };
}

module.exports = { createService };
