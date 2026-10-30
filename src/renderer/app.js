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
    onBoard: (kind, id) => {
      if (kind === 'overview') return openCommand(runs.some((r) => LIVE.includes(r.status)) ? 'live' : 'new');
      if (kind === 'desk') { switchTab('agents'); openAgent(null); toast('替新同事設定名字、AI 與個性吧！'); return null; }
      return openRoomBoard(id);
    },
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
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => {
    switchTab(b.dataset.tab);
    if (b.dataset.tab === 'usage' && typeof loadUsage === 'function') loadUsage(true);
  }));

  const engineOf = (a) => state.engines[a.engine] || { label: a.engine, color: '#999' };
  const agentName = (id) => { const a = state.agents.find((x) => x.id === id); return a ? a.name : id; };

  // ---------- 任務：啟動器（右側面板與會議室白板共用） ----------
  let runs = state.runs || [];
  let routines = state.routines || [];
  const LIVE = ['queued', 'running', 'asking'];
  const STATUS_TXT = { queued: '排隊中', running: '進行中', asking: '等你回答', finished: '完成', failed: '失敗', stopped: '已停止' };
  const launchMode = {};
  function prefs(k, v) {
    try { if (v === undefined) return localStorage.getItem('aiOffice.' + k); localStorage.setItem('aiOffice.' + k, v); } catch (_) { /* 無儲存空間 */ }
    return null;
  }
  function launcherHTML(px) {
    return `
      <div class="seg">
        <button type="button" data-mode="single">交辦單人</button>
        <button type="button" data-mode="workflow">協作流程</button>
      </div>
      <div data-show="single"><label>交給誰</label><select id="${px}Agent"></select></div>
      <div data-show="workflow"><label>協作流程</label><select id="${px}Wf"></select>
        <p class="hint" id="${px}WfDesc"></p><div class="chain" id="${px}WfChain"></div></div>
      <label>任務內容</label>
      <textarea id="${px}Task" rows="5" placeholder="例如：幫我規劃一個個人記帳 App 的 MVP，並寫出核心資料結構"></textarea>
      <label class="chk" style="margin-top:8px"><input type="checkbox" id="${px}Clarify" /> 開始前先追問、確認需求</label>
      <div class="row"><button class="primary" id="${px}Run">開始（另開一個任務）</button></div>`;
  }
  function renderLauncher(px) {
    const box = document.querySelector(`.launcher[data-prefix="${px}"]`);
    if (!box) return;
    if (!box.dataset.ready) { box.innerHTML = launcherHTML(px); box.dataset.ready = '1'; bindLauncher(px, box); }
    const mode = launchMode[px] || prefs('launchMode') || 'workflow';
    launchMode[px] = mode;
    box.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    box.querySelectorAll('[data-show]').forEach((el) => { el.hidden = el.dataset.show !== mode; });
    const ag = $(`#${px}Agent`), cur = ag.value;
    ag.innerHTML = state.agents.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}（${esc(a.title || '')}・${esc(engineOf(a).label)}${a.mode === 'cli' && a.permission === 'full' ? '・⚠完整權限' : ''}）</option>`).join('');
    if (cur && state.agents.some((a) => a.id === cur)) ag.value = cur;
    const wf = $(`#${px}Wf`), cw = wf.value;
    wf.innerHTML = state.workflows.map((w) => `<option value="${esc(w.id)}">${esc(w.name)}（${w.type === 'meeting' ? '會議' : '管線'}）</option>`).join('');
    if (cw && state.workflows.some((w) => w.id === cw)) wf.value = cw;
    renderChain(px);
    const c = prefs('clarify');
    $(`#${px}Clarify`).checked = c == null ? true : c === '1';
  }
  function bindLauncher(px, box) {
    box.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
      launchMode[px] = b.dataset.mode;
      prefs('launchMode', b.dataset.mode);
      renderLauncher(px);
    }));
    $(`#${px}Wf`).addEventListener('change', () => renderChain(px));
    $(`#${px}Clarify`).addEventListener('change', (e) => prefs('clarify', e.target.checked ? '1' : '0'));
    $(`#${px}Run`).addEventListener('click', async () => {
      const task = $(`#${px}Task`).value.trim();
      if (!task) { toast('請先輸入任務內容', true); return; }
      const r = await guard(() => api.startRun({
        kind: launchMode[px], agentId: $(`#${px}Agent`).value, workflowId: $(`#${px}Wf`).value, task, clarify: $(`#${px}Clarify`).checked,
      }));
      if (r) {
        $(`#${px}Task`).value = '';
        toast('任務已開始，可以繼續交辦下一件');
        if (px === 'w') openCommand('live');
      }
    });
  }
  function chip(id) {
    const a = state.agents.find((x) => x.id === id);
    const color = a ? engineOf(a).color : '#777';
    return `<span class="chip"><i style="background:${esc(color)}"></i>${esc(agentName(id))}</span>`;
  }
  function renderChain(px) {
    const wf = state.workflows.find((w) => w.id === $(`#${px}Wf`).value);
    $(`#${px}WfDesc`).textContent = wf ? wf.description || '' : '';
    if (!wf) { $(`#${px}WfChain`).innerHTML = ''; return; }
    if (wf.type === 'meeting') {
      $(`#${px}WfChain`).innerHTML = `${wf.participants.map(chip).join('')}<span class="arrow">× ${wf.rounds} 輪 →</span>${chip(wf.moderator)}<span class="arrow">總結</span>`;
    } else {
      $(`#${px}WfChain`).innerHTML = wf.steps.map((st) => (st.type === 'review'
        ? `${chip(st.agent)}<span class="arrow">質疑・與 ${esc((st.with || []).map(agentName).join('、'))} 討論到共識</span>`
        : `${chip(st.agent)}<span class="arrow">${esc(st.label)}</span>`)).join('<span class="arrow">→</span>');
    }
  }

  // ---------- 任務清單（每個任務像一段對話） ----------
  function timeAgo(iso) {
    if (!iso) return '';
    const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (m < 1) return '剛剛';
    if (m < 60) return `${m} 分鐘前`;
    if (m < 1440) return `${Math.round(m / 60)} 小時前`;
    return new Date(iso).toLocaleDateString('zh-TW');
  }
  function runCard(r) {
    const live = LIVE.includes(r.status);
    const who = r.currentAgent ? agentName(r.currentAgent) : (r.agentId ? agentName(r.agentId) : '');
    const daily = r.meta && r.meta.routineId ? '<span class="rc-tag">日常</span>' : '';
    return `<div class="runcard ${r.status}" data-run="${esc(r.runId)}">
      <div class="rc-top"><b>${esc(r.title)}</b><span class="rc-st ${r.status}">${STATUS_TXT[r.status] || esc(r.status)}</span></div>
      <div class="rc-meta">${daily}${esc(r.workflowName || '交辦')}${who ? '・' + esc(who) : ''}・${esc(timeAgo(r.startedAt))}</div>
      ${live ? `<div class="rc-step">${esc(r.stepLabel || '')}</div><div class="pbar"><i style="width:${r.progress || 3}%"></i></div>`
        : r.status === 'finished' ? `<div class="rc-final">${esc(String(r.final || '').slice(0, 110))}</div>`
          : r.error ? `<div class="rc-err">${esc(r.error)}</div>` : ''}
      ${r.consensus === true ? '<span class="rc-tag ok">審查已達共識</span>' : r.consensus === false ? '<span class="rc-tag warn">審查有分歧，已裁決</span>' : ''}
    </div>`;
  }
  function bindRunCards(sel) { $$(`${sel} .runcard`).forEach((el) => el.addEventListener('click', () => openRun(el.dataset.run))); }
  function renderRuns() {
    $('#runList').innerHTML = runs.length ? runs.slice(0, 30).map(runCard).join('') : '<p class="hint">還沒有任務。上面輸入內容開始第一個吧！可以連續開好幾個，大家會同時做。</p>';
    bindRunCards('#runList');
    office.setRuns(runs);
    renderTopStatus();
    if (modalView && modalView.kind === 'command' && modalView.tab === 'live') renderCommandBody();
    if (modalView && modalView.kind === 'run') syncRunModal();
  }
  function renderTopStatus() {
    const live = runs.filter((r) => LIVE.includes(r.status));
    const asking = live.filter((r) => r.status === 'asking').length;
    const st = $('#runStatus');
    st.className = 'run-status' + (live.length ? ' running' : '');
    $('#runLabel').textContent = live.length ? `進行中 ${live.length} 個任務${asking ? `・${asking} 個等你回答` : ''}` : '待命中';
    $('#runBar').style.width = live.length ? `${Math.round(live.reduce((n, r) => n + (r.progress || 3), 0) / live.length)}%` : '0';
  }
  $('#clearRuns').addEventListener('click', async () => { const r = await guard(() => api.clearRuns()); if (r) { runs = r; renderRuns(); } });

  // 任務對話視窗
  let runView = null;
  async function openRun(runId) {
    const d = await guard(() => api.getRun(runId));
    if (!d) return;
    modalView = { kind: 'run', runId };
    runView = d;
    renderRunModal();
  }
  function entryHTML(e) {
    const a = e.agentId && state.agents.find((x) => x.id === e.agentId);
    const color = a ? engineOf(a).color : 'var(--accent)';
    const who = a ? `<span class="who" style="color:${esc(color)}">${esc(a.name)}</span>` : '';
    if (e.kind === 'prompt') return `<div class="entry prompt" style="border-left-color:${esc(color)}"><details><summary>${who}收到的指示</summary>${esc(e.text)}</details></div>`;
    const k = e.kind === 'stream' ? 'output stream' : e.kind;
    return `<div class="entry ${k}" data-agent="${esc(e.agentId || '')}" style="${e.kind === 'error' ? '' : `border-left-color:${esc(color)}`}">${who}<span class="txt">${esc(e.text)}</span></div>`;
  }
  function renderRunModal() {
    const d = runView;
    const live = LIVE.includes(d.status);
    openModal(d.title, `${d.workflowName || '交辦'}・${STATUS_TXT[d.status] || d.status}${live && d.stepLabel ? '・' + d.stepLabel : ''}`);
    const keepNote = $('#rmNote') ? $('#rmNote').value : '';
    $('#modalBody').innerHTML = `
      <div class="convo" id="convo">${(d.log || []).map(entryHTML).join('') || '<p class="hint">還沒有內容</p>'}</div>
      ${d.status === 'finished' ? `<div class="result"><div class="result-head"><strong>最終結果</strong>${d.file ? '<button class="ghost" id="rmReport">開啟報告檔</button>' : ''}</div><pre>${esc(d.final)}</pre></div>` : ''}
      ${d.error && d.status !== 'finished' ? `<p class="rc-err">${esc(d.error)}</p>` : ''}
      ${d.asking && d.ask ? `<button class="askbanner" id="rmAsk">${esc(d.ask.agentName)} 有 ${d.ask.questions.length} 個問題等你回答 ▸</button>` : ''}
      ${live ? `<div class="notebox"><label>追加指示（下一位成員開始工作時生效）</label>
          <div class="row"><input id="rmNote" placeholder="例如：報告改成條列、預算控制在一萬內" /><button id="rmNoteSend">送出</button></div>
          <ul class="notes">${(d.notes || []).map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>
          <div class="row"><button class="danger" id="rmStop">停止這個任務</button></div>`
        : `<div class="row"><button id="rmAgain">用同樣內容再開一次</button><button class="ghost" id="rmRemove">刪除這筆紀錄</button></div>`}`;
    if ($('#rmNote')) $('#rmNote').value = keepNote;
    const c = $('#convo');
    c.scrollTop = c.scrollHeight;
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    on('rmReport', () => api.openFile(d.file));
    on('rmAsk', () => openAsk(pendingAsks.find((x) => x.runId === d.runId) || { source: 'run', runId: d.runId, ...d.ask }));
    const sendRunNote = async () => {
      const text = $('#rmNote').value.trim();
      if (!text) return;
      const r = await guard(() => api.addNote(d.runId, text));
      if (r) { $('#rmNote').value = ''; d.notes = r.notes; renderRunModal(); toast('已追加，下一位成員開始時生效'); }
    };
    on('rmNoteSend', sendRunNote);
    if ($('#rmNote')) $('#rmNote').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendRunNote(); });
    on('rmStop', async () => { if (confirm('確定停止這個任務？')) await guard(() => api.stopRun(d.runId)); });
    on('rmRemove', async () => { const r = await guard(() => api.removeRun(d.runId)); if (r) { runs = r; renderRuns(); closeModal(); } });
    on('rmAgain', async () => {
      const r = await guard(() => api.startRun(d.type === 'single'
        ? { kind: 'single', agentId: d.agentId, task: d.task, title: d.title }
        : { kind: 'workflow', workflowId: d.workflowId, task: d.task, title: d.title }));
      if (r) { toast('已再開一次'); openRun(r.runId); }
    });
  }
  // 任務狀態有變化時（開始、追問、完成）重新抓一次完整紀錄
  async function syncRunModal() {
    if (!modalView || modalView.kind !== 'run' || !runView) return;
    const s = runs.find((r) => r.runId === runView.runId);
    if (!s || (s.status === runView.status && !!s.asking === !!runView.asking && s.stepLabel === runView.stepLabel)) return;
    const d = await api.getRun(runView.runId).catch(() => null);
    if (d && modalView && modalView.kind === 'run' && modalView.runId === d.runId) { runView = d; renderRunModal(); }
  }
  function appendRunLog(d) {
    if (!modalView || modalView.kind !== 'run' || !runView || d.runId !== runView.runId) return;
    const c = $('#convo');
    if (!c) return;
    const stick = c.scrollTop + c.clientHeight >= c.scrollHeight - 40;
    if (d.kind === 'chunk') {
      let el = c.lastElementChild;
      if (!el || !el.classList.contains('stream') || el.dataset.agent !== (d.agentId || '')) {
        c.insertAdjacentHTML('beforeend', entryHTML({ kind: 'stream', agentId: d.agentId, text: '' }));
        el = c.lastElementChild;
      }
      el.querySelector('.txt').textContent += d.text;
    } else {
      const last = c.lastElementChild;
      if (d.kind === 'output' && last && last.classList.contains('stream') && last.dataset.agent === (d.agentId || '')) last.remove();
      c.insertAdjacentHTML('beforeend', entryHTML({ kind: d.kind, agentId: d.agentId, text: d.text }));
    }
    if (stick) c.scrollTop = c.scrollHeight;
  }

  async function sendNote(inputSel) {
    const text = $(inputSel).value.trim();
    if (!text) return;
    const r = await guard(() => api.addNote('devops', text));
    if (!r) return;
    $(inputSel).value = '';
    if (r.devops) { dev = r.devops; renderDev(); toast(r.devops.phase === 'implementing' ? '已交給工程接著修改' : '已追加'); }
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

  const PERM_LABEL = { read: '唯讀', workspace: '可改檔案', full: '完整權限' };
  const permOf = (a) => (a.mode === 'cli' && PERM_LABEL[a.permission] ? a.permission : 'read');
  function permBadge(a) {
    if (a.mode !== 'cli') return '';
    const p = permOf(a);
    return p === 'read' ? '' : ` <span class="perm-badge ${p}">${PERM_LABEL[p]}</span>`;
  }
  function renderAgents() {
    $('#agentList').innerHTML = state.agents.map((a) => {
      const e = engineOf(a);
      return `<div class="agent-card${a.id === editingId ? ' sel' : ''}" data-id="${esc(a.id)}">
        <canvas width="44" height="48"></canvas>
        <div><div><b>${esc(a.name)}</b>　${esc(a.title || '')}</div>
        <div class="meta">${esc(roomName(a.room))} · ${a.mode === 'cli' ? 'CLI' : 'API'}${a.model ? ' · ' + esc(a.model) : ''}${permBadge(a)}</div></div>
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

  const depts = () => state.rooms.departments || state.rooms.floors.flat().filter((r) => !['meeting', 'lounge', 'office'].includes(r.id));
  function roomName(id) { return (depts().find((d) => d.id === id) || { name: id || '未分組' }).name; }
  const form = $('#agentForm');
  const F = form.elements;
  function fillSelects() {
    F.engine.innerHTML = Object.entries(state.engines).filter(([, e]) => e && typeof e === 'object')
      .map(([id, e]) => `<option value="${esc(id)}">${esc(e.label)}</option>`).join('');
    F.room.innerHTML = depts()
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
    F.permission.value = PERM_LABEL[a.permission] ? a.permission : 'read';
    $('#deleteAgent').hidden = !id;
    syncModeOptions();
    updatePreview();
    office.selected = id || null;
    renderAgents();
    form.scrollIntoView({ block: 'nearest' });
  }

  const PERM_HINT = {
    read: '最安全。適合研究、企劃、審查這類只需要讀和寫報告的員工（報告由 AI Office 自己存檔）。',
    workspace: '只能動工作目錄裡的檔案，適合寫程式、產出文件的員工。「改版」流程至少會用這一級。',
    full: '⚠ 等同把你的電腦交給這位員工：沒有沙箱、不會再問你，可以刪檔、裝軟體、上網。任務內容如果包含網頁或外部文件，裡面藏的惡意指令也可能被照做。完整權限的員工不能被排進日常任務。',
  };
  function syncPerm() {
    const isCli = F.mode.value === 'cli';
    $('#permBox').hidden = !isCli;
    const p = F.permission.value;
    $('#permBox').classList.toggle('full', p === 'full');
    $('#permHint').textContent = PERM_HINT[p];
    $('#permHint').classList.toggle('warn', p === 'full');
  }
  F.permission.addEventListener('change', syncPerm);
  function syncModeOptions() {
    const eng = state.engines[F.engine.value];
    const cliOpt = F.mode.querySelector('option[value="cli"]');
    cliOpt.disabled = !(eng && eng.cli);
    if (cliOpt.disabled) F.mode.value = 'api';
    syncPerm();
    if (F.mode.value === 'cli') {
      $('#modeHint').textContent = `CLI：執行本機的「${eng.cli.command}」，使用你已登入的帳號。能動到的範圍看下面的「權限」。`;
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
      permission: F.mode.value === 'cli' ? F.permission.value : 'read',
    };
    const prev = state.agents.find((a) => a.id === editingId);
    if (data.permission === 'full' && (!prev || prev.permission !== 'full')
      && !confirm(`確定要給「${data.name}」完整權限？\n\n他將可以在你的電腦上執行任何指令、修改或刪除任何檔案、自由連網，而且不會再詢問你。\n建議只給需要的員工，並避免讓他處理來路不明的網頁或文件。`)) return;
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
    $('#parallelInput').value = state.settings.maxParallel || 3;
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
  $('#parallelInput').addEventListener('change', async (e) => {
    const v = Math.max(1, Math.min(8, parseInt(e.target.value, 10) || 3));
    const next = await guard(() => api.saveSettings({ maxParallel: v }));
    if (next) { setState(next); toast(`最多同時 ${v} 個任務`); }
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
  let streamEl = {}; // runId|agentId -> 正在串流的 entry
  const runTitle = (runId) => { const r = runs.find((x) => x.runId === runId); return r ? r.title : ''; };
  function logEntry(kind, agentId, text, runId) {
    const a = state.agents.find((x) => x.id === agentId);
    const color = a ? engineOf(a).color : 'var(--accent)';
    const el = document.createElement('div');
    el.className = 'entry ' + kind;
    el.dataset.agent = agentId || '';
    el.style.borderLeftColor = kind === 'error' ? '' : color;
    const who = a ? `<span class="who" style="color:${esc(color)}">${esc(a.name)}</span>` : '';
    const tag = runId && runTitle(runId) ? `<span class="rtag" data-run="${esc(runId)}">${esc(runTitle(runId).slice(0, 14))}</span>` : '';
    if (kind === 'prompt') el.innerHTML = `<details><summary>${tag}${who}收到的指示</summary>${esc(text)}</details>`;
    else el.innerHTML = `${tag}${who}<span class="txt">${esc(text)}</span>`;
    const t = el.querySelector('.rtag');
    if (t) t.addEventListener('click', () => openRun(runId));
    applyFilter(el);
    const stick = logBody.scrollTop + logBody.clientHeight >= logBody.scrollHeight - 30;
    logBody.appendChild(el);
    while (logBody.children.length > 600) logBody.firstElementChild.remove();
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
    if (type === 'devops') { dev = d; renderDev(); }
    if (type === 'ask') {
      const ask = { ...d, runId: d.runId || 'devops' };
      pendingAsks = pendingAsks.filter((x) => x.runId !== ask.runId).concat([ask]);
      renderAskBanners();
      if ($('#modal').hidden) openAsk(ask); else toast(`${ask.agentName} 有問題等你回答（${ask.title || '任務'}）`);
    }
    if (type === 'ask-done') {
      const id = d.runId || 'devops';
      pendingAsks = pendingAsks.filter((x) => x.runId !== id);
      renderAskBanners();
      if (modalView && modalView.kind === 'ask' && modalView.runId === id) closeModal();
    }
    if (type === 'runs') { runs = d; renderRuns(); }
    if (type === 'routines') { routines = d; if (modalView && modalView.kind === 'command' && modalView.tab === 'routines') refreshModal(); }
    if (type === 'tasks') { tasks = d; office.setTasks(tasks); refreshModal(); }
    if (type === 'usage' && d) { usage[d.engine] = d; office.setUsage(usage); renderUsage(); }
    if (type === 'log') {
      appendRunLog(d);
      const key = `${d.runId || ''}|${d.agentId || ''}`;
      if (d.kind === 'chunk') {
        let el = streamEl[key];
        if (!el) el = streamEl[key] = logEntry('output', d.agentId, '', d.runId);
        el.querySelector('.txt').textContent += d.text;
        logBody.scrollTop = logBody.scrollHeight;
      } else if (d.kind === 'output') {
        const el = streamEl[key];
        if (el) el.querySelector('.txt').textContent = d.text; else logEntry('output', d.agentId, d.text, d.runId);
        delete streamEl[key];
      } else {
        if (d.kind === 'error') delete streamEl[key];
        logEntry(d.kind, d.agentId, d.text, d.runId);
      }
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
  const roomLabel = (id) => roomName(id);
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
    if (modalView.kind === 'ask' || modalView.kind === 'run') return;
    if (modalView.kind === 'room') renderRoomBoard(modalView.id);
    else if (modalView.kind === 'command') { if (!(modalView.tab === 'routines' && editingRoutine) && modalView.tab !== 'new') renderCommandBody(); }
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

  function renderOverview() {
    const active = tasks.projects.filter((p) => p.status !== 'done');
    const done = tasks.projects.filter((p) => p.status === 'done');
    const allTasks = tasks.tasks.filter((t) => active.some((p) => p.id === t.projectId));
    const overall = allTasks.length ? Math.round(allTasks.reduce((s, t) => s + taskPct(t), 0) / allTasks.length) : 0;
    const blockedN = active.filter((p) => p.status === 'blocked').length;
    if (!$('#cmdBody')) { openCommand('projects'); return; }
    $('#modalSub').textContent = `進行中 ${active.length} 個・卡住 ${blockedN} 個・整體進度 ${overall}%・已完成 ${done.length} 個`;
    const card = (p) => {
      const ts = tasks.tasks.filter((t) => t.projectId === p.id);
      const pct = projPct(p.id);
      const byRoom = {};
      ts.forEach((t) => { (byRoom[t.room] = byRoom[t.room] || []).push(t); });
      const stuck = ts.filter((t) => t.status === 'blocked');
      const doing = ts.filter((t) => t.status === 'doing');
      const name = (t) => (state.agents.find((a) => a.id === t.agentId) || { name: '未指派' }).name;
      const src = p.source === 'workflow' ? `流程：${p.workflow || ''}` : p.source === 'quick' ? '交辦' : p.source === 'routine' ? '例行清單' : p.source === 'daily' ? '日常事項' : '手動';
      return `<div class="pcard ${p.status}">
        <div class="top"><div><b>${esc(p.title)}</b><div class="chipline">${esc(src)}・${STATUS[p.status] || ''}・${ts.filter((t) => t.status === 'done').length}/${ts.length} 完成</div></div><div class="pct">${pct}%</div></div>
        <div class="pbar ${p.status === 'blocked' ? 'blocked' : ''}"><i style="width:${pct}%"></i></div>
        <div class="rooms">${Object.entries(byRoom).map(([rid, list]) => `<span data-room="${esc(rid)}">${esc(roomLabel(rid))} ${list.filter((t) => t.status === 'done').length}/${list.length}</span>`).join('')}</div>
        ${stuck.length ? `<div class="stuck">卡在：${stuck.map((t) => `${roomLabel(t.room)}・${name(t)}「${t.title}」${t.note ? '：' + t.note.slice(0, 80) : ''}`).map(esc).join('\n')}</div>`
          : doing.length ? `<div class="chipline" style="margin-top:8px">正在進行：${doing.map((t) => `${name(t)}「${t.title}」`).map(esc).join('、')}</div>` : ''}
        ${p.source !== 'workflow' || p.status !== 'doing' ? `<div class="row" style="margin-top:8px"><button class="ghost" data-delp="${esc(p.id)}">刪除專案</button></div>` : ''}
      </div>`;
    };
    $('#cmdBody').innerHTML = `
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
      const src = u.source === 'unofficial' ? '即時・非官方介面' : u.source === 'live' ? '即時查詢' : u.source === 'agyhud' ? 'agy-hud 紀錄' : u.mode === 'api' ? 'API 估算' : '本機紀錄';
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
  let usageLoading = false;
  async function loadUsage(force) {
    if (!api.getUsage) { $('#usageList').innerHTML = '<p class="hint">這個執行方式不支援用量查詢。</p>'; return; }
    if (usageLoading) return;
    usageLoading = true;
    $('#usageRefresh').disabled = true;
    if (force) $('#usageTime').textContent = '正在向各家即時查詢…';
    try {
      usage = await api.getUsage(force);
      office.setUsage(usage);
      renderUsage();
      $('#usageTime').textContent = '更新於 ' + new Date().toLocaleTimeString('zh-TW', { hour12: false });
    } catch (e) { $('#usageList').innerHTML = `<p class="hint">讀取失敗：${esc(e.message)}</p>`; }
    usageLoading = false;
    $('#usageRefresh').disabled = false;
  }
  $('#usageRefresh').addEventListener('click', () => loadUsage(true));
  setInterval(() => loadUsage(false), 60000);

  // ================= 改版 =================
  let dev = state.devops || { phase: 'idle', steps: [] };
  const DEV_BUSY = ['preparing', 'clarifying', 'planning', 'implementing', 'testing', 'fixing', 'reviewing', 'publishing'];
  function fillDevSelects() {
    const opts = (pref) => state.agents.map((a) => `<option value="${esc(a.id)}"${a.id === pref ? ' selected' : ''}>${esc(a.name)}（${esc(engineOf(a).label)}・${a.mode === 'cli' ? 'CLI' : 'API'}）</option>`).join('');
    const pick = (sel, fallback) => { const cur = $(sel).value; return cur && state.agents.some((a) => a.id === cur) ? cur : fallback; };
    const firstCli = (state.agents.find((a) => a.mode === 'cli' && a.engine === 'claude') || state.agents.find((a) => a.mode === 'cli') || {}).id;
    $('#devPlanner').innerHTML = opts(pick('#devPlanner', state.agents.some((a) => a.id === 'pm') ? 'pm' : firstCli));
    $('#devImpl').innerHTML = opts(pick('#devImpl', firstCli));
    $('#devReviewer').innerHTML = opts(pick('#devReviewer', state.agents.some((a) => a.id === 'critic') ? 'critic' : firstCli));
  }
  function renderDev() {
    if (!api.devStatus) { $('#tab-devops').innerHTML = '<p class="hint">這個執行方式不支援改版，請用桌面的 AI Office 捷徑開啟。</p>'; return; }
    const busy = DEV_BUSY.includes(dev.phase);
    $('#devStart').disabled = busy || dev.phase === 'awaiting';
    const canNote = (busy && dev.phase !== 'publishing') || dev.phase === 'awaiting';
    $('#devNoteBox').hidden = !canNote;
    $('#devNoteLabel').textContent = dev.phase === 'awaiting' ? '追加修改（工程會在目前的修改上接著改，再跑一次測試與審查）' : '追加指示（下一位成員開始工作時生效）';
    $('#devNoteSend').textContent = dev.phase === 'awaiting' ? '交給工程修改' : '送出';
    $('#devNoteList').innerHTML = (dev.notes || []).map((n) => `<li>${esc(n)}</li>`).join('');
    $('#devCancel').hidden = !busy;
    $('#devRequest').disabled = busy;
    if (dev.request && (busy || dev.phase === 'awaiting') && !$('#devRequest').value) $('#devRequest').value = dev.request;
    const icon = { ok: '✓', failed: '✗', running: '…', waiting: '?', todo: '·' };
    $('#devSteps').innerHTML = (dev.steps || []).map((s) => `<div class="dstep ${s.status}"><span class="ic">${icon[s.status] || '·'}</span>
      <div>${esc(s.name)}${s.detail ? `<details${s.status === 'failed' ? ' open' : ''}><summary class="hint">詳細</summary><pre>${esc(s.detail)}</pre></details>` : ''}</div></div>`).join('');
    const r = dev.result;
    let html = '';
    if (dev.phase === 'failed' || dev.phase === 'cancelled') {
      html = `<div class="dres bad"><h4>${dev.phase === 'cancelled' ? '已取消' : '改版失敗'}</h4><p>${esc(dev.error || '')}</p><div class="row"><button id="devDiscard">清除並重新開始</button></div></div>`;
    } else if (r && (dev.phase === 'awaiting' || dev.phase === 'publishing' || dev.phase === 'published')) {
      const vtxt = r.verdict === 'ok' ? '審查結論：可以發布' : r.verdict === 'fix' ? '審查結論：建議修正' : '審查沒有給出明確結論';
      html = `<div class="dres ${r.tests.ok ? '' : 'bad'}">
        <h4>${dev.phase === 'published' ? `已發布 v${esc(r.publishedVersion)} 🎉` : '改版結果'}</h4>
        <div class="hint">以 v${esc(r.baseVersion)} 為基礎，修改 ${r.files.length} 個檔案</div>
        <div class="${r.tests.ok ? 'verdict ok' : 'verdict fix'}">${r.tests.ok ? '✓ 自動測試全部通過' : '✗ 自動測試沒有通過'}</div>
        <div class="verdict ${r.verdict}">${vtxt}</div>
        <details><summary class="hint">修改了哪些檔案</summary><pre>${esc(r.stat)}</pre></details>
        <details><summary class="hint">審查意見</summary><pre>${esc(r.review)}</pre></details>
        <details><summary class="hint">測試輸出</summary><pre>${esc(r.tests.output)}</pre></details>
        <details><summary class="hint">完整程式差異</summary><pre>${esc(r.diff)}</pre></details>
        ${dev.phase === 'awaiting' ? `<div class="row">
          <button class="primary" id="devPublish"${r.tests.ok ? '' : ' disabled'}>發布到 GitHub</button>
          <button class="ghost" id="devDiscard">放棄這次修改</button></div>
          ${r.tests.ok ? '' : '<p class="hint">測試沒過不能發布。可以放棄後把錯誤訊息補進需求再試一次。</p>'}` : ''}
        ${dev.phase === 'published' ? `<div class="row"><button class="primary" id="devGoUpdate">立即更新到 v${esc(r.publishedVersion)}</button><button class="ghost" id="devDiscard">完成</button></div>` : ''}
      </div>`;
    }
    $('#devResult').innerHTML = html;
    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    on('devPublish', async () => {
      if (!confirm('確定把這次修改發布到 GitHub？發布後可在右上角更新套用。')) return;
      $('#devPublish').disabled = true;
      $('#devPublish').textContent = '發布中…';
      const x = await guard(() => api.devPublish({}));
      if (x) { dev = x; renderDev(); checkUpdate(false); toast('已發布到 GitHub'); } else renderDev();
    });
    on('devDiscard', async () => { const x = await guard(() => api.devDiscard()); if (x) { dev = x; $('#devRequest').value = ''; renderDev(); } });
    on('devGoUpdate', async () => { await checkUpdate(false); applyUpdate(); });
  }
  $('#devStart').addEventListener('click', async () => {
    const request = $('#devRequest').value.trim();
    if (!request) { toast('請先描述想要的改變', true); return; }
    const x = await guard(() => api.devStart({ request, planner: $('#devPlanner').value, implementer: $('#devImpl').value, reviewer: $('#devReviewer').value }));
    if (x) { dev = x; renderDev(); }
  });
  $('#devNoteSend').addEventListener('click', () => sendNote('#devNoteInput'));
  $('#devNoteInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendNote('#devNoteInput'); });
  $('#devCancel').addEventListener('click', async () => { if (confirm('確定取消這次改版？')) await guard(() => api.devCancel()); });
  $('#rollbackBtn').addEventListener('click', async () => {
    if (!api.rollback) return;
    const list = await guard(() => api.listBackups());
    if (!list) return;
    if (!list.length) { toast('還沒有備份，更新過一次之後才會有', true); return; }
    if (!confirm(`回復到 v${list[0].version}？AI Office 會自動重新啟動。`)) return;
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.textContent = `正在回復到 v${list[0].version}…`;
    document.body.appendChild(ov);
    const r = await guard(() => api.rollback());
    if (!r) { ov.remove(); return; }
    for (let i = 0; i < 60; i++) {
      await new Promise((res) => setTimeout(res, 700));
      try { const st = await api.getState(); if (st.version === r.version) { location.reload(); return; } } catch (_) { /* 重啟中 */ }
    }
    ov.textContent = '重新啟動逾時，請關掉視窗再從捷徑開啟。';
  });

  // ================= 追問（可能同時有好幾個任務在問） =================
  let pendingAsks = (state.pendingAsks || []).map((a) => ({ ...a, runId: a.runId || 'devops' }));
  function renderAskBanners() {
    $$('.askbanner-slot').forEach((slot) => {
      const n = pendingAsks.length;
      slot.innerHTML = n ? `<button class="askbanner">${n === 1 ? `${esc(pendingAsks[0].agentName)} 有 ${pendingAsks[0].questions.length} 個問題等你回答` : `${n} 個任務有問題等你回答`} ▸</button>` : '';
      const b = slot.querySelector('button');
      if (b) b.addEventListener('click', () => openAsk(pendingAsks[0]));
    });
  }
  function openAsk(ask) {
    if (!ask) return;
    modalView = { kind: 'ask', runId: ask.runId };
    openModal(`${ask.agentName} 想先確認幾件事`, `${ask.title ? `任務：${ask.title}・` : ''}回答越具體，做出來的東西越接近你要的；不想回答可以跳過`);
    $('#modalBody').innerHTML = ask.questions.map((q, i) => `<div class="askq" data-i="${i}">
        <div class="q">${i + 1}. ${esc(q.q)}</div>
        ${q.options && q.options.length ? `<div class="opts">${q.options.map((o) => `<button type="button" data-opt="${esc(o)}">${esc(o)}</button>`).join('')}</div>` : ''}
        <input placeholder="${q.options && q.options.length ? '其他／補充說明（可不填）' : '你的回答'}" data-extra />
      </div>`).join('') + `<div class="askfoot"><button class="primary" id="askSubmit">送出回答</button><button class="ghost" id="askSkip">跳過，直接開始</button>
        ${pendingAsks.length > 1 ? `<span class="hint">還有 ${pendingAsks.length - 1} 個任務在等你</span>` : ''}</div>`;
    $$('#modalBody .opts button').forEach((b) => b.addEventListener('click', () => {
      const on = !b.classList.contains('on');
      b.parentElement.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
      if (on) b.classList.add('on');
    }));
    const submit = async (skip) => {
      const answers = skip ? null : ask.questions.map((q, i) => {
        const box = $(`#modalBody .askq[data-i="${i}"]`);
        const sel = box.querySelector('.opts button.on');
        const extra = box.querySelector('[data-extra]').value.trim();
        return { q: q.q, a: [sel ? sel.dataset.opt : '', extra].filter(Boolean).join('；') };
      });
      if (answers && answers.every((a) => !a.a)) { toast('至少回答一題，或按「跳過」', true); return; }
      const r = await guard(() => api.answerAsk(ask.runId, answers));
      if (r !== null) {
        pendingAsks = pendingAsks.filter((x) => x.runId !== ask.runId);
        renderAskBanners();
        closeModal();
        if (pendingAsks.length) setTimeout(() => openAsk(pendingAsks[0]), 300);
      }
    };
    $('#askSubmit').addEventListener('click', () => submit(false));
    $('#askSkip').addEventListener('click', () => submit(true));
  }

  // ================= 會議室指揮白板 =================
  const CMD_TABS = [['live', '進行中任務'], ['new', '發起任務'], ['routines', '日常任務'], ['projects', '專案總覽']];
  function openCommand(tab) {
    modalView = { kind: 'command', tab: tab || 'live' };
    editingRoutine = null;
    openModal('會議室　指揮白板', '');
    $('#modalBody').innerHTML = `<nav class="cmdtabs">${CMD_TABS.map(([k, n]) => `<button data-ct="${k}">${n}</button>`).join('')}</nav><div id="cmdBody"></div>`;
    $$('#modalBody [data-ct]').forEach((b) => b.addEventListener('click', () => { modalView.tab = b.dataset.ct; editingRoutine = null; renderCommandBody(); }));
    renderCommandBody();
  }
  function renderCommandBody() {
    if (!modalView || modalView.kind !== 'command' || !$('#cmdBody')) return;
    const tab = modalView.tab;
    $$('#modalBody [data-ct]').forEach((b) => b.classList.toggle('on', b.dataset.ct === tab));
    const live = runs.filter((r) => LIVE.includes(r.status));
    if (tab === 'live') {
      const recent = runs.filter((r) => !LIVE.includes(r.status)).slice(0, 8);
      $('#modalSub').textContent = `進行中 ${live.length} 個・最多同時 ${state.settings.maxParallel || 3} 個（可到設定調整）`;
      $('#cmdBody').innerHTML = `
        ${live.length ? `<div class="rgrid">${live.map(runCard).join('')}</div>` : '<p class="hint">目前沒有進行中的任務。到「發起任務」開始一個，或讓日常任務自動跑。</p>'}
        ${recent.length ? `<h4 style="color:var(--muted)">最近結束</h4><div class="rgrid">${recent.map(runCard).join('')}</div>` : ''}`;
      bindRunCards('#cmdBody');
    } else if (tab === 'new') {
      $('#modalSub').textContent = '可以連續發起好幾個任務，大家會同時進行';
      $('#cmdBody').innerHTML = '<div class="launcher wide" data-prefix="w"></div>';
      renderLauncher('w');
    } else if (tab === 'routines') {
      $('#modalSub').textContent = '時間到自動執行（AI Office 需開著；當天錯過的會在開啟後補跑一次）';
      renderRoutines();
    } else {
      renderOverview();
    }
  }
  const openOverview = () => openCommand('projects');

  // ---------- 日常任務 ----------
  let editingRoutine = null;
  const KIND_TXT = { single: '交辦單人', workflow: '協作流程', checklist: '例行清單' };
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  function fmtWhen(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  }
  function routineFormHTML(r) {
    const s = r.schedule || {};
    const agentOpts = (sel) => state.agents.map((a) => `<option value="${esc(a.id)}"${a.id === sel ? ' selected' : ''}>${esc(a.name)}（${esc(a.title || '')}）${a.mode === 'cli' && a.permission === 'full' ? '（完整權限，不可排程）' : ''}</option>`).join('');
    const items = (r.items && r.items.length ? r.items : [{ title: '', agentId: '' }]);
    return `<div class="rform">
      <div class="grid2">
        <div><label>名稱</label><input data-r="title" value="${esc(r.title || '')}" placeholder="例如：每日晨報" /></div>
        <div><label>類型</label><select data-r="kind">${Object.entries(KIND_TXT).map(([k, n]) => `<option value="${k}"${k === r.kind ? ' selected' : ''}>${n}</option>`).join('')}</select></div>
      </div>
      <div data-k="single"><label>交給誰</label><select data-r="agentId">${agentOpts(r.agentId)}</select></div>
      <div data-k="workflow"><label>協作流程</label><select data-r="workflowId">${state.workflows.map((w) => `<option value="${esc(w.id)}"${w.id === r.workflowId ? ' selected' : ''}>${esc(w.name)}</option>`).join('')}</select></div>
      <div data-k="checklist"><label>清單項目（每項指定負責的員工）</label>
        <div class="ritems">${items.map((it) => `<div class="ritem"><input data-it="title" value="${esc(it.title)}" placeholder="例如：檢查信箱並整理重點" /><select data-it="agentId">${agentOpts(it.agentId)}</select><button type="button" class="ghost" data-it-del>✕</button></div>`).join('')}</div>
        <button type="button" id="riAdd">＋ 新增一項</button></div>
      <label data-k-label>要做的事</label>
      <textarea data-r="prompt" rows="3" placeholder="例如：整理今天的科技新聞重點，條列 5 則並附來源">${esc(r.prompt || '')}</textarea>
      <div class="grid3">
        <div><label>頻率</label><select data-r="stype">${[['daily', '每天'], ['weekly', '每週'], ['manual', '只手動執行']].map(([k, n]) => `<option value="${k}"${k === (s.type || 'daily') ? ' selected' : ''}>${n}</option>`).join('')}</select></div>
        <div data-s="time"><label>時間</label><input type="time" data-r="time" value="${esc(s.time || '09:00')}" /></div>
      </div>
      <div data-s="days" class="days">${WEEK.map((w, i) => `<label class="chk"><input type="checkbox" data-day="${i}"${(s.days || [1, 2, 3, 4, 5]).includes(i) ? ' checked' : ''} /> ${w}</label>`).join('')}</div>
      <div class="row"><button class="primary" id="rSave">儲存</button><button class="ghost" id="rCancel">取消</button></div>
    </div>`;
  }
  function syncRoutineForm() {
    const f = $('.rform');
    if (!f) return;
    const kind = f.querySelector('[data-r="kind"]').value;
    f.querySelectorAll('[data-k]').forEach((el) => { el.hidden = el.dataset.k !== kind; });
    f.querySelector('[data-k-label]').textContent = kind === 'checklist' ? '共同說明（可不填，每一項都會參考）' : '要做的事';
    const st = f.querySelector('[data-r="stype"]').value;
    f.querySelector('[data-s="time"]').hidden = st === 'manual';
    f.querySelector('[data-s="days"]').hidden = st !== 'weekly';
  }
  function renderRoutines() {
    const list = routines.map((r) => `<div class="rcard ${r.enabled ? '' : 'off'}">
      <div class="rc-top"><b>${esc(r.title)}</b><span class="rc-tag">${KIND_TXT[r.kind]}</span></div>
      <div class="rc-meta">${esc(r.scheduleText || '')}・${r.kind === 'single' ? esc(agentName(r.agentId)) : r.kind === 'workflow' ? esc((state.workflows.find((w) => w.id === r.workflowId) || {}).name || '') : `${(r.items || []).length} 項`}</div>
      <div class="rc-meta">下次：${r.enabled ? esc(fmtWhen(r.nextRunAt)) : '已暫停'}・上次：${r.runs ? `${esc(fmtWhen(r.lastRunAt))}（${STATUS_TXT[r.lastStatus] || r.lastStatus || '—'}）` : '尚未執行'}</div>
      ${r.lastError ? `<div class="rc-err">${esc(r.lastError)}</div>` : ''}
      <div class="row"><label class="chk"><input type="checkbox" data-en="${esc(r.id)}"${r.enabled ? ' checked' : ''} /> 啟用</label>
        <button data-now="${esc(r.id)}">立即執行</button><button class="ghost" data-edit="${esc(r.id)}">編輯</button><button class="ghost danger" data-del="${esc(r.id)}">刪除</button></div>
    </div>`).join('');
    $('#cmdBody').innerHTML = editingRoutine
      ? routineFormHTML(editingRoutine)
      : `<div class="row" style="margin:0 0 12px"><button class="primary" id="rNew">＋ 新增日常任務</button></div>
         ${routines.length ? `<div class="rgrid">${list}</div>` : '<p class="hint">還沒有日常任務。例如：每天 9:00 讓 Gemma 整理新聞、每週一讓 Clara 寫週報、每天早上產生一份例行清單交給大家分頭處理。</p>'}`;
    const on = (sel, fn) => $$(`#cmdBody ${sel}`).forEach((el) => el.addEventListener('click', () => fn(el)));
    on('#rNew', () => { editingRoutine = { kind: 'single', schedule: { type: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] }, items: [], enabled: true }; renderRoutines(); });
    on('[data-edit]', (el) => { editingRoutine = JSON.parse(JSON.stringify(routines.find((r) => r.id === el.dataset.edit))); renderRoutines(); });
    on('[data-del]', async (el) => { if (!confirm('刪除這個日常任務？')) return; const r = await guard(() => api.deleteRoutine(el.dataset.del)); if (r) { routines = r; renderRoutines(); } });
    on('[data-now]', async (el) => { const r = await guard(() => api.runRoutineNow(el.dataset.now)); if (r) { routines = r.routines; toast('已開始執行'); modalView.tab = 'live'; renderCommandBody(); } });
    $$('#cmdBody [data-en]').forEach((el) => el.addEventListener('change', async () => { const r = await guard(() => api.setRoutineEnabled(el.dataset.en, el.checked)); if (r) { routines = r; renderRoutines(); } }));
    if (!editingRoutine) return;
    const f = $('.rform');
    f.querySelectorAll('[data-r="kind"],[data-r="stype"]').forEach((el) => el.addEventListener('change', syncRoutineForm));
    const bindDel = () => f.querySelectorAll('[data-it-del]').forEach((b) => { b.onclick = () => { if (f.querySelectorAll('.ritem').length > 1) b.parentElement.remove(); }; });
    bindDel();
    $('#riAdd').addEventListener('click', () => {
      const row = f.querySelector('.ritem').cloneNode(true);
      row.querySelector('[data-it="title"]').value = '';
      f.querySelector('.ritems').appendChild(row);
      bindDel();
      row.querySelector('input').focus();
    });
    $('#rCancel').addEventListener('click', () => { editingRoutine = null; renderRoutines(); });
    $('#rSave').addEventListener('click', async () => {
      const g = (k) => f.querySelector(`[data-r="${k}"]`).value;
      const data = {
        id: editingRoutine.id, title: g('title'), kind: g('kind'), agentId: g('agentId'), workflowId: g('workflowId'), prompt: g('prompt'),
        enabled: editingRoutine.enabled !== false,
        items: [...f.querySelectorAll('.ritem')].map((row) => ({ title: row.querySelector('[data-it="title"]').value, agentId: row.querySelector('[data-it="agentId"]').value })),
        schedule: { type: g('stype'), time: g('time'), days: [...f.querySelectorAll('[data-day]')].filter((x) => x.checked).map((x) => Number(x.dataset.day)) },
      };
      const r = await guard(() => api.saveRoutine(data));
      if (r) { routines = r; editingRoutine = null; renderRoutines(); toast('已儲存日常任務'); }
    });
    syncRoutineForm();
  }

  function renderAll() {
    renderLauncher('t');
    renderRuns();
    renderAgents();
    renderFlows();
    renderSettings();
    renderLogFilter();
    renderVersion();
    fillDevSelects();
    renderDev();
  }
  renderAll();
  if (api.isPreview) logEntry('system', null, '瀏覽器預覽模式：使用模擬 AI。要串接真的 AI，請用 npm start 以 Electron 執行。');
  checkUpdate(false);
  loadUsage(false);
  renderAskBanners();
  if (pendingAsks.length) openAsk(pendingAsks[0]);
})();
