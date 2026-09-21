// core.test.js — unit tests for the dependency-free logic in utils.js
// (shared with the renderer) and settings.js (main-process schema).
//
// Run with: npm test  (node --test tests/)

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  clampNum,
  animationBehavior,
  floorYForXState,
  currentDisplaySizeState,
  wrapTextLines,
  sanitizeP2PMessage
} = require('../utils.js');
const {
  DEFAULT_SETTINGS,
  RANGES,
  generatePeerCode,
  isValidPeerCode,
  sanitizePeerCode,
  sanitizeSettings,
  clampNum: settingsClampNum
} = require('../settings.js');

// ---------------------------------------------------------------------------
// clampNum
// ---------------------------------------------------------------------------

test('clampNum clamps into range and rejects bad input', () => {
  assert.equal(clampNum(150, 20, 200, 100), 150);
  assert.equal(clampNum(10, 20, 200, 100), 20); // clamps to lower bound
  assert.equal(clampNum(999, 20, 200, 100), 200); // clamps to upper bound
  assert.equal(clampNum('75', 20, 200, 100), 75);
  assert.equal(clampNum(null, 20, 200, 100), 20); // Number(null)===0 → clamps to min
  assert.equal(clampNum(undefined, 20, 200, 100), 100); // not finite → fallback
  assert.equal(clampNum(NaN, 20, 200, 100), 100);
  assert.equal(clampNum(Infinity, 20, 200, 100), 100);
  assert.equal(clampNum(true, 20, 200, 100), 100);
});

// ---------------------------------------------------------------------------
// animationBehavior (file-name → behavior, the species system's core)
// ---------------------------------------------------------------------------

test('animationBehavior maps file names to behaviors', () => {
  assert.equal(animationBehavior('Idle.png'), 'idle');
  assert.equal(animationBehavior('Walk.png'), 'walk');
  assert.equal(animationBehavior('Run.png'), 'run');
  assert.equal(animationBehavior('Charge.png'), 'charge');
  assert.equal(animationBehavior('Charge_1.png'), 'charge');
  assert.equal(animationBehavior('Jump.png'), 'jump');
  assert.equal(animationBehavior('Attack_1.png'), 'attack');
  assert.equal(animationBehavior('Hurt.png'), 'flinch');
  assert.equal(animationBehavior('Dead.png'), 'fall');
  assert.equal(animationBehavior('Fireball.png'), 'special');
  assert.equal(animationBehavior('Flame_jet.png'), 'special');
  assert.equal(animationBehavior(''), 'special');
});

test('animationBehavior handles species-name prefixed sheets (GingerCat)', () => {
  // GingerCat's sheets carry the species name as a prefix (GingerCatIdle.png,
  // GingerCatPunch.png, …) instead of bare behavior names. The substring
  // matching must still classify them, and the "special" sheets (Angry/Punch)
  // must NOT accidentally hit idle/walk/run/jump.
  assert.equal(animationBehavior('GingerCatIdle.png'), 'idle');
  assert.equal(animationBehavior('GingerCatWalk.png'), 'walk');
  assert.equal(animationBehavior('GingerCatRun.png'), 'run');
  assert.equal(animationBehavior('GingerCatJump.png'), 'jump');
  assert.equal(animationBehavior('GingerCatAngry.png'), 'special');
  assert.equal(animationBehavior('GingerCatPunch.png'), 'special');
  assert.equal(animationBehavior('GingerCatKick.png'), 'special');
  assert.equal(animationBehavior('GingerCatLaugh.png'), 'special');
  assert.equal(animationBehavior('GingerCatSad.png'), 'special');
  assert.equal(animationBehavior('GingerCatSleep.png'), 'special');
});

// ---------------------------------------------------------------------------
// floorYForXState
// ---------------------------------------------------------------------------

const twoDisplays = [
  {
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    workAreaX: 0,
    workAreaY: 0,
    workAreaWidth: 1920,
    workAreaHeight: 1040
  },
  {
    x: 1920,
    y: 0,
    width: 1280,
    height: 1024,
    workAreaX: 1920,
    workAreaY: 0,
    workAreaWidth: 1280,
    workAreaHeight: 1000
  }
];

test('floorYForXState uses each display work area bottom as its floor', () => {
  assert.equal(
    floorYForXState(0, {
      displays: twoDisplays,
      walkOnBorders: false,
      foregroundWindow: null,
      canvasHeight: 1080
    }),
    1040
  );
  assert.equal(
    floorYForXState(1920, {
      displays: twoDisplays,
      walkOnBorders: false,
      foregroundWindow: null,
      canvasHeight: 1080
    }),
    1000
  );
});

