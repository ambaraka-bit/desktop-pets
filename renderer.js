// renderer.js — drives multiple independent pets, each backed by a
// species/animation set discovered by species.js (assets/Characters/...).
//
// Each animation is a single sprite-sheet image (a horizontal strip of
// square frames). Frame count is inferred as (sheet.width / sheet.height).
//
// Behavior states ('walk' / 'idle') map directly to animation names
// ('Walk' / 'Idle') inside each species' folder.

const canvas = document.getElementById('pet-canvas');
const ctx = canvas.getContext('2d');

canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

// --- Multi-monitor layout (sent from main.js — see computeVirtualDesktop) ---
// Each entry: { x, y, width, height, workAreaX, workAreaY, workAreaWidth, workAreaHeight }
// in LOCAL canvas coordinates (already offset so the virtual window's
// top-left corner is (0,0), matching this canvas exactly).
let displays = [];

const { ipcRenderer: _ipcForDisplays } = require('electron');
_ipcForDisplays.on('display-info', (event, info) => {
  displays = info;
});

// Given a horizontal canvas x-position, returns the y-coordinate a pet's
// feet should rest at — the bottom of whichever monitor's work area
// (i.e. above its taskbar, if any) currently contains that x. Falls back
// to the overall canvas bottom if x doesn't land inside any known display
// (e.g. a gap between differently-sized, unaligned monitors).
function floorYForX(x) {
  for (const d of displays) {
    if (x >= d.x && x < d.x + d.width) {
      return d.workAreaY + d.workAreaHeight;
    }
  }
  return canvas.height;
}

const { scanSpeciesLibrary } = require('./species.js');

const BASE_DISPLAY_SIZE = 96;          // pets are drawn at this height (px) before size% scaling
const BASE_WALK_SPEED_PX = 1.5;
const FRAME_DURATION_MS = 90;

let sizePercent = 100;
let speedPercent = 100;
let isMuted = true;
let masterVolume = 0.5;
let isPaused = false;

// Animations that are never picked for the random "surprise event" pool —
// these read as combat/negative rather than a cute idle desktop moment.
// Everything else a species has (Attack_1, Fireball, Jump, Run, etc.)
// is fair game.
const EVENT_EXCLUDED_ANIMATIONS = new Set(['Idle', 'Walk', 'Dead', 'Hurt']);

const EVENT_MIN_INTERVAL_MS = 8000;   // shortest gap between possible events for a pet
const EVENT_MAX_INTERVAL_MS = 20000;  // longest gap
const EVENT_TRIGGER_CHANCE = 0.5;     // chance an eligible pet actually fires when its timer is up

function randomEventInterval() {
  return EVENT_MIN_INTERVAL_MS + Math.random() * (EVENT_MAX_INTERVAL_MS - EVENT_MIN_INTERVAL_MS);
}

function currentDisplayScale() {
  return (sizePercent / 100);
}
function currentWalkSpeed() {
  return BASE_WALK_SPEED_PX * (speedPercent / 100);
}

// Howl / Howler are loaded globally via the <script> tag in index.html.
const footstepSound = new Howl({ src: ['assets/sounds/footstep.wav'], volume: 1.0 });
const idleSound = new Howl({ src: ['assets/sounds/idle.wav'], volume: 1.0 });

function playSound(sound) {
  if (isMuted) return;
  sound.volume(masterVolume);
  sound.play();
}

// --- Species registry (metadata only — no images loaded yet) ---
let SPECIES = scanSpeciesLibrary();
let DEFAULT_SPECIES_ID = Object.keys(SPECIES)[0] || null;
console.log('[renderer.js] SPECIES keys:', Object.keys(SPECIES), '| DEFAULT_SPECIES_ID:', DEFAULT_SPECIES_ID);

// Precompute each species' pool of eligible random-event animation names
// (everything it has except Idle/Walk/Dead/Hurt).
function eventAnimationsFor(speciesId) {
  const species = SPECIES[speciesId];
  if (!species) return [];
  return Object.keys(species.animations).filter(name => !EVENT_EXCLUDED_ANIMATIONS.has(name));
}

// --- Sheet cache: resolves each animation's image + frame geometry once ---
// resolvedSheets["FireWizard/Idle"] = { img, frameWidth, frameHeight, frameCount }
const resolvedSheets = new Map();

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function resolveSheet(speciesId, animName) {
  const key = `${speciesId}/${animName}`;
  if (resolvedSheets.has(key)) return resolvedSheets.get(key);

  const anim = SPECIES[speciesId]?.animations?.[animName];
  if (!anim) return null;

  const img = await loadImage(anim.src);
  const frameHeight = img.height;
  const frameCount = Math.max(1, Math.round(img.width / img.height)); // square-frame assumption
  const frameWidth = img.width / frameCount;

  const sheet = { img, frameWidth, frameHeight, frameCount };
  resolvedSheets.set(key, sheet);
  return sheet;
}

