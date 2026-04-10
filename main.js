const { app, BrowserWindow, Menu, globalShortcut, dialog, shell, ipcMain, protocol, net, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const MediaManager = require('./media-manager');
const BonjourBrowser = require('./bonjour-browser');

const PLAYER_PATH = '/tv';
const CONFIG_FILE = 'config.json';
const CURSOR_HIDE_DELAY = 3000;

let mainWindow = null;
let tray = null;
let kioskMode = false;
let serverUrl = '';
let mediaManager = null;
let bonjourBrowser = null;
let cursorHideTimer = null;
let cursorHidden = false;

protocol.registerSchemesAsPrivileged([
  { scheme: 'local-media', privileges: { bypassCSP: true, stream: true, supportFetchAPI: true } }
]);

function getConfigPath() {
  return path.join(app.getPath('userData'), CONFIG_FILE);
}

function loadConfig() {
  try {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (data.serverUrl) {
        serverUrl = data.serverUrl;
        return true;
      }
    }
  } catch (e) {
    console.error('Failed to load config:', e.message);
  }
  return false;
}

function saveConfig(url) {
  try {
    const configPath = getConfigPath();
    fs.writeFileSync(configPath, JSON.stringify({ serverUrl: url }, null, 2), 'utf-8');
    serverUrl = url;
  } catch (e) {
    console.error('Failed to save config:', e.message);
  }
}

function showSetupPrompt() {
  return new Promise((resolve) => {
    const promptWindow = new BrowserWindow({
      width: 500,
      height: 420,
      resizable: false,
      frame: false,
      backgroundColor: '#0f172a',
      icon: path.join(__dirname, 'icon.png'),
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });

    promptWindow.loadFile(path.join(__dirname, 'prompt.html'));

    const onSubmit = (_event, url) => {
      saveConfig(url);
      promptWindow.close();
      resolve(url);
    };

    ipcMain.once('server-url-submitted', onSubmit);

    promptWindow.on('closed', () => {
      ipcMain.removeListener('server-url-submitted', onSubmit);
      resolve(serverUrl || null);
      if (!serverUrl) {
        app.quit();
      }
    });
  });
}

let cursorHideCssKey = null;

function setupCursorAutoHide() {
  if (!mainWindow) return;

  const showCursor = async () => {
    if (cursorHidden && cursorHideCssKey && mainWindow && !mainWindow.isDestroyed()) {
      try {
        await mainWindow.webContents.removeInsertedCSS(cursorHideCssKey);
      } catch (_) {}
      cursorHideCssKey = null;
      cursorHidden = false;
    }
  };

  const hideCursor = async () => {
    if (!cursorHidden && mainWindow && !mainWindow.isDestroyed()) {
      try {
        cursorHideCssKey = await mainWindow.webContents.insertCSS('html, body, * { cursor: none !important; }');
        cursorHidden = true;
      } catch (_) {}
    }
  };

  const resetCursorTimer = () => {
    showCursor();
    if (cursorHideTimer) clearTimeout(cursorHideTimer);
    cursorHideTimer = setTimeout(hideCursor, CURSOR_HIDE_DELAY);
  };

  mainWindow.webContents.on('cursor-changed', resetCursorTimer);
  ipcMain.on('cursor:activity', resetCursorTimer);

  mainWindow.webContents.on('did-finish-load', resetCursorTimer);
  mainWindow.on('focus', resetCursorTimer);
}

