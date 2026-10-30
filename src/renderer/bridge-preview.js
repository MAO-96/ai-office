/*
 * 瀏覽器預覽模式：沒有後端時（直接開 index.html），用協調核心＋模擬 AI 在畫面裡跑，方便改畫面。
 * 任務板、日常任務、改版等需要後端的功能在這裡不可用。
 */
(function () {
  'use strict';
  if (window.aiOffice) return;

  const base = '../../config/';
  let cfg = null;
  let orch = null;
  const listeners = [];
  const runs = new Map();
  const settings = { mockMode: true, workspace: '（預覽模式無工作目錄）', timeoutMinutes: 10, maxParallel: 3 };
  const emit = (t, d) => listeners.forEach((cb) => cb(t, d));

  async function load() {
    if (cfg) return;
    const names = ['agents', 'engines', 'rooms', 'workflows'];
    const vals = await Promise.all(names.map((n) => fetch(base + n + '.json').then((r) => r.json())));
    cfg = {};
    names.forEach((n, i) => { cfg[n] = vals[i]; });
    orch = window.OrchestratorCore.createOrchestrator({
      getAgents: () => cfg.agents, getWorkflows: () => cfg.workflows,
      runAgent: (a, p, o) => window.MockAdapter.run(a, p, o), maxParallel: () => settings.maxParallel,
    });
    orch.on('*', (t, d) => {
      if (t === 'run' && d.status === 'queued') runs.set(d.runId, { runId: d.runId, title: d.title, type: d.type, status: 'queued', stepLabel: '排隊中', log: [], notes: [], startedAt: new Date().toISOString() });
      const r = d && runs.get(d.runId);
      if (r && t === 'run') {
        if (d.status === 'step' || d.status === 'substep') { r.status = 'running'; r.stepLabel = d.label; }
        if (d.status === 'asking') r.status = 'asking';
        if (['finished', 'failed', 'stopped'].includes(d.status)) { r.status = d.status; r.final = d.final || ''; r.error = d.error || null; r.endedAt = new Date().toISOString(); }
      }
      if (r && t === 'log' && d.kind !== 'chunk') r.log.push({ kind: d.kind, agentId: d.agentId, text: d.text });
      emit(t, d);
      if (t === 'run') emit('runs', [...runs.values()].reverse());
    });
  }
  function snapshot() {
    const keys = {};
    Object.values(cfg.engines).forEach((e) => { if (e && e.api) keys[e.api.keyEnv] = 'none'; });
    return { ...cfg, settings: { ...settings }, workspace: settings.workspace, keys, running: orch.isRunning(), runs: [...runs.values()].reverse(), routines: [], pendingAsks: orch.pendingAsks(), tasks: { projects: [], tasks: [] } };
  }
  const unsupported = () => { throw new Error('預覽模式不支援這個功能，請用 AI Office 捷徑開啟'); };
  async function call(name, b) {
    await load();
    switch (name) {
      case 'getState': return snapshot();
      case 'saveAgents': cfg.agents = b; return snapshot();
      case 'saveWorkflows': cfg.workflows = b; return snapshot();
      case 'saveSettings': Object.assign(settings, b, { mockMode: true }); return snapshot();
      case 'resetConfig': cfg = null; await load(); return snapshot();
      case 'startRun': {
        const spec = b.kind === 'single' ? { type: 'single', agent: b.agentId, name: '交辦' } : b.workflowId;
        const runId = 'p' + Date.now().toString(36);
        orch.run(spec, b.task, { runId, clarify: b.clarify, title: b.title }).catch(() => {});
        return { runId };
      }
      case 'stopRun': orch.stop(b.runId); return true;
      case 'listRuns': return [...runs.values()].reverse();
      case 'getRun': return runs.get(b.runId);
      case 'removeRun': runs.delete(b.runId); return [...runs.values()].reverse();
      case 'clearRuns': [...runs.keys()].forEach((k) => { if (['finished', 'failed', 'stopped'].includes(runs.get(k).status)) runs.delete(k); }); return [...runs.values()].reverse();
      case 'answerAsk': return orch.answer(b.runId, b.answers || null);
      case 'addNote': return { runId: b.runId, notes: orch.addNote(b.runId, b.text) };
      case 'listRoutines': return [];
      case 'getTasks': case 'deleteTask': case 'deleteProject': case 'clearDoneProjects': return { projects: [], tasks: [] };
      case 'getUsage': return {};
      case 'testAgent': return { ok: false, text: '預覽模式無法測試，請用 AI Office 捷徑開啟' };
      case 'checkCli': return { _preview: { ok: false, detail: '預覽模式無法檢查 CLI' } };
      case 'openWorkspace': case 'openFile': return null;
      default: return unsupported();
    }
  }
  const onEvent = (cb) => { listeners.push(cb); return () => listeners.splice(listeners.indexOf(cb), 1); };
  window.aiOffice = window.AiOfficeBridge(call, onEvent, { isPreview: true, chooseWorkspace: () => call('getState') });
})();
