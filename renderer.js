// renderer.js — boot + main-process IPC wiring (thin glue over pet-ai.js,
// renderer-draw.js, p2p.js and interaction.js). All heavy lifting lives in the
// modules loaded before this one by index.html.
//
// IPC contract (mirrors preload.js + main.js):
//   receive: restore-settings, display-info, apply-settings, add-pet,
//            remove-pet, set-paused, foreground-window, friends:* relays
//   send:    set-mouse-ignore, pets-changed, friends:status-update
//   invoke:  species:scan, generate-peer-code, show-confirm-dialog

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function currentSettingsSnapshot() {
  return {
    sizePercent,
    speedPercent,
    isMuted,
    masterVolume,
    reduceMotion,
    largerSprites,
    walkOnBorders,
    highContrast
  };
}

// Applied from `apply-settings` events (main broadcasts the full sanitized
// object after any settings mutation) and from the initial restore payload.
// Every value is clamped defensively — a tampered/buggy settings.json frame
// must never OOM the canvas or crash the drawing path.
function applySettings(changes) {
  if (!changes || typeof changes !== 'object') return;
  const merged = { ...currentSettingsSnapshot(), ...changes };

  const prevSizePercent = sizePercent;
  const prevLargerSprites = largerSprites;

  sizePercent = clampNum(
    merged.sizePercent,
    SIZE_PERCENT_MIN,
    SIZE_PERCENT_MAX,
    SIZE_PERCENT_DEFAULT
  );
  speedPercent = clampNum(
    merged.speedPercent,
    SPEED_PERCENT_MIN,
    SPEED_PERCENT_MAX,
    SPEED_PERCENT_DEFAULT
  );
  masterVolume = clampNum(merged.masterVolume, 0, 1, 1);
  isMuted = !!merged.isMuted;
  reduceMotion = !!merged.reduceMotion;
  largerSprites = !!merged.largerSprites;
  walkOnBorders = !!merged.walkOnBorders;
  highContrast = !!merged.highContrast;

  // A pet's standing position depends on its size — if the sprite size or the
  // larger-sprites multiplier changed, re-snap every pet onto its floor.
  if (sizePercent !== prevSizePercent || largerSprites !== prevLargerSprites) {
    for (const pet of pets) pet.y = floorYForX(pet.x) - currentDisplaySize();
  }

  try {
    Howler.volume(isMuted ? 0 : masterVolume);
  } catch (_) {
    /* Howler loaded via <script>; missing is non-fatal */
  }

  if (reduceMotion) {
    for (const pet of pets) applyReduceMotion(pet);
  }
}

let pendingRestore = null;
function queueRestore(payload) {
  if (!payload || typeof payload !== 'object') return;
  pendingRestore = payload;
  tryApplyPendingRestore();
}

// The overlay window only exists on screen during real user sessions.
function tryApplyPendingRestore() {
  if (!pendingRestore || !DEFAULT_SPECIES_ID) return;
  applyRestoredSettings(pendingRestore);
  pendingRestore = null;
}

function applyRestoredSettings(payload) {
  debugLog('Restoring settings + saved pets:', payload);
  applySettings(payload);

  maxPets = clampNum(payload.maxPets, 1, MAX_PETS_LIMIT, MAX_PETS_DEFAULT);
  myPeerCode = payload.myPeerCode || '';

  // Join the PeerJS network under our persisted friend code (guarded so a
  // stray second restore can't double-init). If the code turns out to be taken
  // by a stale instance, initPeer's unavailable-id handler asks main for a
  // fresh one and retries automatically.
  if (myPeerCode && !peer) initPeer(myPeerCode);

  // The persisted roster is a list of pet profiles ({ speciesId, name?, x? };
  // legacy string entries are also tolerated). Main keeps it pruned, but we
  // still double-check species against the real registry.
  const savedRoster = Array.isArray(payload.activePets) ? payload.activePets : [];
  for (const entry of savedRoster) {
    const speciesId = typeof entry === 'string' ? entry : entry && entry.speciesId;
    if (!speciesId || !SPECIES[speciesId]) {
      console.warn(`[renderer] Ignoring saved pet with unknown species ${speciesId}`);
      continue;
    }
    const opts =
      entry && typeof entry === 'object' && (entry.name || typeof entry.x === 'number')
        ? { name: entry.name, x: entry.x }
        : undefined;
    addPet(speciesId, false, opts);
  }

  if (pets.length === 0) {
    // Fresh install / all pets pruned — put the default pet on its floor.
    const pet = makePet(DEFAULT_SPECIES_ID);
    pet.y = floorYForX(pet.x) - currentDisplaySize();
    pets.push(pet);
  }

  syncPetsToMain();
}

