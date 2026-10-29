/*
 * 協調核心：與執行環境無關（Electron 主程序與瀏覽器預覽模式共用）。
 * 不直接呼叫任何 AI，只透過注入的 runAgent(agent, prompt, opts) 取得回覆。
 *
 * 發出的事件：
 *   run      { status: 'started'|'step'|'finished'|'failed'|'stopped', runId, workflowId, label?, index?, total?, error? }
 *   agent    { id, state: 'idle'|'working'|'thinking'|'talking'|'error', label? }
 *   move     { id, to }                 角色走到某房間（畫面負責走路與搭電梯）
 *   handoff  { from, to, label }        把產出交給下一位
 *   say      { id, text }               對話泡泡（會議發言）
 *   log      { agentId, kind: 'system'|'prompt'|'chunk'|'output'|'error', text }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OrchestratorCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function createEmitter() {
    const handlers = {};
    return {
      on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); return () => this.off(evt, fn); },
      off(evt, fn) { handlers[evt] = (handlers[evt] || []).filter((h) => h !== fn); },
      emit(evt, data) {
        (handlers[evt] || []).forEach((h) => { try { h(data); } catch (e) { console.error(e); } });
        (handlers['*'] || []).forEach((h) => { try { h(evt, data); } catch (e) { console.error(e); } });
      },
    };
  }

  function fill(template, vars) {
    return String(template).replace(/\{(\w+)\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
  }

  function snippet(text, n) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }

  class StoppedError extends Error { constructor() { super('已停止'); this.stopped = true; } }

  function createOrchestrator({ getAgents, getWorkflows, runAgent }) {
    const ev = createEmitter();
    let current = null; // { runId, controller }

    function agentById(id) {
      const a = getAgents().find((x) => x.id === id);
      if (!a) throw new Error(`找不到角色：${id}`);
      return a;
    }

    function checkStop(ctrl) { if (ctrl.signal.aborted) throw new StoppedError(); }

    async function callAgent(agent, prompt, ctrl, stateWhileRunning) {
      checkStop(ctrl);
      ev.emit('agent', { id: agent.id, state: stateWhileRunning || 'working' });
      ev.emit('log', { agentId: agent.id, kind: 'prompt', text: prompt });
      try {
        const out = await runAgent(agent, prompt, {
          signal: ctrl.signal,
          onChunk: (chunk) => ev.emit('log', { agentId: agent.id, kind: 'chunk', text: chunk }),
        });
        checkStop(ctrl);
        const text = String(out || '').trim();
        ev.emit('log', { agentId: agent.id, kind: 'output', text });
        ev.emit('agent', { id: agent.id, state: 'idle' });
        return text;
      } catch (err) {
        if (ctrl.signal.aborted) throw new StoppedError();
        ev.emit('agent', { id: agent.id, state: 'error' });
        ev.emit('log', { agentId: agent.id, kind: 'error', text: err.message || String(err) });
        throw err;
      }
    }

    async function runPipeline(wf, task, ctrl, runId) {
      const outputs = [];
      let prevAgentId = null;
      for (let i = 0; i < wf.steps.length; i++) {
        const step = wf.steps[i];
        const agent = agentById(step.agent);
        ev.emit('run', { status: 'step', runId, workflowId: wf.id, label: `${agent.name}：${step.label}`, index: i + 1, total: wf.steps.length, agentId: agent.id, stepIndex: i });
        if (prevAgentId && prevAgentId !== agent.id) {
          ev.emit('handoff', { from: prevAgentId, to: agent.id, label: step.label });
        }
        const vars = { task, prev: outputs[i - 1] || '' };
        outputs.forEach((o, k) => { vars['step' + (k + 1)] = o; });
        const out = await callAgent(agent, fill(step.prompt, vars), ctrl, 'working');
        outputs.push(out);
        ev.emit('say', { id: agent.id, text: `${step.label}完成` });
        prevAgentId = agent.id;
      }
      return { outputs, final: outputs[outputs.length - 1] || '' };
    }

    async function runMeeting(wf, task, ctrl, runId) {
      const people = wf.participants.map(agentById);
      const moderator = agentById(wf.moderator || wf.participants[0]);
      people.forEach((p) => ev.emit('move', { id: p.id, to: 'meeting' }));
      if (!people.includes(moderator)) ev.emit('move', { id: moderator.id, to: 'meeting' });

      const lines = [];
      const transcript = () => (lines.length ? lines.join('\n\n') : '（尚無發言）');
      const rounds = Math.max(1, wf.rounds || 1);
      const total = rounds * people.length + 1;
      let n = 0;
      for (let r = 1; r <= rounds; r++) {
        for (const p of people) {
          n++;
          ev.emit('run', { status: 'step', runId, workflowId: wf.id, label: `第 ${r} 輪：${p.name} 發言`, index: n, total, agentId: p.id, round: r });
          const out = await callAgent(p, fill(wf.turnPrompt, { task, transcript: transcript(), round: r }), ctrl, 'thinking');
          lines.push(`【${p.name}／${p.title}】${out}`);
          ev.emit('say', { id: p.id, text: snippet(out, 60) });
        }
      }
      ev.emit('run', { status: 'step', runId, workflowId: wf.id, label: `${moderator.name} 整理結論`, index: total, total, agentId: moderator.id, summary: true });
      const summary = await callAgent(moderator, fill(wf.summaryPrompt, { task, transcript: transcript() }), ctrl, 'thinking');
      ev.emit('say', { id: moderator.id, text: '結論整理好了！' });
      return { outputs: lines.concat([`【結論】${summary}`]), final: summary, transcript: transcript() };
    }

    function sendEveryoneHome() {
      getAgents().forEach((a) => {
        ev.emit('agent', { id: a.id, state: 'idle' });
        ev.emit('move', { id: a.id, to: a.room });
      });
    }

    async function run(workflowId, task) {
      if (current) throw new Error('已有任務進行中，請先停止或等待完成');
      const wf = getWorkflows().find((w) => w.id === workflowId);
      if (!wf) throw new Error(`找不到流程：${workflowId}`);
      if (!String(task || '').trim()) throw new Error('請輸入任務內容');

      const runId = new Date().toISOString().replace(/[:.]/g, '-');
      const controller = new AbortController();
      current = { runId, controller };
      ev.emit('run', { status: 'started', runId, workflowId: wf.id, label: wf.name, task: String(task) });
      ev.emit('log', { agentId: null, kind: 'system', text: `開始「${wf.name}」：${task}` });
      try {
        const result = wf.type === 'meeting'
          ? await runMeeting(wf, task, controller, runId)
          : await runPipeline(wf, task, controller, runId);
        ev.emit('run', { status: 'finished', runId, workflowId: wf.id });
        ev.emit('log', { agentId: null, kind: 'system', text: `「${wf.name}」完成` });
        return { runId, workflow: wf, task, ...result };
      } catch (err) {
        const stopped = !!(err && err.stopped);
        ev.emit('run', { status: stopped ? 'stopped' : 'failed', runId, workflowId: wf.id, error: err.message });
        ev.emit('log', { agentId: null, kind: stopped ? 'system' : 'error', text: stopped ? '任務已停止' : `任務失敗：${err.message}` });
        throw err;
      } finally {
        current = null;
        sendEveryoneHome();
      }
    }

    function stop() { if (current) current.controller.abort(); }

    return { on: ev.on.bind(ev), off: ev.off.bind(ev), run, stop, isRunning: () => !!current };
  }

  function composePrompt(agent, prompt) {
    const head = `你的名字是 ${agent.name}，職稱是「${agent.title}」。`;
    return `${head}\n${agent.systemPrompt || ''}\n\n---\n\n${prompt}`;
  }

  return { createOrchestrator, composePrompt, fill, snippet };
});
