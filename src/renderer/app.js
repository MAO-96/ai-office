/* 畫面主程式：連接 window.aiOffice（Electron 或預覽模式）、辦公室動畫與各面板 */
(async function () {
  'use strict';
  const api = window.aiOffice;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let state = await api.getState();
  let lastReport = null;
  let editingId = null; // null = 新增

  function toast(msg, err) {
    const t = document.createElement('div');
    t.className = 'toast' + (err ? ' err' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }
  async function guard(fn) {
    try { return await fn(); } catch (e) { toast(e.message || String(e), true); return null; }
  }

  const office = new window.Office($('#office'), state, {
    onSelect: (id) => { if (id) { switchTab('agents'); openAgent(id); } },
    onBoard: (kind, id) => (kind === 'overview' ? openOverview() : openRoomBoard(id)),
  });
  let tasks = state.tasks || { projects: [], tasks: [] };
  let usage = {};
  office.setTasks(tasks);

  function setState(next) {
    state = next;
    office.setState(state);
    if (next.tasks) { tasks = next.tasks; office.setTasks(tasks); }
    renderAll();
  }

  // ---------- 分頁 ----------
  function switchTab(name) {
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab').forEach((t) => { t.hidden = t.id !== 'tab-' + name; });
  }
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  const engineOf = (a) => state.engines[a.engine] || { label: a.engine, color: '#999' };
  const agentName = (id) => { const a = state.agents.find((x) => x.id === id); return a ? a.name : id; };

  // ---------- 任務 ----------
  function renderTask() {
    const sel = $('#wfSelect');
    const cur = sel.value;
    sel.innerHTML = state.workflows.map((w) => `<option value="${esc(w.id)}">${esc(w.name)}（${w.type === 'meeting' ? '會議' : '管線'}）</option>`).join('');
    if (cur && state.workflows.some((w) => w.id === cur)) sel.value = cur;
    renderChain();
  }
  function chip(id) {
    const a = state.agents.find((x) => x.id === id);
    const color = a ? engineOf(a).color : '#777';
    return `<span class="chip"><i style="background:${esc(color)}"></i>${esc(agentName(id))}</span>`;
  }
  function renderChain() {
    const wf = state.workflows.find((w) => w.id === $('#wfSelect').value);
    $('#wfDesc').textContent = wf ? wf.description || '' : '';
    if (!wf) { $('#wfChain').innerHTML = ''; return; }
    if (wf.type === 'meeting') {
      $('#wfChain').innerHTML = `${wf.participants.map(chip).join('')}<span class="arrow">× ${wf.rounds} 輪 →</span>${chip(wf.moderator)}<span class="arrow">總結</span>`;
    } else {
      $('#wfChain').innerHTML = wf.steps.map((s) => `${chip(s.agent)}<span class="arrow">${esc(s.label)}</span>`).join('<span class="arrow">→</span>');
    }
  }
  $('#wfSelect').addEventListener('change', renderChain);

  $('#runBtn').addEventListener('click', async () => {
    const task = $('#taskInput').value.trim();
    if (!task) { toast('請先輸入任務內容', true); return; }
    $('#resultBox').hidden = true;
    setRunning(true);
    const r = await guard(() => api.startRun($('#wfSelect').value, task));
    setRunning(false);
    if (r) {
      lastReport = r.file;
      $('#resultText').textContent = r.final;
      $('#resultBox').hidden = false;
      $('#openReport').hidden = !r.file;
    }
  });
  $('#stopBtn').addEventListener('click', () => api.stopRun());
  $('#openReport').addEventListener('click', () => lastReport && api.openFile(lastReport));

  function setRunning(on) {
    $('#runBtn').disabled = on;
    $('#stopBtn').disabled = !on;
  }

  // ---------- 角色 ----------
  function miniSprite(canvas, look, bg) {
    const c = canvas.getContext('2d');
    c.imageSmoothingEnabled = false;
    c.fillStyle = bg || '#1a1410';
    c.fillRect(0, 0, canvas.width, canvas.height);
    const px = Math.floor(canvas.height / 22);
    window.drawCharacter(c, canvas.width / 2, canvas.height - px * 2, look, { px, facing: 1, t: 0 });
  }

  function renderAgents() {
    $('#agentList').innerHTML = state.agents.map((a) => {
      const e = engineOf(a);
      return `<div class="agent-card${a.id === editingId ? ' sel' : ''}" data-id="${esc(a.id)}">
        <canvas width="44" height="48"></canvas>
        <div><div><b>${esc(a.name)}</b>　${esc(a.title || '')}</div>
        <div class="meta">${esc(roomName(a.room))} · ${a.mode === 'cli' ? 'CLI' : 'API'}${a.model ? ' · ' + esc(a.model) : ''}</div></div>
        <span class="eng" style="background:${esc(e.color)}">${esc(e.label)}</span>
        ${testResults[a.id] ? `<div class="test ${testResults[a.id].cls}">${esc(testResults[a.id].msg)}</div>` : ''}</div>`;
    }).join('');
    $$('.agent-card').forEach((el) => {
      const a = state.agents.find((x) => x.id === el.dataset.id);
      miniSprite(el.querySelector('canvas'), a.look);
      el.addEventListener('click', () => openAgent(a.id));
    });
  }

  // ---------- 連線測試 ----------
  const testResults = {}; // id -> { cls, msg }
  async function testOne(id) {
    testResults[id] = { cls: 'wait', msg: '測試中…（第一次可能要等 10~60 秒）' };
    renderAgents();
    const r = await guard(() => api.testAgent(id));
    if (!r) { testResults[id] = { cls: 'bad', msg: '✗ 測試失敗' }; renderAgents(); return false; }
    testResults[id] = r.ok
      ? { cls: 'ok', msg: `✓ 連線成功（${r.seconds} 秒）：${r.text}` }
      : { cls: 'bad', msg: `✗ ${r.text}` };
    renderAgents();
    return r.ok;
  }
  $('#testAll').addEventListener('click', async () => {
    $('#testAll').disabled = true;
    $('#testAllHint').textContent = '依序測試中…';
    let ok = 0;
    for (const a of state.agents) if (await testOne(a.id)) ok++;
    $('#testAllHint').textContent = `${ok}/${state.agents.length} 個角色可用`;
    $('#testAll').disabled = false;
  });
  $('#testAgent').addEventListener('click', async () => {
    if (!editingId) { toast('請先儲存角色再測試', true); return; }
    $('#testAgent').disabled = true;
    await testOne(editingId);
    $('#testAgent').disabled = false;
  });

  function roomName(id) {
    for (const f of state.rooms.floors) for (const r of f) if (r.id === id) return r.name;
    return id;
  }

  const form = $('#agentForm');
  const F = form.elements;
  function fillSelects() {
    F.engine.innerHTML = Object.entries(state.engines).filter(([, e]) => e && typeof e === 'object')
      .map(([id, e]) => `<option value="${esc(id)}">${esc(e.label)}</option>`).join('');
    F.room.innerHTML = state.rooms.floors.flat().filter((r) => r.id !== 'meeting')
      .map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
  }

  function openAgent(id) {
    fillSelects();
    const a = state.agents.find((x) => x.id === id) || {
      id: '', name: '', title: '', engine: 'claude', mode: 'cli', model: '', room: F.room.options[0] && F.room.options[0].value,
      look: { skin: '#f2c9a0', hair: '#3a2a20', shirt: '#7a5ac9', pants: '#33334a' }, systemPrompt: '',
    };
    editingId = id || null;
    form.hidden = false;
    F.id.value = a.id;
    F.id.readOnly = !!id;
    ['name', 'title', 'engine', 'mode', 'model', 'room', 'systemPrompt'].forEach((k) => { F[k].value = a[k] || ''; });
    ['skin', 'hair', 'shirt', 'pants'].forEach((k) => { F[k].value = (a.look && a.look[k]) || '#888888'; });
    $('#deleteAgent').hidden = !id;
    syncModeOptions();
    updatePreview();
    office.selected = id || null;
    renderAgents();
    form.scrollIntoView({ block: 'nearest' });
  }

  function syncModeOptions() {
    const eng = state.engines[F.engine.value];
    const cliOpt = F.mode.querySelector('option[value="cli"]');
    cliOpt.disabled = !(eng && eng.cli);
    if (cliOpt.disabled) F.mode.value = 'api';
    if (F.mode.value === 'cli') {
      $('#modeHint').textContent = `CLI：執行本機的「${eng.cli.command}」，使用你已登入的帳號，能在工作目錄讀寫檔案。`;
    } else {
      const m = eng && eng.api ? (eng.api.defaultModel || '（未設定，請填模型）') : '';
      $('#modeHint').textContent = eng && eng.api ? `API：呼叫 ${eng.api.provider}，金鑰 ${eng.api.keyEnv}，預設模型 ${m}。` : '';
    }
  }
  function updatePreview() {
    miniSprite($('#agentPreview'), { skin: F.skin.value, hair: F.hair.value, shirt: F.shirt.value, pants: F.pants.value }, '#3d5a73');
  }
  F.engine.addEventListener('change', syncModeOptions);
  F.mode.addEventListener('change', syncModeOptions);
  ['skin', 'hair', 'shirt', 'pants'].forEach((k) => F[k].addEventListener('input', updatePreview));
  $('#addAgent').addEventListener('click', () => openAgent(null));
  $('#cancelAgent').addEventListener('click', () => { form.hidden = true; editingId = null; office.selected = null; renderAgents(); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = {
      id: F.id.value.trim(), name: F.name.value.trim(), title: F.title.value.trim(),
      engine: F.engine.value, mode: F.mode.value, model: F.model.value.trim(), room: F.room.value,
      look: { skin: F.skin.value, hair: F.hair.value, shirt: F.shirt.value, pants: F.pants.value },
      systemPrompt: F.systemPrompt.value,
    };
    const agents = state.agents.slice();
    const idx = agents.findIndex((a) => a.id === (editingId || data.id));
    if (!editingId && idx >= 0) { toast('ID 已存在', true); return; }
    if (idx >= 0) agents[idx] = data; else agents.push(data);
    const next = await guard(() => api.saveAgents(agents));
    if (next) { editingId = data.id; setState(next); toast('角色已儲存'); }
  });

  $('#deleteAgent').addEventListener('click', async () => {
    if (!editingId || !confirm(`確定刪除角色「${agentName(editingId)}」？`)) return;
    const next = await guard(() => api.saveAgents(state.agents.filter((a) => a.id !== editingId)));
    if (next) { form.hidden = true; editingId = null; setState(next); toast('已刪除'); }
  });

  // ---------- 流程 ----------
  function renderFlows() {
    $('#flowCards').innerHTML = state.workflows.map((w) => {
      const people = w.type === 'meeting' ? w.participants.map(agentName).join('、') + `（主持：${agentName(w.moderator)}）`
        : w.steps.map((s) => `${agentName(s.agent)}「${s.label}」`).join(' → ');
      return `<div class="flow-card"><div class="type">${w.type === 'meeting' ? 'MEETING 會議討論' : 'PIPELINE 固定管線'}</div><b>${esc(w.name)}</b><div class="hint">${esc(people)}</div></div>`;
    }).join('');
    $('#flowJson').value = JSON.stringify(state.workflows, null, 2);
  }
  $('#saveFlows').addEventListener('click', async () => {
    let parsed;
    try { parsed = JSON.parse($('#flowJson').value); } catch (e) { toast('JSON 格式錯誤：' + e.message, true); return; }
    const next = await guard(() => api.saveWorkflows(parsed));
    if (next) { setState(next); toast('流程已儲存'); }
  });
  $('#revertFlows').addEventListener('click', renderFlows);

  // ---------- 設定 ----------
  function renderSettings() {
    $('#mockToggle').checked = !!state.settings.mockMode;
    $('#mockToggle').disabled = !!api.isPreview;
    $('#wsPath').value = state.workspace || '';
    $('#timeoutInput').value = state.settings.timeoutMinutes || 10;
    $('#modeBadge').textContent = api.isPreview ? '瀏覽器預覽（模擬）' : state.settings.mockMode ? '模擬模式' : '真實 AI';
    $('#modeBadge').classList.toggle('live', !api.isPreview && !state.settings.mockMode);
    const names = Object.keys(state.keys);
    $('#keyList').innerHTML = names.map((n) => {
      const s = state.keys[n];
      const label = s === 'env' ? '已由環境變數提供' : s === 'saved' ? '已儲存' : '未設定';
      return `<label>${esc(n)} <span class="status ${s === 'none' ? 'none' : 'ok'}">● ${label}</span></label>
        <div class="key-row"><input type="password" data-key="${esc(n)}" placeholder="${s === 'none' ? '貼上金鑰' : '輸入新值以更換，留空儲存即清除'}" />
        <button data-save="${esc(n)}">儲存</button></div>`;
    }).join('');
    $$('#keyList button[data-save]').forEach((b) => b.addEventListener('click', async () => {
      const input = $(`#keyList input[data-key="${b.dataset.save}"]`);
      const next = await guard(() => api.saveKey(b.dataset.save, input.value.trim()));
      if (next) { setState(next); toast(api.isPreview ? '預覽模式不會儲存金鑰' : '金鑰已更新'); }
    }));
  }
  $('#mockToggle').addEventListener('change', async (e) => {
    const next = await guard(() => api.saveSettings({ mockMode: e.target.checked }));
    if (next) setState(next);
  });
  $('#timeoutInput').addEventListener('change', async (e) => {
    const v = Math.max(1, Math.min(120, parseInt(e.target.value, 10) || 10));
    const next = await guard(() => api.saveSettings({ timeoutMinutes: v }));
    if (next) setState(next);
  });
  $('#wsChoose').addEventListener('click', async () => { const n = await guard(() => api.chooseWorkspace()); if (n) setState(n); });
  $('#wsOpen').addEventListener('click', () => api.openWorkspace());
  $('#cliCheck').addEventListener('click', async () => {
    $('#cliResult').innerHTML = '<li>檢查中…</li>';
    const r = await guard(() => api.checkCli());
    if (!r) return;
    $('#cliResult').innerHTML = Object.entries(r).map(([id, v]) => {
      const e = state.engines[id];
      return `<li class="${v.ok ? 'ok' : 'bad'}">${esc(e ? e.label : id)}：${esc(v.detail)}</li>`;
    }).join('');
  });
  $('#resetCfg').addEventListener('click', async () => {
    if (!confirm('會覆蓋目前的角色、引擎、樓層與流程設定，確定？')) return;
    const n = await guard(() => api.resetConfig());
    if (n) { setState(n); toast('已還原預設'); }
  });

  // ---------- 紀錄 ----------
  const logBody = $('#logBody');
  let streamEl = {}; // agentId -> 正在串流的 entry
  function logEntry(kind, agentId, text) {
    const a = state.agents.find((x) => x.id === agentId);
    const color = a ? engineOf(a).color : 'var(--accent)';
    const el = document.createElement('div');
    el.className = 'entry ' + kind;
    el.dataset.agent = agentId || '';
    el.style.borderLeftColor = kind === 'error' ? '' : color;
    const who = a ? `<span class="who" style="color:${esc(color)}">${esc(a.name)}</span>` : '';
    if (kind === 'prompt') el.innerHTML = `<details><summary>${who}收到的提示詞</summary>${esc(text)}</details>`;
    else el.innerHTML = `${who}<span class="txt">${esc(text)}</span>`;
    applyFilter(el);
    const stick = logBody.scrollTop + logBody.clientHeight >= logBody.scrollHeight - 30;
    logBody.appendChild(el);
    if (stick) logBody.scrollTop = logBody.scrollHeight;
    return el;
  }
  function applyFilter(el) {
    const f = $('#logFilter').value;
    el.style.display = !f || el.dataset.agent === f ? '' : 'none';
  }
  function renderLogFilter() {
    const cur = $('#logFilter').value;
    $('#logFilter').innerHTML = '<option value="">全部角色</option>' + state.agents.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
    $('#logFilter').value = cur;
  }
  $('#logFilter').addEventListener('change', () => $$('.entry').forEach(applyFilter));
  $('#logPrompts').addEventListener('change', (e) => logBody.classList.toggle('hide-prompts', !e.target.checked));
  logBody.classList.add('hide-prompts');
  $('#logClear').addEventListener('click', () => { logBody.innerHTML = ''; streamEl = {}; });

  // ---------- 事件 ----------
  api.onEvent((type, d) => {
    office.onEvent(type, d);
    if (type === 'update') showUpdate(d);
    if (type === 'tasks') { tasks = d; office.setTasks(tasks); refreshModal(); }
    if (type === 'usage' && d) { usage[d.engine] = d; office.setUsage(usage); renderUsage(); }
    if (type === 'log') {
      if (d.kind === 'chunk') {
        let el = streamEl[d.agentId];
        if (!el) el = streamEl[d.agentId] = logEntry('output', d.agentId, '');
        el.querySelector('.txt').textContent += d.text;
        logBody.scrollTop = logBody.scrollHeight;
      } else if (d.kind === 'output') {
        const el = streamEl[d.agentId];
        if (el) el.querySelector('.txt').textContent = d.text; else logEntry('output', d.agentId, d.text);
        delete streamEl[d.agentId];
      } else {
        if (d.kind === 'error') delete streamEl[d.agentId];
        logEntry(d.kind, d.agentId, d.text);
      }
    }
    if (type === 'run') {
      const st = $('#runStatus');
      st.className = 'run-status';
      if (d.status === 'started') { st.classList.add('running'); $('#runLabel').textContent = d.label; $('#runBar').style.width = '3%'; setRunning(true); }
      if (d.status === 'step') { st.classList.add('running'); $('#runLabel').textContent = `${d.index}/${d.total}　${d.label}`; $('#runBar').style.width = `${Math.round(((d.index - 0.5) / d.total) * 100)}%`; }
      if (d.status === 'finished') { st.classList.add('done'); $('#runLabel').textContent = '完成'; $('#runBar').style.width = '100%'; }
      if (d.status === 'failed') { st.classList.add('failed'); $('#runLabel').textContent = '失敗：' + (d.error || ''); }
      if (d.status === 'stopped') { $('#runLabel').textContent = '已停止'; $('#runBar').style.width = '0'; }
    }
  });

  // ---------- 更新 ----------
  let pendingUpdate = null;
  function showUpdate(info) {
    pendingUpdate = info && info.available ? info : null;
    $('#updateBtn').hidden = !pendingUpdate;
    $('#applyUpdate').hidden = !pendingUpdate;
    if (pendingUpdate) {
      $('#updateBtn').textContent = `有新版本 v${info.latest} ▸ 更新`;
      $('#updateNotes').textContent = info.notes ? `新版內容：${info.notes}` : '';
    }
  }
  function renderVersion() {
    if (!api.checkUpdate) { $('#versionInfo').textContent = '這個執行方式不支援自動更新，請用桌面的 AI Office 捷徑開啟。'; $('#checkUpdate').disabled = true; return; }
    $('#versionInfo').textContent = `目前版本 v${state.version || '?'}`;
  }
  async function checkUpdate(manual) {
    if (!api.checkUpdate) return;
    try {
      const r = await api.checkUpdate();
      showUpdate(r);
      $('#versionInfo').textContent = `目前版本 v${r.current}，最新版本 v${r.latest}` + (r.available ? '' : '（已是最新）');
      if (manual && !r.available) toast('已經是最新版本');
    } catch (e) {
      if (manual) toast('檢查更新失敗：' + e.message, true);
    }
  }
  async function applyUpdate() {
    if (!pendingUpdate) return;
    if (!confirm(`要更新到 v${pendingUpdate.latest} 嗎？你的角色、流程與金鑰不會受影響。`)) return;
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.textContent = `正在下載 v${pendingUpdate.latest}…`;
    document.body.appendChild(ov);
    try {
      const r = await api.applyUpdate();
      if (!r.updated) { ov.remove(); toast('已經是最新版本'); return; }
      ov.textContent = '更新完成，重新啟動中…';
      // 等新版服務起來後重新載入畫面
      for (let i = 0; i < 60; i++) {
        await new Promise((res) => setTimeout(res, 700));
        try { const st = await api.getState(); if (st.version === r.latest) { location.reload(); return; } } catch (_) { /* 還在重啟 */ }
      }
      ov.textContent = '重新啟動逾時，請關掉視窗再從捷徑開啟。';
    } catch (e) {
      ov.remove();
      toast('更新失敗：' + e.message, true);
    }
  }
  $('#updateBtn').addEventListener('click', applyUpdate);
  $('#applyUpdate').addEventListener('click', applyUpdate);
  $('#checkUpdate').addEventListener('click', () => checkUpdate(true));

  // ================= 白板（各處室）與專案總覽（會議室） =================
  const STATUS = { todo: '待辦', doing: '進行中', blocked: '卡住', done: '完成' };
  const roomsFlat = () => state.rooms.floors.flat();
  const roomLabel = (id) => (roomsFlat().find((r) => r.id === id) || { name: id }).name;
  const projectOf = (id) => tasks.projects.find((p) => p.id === id);
  const taskPct = (t) => (t.status === 'done' ? 100 : t.progress || 0);
  const projPct = (pid) => {
    const ts = tasks.tasks.filter((t) => t.projectId === pid);
    return ts.length ? Math.round(ts.reduce((s, t) => s + taskPct(t), 0) / ts.length) : 0;
  };
  let modalView = null; // { kind: 'room', id } | { kind: 'overview' }
  let editingTask = null;

  function openModal(title, sub) {
    $('#modalTitle').textContent = title;
    $('#modalSub').textContent = sub || '';
    $('#modal').hidden = false;
  }
  function closeModal() { $('#modal').hidden = true; modalView = null; editingTask = null; }
  $('#modalClose').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });
  function refreshModal() {
    if (!modalView || $('#modal').hidden) return;
    // 正在輸入時不要重畫，避免打字被打斷
    const a = document.activeElement;
    if (a && $('#modalBody').contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')) return;
    if (modalView.kind === 'room') renderRoomBoard(modalView.id); else renderOverview();
  }

  function taskCard(t, showRoom) {
    const p = projectOf(t.projectId);
    const a = state.agents.find((x) => x.id === t.agentId);
    const meta = [p ? p.title : '', a ? a.name : '未指派', showRoom ? roomLabel(t.room) : ''].filter(Boolean).join('・');
    const editing = editingTask === t.id;
    return `<div class="kcard" data-task="${esc(t.id)}">
      <div class="t">${esc(t.title)}</div>
      <div class="m">${esc(meta)}</div>
      <div class="pbar ${t.status === 'blocked' ? 'blocked' : ''}"><i style="width:${taskPct(t)}%"></i></div>
      ${t.note ? `<div class="n">${esc(t.note)}</div>` : ''}
      ${editing ? `<div class="kedit" data-edit="${esc(t.id)}">
        <div class="row"><select data-f="status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}"${k === t.status ? ' selected' : ''}>${v}</option>`).join('')}</select>
        <select data-f="agentId"><option value="">未指派</option>${state.agents.map((x) => `<option value="${esc(x.id)}"${x.id === t.agentId ? ' selected' : ''}>${esc(x.name)}（${esc(roomLabel(x.room))}）</option>`).join('')}</select></div>
        <div class="row"><input type="range" min="0" max="100" step="10" value="${taskPct(t)}" data-f="progress" /><span class="hint">${taskPct(t)}%</span></div>
        <input data-f="note" placeholder="備註（例如卡在哪裡）" value="${esc(t.note || '')}" />
        <div class="row"><button class="primary" data-act="save">儲存</button><button class="danger" data-act="del">刪除</button><button class="ghost" data-act="cancel">收起</button></div>
      </div>` : ''}
    </div>`;
  }

  function bindCards(rerender) {
    $$('#modalBody .kcard').forEach((el) => el.addEventListener('click', (e) => {
      if (e.target.closest('.kedit')) return;
      editingTask = editingTask === el.dataset.task ? null : el.dataset.task;
      rerender();
    }));
    $$('#modalBody .kedit').forEach((box) => {
      const id = box.dataset.edit;
      const range = box.querySelector('[data-f="progress"]');
      range.addEventListener('input', () => { range.nextElementSibling.textContent = range.value + '%'; });
      box.querySelector('[data-act="save"]').addEventListener('click', async () => {
        const get = (f) => box.querySelector(`[data-f="${f}"]`).value;
        const status = get('status');
        const progress = Number(get('progress'));
        const patch = { id, status, agentId: get('agentId'), note: get('note') };
        if (status !== 'done') patch.progress = progress;
        const r = await guard(() => api.upsertTask(patch));
        if (r) { tasks = r; office.setTasks(tasks); editingTask = null; rerender(); }
      });
      box.querySelector('[data-act="del"]').addEventListener('click', async () => {
        if (!confirm('確定刪除這個任務？')) return;
        const r = await guard(() => api.deleteTask(id));
        if (r) { tasks = r; office.setTasks(tasks); editingTask = null; rerender(); }
      });
      box.querySelector('[data-act="cancel"]').addEventListener('click', () => { editingTask = null; rerender(); });
    });
  }

  function openRoomBoard(roomId) {
    modalView = { kind: 'room', id: roomId };
    editingTask = null;
    renderRoomBoard(roomId);
  }
  function renderRoomBoard(roomId) {
    const doneProjects = new Set(tasks.projects.filter((p) => p.status === 'done').map((p) => p.id));
    const list = tasks.tasks.filter((t) => t.room === roomId && !doneProjects.has(t.projectId));
    const avg = list.length ? Math.round(list.reduce((s, t) => s + taskPct(t), 0) / list.length) : 0;
    const members = state.agents.filter((a) => a.room === roomId).map((a) => a.name).join('、') || '尚無成員';
    openModal(`${roomLabel(roomId)}　白板`, `成員：${members}・${list.length} 個任務・整體進度 ${avg}%`);
    const col = (st) => {
      const items = list.filter((t) => t.status === st).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      return `<div class="kcol ${st}"><h5><span>${STATUS[st]}</span><span>${items.length}</span></h5>${items.map((t) => taskCard(t)).join('') || ''}</div>`;
    };
    const roomAgents = state.agents.filter((a) => a.room === roomId);
    const others = state.agents.filter((a) => a.room !== roomId);
    const activeProjects = tasks.projects.filter((p) => p.status !== 'done');
    $('#modalBody').innerHTML = `<div class="kanban">${['todo', 'doing', 'blocked', 'done'].map(col).join('')}</div>
      <div class="addtask">
        <div><label>新任務</label><input id="ntTitle" placeholder="例如：整理競品資料" /></div>
        <div><label>負責人</label><select id="ntAgent">${roomAgents.concat(others).map((a) => `<option value="${esc(a.id)}">${esc(a.name)}${a.room !== roomId ? `（${esc(roomLabel(a.room))}）` : ''}</option>`).join('')}<option value="">未指派</option></select></div>
        <div><label>所屬專案</label><select id="ntProject"><option value="">日常事項</option>${activeProjects.filter((p) => p.source !== 'daily').map((p) => `<option value="${esc(p.id)}">${esc(p.title)}</option>`).join('')}<option value="__new">＋ 新專案…</option></select></div>
        <button class="primary" id="ntAdd">新增</button>
      </div>`;
    bindCards(() => renderRoomBoard(roomId));
    const add = async () => {
      const title = $('#ntTitle').value.trim();
      if (!title) { toast('請輸入任務名稱', true); return; }
      let projectId = $('#ntProject').value;
      if (projectId === '__new') {
        const name = prompt('新專案名稱：');
        if (!name) return;
        const r = await guard(() => api.upsertProject({ title: name }));
        if (!r) return;
        projectId = r.projects.find((p) => p.title === name.trim()).id;
      }
      const r = await guard(() => api.upsertTask({ title, agentId: $('#ntAgent').value || null, room: roomId, projectId: projectId || null }));
      if (r) { tasks = r; office.setTasks(tasks); renderRoomBoard(roomId); $('#ntTitle').focus(); }
    };
    $('#ntAdd').addEventListener('click', add);
    $('#ntTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  }

  function openOverview() {
    modalView = { kind: 'overview' };
    editingTask = null;
    renderOverview();
  }
  function renderOverview() {
    const active = tasks.projects.filter((p) => p.status !== 'done');
    const done = tasks.projects.filter((p) => p.status === 'done');
    const allTasks = tasks.tasks.filter((t) => active.some((p) => p.id === t.projectId));
    const overall = allTasks.length ? Math.round(allTasks.reduce((s, t) => s + taskPct(t), 0) / allTasks.length) : 0;
    const blockedN = active.filter((p) => p.status === 'blocked').length;
    openModal('會議室　專案總覽', `進行中 ${active.length} 個・卡住 ${blockedN} 個・整體進度 ${overall}%・已完成 ${done.length} 個`);
    const card = (p) => {
      const ts = tasks.tasks.filter((t) => t.projectId === p.id);
      const pct = projPct(p.id);
      const byRoom = {};
      ts.forEach((t) => { (byRoom[t.room] = byRoom[t.room] || []).push(t); });
      const stuck = ts.filter((t) => t.status === 'blocked');
      const doing = ts.filter((t) => t.status === 'doing');
      const name = (t) => (state.agents.find((a) => a.id === t.agentId) || { name: '未指派' }).name;
      const src = p.source === 'workflow' ? `流程：${p.workflow || ''}` : p.source === 'daily' ? '日常' : '手動';
      return `<div class="pcard ${p.status}">
        <div class="top"><div><b>${esc(p.title)}</b><div class="chipline">${esc(src)}・${STATUS[p.status] || ''}・${ts.filter((t) => t.status === 'done').length}/${ts.length} 完成</div></div><div class="pct">${pct}%</div></div>
        <div class="pbar ${p.status === 'blocked' ? 'blocked' : ''}"><i style="width:${pct}%"></i></div>
        <div class="rooms">${Object.entries(byRoom).map(([rid, list]) => `<span data-room="${esc(rid)}">${esc(roomLabel(rid))} ${list.filter((t) => t.status === 'done').length}/${list.length}</span>`).join('')}</div>
        ${stuck.length ? `<div class="stuck">卡在：${stuck.map((t) => `${roomLabel(t.room)}・${name(t)}「${t.title}」${t.note ? '：' + t.note.slice(0, 80) : ''}`).map(esc).join('\n')}</div>`
          : doing.length ? `<div class="chipline" style="margin-top:8px">正在進行：${doing.map((t) => `${name(t)}「${t.title}」`).map(esc).join('、')}</div>` : ''}
        ${p.source !== 'workflow' || p.status !== 'doing' ? `<div class="row" style="margin-top:8px"><button class="ghost" data-delp="${esc(p.id)}">刪除專案</button></div>` : ''}
      </div>`;
    };
    $('#modalBody').innerHTML = `
      <div class="row" style="margin:0 0 12px"><button id="npAdd">＋ 新增專案</button><button class="ghost" id="npClear"${done.length ? '' : ' disabled'}>清除已完成（${done.length}）</button>
      <span class="hint">點處室標籤可打開該處室白板</span></div>
      ${active.length ? `<div class="pcards">${active.map(card).join('')}</div>` : '<p class="hint">目前沒有進行中的專案。下任務給流程會自動建立，也可以手動新增。</p>'}
      ${done.length ? `<h4 style="color:var(--muted)">已完成</h4><div class="pcards">${done.slice(0, 12).map(card).join('')}</div>` : ''}`;
    $$('#modalBody [data-room]').forEach((el) => el.addEventListener('click', () => openRoomBoard(el.dataset.room)));
    $$('#modalBody [data-delp]').forEach((el) => el.addEventListener('click', async () => {
      if (!confirm('刪除這個專案和它的所有任務？')) return;
      const r = await guard(() => api.deleteProject(el.dataset.delp));
      if (r) { tasks = r; office.setTasks(tasks); renderOverview(); }
    }));
    $('#npAdd').addEventListener('click', async () => {
      const name = prompt('新專案名稱：');
      if (!name) return;
      const r = await guard(() => api.upsertProject({ title: name }));
      if (r) { tasks = r; office.setTasks(tasks); renderOverview(); }
    });
    $('#npClear').addEventListener('click', async () => {
      const r = await guard(() => api.clearDoneProjects());
      if (r) { tasks = r; office.setTasks(tasks); renderOverview(); }
    });
  }

  // ================= 用量 =================
  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const mins = Math.round((d - Date.now()) / 60000);
    const when = d.toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    if (mins <= 0) return when;
    return mins < 60 ? `${mins} 分鐘後（${when}）` : mins < 1440 ? `${Math.round(mins / 60)} 小時後（${when}）` : when;
  }
  function renderUsage() {
    const ids = Object.keys(usage);
    if (!ids.length) { $('#usageList').innerHTML = '<p class="hint">讀取中…</p>'; return; }
    $('#usageList').innerHTML = ids.map((id) => {
      const u = usage[id];
      const src = u.source === 'unofficial' ? '非官方介面' : u.source === 'agyhud' ? 'agy-hud 紀錄' : u.mode === 'api' ? 'API 估算' : '本機紀錄';
      const wins = (u.windows || []).map((w) => {
        const left = Math.max(0, Math.round(100 - (w.usedPct || 0)));
        const cls = left > 50 ? '' : left > 20 ? 'mid' : 'low';
        return `<div class="uwin"><div class="row" style="margin:0;justify-content:space-between"><span>${esc(w.name)}：剩 <b>${left}%</b></span><span class="hint" style="margin:0">${w.resetsAt ? '重置 ' + esc(fmtTime(w.resetsAt)) : ''}</span></div>
          <div class="pbar"><i class="${cls}" style="width:${left}%"></i></div></div>`;
      }).join('');
      const money = u.mode === 'api' ? `・本月約 US$${(u.month.cost || 0).toFixed(3)}（${(u.month.inTok + u.month.outTok).toLocaleString()} token）` : '';
      return `<div class="ucard">
        <div class="top"><b style="color:${esc(u.color)}">${esc(u.label)}</b><span class="src">${esc(src)}</span></div>
        <div class="stat">${esc(u.agents.join('、'))}・${u.mode === 'cli' ? 'CLI' : 'API'}</div>
        ${wins}
        <div class="stat">今天 AI Office 呼叫 ${u.today.calls} 次${u.today.fail ? `（失敗 ${u.today.fail}）` : ''}${money}</div>
        ${u.last429 ? `<div class="err">最近一次額度用完：${esc(new Date(u.last429).toLocaleString('zh-TW', { hour12: false }))}</div>` : ''}
        ${u.error ? `<div class="err">${esc(u.error)}</div>` : ''}
        ${u.note ? `<div class="hint">${esc(u.note)}</div>` : ''}
      </div>`;
    }).join('');
  }
  async function loadUsage(force) {
    if (!api.getUsage) { $('#usageList').innerHTML = '<p class="hint">這個執行方式不支援用量查詢。</p>'; return; }
    try {
      usage = await api.getUsage(force);
      office.setUsage(usage);
      renderUsage();
      $('#usageTime').textContent = '更新於 ' + new Date().toLocaleTimeString('zh-TW', { hour12: false });
    } catch (e) { $('#usageList').innerHTML = `<p class="hint">讀取失敗：${esc(e.message)}</p>`; }
  }
  $('#usageRefresh').addEventListener('click', () => loadUsage(true));
  setInterval(() => loadUsage(false), 60000);

  function renderAll() {
    renderTask();
    renderAgents();
    renderFlows();
    renderSettings();
    renderLogFilter();
    renderVersion();
  }
  renderAll();
  setRunning(!!state.running);
  if (api.isPreview) logEntry('system', null, '瀏覽器預覽模式：使用模擬 AI。要串接真的 AI，請用 npm start 以 Electron 執行。');
  checkUpdate(false);
  loadUsage(false);
})();