async function preloadAllSpecies() {
  const jobs = [];
  for (const species of Object.values(SPECIES)) {
    for (const animName of Object.keys(species.animations)) {
      jobs.push(
        resolveSheet(species.id, animName).catch(err => {
          console.error(`[renderer.js] Failed to load ${species.id}/${animName}:`, err);
        })
      );
    }
  }
  await Promise.all(jobs);
}

// Returns the on-screen bounding box for a pet, matching exactly what
// draw() renders — used for mouse hit-testing (hover/click/drag).
function getPetBounds(pet) {
  const animName = animationNameFor(pet);
  const sheet = animName ? resolvedSheets.get(`${pet.speciesId}/${animName}`) : null;
  const displaySize = BASE_DISPLAY_SIZE * currentDisplayScale();
  const aspect = sheet ? (sheet.frameWidth / sheet.frameHeight) : 1;
  const w = displaySize * aspect;
  const h = displaySize;
  return { x: pet.x, y: pet.y, w, h };
}

function isPointInPet(px, py, pet) {
  const b = getPetBounds(pet);
  return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
}

// Topmost pet under the cursor (last in array = drawn last = visually on top)
function petAtPoint(px, py) {
  for (let i = pets.length - 1; i >= 0; i--) {
    if (isPointInPet(px, py, pets[i])) return pets[i];
  }
  return null;
}
// falling back sensibly if a species doesn't have an exact match.
function animationNameFor(pet) {
  const species = SPECIES[pet.speciesId];
  if (!species) return null;
  if (pet.state === 'event' && pet.eventAnimation) return pet.eventAnimation;
  if (pet.state === 'jumping' && species.animations['Jump']) return 'Jump';
  const wanted = pet.state === 'walk' ? 'Walk' : 'Idle';
  if (species.animations[wanted]) return wanted;
  // fall back to whatever exists
  return Object.keys(species.animations)[0] || null;
}

let nextPetId = 1;
let pets = [];

function randomDuration() {
  return 2000 + Math.random() * 3000;
}

function makePet(speciesId) {
  const id = (speciesId && SPECIES[speciesId]) ? speciesId : DEFAULT_SPECIES_ID;
  const displaySize = BASE_DISPLAY_SIZE * currentDisplayScale();
  const spawnX = Math.random() * Math.max(0, canvas.width - displaySize);
  return {
    id: nextPetId++,
    speciesId: id,
    x: spawnX,
    y: floorYForX(spawnX) - displaySize,
    direction: Math.random() < 0.5 ? -1 : 1,
    state: 'walk',
    stateTimer: 0,
    stateDuration: randomDuration(),
    currentFrame: 0,
    lastFrameTime: 0,
    footstepTimer: 0,
    // Random "surprise event" tracking
    eventTimer: 0,
    eventInterval: randomEventInterval(),
    eventAnimation: null,   // e.g. "Fireball" while an event is playing, else null
    previousState: null,    // 'walk' or 'idle' to resume once the event finishes
    isDragging: false,
    isGuest: false,          // true if this pet is visiting from a friend's app
    migrationId: null,
    guestOwner: null
  };
}

function addPet(speciesId, notifyMain = true) {
  if (!DEFAULT_SPECIES_ID) {
    console.error('[renderer.js] No species available — cannot add pet. Check Characters folder.');
    return;
  }
  const pet = makePet(speciesId);
  pets.push(pet);
  console.log(`[renderer.js] addPet(requested="${speciesId}", resolved="${pet.speciesId}", notifyMain=${notifyMain}) — total pets now:`, pets.length);
  if (notifyMain) ipcRenderer.send('pet-added', pet.speciesId);
}

function removePet(notifyMain = true) {
  if (pets.length > 0) {
    pets.pop();
    console.log('Pet removed. Total pets:', pets.length);
    if (notifyMain) ipcRenderer.send('pet-removed');
  }
}

// --- IPC: tray menu controls (see main.js) ---
const { ipcRenderer } = require('electron');

ipcRenderer.on('set-paused', (event, paused) => { isPaused = paused; });
ipcRenderer.on('add-pet', (event, speciesId) => { addPet(speciesId); });
ipcRenderer.on('remove-pet', () => { removePet(); });

