const {
  app,
  BrowserWindow,
  screen,
  Tray,
  Menu,
  ipcMain,
  dialog,
  globalShortcut,
  clipboard
} = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const readline = require('readline');
const { autoUpdater } = require('electron-updater');
const { DEFAULT_SETTINGS, sanitizeSettings, generatePeerCode } = require('./settings.js');
const { scanSpeciesLibrary } = require('./species.js');

const DEBUG = !!process.env.DP_DEBUG;
const SMOKE_TEST = !!process.env.DP_SMOKE_TEST;
let smokeWindowLoads = 0; // smoke test: windows that finished loading (expect 3)
function debug(...args) {
  if (DEBUG) console.log('[main.js]', ...args);
}

// Reasonable cap so lower-end machines don't melt under unlimited pets.
const MAX_PETS = 20;

let overlayWindow = null;
let settingsWindow = null;
let friendsWindow = null;
let tray = null;

// All persisted settings live in ONE object (schema in settings.js).
let settings = { ...DEFAULT_SETTINGS };
let autoPaused = false; // DND: auto-paused because a fullscreen app has focus
let livePetCount = 0; // authoritative on-screen count, reported by the renderer
let livePets = []; // [{ id, speciesId, isGuest }] per on-screen pet — drives the Remove-Pet picker

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const CHARACTERS_DIR = path.join(__dirname, 'assets', 'Characters');

// Lightweight scan just to list species NAMES for the tray submenu —
// scanSpeciesLibrary() (invoked over IPC) does the full animation scan.
function listSpeciesIds() {
  const ids = [];
  try {
    if (fs.existsSync(CHARACTERS_DIR)) {
      for (const entry of fs.readdirSync(CHARACTERS_DIR, { withFileTypes: true })) {
        if (entry.isDirectory()) ids.push(entry.name);
      }
    }
  } catch (err) {
    console.error('[main.js] Failed to list species:', err);
  }
  if (ids.length === 0) ids.push(DEFAULT_SETTINGS.activePets[0].speciesId);
  return ids;
}

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
      return sanitizeSettings(raw); // clamp/validate everything on the way in
    }
  } catch (err) {
    console.error('[main.js] Failed to load settings, using defaults:', err);
    // settings.json may be partially-written/corrupt — try the rolling .bak
    // before giving up and overwriting the user's old settings.
    try {
      if (fs.existsSync(SETTINGS_PATH + '.bak')) {
        const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH + '.bak', 'utf-8'));
        console.warn('[main.js] Recovered settings from .bak backup.');
        return sanitizeSettings(raw);
      }
    } catch (bakErr) {
      console.error('[main.js] .bak recovery also failed:', bakErr);
    }
  }
  return { ...DEFAULT_SETTINGS };
}

// Atomic-ish write: temp file + rename (avoids truncating settings.json if
// the process dies mid-save), then keep a rolling .bak for corruption recovery.
function saveSettings() {
  const data = JSON.stringify(settings, null, 2);
  const tmpPath = SETTINGS_PATH + '.tmp';
  try {
    fs.writeFileSync(tmpPath, data, 'utf-8');
    try {
      fs.renameSync(tmpPath, SETTINGS_PATH);
    } catch {
      // rename can fail (AV lock, weird permissions) — fall back to direct write
      fs.writeFileSync(SETTINGS_PATH, data, 'utf-8');
    }
    fs.copyFileSync(SETTINGS_PATH, SETTINGS_PATH + '.bak');
  } catch (err) {
    console.error('[main.js] Failed to save settings:', err);
  }
}

// --- Multi-monitor layout, cached. ---
//
// The foreground-watcher readline callback + maybeApplyDnd used to call
// computeVirtualDesktop() every 250ms, doing a full screen.getAllDisplays()
// + bounding-box pass per CSV line. It's now cached and only invalidated when
// a display is added/removed/rearranged.
let virtualDesktopCache = null;

