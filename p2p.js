// p2p.js — PeerJS (WebRTC) "Friends" feature.
//
// Each app instance is a "Peer" identified by a short persisted code. Connecting
// to a friend opens a direct WebRTC data channel — the only server involved is
// PeerJS's free public signaling broker, used solely to establish the link.
//
// MULTIPLE FRIENDS: every live connection lives in the `friendConnections` Map
// (state.js), keyed by friend code. One of them is the "primary" — the most
// recently connected / the sender asks for — which drives the status badge,
// the Friends window, and the "Send to Friend" menu action. Migrated pets
// remember which friend they were sent to, so a disconnect only recalls that
// friend's pets.
//
// Security hardening in this module:
//   * initPeer() feature-detects the PeerJS <script> (a load failure no longer
//     crashes the whole renderer).
//   * handleP2PMessage() runs every inbound message through sanitizeP2PMessage()
//     (utils.js) — schema-validated, type-checked, length-capped, and species-
//     checked before anything touches canvas/state.
//   * Connection attempts time out instead of hanging in 'connecting' forever.
//   * Away pets are auto-recalled if the friend never answers the migration.

const CONNECTION_TIMEOUT_MS = 20000; // friend never responded to connect
const MIGRATION_TIMEOUT_MS = 30000; // friend never answered a pet transfer

// Message protocol over the data channel (all JSON):
//   { type: 'chat', migrationId, text }
//   { type: 'chat-echo', migrationId, text }   chat sent THROUGH a guest pet, echoed to its owner
//   { type: 'pet-migrate-request', migrationId, speciesId, ownerCode }
//   { type: 'pet-migrate-accept', migrationId }
//   { type: 'pet-migrate-reject', migrationId }
//   { type: 'pet-recall-request', migrationId }
//   { type: 'pet-recall-ack', migrationId }

function initPeer(code) {
  if (typeof Peer === 'undefined') {
    console.warn('[renderer] PeerJS library did not load — P2P disabled.');
    connectionState = 'error';
    connectionError = 'PeerJS failed to load';
    reportFriendsStatus();
    return;
  }
  myPeerCode = code;
  peer = new Peer(code, { debug: 1 });

  peer.on('open', () => {
    debugLog('PeerJS ready. My code:', myPeerCode);
    reportFriendsStatus();
  });

  peer.on('error', err => {
    console.error('[renderer] PeerJS error:', err);

    // ID already taken on the signaling server (stale session / other
    // instance). Ask main for a fresh cryptographically-secure code and
    // retry. peerRecovering prevents recursive error → destroy → error loops.
    if (err.type === 'unavailable-id' && !peerRecovering) {
      peerRecovering = true;
      try {
        if (peer) peer.destroy();
      } catch (_) {
        /* ignore destroy errors */
      }
      api
        .invoke('generate-peer-code')
        .then(code => {
          myPeerCode = code;
          api.send('settings-changed', { myPeerCode: code });
          peerRecovering = false;
          initPeer(code);
        })
        .catch(() => {
          peerRecovering = false;
          connectionState = 'error';
          connectionError = 'Could not obtain a fresh peer code';
          reportFriendsStatus();
        });
      return;
    }

    connectionState = 'error';
    connectionError = err.type || String(err);
    reportFriendsStatus();
  });

  peer.on('connection', conn => {
    // Someone wants to connect to us — explicit consent required.
    api
      .invoke('show-confirm-dialog', {
        title: 'Incoming Friend Request',
        message: `"${conn.peer}" wants to connect. Accept?`
      })
      .then(accepted => {
        if (accepted) {
          setupConnection(conn);
          // If we have no friend yet, this new one becomes the primary.
          if (!connectedFriendCode) setPrimaryFriend(conn.peer, 'connecting');
        } else {
          try {
            conn.close();
          } catch (_) {
            /* race */
          }
        }
      });
  });
}

