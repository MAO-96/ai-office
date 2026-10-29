// 只把必要的操作暴露給畫面，畫面拿不到 Node 或檔案系統。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aiOffice', {
  isPreview: false,
  getState: () => ipcRenderer.invoke('state:get'),
  saveAgents: (agents) => ipcRenderer.invoke('agents:save', agents),
  saveWorkflows: (wfs) => ipcRenderer.invoke('workflows:save', wfs),
  saveEngines: (engines) => ipcRenderer.invoke('engines:save', engines),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  resetConfig: () => ipcRenderer.invoke('config:reset'),
  saveKey: (name, value) => ipcRenderer.invoke('keys:save', { name, value }),
  startRun: (workflowId, task) => ipcRenderer.invoke('run:start', { workflowId, task }),
  stopRun: () => ipcRenderer.invoke('run:stop'),
  testAgent: (id) => ipcRenderer.invoke('agent:test', id),
  checkCli: () => ipcRenderer.invoke('cli:check'),
  openWorkspace: (sub) => ipcRenderer.invoke('workspace:open', sub),
  chooseWorkspace: () => ipcRenderer.invoke('workspace:choose'),
  openFile: (file) => ipcRenderer.invoke('file:open', file),
  onEvent: (cb) => {
    const h = (_e, msg) => cb(msg.type, msg.data);
    ipcRenderer.on('office:event', h);
    return () => ipcRenderer.removeListener('office:event', h);
  },
});