function buildVirtualDesktop() {
  const displays = screen.getAllDisplays();

  // Bounding box that contains every connected monitor.
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
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

// Cached accessor — cheap to call from high-frequency paths (foreground
// watcher runs every 250ms). Invalidated via invalidateDisplayCache().
function computeVirtualDesktop() {
  if (!virtualDesktopCache) virtualDesktopCache = buildVirtualDesktop();
  return virtualDesktopCache;
}

function invalidateDisplayCache() {
  virtualDesktopCache = null;
}

// --- Foreground-window watcher (powershell child process) ---
//
// Powers the two "desktop-aware" features:
//   * Walk on window edges  — pets use the focused window's top edge as their floor
//   * DND auto-pause        — fullscreen apps (videos, games, presentations) auto-pause pets
//
// Electron has no API for reading *other* apps' window rectangles, so we run a
// single persistent powershell.exe that samples the OS foreground window bounds
// (DPI-scaled to DIPs) every 250ms and prints one CSV line per sample. One long-
// lived process beats spawning powershell hundreds of times per minute. It is
// only started when at least one of the two features above is enabled.
//
// Crash-recovery: if the child process dies for any reason (crash, resource
// exhaustion), the 'exit' handler restarts it automatically, so DND and
// walk-on-borders never silently stop working.

const FOREGROUND_PS_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
$code='using System; using System.Runtime.InteropServices; using System.Text;
public class W32G {
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr h, StringBuilder b, int n);
[DllImport("user32.dll")] public static extern int GetDpiForWindow(IntPtr h);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; } }'
Add-Type -TypeDefinition $code -Language CSharp
$excludePid = [int]$env:DP_EXCLUDE_PID
while($true){
  $line=""
  try{
    $h=[W32G]::GetForegroundWindow()
    if($h -ne [IntPtr]::Zero -and -not [W32G]::IsIconic($h)){
      $wp=[uint32]0
      [void][W32G]::GetWindowThreadProcessId($h,[ref]$wp)
      if($wp -ne $excludePid){
        $sb=New-Object System.Text.StringBuilder 256
        [void][W32G]::GetClassNameW($h,$sb,256)
        $cls=$sb.ToString()
        if($cls -ne "Progman" -and $cls -ne "Shell_TrayWnd"){
          $r=New-Object W32G+RECT
          if([W32G]::GetWindowRect($h,[ref]$r)){
            $dpi=[W32G]::GetDpiForWindow($h)
            if($dpi -le 0){$dpi=96}
            $sc=$dpi/96.0
            if(($r.R-$r.L) -gt 0 -and ($r.B-$r.T) -gt 0){
              $line=("{0},{1},{2},{3},{4}" -f [int]([Math]::Round($r.L/$sc)),[int]([Math]::Round($r.T/$sc)),[int]([Math]::Round(($r.R-$r.L)/$sc)),[int]([Math]::Round(($r.B-$r.T)/$sc)),$dpi)
            }
          }
        }
      }
    }
  }catch{}
  $line
  Start-Sleep -Milliseconds 250
}`;

let foregroundWatcher = null;
let foregroundWindow = null; // { x, y, width, height } in local DIP coords, or null
let watcherGeneration = 0; // lets the exit handler ignore sessions we killed on purpose

function startForegroundWatcher() {
  if (foregroundWatcher) return;
  foregroundWindow = null;
  const gen = ++watcherGeneration;

  const ps = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand',
      Buffer.from(FOREGROUND_PS_SCRIPT, 'utf16le').toString('base64')
    ],
    { env: { ...process.env, DP_EXCLUDE_PID: String(process.pid) } }
  );

  const rl = readline.createInterface({ input: ps.stdout });
  rl.on('line', raw => {
    const m = /^(-?\d+),(-?\d+),(\d+),(\d+),\d+$/.exec(raw.trim());
    if (m) {
      foregroundWindow = {
        x: Number(m[1]) - computeVirtualDesktop().virtualBounds.x,
        y: Number(m[2]) - computeVirtualDesktop().virtualBounds.y,
        width: Number(m[3]),
        height: Number(m[4])
      };
    } else {
      foregroundWindow = null;
    }
    if (overlayWindow) overlayWindow.webContents.send('foreground-window', foregroundWindow);
    maybeApplyDnd();
  });
  ps.stderr.on('data', d => {
    if (DEBUG) console.error('[main.js] foreground watcher stderr:', String(d));
  });
  ps.on('exit', () => {
    if (foregroundWatcher === ps) foregroundWatcher = null;
    foregroundWindow = null;
    // Auto-restart on crash — unless this is the session we intentionally
    // stopped (generation mismatch means a newer stop/start superseded it).
    if (gen === watcherGeneration) updateForegroundWatcher();
  });

  foregroundWatcher = ps;
  debug('Foreground watcher started.');
}

function updateForegroundWatcher() {
  const needed = settings.dndEnabled || settings.walkOnBorders;
  if (needed && !foregroundWatcher) {
    startForegroundWatcher();
  } else if (!needed && foregroundWatcher) {
    watcherGeneration++; // suppress the exit handler's auto-restart
    try {
      foregroundWatcher.kill();
    } catch {
      /* already gone */
    }
    foregroundWatcher = null;
    foregroundWindow = null;
  }
}

function effectivePaused() {
  return settings.isPaused || autoPaused;
}

function pushPauseState() {
  if (overlayWindow) overlayWindow.webContents.send('set-paused', effectivePaused());
}

// If a foreground window covers one display entirely, treat it as fullscreen
// (movie/game/presentation) and auto-pause pets so they don't distract.
function maybeApplyDnd() {
  if (!settings.dndEnabled || !foregroundWindow) {
    setAutoPaused(false);
    return;
  }
  const { displayInfo } = computeVirtualDesktop();
  const fw = foregroundWindow;
  const TOL = 40; // DIPs of tolerance for resize edges / rounded corners
  const isFullscreen = displayInfo.some(
    d =>
      Math.abs(fw.x - d.x) < TOL &&
      Math.abs(fw.y - d.y) < TOL &&
      Math.abs(fw.width - d.width) < TOL &&
      Math.abs(fw.height - d.height) < TOL
  );
  setAutoPaused(isFullscreen);
}

function setAutoPaused(v) {
  if (autoPaused === v) return;
  autoPaused = v;
  pushPauseState();
  refreshTrayMenu();
}

// Controls whether pets float above every app window ("show in all apps")
// or stay on the desktop behind other windows ("only on the homescreen").
function applyShowOverApps() {
  if (!overlayWindow) return;
  if (settings.showOverApps) {
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  } else {
    overlayWindow.setAlwaysOnTop(false);
  }
}

// Auto-start the app at Windows login. Toggle-able from the Settings window.
function applyAutoLaunch() {
  if (process.platform !== 'win32') return;
  try {
    app.setLoginItemSettings({ openAtLogin: settings.autoLaunch });
  } catch (err) {
    console.error('[main.js] Failed to set login item:', err);
  }
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
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.loadFile('index.html');

  overlayWindow.webContents.once('did-finish-load', () => {
    if (SMOKE_TEST) smokeWindowLoads++;
    overlayWindow.webContents.send('display-info', displayInfo);
    overlayWindow.webContents.send('restore-settings', {
      ...settings,
      maxPets: MAX_PETS
    });
    // Re-assert the effective pause state: if autoPaused (DND) already flipped
    // before the renderer finished loading, the earlier send was lost.
    pushPauseState();
    applyShowOverApps();
    debug('Overlay loaded. activePets =', JSON.stringify(settings.activePets));
  });

  // Renderer console forwarding — for smoke/Debug runs only (DP_DEBUG).
  // Newer Electron passes a single event object; handle both shapes.
  overlayWindow.webContents.on('console-message', (...args) => {
    const first = args[0];
    const msg =
      first && typeof first === 'object' && typeof first.message === 'string'
        ? first.message
        : typeof args[1] === 'string'
          ? args[1]
          : '';
    if (msg) console.log('[renderer]', msg);
  });
}

// Attach the same DEBUG console forwarding to the other windows.
function forwardConsole(win, label) {
  if (!win || !DEBUG) return;
  win.webContents.on('console-message', (...args) => {
    const first = args[0];
    const msg =
      first && typeof first === 'object' && typeof first.message === 'string'
        ? first.message
        : typeof args[1] === 'string'
          ? args[1]
          : '';
    if (msg) console.log(`[${label}]`, msg);
  });
}

// If monitors are connected/disconnected/rearranged while running, resize
// the overlay window to match and let the renderer know the new layout.
// (Existing pets simply keep their current x/y — they'll be re-clamped
// to the new bounds next time they move.)
function handleDisplayChange() {
  invalidateDisplayCache();
  if (!overlayWindow) return;
  const { virtualBounds, displayInfo } = computeVirtualDesktop();
  overlayWindow.setBounds(virtualBounds);
  overlayWindow.webContents.send('display-info', displayInfo);
  maybeApplyDnd();
}

function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 320,
    height: 620,
    resizable: false,
    title: 'Desktop Pets — Settings',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  settingsWindow.setMenu(null);
  settingsWindow.loadFile('settings.html');
  forwardConsole(settingsWindow, 'settings');
  settingsWindow.webContents.once('did-finish-load', () => {
    if (SMOKE_TEST) smokeWindowLoads++;
    pushSettingsValues();
  });
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

function pushSettingsValues() {
  if (!settingsWindow) return;
  settingsWindow.webContents.send('init-settings-values', {
    sizePercent: settings.sizePercent,
    speedPercent: settings.speedPercent,
    isMuted: settings.isMuted,
    masterVolume: settings.masterVolume,
    autoLaunch: settings.autoLaunch,
    dndEnabled: settings.dndEnabled,
    walkOnBorders: settings.walkOnBorders,
    reduceMotion: settings.reduceMotion,
    highContrast: settings.highContrast,
    largerSprites: settings.largerSprites,
    showOverApps: settings.showOverApps,
    activePets: settings.activePets,
    livePetCount,
    livePets
  });
}

// Live roster updates pushed to the Settings window as pets come and go.
function pushSettingsRoster() {
  if (!settingsWindow) return;
  settingsWindow.webContents.send('settings-roster-update', {
    activePets: settings.activePets,
    livePetCount,
    livePets
  });
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  friendsWindow.setMenu(null);
  friendsWindow.loadFile('friends.html');
  forwardConsole(friendsWindow, 'friends');
  friendsWindow.webContents.once('did-finish-load', () => {
    if (SMOKE_TEST) smokeWindowLoads++;
  });
  friendsWindow.on('closed', () => {
    friendsWindow = null;
  });
}

function setupAutoUpdater() {
  // Auto-update only makes sense in a real packaged install — running via
  // `electron .` in dev has no update feed and would just log noisy errors.
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = false; // ask before downloading, not just before installing

  autoUpdater.on('update-available', info => {
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

  autoUpdater.on('error', err => {
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
  if (!tray) return;
  debug('refreshTrayMenu — activePets.length =', JSON.stringify(settings.activePets));
  const speciesIds = listSpeciesIds();

  const atPetCap = livePetCount >= MAX_PETS;
  const addPetSubmenu = speciesIds.map(speciesId => ({
    label: speciesId,
    click: () => {
      if (overlayWindow) overlayWindow.webContents.send('add-pet', speciesId);
      // Tray/settings update happens when the renderer reports the new
      // roster snapshot via 'pets-changed' — not here — so the count
      // never gets out of sync with what's actually on screen.
    }
  }));

  const contextMenu = Menu.buildFromTemplate([
    { label: `Pets: ${livePetCount}${atPetCap ? ' (max)' : ''}`, enabled: false },
    { type: 'separator' },
    {
      label: atPetCap ? 'Add Pet (max reached)' : 'Add Pet',
      enabled: !atPetCap,
      submenu: addPetSubmenu
    },
    {
      label: 'Remove Pet',
      enabled: livePets.length > 0,
      // Pick which pet to remove — one entry per on-screen pet (each shows a
      // guest marker if it's visiting from a friend).
      submenu: livePets.map(p => ({
        label: `${p.isGuest ? '♦ ' : ''}${p.speciesId} #${p.id}`,
        click: () => {
          if (overlayWindow) overlayWindow.webContents.send('remove-pet', p.id);
        }
      }))
    },
    { type: 'separator' },
    {
      label: effectivePaused() ? 'Resume' : 'Pause',
      click: () => togglePauseFromMain()
    },
    {
      label: settings.isMuted ? 'Unmute' : 'Mute',
      click: () => toggleMuteFromMain()
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

function togglePauseFromMain() {
  settings.isPaused = !settings.isPaused;
  pushPauseState();
  refreshTrayMenu();
  saveSettings();
}

function toggleMuteFromMain() {
  settings.isMuted = !settings.isMuted;
  if (overlayWindow)
    overlayWindow.webContents.send('apply-settings', { isMuted: settings.isMuted });
  refreshTrayMenu();
  saveSettings();
}

// Apply a fully-sanitized settings object, running whatever side effects the
// changed values imply. Used by load, settings-changed, and the tray toggles.
// Broadcast the renderer-relevant subset of a settings change to the overlay
// window. Without this, Settings-window slider/toggle changes would only be
// sanitized + saved by main and never actually reach the pets.
function pushApplySettings() {
  if (!overlayWindow) return;
  overlayWindow.webContents.send('apply-settings', {
    isMuted: settings.isMuted,
    masterVolume: settings.masterVolume,
    sizePercent: settings.sizePercent,
    speedPercent: settings.speedPercent,
    reduceMotion: settings.reduceMotion,
    largerSprites: settings.largerSprites,
    walkOnBorders: settings.walkOnBorders,
    highContrast: settings.highContrast,
    showOverApps: settings.showOverApps
  });
}

function applySettingsState(next) {
  settings = next;
  applyAutoLaunch();
  applyShowOverApps();
  updateForegroundWatcher();
  refreshTrayMenu();
  saveSettings();
  pushPauseState();
  pushApplySettings();
  debug('Settings applied:', JSON.stringify(settings));
}

app.whenReady().then(() => {
  // Single-instance lock: a second `electron .` / double-click of the exe must
  // not spawn a duplicate instance (it stole the peer code and caused the
  // historical "pet count looks wrong" symptom). The second launch just focuses
  // the existing overlay instead.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (overlayWindow) {
      if (overlayWindow.isMinimized()) overlayWindow.restore();
      overlayWindow.focus();
    }
  });

  settings = loadSettings();
  if (!settings.myPeerCode) {
    settings.myPeerCode = generatePeerCode();
    debug('Generated fresh peer code:', settings.myPeerCode);
  }

  // Prune any retired/unknown species from the saved roster (e.g. the old
  // Swordsman assets no longer exist on disk) — otherwise a stale speciesId
  // would silently fail to spawn while still being counted.
  const validSpecies = new Set(listSpeciesIds());
  settings.activePets = settings.activePets.filter(p => validSpecies.has(p.speciesId));
  if (settings.activePets.length === 0) settings.activePets = [...DEFAULT_SETTINGS.activePets];
  livePetCount = settings.activePets.length;

  saveSettings(); // persist freshly-generated code + pruned roster immediately
  debug('Loaded settings. activePets =', JSON.stringify(settings.activePets));

  createOverlayWindow();
  createTray();
  applyAutoLaunch();
  setupAutoUpdater();
  updateForegroundWatcher();

  const pauseShortcutOk = globalShortcut.register('CommandOrControl+Alt+P', togglePauseFromMain);
  debug('Global pause shortcut (Ctrl+Alt+P) registered:', pauseShortcutOk);
  const muteShortcutOk = globalShortcut.register('CommandOrControl+Alt+M', toggleMuteFromMain);
  debug('Global mute shortcut (Ctrl+Alt+M) registered:', muteShortcutOk);

  screen.on('display-added', handleDisplayChange);
  screen.on('display-removed', handleDisplayChange);
  screen.on('display-metrics-changed', handleDisplayChange);

  // Center of the settings relay: runner-up values come from the renderer.
  // Everything is re-sanitized against the schema, so slider garbage or a
  // tampered payload can never corrupt in-memory state.
  ipcMain.on('settings-changed', (event, changes) => {
    if (!changes || typeof changes !== 'object') return;
    // Merge the partial change over the current state, then sanitize the whole
    // thing. This is what clamps maliciously-large/negative values that might
    // otherwise OOM the canvas or make pets invisible.
    const next = sanitizeSettings({ ...settings, ...changes });
    applySettingsState(next);
  });

  // The renderer is the source of truth for the pet roster. A full snapshot
  // per change (instead of incremental adds/removes) eliminates the tray-count
  // desync (#1 in PROJECT-STATUS.md).
  ipcMain.on('pets-changed', (event, snapshot = {}) => {
    const raw = Array.isArray(snapshot.species) ? snapshot.species : [];
    const profiles = [];
    for (const entry of raw) {
      let speciesId = '';
      let name = null;
      let x = null;
      if (typeof entry === 'string') {
        speciesId = entry;
      } else if (entry && typeof entry === 'object' && typeof entry.speciesId === 'string') {
        speciesId = entry.speciesId;
        if (typeof entry.name === 'string' && entry.name) name = entry.name.slice(0, 40);
        if (typeof entry.x === 'number' && Number.isFinite(entry.x)) x = entry.x;
      }
      if (!speciesId || speciesId.length > 64) continue;
      const prof = { speciesId };
      if (name) prof.name = name;
      if (x != null) prof.x = x;
      profiles.push(prof);
    }

    const count =
      typeof snapshot.count === 'number' && Number.isFinite(snapshot.count)
        ? Math.max(0, Math.floor(snapshot.count))
        : profiles.length;
    const pets = Array.isArray(snapshot.pets)
      ? snapshot.pets
          .filter(p => p && typeof p.id === 'number')
          .map(p => ({
            id: p.id,
            speciesId: typeof p.speciesId === 'string' ? p.speciesId : '?',
            isGuest: !!p.isGuest
          }))
      : [];

    settings.activePets = profiles.length > 0 ? profiles : [...DEFAULT_SETTINGS.activePets];
    livePetCount = count;
    livePets = pets;
    refreshTrayMenu();
    saveSettings();
    pushSettingsRoster();
  });

  // --- P2P Friends: overlayWindow owns the real Peer/connection logic;
  // friendsWindow is just a control panel. main.js relays between them
  // since separate renderer processes can't talk to each other directly. ---

  ipcMain.on('friends:connect-request', (event, code) => {
    if (overlayWindow) overlayWindow.webContents.send('friends:connect-request', code);
  });
  ipcMain.on('friends:disconnect-request', () => {
    if (overlayWindow) overlayWindow.webContents.send('friends:disconnect-request');
  });
  ipcMain.on('friends:recall-request', (event, migrationId) => {
    if (overlayWindow) overlayWindow.webContents.send('friends:recall-request', migrationId);
  });
  ipcMain.on('friends:send-home-request', (event, migrationId) => {
    if (overlayWindow) overlayWindow.webContents.send('friends:send-home-request', migrationId);
  });
  ipcMain.on('friends:request-status', () => {
    if (overlayWindow) overlayWindow.webContents.send('friends:request-status');
  });
  // overlay -> main -> friends window (status changed / pet lists changed)
  ipcMain.on('friends:status-update', (event, status) => {
    if (friendsWindow) friendsWindow.webContents.send('friends:status-update', status);
  });

  // Native OS consent dialog — used both for "accept this friend connection?"
  // and "accept this incoming visiting pet?" prompts.
  ipcMain.handle('show-confirm-dialog', (event, { title, message } = {}) => {
    const result = dialog.showMessageBoxSync(overlayWindow, {
      type: 'question',
      buttons: ['Accept', 'Decline'],
      defaultId: 0,
      cancelId: 1,
      title: typeof title === 'string' ? title : 'Confirm',
      message: typeof message === 'string' ? message : ''
    });
    return result === 0;
  });

  // Species library scan for the (isolated) renderer — fs lives in main now.
  ipcMain.handle('species:scan', () => scanSpeciesLibrary());

  // Fresh cryptographically-secure friend code, requested by the renderer
  // when its Peer ID was taken on the signaling server.
  ipcMain.handle('generate-peer-code', () => generatePeerCode());

  // Copy a friend code to the system clipboard on behalf of the Friends
  // window — navigator.clipboard isn't available on file:// pages.
  ipcMain.on('copy-to-clipboard', (event, text) => {
    clipboard.writeText(typeof text === 'string' ? text.slice(0, 64) : '');
  });

  // The renderer hit-tests the cursor against pet bounding boxes on every
  // mousemove (received even while click-through, thanks to {forward:true})
  // and tells us to flip click-through off only while hovering a pet — so the
  // desktop underneath stays fully clickable everywhere else.
  ipcMain.on('set-mouse-ignore', (event, ignore) => {
    overlayWindow.setIgnoreMouseEvents(!!ignore, { forward: true });
  });

  // Smoke-test harness support: boot up, then quit so a CI/console runner can
  // capture logs and exit cleanly. The forced-exit fallback covers cases where
  // window-all-closed preventDefault interferes with the graceful quit.
  if (SMOKE_TEST) {
    console.log('[main.js] SMOKE_TEST — booting, will auto-quit in 10s.');
    setTimeout(() => {
      console.log('[main.js] SMOKE_TEST — opening Settings + Friends windows.');
      createSettingsWindow();
      createFriendsWindow();
    }, 1500);
    setTimeout(() => {
      console.log('[main.js] SMOKE_TEST — windows loaded:', smokeWindowLoads);
      const ok = smokeWindowLoads === 3;
      console.log(`[main.js] SMOKE_TEST — ${ok ? 'PASS' : 'FAIL'} (expected 3 windows).`);
      app.quit();
      setTimeout(() => {
        console.log('[main.js] SMOKE_TEST — forced exit.');
        process.exit(ok ? 0 : 1);
      }, 2000);
    }, 10000);
  }
});

app.on('window-all-closed', e => {
  e.preventDefault(); // stay alive in tray
});

app.on('will-quit', () => {
  if (foregroundWatcher) {
    watcherGeneration++;
    try {
      foregroundWatcher.kill();
    } catch {
      /* already gone */
    }
    foregroundWatcher = null;
  }
  globalShortcut.unregisterAll();
});

app.on('before-quit', () => {
  saveSettings();
});