ipcRenderer.on('apply-settings', (event, changes) => {
  if (changes.sizePercent !== undefined) sizePercent = changes.sizePercent;
  if (changes.speedPercent !== undefined) speedPercent = changes.speedPercent;
  if (changes.isMuted !== undefined) isMuted = changes.isMuted;
  if (changes.masterVolume !== undefined) masterVolume = changes.masterVolume;
});

let pendingRestoreSettings = null;
let isReady = false;

ipcRenderer.on('restore-settings', (event, settings) => {
  if (!isReady) { pendingRestoreSettings = settings; return; }
  applyRestoredSettings(settings);
});

function applyRestoredSettings(settings) {
  console.log('[renderer.js] applyRestoredSettings received:', JSON.stringify(settings));
  isPaused = settings.isPaused;
  if (settings.sizePercent !== undefined) sizePercent = settings.sizePercent;
  if (settings.speedPercent !== undefined) speedPercent = settings.speedPercent;
  if (settings.isMuted !== undefined) isMuted = settings.isMuted;
  if (settings.masterVolume !== undefined) masterVolume = settings.masterVolume;

  if (settings.myPeerCode) initPeer(settings.myPeerCode);

  if (settings.activePets && settings.activePets.length > 0) {
    console.log('[renderer.js] Restoring known roster silently:', settings.activePets);
    // main.js already knows about these — don't re-notify, or the tray
    // count would double up against what's already saved on disk.
    for (const speciesId of settings.activePets) addPet(speciesId, false);
  } else if (DEFAULT_SPECIES_ID) {
    console.log('[renderer.js] activePets was empty — spawning fresh default pet AND notifying main.');
    // main.js's saved roster was empty — this is a genuinely new pet
    // main doesn't know about yet, so DO notify to keep the tray in sync.
    addPet(DEFAULT_SPECIES_ID, true);
  }
}

// --- Main animation loop ---
function tick(timestamp) {
  if (!isPaused) {
    for (const pet of pets) {
      updateState(pet);
      updateAnimationFrame(pet, timestamp);
    }
  }
  draw();
  requestAnimationFrame(tick);
}

function updateState(pet) {
  // Held by the mouse — skip all normal AI/movement/timers entirely.
  if (pet.isDragging) return;

  // Player-controlled ("Control" mode from the pet menu) — movement comes
  // from arrow/WASD key state instead of the autonomous AI below.
  if (pet.isControlled) {
    if (pet.state === 'jumping') return; // let the jump animation play out untouched

    if (pet.controlMoveDir !== 0) {
      pet.direction = pet.controlMoveDir;
      pet.x += currentWalkSpeed() * 2 * pet.controlMoveDir; // a bit snappier than autonomous walking
      pet.state = 'walk';

      const displayWidth = BASE_DISPLAY_SIZE * currentDisplayScale();
      pet.x = Math.max(0, Math.min(canvas.width - displayWidth, pet.x));

      pet.footstepTimer += 16;
      if (pet.footstepTimer > 220) {
        pet.footstepTimer = 0;
        playSound(footstepSound);
      }

      pet.y = floorYForX(pet.x) - displayWidth; // re-snap floor when crossing monitors
    } else {
      pet.state = 'idle';
    }
    return;
  }

  // While a random event animation is playing, freeze normal walk/idle
  // behavior and movement — just wait for it to finish (handled in
  // updateAnimationFrame, since that's where we know frame/loop counts).
  if (pet.state === 'event') return;

  // Tick toward the next possible random event for this pet.
  pet.eventTimer += 16;
  if (pet.eventTimer >= pet.eventInterval) {
    pet.eventTimer = 0;
    pet.eventInterval = randomEventInterval();

    const pool = eventAnimationsFor(pet.speciesId);
    if (pool.length > 0 && Math.random() < EVENT_TRIGGER_CHANCE) {
      pet.previousState = pet.state;
      pet.state = 'event';
      pet.eventAnimation = pool[Math.floor(Math.random() * pool.length)];
      pet.currentFrame = 0;
      pet.lastFrameTime = 0;
      pet.eventLoopsPlayed = 0;
      return; // skip normal walk/idle logic this tick — event just started
    }
  }

  pet.stateTimer += 16;

  if (pet.stateTimer > pet.stateDuration) {
    pet.state = pet.state === 'walk' ? 'idle' : 'walk';
    pet.stateTimer = 0;
    pet.stateDuration = randomDuration();
    pet.currentFrame = 0;

    if (pet.state === 'walk') {
      pet.direction = Math.random() < 0.5 ? -1 : 1;
    } else {
      if (Math.random() < 0.5) playSound(idleSound);
    }
  }

  if (pet.state === 'walk') {
    pet.x += currentWalkSpeed() * pet.direction;

    pet.footstepTimer += 16;
    if (pet.footstepTimer > 280) {
      pet.footstepTimer = 0;
      playSound(footstepSound);
    }

    const displayWidth = BASE_DISPLAY_SIZE * currentDisplayScale();
    const displaySize = BASE_DISPLAY_SIZE * currentDisplayScale();
    if (pet.x <= 0) {
      pet.x = 0;
      pet.direction = 1;
    } else if (pet.x + displayWidth >= canvas.width) {
      pet.x = canvas.width - displayWidth;
      pet.direction = -1;
    }

    // Re-snap to the floor of whichever monitor the pet is now over —
    // this is what makes crossing from one screen to another look right,
    // since different monitors can have different resolutions/taskbars.
    pet.y = floorYForX(pet.x) - displaySize;
  }
}