test('floorYForXState falls back to canvas bottom for monitor gaps', () => {
  assert.equal(
    floorYForXState(2000, {
      displays: twoDisplays,
      walkOnBorders: false,
      foregroundWindow: null,
      canvasHeight: 1080
    }),
    1000
  );
  assert.equal(
    floorYForXState(-50, {
      displays: twoDisplays,
      walkOnBorders: false,
      foregroundWindow: null,
      canvasHeight: 1000
    }),
    1000
  );
});

test('floorYForXState snaps right-edge wrap to the rightmost monitor floor', () => {
  assert.equal(
    floorYForXState(3200, {
      displays: twoDisplays,
      walkOnBorders: false,
      foregroundWindow: null,
      canvasHeight: 1080
    }),
    1000
  );
});

test('floorYForXState walks along the focused window top edge when enabled', () => {
  const env = {
    displays: twoDisplays,
    walkOnBorders: true,
    foregroundWindow: { x: 100, y: 300, width: 800, height: 600 },
    canvasHeight: 1080
  };
  assert.equal(floorYForXState(500, env), 300);
  assert.equal(floorYForXState(0, env), 1040); // outside window → normal floor
  assert.equal(floorYForXState(2000, env), 1000);
});

// ---------------------------------------------------------------------------
// currentDisplaySizeState
// ---------------------------------------------------------------------------

test('currentDisplaySizeState scales size% and larger-sprites multiplier', () => {
  assert.equal(currentDisplaySizeState(100, false, 1), 96);
  assert.equal(currentDisplaySizeState(50, false, 1), 48);
  assert.equal(currentDisplaySizeState(200, false, 1), 192);
  assert.equal(currentDisplaySizeState(100, true, 1), 144);
});

test('currentDisplaySizeState clamps out-of-range inputs', () => {
  assert.equal(currentDisplaySizeState(5000, false, 1), 960); // size% clamped to 1000 → ×10
  assert.equal(currentDisplaySizeState(-1, false, 1), 0.96); // size% clamped to min 1 → ×0.01
  assert.equal(currentDisplaySizeState(100, false, 100), 960); // screenScale clamped to ×10
});

// ---------------------------------------------------------------------------
// wrapTextLines
// ---------------------------------------------------------------------------

const fakeMeasure = text => text.length;

test('wrapTextLines wraps words at the width limit', () => {
  assert.deepEqual(wrapTextLines('hello world this is long', 10, fakeMeasure), [
    'hello',
    'world this',
    'is long'
  ]);
});

test('wrapTextLines never splits a word longer than the box', () => {
  assert.deepEqual(wrapTextLines('supercalifragilistic', 5, fakeMeasure), ['supercalifragilistic']);
});

test('wrapTextLines handles empty / whitespace-only input', () => {
  assert.deepEqual(wrapTextLines('', 10, fakeMeasure), []);
  assert.deepEqual(wrapTextLines('   ', 10, fakeMeasure), []);
  assert.deepEqual(wrapTextLines(undefined, 10, fakeMeasure), []);
});

// ---------------------------------------------------------------------------
// sanitizeP2PMessage
// ---------------------------------------------------------------------------

test('sanitizeP2PMessage rejects non-objects and unknown types', () => {
  assert.equal(sanitizeP2PMessage(null, {}), null);
  assert.equal(sanitizeP2PMessage('hello', {}), null);
  assert.equal(sanitizeP2PMessage({}, {}), null);
  assert.equal(sanitizeP2PMessage({ type: 'exploit-me' }, {}), null);
});

test('sanitizeP2PMessage truncates chat text to 40 chars', () => {
  const msg = sanitizeP2PMessage(
    { type: 'chat', migrationId: 'a'.repeat(200), text: 'x'.repeat(500) },
    {}
  );
  assert.ok(msg);
  assert.equal(msg.text.length, 40);
  assert.equal(msg.migrationId.length, 64);
});

test('sanitizeP2PMessage rejects chat without text', () => {
  assert.equal(sanitizeP2PMessage({ type: 'chat' }, {}), null);
});

test('sanitizeP2PMessage parses chat-echo but requires migrationId + code text', () => {
  assert.equal(sanitizeP2PMessage({ type: 'chat-echo', text: 'hi' }, {}), null);
  assert.equal(sanitizeP2PMessage({ type: 'chat-echo', migrationId: 'm1' }, {}), null);
  const ok = sanitizeP2PMessage(
    { type: 'chat-echo', migrationId: 'm1', text: 'x'.repeat(500) },
    {}
  );
  assert.ok(ok);
  assert.equal(ok.text.length, 40);
  assert.equal(ok.migrationId, 'm1');
});

