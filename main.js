const { app, BrowserWindow, screen, Tray, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

let overlayWindow = null;
let settingsWindow = null;
let friendsWindow = null;
let tray = null;
let isPaused = false;
let activePets = [];    // array of speciesId strings, one per active pet
let sizePercent = 100;
let speedPercent = 100;
let isMuted = true;
let masterVolume = 0.5;
let myPeerCode = null; // persisted short "friend code" for P2P — generated once, reused across launches

function generatePeerCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — avoids ambiguity
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const CHARACTERS_DIR = path.join(__dirname, 'assets', 'Characters');
const FALLBACK_SPECIES_ID = 'Swordsman';

const DEFAULT_SETTINGS = {
  activePets: [FALLBACK_SPECIES_ID],
  isPaused: false,
  sizePercent: 100,
  speedPercent: 100,
  isMuted: true,
  masterVolume: 0.5,
  myPeerCode: null
};

// Lightweight scan just to list species NAMES for the tray submenu —
// species.js (in the renderer) does the real per-animation frame scan.
function listSpeciesIds() {
  const ids = [];
  if (fs.existsSync(CHARACTERS_DIR)) {
    for (const entry of fs.readdirSync(CHARACTERS_DIR, { withFileTypes: true })) {
      if (entry.isDirectory()) ids.push(entry.name);
    }
  }
  if (ids.length === 0) ids.push(FALLBACK_SPECIES_ID);
  return ids;
}

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
      const saved = JSON.parse(raw);
      return { ...DEFAULT_SETTINGS, ...saved };
    }
  } catch (err) {
    console.error('Failed to load settings, using defaults:', err);
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings() {
  const data = { activePets, isPaused, sizePercent, speedPercent, isMuted, masterVolume, myPeerCode };
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save settings:', err);
  }
}

function computeVirtualDesktop() {
  const displays = screen.getAllDisplays();

  // Bounding box that contains every connected monitor.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const d of displays) {
    minX = Math.min(minX, d.bounds.x);
    minY = Math.min(minY, d.bounds.y);
    maxX = Math.max(maxX, d.bounds.x + d.bounds.width);
    maxY = Math.max(maxY, d.bounds.y + d.bounds.height);
  }

  const virtualBounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };

  // Re-express each display's bounds/workArea relative to the virtual
  // window's top-left corner, so the renderer can work in simple local
  // canvas coordinates instead of raw OS screen coordinates.
  const displayInfo = displays.map(d => ({
    id: d.id,
    x: d.bounds.x - minX,
    y: d.bounds.y - minY,
    width: d.bounds.width,
    height: d.bounds.height,
    workAreaX: d.workArea.x - minX,
    workAreaY: d.workArea.y - minY,
    workAreaWidth: d.workArea.width,
    workAreaHeight: d.workArea.height
  }));

  return { virtualBounds, displayInfo };
}

