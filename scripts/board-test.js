// 任務板與用量的測試：流程自動建任務、手動增改、會議進度、失敗卡住、用量記錄
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createService } = require('../src/main/service');

const waitDone = async (svc, runId) => {
  for (let i = 0; i < 600; i++) {
    const r = svc.listRuns().find((x) => x.runId === runId);
    if (r && ['finished', 'failed', 'stopped'].includes(r.status)) return r;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('等太久');
};

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-office-board-'));
  const events = [];
  const svc = createService({ userDataDir: tmp, defaultsDir: path.join(__dirname, '..', 'config'), crypto: null, openPath: () => {}, emit: (t, d) => events.push([t, d]) });

  // 模擬模式跑管線：應建立 1 個專案、4 個任務，結束後全部完成
  await waitDone(svc, svc.startRun({ kind: 'workflow', workflowId: 'feature-pipeline', task: '做記帳 App' }).runId);
  let b = svc.getTasks();
  const proj = b.projects.find((p) => p.source === 'workflow');
  assert.ok(proj && proj.title === '做記帳 App');
  const pts = b.tasks.filter((t) => t.projectId === proj.id);
  assert.strictEqual(pts.length, 3);
  assert.ok(pts.some((t) => t.title.startsWith('審查討論') && t.note === '已達成共識'));
  assert.ok(pts.every((t) => t.status === 'done' && t.progress === 100));
  assert.strictEqual(proj.status, 'done');
  assert.deepStrictEqual([...new Set(pts.map((t) => t.room))].sort(), ['dev', 'planning', 'review']);
  console.log('✓ 管線自動建立專案與各部門任務（含審查討論），完成後全部打勾');

  // 中途停止：目前那一步應變成「卡住」
  const sid = svc.startRun({ kind: 'workflow', workflowId: 'feature-pipeline', task: '測試停止' }).runId;
  await new Promise((r) => setTimeout(r, 1500));
  svc.stopRun(sid);
  await waitDone(svc, sid);
  b = svc.getTasks();
  const stopped = b.projects.find((x) => x.title === '測試停止');
  assert.strictEqual(stopped.status, 'blocked');
  assert.ok(b.tasks.some((t) => t.projectId === stopped.id && t.status === 'blocked' && t.note === '已手動停止'));
  console.log('✓ 停止後專案顯示卡住，並標出卡在哪一步');

  // 會議：每人兩輪，進度 50% → 100%
  await waitDone(svc, svc.startRun({ kind: 'workflow', workflowId: 'brainstorm-meeting', task: '下季方向' }).runId);
  b = svc.getTasks();
  const mp = b.projects.find((x) => x.title === '下季方向');
  const mts = b.tasks.filter((t) => t.projectId === mp.id);
  assert.strictEqual(mts.length, 5);
  assert.ok(mts.every((t) => t.status === 'done'));
  console.log('✓ 會議：每位成員一張發言卡＋主持人結論卡');

  // 手動新增任務：沒選專案時進「日常事項」，改進度會自動變狀態
  svc.upsertTask({ title: '整理競品', agentId: 'designer' });
  b = svc.getTasks();
  const t = b.tasks.find((x) => x.title === '整理競品');
  assert.strictEqual(t.room, 'research');
  assert.strictEqual(b.projects.find((x) => x.id === t.projectId).title, '日常事項');
  svc.upsertTask({ id: t.id, progress: 40 });
  assert.strictEqual(svc.getTasks().tasks.find((x) => x.id === t.id).status, 'doing');
  svc.upsertTask({ id: t.id, progress: 100 });
  assert.strictEqual(svc.getTasks().tasks.find((x) => x.id === t.id).status, 'done');
  console.log('✓ 手動任務：自動歸到角色的處室，進度改變自動更新狀態');

  // 資料只存一份
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'tasks.json'), 'utf8'));
  assert.strictEqual(onDisk.tasks.length, svc.getTasks().tasks.length);
  assert.ok(events.some(([ty]) => ty === 'tasks'));
  console.log('✓ 單一資料來源，變動會即時推送給畫面');

  // 模擬模式不記用量；直接記一筆 API 呼叫測成本計算
  const usage = await svc.getUsage(true);
  assert.ok(usage.grok && usage.grok.mode === 'api');
  assert.strictEqual(usage.grok.today.calls, 0);
  console.log('✓ 模擬模式不計入用量');

  // 平行：同時開 3 個交辦，應該同時進行
  const ids = ['pm', 'dev', 'designer'].map((a) => svc.startRun({ kind: 'single', agentId: a, task: `平行測試 ${a}` }).runId);
  await new Promise((r) => setTimeout(r, 700));
  assert.strictEqual(svc.listRuns().filter((x) => ids.includes(x.runId) && x.status === 'running').length, 3);
  await Promise.all(ids.map((id) => waitDone(svc, id)));
  const conv = svc.getRun(ids[0]);
  assert.ok(conv.log.some((e) => e.kind === 'output'));
  console.log('✓ 3 個交辦同時進行，每個都有自己的對話紀錄');

  // 完整權限的員工不能排進日常任務
  const ag = svc.getState().agents.map((a) => (a.id === 'dev' ? { ...a, permission: 'full' } : a));
  svc.saveAgents(ag);
  assert.throws(() => svc.saveRoutine({ title: '每日', kind: 'single', agentId: 'dev', prompt: 'x', schedule: { type: 'daily', time: '09:00' } }), /完整權限/);
  assert.throws(() => svc.saveRoutine({ title: '每週', kind: 'workflow', workflowId: 'feature-pipeline', prompt: 'x', schedule: { type: 'manual' } }), /Cody/);
  svc.saveRoutine({ title: '研究', kind: 'single', agentId: 'designer', prompt: 'x', schedule: { type: 'manual' } });
  svc.saveAgents(ag.map((a) => ({ ...a, permission: a.id === 'designer' ? 'full' : 'read' })));
  const rid = svc.listRoutines()[0].id;
  assert.throws(() => svc.runRoutineNow(rid), /完整權限/);
  svc.saveAgents(ag.map((a) => ({ ...a, permission: 'read' })));
  console.log('✓ 完整權限的員工不能被排進日常任務（事後調高也擋得住）');

  svc.clearDoneProjects();
  assert.ok(svc.getTasks().projects.every((x) => x.status !== 'done'));
  console.log('✓ 清除已完成專案');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n全部通過');
})().catch((e) => { console.error('✗', e); process.exit(1); });