test('sanitizeP2PMessage validates migrate requests against known species', () => {
  assert.equal(sanitizeP2PMessage({ type: 'pet-migrate-request', speciesId: 'Nope' }, {}), null);
  assert.equal(
    sanitizeP2PMessage(
      { type: 'pet-migrate-request', speciesId: 'FireWizard', ownerCode: 'notacode!' },
      {}
    ),
    null
  );
  const ok = sanitizeP2PMessage(
    {
      type: 'pet-migrate-request',
      migrationId: 'm1',
      speciesId: 'FireWizard',
      ownerCode: 'abc234'
    },
    { FireWizard: {} }
  );
  assert.deepEqual(ok, {
    type: 'pet-migrate-request',
    migrationId: 'm1',
    speciesId: 'FireWizard',
    ownerCode: 'ABC234'
  });
});

// ---------------------------------------------------------------------------
// Friend-code generation / validation (settings.js)
// ---------------------------------------------------------------------------

test('generatePeerCode produces valid, look-alike-free codes', () => {
  for (let i = 0; i < 50; i++) {
    const code = generatePeerCode();
    assert.equal(code.length, 6);
    assert.ok(isValidPeerCode(code), `generated invalid code: ${code}`);
    assert.ok(/^[A-HJ-NP-Z2-9]{6}$/.test(code));
  }
});

test('sanitizePeerCode normalizes input', () => {
  assert.equal(sanitizePeerCode(' abcdef '), 'ABCDEF');
  assert.equal(sanitizePeerCode('abcdef'), 'ABCDEF');
  assert.equal(sanitizePeerCode('oops'), null); // contains look-alike chars (O)
  assert.equal(sanitizePeerCode('abc123'), null); // contains 1/3 mix — 1 excluded, 3 allowed... 1 blocks it
  assert.equal(sanitizePeerCode(123456), null);
  assert.equal(sanitizePeerCode(''), null);
});

// ---------------------------------------------------------------------------
// sanitizeSettings (settings-integrity gate)
// ---------------------------------------------------------------------------

test('sanitizeSettings produces a fully-typed default object for garbage input', () => {
  const s = sanitizeSettings(null);
  assert.deepEqual(s, DEFAULT_SETTINGS);
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    assert.ok(k in s);
    assert.equal(typeof s[k], typeof v);
  }
});

test('sanitizeSettings clamps numeric settings to documented ranges', () => {
  const s = sanitizeSettings({ sizePercent: 99999, speedPercent: -5, masterVolume: 42 });
  assert.equal(s.sizePercent, RANGES.sizePercent.max);
  assert.equal(s.speedPercent, RANGES.speedPercent.min);
  assert.equal(s.masterVolume, RANGES.masterVolume.max);
});

test('sanitizeSettings coerces booleans and rejects numeric impostors', () => {
  assert.equal(sanitizeSettings({ isMuted: 'true' }).isMuted, true);
  assert.equal(sanitizeSettings({ isMuted: 1 }).isMuted, false);
  assert.equal(sanitizeSettings({ reduceMotion: true }).reduceMotion, true);
});

test('sanitizeSettings cleans activePets and falls back when empty', () => {
  // Legacy strings are upgraded to profile objects.
  const upgraded = sanitizeSettings({
    activePets: ['FireWizard', 42, '', 'x'.repeat(100)]
  }).activePets;
  assert.equal(upgraded.length, 1);
  assert.deepEqual(upgraded[0], { speciesId: 'FireWizard' });
  assert.deepEqual(sanitizeSettings({ activePets: [] }).activePets, [
    DEFAULT_SETTINGS.activePets[0]
  ]);
  assert.equal(sanitizeSettings({ activePets: 'not-array' }).activePets[0].speciesId, 'GingerCat');
});

test('sanitizeSettings keeps name/x inside profiles, capping hostile values', () => {
  const ok = sanitizeSettings({
    activePets: [{ speciesId: 'LightningMage', name: 'Sparky', x: 300 }]
  }).activePets;
  assert.deepEqual(ok, [{ speciesId: 'LightningMage', name: 'Sparky', x: 300 }]);
  // Oversized names are capped at 40 chars, non-finite x is dropped. Unknown
  // species ids are kept here (settings.js has no species list) — main.js
  // prunes them after the scan.
  const bad = sanitizeSettings({
    activePets: [
      { speciesId: 'Nope', name: 'y'.repeat(500), x: Infinity },
      { speciesId: 'WandererMagican', name: 7, x: NaN }
    ]
  }).activePets;
  assert.equal(bad.length, 2);
  assert.equal(bad[0].name.length, 40);
  assert.equal(bad[0].x, undefined);
  assert.deepEqual(bad[1], { speciesId: 'WandererMagican', name: '7' });
});

test('sanitizeSettings only keeps valid peer codes', () => {
  assert.equal(sanitizeSettings({ myPeerCode: 'ABCDEF' }).myPeerCode, 'ABCDEF');
  assert.equal(sanitizeSettings({ myPeerCode: 'O0IIF' }).myPeerCode, null);
});
