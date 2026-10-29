// 用量：查詢各家 AI 剩餘額度，並記錄 AI Office 自己的呼叫次數與花費。
//  - Claude（CLI）：讀 Claude Code 的登入資訊，查詢訂閱的 5 小時 / 7 天用量（非官方介面，可能失效）
//  - Codex（CLI）：讀 Codex 在本機留下的工作紀錄，裡面有 5 小時 / 每週用量百分比
//  - Antigravity（Gemini CLI）：官方沒有提供查詢方式，只顯示 AI Office 的呼叫統計
//  - API 模式（Grok 等）：依回應中的 token 數與單價估算本月花費
const fs = require('fs');
const os = require('os');
const path = require('path');

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

  // ---------- 彙整 ----------
  async function refresh(engineId) {
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
      else if (mode === 'cli' && engineId === 'codex') r = codexWindows();
      else if (mode === 'cli' && engineId === 'gemini') out.note = 'Google 沒有提供程式查詢剩餘額度的方式，可在 PowerShell 執行 agy 後輸入 /usage 查看。';
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
      result[id] = !force && c && Date.now() - c.at < CACHE_MS ? c.value : await refresh(id);
    }));
    return result;
  }

  return { record, getAll, refresh };
}

module.exports = { createUsage };
