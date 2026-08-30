const { ipcRenderer } = require('electron');

const myCodeEl = document.getElementById('my-code');
const statusLine = document.getElementById('status-line');
const friendInput = document.getElementById('friend-code-input');
const connectBtn = document.getElementById('connect-btn');
const disconnectBtn = document.getElementById('disconnect-btn');
const awayList = document.getElementById('away-list');
const guestList = document.getElementById('guest-list');

connectBtn.addEventListener('click', () => {
  const code = friendInput.value.trim().toUpperCase();
  if (!code) return;
  ipcRenderer.send('friends:connect-request', code);
});

disconnectBtn.addEventListener('click', () => {
  ipcRenderer.send('friends:disconnect-request');
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

ipcRenderer.on('friends:status-update', (event, status) => {
  myCodeEl.textContent = status.myCode || '------';

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
    (status.awayPets || []).map(p => ({ id: p.migrationId, label: `${p.speciesId} (visiting ${status.friendCode || 'friend'})` })),
    'None right now.',
    (migrationId) => ipcRenderer.send('friends:recall-request', migrationId),
    'Recall'
  );

  renderList(
    guestList,
    (status.guestPets || []).map(p => ({ id: p.migrationId, label: `${p.speciesId} (from ${p.guestOwner})` })),
    'None right now.',
    (migrationId) => ipcRenderer.send('friends:send-home-request', migrationId),
    'Send Home'
  );
});

// Ask for the current state as soon as this window opens.
ipcRenderer.send('friends:request-status');
