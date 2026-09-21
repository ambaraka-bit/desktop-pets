// settings-renderer.js — Settings window (contextIsolation build).
//
// Runs in the isolated main world: no require(), no ipcRenderer. Everything
// goes through window.api (whitelisted bridge in preload.js).
//
// Slider sends are debounced: dragging a range slider fires dozens of 'input'
// events, and each one used to trigger a full settings sanitize + JSON save in
// main. We coalesce bursts into one send per ~80ms and flush whatever is still
// pending when the window closes.

const sizeSlider = document.getElementById('size-slider');
const speedSlider = document.getElementById('speed-slider');
const volumeSlider = document.getElementById('volume-slider');
const muteCheckbox = document.getElementById('mute-checkbox');
const dndCheckbox = document.getElementById('dnd-checkbox');
const bordersCheckbox = document.getElementById('borders-checkbox');
const reduceMotionCheckbox = document.getElementById('reduce-motion-checkbox');
const contrastCheckbox = document.getElementById('contrast-checkbox');
const largerCheckbox = document.getElementById('larger-checkbox');
const overAppsCheckbox = document.getElementById('overapps-checkbox');
const autoLaunchCheckbox = document.getElementById('autolaunch-checkbox');

const sizeValue = document.getElementById('size-value');
const speedValue = document.getElementById('speed-value');
const volumeValue = document.getElementById('volume-value');

const rosterList = document.getElementById('roster-list');
const closeBtn = document.getElementById('close-btn');

let currentSettings = {
  sizePercent: 100,
  speedPercent: 100,
  isMuted: false,
  masterVolume: 0.5,
  dndEnabled: false,
  walkOnBorders: false,
  reduceMotion: false,
  highContrast: false,
  largerSprites: false,
  showOverApps: true,
  autoLaunch: false
};

function populateControls(values) {
  currentSettings = { ...currentSettings, ...values };

  sizeSlider.value = currentSettings.sizePercent;
  speedSlider.value = currentSettings.speedPercent;
  sizeValue.textContent = `${currentSettings.sizePercent}%`;
  speedValue.textContent = `${currentSettings.speedPercent}%`;

  const volPercent = Math.round((currentSettings.masterVolume ?? 0.5) * 100);
  volumeSlider.value = volPercent;
  volumeValue.textContent = `${volPercent}%`;

  muteCheckbox.checked = !!currentSettings.isMuted;
  dndCheckbox.checked = !!currentSettings.dndEnabled;
  bordersCheckbox.checked = !!currentSettings.walkOnBorders;
  reduceMotionCheckbox.checked = !!currentSettings.reduceMotion;
  contrastCheckbox.checked = !!currentSettings.highContrast;
  largerCheckbox.checked = !!currentSettings.largerSprites;
  overAppsCheckbox.checked = !!currentSettings.showOverApps;
  autoLaunchCheckbox.checked = !!currentSettings.autoLaunch;

  renderRoster(currentSettings.livePetCount, currentSettings.livePets);
}

// --- Live pet roster (pushed from main as pets come and go) ---
function renderRoster(livePetCount, livePets) {
  const list = Array.isArray(livePets) ? livePets : [];
  if (list.length === 0) {
    rosterList.innerHTML = '<span class="roster-empty">No pets on screen.</span>';
    return;
  }
  rosterList.innerHTML = '';
  for (const pet of list.slice(0, 50)) {
    const item = document.createElement('div');
    item.className = 'roster-item';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = pet.isGuest
      ? `♦ ${pet.speciesId} #${pet.id}`
      : `${pet.speciesId} #${pet.id}`;
    if (pet.isGuest) nameSpan.className = 'guest';
    item.appendChild(nameSpan);
    rosterList.appendChild(item);
  }
}

// --- Debounced settings writer ---
// Only true 'input'-driven keys are coalesced; checkboxes send immediately.
const PENDING_KEYS = new Set();
let debounceTimer = null;
const DEBOUNCE_MS = 80;

function queueSetting(key, value) {
  PENDING_KEYS.add(key);
  currentSettings[key] = value;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushPending, DEBOUNCE_MS);
}

function flushPending() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (PENDING_KEYS.size === 0) return;
  const changes = {};
  for (const key of PENDING_KEYS) changes[key] = currentSettings[key];
  PENDING_KEYS.clear();
  api.send('settings-changed', changes);
}

// --- Rehydrate on open ---
api.on('init-settings-values', values => {
  if (values && typeof values === 'object') populateControls(values);
});

api.on('settings-roster-update', update => {
  if (!update || typeof update !== 'object') return;
  renderRoster(update.livePetCount, update.livePets);
});

sizeSlider.addEventListener('input', () => {
  const val = Number(sizeSlider.value);
  sizeValue.textContent = `${val}%`;
  queueSetting('sizePercent', val);
});

speedSlider.addEventListener('input', () => {
  const val = Number(speedSlider.value);
  speedValue.textContent = `${val}%`;
  queueSetting('speedPercent', val);
});

volumeSlider.addEventListener('input', () => {
  const val = Number(volumeSlider.value);
  volumeValue.textContent = `${val}%`;
  queueSetting('masterVolume', val / 100);
});

muteCheckbox.addEventListener('change', () => {
  currentSettings.isMuted = muteCheckbox.checked;
  api.send('settings-changed', { isMuted: muteCheckbox.checked });
});

dndCheckbox.addEventListener('change', () => {
  api.send('settings-changed', { dndEnabled: dndCheckbox.checked });
});

bordersCheckbox.addEventListener('change', () => {
  api.send('settings-changed', { walkOnBorders: bordersCheckbox.checked });
});

reduceMotionCheckbox.addEventListener('change', () => {
  api.send('settings-changed', { reduceMotion: reduceMotionCheckbox.checked });
});

contrastCheckbox.addEventListener('change', () => {
  api.send('settings-changed', { highContrast: contrastCheckbox.checked });
});

largerCheckbox.addEventListener('change', () => {
  api.send('settings-changed', { largerSprites: largerCheckbox.checked });
});

overAppsCheckbox.addEventListener('change', () => {
  api.send('settings-changed', { showOverApps: overAppsCheckbox.checked });
});

autoLaunchCheckbox.addEventListener('change', () => {
  api.send('settings-changed', { autoLaunch: autoLaunchCheckbox.checked });
});

closeBtn.addEventListener('click', () => {
  flushPending();
  window.close();
});

window.addEventListener('beforeunload', flushPending);
