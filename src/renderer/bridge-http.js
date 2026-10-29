/*
 * 瀏覽器版連線：網址帶 ?mode=server 時，透過本機 server.js 的 HTTP API 與事件串流運作，
 * 提供和 Electron 相同的 window.aiOffice 介面。
 */
(function () {
  'use strict';
  if (window.aiOffice) return;
  if (new URLSearchParams(location.search).get('mode') !== 'server') return;

  async function call(name, body) {
    const res = await fetch('/api/' + name, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ai-office': '1' },
      body: JSON.stringify(body === undefined ? null : body),
    });
    if (!res.ok) throw new Error(`連線失敗（${res.status}），請確認 AI 辦公室的黑色視窗還開著`);
    const j = await res.json();
    if (!j.ok) throw new Error(j.error);
    return j.data;
  }

  const listeners = [];
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (_) { return; }
    listeners.forEach((cb) => cb(msg.type, msg.data));
  };

  window.aiOffice = {
    isPreview: false,
    getState: () => call('getState'),
    saveAgents: (a) => call('saveAgents', a),
    saveWorkflows: (w) => call('saveWorkflows', w),
    saveEngines: (e) => call('saveEngines', e),
    saveSettings: (s) => call('saveSettings', s),
    resetConfig: () => call('resetConfig'),
    saveKey: (name, value) => call('saveKey', { name, value }),
    startRun: (workflowId, task) => call('startRun', { workflowId, task }),
    stopRun: () => call('stopRun'),
    testAgent: (id) => call('testAgent', { id }),
    checkUpdate: () => call('checkUpdate'),
    applyUpdate: () => call('applyUpdate'),
    checkCli: () => call('checkCli'),
    openWorkspace: () => call('openWorkspace'),
    openFile: (file) => call('openFile', { file }),
    chooseWorkspace: async () => {
      const p = window.prompt('請輸入工作目錄的完整路徑（不存在會自動建立）：', '');
      if (!p) return call('getState');
      return call('setWorkspace', { path: p.trim() });
    },
    onEvent: (cb) => { listeners.push(cb); return () => listeners.splice(listeners.indexOf(cb), 1); },
  };
})();
