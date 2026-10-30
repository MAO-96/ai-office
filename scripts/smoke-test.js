// 不需要 Electron 的煙霧測試：驗證設定讀寫、兩種流程、CLI 轉接器、停止機制。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../src/main/store');
const { createOrchestrator } = require('../src/shared/orchestrator-core');
const MockAdapter = require('../src/shared/mock-adapter');
const { runCli, buildArgs } = require('../src/main/adapters/cli');

const ROOT = path.join(__dirname, '..');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-'));
  const store = createStore({ userDataDir: tmp, defaultsDir: path.join(ROOT, 'config') });
  assert.ok(store.getAgents().length >= 4, '預設角色應載入');
  assert.ok(store.getSettings().mockMode, '預設應為模擬模式');

  const events = [];
  const orch = createOrchestrator({
    getAgents: store.getAgents,
    getWorkflows: store.getWorkflows,
    runAgent: (a, p, o) => MockAdapter.run(a, p, { ...o, speed: 200 }),
  });
  orch.on('*', (t, d) => events.push([t, d]));

  // 管線
  const r1 = await orch.run('feature-pipeline', '做一個待辦清單 App');
  assert.strictEqual(r1.outputs.length, 4);
  assert.ok(events.some(([t]) => t === 'handoff'), '管線應有交接事件');
  const report = store.saveRunReport(r1);
  assert.ok(fs.existsSync(report), '應存下報告');
  console.log('✓ 管線流程，報告：', path.relative(tmp, report));

  // 會議
  events.length = 0;
  const r2 = await orch.run('brainstorm-meeting', '下季產品方向');
  assert.strictEqual(r2.outputs.length, 4 * 2 + 1);
  assert.ok(events.filter(([t, d]) => t === 'move' && d.to === 'meeting').length >= 4, '應移動到會議室');
  console.log('✓ 會議流程，發言數：', r2.outputs.length - 1);

  // 停止
  const p = orch.run('feature-pipeline', '測試停止');
  setTimeout(() => orch.stop(), 30);
  await p.then(() => assert.fail('應被停止'), (e) => assert.ok(e.stopped));
  assert.ok(!orch.isRunning());
  console.log('✓ 停止機制');

  // 角色驗證
  assert.throws(() => store.saveAgents([{ id: 'pm', name: 'x' }]), /引用了不存在的角色/);
  console.log('✓ 刪除被流程引用的角色會被擋下');

  // CLI 轉接器：用 cat 模擬一個從 stdin 讀提示詞的 CLI
  if (process.platform !== 'win32') {
    const out = await runCli({ cli: { command: 'cat', args: [], promptVia: 'stdin' }, agent: { engine: 'fake', name: 'T' }, prompt: '你好\n第二行', cwd: tmp });
    assert.strictEqual(out, '你好\n第二行');
    await runCli({ cli: { command: 'not-a-real-cli-xyz', args: [] }, agent: { engine: 'fake' }, prompt: 'x', cwd: tmp })
      .then(() => assert.fail(), (e) => assert.match(e.message, /找不到「not-a-real-cli-xyz」/));
    console.log('✓ CLI 轉接器（stdin 傳遞、找不到指令提示）');
  }
  const args = buildArgs(store.getEngines().codex.cli, { model: 'm1' }, 'p');
  assert.deepStrictEqual(args, ['exec', '--skip-git-repo-check', '-m', 'm1', '--sandbox', 'read-only', '-']);
  console.log('✓ 模型參數插入位置');
  const E = store.getEngines();
  const cx = (permission, write) => buildArgs(E.codex.cli, { permission }, 'p', { write }).join(' ');
  assert.match(cx('workspace'), /--sandbox workspace-write/);
  assert.match(cx('full'), /--dangerously-bypass-approvals-and-sandbox/);
  assert.match(cx(undefined, true), /--sandbox workspace-write/); // 改版至少可改檔
  assert.match(cx('full', true), /--dangerously-bypass/); // 完整權限不會被改版降級
  assert.deepStrictEqual(buildArgs(E.claude.cli, {}, 'p'), ['-p']);
  assert.deepStrictEqual(buildArgs(E.claude.cli, { permission: 'full' }, 'p'), ['-p', '--dangerously-skip-permissions']);
  assert.deepStrictEqual(buildArgs(E.gemini.cli, { permission: 'workspace' }, 'hi'), ['-p', 'hi', '--mode', 'accept-edits', '--print-timeout', '10m']);
  assert.deepStrictEqual(buildArgs({ args: ['-p', '{writeArgs}'], writeArgs: ['--w'] }, { permission: 'workspace' }, 'p'), ['-p', '--w']); // 舊版設定檔
  assert.throws(() => store.saveAgents([{ id: 'x', name: 'X', permission: 'root' }]), /權限設定不正確/);
  console.log('✓ 每位員工各自的權限（唯讀／工作目錄／完整）');

  // 金鑰（無加密時明文保存）
  store.setKey('XAI_API_KEY', 'abc');
  assert.strictEqual(store.getKey('XAI_API_KEY'), 'abc');
  assert.strictEqual(store.keyStatus().XAI_API_KEY, process.env.XAI_API_KEY ? 'env' : 'saved');
  console.log('✓ 金鑰儲存');

  // 舊版使用者升級：自動加入資料蒐集員，研究管線若沒改過就換成新版；刪掉後不會再加回來
  {
    const old = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-mig-'));
    const cfg = path.join(old, 'config');
    fs.mkdirSync(cfg, { recursive: true });
    const def = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'config', f), 'utf8'));
    const mig = def('migrations.json');
    fs.writeFileSync(path.join(cfg, 'agents.json'), JSON.stringify(def('agents.json').filter((a) => a.id !== 'collector')));
    const oldRp = mig.workflows['research-pipeline'].slice(-1)[0];
    fs.writeFileSync(path.join(cfg, 'workflows.json'), JSON.stringify(def('workflows.json').map((w) => (w.id === 'research-pipeline' ? oldRp : w))));
    let st = createStore({ userDataDir: old, defaultsDir: path.join(ROOT, 'config') });
    assert.ok(st.getAgents().some((a) => a.id === 'collector'));
    assert.strictEqual(st.getWorkflows().find((w) => w.id === 'research-pipeline').steps[0].agent, 'collector');
    fs.writeFileSync(path.join(cfg, 'agents.json'), JSON.stringify(st.getAgents().filter((a) => a.id !== 'collector')));
    st = createStore({ userDataDir: old, defaultsDir: path.join(ROOT, 'config') });
    assert.ok(!st.getAgents().some((a) => a.id === 'collector'));
    fs.rmSync(old, { recursive: true, force: true });
    console.log('✓ 升級時自動加入資料蒐集員 Iris，研究管線改由她先蒐集資料');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n全部通過');
})().catch((e) => { console.error('✗', e); process.exit(1); });
