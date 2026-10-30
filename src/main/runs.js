// 任務紀錄：每個任務像一段對話，保存狀態、進度與完整往來，結束後留在歷史裡可以回頭看。
const MAX_HISTORY = 60;
const MAX_LOG = 400;
const MAX_TEXT = 20000;

function createRunRegistry({ store, emit, getAgents }) {
  const live = new Map();
  let history = store.getRunHistory();
  let timer = null;

  function summary(r) {
    const { log, ...rest } = r;
    return { ...rest, final: r.final ? String(r.final).slice(0, 400) : '' };
  }
  function list() {
    return [...live.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).map(summary)
      .concat(history.map(summary));
  }
  function push() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; emit('runs', list()); }, 250);
  }
  function persist() {
    history = history.slice(0, MAX_HISTORY);
    try { store.saveRunHistory(history); } catch (e) { console.error(e); }
  }
  function addLog(r, entry) {
    const text = String(entry.text || '');
    r.log.push({ ...entry, text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '\n…（內容太長已截斷）' : text, at: Date.now() });
    if (r.log.length > MAX_LOG) r.log.splice(0, r.log.length - MAX_LOG);
  }
  const agentName = (id) => { const a = getAgents().find((x) => x.id === id); return a ? a.name : id; };

  function onEvent(type, d) {
    if (!d || !d.runId) return;
    let r = live.get(d.runId);
    if (type === 'run' && d.status === 'queued') {
      r = {
        runId: d.runId, title: d.title, task: d.task, type: d.type, workflowId: d.workflowId || null, workflowName: d.workflowName,
        agentId: d.agent || null, status: 'queued', stepLabel: '排隊中，等其他任務完成', progress: 0,
        startedAt: new Date().toISOString(), endedAt: null, final: '', file: null, error: null, consensus: null,
        notes: [], asking: false, meta: d.meta || null, log: [],
      };
      live.set(d.runId, r);
      push();
      return;
    }
    if (!r) return;
    if (type === 'run') {
      if (d.status === 'started') { r.status = 'running'; r.stepLabel = '開始'; r.startedAt = new Date().toISOString(); }
      if (d.status === 'step' || d.status === 'substep') {
        r.status = 'running';
        r.stepLabel = d.label;
        r.currentAgent = d.agentId || null;
        if (d.total) r.progress = Math.round(((d.index - 0.5) / d.total) * 100);
      }
      if (d.status === 'asking') { r.status = 'asking'; r.stepLabel = d.label; }
      if (['finished', 'failed', 'stopped'].includes(d.status)) {
        r.status = d.status;
        r.endedAt = new Date().toISOString();
        r.stepLabel = d.status === 'finished' ? '完成' : d.status === 'stopped' ? '已停止' : '失敗';
        r.progress = d.status === 'finished' ? 100 : r.progress;
        if (d.final) r.final = d.final;
        if (d.error) r.error = d.error;
        if (d.consensus != null) r.consensus = d.consensus;
        r.asking = false;
        r.currentAgent = null;
        live.delete(r.runId);
        history.unshift(r);
        persist();
      }
    } else if (type === 'log') {
      if (d.kind === 'chunk') {
        const last = r.log[r.log.length - 1];
        if (last && last.kind === 'stream' && last.agentId === d.agentId) last.text += d.text;
        else r.log.push({ kind: 'stream', agentId: d.agentId, text: d.text, at: Date.now() });
        return; // 串流太頻繁，不推清單
      }
      if (d.kind === 'output') {
        const last = r.log[r.log.length - 1];
        if (last && last.kind === 'stream' && last.agentId === d.agentId) r.log.pop();
      }
      addLog(r, { kind: d.kind, agentId: d.agentId, agentName: d.agentId ? agentName(d.agentId) : null, text: d.text });
    } else if (type === 'note') {
      r.notes = d.notes || [];
    } else if (type === 'ask') {
      r.asking = true;
      r.ask = { agentId: d.agentId, agentName: d.agentName, questions: d.questions };
    } else if (type === 'ask-done') {
      r.asking = false;
      r.ask = null;
    }
    push();
  }

  function setFile(runId, file) {
    const r = live.get(runId) || history.find((x) => x.runId === runId);
    if (!r) return;
    r.file = file;
    persist();
    push();
  }
  function get(runId) {
    const r = live.get(runId) || history.find((x) => x.runId === runId);
    if (!r) throw new Error('找不到這個任務紀錄');
    return JSON.parse(JSON.stringify(r));
  }
  function remove(runId) {
    if (live.has(runId)) throw new Error('任務還在進行中，請先停止');
    history = history.filter((x) => x.runId !== runId);
    persist();
    push();
    return list();
  }
  function clearFinished() {
    history = [];
    persist();
    push();
    return list();
  }
  return { onEvent, list, get, setFile, remove, clearFinished };
}

module.exports = { createRunRegistry };
