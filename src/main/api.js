// 對外 API：伺服器（瀏覽器版）與 Electron 版共用同一份清單，畫面一律用 call(名稱, 內容) 呼叫。
function buildApi(svc) {
  return {
    getState: () => svc.getState(),
    saveAgents: (b) => svc.saveAgents(b),
    saveWorkflows: (b) => svc.saveWorkflows(b),
    saveEngines: (b) => svc.saveEngines(b),
    saveSettings: (b) => svc.saveSettings(b || {}),
    setWorkspace: (b) => svc.setWorkspace(b && b.path),
    resetConfig: () => svc.resetConfig(),
    saveKey: (b) => svc.saveKey(b),
    // 任務（可平行）
    startRun: (b) => svc.startRun(b || {}),
    stopRun: (b) => svc.stopRun(b && b.runId),
    listRuns: () => svc.listRuns(),
    getRun: (b) => svc.getRun(b && b.runId),
    removeRun: (b) => svc.removeRun(b && b.runId),
    clearRuns: () => svc.clearRuns(),
    answerAsk: (b) => svc.answerAsk(b || {}),
    addNote: (b) => svc.addNote(b || {}),
    // 日常任務
    listRoutines: () => svc.listRoutines(),
    saveRoutine: (b) => svc.saveRoutine(b),
    deleteRoutine: (b) => svc.deleteRoutine(b && b.id),
    setRoutineEnabled: (b) => svc.setRoutineEnabled(b || {}),
    runRoutineNow: (b) => svc.runRoutineNow(b && b.id),
    // 角色
    testAgent: (b) => svc.testAgent(b && b.id),
    // 任務板
    getTasks: () => svc.getTasks(),
    upsertTask: (b) => svc.upsertTask(b),
    deleteTask: (b) => svc.deleteTask(b && b.id),
    upsertProject: (b) => svc.upsertProject(b),
    deleteProject: (b) => svc.deleteProject(b && b.id),
    clearDoneProjects: () => svc.clearDoneProjects(),
    // 用量
    getUsage: (b) => svc.getUsage(b && b.force),
    // 改版
    devStatus: () => svc.devStatus(),
    devStart: (b) => svc.devStart(b),
    devPublish: (b) => svc.devPublish(b),
    devDiscard: () => svc.devDiscard(),
    devCancel: () => svc.devCancel(),
    // 其他
    checkCli: () => svc.checkCli(),
    openWorkspace: () => svc.openWorkspace(),
    openFile: (b) => svc.openFile(b && b.file),
  };
}
module.exports = { buildApi };