function updateAnimationFrame(pet, timestamp) {
  const animName = animationNameFor(pet);
  if (!animName) return;
  const sheet = resolvedSheets.get(`${pet.speciesId}/${animName}`);
  if (!sheet) return;

  if (timestamp - pet.lastFrameTime > FRAME_DURATION_MS) {
    const nextFrame = pet.currentFrame + 1;

    if ((pet.state === 'event' || pet.state === 'jumping') && nextFrame >= sheet.frameCount) {
      // One-shot animation (event OR jump-in-place) completed a full loop.
      if (pet.state === 'jumping') {
        pet.state = pet.isControlled ? 'idle' : (pet.previousState || 'idle');
      } else {
        pet.state = pet.previousState || 'idle';
      }
      pet.eventAnimation = null;
      pet.currentFrame = 0;
      pet.stateTimer = 0;
      pet.stateDuration = randomDuration();
    } else {
      pet.currentFrame = nextFrame % sheet.frameCount;
    }
    pet.lastFrameTime = timestamp;
  }
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (const pet of pets) {
    const animName = animationNameFor(pet);
    if (!animName) continue;
    const sheet = resolvedSheets.get(`${pet.speciesId}/${animName}`);
    if (!sheet) continue;

    const frameIndex = pet.currentFrame % sheet.frameCount;
    const sx = frameIndex * sheet.frameWidth;
    const sy = 0;

    const displaySize = BASE_DISPLAY_SIZE * currentDisplayScale();
    const displayW = displaySize * (sheet.frameWidth / sheet.frameHeight); // preserve aspect (usually 1:1)
    const displayH = displaySize;

    ctx.save();
    if (pet.direction === -1) {
      ctx.translate(pet.x + displayW, pet.y);
      ctx.scale(-1, 1);
    } else {
      ctx.translate(pet.x, pet.y);
    }
    ctx.drawImage(
      sheet.img,
      sx, sy, sheet.frameWidth, sheet.frameHeight,   // source crop from the sheet
      0, 0, displayW, displayH                        // destination on canvas
    );
    ctx.restore();

    // Chat speech bubble (pixel-style), drawn above the pet's head.
    if (pet.chatText && performance.now() < pet.chatExpiresAt) {
      drawChatBubble(pet, displayW, displayH);
    } else if (pet.chatText) {
      pet.chatText = null; // expired
    }

    // Small indicator so it's obvious which pet you're currently steering.
    if (pet === controlledPet) {
      ctx.save();
      ctx.font = 'bold 10px "Courier New", monospace';
      ctx.fillStyle = '#ffe66d';
      ctx.textAlign = 'center';
      ctx.fillText('▲ CONTROLLING (ESC to release)', pet.x + displayW / 2, pet.y - 8);
      ctx.restore();
    }

    // Guest nameplate — makes it obvious this pet is visiting from a friend.
    if (pet.isGuest && !(pet.chatText && performance.now() < pet.chatExpiresAt)) {
      ctx.save();
      ctx.font = 'bold 9px "Courier New", monospace';
      ctx.fillStyle = '#7CFC00';
      ctx.textAlign = 'center';
      ctx.fillText(`♦ ${pet.guestOwner}'s guest`, pet.x + displayW / 2, pet.y - 6);
      ctx.restore();
    }
  }
}