function showRetryOverlay(retrySeconds) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.executeJavaScript(`
    (function() {
      let existing = document.getElementById('__digipal_retry');
      if (existing) existing.remove();
      const div = document.createElement('div');
      div.id = '__digipal_retry';
      div.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:#0f172a;color:#e2e8f0;display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:999999;font-family:system-ui,sans-serif;';
      div.innerHTML = '<div style="text-align:center"><div style="font-size:48px;margin-bottom:16px">⚡</div><h2 style="font-size:24px;margin-bottom:8px">Connection Lost</h2><p style="color:#94a3b8;font-size:16px">Retrying in <span id="__retry_count">${retrySeconds}</span> seconds...</p></div>';
      document.body.appendChild(div);
      let count = ${retrySeconds};
      const interval = setInterval(() => {
        count--;
        const el = document.getElementById('__retry_count');
        if (el) el.textContent = count;
        if (count <= 0) clearInterval(interval);
      }, 1000);
    })();
  `).catch(() => {});
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    fullscreen: true,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  Menu.setApplicationMenu(null);

  const playerUrl = serverUrl + PLAYER_PATH + '?platform=linux';
  mainWindow.loadURL(playerUrl);

  let retryCount = 0;
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error(`Failed to load: ${errorDescription} (${errorCode})`);
    retryCount++;
    const delay = Math.min(5 * retryCount, 30);
    showRetryOverlay(delay);
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log(`Retrying connection (attempt ${retryCount})...`);
        mainWindow.loadURL(playerUrl);
      }
    }, delay * 1000);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    retryCount = 0;
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });

  if (mediaManager) {
    mediaManager.setWebContents(mainWindow.webContents);
  }

  setupCursorAutoHide();

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (kioskMode && input.alt && input.key === 'F4') {
      event.preventDefault();
    }
  });

  globalShortcut.register('F11', () => {
    if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen());
  });

  globalShortcut.register('F5', () => {
    if (mainWindow) mainWindow.webContents.reload();
  });

  globalShortcut.register('Control+Shift+I', () => {
    if (mainWindow) mainWindow.webContents.toggleDevTools();
  });

  globalShortcut.register('Escape', () => {
    if (!kioskMode && mainWindow && mainWindow.isFullScreen()) {
      mainWindow.setFullScreen(false);
    }
  });

  globalShortcut.register('Control+Shift+S', async () => {
    const previousUrl = serverUrl;
    await showSetupPrompt();
    if (serverUrl !== previousUrl && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(serverUrl + PLAYER_PATH + '?platform=linux');
    }
  });

  globalShortcut.register('Control+Alt+K', () => {
    kioskMode = !kioskMode;
    if (mainWindow) {
      if (kioskMode) {
        mainWindow.setFullScreen(true);
        mainWindow.setAlwaysOnTop(true, 'screen-saver');
        mainWindow.setSkipTaskbar(true);
      } else {
        mainWindow.setAlwaysOnTop(false);
        mainWindow.setSkipTaskbar(false);
      }
    }
    updateTray();
  });
}

function createTray() {
  try {
    const iconPath = path.join(__dirname, 'icon.png');
    if (!fs.existsSync(iconPath)) return;
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 22, height: 22 });
    tray = new Tray(icon);
    updateTray();
  } catch (e) {
    console.error('Failed to create tray:', e.message);
  }
}

