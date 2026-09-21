// settings.js — single source of truth for the settings schema.
//
// Previously every setting was declared ~6 times (main.js vars, renderer.js
// vars, DEFAULT_SETTINGS, saveSettings(), the settings-changed handler, the
// apply-settings handler). This module defines each setting exactly once along
// with its type + range, so loading, sanitizing, and persisting all go through
// the same code path.
//
// Requires Node's crypto, so this module is main-process only (the renderer
// never loads it — it receives already-sanitized values over IPC).

const crypto = require('crypto');

// Digit/letter set that avoids look-alikes (no 0/O/1/I) — matches the
// friend-code format rendered in the Friends window.
const PEER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PEER_CODE_LENGTH = 6;
const PEER_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;

// Cryptographically-secure friend-code generation (replaces the old
// Math.random() version, which was duplicated in main.js + renderer.js).
// 6 chars × 32-symbol alphabet ≈ 1.07B combinations, drawn from 6 random
// bytes with byte % 32 (256 % 32 === 0, so no modulo bias).
function generatePeerCode() {
  const bytes = crypto.randomBytes(PEER_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < PEER_CODE_LENGTH; i++) {
    code += PEER_CODE_ALPHABET[bytes[i] % PEER_CODE_ALPHABET.length];
  }
  return code;
}

function isValidPeerCode(code) {
  return typeof code === 'string' && PEER_CODE_RE.test(code);
}

function sanitizePeerCode(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toUpperCase();
  return PEER_CODE_RE.test(trimmed) ? trimmed : null;
}

// Documented numeric ranges (mirror the slider min/max in settings.html).
const RANGES = Object.freeze({
  sizePercent: { min: 20, max: 200 },
  speedPercent: { min: 20, max: 300 },
  masterVolume: { min: 0, max: 1 }
});

const DEFAULT_SETTINGS = Object.freeze({
  // Pet roster entries are PROFILES: { speciesId, name?, x? } (kept flexible so
  // custom names + screen positions survive relaunch). Old string-only entries
  // are still accepted by sanitizeSettings and upgraded on load.
  activePets: [{ speciesId: 'GingerCat', name: null }],
  isPaused: false,
  sizePercent: 100,
  speedPercent: 100,
  isMuted: true,
  masterVolume: 0.5,
  myPeerCode: null,
  autoLaunch: false,
  dndEnabled: true,
  walkOnBorders: false,
  reduceMotion: false,
  highContrast: false,
  largerSprites: false,
  showOverApps: true
});

const FALLBACK_SPECIES_ID = DEFAULT_SETTINGS.activePets[0].speciesId;

const BOOLEAN_KEYS = new Set([
  'isPaused',
  'isMuted',
  'autoLaunch',
  'dndEnabled',
  'walkOnBorders',
  'reduceMotion',
  'highContrast',
  'largerSprites',
  'showOverApps'
]);

// Clamp a value into [min, max]; any non-finite / wrong-type input falls back.
// Note Number(true) === 1, so booleans are explicitly rejected.
function clampNum(value, min, max, fallback) {
  if (typeof value === 'boolean') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

// Merge raw (possibly corrupt / attacker-injected) settings over the defaults,
// clamping numerics to their documented ranges, coercing booleans, and
// validating strings. Always returns a fully-typed settings object with every
// default key present. This is the settings-integrity gate for the world-
// readable settings.json file.
function sanitizeSettings(raw) {
  const out = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) out[key] = DEFAULT_SETTINGS[key];
  if (!raw || typeof raw !== 'object') return out;

  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const value = raw[key];
    if (value === undefined) continue;

    if (key === 'sizePercent' || key === 'speedPercent') {
      out[key] = clampNum(value, RANGES[key].min, RANGES[key].max, DEFAULT_SETTINGS[key]);
    } else if (key === 'masterVolume') {
      out[key] = clampNum(
        value,
        RANGES.masterVolume.min,
        RANGES.masterVolume.max,
        DEFAULT_SETTINGS[key]
      );
    } else if (BOOLEAN_KEYS.has(key)) {
      out[key] = value === true || value === 'true';
    } else if (key === 'activePets') {
      // Accept both legacy strings AND profile objects ({ speciesId, name?, x? }).
      // Names are capped at 40 chars; positions kept only if they're finite
      // numbers (the renderer re-clamps them to the live canvas bounds).
      const rawList = Array.isArray(value) ? value : [];
      const cleaned = [];
      for (const entry of rawList) {
        let speciesId = '';
        let name = null;
        let x = null;
        if (typeof entry === 'string') {
          speciesId = entry;
        } else if (entry && typeof entry === 'object' && typeof entry.speciesId === 'string') {
          speciesId = entry.speciesId;
          if (entry.name != null) name = String(entry.name).slice(0, 40);
          if (typeof entry.x === 'number' && Number.isFinite(entry.x)) x = entry.x;
        }
        if (!speciesId || speciesId.length > 64) continue;
        const prof = { speciesId };
        if (name) prof.name = name;
        if (x != null) prof.x = x;
        cleaned.push(prof);
      }
      out[key] =
        cleaned.length > 0
          ? cleaned.slice(0, 40)
          : [{ ...DEFAULT_SETTINGS.activePets[0], name: null }];
    } else if (key === 'myPeerCode') {
      out[key] = sanitizePeerCode(value);
    }
  }
  return out;
}

module.exports = {
  DEFAULT_SETTINGS,
  RANGES,
  FALLBACK_SPECIES_ID,
  generatePeerCode,
  isValidPeerCode,
  sanitizePeerCode,
  sanitizeSettings,
  clampNum,
  PEER_CODE_RE
};
