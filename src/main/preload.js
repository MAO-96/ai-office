// 只暴露一個呼叫通道與事件訂閱給畫面，畫面拿不到 Node 或檔案系統。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aiOfficeIPC', {
  invoke: (name, body) => ipcRenderer.invoke('api', { name, body }),
  onEvent: (cb) => {
    const h = (_e, msg) => cb(msg.type, msg.data);
    ipcRenderer.on('office:event', h);
    return () => ipcRenderer.removeListener('office:event', h);
  },
});
