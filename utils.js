// utils.js — dependency-free helpers used by the renderer (loaded as a classic
// <script>, functions attach to window) AND by the Node test runner (module
// exports). Nothing here touches the DOM or Electron, so it can run anywhere.
//
// Keeping these pure (environment passed in as args / locals) is what makes
// them unit-testable without a browser.

function clampNum(value, min, max, fallback) {
  if (typeof value === 'boolean') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

// File-name → behavior mapping (see PROJECT-STATUS.md "Species / animation
// system"). Pure: a species' animations are classified purely by file name.
function animationBehavior(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('idle')) return 'idle';
  if (n.includes('walk')) return 'walk';
  if (n.includes('run')) return 'run';
  if (n.startsWith('charge')) return 'charge';
  if (n.includes('jump')) return 'jump';
  if (n.includes('attack')) return 'attack';
  if (n.includes('hurt')) return 'flinch';
  if (n.includes('dead')) return 'fall';
  return 'special';
}

// floorYForX with an explicit environment, so the browser wrapper can bind in
// the live globals and the tests can pass a plain object. Generic pure logic:
// given an x, return the y a pet's feet should rest on.
function floorYForXState(x, env) {
  const { displays, walkOnBorders, foregroundWindow, canvasHeight } = env;

  // "Walk on window edges" mode: the focused window's top edge is the floor.
  if (
    walkOnBorders &&
    foregroundWindow &&
    x >= foregroundWindow.x &&
    x < foregroundWindow.x + foregroundWindow.width
  ) {
    return foregroundWindow.y;
  }

  for (const d of displays) {
    if (x >= d.x && x < d.x + d.width) {
      return d.workAreaY + d.workAreaHeight;
    }
  }

  // x landed exactly on the right edge of the rightmost monitor (after a
  // left-to-right wrap) — snap to that monitor's floor.
  if (displays.length > 0) {
    const rightmost = displays.reduce((a, b) => (a.x + a.width >= b.x + b.width ? a : b));
    if (x >= rightmost.x + rightmost.width) {
      return rightmost.workAreaY + rightmost.workAreaHeight;
    }
  }
  return canvasHeight;
}

// Size % scaling combined with the "larger sprites" multiplier and screen-
// relative scaling — the single place pets derive their draw height from.
function currentDisplaySizeState(sizePercent, largerSprites, screenScale) {
  const BASE_DISPLAY_SIZE = 96;
  const sizeScale = clampNum(sizePercent, 1, 1000, 100) / 100;
  return (
    BASE_DISPLAY_SIZE * (largerSprites ? 1.5 : 1) * sizeScale * clampNum(screenScale, 0.1, 10, 1)
  );
}

// Greedy word wrap for canvas-drawn labels. `measure(text)` must return the
// rendered width of a string (browser: ctx.measureText; tests: a stub).
function wrapTextLines(text, maxWidth, measure) {
  const words = String(text || '')
    .split(/\s+/)
    .filter(w => w.length > 0);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measure(candidate) <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// Validate + sanitize an untrusted P2P message received from a remote peer.
// Returns a safe, normalized message object, or null if it's malformed.
// `knownSpecies` is the renderer's SPECIES map (pet-migrate-request targets
// must reference a species that actually exists locally).
function sanitizeP2PMessage(raw, knownSpecies) {
  if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') return null;

  const VALID_TYPES = [
    'chat',
    'chat-echo',
    'pet-migrate-request',
    'pet-migrate-accept',
    'pet-migrate-reject',
    'pet-recall-request',
    'pet-recall-ack'
  ];
  if (!VALID_TYPES.includes(raw.type)) return null;

  const msg = { type: raw.type };
  msg.migrationId = typeof raw.migrationId === 'string' ? raw.migrationId.slice(0, 64) : '';

  if (msg.type === 'chat') {
    if (typeof raw.text !== 'string') return null;
    msg.text = raw.text.slice(0, 40); // cap length — no canvas overflow via huge text
  } else if (msg.type === 'chat-echo') {
    // A chat sent THROUGH a guest pet, echoed back to its owner. Must name a
    // migration the owner actually sent away, and carry displayable text.
    if (!msg.migrationId || typeof raw.text !== 'string') return null;
    msg.text = raw.text.slice(0, 40);
  } else if (msg.type === 'pet-migrate-request') {
    const speciesId = typeof raw.speciesId === 'string' ? raw.speciesId : '';
    if (!knownSpecies || !knownSpecies[speciesId]) return null;
    msg.speciesId = speciesId;
    const ownerCode = typeof raw.ownerCode === 'string' ? raw.ownerCode.trim().toUpperCase() : '';
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(ownerCode)) return null;
    msg.ownerCode = ownerCode;
  }
  return msg;
}

// Keep ONE source of truth for the human-friendly name mapping without
// copying the CSS values around.
const UI_COLORS = Object.freeze({
  nameLabel: '#a0a0ff',
  guestNameplate: '#7CFC00',
  controlling: '#ffe66d'
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    clampNum,
    animationBehavior,
    floorYForXState,
    currentDisplaySizeState,
    wrapTextLines,
    sanitizeP2PMessage,
    UI_COLORS
  };
}
