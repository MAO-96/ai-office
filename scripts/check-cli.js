// 檢查本機是否裝好各家 CLI：npm run check-cli
const path = require('path');
const { checkCommand } = require('../src/main/adapters/cli');
const engines = require(path.join(__dirname, '..', 'config', 'engines.json'));

(async () => {
  for (const [id, e] of Object.entries(engines)) {
    if (!e || typeof e !== 'object') continue;
    if (!e.cli) { console.log(`- ${e.label}: 無 CLI，使用 API（${e.api.keyEnv}）`); continue; }
    const r = await checkCommand(e.cli.command);
    console.log(`${r.ok ? '✓' : '✗'} ${e.label} (${e.cli.command}): ${r.detail}`);
  }
})();