function updateTray() {
  if (!tray) return;
  const contextMenu = Menu.buildFromTemplate([
    { label: `Digipal Player v${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: `Server: ${serverUrl || 'Not configured'}`, enabled: false },
    { label: `Kiosk: ${kioskMode ? 'ON' : 'OFF'}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Change Server (Ctrl+Shift+S)',
      click: async () => {
        const previousUrl = serverUrl;
        await showSetupPrompt();
        if (serverUrl !== previousUrl && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL(serverUrl + PLAYER_PATH + '?platform=linux');
        }
      }
    },
    {
      label: kioskMode ? 'Exit Kiosk Mode' : 'Enter Kiosk Mode',
      click: () => {
        kioskMode = !kioskMode;
        if (mainWindow) {
          if (kioskMode) {
            mainWindow.setFullScreen(true);
            mainWindow.setAlwaysOnTop(true, 'screen-saver');
            mainWindow.setSkipTaskbar(true);
          } else {
            mainWindow.setAlwaysOnTop(false);
            mainWindow.setSkipTaskbar(false);
          }
        }
        updateTray();
      }
    },
    {
      label: 'Toggle Fullscreen (F11)',
      click: () => {
        if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen());
      }
    },
    {
      label: 'Reload (F5)',
      click: () => {
        if (mainWindow) mainWindow.webContents.reload();
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        kioskMode = false;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(contextMenu);
  tray.setToolTip(`Digipal Player - ${kioskMode ? 'Kiosk Mode' : 'Normal'}`);
}

function setupAutoStart(enabled) {
  const desktopEntry = `[Desktop Entry]
Type=Application
Name=Digipal Player
Exec=digipal-linux-player
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=${enabled}
Comment=Digital Signage Player
`;

  try {
    const autostartDir = path.join(app.getPath('home'), '.config', 'autostart');
    if (!fs.existsSync(autostartDir)) {
      fs.mkdirSync(autostartDir, { recursive: true });
    }
    const desktopFilePath = path.join(autostartDir, 'digipal-player.desktop');
    if (enabled) {
      fs.writeFileSync(desktopFilePath, desktopEntry, 'utf-8');
    } else {
      if (fs.existsSync(desktopFilePath)) {
        fs.unlinkSync(desktopFilePath);
      }
    }
  } catch (e) {
    console.error('Failed to configure auto-start:', e.message);
  }
}

function setupMediaIPC() {
  ipcMain.on('media:download', (event, objectPath, signedUrl) => {
    if (mediaManager) mediaManager.downloadMedia(objectPath, signedUrl);
  });

  ipcMain.on('media:getLocalPath', (event, objectPath) => {
    event.returnValue = mediaManager ? mediaManager.getLocalMediaPath(objectPath) : '';
  });

  ipcMain.on('media:delete', (event, objectPath) => {
    event.returnValue = mediaManager ? mediaManager.deleteMedia(objectPath) : false;
  });

  ipcMain.on('media:deleteAll', (event) => {
    event.returnValue = mediaManager ? mediaManager.deleteAllMedia() : 0;
  });

  ipcMain.on('media:getStorageInfo', (event) => {
    event.returnValue = mediaManager ? mediaManager.getStorageInfo() : '{"usedBytes":0,"freeBytes":0,"totalSpace":0,"totalFiles":0}';
  });

  ipcMain.on('media:clearCache', () => {
    if (mediaManager) mediaManager.deleteAllMedia();
  });

  ipcMain.on('app:setAutoRelaunch', (event, enabled) => {
    app.setLoginItemSettings({ openAtLogin: enabled });
    setupAutoStart(enabled);
  });

  ipcMain.on('app:scheduleRelaunch', () => {
    app.relaunch();
    app.exit(0);
  });

  ipcMain.on('bonjour:getServers', (event) => {
    event.returnValue = bonjourBrowser ? JSON.stringify(bonjourBrowser.getServers()) : '[]';
  });
}

app.on('ready', async () => {
  protocol.handle('local-media', (request) => {
    const filePath = decodeURIComponent(request.url.replace('local-media://', ''));
    const resolvedPath = path.resolve(filePath);
    const mediaRoot = path.join(app.getPath('userData'), 'media');
    const mediaRootSlash = mediaRoot.endsWith('/') ? mediaRoot : mediaRoot + '/';
    if (resolvedPath !== mediaRoot && !resolvedPath.startsWith(mediaRootSlash)) {
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch('file://' + resolvedPath);
  });

  mediaManager = new MediaManager(app.getPath('userData'));
  mediaManager.cleanupOrphans();

  bonjourBrowser = new BonjourBrowser();
  bonjourBrowser.start();

  setupMediaIPC();
  createTray();

  const hasConfig = loadConfig();
  if (!hasConfig) {
    await showSetupPrompt();
  }
  if (serverUrl) {
    createWindow();
  }
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  if (bonjourBrowser) bonjourBrowser.stop();
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on('before-quit', () => {
  kioskMode = false;
  if (bonjourBrowser) bonjourBrowser.stop();
});
