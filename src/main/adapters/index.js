// 轉接器路由：依設定決定角色要走模擬、CLI 或 API。
const { runCli } = require('./cli');
const { runApi } = require('./api');
const MockAdapter = require('../../shared/mock-adapter');
const { composePrompt } = require('../../shared/orchestrator-core');

function createRunner(store, { forceReal = false, usage = null } = {}) {
  const inner = makeInner(store, forceReal);
  // 記錄每次呼叫的成敗與 token，供用量面板使用（模擬模式不記）
  return async function runAgent(agent, prompt, opts = {}) {
    const real = forceReal || !store.getSettings().mockMode;
    let tokens = null;
    try {
      const out = await inner(agent, prompt, { ...opts, onUsage: (u) => { tokens = u; } });
      if (real && usage) usage.record(agent, { ok: true, tokens });
      return out;
    } catch (e) {
      if (real && usage && !(opts.signal && opts.signal.aborted)) usage.record(agent, { ok: false, error: e.message });
      throw e;
    }
  };
}

function makeInner(store, forceReal) {
  return async function runAgent(agent, prompt, { signal, onChunk, onUsage } = {}) {
    const settings = store.getSettings();
    if (settings.mockMode && !forceReal) return MockAdapter.run(agent, prompt, { signal, onChunk });

    const engine = store.getEngines()[agent.engine];
    if (!engine) throw new Error(`未知的引擎：${agent.engine}`);

    if (agent.mode === 'cli') {
      return runCli({
        cli: engine.cli,
        agent,
        prompt: composePrompt(agent, prompt),
        cwd: store.getWorkspace(),
        env: engine.cli && engine.cli.env,
        signal,
        onChunk,
        timeoutMs: (settings.timeoutMinutes || 10) * 60 * 1000,
      });
    }
    const api = engine.api;
    return runApi({ api, agent, prompt, key: api && store.getKey(api.keyEnv), signal, onChunk, onUsage });
  };
}

module.exports = { createRunner };
