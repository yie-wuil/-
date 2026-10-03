const { app, BrowserWindow, Menu, shell, protocol, net } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

const APP_ID = 'com.shiguangzhou.desktop';
const ROOT = __dirname;
let mainWindow = null;

// 用自定义协议加载页面，使其成为安全上下文：
// 这样 IndexedDB（存附件/音乐）、音频自动播放、通知才能正常工作。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
  }
]);

function registerAppProtocol() {
  protocol.handle('app', function (request) {
    try {
      const u = new URL(request.url);
      let rel = decodeURIComponent(u.pathname);
      if (rel === '/' || rel === '') rel = '/index.html';
      const full = path.normalize(path.join(ROOT, rel));
      if (!full.startsWith(ROOT)) return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(full).toString());
    } catch (e) {
      return new Response('Not Found', { status: 404 });
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1420,
    height: 900,
    minWidth: 880,
    minHeight: 600,
    show: false,
    title: '时光轴 - 日程管理',
    backgroundColor: '#f2f4fa',
    icon: path.join(ROOT, 'build', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadURL('app://local/index.html');

  mainWindow.once('ready-to-show', function () { mainWindow.show(); });

  mainWindow.webContents.setWindowOpenHandler(function (details) {
    if (/^https?:/i.test(details.url)) shell.openExternal(details.url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', function (e, url) {
    if (!url.startsWith('app://')) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.webContents.on('before-input-event', function (event, input) {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') { mainWindow.webContents.toggleDevTools(); event.preventDefault(); }
  });

  mainWindow.on('closed', function () { mainWindow = null; });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', function () {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(function () {
    app.setAppUserModelId(APP_ID);
    registerAppProtocol();
    createWindow();
    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', function () { app.quit(); });
}