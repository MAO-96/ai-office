// 共用服務層：Electron 版與瀏覽器版共用同一套設定、協調核心與轉接器。
const fs = require('fs');
const path = require('path');
const { createStore } = require('./store');
const { createRunner } = require('./adapters');
const { checkCommand } = require('./adapters/cli');
const { createOrchestrator } = require('../shared/orchestrator-core');
const { createTaskBoard } = require('./tasks');
const { createUsage } = require('./usage');
const { createDevOps } = require('./devops');
const { createRunRegistry } = require('./runs');
const { createRoutines } = require('./routines');

function createService({ userDataDir, defaultsDir, crypto, openPath, emit }) {
  const store = createStore({ userDataDir, defaultsDir, crypto });
  const usage = createUsage({ file: path.join(userDataDir, 'usage.json'), store, emit });
  const board = createTaskBoard({ file: path.join(userDataDir, 'tasks.json'), getAgents: () => store.getAgents(), emit });
  const orchestrator = createOrchestrator({
    getAgents: () => store.getAgents(),
    getWorkflows: () => store.getWorkflows(),
    runAgent: createRunner(store, { usage }),
    maxParallel: () => store.getSettings().maxParallel || 3,
  });
  const registry = createRunRegistry({ store, emit, getAgents: () => store.getAgents() });
  orchestrator.on('*', (type, data) => {
    emit(type, data);
    try { registry.onEvent(type, data); } catch (e) { console.error(e); }
    // 流程進度同步寫進任務板（單一資料來源）
    if (type === 'run') {
      const wf = data.status !== 'started' ? null
        : data.type === 'single' ? { type: 'single', agent: data.agent, name: data.workflowName }
          : store.getWorkflows().find((w) => w.id === data.workflowId);
      try { board.onRunEvent(data, wf); } catch (e) { console.error(e); }
    }
  });

  // 開始一個任務（不等它做完，馬上回傳 runId；可同時開很多個）
  function startRun({ kind, workflowId, agentId, task, clarify, title, meta } = {}) {
    let spec;
    if (kind === 'single') {
      const a = store.getAgents().find((x) => x.id === agentId);
      if (!a) throw new Error('請選擇要交辦的員工');
      spec = { type: 'single', agent: a.id, name: `交辦：${a.name}` };
    } else {
      spec = workflowId;
    }
    if (!String(task || '').trim()) throw new Error('請輸入任務內容');
    const runId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    orchestrator.run(spec, task, { runId, clarify: !!clarify, title, meta })
      .then((result) => {
        const file = store.saveRunReport(result);
        registry.setFile(runId, file);
        emit('report', { runId, file, final: result.final });
        routines.onRunDone(meta, 'finished');
      })
      .catch((e) => routines.onRunDone(meta, e && e.stopped ? 'stopped' : 'failed', e && e.message));
    return { runId };
  }
  const routines = createRoutines({ store, board, startRun, emit });
  routines.startScheduler();
  const realRunner = createRunner(store, { forceReal: true, usage });
  const devops = createDevOps({
    store, board, emit, runner: realRunner, userDataDir,
    isOrchestratorBusy: () => false,
    remoteOverride: process.env.AI_OFFICE_DEV_REMOTE || null,
  });
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
      tasks: board.snapshot(),
      devops: devops.status(),
      pendingAsks: pendingAsks(),
      runs: registry.list(),
      routines: routines.view(),
    };
  }

  function pendingAsks() {
    const list = orchestrator.pendingAsks();
    const d = devops.status().ask;
    if (d) list.push({ ...d, source: 'devops', runId: 'devops', title: 'AI Office 改版' });
    return list;
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
      if ('maxParallel' in s) allowed.maxParallel = Math.max(1, Math.min(8, Number(s.maxParallel) || 3));
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
    startRun,
    stopRun(runId) { orchestrator.stop(runId || undefined); return true; },
    listRuns: () => registry.list(),
    getRun: (runId) => registry.get(runId),
    removeRun: (runId) => registry.remove(runId),
    clearRuns: () => registry.clearFinished(),
    // 日常任務
    listRoutines: () => routines.view(),
    saveRoutine: (r) => routines.upsert(r || {}),
    deleteRoutine: (id) => routines.remove(id),
    setRoutineEnabled: ({ id, enabled }) => routines.setEnabled(id, enabled),
    runRoutineNow: (id) => routines.runNow(id),
    // 任務板
    getTasks: () => board.snapshot(),
    upsertTask: (t) => { board.upsertTask(t); return board.snapshot(); },
    deleteTask: (id) => { board.deleteTask(id); return board.snapshot(); },
    upsertProject: (p) => { board.upsertProject(p); return board.snapshot(); },
    deleteProject: (id) => { board.deleteProject(id); return board.snapshot(); },
    clearDoneProjects: () => { board.clearDone(); return board.snapshot(); },
    // 追問與追加指示（任務與改版共用）
    answerAsk: ({ source, runId, answers } = {}) => (source === 'devops' || runId === 'devops'
      ? devops.answer(answers || null) : orchestrator.answer(runId, answers || null)),
    addNote: ({ runId, text } = {}) => (runId === 'devops'
      ? { devops: devops.addNote(text) } : { runId, notes: orchestrator.addNote(runId, text) }),
    pendingAsks,
    // 改版
    devStatus: () => devops.status(),
    devStart: (b) => devops.start(b || {}),
    devPublish: (b) => devops.publish(b || {}),
    devDiscard: () => devops.discard(),
    devCancel: () => devops.cancel(),
    // 用量
    getUsage: (force) => usage.getAll(!!force),
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
