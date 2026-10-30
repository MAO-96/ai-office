// 任務板：所有白板（各處室＋會議室總覽）都讀這一份資料，不重複輸入。
// 結構：{ projects: [{ id, title, source, status, createdAt, updatedAt }],
//         tasks:    [{ id, projectId, title, agentId, room, status, progress, note, order, updatedAt }] }
// status：todo 待辦 / doing 進行中 / done 完成 / blocked 卡住
const fs = require('fs');
const path = require('path');

const STATUSES = ['todo', 'doing', 'done', 'blocked'];
const MAX_DONE_PROJECTS = 30; // 完成的專案最多保留幾個，避免白板越來越長

function uid(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

function createTaskBoard({ file, getAgents, emit }) {
  let data = { projects: [], tasks: [] };
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* 第一次使用 */ }
  data.projects = data.projects || [];
  data.tasks = data.tasks || [];

  const now = () => new Date().toISOString();
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    emit('tasks', snapshot());
  }
  function agentRoom(agentId) {
    const a = getAgents().find((x) => x.id === agentId);
    return a ? a.room : null;
  }
  function touchProject(projectId) {
    const p = data.projects.find((x) => x.id === projectId);
    if (!p) return;
    p.updatedAt = now();
    const ts = data.tasks.filter((t) => t.projectId === projectId);
    if (!ts.length) return;
    if (ts.some((t) => t.status === 'blocked')) p.status = 'blocked';
    else if (ts.every((t) => t.status === 'done')) p.status = 'done';
    else if (ts.some((t) => t.status === 'doing' || t.status === 'done')) p.status = 'doing';
    else p.status = 'todo';
  }
  function prune() {
    const done = data.projects.filter((p) => p.status === 'done').sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    const drop = new Set(done.slice(MAX_DONE_PROJECTS).map((p) => p.id));
    if (!drop.size) return;
    data.projects = data.projects.filter((p) => !drop.has(p.id));
    data.tasks = data.tasks.filter((t) => !drop.has(t.projectId));
  }

  function snapshot() { return JSON.parse(JSON.stringify(data)); }

  // ---------- 手動操作 ----------
  function upsertProject(p) {
    const title = String((p && p.title) || '').trim();
    if (!title) throw new Error('請輸入專案名稱');
    let proj = p.id && data.projects.find((x) => x.id === p.id);
    if (!proj) {
      proj = { id: uid('p'), title, source: 'manual', status: 'todo', createdAt: now(), updatedAt: now() };
      data.projects.unshift(proj);
    } else {
      proj.title = title;
      proj.updatedAt = now();
    }
    save();
    return proj;
  }
  function deleteProject(id) {
    data.projects = data.projects.filter((p) => p.id !== id);
    data.tasks = data.tasks.filter((t) => t.projectId !== id);
    save();
  }
  function upsertTask(t) {
    if (!t) throw new Error('任務資料錯誤');
    let task = t.id && data.tasks.find((x) => x.id === t.id);
    if (!task) {
      const title = String(t.title || '').trim();
      if (!title) throw new Error('請輸入任務名稱');
      let projectId = t.projectId;
      if (!projectId || !data.projects.some((p) => p.id === projectId)) {
        // 沒選專案時放到「日常事項」
        let daily = data.projects.find((p) => p.source === 'daily');
        if (!daily) {
          daily = { id: uid('p'), title: '日常事項', source: 'daily', status: 'todo', createdAt: now(), updatedAt: now() };
          data.projects.push(daily);
        }
        projectId = daily.id;
      }
      task = {
        id: uid('t'), projectId, title, agentId: t.agentId || null,
        room: t.room || agentRoom(t.agentId) || 'planning',
        status: 'todo', progress: 0, note: '', order: data.tasks.length, updatedAt: now(),
      };
      data.tasks.push(task);
    }
    if ('title' in t && String(t.title).trim()) task.title = String(t.title).trim();
    if ('agentId' in t) { task.agentId = t.agentId || null; if (t.agentId && !t.room) task.room = agentRoom(t.agentId) || task.room; }
    if ('room' in t && t.room) task.room = t.room;
    if ('note' in t) task.note = String(t.note || '').slice(0, 500);
    if ('status' in t && STATUSES.includes(t.status)) {
      task.status = t.status;
      if (t.status === 'done') task.progress = 100;
      if (t.status === 'todo' && !('progress' in t)) task.progress = 0;
    }
    if ('progress' in t) {
      task.progress = Math.max(0, Math.min(100, Math.round(Number(t.progress) || 0)));
      if (task.progress === 100 && !('status' in t)) task.status = 'done';
      else if (task.progress > 0 && task.status === 'todo') task.status = 'doing';
    }
    task.updatedAt = now();
    touchProject(task.projectId);
    save();
    return task;
  }
  function deleteTask(id) {
    const t = data.tasks.find((x) => x.id === id);
    data.tasks = data.tasks.filter((x) => x.id !== id);
    if (t) touchProject(t.projectId);
    save();
  }
  function clearDone() {
    const keep = new Set(data.projects.filter((p) => p.status !== 'done').map((p) => p.id));
    data.projects = data.projects.filter((p) => keep.has(p.id));
    data.tasks = data.tasks.filter((t) => keep.has(t.projectId));
    save();
  }

  // ---------- 流程執行時自動追蹤 ----------
  const runs = {}; // runId -> { projectId, type, current, meetingTurns }
  function onRunEvent(d, workflow) {
    // 例行清單的單項：直接更新那一格任務，不另開專案
    if (d.status === 'started' && d.meta && d.meta.boardTaskId) {
      runs[d.runId] = { linked: d.meta.boardTaskId };
      const t = data.tasks.find((x) => x.id === d.meta.boardTaskId);
      if (t) { t.status = 'doing'; t.progress = Math.max(t.progress || 0, 10); t.updatedAt = now(); touchProject(t.projectId); save(); }
      return;
    }
    if (runs[d.runId] && runs[d.runId].linked) {
      const t = data.tasks.find((x) => x.id === runs[d.runId].linked);
      if (t && d.status === 'finished') { t.status = 'done'; t.progress = 100; t.note = ''; }
      if (t && (d.status === 'failed' || d.status === 'stopped')) { t.status = 'blocked'; t.note = d.status === 'stopped' ? '已手動停止' : String(d.error || '執行失敗').slice(0, 300); }
      if (t && ['finished', 'failed', 'stopped'].includes(d.status)) { t.updatedAt = now(); touchProject(t.projectId); delete runs[d.runId]; save(); }
      return;
    }
    if (d.status === 'started' && workflow) {
      const proj = {
        id: 'run-' + d.runId, title: String(d.title || d.task || workflow.name).slice(0, 80), source: workflow.type === 'single' ? 'quick' : 'workflow',
        workflow: workflow.name || '交辦', runId: d.runId, status: 'doing', createdAt: now(), updatedAt: now(),
      };
      data.projects.unshift(proj);
      const r = runs[d.runId] = { projectId: proj.id, type: workflow.type, current: null, rounds: workflow.rounds || 1 };
      if (workflow.type === 'meeting') {
        const people = workflow.participants || [];
        people.forEach((id, i) => data.tasks.push({
          id: `${proj.id}-m${i}`, projectId: proj.id, title: `會議發言（${r.rounds} 輪）`, agentId: id, room: agentRoom(id),
          status: 'todo', progress: 0, note: '', order: i, updatedAt: now(), turns: 0,
        }));
        data.tasks.push({
          id: `${proj.id}-sum`, projectId: proj.id, title: '整理會議結論', agentId: workflow.moderator, room: agentRoom(workflow.moderator),
          status: 'todo', progress: 0, note: '', order: people.length, updatedAt: now(),
        });
      } else if (workflow.type === 'single') {
        data.tasks.push({
          id: `${proj.id}-s0`, projectId: proj.id, title: String(d.title || d.task).slice(0, 60), agentId: workflow.agent, room: agentRoom(workflow.agent),
          status: 'todo', progress: 0, note: '', order: 0, updatedAt: now(),
        });
      } else {
        (workflow.steps || []).forEach((st, i) => data.tasks.push({
          id: `${proj.id}-s${i}`, projectId: proj.id,
          title: st.type === 'review' ? `${st.label}（最多 ${st.maxRounds || 3} 輪）` : st.label,
          agentId: st.agent, room: agentRoom(st.agent),
          status: 'todo', progress: 0, note: '', order: i, updatedAt: now(),
        }));
      }
      prune();
      save();
      return;
    }
    const r = runs[d.runId];
    if (!r) return;
    const finishCurrent = () => {
      const cur = r.current && data.tasks.find((t) => t.id === r.current);
      if (!cur || cur.status === 'done') return;
      if (r.type === 'meeting' && !cur.id.endsWith('-sum')) {
        cur.turns = (cur.turns || 0) + 1;
        cur.progress = Math.round((cur.turns / r.rounds) * 100);
        cur.status = cur.turns >= r.rounds ? 'done' : 'doing';
      } else {
        cur.status = 'done';
        cur.progress = 100;
      }
      cur.updatedAt = now();
    };
    if (d.status === 'step' && d.clarify) return; // 確認需求不佔任務格
    if (d.status === 'substep') {
      // 審查討論：依輪數推進度，並寫上目前在做什麼
      const t = data.tasks.find((x) => x.id === `${r.projectId}-s${d.stepIndex}`);
      if (t) {
        t.progress = Math.min(95, Math.round(((d.round - 1) / (d.maxRounds || 3)) * 100) + 10);
        t.note = d.label;
        t.updatedAt = now();
        save();
      }
      return;
    }
    if (d.status === 'step') {
      finishCurrent();
      let id;
      if (r.type === 'meeting') {
        id = d.summary ? `${r.projectId}-sum` : (data.tasks.find((t) => t.projectId === r.projectId && t.agentId === d.agentId && !t.id.endsWith('-sum')) || {}).id;
      } else {
        id = `${r.projectId}-s${d.stepIndex}`;
      }
      const t = data.tasks.find((x) => x.id === id);
      if (t) {
        t.status = 'doing';
        if (t.progress === 0) t.progress = r.type === 'meeting' ? t.progress : 10;
        t.updatedAt = now();
      }
      r.current = id;
      touchProject(r.projectId);
      save();
    } else if (d.status === 'finished') {
      finishCurrent();
      data.tasks.filter((t) => t.projectId === r.projectId).forEach((t) => {
        t.status = 'done'; t.progress = 100;
        if (t.title.startsWith('審查討論')) t.note = d.consensus === false ? '討論後仍有分歧，已由審查官裁決' : d.consensus ? '已達成共識' : '';
      });
      touchProject(r.projectId);
      delete runs[d.runId];
      save();
    } else if (d.status === 'failed' || d.status === 'stopped') {
      const cur = r.current && data.tasks.find((t) => t.id === r.current);
      if (cur) {
        cur.status = 'blocked';
        cur.note = d.status === 'stopped' ? '已手動停止' : String(d.error || '執行失敗').slice(0, 300);
        cur.updatedAt = now();
      }
      touchProject(r.projectId);
      delete runs[d.runId];
      save();
    }
  }

  // 例行清單：產生一個當天的專案與各項任務
  function createChecklist(title, items) {
    const proj = { id: uid('p'), title, source: 'routine', status: 'todo', createdAt: now(), updatedAt: now() };
    data.projects.unshift(proj);
    const tasks = items.map((it, i) => {
      const t = {
        id: uid('t'), projectId: proj.id, title: String(it.title).slice(0, 80), agentId: it.agentId || null,
        room: agentRoom(it.agentId) || 'planning', status: 'todo', progress: 0, note: '', order: i, updatedAt: now(),
      };
      data.tasks.push(t);
      return t;
    });
    prune();
    save();
    return { project: proj, tasks };
  }

  return { snapshot, upsertProject, deleteProject, upsertTask, deleteTask, clearDone, onRunEvent, createChecklist };
}

module.exports = { createTaskBoard };
