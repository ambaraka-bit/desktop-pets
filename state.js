// state.js — every piece of mutable shared state for the overlay window's
// renderer, plus the constant tables. Loaded FIRST (after howler/peerjs and
// utils.js) so the sibling modules (pet-ai.js, renderer-draw.js, p2p.js,
// interaction.js, renderer.js) can all reference the same globals.
//
// Browser-only (this file isn't loaded by Node's test runner; the pure logic
// that IS tested lives in utils.js).

const canvas = document.getElementById('pet-canvas');
const ctx = canvas.getContext('2d');

canvas.width = window.innerWidth || 1920;
canvas.height = window.innerHeight || 1080;

// --- Screen-relative scale factor (1.0 at 1080p baseline) ---
let screenScale = canvas.height / 1080;
document.documentElement.style.setProperty('--s', screenScale);

function updateCanvasSize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (w > 0 && h > 0) {
    canvas.width = w;
    canvas.height = h;
  }
  applyScreenScale();
}

function applyScreenScale() {
  screenScale = canvas.height / 1080;
  document.documentElement.style.setProperty('--s', screenScale);
}

// --- Multi-monitor layout (sent from main.js — see computeVirtualDesktop) ---
let displays = [];

// --- Species registry (populated at boot from main via 'species:scan') ---
let SPECIES = {};
let DEFAULT_SPECIES_ID = null;

// --- Per-app cap on on-screen pets (overridden from main's MAX_PETS) ---
let maxPets = 20;

// --- Settings (main is the source of truth; these are the applied copies) ---
let sizePercent = 100;
let speedPercent = 100;
let isMuted = true;
let masterVolume = 0.5;
let isPaused = false;
let reduceMotion = false; // accessibility: no walking, no surprise events
let highContrast = false; // accessibility: dark outline around pets
let largerSprites = false; // accessibility: 150% sprite scale
let walkOnBorders = false; // pets walk along the focused window's top edge
let showOverApps = true; // mirror of main's toggle (bookkeeping only here)

// Focused-window geometry from the main-process foreground watcher,
// in local canvas coords. null = no usable focused window right now.
let foregroundWindow = null;

// --- Sizing / speed / animation constants ---
const BASE_DISPLAY_SIZE = 96; // pets are drawn at this height (px) before % scaling
const BASE_WALK_SPEED_PX = 1.5;
const FRAME_DURATION_MS = 260;
const FRAME_DURATION_WALK_MS = 180;
const FRAME_DURATION_RUN_MS = 90;
const FRAME_DURATION_CHARGE_MS = 80;

// Defensive clamp bounds applied to every settings value that reaches the
// renderer (mirrors main's RANGES — same numbers, enforced client-side too so
// a tampered/legacy settings.json can never OOM the canvas or freeze pets).
const SIZE_PERCENT_MIN = 20;
const SIZE_PERCENT_MAX = 200;
const SIZE_PERCENT_DEFAULT = 100;
const SPEED_PERCENT_MIN = 20;
const SPEED_PERCENT_MAX = 300;
const SPEED_PERCENT_DEFAULT = 100;
const MAX_PETS_LIMIT = 20; // hard ceiling (main's MAX_PETS — also enforced there)
const MAX_PETS_DEFAULT = 1; // fresh-install fallback if payload has no maxPets

// Jump physics (per ~16ms tick, matching the other timers).
const JUMP_VELOCITY_BASE = -12; // base upward px/tick on jump start (at 1080p)
const JUMP_GRAVITY_BASE = 0.45; // base downward acceleration px/tick² while airborne
const JUMP_MAX_FALL_BASE = 14; // base terminal fall speed

// Double-press detection for triggering run in control mode.
const DOUBLE_PRESS_THRESHOLD_MS = 300;
let lastDirectionPressTime = { left: 0, right: 0 };

// Number-key held animation (control mode): the animation name being looped
// while the user holds a number key, or null when released.
let heldEventAnimation = null;

