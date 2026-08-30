const { ipcRenderer } = require('electron');

const sizeSlider = document.getElementById('size-slider');
const speedSlider = document.getElementById('speed-slider');
const volumeSlider = document.getElementById('volume-slider');
const muteCheckbox = document.getElementById('mute-checkbox');

const sizeValue = document.getElementById('size-value');
const speedValue = document.getElementById('speed-value');
const volumeValue = document.getElementById('volume-value');

const closeBtn = document.getElementById('close-btn');

// Populate controls with current values when the window opens
ipcRenderer.on('init-settings-values', (event, { sizePercent, speedPercent, isMuted, masterVolume }) => {
  sizeSlider.value = sizePercent;
  speedSlider.value = speedPercent;
  sizeValue.textContent = `${sizePercent}%`;
  speedValue.textContent = `${speedPercent}%`;

  const volPercent = Math.round((masterVolume ?? 0.5) * 100);
  volumeSlider.value = volPercent;
  volumeValue.textContent = `${volPercent}%`;

  muteCheckbox.checked = !!isMuted;
});

sizeSlider.addEventListener('input', () => {
  const val = Number(sizeSlider.value);
  sizeValue.textContent = `${val}%`;
  ipcRenderer.send('settings-changed', { sizePercent: val });
});

speedSlider.addEventListener('input', () => {
  const val = Number(speedSlider.value);
  speedValue.textContent = `${val}%`;
  ipcRenderer.send('settings-changed', { speedPercent: val });
});

volumeSlider.addEventListener('input', () => {
  const val = Number(volumeSlider.value);
  volumeValue.textContent = `${val}%`;
  ipcRenderer.send('settings-changed', { masterVolume: val / 100 });
});

muteCheckbox.addEventListener('change', () => {
  ipcRenderer.send('settings-changed', { isMuted: muteCheckbox.checked });
});

closeBtn.addEventListener('click', () => {
  window.close();
});