// Mark a friend as the UI's primary (status badge / Send-to-Friend target).
function setPrimaryFriend(code, state) {
  const entry = friendConnections.get(code);
  activeConnection = entry ? entry.conn : null;
  connectedFriendCode = code;
  connectionState = state || (entry && entry.state) || 'connected';
  connectionError = null;
}

function clearConnectionTimeout(code) {
  const timer = connectionTimeouts.get(code);
  if (timer) {
    clearTimeout(timer);
    connectionTimeouts.delete(code);
  }
}

function connectToFriend(code) {
  if (!peer) return;
  const existing = friendConnections.get(code);
  if (existing) {
    // Already connected/connecting — just make it the primary.
    if (existing.state === 'connected') setPrimaryFriend(code, 'connected');
    reportFriendsStatus();
    return;
  }

  const conn = peer.connect(code, { reliable: true });
  friendConnections.set(code, { conn, state: 'connecting' });
  setPrimaryFriend(code, 'connecting');
  reportFriendsStatus();

  // If the peer never responds, drop out of 'connecting' with a clear error.
  connectionTimeouts.set(
    code,
    setTimeout(() => {
      clearConnectionTimeout(code);
      const entry = friendConnections.get(code);
      if (!entry || entry.state !== 'connecting') return;
      friendConnections.delete(code);
      try {
        conn.close();
      } catch (_) {
        /* already closed */
      }
      if (connectedFriendCode === code) {
        connectionState = 'error';
        connectionError = `Timed out — "${code}" never responded.`;
      }
      reportFriendsStatus();
    }, CONNECTION_TIMEOUT_MS)
  );

  setupConnection(conn);
}

function setupConnection(conn) {
  const code = conn.peer;
  if (!friendConnections.has(code)) friendConnections.set(code, { conn, state: 'connecting' });

  conn.on('open', () => {
    clearConnectionTimeout(code);
    const entry = friendConnections.get(code);
    if (entry) entry.state = 'connected';
    if (connectedFriendCode === code) connectionState = 'connected';
    connectionError = null;
    reportFriendsStatus();
  });

  conn.on('data', data => handleP2PMessage(data));

  conn.on('close', () => handleConnectionClosed(code));

  conn.on('error', err => {
    clearConnectionTimeout(code);
    friendConnections.delete(code);
    console.error('[renderer] Connection error:', err);
    if (connectedFriendCode === code) {
      connectionState = 'error';
      connectionError = String(err);
    }
    reportFriendsStatus();
  });
}

// One friend's connection went away. Recall pets that were visiting THAT
// friend, drop guest pets owned by THAT friend, then pick a new primary.
function handleConnectionClosed(code) {
  clearConnectionTimeout(code);
  friendConnections.delete(code);

  // Bring home any pets that were away visiting this friend.
  const gone = awayPets.filter(a => a.friendCode === code);
  awayPets = awayPets.filter(a => a.friendCode !== code);
  for (const away of gone) {
    clearMigrationTimeout(away.migrationId);
    addPet(away.speciesId, true, away.name ? { name: away.name } : undefined);
  }

  // Remove guest pets that were visiting from this friend.
  if (pets.some(p => p.isGuest && p.guestOwner === code)) {
    pets = pets.filter(p => !(p.isGuest && p.guestOwner === code));
  }

  // If the primary died, promote any remaining friend (most recent first).
  if (connectedFriendCode === code) {
    const entries = [...friendConnections.entries()].reverse();
    const next = entries.find(([, e]) => e.state === 'connected') || entries[0];
    if (next) {
      setPrimaryFriend(next[0], next[1].state);
    } else {
      activeConnection = null;
      connectedFriendCode = null;
      connectionState = 'idle';
      connectionError = null;
    }
  }

  syncPetsToMain();
  reportFriendsStatus();
}

