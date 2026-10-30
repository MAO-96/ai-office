/* Electron 版：透過 preload 暴露的單一通道呼叫主程序 */
(function () {
  'use strict';
  if (window.aiOffice || !window.aiOfficeIPC) return;
  const ipc = window.aiOfficeIPC;
  async function call(name, body) {
    const r = await ipc.invoke(name, body === undefined ? null : body);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  }
  window.aiOffice = window.AiOfficeBridge(call, ipc.onEvent, {
    chooseWorkspace: () => call('chooseWorkspace'),
  });
})();