function drawChatBubble(pet, displayW, displayH) {
  const text = pet.chatText;
  ctx.save();
  ctx.font = 'bold 11px "Courier New", monospace';
  const paddingX = 8, paddingY = 5;
  const textWidth = ctx.measureText(text).width;
  const boxW = textWidth + paddingX * 2;
  const boxH = 20;
  const boxX = pet.x + displayW / 2 - boxW / 2;
  const boxY = pet.y - boxH - 10;

  ctx.fillStyle = '#1a1a2e';
  ctx.strokeStyle = '#f4f4f4';
  ctx.lineWidth = 2;
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.strokeRect(boxX, boxY, boxW, boxH);

  ctx.fillStyle = '#f4f4f4';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, boxX + boxW / 2, boxY + boxH / 2 + 1);
  ctx.restore();
}

window.addEventListener('resize', () => {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
});

// --- Mouse interaction: hover-to-unlock-clicks, click reaction, drag ---
//
// The overlay window is click-through by default (set-mouse-ignore true
// in main.js). Electron still forwards mousemove events to us even while
// click-through, so we can hit-test the cursor against pet bounding boxes
// every frame and only "unlock" real mouse input over the window while
// hovering a pet — everywhere else on the desktop stays fully clickable.

let mouseX = 0;
let mouseY = 0;
let isWindowInteractive = false;
let draggingPet = null;
let dragOffsetX = 0;
let dragOffsetY = 0;
let dragStartX = 0;
let dragStartY = 0;
const DRAG_CLICK_THRESHOLD_PX = 5; // movement below this = treat as a click, not a drag

function setWindowInteractive(interactive) {
  if (interactive === isWindowInteractive) return;
  isWindowInteractive = interactive;
  ipcRenderer.send('set-mouse-ignore', !interactive);
  canvas.style.cursor = interactive ? 'grab' : 'default';
}

function triggerClickReaction(pet) {
  const pool = eventAnimationsFor(pet.speciesId);
  if (pool.length === 0) return;
  pet.previousState = (pet.state === 'event') ? (pet.previousState || 'idle') : pet.state;
  pet.state = 'event';
  pet.eventAnimation = pool[Math.floor(Math.random() * pool.length)];
  pet.currentFrame = 0;
  pet.lastFrameTime = 0;
  pet.eventTimer = 0;
  pet.eventInterval = randomEventInterval();
}

// --- P2P Friends (PeerJS / WebRTC) ---
//
// Each app instance is a "Peer" identified by a short persisted code
// (generated once by main.js). Connecting to a friend opens a direct
// WebRTC data channel between the two apps — no server in the middle
// except PeerJS's free public broker, used only to establish the
// connection (standard signaling-server role, per the spec's P2P notes).
//
// Message protocol sent over the data channel (all JSON):
//   { type: 'chat', migrationId, text }
//   { type: 'pet-migrate-request', migrationId, speciesId, ownerCode }
//   { type: 'pet-migrate-accept', migrationId }
//   { type: 'pet-migrate-reject', migrationId }
//   { type: 'pet-recall-request', migrationId }
//   { type: 'pet-recall-ack', migrationId }

let myPeerCode = null;
let peer = null;
let activeConnection = null;   // the current friend's DataConnection, or null
let connectionState = 'idle';  // 'idle' | 'connecting' | 'connected' | 'error'
let connectedFriendCode = null;
let connectionError = null;

let awayPets = [];   // pets *I* sent to a friend: [{ migrationId, speciesId }]
// Guest pets live directly in the `pets[]` array with isGuest=true —
// see makePet()'s isGuest/guestOwner/migrationId fields.

function reportFriendsStatus() {
  ipcRenderer.send('friends:status-update', {
    myCode: myPeerCode,
    state: connectionState,
    friendCode: connectedFriendCode,
    error: connectionError,
    awayPets: awayPets.map(p => ({ migrationId: p.migrationId, speciesId: p.speciesId })),
    guestPets: pets
      .filter(p => p.isGuest)
      .map(p => ({ migrationId: p.migrationId, speciesId: p.speciesId, guestOwner: p.guestOwner }))
  });
  updateFriendBadge();
}

const friendBadge = document.getElementById('friend-status-badge');
function updateFriendBadge() {
  if (connectionState === 'connected') {
    friendBadge.textContent = `♦ Connected to ${connectedFriendCode}`;
    friendBadge.style.display = 'block';
  } else if (connectionState === 'connecting') {
    friendBadge.textContent = `Connecting to ${connectedFriendCode}...`;
    friendBadge.style.display = 'block';
  } else {
    friendBadge.style.display = 'none';
  }
}

