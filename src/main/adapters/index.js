// 轉接器路由：依設定決定角色要走模擬、CLI 或 API。
const { runCli } = require('./cli');
const { runApi } = require('./api');
const MockAdapter = require('../../shared/mock-adapter');
const { composePrompt } = require('../../shared/orchestrator-core');

function createRunner(store, { forceReal = false } = {}) {
  return async function runAgent(agent, prompt, { signal, onChunk } = {}) {
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
        signal,
        onChunk,
        timeoutMs: (settings.timeoutMinutes || 10) * 60 * 1000,
      });
    }
    const api = engine.api;
    return runApi({ api, agent, prompt, key: api && store.getKey(api.keyEnv), signal, onChunk });
  };
}

module.exports = { createRunner };
