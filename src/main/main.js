// Electron 主程序：建立視窗，把畫面的 IPC 請求轉給共用服務層。
const path = require('path');
const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage } = require('electron');
const { createService } = require('./service');
const { buildApi } = require('./api');

const ROOT = path.join(__dirname, '..', '..');
let win = null;
let svc = null;

function send(type, data) {
  if (win && !win.isDestroyed()) win.webContents.send('office:event', { type, data });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#1a1410',
    title: 'AI 辦公室',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

function registerIpc() {
  const api = {
    ...buildApi(svc),
    chooseWorkspace: async () => {
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled || !r.filePaths[0]) return svc.getState();
      return svc.setWorkspace(r.filePaths[0]);
    },
  };
  ipcMain.handle('api', async (_e, { name, body }) => {
    const fn = api[name];
    if (!fn) return { ok: false, error: `不支援的操作：${name}` };
    try { return { ok: true, data: await fn(body) }; } catch (e) { return { ok: false, error: e.message || String(e) }; }
  });
}

app.whenReady().then(() => {
  svc = createService({
    userDataDir: app.getPath('userData'),
    defaultsDir: path.join(ROOT, 'config'),
    crypto: {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
      decrypt: (b) => safeStorage.decryptString(Buffer.from(b, 'base64')),
    },
    openPath: (p) => shell.openPath(p),
    emit: send,
  });
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (svc) svc.stopRun();
  if (process.platform !== 'darwin') app.quit();
});