function initPeer(code) {
  myPeerCode = code;
  peer = new Peer(code, { debug: 1 });

  peer.on('open', () => {
    console.log('[renderer.js] PeerJS ready. My code:', myPeerCode);
    reportFriendsStatus();
  });

  peer.on('error', (err) => {
    console.error('[renderer.js] PeerJS error:', err);
    connectionState = 'error';
    connectionError = err.type || String(err);
    reportFriendsStatus();
  });

  peer.on('connection', (conn) => {
    // Someone is trying to connect to us — ask for explicit consent
    // before accepting anything from them (per spec: both sides must
    // approve the connection).
    ipcRenderer.invoke('show-confirm-dialog', {
      title: 'Incoming Friend Request',
      message: `"${conn.peer}" wants to connect. Accept?`
    }).then((accepted) => {
      if (accepted) {
        setupConnection(conn);
      } else {
        conn.close();
      }
    });
  });
}

function connectToFriend(code) {
  if (!peer || connectionState === 'connected' || connectionState === 'connecting') return;
  connectionState = 'connecting';
  connectedFriendCode = code;
  connectionError = null;
  reportFriendsStatus();

  const conn = peer.connect(code, { reliable: true });
  setupConnection(conn);
}

function setupConnection(conn) {
  activeConnection = conn;
  connectedFriendCode = conn.peer;

  conn.on('open', () => {
    connectionState = 'connected';
    connectionError = null;
    reportFriendsStatus();
  });

  conn.on('data', (data) => handleP2PMessage(data));

  conn.on('close', () => {
    handleDisconnect();
  });

  conn.on('error', (err) => {
    console.error('[renderer.js] Connection error:', err);
    connectionState = 'error';
    connectionError = String(err);
    reportFriendsStatus();
  });
}

function handleDisconnect() {
  activeConnection = null;
  connectionState = 'idle';
  connectedFriendCode = null;

  // Bring home any pets that were away visiting — the connection is gone,
  // so they can't stay "visiting" anywhere.
  for (const away of awayPets) {
    addPet(away.speciesId, true);
  }
  awayPets = [];

  // Remove any guest pets that were visiting us — they belong on their
  // owner's screen, not stranded here with a dead connection.
  pets = pets.filter(p => !p.isGuest);

  reportFriendsStatus();
}

function sendP2P(message) {
  if (activeConnection && connectionState === 'connected') {
    activeConnection.send(message);
  }
}

function handleP2PMessage(msg) {
  console.log('[renderer.js] P2P message received:', msg);

  if (msg.type === 'pet-migrate-request') {
    ipcRenderer.invoke('show-confirm-dialog', {
      title: 'Incoming Pet',
      message: `${connectedFriendCode} wants to send a pet (${msg.speciesId}) to visit your desktop. Accept?`
    }).then((accepted) => {
      if (accepted) {
        addGuestPet(msg.speciesId, msg.migrationId, msg.ownerCode);
        sendP2P({ type: 'pet-migrate-accept', migrationId: msg.migrationId });
      } else {
        sendP2P({ type: 'pet-migrate-reject', migrationId: msg.migrationId });
      }
    });
  } else if (msg.type === 'pet-migrate-accept') {
    reportFriendsStatus(); // already removed locally when sent — just refresh UI
  } else if (msg.type === 'pet-migrate-reject') {
    const away = awayPets.find(p => p.migrationId === msg.migrationId);
    if (away) {
      awayPets = awayPets.filter(p => p.migrationId !== msg.migrationId);
      addPet(away.speciesId, true); // bring it back home
      reportFriendsStatus();
    }
  } else if (msg.type === 'pet-recall-request') {
    // Friend wants their visiting pet back.
    pets = pets.filter(p => p.migrationId !== msg.migrationId || !p.isGuest);
    sendP2P({ type: 'pet-recall-ack', migrationId: msg.migrationId });
    reportFriendsStatus();
  } else if (msg.type === 'pet-recall-ack') {
    const away = awayPets.find(p => p.migrationId === msg.migrationId);
    if (away) {
      awayPets = awayPets.filter(p => p.migrationId !== msg.migrationId);
      addPet(away.speciesId, true);
      reportFriendsStatus();
    }
  } else if (msg.type === 'chat') {
    const pet = pets.find(p => p.migrationId === msg.migrationId);
    if (pet) {
      pet.chatText = msg.text;
      pet.chatExpiresAt = performance.now() + 4000;
    }
  }
}

function sendPetToFriend(pet) {
  if (connectionState !== 'connected') return;
  const migrationId = `${myPeerCode}-${Date.now()}`;
  awayPets.push({ migrationId, speciesId: pet.speciesId });
  pets = pets.filter(p => p.id !== pet.id);
  sendP2P({ type: 'pet-migrate-request', migrationId, speciesId: pet.speciesId, ownerCode: myPeerCode });
  reportFriendsStatus();
}

