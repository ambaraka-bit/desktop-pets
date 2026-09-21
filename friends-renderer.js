// friends-renderer.js — Friends window (contextIsolation build).
//
// Runs in the isolated main world: no require(), no ipcRenderer. Everything
// goes through window.api (whitelisted bridge in preload.js). Copy-to-clipboard
// is routed to main because navigator.clipboard isn't available on file://.

const myCodeEl = document.getElementById('my-code');
const copyBtn = document.getElementById('copy-btn');
const statusLine = document.getElementById('status-line');
const friendInput = document.getElementById('friend-code-input');
const connectBtn = document.getElementById('connect-btn');
const disconnectBtn = document.getElementById('disconnect-btn');
const awayList = document.getElementById('away-list');
const guestList = document.getElementById('guest-list');

connectBtn.addEventListener('click', () => {
  const code = friendInput.value.trim().toUpperCase();
  if (!code) return;
  api.send('friends:connect-request', code);
});

disconnectBtn.addEventListener('click', () => {
  api.send('friends:disconnect-request');
});

copyBtn.addEventListener('click', () => {
  const code = myCodeEl.textContent.trim();
  if (!code || code === '------') return;
  api.send('copy-to-clipboard', code);
  copyBtn.textContent = 'Copied!';
  setTimeout(() => {
    copyBtn.textContent = 'Copy';
  }, 1200);
});

function renderList(el, items, emptyText, onAction, actionLabel) {
  el.innerHTML = '';
  if (!items || items.length === 0) {
    el.innerHTML = `<li class="empty">${emptyText}</li>`;
    return;
  }
  for (const item of items) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = item.label;
    li.appendChild(label);

    if (onAction) {
      const btn = document.createElement('button');
      btn.textContent = actionLabel;
      btn.addEventListener('click', () => onAction(item.id));
      li.appendChild(btn);
    }
    el.appendChild(li);
  }
}

let currentCode = '';
api.on('friends:status-update', status => {
  if (!status || typeof status !== 'object') return;
  currentCode = status.myCode || '';
  myCodeEl.textContent = currentCode || '------';

  statusLine.className = '';
  if (status.state === 'connected') {
    statusLine.textContent = `Connected to ${status.friendCode}`;
    statusLine.classList.add('status-connected');
    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
  } else if (status.state === 'connecting') {
    statusLine.textContent = `Connecting to ${status.friendCode}...`;
    statusLine.classList.add('status-connecting');
    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
  } else if (status.state === 'error') {
    statusLine.textContent = `Error: ${status.error}`;
    statusLine.classList.add('status-error');
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
  } else {
    statusLine.textContent = 'Not connected.';
    statusLine.classList.add('status-idle');
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
  }

  renderList(
    awayList,
    (status.awayPets || []).map(p => ({
      id: p.migrationId,
      label: `${p.speciesId} (visiting ${p.friendCode || status.friendCode || 'friend'})`
    })),
    'None right now.',
    migrationId => api.send('friends:recall-request', migrationId),
    'Recall'
  );

  renderList(
    guestList,
    (status.guestPets || []).map(p => ({
      id: p.migrationId,
      label: `${p.speciesId} (from ${p.guestOwner})`
    })),
    'None right now.',
    migrationId => api.send('friends:send-home-request', migrationId),
    'Send Home'
  );
});

// Ask for the current state as soon as this window opens.
api.send('friends:request-status');
