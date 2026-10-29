// API 轉接器：直接呼叫各家 HTTP API（不串流，回傳完整文字）。
const MAX_TOKENS = 4096;

async function postJson(url, headers, body, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { json = null; }
  if (!res.ok) {
    const msg = (json && (json.error && (json.error.message || json.error))) || text.slice(0, 500);
    throw new Error(`HTTP ${res.status}：${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  return json;
}

const providers = {
  async anthropic({ key, model, system, prompt, signal }) {
    const j = await postJson('https://api.anthropic.com/v1/messages',
      { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      { model, max_tokens: MAX_TOKENS, system, messages: [{ role: 'user', content: prompt }] }, signal);
    return (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  },

  async openai({ key, model, system, prompt, signal, baseUrl = 'https://api.openai.com/v1' }) {
    const j = await postJson(`${baseUrl}/chat/completions`,
      { authorization: `Bearer ${key}` },
      { model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }, signal);
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  },

  // xAI 的 API 與 OpenAI Chat Completions 格式相容
  async xai(opts) {
    return providers.openai({ ...opts, baseUrl: 'https://api.x.ai/v1' });
  },

  async gemini({ key, model, system, prompt, signal }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const j = await postJson(url, { 'x-goog-api-key': key }, {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    }, signal);
    const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
    return parts.map((p) => p.text || '').join('');
  },
};

async function runApi({ api, agent, prompt, key, signal, onChunk }) {
  if (!api) throw new Error(`${agent.engine} 沒有 API 接法`);
  const fn = providers[api.provider];
  if (!fn) throw new Error(`不支援的 API 供應商：${api.provider}`);
  if (!key) throw new Error(`缺少 ${api.keyEnv}，請到「設定」填入或設成環境變數`);
  const model = (agent.model || '').trim() || api.defaultModel;
  if (!model) throw new Error(`${agent.name} 未指定模型，請在角色設定填入 ${api.provider} 的模型 ID`);
  const system = `你的名字是 ${agent.name}，職稱是「${agent.title}」。\n${agent.systemPrompt || ''}`;
  const text = await fn({ key, model, system, prompt, signal });
  if (onChunk) onChunk(text);
  return text;
}

module.exports = { runApi, providers };