function sendGuestPetHome(pet) {
  sendP2P({ type: 'pet-recall-request', migrationId: pet.migrationId });
  pets = pets.filter(p => p.id !== pet.id);
  reportFriendsStatus();
}

function addGuestPet(speciesId, migrationId, guestOwner) {
  const pet = makePet(speciesId);
  pet.isGuest = true;
  pet.migrationId = migrationId;
  pet.guestOwner = guestOwner;
  pets.push(pet);
  reportFriendsStatus();
}

// --- IPC from the Friends window (relayed through main.js) ---
ipcRenderer.on('friends:connect-request', (event, code) => connectToFriend(code));
ipcRenderer.on('friends:disconnect-request', () => {
  if (activeConnection) activeConnection.close();
  handleDisconnect();
});
ipcRenderer.on('friends:recall-request', (event, migrationId) => {
  sendP2P({ type: 'pet-recall-request', migrationId });
});
ipcRenderer.on('friends:send-home-request', (event, migrationId) => {
  const pet = pets.find(p => p.migrationId === migrationId && p.isGuest);
  if (pet) sendGuestPetHome(pet);
});
ipcRenderer.on('friends:request-status', () => reportFriendsStatus());



const petMenu = document.getElementById('pet-menu');
const chatPanel = document.getElementById('chat-panel');
const chatInput = document.getElementById('chat-input');

let menuOpen = false;
let menuTargetPet = null;
let chatOpen = false;
let chatTargetPet = null;
let controlledPet = null; // pet currently in keyboard "Control" mode

function hideAllPanels() {
  petMenu.style.display = 'none';
  chatPanel.style.display = 'none';
  menuOpen = false;
  chatOpen = false;
  menuTargetPet = null;
  chatTargetPet = null;
  const stillHovering = !!petAtPoint(mouseX, mouseY);
  setWindowInteractive(stillHovering);
}

const sendFriendBtn = document.getElementById('send-friend-btn');
const sendHomeBtn = document.getElementById('send-home-btn');

function openPetMenu(pet, screenX, screenY) {
  hideAllPanels();
  menuTargetPet = pet;
  menuOpen = true;
  petMenu.style.left = `${screenX}px`;
  petMenu.style.top = `${screenY}px`;

  // "Send to Friend" only makes sense for your own pets while connected.
  // "Send Home" only makes sense for a guest pet visiting you.
  sendFriendBtn.style.display = (!pet.isGuest && connectionState === 'connected') ? 'block' : 'none';
  sendHomeBtn.style.display = pet.isGuest ? 'block' : 'none';

  petMenu.style.display = 'flex';
  setWindowInteractive(true); // force interactive while the menu is open
}

function openChatPanel(pet, screenX, screenY) {
  hideAllPanels();
  chatTargetPet = pet;
  chatOpen = true;
  chatPanel.style.left = `${screenX}px`;
  chatPanel.style.top = `${screenY}px`;
  chatPanel.style.display = 'block';
  setWindowInteractive(true);
  chatInput.value = '';
  setTimeout(() => chatInput.focus(), 0);
}

function enterControlMode(pet) {
  hideAllPanels();
  if (controlledPet) controlledPet.isControlled = false;
  controlledPet = pet;
  pet.isControlled = true;
  pet.isDragging = false;
  pet.eventAnimation = null;
  pet.state = 'idle';
  pet.currentFrame = 0;
  pet.controlMoveDir = 0; // -1 left, 0 still, 1 right
}

function exitControlMode() {
  if (!controlledPet) return;
  controlledPet.isControlled = false;
  controlledPet.state = 'idle';
  controlledPet.stateTimer = 0;
  controlledPet.stateDuration = randomDuration();
  controlledPet = null;
}

petMenu.addEventListener('click', (e) => {
  const action = e.target.dataset.action;
  if (!action || !menuTargetPet) return;
  const pet = menuTargetPet;

  if (action === 'chat') {
    const rect = petMenu.getBoundingClientRect();
    openChatPanel(pet, rect.left, rect.top);
  } else if (action === 'animate') {
    triggerClickReaction(pet);
    hideAllPanels();
  } else if (action === 'control') {
    enterControlMode(pet);
  } else if (action === 'send-friend') {
    sendPetToFriend(pet);
    hideAllPanels();
  } else if (action === 'send-home') {
    sendGuestPetHome(pet);
    hideAllPanels();
  }
});

