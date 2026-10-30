/* 共用：給一個 call(名稱, 內容) 與事件訂閱，就組出畫面用的 window.aiOffice。 */
(function () {
  'use strict';
  window.AiOfficeBridge = function build(call, onEvent, extra) {
    const api = {
      isPreview: false,
      getState: () => call('getState'),
      saveAgents: (a) => call('saveAgents', a),
      saveWorkflows: (w) => call('saveWorkflows', w),
      saveEngines: (e) => call('saveEngines', e),
      saveSettings: (s) => call('saveSettings', s),
      resetConfig: () => call('resetConfig'),
      saveKey: (name, value) => call('saveKey', { name, value }),
      // 任務：startRun({ kind:'single'|'workflow', agentId, workflowId, task, clarify, title })
      startRun: (opts) => call('startRun', opts),
      stopRun: (runId) => call('stopRun', { runId }),
      listRuns: () => call('listRuns'),
      getRun: (runId) => call('getRun', { runId }),
      removeRun: (runId) => call('removeRun', { runId }),
      clearRuns: () => call('clearRuns'),
      answerAsk: (runId, answers) => call('answerAsk', { runId, source: runId === 'devops' ? 'devops' : 'run', answers }),
      addNote: (runId, text) => call('addNote', { runId, text }),
      listRoutines: () => call('listRoutines'),
      saveRoutine: (r) => call('saveRoutine', r),
      deleteRoutine: (id) => call('deleteRoutine', { id }),
      setRoutineEnabled: (id, enabled) => call('setRoutineEnabled', { id, enabled }),
      runRoutineNow: (id) => call('runRoutineNow', { id }),
      testAgent: (id) => call('testAgent', { id }),
      getTasks: () => call('getTasks'),
      upsertTask: (t) => call('upsertTask', t),
      deleteTask: (id) => call('deleteTask', { id }),
      upsertProject: (p) => call('upsertProject', p),
      deleteProject: (id) => call('deleteProject', { id }),
      clearDoneProjects: () => call('clearDoneProjects'),
      getUsage: (force) => call('getUsage', { force }),
      devStatus: () => call('devStatus'),
      devStart: (b) => call('devStart', b),
      devPublish: (b) => call('devPublish', b),
      devDiscard: () => call('devDiscard'),
      devCancel: () => call('devCancel'),
      checkCli: () => call('checkCli'),
      openWorkspace: () => call('openWorkspace'),
      openFile: (file) => call('openFile', { file }),
      onEvent,
    };
    return Object.assign(api, extra || {});
  };
})();
