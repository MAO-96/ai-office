// 日常任務：定時自動執行（每天／每週／手動），三種內容：
//   single    交辦單人：指定一位員工做一件事
//   workflow  協作流程：照流程讓多位員工合作
//   checklist 例行清單：每次產生一份當天的白板任務，逐項交給負責的員工
// 只在 AI Office 開著時執行；當天錯過的時間，開啟後會補跑一次。
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

function uid() { return 'rt-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function pad(n) { return String(n).padStart(2, '0'); }

function scheduledToday(r, now) {
  const s = r.schedule || {};
  if (s.type !== 'daily' && s.type !== 'weekly') return null;
  if (s.type === 'weekly' && !(s.days || []).includes(now.getDay())) return null;
  const [h, m] = String(s.time || '09:00').split(':').map((x) => parseInt(x, 10) || 0);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  return d;
}
function nextRunAt(r, now = new Date()) {
  if (!r.enabled) return null;
  const s = r.schedule || {};
  if (s.type !== 'daily' && s.type !== 'weekly') return null;
  for (let i = 0; i < 8; i++) {
    const day = new Date(now);
    day.setDate(now.getDate() + i);
    const t = scheduledToday(r, day);
    if (!t) continue;
    if (i === 0 && t <= now) {
      if (r.lastRunAt && Date.parse(r.lastRunAt) >= t.getTime()) continue; // 今天已經跑過
      return now.toISOString(); // 今天的時間已過但還沒跑：馬上補跑
    }
    return t.toISOString();
  }
  return null;
}
function describe(r) {
  const s = r.schedule || {};
  if (s.type === 'daily') return `每天 ${s.time}`;
  if (s.type === 'weekly') return `每週${(s.days || []).sort().map((d) => WEEK[d]).join('、')} ${s.time}`;
  return '手動執行';
}

function createRoutines({ store, board, startRun, emit, now = () => new Date() }) {
  let list = store.getRoutines();
  const save = () => { store.saveRoutines(list); emit('routines', view()); };
  function view() {
    return list.map((r) => ({ ...r, scheduleText: describe(r), nextRunAt: nextRunAt(r, now()) }));
  }

  function validate(r) {
    const agents = store.getAgents();
    const has = (id) => agents.some((a) => a.id === id);
    if (!String(r.title || '').trim()) throw new Error('請輸入日常任務名稱');
    if (!['single', 'workflow', 'checklist'].includes(r.kind)) throw new Error('請選擇日常任務的類型');
    if (r.kind === 'single' && !has(r.agentId)) throw new Error('請選擇要交辦的員工');
    if (r.kind === 'workflow' && !store.getWorkflows().some((w) => w.id === r.workflowId)) throw new Error('請選擇協作流程');
    if (r.kind !== 'checklist' && !String(r.prompt || '').trim()) throw new Error('請輸入要做的事');
    if (r.kind === 'checklist') {
      if (!Array.isArray(r.items) || !r.items.length) throw new Error('例行清單至少要有一項');
      r.items.forEach((it, i) => {
        if (!String(it.title || '').trim()) throw new Error(`第 ${i + 1} 項沒有內容`);
        if (!has(it.agentId)) throw new Error(`第 ${i + 1} 項請選擇負責的員工`);
      });
    }
    const s = r.schedule || {};
    if (!['daily', 'weekly', 'manual'].includes(s.type)) throw new Error('請選擇執行頻率');
    if (s.type !== 'manual' && !/^\d{1,2}:\d{2}$/.test(String(s.time || ''))) throw new Error('時間格式請用 09:00');
    if (s.type === 'weekly' && !(s.days || []).length) throw new Error('每週執行請至少選一天');
  }

  function upsert(input) {
    const r = {
      id: input.id || uid(),
      title: String(input.title || '').trim().slice(0, 60),
      kind: input.kind,
      agentId: input.agentId || null,
      workflowId: input.workflowId || null,
      prompt: String(input.prompt || '').trim(),
      items: (input.items || []).map((it) => ({ title: String(it.title || '').trim(), agentId: it.agentId })).filter((it) => it.title),
      schedule: { type: (input.schedule || {}).type || 'daily', time: (input.schedule || {}).time || '09:00', days: ((input.schedule || {}).days || []).map(Number) },
      enabled: input.enabled !== false,
    };
    validate(r);
    const i = list.findIndex((x) => x.id === r.id);
    if (i >= 0) {
      const prev = list[i];
      // 改了時間就從現在重新起算，避免一存檔就立刻補跑
      const timeChanged = JSON.stringify(prev.schedule) !== JSON.stringify(r.schedule);
      list[i] = { ...prev, ...r, lastRunAt: timeChanged ? now().toISOString() : prev.lastRunAt };
    } else {
      list.push({ ...r, createdAt: now().toISOString(), lastRunAt: now().toISOString(), lastStatus: null, runs: 0 });
    }
    save();
    return view();
  }
  function remove(id) { list = list.filter((x) => x.id !== id); save(); return view(); }
  function setEnabled(id, enabled) {
    const r = list.find((x) => x.id === id);
    if (!r) throw new Error('找不到這個日常任務');
    r.enabled = !!enabled;
    if (enabled) r.lastRunAt = now().toISOString();
    save();
    return view();
  }

  function trigger(r, reason) {
    r.lastRunAt = now().toISOString();
    r.runs = (r.runs || 0) + 1;
    r.lastStatus = 'started';
    const meta = { routineId: r.id, reason };
    const d = now();
    const stamp = `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
    const started = [];
    if (r.kind === 'single') {
      started.push(startRun({ kind: 'single', agentId: r.agentId, task: r.prompt, title: `${r.title}（${stamp}）`, meta }));
    } else if (r.kind === 'workflow') {
      started.push(startRun({ kind: 'workflow', workflowId: r.workflowId, task: r.prompt, title: `${r.title}（${stamp}）`, meta }));
    } else {
      const { tasks } = board.createChecklist(`例行：${r.title}（${stamp}）`, r.items);
      tasks.forEach((t, i) => {
        const it = r.items[i];
        const task = r.prompt ? `${it.title}\n\n背景說明：${r.prompt}` : it.title;
        started.push(startRun({ kind: 'single', agentId: it.agentId, task, title: `${r.title}：${it.title}`, meta: { ...meta, boardTaskId: t.id } }));
      });
    }
    emit('log', { agentId: null, kind: 'system', text: `日常任務「${r.title}」開始執行（${reason === 'manual' ? '手動' : '排程'}）` });
    save();
    return started.map((x) => x && x.runId).filter(Boolean);
  }
  function runNow(id) {
    const r = list.find((x) => x.id === id);
    if (!r) throw new Error('找不到這個日常任務');
    return { runIds: trigger(r, 'manual'), routines: view() };
  }
  function tick() {
    const t = now();
    for (const r of list) {
      if (!r.enabled) continue;
      const due = scheduledToday(r, t);
      if (!due || t < due) continue;
      if (r.lastRunAt && Date.parse(r.lastRunAt) >= due.getTime()) continue;
      try { trigger(r, 'schedule'); } catch (e) {
        r.lastStatus = 'error';
        r.lastError = e.message;
        save();
        emit('log', { agentId: null, kind: 'error', text: `日常任務「${r.title}」無法執行：${e.message}` });
      }
    }
  }
  let timer = null;
  function startScheduler(intervalMs = 30000) {
    if (timer) return;
    setTimeout(tick, 5000);
    timer = setInterval(tick, intervalMs);
    if (timer.unref) timer.unref();
  }
  // 任務結束時記下結果
  function onRunDone(meta, status, error) {
    if (!meta || !meta.routineId) return;
    const r = list.find((x) => x.id === meta.routineId);
    if (!r) return;
    r.lastStatus = status;
    r.lastError = error || null;
    save();
  }

  return { view, upsert, remove, setEnabled, runNow, tick, startScheduler, onRunDone };
}

module.exports = { createRoutines, nextRunAt, describe };