chatInput.addEventListener('keydown', (e) => {
  e.stopPropagation(); // don't let arrow-key control mode swallow typed keys
  if (e.key === 'Enter') {
    const text = chatInput.value.trim();
    if (text && chatTargetPet) {
      chatTargetPet.chatText = text;
      chatTargetPet.chatExpiresAt = performance.now() + 4000; // fades after 4s
    }
    hideAllPanels();
  } else if (e.key === 'Escape') {
    hideAllPanels();
  }
});

// Clicking anywhere outside an open panel closes it.
window.addEventListener('mousedown', (e) => {
  if (!menuOpen && !chatOpen) return;
  if (petMenu.contains(e.target) || chatPanel.contains(e.target)) return;
  hideAllPanels();
}, true);

// --- Arrow key / WASD control mode ---
window.addEventListener('keydown', (e) => {
  if (chatOpen) return; // chat input handles its own keys

  if (e.key === 'Escape' && controlledPet) {
    exitControlMode();
    return;
  }
  if (!controlledPet) return;

  if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
    controlledPet.controlMoveDir = -1;
  } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
    controlledPet.controlMoveDir = 1;
  } else if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W' || e.key === ' ') {
    // "Jump" — play the Jump animation once in place, if the species has one.
    const species = SPECIES[controlledPet.speciesId];
    if (species && species.animations['Jump'] && controlledPet.state !== 'jumping') {
      controlledPet.state = 'jumping';
      controlledPet.currentFrame = 0;
      controlledPet.lastFrameTime = 0;
    }
  }
});

window.addEventListener('keyup', (e) => {
  if (!controlledPet) return;
  if (['ArrowLeft', 'a', 'A', 'ArrowRight', 'd', 'D'].includes(e.key)) {
    controlledPet.controlMoveDir = 0;
  }
});

window.addEventListener('mousemove', (e) => {
  mouseX = e.clientX;
  mouseY = e.clientY;

  if (draggingPet) {
    draggingPet.x = mouseX - dragOffsetX;
    draggingPet.y = mouseY - dragOffsetY;

    // Keep the pet fully on-screen while being dragged.
    const b = getPetBounds(draggingPet);
    draggingPet.x = Math.max(0, Math.min(canvas.width - b.w, draggingPet.x));
    draggingPet.y = Math.max(0, Math.min(canvas.height - b.h, draggingPet.y));
    return;
  }

  if (menuOpen || chatOpen) return; // keep window interactive while a panel is open

  const hovered = petAtPoint(mouseX, mouseY);
  setWindowInteractive(!!hovered);
});

window.addEventListener('mousedown', (e) => {
  const target = petAtPoint(mouseX, mouseY);
  if (!target) return;

  draggingPet = target;
  dragStartX = mouseX;
  dragStartY = mouseY;
  dragOffsetX = mouseX - target.x;
  dragOffsetY = mouseY - target.y;

  // Cancel any in-progress event/walk so the pet doesn't fight being held.
  draggingPet.eventAnimation = null;
  draggingPet.state = 'idle';
  draggingPet.currentFrame = 0;
  draggingPet.isDragging = true;

  canvas.style.cursor = 'grabbing';
});

window.addEventListener('mouseup', () => {
  if (!draggingPet) return;

  const movedDist = Math.hypot(mouseX - dragStartX, mouseY - dragStartY);
  const pet = draggingPet;
  draggingPet = null;
  pet.isDragging = false;

  if (movedDist < DRAG_CLICK_THRESHOLD_PX) {
    // Barely moved — treat as a click: open the pixel action menu.
    openPetMenu(pet, mouseX, mouseY);
    return; // openPetMenu already sets interactivity/cursor as needed
  } else {
    // Dropped after a real drag — settle onto whichever monitor's floor
    // it was released over, then resume normal wandering from there.
    const displaySize = BASE_DISPLAY_SIZE * currentDisplayScale();
    pet.y = floorYForX(pet.x) - displaySize;
    pet.state = 'idle';
    pet.stateTimer = 0;
    pet.stateDuration = randomDuration();
  }

  const stillHovering = !!petAtPoint(mouseX, mouseY);
  canvas.style.cursor = stillHovering ? 'grab' : 'default';
  setWindowInteractive(stillHovering);
});

preloadAllSpecies().then(() => {
  isReady = true;
  if (pendingRestoreSettings) {
    applyRestoredSettings(pendingRestoreSettings);
  } else if (DEFAULT_SPECIES_ID) {
    addPet(DEFAULT_SPECIES_ID, true);
  } else {
    console.error('[renderer.js] No species found at all — check assets/Characters folder structure.');
  }
  requestAnimationFrame(tick);
}).catch(err => console.error('Failed to preload species:', err));