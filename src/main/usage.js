// 用量：查詢各家 AI 剩餘額度，並記錄 AI Office 自己的呼叫次數與花費。
//  - Claude（CLI）：讀 Claude Code 的登入資訊，查詢訂閱的 5 小時 / 7 天用量（非官方介面，可能失效）
//  - Codex（CLI）：讀 Codex 在本機留下的工作紀錄，裡面有 5 小時 / 每週用量百分比
//  - Antigravity（Gemini CLI）：官方沒有提供查詢方式，只顯示 AI Office 的呼叫統計
//  - API 模式（Grok 等）：依回應中的 token 數與單價估算本月花費
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CACHE_MS = 60 * 1000;
const day = (d = new Date()) => d.toLocaleDateString('sv-SE'); // YYYY-MM-DD（本地時間）
const month = (d = new Date()) => day(d).slice(0, 7);

function pct(v) {
  if (v == null || isNaN(v)) return null;
  const n = Number(v);
  // 有的介面回 0~1 的比例，有的回 0~100 的百分比
  return Math.max(0, Math.min(100, n <= 1 && !Number.isInteger(n) ? n * 100 : n));
}

function createUsage({ file, store, emit }) {
  let ledger = { days: {}, months: {}, last429: {}, lastError: {} };
  try { ledger = { ...ledger, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (_) { /* 第一次 */ }
  const cache = {};

  function saveLedger() {
    // 只保留最近 40 天的每日統計
    const keys = Object.keys(ledger.days).sort();
    while (keys.length > 40) delete ledger.days[keys.shift()];
    try { fs.writeFileSync(file, JSON.stringify(ledger, null, 2), 'utf8'); } catch (_) { /* ignore */ }
  }

  function bucket(obj, key, engine) {
    obj[key] = obj[key] || {};
    obj[key][engine] = obj[key][engine] || { calls: 0, ok: 0, fail: 0, inTok: 0, outTok: 0, cost: 0 };
    return obj[key][engine];
  }

  function record(agent, { ok, tokens, error }) {
    const eng = agent.engine;
    const engines = store.getEngines();
    const price = (engines[eng] && engines[eng].api && engines[eng].api.pricing) || null;
    for (const b of [bucket(ledger.days, day(), eng), bucket(ledger.months, month(), eng)]) {
      b.calls++;
      if (ok) b.ok++; else b.fail++;
      if (tokens) {
        b.inTok += tokens.inTok || 0;
        b.outTok += tokens.outTok || 0;
        if (price && agent.mode === 'api') b.cost += ((tokens.inTok || 0) * price.input + (tokens.outTok || 0) * price.output) / 1e6;
      }
    }
    if (!ok && /額度|429|quota|rate.?limit/i.test(error || '')) ledger.last429[eng] = new Date().toISOString();
    if (!ok) ledger.lastError[eng] = { at: new Date().toISOString(), text: String(error || '').slice(0, 200) };
    saveLedger();
    delete cache[eng]; // 下次查詢重新抓
    setTimeout(() => refresh(eng).then((u) => emit('usage', u)).catch(() => {}), 1500);
  }

  // ---------- Claude ----------
  async function claudeWindows() {
    const credFile = path.join(os.homedir(), '.claude', '.credentials.json');
    if (!fs.existsSync(credFile)) {
      return { error: process.platform === 'darwin' ? 'macOS 的 Claude 登入資訊存在鑰匙圈，無法讀取' : '找不到 Claude Code 登入資訊，請先在終端機執行 claude 登入' };
    }
    let token;
    try { token = JSON.parse(fs.readFileSync(credFile, 'utf8')).claudeAiOauth.accessToken; } catch (_) { return { error: '無法讀取 Claude 登入資訊' }; }
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': 'ai-office' },
    });
    if (res.status === 401) return { error: 'Claude 登入已過期，請在 PowerShell 執行 claude 一次' };
    if (!res.ok) return { error: `查詢失敗（HTTP ${res.status}）` };
    const j = await res.json();
    const win = (w, name) => (j[w] ? { name, usedPct: pct(j[w].utilization), resetsAt: j[w].resets_at || null } : null);
    return { windows: [win('five_hour', '5 小時'), win('seven_day', '7 天')].filter(Boolean), source: 'unofficial' };
  }

  // ---------- Codex ----------
  function codexWindows() {
    const root = path.join(os.homedir(), '.codex', 'sessions');
    if (!fs.existsSync(root)) return { error: '還沒有 Codex 使用紀錄，執行過一次後就會顯示' };
    const files = [];
    for (let i = 0; i < 8; i++) {
      const d = new Date(Date.now() - i * 86400000);
      const dir = path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
      try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) { const full = path.join(dir, f); files.push({ full, m: fs.statSync(full).mtimeMs }); } } catch (_) { /* 沒有這天 */ }
    }
    files.sort((a, b) => b.m - a.m);
    for (const { full } of files.slice(0, 15)) {
      let lines;
      try { lines = fs.readFileSync(full, 'utf8').trim().split('\n'); } catch (_) { continue; }
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('rate_limits')) continue;
        let rec;
        try { rec = JSON.parse(lines[i]); } catch (_) { continue; }
        const rl = rec.payload && rec.payload.rate_limits;
        if (!rl) continue;
        const ts = Date.parse(rec.timestamp) || Date.now();
        const toWin = (w, fallback) => {
          if (!w) return null;
          const mins = w.window_minutes || 0;
          const name = mins ? (mins < 600 ? `${Math.round(mins / 60)} 小時` : mins < 1500 ? '1 天' : '7 天') : fallback;
          const resetsAt = w.resets_at ? new Date((w.resets_at > 1e12 ? w.resets_at : w.resets_at * 1000)).toISOString()
            : w.resets_in_seconds != null ? new Date(ts + w.resets_in_seconds * 1000).toISOString() : null;
          // 已過重置時間的紀錄代表額度已恢復
          const expired = resetsAt && Date.parse(resetsAt) < Date.now();
          return { name, usedPct: expired ? 0 : pct(w.used_percent != null ? w.used_percent : w.usedPercent), resetsAt: expired ? null : resetsAt };
        };
        return { windows: [toWin(rl.primary, '5 小時'), toWin(rl.secondary, '每週')].filter(Boolean), source: 'local', asOf: rec.timestamp };
      }
    }
    return { error: '紀錄裡還沒有用量資訊，執行過一次後就會顯示' };
  }

  // ---------- Antigravity（Gemini） ----------
  // Google 沒有公開的查詢方式。若使用者自行安裝了第三方工具 agy-hud，
  // 它會把額度寫進本機快取檔；AI Office 只「讀」這個檔，不碰登入資訊、不呼叫 Google。
  function agyHudWindows() {
    const dirs = [
      path.join(os.homedir(), '.gemini', 'antigravity-cli'),
      process.env.XDG_DATA_HOME && path.join(process.env.XDG_DATA_HOME, 'antigravity-cli'),
      process.env.APPDATA && path.join(process.env.APPDATA, 'antigravity-cli'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'antigravity-cli'),
    ].filter(Boolean);
    const file = dirs.map((d) => path.join(d, 'agy-hud-quota-cache.json')).find((f) => fs.existsSync(f));
    if (!file) return null;
    let j;
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return { error: '無法讀取 agy-hud 的額度快取' }; }
    const models = Array.isArray(j.data) ? j.data : [];
    const google = models.filter((m) => m.modelProvider === 'MODEL_PROVIDER_GOOGLE' || /gemini/i.test(`${m.id} ${m.displayName || ''}`));
    const pool = google.length ? google : models;
    const now = Date.now();
    const pick = (key, label) => {
      let worst = null;
      for (const m of pool) {
        const w = m.windows && m.windows[key];
        if (!w || w.remainingFraction == null) continue;
        const expired = w.resetTime && Date.parse(w.resetTime) < now;
        const left = expired ? 1 : Number(w.remainingFraction);
        if (!worst || left < worst.left) worst = { left, model: m.displayName || m.id, resetTime: expired ? null : w.resetTime };
      }
      return worst ? { name: `${label}（${worst.model}）`, usedPct: Math.round((1 - worst.left) * 1000) / 10, resetsAt: worst.resetTime } : null;
    };
    const windows = [pick('fiveHour', '5 小時'), pick('weekly', '每週')].filter(Boolean);
    if (!windows.length) return { error: 'agy-hud 快取裡還沒有額度資料，開一次 agy 互動畫面就會更新' };
    return { windows, source: 'agyhud', asOf: j.lastRefreshed ? new Date(j.lastRefreshed).toISOString() : null, plan: j.tier || null };
  }

  // ---------- Codex 即時查詢（官方 app-server 介面） ----------
  function codexLive() {
    const { spawnResolved } = require('./adapters/cli');
    return new Promise((resolve) => {
      let child;
      try { child = spawnResolved('codex', ['app-server'], { env: { ...process.env, NO_COLOR: '1' } }); } catch (_) { return resolve(null); }
      let buf = '';
      let done = false;
      const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch (_) { /* ignore */ } resolve(v); };
      const timer = setTimeout(() => finish(null), 15000);
      const send = (m) => { try { child.stdin.write(JSON.stringify(m) + '\n'); } catch (_) { /* ignore */ } };
      child.on('error', () => finish(null));
      child.on('close', () => finish(null));
      child.stdin.on('error', () => {});
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch (_) { continue; }
          if (msg.id === 0) {
            send({ method: 'initialized', params: {} });
            send({ method: 'account/rateLimits/read', id: 1 });
          } else if (msg.id === 1 && msg.error) {
            send({ method: 'account/rateLimits/read', id: 2, params: {} }); // 有些版本要求帶 params
          } else if ((msg.id === 1 || msg.id === 2) && msg.result) {
            finish(msg.result.rateLimits || msg.result.rate_limits || null);
          } else if (msg.id === 2 && msg.error) {
            finish(null);
          }
        }
      });
      send({ method: 'initialize', id: 0, params: { clientInfo: { name: 'ai-office', version: '1' } } });
    });
  }
  function codexFromLive(rl) {
    const toWin = (w, fallback) => {
      if (!w) return null;
      const used = w.usedPercent != null ? w.usedPercent : w.used_percent;
      const mins = w.windowDurationMins || w.window_minutes || w.windowMinutes || 0;
      let at = w.resetsAt != null ? w.resetsAt : w.resets_at;
      const name = mins ? (mins < 600 ? `${Math.round(mins / 60)} 小時` : mins < 1500 ? '1 天' : '7 天') : fallback;
      const resetsAt = at != null ? new Date(at > 1e12 ? at : at * 1000).toISOString() : null;
      return { name, usedPct: pct(used), resetsAt };
    };
    return { windows: [toWin(rl.primary, '5 小時'), toWin(rl.secondary, '7 天')].filter(Boolean), source: 'live', asOf: new Date().toISOString() };
  }

  // ---------- Antigravity：請已安裝的 agy-hud 刷新一次額度 ----------
  let lastAgyRefresh = 0;
  function runNode(args, stdin, timeoutMs) {
    return new Promise((resolve) => {
      let child;
      try { child = spawn(process.versions.electron ? 'node' : process.execPath, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] }); } catch (_) { return resolve(false); }
      const t = setTimeout(() => { try { child.kill(); } catch (_) { /* ignore */ } resolve(false); }, timeoutMs);
      child.on('error', () => { clearTimeout(t); resolve(false); });
      child.on('close', (code) => { clearTimeout(t); resolve(code === 0); });
      child.stdin.on('error', () => {});
      child.stdin.end(stdin || '');
    });
  }
  async function refreshAgyHud() {
    if (Date.now() - lastAgyRefresh < 20000) return;
    lastAgyRefresh = Date.now();
    const roots = [
      path.join(os.homedir(), '.gemini', 'antigravity-cli'),
      process.env.APPDATA && path.join(process.env.APPDATA, 'antigravity-cli'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'antigravity-cli'),
    ].filter(Boolean);
    const rt = roots.map((r) => path.join(r, 'agy-hud-runtime', 'runtime')).find((d) => fs.existsSync(path.join(d, 'quota.js')));
    if (!rt) return;
    // 先跑一次狀態列程式（它會更新登入權杖的暫存），再請它重新抓額度
    await runNode([path.join(rt, 'bin', 'agy-hud.js')], '{}', 10000);
    await new Promise((r) => setTimeout(r, 1500));
    await runNode([path.join(rt, 'quota.js'), '--refresh'], '', 15000);
  }

  // ---------- 彙整 ----------
  async function refresh(engineId, live_ = false) {
    const engines = store.getEngines();
    const e = engines[engineId];
    if (!e || typeof e !== 'object') return null;
    const agents = store.getAgents().filter((a) => a.engine === engineId);
    const mode = agents.some((a) => a.mode === 'cli') ? 'cli' : 'api';
    const today = (ledger.days[day()] || {})[engineId] || { calls: 0, ok: 0, fail: 0 };
    const mon = (ledger.months[month()] || {})[engineId] || { calls: 0, inTok: 0, outTok: 0, cost: 0 };
    const out = {
      engine: engineId, label: e.label, color: e.color, mode, agents: agents.map((a) => a.name),
      today: { calls: today.calls, fail: today.fail }, month: { calls: mon.calls, inTok: mon.inTok, outTok: mon.outTok, cost: Math.round(mon.cost * 10000) / 10000 },
      last429: ledger.last429[engineId] || null, lastError: ledger.lastError[engineId] || null,
      windows: [], source: 'local', note: '', error: null, updatedAt: new Date().toISOString(),
    };
    try {
      let r = null;
      if (mode === 'cli' && engineId === 'claude') r = await claudeWindows();
      else if (mode === 'cli' && engineId === 'codex') {
        const live = live_ ? await codexLive() : null;
        r = live ? codexFromLive(live) : codexWindows();
      }
      else if (mode === 'cli' && engineId === 'gemini') {
        if (live_) await refreshAgyHud();
        r = agyHudWindows();
        if (!r) out.note = 'Google 沒有公開的額度查詢方式。可在 PowerShell 執行 agy 後輸入 /usage 查看；或自行安裝第三方工具 agy-hud，AI Office 會自動讀它的額度紀錄（說明見 README）。';
        else if (r.asOf) out.note = `資料來自 agy-hud，最後更新 ${new Date(r.asOf).toLocaleString('zh-TW', { hour12: false })}${r.plan ? `・方案：${r.plan}` : ''}。`;
      }
      else if (mode === 'api') out.note = e.api && e.api.pricing ? '依 API 回應的 token 數 × 單價估算，實際以供應商帳單為準。' : '依 API 回應的 token 數統計。';
      if (r) { out.windows = r.windows || []; out.source = r.source || out.source; out.error = r.error || null; out.asOf = r.asOf || null; }
    } catch (err) {
      out.error = '查詢失敗：' + (err.message || err);
    }
    cache[engineId] = { at: Date.now(), value: out };
    return out;
  }

  async function getAll(force) {
    const ids = [...new Set(store.getAgents().map((a) => a.engine))];
    const result = {};
    await Promise.all(ids.map(async (id) => {
      const c = cache[id];
      result[id] = !force && c && Date.now() - c.at < CACHE_MS ? c.value : await refresh(id, !!force);
    }));
    return result;
  }

  return { record, getAll, refresh };
}

module.exports = { createUsage };