// Renderer → "disconnect" = tear down the primary friend only. Other friends
// (if any) stay connected and keep their guest pets.
function handleDisconnect() {
  const code = connectedFriendCode;
  if (!code) return;
  const entry = friendConnections.get(code);
  if (entry) {
    try {
      entry.conn.close();
    } catch (_) {
      /* race */
    }
  } else {
    handleConnectionClosed(code);
  }
}

function sendP2P(message) {
  if (activeConnection) {
    try {
      activeConnection.send(message);
    } catch (err) {
      console.warn('[renderer] Failed to send P2P message:', err);
    }
  }
}

function handleP2PMessage(raw) {
  // Validate & sanitize EVERYTHING from remote peers — never trust their
  // shapes, lengths, or types (see sanitizeP2PMessage in utils.js).
  const msg = sanitizeP2PMessage(raw, SPECIES);
  if (!msg) {
    console.warn('[renderer] Ignoring malformed P2P message:', raw);
    return;
  }
  debugLog('P2P message received:', msg);

  switch (msg.type) {
    case 'pet-migrate-request': {
      api
        .invoke('show-confirm-dialog', {
          title: 'Incoming Pet',
          message: `${connectedFriendCode} wants to send a pet (${msg.speciesId}) to visit your desktop. Accept?`
        })
        .then(accepted => {
          if (accepted) {
            addGuestPet(msg.speciesId, msg.migrationId, msg.ownerCode);
            sendP2P({ type: 'pet-migrate-accept', migrationId: msg.migrationId });
          } else {
            sendP2P({ type: 'pet-migrate-reject', migrationId: msg.migrationId });
          }
        });
      break;
    }
    case 'pet-migrate-accept':
      clearMigrationTimeout(msg.migrationId);
      reportFriendsStatus(); // already removed locally when sent — just refresh UI
      break;
    case 'pet-migrate-reject': {
      clearMigrationTimeout(msg.migrationId);
      const away = awayPets.find(p => p.migrationId === msg.migrationId);
      if (away) {
        awayPets = awayPets.filter(p => p.migrationId !== msg.migrationId);
        addPet(away.speciesId, true, away.name ? { name: away.name } : undefined); // bring it back home
        reportFriendsStatus();
      }
      break;
    }
    case 'pet-recall-request': {
      // Friend wants their visiting pet back.
      const recalled = pets.filter(p => p.migrationId === msg.migrationId && p.isGuest);
      pets = pets.filter(p => p.migrationId !== msg.migrationId || !p.isGuest);
      sendP2P({ type: 'pet-recall-ack', migrationId: msg.migrationId });
      if (recalled.length > 0) {
        syncPetsToMain();
        reportFriendsStatus();
      }
      break;
    }
    case 'pet-recall-ack': {
      clearMigrationTimeout(msg.migrationId);
      const away = awayPets.find(p => p.migrationId === msg.migrationId);
      if (away) {
        awayPets = awayPets.filter(p => p.migrationId !== msg.migrationId);
        addPet(away.speciesId, true, away.name ? { name: away.name } : undefined);
        reportFriendsStatus();
      }
      break;
    }
    case 'chat': {
      const pet = pets.find(p => p.migrationId === msg.migrationId);
      if (pet && pet.isGuest) {
        pet.chatText = msg.text; // already truncated to 40 chars by sanitizer
        pet.chatExpiresAt = performance.now() + 4000;
        recordChatEntry(petKey(pet), `${pet.guestOwner}'s reply`, msg.text);
      }
      break;
    }
    case 'chat-echo': {
      // A friend chatted THROUGH my pet while it was visiting them. Only show
      // it if the migration is genuinely one of mine (migrationId must match an
      // away pet) — otherwise ignore the stray echo.
      const away = awayPets.find(p => p.migrationId === msg.migrationId);
      if (away) showEchoToast(msg.text);
      break;
    }
  }
}