// ---------------------------------------------------------------------------
// IPC wiring (all subscriptions registered once, before boot finishes)
// ---------------------------------------------------------------------------

function setupIPC() {
  api.on('restore-settings', queueRestore);

  api.on('display-info', info => {
    if (!info || !Array.isArray(info.displays)) return;
    displays = info.displays;
    updateCanvasSize();
    // Pets may now sit on a different monitor than before — re-snap floor
    // positions so nobody floats or sinks when displays change.
    for (const pet of pets) pet.y = floorYForX(pet.x) - currentDisplaySize();
  });

  api.on('apply-settings', applySettings);

  api.on('set-paused', paused => {
    isPaused = !!paused;
  });

  api.on('foreground-window', win => {
    // Store the focused app-window's bounds for walk-on-borders. `null` just
    // means "no reportable foreground window" — the desktop, the taskbar, or
    // OUR OWN overlay after clicking a pet (the foreground watcher in main
    // excludes our PID). It is deliberately NOT a pause signal: pets must keep
    // moving while the user interacts with the overlay. The only things that
    // freeze pets are the user's explicit pause toggle and DND auto-pause
    // (both delivered via 'set-paused'). Freezing here was the source of the
    // "click a character → every pet freezes until you click elsewhere" bug.
    foregroundWindow = win && typeof win === 'object' ? win : null;
  });

  api.on('add-pet', speciesId => {
    if (typeof speciesId !== 'string') return;
    if (!SPECIES[speciesId]) {
      console.warn(`[renderer] Add-pet ignored: unknown species ${speciesId}`);
      return;
    }
    addPet(speciesId);
  });

  api.on('remove-pet', petId => {
    if (typeof petId !== 'number' || !Number.isFinite(petId)) return;
    removePet(petId);
  });

  // --- Friends window relay (friends window → main → this renderer) ---
  api.on('friends:connect-request', code => {
    if (typeof code === 'string' && code.trim()) connectToFriend(code.trim().toUpperCase());
  });
  api.on('friends:disconnect-request', () => {
    handleDisconnect();
  });
  api.on('friends:recall-request', migrationId => {
    // Ask the friend to send MY pet back. No id = recall every away pet.
    if (typeof migrationId === 'string' && migrationId) {
      sendP2P({ type: 'pet-recall-request', migrationId });
      return;
    }
    for (const away of awayPets)
      sendP2P({ type: 'pet-recall-request', migrationId: away.migrationId });
  });
  api.on('friends:send-home-request', migrationId => {
    // The friend's guest is visiting me — send it back to its owner.
    if (typeof migrationId !== 'string' || !migrationId) return;
    const pet = pets.find(p => p.migrationId === migrationId && p.isGuest);
    if (pet) sendGuestPetHome(pet);
  });
  api.on('friends:request-status', () => reportFriendsStatus());
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let lastTickMs = 0;
function tick(currentTime) {
  requestAnimationFrame(tick);

  // Paused (user toggle or fullscreen-DND): freeze the pets entirely rather than
  // budget-hogging in the background. (We deliberately do NOT listen to the
  // foreground-window state here — clicking a pet gives the overlay focus, and
  // main then reports no foreground window; that context is for walk-on-borders
  // only and must never pause the pets.)
  if (isPaused) {
    lastTickMs = currentTime;
    return;
  }

  lastTickMs = currentTime;

  for (const pet of pets) updateState(pet);
  for (const pet of pets) updateAnimationFrame(pet, currentTime);

  draw();
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function boot() {
  setupIPC();

  // Species registry comes from main (fs + scanning live in the main process
  // now that the renderer is sandboxed). DEFAULT_SPECIES_ID must exist before
  // any pet can spawn — the restore payload arriving mid-scan gets queued.
  try {
    const registry = await api.invoke('species:scan');
    if (registry && typeof registry === 'object' && Object.keys(registry).length > 0) {
      SPECIES = registry;
      DEFAULT_SPECIES_ID = Object.keys(SPECIES)[0] || null;
    }
  } catch (err) {
    console.warn('[renderer] Species scan failed:', err);
  }
  tryApplyPendingRestore();

  try {
    await preloadAllSpecies();
  } catch (err) {
    console.warn('[renderer] Some species sheets failed to preload:', err);
  }

  updateCanvasSize();
  requestAnimationFrame(t => {
    lastTickMs = t;
    tick(t);
  });

  api.send('set-mouse-ignore', !isWindowInteractive);
  debugLog('Boot complete. Species:', Object.keys(SPECIES).length, 'Pets:', pets.length);
}

window.addEventListener('resize', () => updateCanvasSize());

document.addEventListener('DOMContentLoaded', () => {
  boot();
});