// Surprise-event cadence.
const EVENT_MIN_INTERVAL_MS = 8000;
const EVENT_MAX_INTERVAL_MS = 20000;
const EVENT_TRIGGER_CHANCE = 0.5;

let nextPetId = 1;
let pets = [];
let awayPets = []; // pets *I* sent to a friend: [{ migrationId, speciesId, name, friendCode, sentAt }]

// --- P2P state (see p2p.js) ---
let myPeerCode = null;
let peer = null;
// Multiple simultaneous friends: EVERY live peer connection lives here
// (friendCode -> { conn, state: 'connecting' | 'connected' }).
const friendConnections = new Map();
// The "primary" friend is the most recently connected one — what the status
// badge + Friends window show, and the target of "Send to Friend".
let activeConnection = null;
let connectionState = 'idle'; // 'idle' | 'connecting' | 'connected' | 'error'
let connectedFriendCode = null;
let connectionError = null;
let peerRecovering = false;
const connectionTimeouts = new Map(); // friendCode -> setTimeout handle
const migrationTimeouts = new Map(); // migrationId -> setTimeout handle

// --- Mouse / drag / panels ---
let mouseX = 0;
let mouseY = 0;
let isWindowInteractive = false;
let draggingPet = null;
let dragOffsetX = 0;
let dragOffsetY = 0;
let dragStartX = 0;
let dragStartY = 0;
const DRAG_CLICK_THRESHOLD_PX = 5;

let menuOpen = false;
let menuTargetPet = null;
let chatOpen = false;
let chatTargetPet = null;
let chatRenameMode = false; // when true the chat panel edits setName(), not a bubble
let historyOpen = false; // pet chat-log panel is showing
let historyTargetPet = null;
let controlledPet = null; // pet currently in keyboard "Control" mode

// Stable identity for a pet in the chat log: local pets by their id, guest
// pets by migrationId (each visiting pet has a unique transfer).
function petKey(pet) {
  return pet && pet.isGuest ? `g:${pet.migrationId}` : `p:${pet ? pet.id : '?'}`;
}

// --- Chat history (pet menu → HISTORY) ---
// Rolling log of messages said by/to pets; capped so it can't grow forever.
// Entries: { key, label, text, ts } — key identifies the pet (id for local,
// migrationId-prefixed for guests / remote echoes).
const chatHistory = [];
function recordChatEntry(key, label, text) {
  chatHistory.push({ key, label, text: String(text || '').slice(0, 40), ts: Date.now() });
  if (chatHistory.length > 30) chatHistory.splice(0, chatHistory.length - 30);
}

// --- Sounds (Howler; loaded via <script> in index.html) ---
const footstepSound = new Howl({ src: ['assets/sounds/footstep.wav'], volume: 1.0 });
const idleSound = new Howl({ src: ['assets/sounds/idle.wav'], volume: 1.0 });

// Sound playback wrapped in try/catch: a missing/corrupt file must never
// throw and take down the render loop.
function playSound(sound) {
  if (isMuted || !sound) return;
  try {
    sound.volume(masterVolume);
    sound.play();
  } catch (err) {
    console.warn('[renderer] Sound playback failed:', err);
  }
}

// --- Size / speed helpers, bound to live state ---
// The pure, testable cores live in utils.js; these are thin bindings.
function currentDisplaySize() {
  return currentDisplaySizeState(sizePercent, largerSprites, screenScale);
}

function currentWalkSpeed() {
  const speedScale = clampNum(speedPercent, 1, 3000, 100) / 100;
  return BASE_WALK_SPEED_PX * speedScale * screenScale;
}

function floorYForX(x) {
  return floorYForXState(x, {
    displays,
    walkOnBorders,
    foregroundWindow,
    canvasHeight: canvas.height
  });
}

function randomEventInterval() {
  return EVENT_MIN_INTERVAL_MS + Math.random() * (EVENT_MAX_INTERVAL_MS - EVENT_MIN_INTERVAL_MS);
}

function randomDuration() {
  return 2000 + Math.random() * 3000;
}