function sendPetToFriend(pet) {
  if (!connectedFriendCode || !activeConnection) return;
  const migrationId = `${myPeerCode}-${Date.now()}`;
  awayPets.push({
    migrationId,
    speciesId: pet.speciesId,
    name: pet.name || null,
    friendCode: connectedFriendCode,
    sentAt: Date.now()
  });
  pets = pets.filter(p => p.id !== pet.id);
  sendP2P({
    type: 'pet-migrate-request',
    migrationId,
    speciesId: pet.speciesId,
    ownerCode: myPeerCode
  });
  scheduleMigrationTimeout(migrationId, pet.speciesId, pet.name || null, MIGRATION_TIMEOUT_MS);
  syncPetsToMain();
  reportFriendsStatus();
}

function sendGuestPetHome(pet) {
  sendP2P({ type: 'pet-recall-request', migrationId: pet.migrationId });
  pets = pets.filter(p => p.id !== pet.id);
  syncPetsToMain();
  reportFriendsStatus();
}

function addGuestPet(speciesId, migrationId, guestOwner) {
  const pet = makePet(speciesId);
  pet.isGuest = true;
  pet.migrationId = migrationId;
  pet.guestOwner = guestOwner;
  pets.push(pet);
  syncPetsToMain();
  reportFriendsStatus();
}

// --- Away-pet auto-recall: if the friend never confirms the migration, bring
// the pet home rather than leaving it stranded in `awayPets` forever. ---
function scheduleMigrationTimeout(migrationId, speciesId, name, ms) {
  const timer = setTimeout(() => {
    migrationTimeouts.delete(migrationId);
    const away = awayPets.find(p => p.migrationId === migrationId);
    if (!away) return;
    awayPets = awayPets.filter(p => p.migrationId !== migrationId);
    addPet(speciesId, true, name ? { name } : undefined);
    connectionError = `Pet returned home — no answer within ${Math.round(ms / 1000)}s.`;
    reportFriendsStatus();
  }, ms);
  migrationTimeouts.set(migrationId, timer);
}

function clearMigrationTimeout(migrationId) {
  const timer = migrationTimeouts.get(migrationId);
  if (timer) {
    clearTimeout(timer);
    migrationTimeouts.delete(migrationId);
  }
}

// --- Status panel (Friends window) + on-canvas badge ---
function reportFriendsStatus() {
  api.send('friends:status-update', {
    myCode: myPeerCode,
    state: connectionState,
    friendCode: connectedFriendCode,
    error: connectionError,
    friends: [...friendConnections.keys()],
    awayPets: awayPets.map(p => ({
      migrationId: p.migrationId,
      speciesId: p.speciesId,
      friendCode: p.friendCode || connectedFriendCode
    })),
    guestPets: pets
      .filter(p => p.isGuest)
      .map(p => ({ migrationId: p.migrationId, speciesId: p.speciesId, guestOwner: p.guestOwner }))
  });
  updateFriendBadge();
}

const friendBadge = document.getElementById('friend-status-badge');
function updateFriendBadge() {
  if (connectionState === 'connected') {
    friendBadge.textContent =
      friendConnections.size > 1
        ? `♦ Connected to ${connectedFriendCode} (+${friendConnections.size - 1})`
        : `♦ Connected to ${connectedFriendCode}`;
    friendBadge.style.display = 'block';
  } else if (connectionState === 'connecting') {
    friendBadge.textContent = `Connecting to ${connectedFriendCode}...`;
    friendBadge.style.display = 'block';
  } else {
    friendBadge.style.display = 'none';
  }
}

// --- "Friend said" echo toast (owner side of chat-echo) ---
const echoBanner = document.getElementById('echo-banner');
let echoTimer = null;
function showEchoToast(text) {
  if (!echoBanner) return;
  echoBanner.textContent = `♦ Friend said: ${text}`;
  echoBanner.style.display = 'block';
  recordChatEntry('echo', 'friend', text);
  if (echoTimer) clearTimeout(echoTimer);
  echoTimer = setTimeout(() => {
    echoBanner.style.display = 'none';
  }, 4000);
}
