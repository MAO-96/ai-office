/*
 * 協調核心：與執行環境無關（伺服器、Electron、瀏覽器預覽共用）。
 * 不直接呼叫任何 AI，只透過注入的 runAgent(agent, prompt, opts) 取得回覆。
 * 支援多個任務平行執行，每個任務有自己的 runId、追加指示、追問與停止。
 *
 * 發出的事件（除角色動畫外都帶 runId）：
 *   run      { runId, status: 'queued'|'started'|'step'|'substep'|'asking'|'finished'|'failed'|'stopped', ... }
 *   agent    { id, state: 'idle'|'working'|'thinking'|'talking'|'error' }
 *   move     { id, to }
 *   handoff  { runId, from, to, label }
 *   say      { runId, id, text }
 *   log      { runId, agentId, kind: 'system'|'prompt'|'chunk'|'output'|'error', text }
 *   ask      { source: 'run', runId, agentId, agentName, questions }
 *   ask-done { source: 'run', runId }
 *   note     { runId, notes }
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

  // ---------- 釐清需求（企劃先追問） ----------
  function clarifyPrompt(task, qa) {
    const asked = qa && qa.length
      ? `\n已經問過並得到的回答：\n${qa.map((x) => `Q：${x.q}\nA：${x.a}`).join('\n')}\n`
      : '';
    return [
      '【釐清需求】開始動工之前，請先判斷這個需求是否已經清楚到可以直接做。',
      `需求：${task}`,
      asked,
      '如果有不清楚、而且會影響做法或成品的地方，請提出最多 4 個最關鍵的問題，每題盡量附上 2～4 個選項讓使用者直接選。',
      '已經夠清楚、或剩下的細節可以合理自行決定時，questions 給空陣列。',
      '只輸出 JSON，不要任何其他文字。格式：{"questions":[{"q":"問題","options":["選項A","選項B"]}]}',
    ].join('\n');
  }
  function parseQuestions(text) {
    const t = String(text || '');
    const m = t.match(/\{[\s\S]*"questions"[\s\S]*\}/);
    if (m) {
      try {
        const j = JSON.parse(m[0]);
        return (j.questions || []).slice(0, 5).map((x) => (typeof x === 'string' ? { q: x, options: [] } : {
          q: String(x.q || x.question || '').trim(),
          options: Array.isArray(x.options) ? x.options.map(String).slice(0, 6) : [],
        })).filter((x) => x.q);
      } catch (_) { /* 退回逐行解析 */ }
    }
    return t.split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, '').trim())
      .filter((l) => /[?？]$/.test(l)).slice(0, 5).map((q) => ({ q, options: [] }));
  }
  function withAnswers(task, qa) {
    if (!qa || !qa.length) return task;
    return `${task}\n\n【需求確認（使用者的回答）】\n${qa.map((x) => `- ${x.q}\n  → ${x.a}`).join('\n')}`;
  }
  function withNotes(prompt, notes) {
    if (!notes || !notes.length) return prompt;
    return `${prompt}\n\n【使用者追加的指示（請一併遵守；若和前面的內容衝突，以這裡為準）】\n${notes.map((n) => `- ${n}`).join('\n')}`;
  }

  // ---------- 審查辯論 ----------
  const SKEPTIC = [
    '你現在是這份成果的審查官，請採取懷疑與挑戰的立場：',
    '- 預設這份成果一定有問題，主動找出錯誤、漏洞、沒有根據的假設、遺漏的需求、風險，以及更好的替代做法。',
    '- 要求對方說明理由或拿出證據；不接受「應該可以」「大概沒問題」這類說法。',
    '- 不要客套、不要因為對方堅持就讓步；但對方提出充分理由或已經改好時，要明確承認。',
    '- 每個問題編號，寫出「問題 → 為什麼是問題 → 建議怎麼改」。',
  ].join('\n');
  function stanceOf(text) {
    const t = String(text || '');
    const m = t.match(/立場[：:]\s*(同意|有異議|反對|不同意)/g);
    if (!m) return /結論[：:]\s*(可以|通過|同意)/.test(t) ? 'agree' : 'object';
    return /同意$/.test(m[m.length - 1]) && !/不同意$/.test(m[m.length - 1]) ? 'agree' : 'object';
  }
  function revisedOf(text) {
    const t = String(text || '');
    const i = t.lastIndexOf('【修訂版】');
    return i >= 0 ? t.slice(i + '【修訂版】'.length).trim() : '';
  }

  function createOrchestrator({ getAgents, getWorkflows, runAgent, maxParallel = () => 3 }) {
    const ev = createEmitter();
    const runs = new Map(); // runId -> { runId, controller, notes, ask, title, meta }
    const waiting = [];     // 排隊中的任務
    const busy = new Map(); // agentId -> 同時在做幾件事
    const meeting = new Map(); // agentId -> 在幾個會議中

    function agentById(id) {
      const a = getAgents().find((x) => x.id === id);
      if (!a) throw new Error(`找不到角色：${id}`);
      return a;
    }
    function checkStop(ctrl) { if (ctrl.signal.aborted) throw new StoppedError(); }
    const inc = (m, id) => m.set(id, (m.get(id) || 0) + 1);
    const dec = (m, id) => { const n = (m.get(id) || 0) - 1; if (n <= 0) m.delete(id); else m.set(id, n); };

    function goHomeIfFree(id) {
      if (busy.get(id) || meeting.get(id)) return;
      const a = getAgents().find((x) => x.id === id);
      if (!a) return;
      ev.emit('agent', { id, state: 'idle' });
      ev.emit('move', { id, to: a.room });
    }
    function gather(r, ids) {
      ids.forEach((id) => { inc(meeting, id); r.gathered.push(id); ev.emit('move', { id, to: 'meeting' }); });
    }
    function release(r, ids) {
      ids.forEach((id) => {
        const i = r.gathered.indexOf(id);
        if (i >= 0) { r.gathered.splice(i, 1); dec(meeting, id); goHomeIfFree(id); }
      });
    }

    async function callAgent(r, agent, prompt, stateWhileRunning, quiet) {
      checkStop(r.controller);
      prompt = withNotes(prompt, r.notes);
      inc(busy, agent.id);
      ev.emit('agent', { id: agent.id, state: stateWhileRunning || 'working' });
      ev.emit('log', { runId: r.runId, agentId: agent.id, kind: 'prompt', text: prompt });
      try {
        const out = await runAgent(agent, prompt, {
          signal: r.controller.signal,
          onChunk: (chunk) => { if (!quiet) ev.emit('log', { runId: r.runId, agentId: agent.id, kind: 'chunk', text: chunk }); },
        });
        checkStop(r.controller);
        const text = String(out || '').trim();
        if (!quiet) ev.emit('log', { runId: r.runId, agentId: agent.id, kind: 'output', text });
        return text;
      } catch (err) {
        if (r.controller.signal.aborted) throw new StoppedError();
        ev.emit('agent', { id: agent.id, state: 'error' });
        ev.emit('log', { runId: r.runId, agentId: agent.id, kind: 'error', text: err.message || String(err) });
        throw err;
      } finally {
        dec(busy, agent.id);
        if (!busy.get(agent.id)) ev.emit('agent', { id: agent.id, state: 'idle' });
      }
    }

    // ---------- 追問 ----------
    function askUser(r, agent, questions) {
      return new Promise((resolve, reject) => {
        const onAbort = () => { r.ask = null; reject(new StoppedError()); };
        r.controller.signal.addEventListener('abort', onAbort, { once: true });
        r.ask = { agentId: agent.id, questions, resolve: (a) => { r.controller.signal.removeEventListener('abort', onAbort); resolve(a); } };
        ev.emit('run', { runId: r.runId, status: 'asking', label: `${agent.name} 等你回答問題` });
        ev.emit('agent', { id: agent.id, state: 'talking' });
        ev.emit('say', { runId: r.runId, id: agent.id, text: `想先跟你確認 ${questions.length} 件事` });
        ev.emit('ask', { source: 'run', runId: r.runId, agentId: agent.id, agentName: agent.name, questions, title: r.title });
        ev.emit('log', { runId: r.runId, agentId: agent.id, kind: 'system', text: `${agent.name} 想先確認：\n${questions.map((q, i) => `${i + 1}. ${q.q}`).join('\n')}` });
      });
    }
    async function clarify(r, task, agent) {
      const qa = [];
      for (let round = 1; round <= 2; round++) {
        ev.emit('run', { runId: r.runId, status: 'step', label: `${agent.name}：確認需求`, index: 0, total: 0, agentId: agent.id, clarify: true });
        const out = await callAgent(r, agent, clarifyPrompt(task, qa), 'thinking', true);
        const questions = parseQuestions(out);
        if (!questions.length) break;
        const answers = await askUser(r, agent, questions);
        r.ask = null;
        ev.emit('ask-done', { source: 'run', runId: r.runId });
        if (!answers) { ev.emit('log', { runId: r.runId, agentId: null, kind: 'system', text: '你選擇跳過確認，直接開始' }); break; }
        answers.forEach((a) => { if (a && String(a.a || '').trim()) qa.push({ q: a.q, a: String(a.a).trim() }); });
        ev.emit('log', { runId: r.runId, agentId: null, kind: 'system', text: `你的回答：\n${answers.map((a) => `- ${a.q} → ${a.a || '（未回答）'}`).join('\n')}` });
      }
      if (qa.length) ev.emit('say', { runId: r.runId, id: agent.id, text: '了解，我照這個方向來做！' });
      return withAnswers(task, qa);
    }

    // ---------- 審查辯論：懷疑 → 回應/修訂 → 再審，直到共識或達到輪數上限 ----------
    async function debate(r, { task, reviewer, owner, others, deliverable, maxRounds, stepIndex }) {
      const people = [reviewer, owner, ...others];
      gather(r, people.map((p) => p.id));
      const transcript = [];
      const tx = () => (transcript.length ? transcript.join('\n\n') : '（尚無討論）');
      let current = deliverable;
      let consensus = false;
      let rounds = 0;
      try {
        for (let round = 1; round <= maxRounds; round++) {
          rounds = round;
          ev.emit('run', { runId: r.runId, status: 'substep', label: `審查討論 第 ${round} 輪：${reviewer.name} 質疑`, agentId: reviewer.id, stepIndex, round, maxRounds });
          const critique = await callAgent(r, reviewer, [
            SKEPTIC,
            `\n【審查討論】第 ${round} 輪（最多 ${maxRounds} 輪）`,
            `任務：${task}`,
            `目前的成果：\n${current}`,
            `目前為止的討論：\n${tx()}`,
            round > 1 ? '請確認上一輪的問題是否真的解決，再找新的問題；已解決的要明說。' : '',
            '最後一行只寫「立場：同意」（已沒有重大問題，可以定案）或「立場：有異議」。',
          ].filter(Boolean).join('\n'), 'thinking');
          transcript.push(`【${reviewer.name}（審查）第 ${round} 輪】${critique}`);
          if (stanceOf(critique) === 'agree') {
            consensus = true;
            ev.emit('say', { runId: r.runId, id: reviewer.id, text: '我同意了，可以定案。' });
            break;
          }
          ev.emit('say', { runId: r.runId, id: reviewer.id, text: snippet(critique.split('\n').find((l) => l.trim()) || '我有異議', 50) });

          // 其他員工先表達專業意見（可支持任一方）
          for (const o of others) {
            ev.emit('run', { runId: r.runId, status: 'substep', label: `審查討論 第 ${round} 輪：${o.name} 發表意見`, agentId: o.id, stepIndex, round, maxRounds });
            const view = await callAgent(r, o, [
              `【審查討論】第 ${round} 輪。審查官 ${reviewer.name} 對成果提出質疑，請你以「${o.title}」的專業角度表達意見：`,
              '哪些質疑成立、哪些不成立、理由是什麼、你建議怎麼處理。可以支持任一方，但要有根據。精簡條列。',
              `任務：${task}`,
              `目前的成果：\n${current}`,
              `討論紀錄：\n${tx()}`,
            ].join('\n'), 'thinking');
            transcript.push(`【${o.name}（${o.title}）第 ${round} 輪】${view}`);
            ev.emit('say', { runId: r.runId, id: o.id, text: snippet(view, 50) });
          }

          // 負責人逐點回應並修訂
          ev.emit('run', { runId: r.runId, status: 'substep', label: `審查討論 第 ${round} 輪：${owner.name} 回應與修訂`, agentId: owner.id, stepIndex, round, maxRounds });
          ev.emit('handoff', { runId: r.runId, from: reviewer.id, to: owner.id, label: '審查意見' });
          const reply = await callAgent(r, owner, [
            `【審查討論】第 ${round} 輪。你是這份成果的負責人，審查官 ${reviewer.name} 提出了質疑，其他同事也給了意見。`,
            '請逐點回應：接受的，說明怎麼改；不接受的，提出理由或證據反駁（不要為了妥協而亂改）。',
            '最後另起一段，以「【修訂版】」開頭，輸出修改後「完整」的成果（不是只寫差異）。',
            `任務：${task}`,
            `目前的成果：\n${current}`,
            `討論紀錄：\n${tx()}`,
          ].join('\n'), 'working');
          const revised = revisedOf(reply);
          if (revised) current = revised;
          transcript.push(`【${owner.name}（負責人）第 ${round} 輪回應】${revised ? reply.slice(0, reply.lastIndexOf('【修訂版】')).trim() || '（已修訂）' : reply}`);
          ev.emit('say', { runId: r.runId, id: owner.id, text: revised ? '已依討論修訂，請再看看' : '我說明了我的理由' });
        }

        let verdict;
        if (consensus) {
          verdict = `經過 ${rounds} 輪審查討論，${reviewer.name} 與團隊已達成共識。`;
        } else {
          ev.emit('run', { runId: r.runId, status: 'substep', label: `審查討論：${reviewer.name} 做最終裁決`, agentId: reviewer.id, stepIndex, round: maxRounds, maxRounds });
          const final = await callAgent(r, reviewer, [
            `【審查討論】已經討論 ${maxRounds} 輪，仍有分歧。請放下立場，以客觀角度做最終裁決：`,
            '1) 已有共識的部分 2) 仍有分歧之處，各方理由 3) 你判斷最好的做法與理由。',
            '最後另起一段，以「【修訂版】」開頭，輸出你認為最好的完整成果。',
            `任務：${task}`,
            `目前的成果：\n${current}`,
            `完整討論：\n${tx()}`,
          ].join('\n'), 'thinking');
          const best = revisedOf(final);
          if (best) current = best;
          transcript.push(`【${reviewer.name} 最終裁決】${best ? final.slice(0, final.lastIndexOf('【修訂版】')).trim() : final}`);
          verdict = `討論 ${maxRounds} 輪仍有分歧，以下為 ${reviewer.name} 綜合各方意見後的最佳版本。`;
        }
        return { result: current, consensus, rounds, transcript: tx(), verdict };
      } finally {
        release(r, people.map((p) => p.id));
      }
    }

    // ---------- 各種流程 ----------
    async function runPipeline(r, wf, task) {
      const outputs = [];
      let prevAgentId = null;
      const extra = {};
      for (let i = 0; i < wf.steps.length; i++) {
        const step = wf.steps[i];
        const agent = agentById(step.agent);
        ev.emit('run', { runId: r.runId, status: 'step', label: `${agent.name}：${step.label}`, index: i + 1, total: wf.steps.length, agentId: agent.id, stepIndex: i, review: step.type === 'review' });
        if (prevAgentId && prevAgentId !== agent.id) ev.emit('handoff', { runId: r.runId, from: prevAgentId, to: agent.id, label: step.label });
        if (step.type === 'review') {
          const before = wf.steps.slice(0, i).map((s) => s.agent).filter((id) => id !== agent.id);
          const withIds = (step.with && step.with.length ? step.with : [...new Set(before)].reverse()).filter((id) => id !== agent.id);
          if (!withIds.length) throw new Error(`「${step.label}」沒有可以討論的對象，請在流程設定 with`);
          const ownerId = withIds.includes(prevAgentId) ? prevAgentId : withIds[0];
          const owner = agentById(ownerId);
          const others = withIds.filter((id) => id !== ownerId).map(agentById);
          const d = await debate(r, {
            task, reviewer: agent, owner, others, deliverable: outputs[i - 1] || task,
            maxRounds: Math.max(1, Math.min(6, step.maxRounds || 3)), stepIndex: i,
          });
          extra.debate = d;
          outputs.push(d.result);
          ev.emit('log', { runId: r.runId, agentId: null, kind: 'system', text: d.verdict });
        } else {
          const vars = { task, prev: outputs[i - 1] || '' };
          outputs.forEach((o, k) => { vars['step' + (k + 1)] = o; });
          const out = await callAgent(r, agent, fill(step.prompt, vars), 'working');
          outputs.push(out);
          ev.emit('say', { runId: r.runId, id: agent.id, text: `${step.label}完成` });
        }
        prevAgentId = agent.id;
      }
      const d = extra.debate;
      const final = d ? `${d.verdict}\n\n${d.result}` : (outputs[outputs.length - 1] || '');
      return { outputs: d ? outputs.concat([`【審查討論紀錄】\n${d.transcript}`]) : outputs, final, debate: d || null };
    }

    async function runMeeting(r, wf, task) {
      const people = wf.participants.map(agentById);
      const moderator = agentById(wf.moderator || wf.participants[0]);
      const ids = [...new Set(people.map((p) => p.id).concat(moderator.id))];
      gather(r, ids);
      try {
        const lines = [];
        const transcript = () => (lines.length ? lines.join('\n\n') : '（尚無發言）');
        const rounds = Math.max(1, wf.rounds || 1);
        const total = rounds * people.length + 1;
        let n = 0;
        for (let round = 1; round <= rounds; round++) {
          for (const p of people) {
            n++;
            ev.emit('run', { runId: r.runId, status: 'step', label: `第 ${round} 輪：${p.name} 發言`, index: n, total, agentId: p.id, round });
            const out = await callAgent(r, p, fill(wf.turnPrompt, { task, transcript: transcript(), round }), 'thinking');
            lines.push(`【${p.name}／${p.title}】${out}`);
            ev.emit('say', { runId: r.runId, id: p.id, text: snippet(out, 60) });
          }
        }
        ev.emit('run', { runId: r.runId, status: 'step', label: `${moderator.name} 整理結論`, index: total, total, agentId: moderator.id, summary: true });
        const summary = await callAgent(r, moderator, fill(wf.summaryPrompt, { task, transcript: transcript() }), 'thinking');
        ev.emit('say', { runId: r.runId, id: moderator.id, text: '結論整理好了！' });
        return { outputs: lines.concat([`【結論】${summary}`]), final: summary, transcript: transcript() };
      } finally {
        release(r, ids);
      }
    }

    async function runSingle(r, wf, task) {
      const agent = agentById(wf.agent);
      ev.emit('run', { runId: r.runId, status: 'step', label: `${agent.name}：處理中`, index: 1, total: 1, agentId: agent.id, stepIndex: 0 });
      const out = await callAgent(r, agent, `請完成以下工作，直接給出成果：\n${task}`, 'working');
      ev.emit('say', { runId: r.runId, id: agent.id, text: '完成了！' });
      return { outputs: [out], final: out };
    }

    // ---------- 排隊與執行 ----------
    function activeCount() { let n = 0; runs.forEach((r) => { if (!r.queued) n++; }); return n; }
    function pump() {
      while (waiting.length && activeCount() < Math.max(1, maxParallel())) {
        const next = waiting.shift();
        next.queued = false;
        next.go();
      }
    }

    function resolveWorkflow(spec) {
      if (spec && typeof spec === 'object') return spec;
      const wf = getWorkflows().find((w) => w.id === spec);
      if (!wf) throw new Error(`找不到流程：${spec}`);
      return wf;
    }

    /**
     * 開始一個任務（可同時多個）。
     * @param spec  流程 id，或流程物件（例如 { type:'single', agent:'dev', name:'交辦' }）
     * @param opts  { runId, clarify, title, meta }
     */
    function run(spec, task, opts = {}) {
      const wf = resolveWorkflow(spec);
      if (!String(task || '').trim()) return Promise.reject(new Error('請輸入任務內容'));
      if (wf.type === 'single') agentById(wf.agent);
      const runId = opts.runId || ('r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
      const r = {
        runId, controller: new AbortController(), notes: [], ask: null, gathered: [],
        title: String(opts.title || task).split('\n')[0].slice(0, 60), workflow: wf, meta: opts.meta || null, queued: true,
      };
      runs.set(runId, r);
      const info = { runId, workflowId: wf.id || null, workflowName: wf.name || '', type: wf.type, agent: wf.agent || null, label: wf.name || '交辦', task: String(task), title: r.title, meta: r.meta };
      return new Promise((resolve, reject) => {
        r.go = async () => {
          ev.emit('run', { ...info, status: 'started' });
          ev.emit('log', { runId, agentId: null, kind: 'system', text: `開始「${r.title}」${wf.name ? `（${wf.name}）` : ''}` });
          try {
            let t = String(task);
            if (opts.clarify && wf.type !== 'single') {
              const who = agentById(wf.type === 'meeting' ? (wf.moderator || wf.participants[0]) : wf.steps[0].agent);
              t = await clarify(r, t, who);
            } else if (opts.clarify && wf.type === 'single') {
              t = await clarify(r, t, agentById(wf.agent));
            }
            const result = wf.type === 'meeting' ? await runMeeting(r, wf, t)
              : wf.type === 'single' ? await runSingle(r, wf, t)
                : await runPipeline(r, wf, t);
            ev.emit('run', { runId, status: 'finished', final: result.final, consensus: result.debate ? result.debate.consensus : null });
            ev.emit('log', { runId, agentId: null, kind: 'system', text: `「${r.title}」完成` });
            resolve({ runId, workflow: wf, task: t, title: r.title, ...result });
          } catch (err) {
            const stopped = !!(err && err.stopped);
            ev.emit('run', { runId, status: stopped ? 'stopped' : 'failed', error: err.message });
            ev.emit('log', { runId, agentId: null, kind: stopped ? 'system' : 'error', text: stopped ? '任務已停止' : `任務失敗：${err.message}` });
            reject(err);
          } finally {
            release(r, r.gathered.slice());
            runs.delete(runId);
            pump();
          }
        };
        waiting.push(r);
        ev.emit('run', { ...info, status: 'queued' });
        pump();
      });
    }

    function get(runId) {
      const r = runs.get(runId);
      if (!r) throw new Error('找不到這個任務，可能已經結束');
      return r;
    }
    function stop(runId) {
      if (runId) {
        const r = runs.get(runId);
        if (!r) return;
        const qi = waiting.indexOf(r);
        if (qi >= 0) {
          waiting.splice(qi, 1);
          runs.delete(runId);
          ev.emit('run', { runId, status: 'stopped', error: '已取消排隊' });
          return;
        }
        r.controller.abort();
        return;
      }
      [...runs.keys()].forEach((id) => stop(id));
    }
    // 隨時追加指示：該任務下一位開始工作的成員就會帶入
    function addNote(runId, text) {
      const t = String(text || '').trim();
      if (!t) throw new Error('請輸入要追加的指示');
      const r = get(runId);
      r.notes.push(t);
      ev.emit('note', { runId, notes: r.notes.slice() });
      ev.emit('log', { runId, agentId: null, kind: 'system', text: `你追加了指示：${t}（下一位成員開始時生效）` });
      return r.notes.slice();
    }
    function answer(runId, answers) {
      const r = get(runId);
      if (!r.ask) throw new Error('這個任務目前沒有等待回答的問題');
      const a = r.ask;
      r.ask = null;
      a.resolve(answers);
      return true;
    }
    function pendingAsks() {
      const out = [];
      runs.forEach((r) => {
        if (!r.ask) return;
        const ag = getAgents().find((x) => x.id === r.ask.agentId);
        out.push({ source: 'run', runId: r.runId, agentId: r.ask.agentId, agentName: ag ? ag.name : r.ask.agentId, questions: r.ask.questions, title: r.title });
      });
      return out;
    }
    function notes(runId) { const r = runs.get(runId); return r ? r.notes.slice() : []; }

    return {
      on: ev.on.bind(ev), off: ev.off.bind(ev), run, stop, addNote, answer, pendingAsks, notes,
      isRunning: () => runs.size > 0,
      activeIds: () => [...runs.keys()],
      busyAgents: () => [...busy.keys()],
    };
  }

  function composePrompt(agent, prompt) {
    const head = `你的名字是 ${agent.name}，職稱是「${agent.title}」。`;
    return `${head}\n${agent.systemPrompt || ''}\n\n---\n\n${prompt}`;
  }

  return { createOrchestrator, composePrompt, fill, snippet, clarifyPrompt, parseQuestions, withAnswers, withNotes, stanceOf, revisedOf };
});