function createOverlayWindow() {
  const { virtualBounds, displayInfo } = computeVirtualDesktop();

  overlayWindow = new BrowserWindow({
    width: virtualBounds.width,
    height: virtualBounds.height,
    x: virtualBounds.x,
    y: virtualBounds.y,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    hasShadow: false,
    skipTaskbar: true,
    resizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.loadFile('index.html');

  overlayWindow.webContents.once('did-finish-load', () => {
    overlayWindow.webContents.send('display-info', displayInfo);
    overlayWindow.webContents.send('restore-settings', {
      activePets, isPaused, sizePercent, speedPercent, isMuted, masterVolume, myPeerCode
    });
  });
}

// If monitors are connected/disconnected/rearranged while running, resize
// the overlay window to match and let the renderer know the new layout.
// (Existing pets simply keep their current x/y — they'll be re-clamped
// to the new bounds next time they move.)
function handleDisplayChange() {
  if (!overlayWindow) return;
  const { virtualBounds, displayInfo } = computeVirtualDesktop();
  overlayWindow.setBounds(virtualBounds);
  overlayWindow.webContents.send('display-info', displayInfo);
}

function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 320,
    height: 260,
    resizable: false,
    title: 'Desktop Pets — Settings',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  settingsWindow.setMenu(null);
  settingsWindow.loadFile('settings.html');
  settingsWindow.webContents.once('did-finish-load', () => {
    settingsWindow.webContents.send('init-settings-values', { sizePercent, speedPercent, isMuted, masterVolume });
  });
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

function createFriendsWindow() {
  if (friendsWindow) {
    friendsWindow.focus();
    return;
  }
  friendsWindow = new BrowserWindow({
    width: 320,
    height: 480,
    resizable: false,
    title: 'Desktop Pets — Friends',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  friendsWindow.setMenu(null);
  friendsWindow.loadFile('friends.html');
  friendsWindow.on('closed', () => { friendsWindow = null; });
}

function setupAutoUpdater() {
  // Auto-update only makes sense in a real packaged install — running via
  // `electron .` in dev has no update feed and would just log noisy errors.
  if (!app.isPackaged) {
    console.log('[main.js] Skipping auto-update check (not a packaged build).');
    return;
  }

  autoUpdater.autoDownload = false; // ask before downloading, not just before installing

  autoUpdater.on('update-available', (info) => {
    const wantsUpdate = dialog.showMessageBoxSync(overlayWindow, {
      type: 'info',
      buttons: ['Download', 'Later'],
      defaultId: 0,
      title: 'Update Available',
      message: `Desktop Pets ${info.version} is available (you have ${app.getVersion()}). Download it now?`
    });
    if (wantsUpdate === 0) autoUpdater.downloadUpdate();
  });

  autoUpdater.on('update-downloaded', () => {
    const wantsRestart = dialog.showMessageBoxSync(overlayWindow, {
      type: 'info',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      title: 'Update Ready',
      message: 'The update has been downloaded. Restart now to install it?'
    });
    if (wantsRestart === 0) autoUpdater.quitAndInstall();
  });

  autoUpdater.on('error', (err) => {
    console.error('[main.js] Auto-update error:', err);
  });

  autoUpdater.checkForUpdates();
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  tray = new Tray(iconPath);
  tray.setToolTip('Desktop Pets');
  refreshTrayMenu();
}

function refreshTrayMenu() {
  console.log('[main.js] refreshTrayMenu — activePets.length =', activePets.length, JSON.stringify(activePets));
  const speciesIds = listSpeciesIds();

  const addPetSubmenu = speciesIds.map(speciesId => ({
    label: speciesId,
    click: () => {
      overlayWindow.webContents.send('add-pet', speciesId);
      // Tray/settings update happens when the renderer confirms via
      // the 'pet-added' IPC message — not here — so the count never
      // gets out of sync with what's actually on screen.
    }
  }));

  const contextMenu = Menu.buildFromTemplate([
    { label: `Pets: ${activePets.length}`, enabled: false },
    { type: 'separator' },
    { label: 'Add Pet', submenu: addPetSubmenu },
    {
      label: 'Remove Pet',
      enabled: activePets.length > 0,
      click: () => {
        if (activePets.length > 0) {
          overlayWindow.webContents.send('remove-pet');
          // Tray/settings update happens when the renderer confirms via
          // the 'pet-removed' IPC message — not here.
        }
      }
    },
    { type: 'separator' },
    {
      label: isPaused ? 'Resume' : 'Pause',
      click: () => {
        isPaused = !isPaused;
        overlayWindow.webContents.send('set-paused', isPaused);
        refreshTrayMenu();
        saveSettings();
      }
    },
    {
      label: isMuted ? 'Unmute' : 'Mute',
      click: () => {
        isMuted = !isMuted;
        overlayWindow.webContents.send('apply-settings', { isMuted });
        refreshTrayMenu();
        saveSettings();
      }
    },
    { type: 'separator' },
    { label: 'Settings...', click: () => createSettingsWindow() },
    { label: 'Friends...', click: () => createFriendsWindow() },
    {
      label: 'Check for Updates...',
      click: () => {
        if (app.isPackaged) {
          autoUpdater.checkForUpdates();
        } else {
          dialog.showMessageBoxSync(overlayWindow, {
            type: 'info',
            title: 'Check for Updates',
            message: 'Update checks only work in an installed build, not this dev version.'
          });
        }
      }
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);

  tray.setContextMenu(contextMenu);
}

app.whenReady().then(() => {
  const settings = loadSettings();
  activePets = settings.activePets;
  isPaused = settings.isPaused;
  sizePercent = settings.sizePercent;
  speedPercent = settings.speedPercent;
  isMuted = settings.isMuted;
  masterVolume = settings.masterVolume;
  myPeerCode = settings.myPeerCode || generatePeerCode();
  saveSettings(); // persist a freshly-generated code immediately

  console.log('[main.js] Loaded settings. activePets =', JSON.stringify(activePets));

  createOverlayWindow();
  createTray();
  setupAutoUpdater();

  screen.on('display-added', handleDisplayChange);
  screen.on('display-removed', handleDisplayChange);
  screen.on('display-metrics-changed', handleDisplayChange);

  ipcMain.on('settings-changed', (event, changes) => {
    if (changes.sizePercent !== undefined) sizePercent = changes.sizePercent;
    if (changes.speedPercent !== undefined) speedPercent = changes.speedPercent;
    if (changes.isMuted !== undefined) isMuted = changes.isMuted;
    if (changes.masterVolume !== undefined) masterVolume = changes.masterVolume;

    overlayWindow.webContents.send('apply-settings', { sizePercent, speedPercent, isMuted, masterVolume });
    refreshTrayMenu();
    saveSettings();
  });

  ipcMain.on('pet-added', (event, speciesId) => {
    console.log('[main.js] Received pet-added for:', speciesId, '(activePets before:', JSON.stringify(activePets), ')');
    activePets.push(speciesId);
    console.log('[main.js] activePets after push:', JSON.stringify(activePets));
    refreshTrayMenu();
    saveSettings();
  });

  ipcMain.on('pet-removed', () => {
    console.log('[main.js] Received pet-removed (activePets before:', JSON.stringify(activePets), ')');
    if (activePets.length > 0) activePets.pop();
    console.log('[main.js] activePets after pop:', JSON.stringify(activePets));
    refreshTrayMenu();
    saveSettings();
  });

  // --- P2P Friends: overlayWindow owns the real Peer/connection logic;
  // friendsWindow is just a control panel. main.js relays between them
  // since separate renderer processes can't talk to each other directly. ---

  ipcMain.on('friends:connect-request', (event, code) => {
    overlayWindow.webContents.send('friends:connect-request', code);
  });
  ipcMain.on('friends:disconnect-request', () => {
    overlayWindow.webContents.send('friends:disconnect-request');
  });
  ipcMain.on('friends:recall-request', (event, migrationId) => {
    overlayWindow.webContents.send('friends:recall-request', migrationId);
  });
  ipcMain.on('friends:send-home-request', (event, migrationId) => {
    overlayWindow.webContents.send('friends:send-home-request', migrationId);
  });
  ipcMain.on('friends:request-status', () => {
    overlayWindow.webContents.send('friends:request-status');
  });
  // overlay -> main -> friends window (status changed / pet lists changed)
  ipcMain.on('friends:status-update', (event, status) => {
    if (friendsWindow) friendsWindow.webContents.send('friends:status-update', status);
  });

  // Native OS consent dialog — used both for "accept this friend
  // connection?" and "accept this incoming visiting pet?" prompts.
  ipcMain.handle('show-confirm-dialog', (event, { title, message }) => {
    const result = dialog.showMessageBoxSync(overlayWindow, {
      type: 'question',
      buttons: ['Accept', 'Decline'],
      defaultId: 0,
      cancelId: 1,
      title,
      message
    });
    return result === 0;
  });

  // The renderer hit-tests the cursor against pet bounding boxes on every
  // mousemove (received even while click-through, thanks to {forward:true}
  // below) and tells us to flip click-through off only while hovering a
  // pet — so the desktop underneath stays fully clickable everywhere else.
  ipcMain.on('set-mouse-ignore', (event, ignore) => {
    overlayWindow.setIgnoreMouseEvents(ignore, { forward: true });
  });
});

app.on('window-all-closed', (e) => {
  e.preventDefault(); // stay alive in tray
});

app.on('before-quit', () => {
  saveSettings();
});