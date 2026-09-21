// pet-ai.js — pet lifecycle, autonomous AI, and roster sync.
//
// Each pet is a plain object in `pets[]` (declared in state.js). Behavior is
// driven purely by the animation FILE NAME (see animationBehavior in utils.js);
// dropping PNGs into a species folder adds/removes behaviors with no code.

// First animation name in a species that maps to the given behavior (or null).
function animForBehavior(speciesId, behavior) {
  const species = SPECIES[speciesId];
  if (!species) return null;
  return Object.keys(species.animations).find(name => animationBehavior(name) === behavior) || null;
}

// Like animForBehavior, but species with a PARTIAL asset set still get full
// behavior parity: a missing run/charge/jump sheet falls back to the species'
// walk sheet (then idle), so a species that only ships Idle/Walk art can
// sprint, dash and jump just like the fully-kitted ones — just without
// bespoke art.
function animForBehaviorWithFallback(speciesId, behavior) {
  const direct = animForBehavior(speciesId, behavior);
  if (direct) return direct;
  if (behavior === 'run' || behavior === 'charge' || behavior === 'jump') {
    return animForBehavior(speciesId, 'walk') || animForBehavior(speciesId, 'idle');
  }
  return null;
}

// Signature/surprise animations: everything the species has that isn't mapped
// to a dedicated behavior (idle/walk/run/charge/jump).
function specialAnimationsFor(speciesId) {
  const species = SPECIES[speciesId];
  if (!species) return [];
  return Object.keys(species.animations).filter(name => {
    const b = animationBehavior(name);
    return b === 'special' || b === 'attack' || b === 'flinch' || b === 'fall';
  });
}

// Animations triggerable by number keys (1-0) in control mode. Species with no
// dedicated "special" art (only idle/walk) fall back to their base sheets so
// the keys still trigger a visible animation.
function triggerableAnimationsFor(speciesId) {
  const species = SPECIES[speciesId];
  if (!species) return [];
  const names = Object.keys(species.animations);
  const dedicated = names.filter(name => {
    const b = animationBehavior(name);
    return b !== 'idle' && b !== 'walk' && b !== 'run' && b !== 'jump';
  });
  if (dedicated.length > 0) return dedicated;
  return names.filter(name => {
    const b = animationBehavior(name);
    return b === 'idle' || b === 'walk';
  });
}

// Species that prefer their run gait to finish the current stride cycle before
// the autonomous state timer lets them switch to another behavior. Without this,
// a run ending mid-sheet snaps to frame 0 of a different animation — a visible
// "pop" in the middle of a stride. GingerCat's wide-celled run sheet is the
// poster child for this.
const SMOOTH_RUN_SPECIES = new Set(['GingerCat']);

function runShouldFinishCycle(pet) {
  return SMOOTH_RUN_SPECIES.has(pet.speciesId) && !!animForBehavior(pet.speciesId, 'run');
}

// Per-animation frame-duration overrides (ms), keyed "SpeciesId/AnimName".
// Lets a fast one-shot like GingerCat's punch snap through its 12 frames
// instead of playing at the slow idle/event rate (which looks like a lazy
// wave rather than a punch).
const ANIM_FRAME_DURATION_MS = {
  'GingerCat/GingerCatPunch': 110,
  'GingerCat/GingerCatKick': 110,
  'GingerCat/GingerCatSleep': 350
};

// Returns the animation file name to show for a pet's current state.
function animationNameFor(pet) {
  const species = SPECIES[pet.speciesId];
  if (!species) return null;
  const names = Object.keys(species.animations);
  if (names.length === 0) return null;

  if (pet.state === 'event' && pet.eventAnimation) return pet.eventAnimation;

  if (pet.state === 'jumping') {
    return animForBehaviorWithFallback(pet.speciesId, 'jump') || names[0];
  }

  const moving = { walk: 'walk', run: 'run', charge: 'charge' }[pet.state];
  if (moving) {
    const match = animForBehaviorWithFallback(pet.speciesId, moving);
    if (match) return match;
  }

  return animForBehavior(pet.speciesId, 'idle') || names[0];
}

function makePet(speciesId) {
  const id = speciesId && SPECIES[speciesId] ? speciesId : DEFAULT_SPECIES_ID;
  const displaySize = currentDisplaySize();
  const spawnX = Math.random() * Math.max(0, canvas.width - displaySize);
  return {
    id: nextPetId++,
    speciesId: id,
    name: null, // optional custom name (pet menu → Rename)
    x: spawnX,
    y: floorYForX(spawnX) - displaySize,
    direction: Math.random() < 0.5 ? -1 : 1,
    state: 'walk',
    stateTimer: 0,
    stateDuration: randomDuration(),
    currentFrame: 0,
    lastFrameTime: 0,
    vy: 0, // vertical velocity — only non-zero while jumping
    footstepTimer: 0,
    eventTimer: 0,
    eventInterval: randomEventInterval(),
    eventAnimation: null,
    previousState: null,
    smoothRunExit: false, // run gait completes its stride before switching states
    isDragging: false,
    isControlled: false,
    controlMoveDir: 0,
    controlIsRunning: false,
    isGuest: false,
    migrationId: null,
    guestOwner: null
  };
}

// --- Roster sync with main.js ---
//
// The renderer is the single source of truth for what's alive on screen.
// Whenever the pet list changes (add/remove/migration/disconnect), we send a
// full snapshot so main's tray count + persisted roster can never drift out of
// sync. `species` is the persistent roster (own + LOCAL pets only — away pets
// are transient P2P state and would otherwise reappear as duplicates on
// relaunch); `count` is the live on-screen number (guests included).
function persistentRoster() {
  return pets
    .filter(p => !p.isGuest)
    .map(p => {
      const prof = { speciesId: p.speciesId };
      if (p.name) prof.name = p.name;
      if (typeof p.x === 'number' && Number.isFinite(p.x)) prof.x = p.x;
      return prof;
    });
}

function syncPetsToMain() {
  api.send('pets-changed', {
    species: persistentRoster(),
    count: pets.length,
    // Per-pet snapshot for the tray's "Remove Pet" picker — main can't tell
    // individual pets apart from the species list alone.
    pets: pets.map(p => ({ id: p.id, speciesId: p.speciesId, isGuest: !!p.isGuest }))
  });
}

// `opts` (optional): { name, x } — restores a pet's identity/position from a
// persisted profile (or from an away-pet recall) instead of spawning fresh.
function addPet(speciesId, notifyMain = true, opts) {
  if (!DEFAULT_SPECIES_ID) {
    console.error('[renderer] No species available — cannot add pet. Check Characters folder.');
    return;
  }
  if (pets.length >= maxPets) {
    console.warn(`[renderer] Pet cap (${maxPets}) reached — not adding another.`);
    return;
  }
  const pet = makePet(speciesId);
  if (opts && typeof opts === 'object') {
    if (typeof opts.name === 'string' && opts.name) pet.name = opts.name;
    if (typeof opts.x === 'number' && Number.isFinite(opts.x)) {
      const ds = currentDisplaySize();
      pet.x = clampNum(opts.x, 0, Math.max(0, canvas.width - ds), pet.x);
      pet.y = floorYForX(pet.x) - ds;
    }
  }
  pets.push(pet);
  debugLog(
    `addPet(requested="${speciesId}", resolved="${pet.speciesId}", notifyMain=${notifyMain}) — total pets:`,
    pets.length
  );
  if (notifyMain) syncPetsToMain();
}

function removePet(petId, notifyMain = true) {
  if (pets.length === 0) return;

  let removed = null;
  if (petId != null) {
    const idx = pets.findIndex(p => p.id === petId);
    if (idx === -1) return; // already gone — nothing to do
    removed = pets[idx];
    pets.splice(idx, 1);
  } else {
    removed = pets.pop(); // no id supplied → old "remove last" behavior
  }

  // If we just dropped a controlled pet, make sure keyboard mode releases it.
  if (controlledPet && controlledPet.id === removed.id) {
    exitControlMode();
  }

  if (notifyMain) syncPetsToMain();

  // A removed guest is no longer visiting us — tell the Friends window.
  if (removed.isGuest) reportFriendsStatus();
}

// Swap an existing pet to a different species (pixel menu → SWAP TO row) — no
// remove-and-re-add needed. Keeps its name/position; re-snaps to the floor in
// case the new sprite has different dimensions.
function changePetSpecies(pet, speciesId) {
  if (!SPECIES[speciesId] || pet.speciesId === speciesId) return;
  pet.speciesId = speciesId;
  pet.eventAnimation = null;
  pet.currentFrame = 0;
  pet.lastFrameTime = 0;
  if (pet.state === 'event') pet.state = pet.previousState || 'idle';
  const ds = currentDisplaySize();
  pet.x = clampNum(pet.x, 0, Math.max(0, canvas.width - ds), pet.x);
  pet.y = floorYForX(pet.x) - ds;
  syncPetsToMain();
}

// Reduces motion / stays put: pets idle in place, snapped to their floor.
function applyReduceMotion(pet) {
  pet.eventAnimation = null;
  pet.previousState = 'idle';
  pet.smoothRunExit = false;
  if (pet.state !== 'idle') {
    pet.state = 'idle';
    pet.stateTimer = 0;
    pet.stateDuration = randomDuration();
    pet.currentFrame = 0;
  }
  pet.y = floorYForX(pet.x) - currentDisplaySize();
}

function updateState(pet) {
  // Held by the mouse — skip all normal AI/movement/timers entirely.
  if (pet.isDragging) return;

  // Player-controlled ("Control" mode from the pet menu).
  if (pet.isControlled) {
    if (pet.state === 'event') return; // one-shot animations freeze movement

    if (pet.state === 'jumping') {
      // Air control: arrow/WASD still steer the pet sideways mid-jump.
      if (pet.controlMoveDir !== 0) {
        pet.direction = pet.controlMoveDir;
        const airSpeed = pet.controlIsRunning ? currentWalkSpeed() * 2.2 : currentWalkSpeed() * 2;
        pet.x += airSpeed * pet.controlMoveDir;
        const displaySize = currentDisplaySize();
        if (pet.x + displaySize <= 0) pet.x = canvas.width - displaySize;
        else if (pet.x >= canvas.width) pet.x = 0;
      }

      pet.vy = Math.min(pet.vy + JUMP_GRAVITY_BASE * screenScale, JUMP_MAX_FALL_BASE * screenScale);
      pet.y += pet.vy;

      const floorY = floorYForX(pet.x) - currentDisplaySize();
      if (pet.y >= floorY) {
        pet.y = floorY; // land back on the floor (feet down)
        pet.vy = 0;
        if (pet.controlMoveDir !== 0) {
          pet.state = pet.controlIsRunning ? 'run' : 'walk';
        } else {
          pet.state = 'idle';
          pet.controlIsRunning = false;
        }
        pet.stateTimer = 0;
        pet.stateDuration = randomDuration();
      }
      return;
    }

    if (pet.controlMoveDir !== 0) {
      pet.direction = pet.controlMoveDir;
      if (pet.controlIsRunning) {
        pet.x += currentWalkSpeed() * 2.2 * pet.controlMoveDir;
        pet.state = 'run';
      } else {
        pet.x += currentWalkSpeed() * 2 * pet.controlMoveDir; // a bit snappier than autonomous walking
        pet.state = 'walk';
      }

      const displaySize = currentDisplaySize();
      if (pet.x + displaySize <= 0) pet.x = canvas.width - displaySize;
      else if (pet.x >= canvas.width) pet.x = 0;

      pet.footstepTimer += 16;
      if (pet.footstepTimer > 220) {
        pet.footstepTimer = 0;
        playSound(footstepSound);
      }

      pet.y = floorYForX(pet.x) - displaySize; // re-snap floor when crossing monitors
    } else {
      pet.state = 'idle';
      pet.controlIsRunning = false;
    }
    return;
  }

  // One-shot animations (surprise event, flinch, fall, jump) freeze normal
  // walk/idle AI — just wait for them to finish (handled in updateAnimationFrame).
  if (pet.state === 'event' || pet.state === 'jumping') return;

  // Accessibility "reduce motion": pets never wander or trigger surprise events.
  if (reduceMotion) {
    applyReduceMotion(pet);
    return;
  }

  // Tick toward the next possible random "special" event (signature moves).
  pet.eventTimer += 16;
  if (pet.eventTimer >= pet.eventInterval) {
    pet.eventTimer = 0;
    pet.eventInterval = randomEventInterval();

    const pool = specialAnimationsFor(pet.speciesId);
    if (pool.length > 0 && Math.random() < EVENT_TRIGGER_CHANCE) {
      pet.previousState = pet.state;
      pet.state = 'event';
      pet.eventAnimation = pool[Math.floor(Math.random() * pool.length)];
      pet.currentFrame = 0;
      pet.lastFrameTime = 0;
      return; // skip normal walk/idle logic this tick — event just started
    }
  }

  pet.stateTimer += 16;

  if (pet.state === 'charge') {
    // A charge is a short burst dash — when the timer runs out, settle back
    // into a plain walk.
    if (pet.stateTimer > pet.stateDuration) {
      pet.state = 'walk';
      pet.stateTimer = 0;
      pet.stateDuration = randomDuration();
      pet.currentFrame = 0;
      pet.direction = Math.random() < 0.5 ? -1 : 1;
    }
  } else if (pet.stateTimer > pet.stateDuration) {
    if (pet.state === 'run' && runShouldFinishCycle(pet)) {
      // Smooth-loop species (e.g. GingerCat): don't cut the run gait off
      // mid-stride at an arbitrary frame. Mark that the run is "done" and let
      // updateAnimationFrame switch states at the next cycle boundary instead,
      // so the tail of the run sheet flows into whatever comes next.
      pet.smoothRunExit = true;
    } else {
      pickNextAutonomousState(pet);
    }
  }

  // Locomotion: walk/trot/charge all move the pet, each at its own speed.
  if (pet.state === 'walk' || pet.state === 'run' || pet.state === 'charge') {
    const speed =
      pet.state === 'walk'
        ? currentWalkSpeed()
        : pet.state === 'run'
          ? currentWalkSpeed() * 2.2
          : currentWalkSpeed() * 3.2; // charge = a fast dash
    pet.x += speed * pet.direction;

    pet.footstepTimer += 16;
    if (pet.footstepTimer > 280) {
      pet.footstepTimer = 0;
      playSound(footstepSound);
    }

    const displaySize = currentDisplaySize();
    if (pet.x + displaySize <= 0) {
      pet.x = canvas.width - displaySize;
    } else if (pet.x >= canvas.width) {
      pet.x = 0;
    }

    // Re-snap to the floor of whichever monitor the pet is now over.
    pet.y = floorYForX(pet.x) - displaySize;
  }
}

// Pick the next autonomous behavior, weighted toward calm wandering. Only
// behaviors the species actually has animation files for are offered.
function pickNextAutonomousState(pet) {
  const options = [];
  if (animForBehavior(pet.speciesId, 'idle')) options.push('idle');
  if (animForBehavior(pet.speciesId, 'walk')) options.push('walk');
  // Run/charge use the fallback (walk sheet when a dedicated sheet is missing),
  // so partial asset sets still wander with the same mobility as full ones.
  if (animForBehaviorWithFallback(pet.speciesId, 'run')) options.push('run');
  if (animForBehaviorWithFallback(pet.speciesId, 'charge')) options.push('charge');

  const weights = { idle: 35, walk: 40, run: 15, charge: 10 };
  let total = 0;
  for (const o of options) total += weights[o] ?? 10;
  let roll = Math.random() * total;
  let next = null;
  for (const o of options) {
    roll -= weights[o] ?? 10;
    if (roll <= 0) {
      next = o;
      break;
    }
  }
  if (!next) next = options[options.length - 1] || 'idle';

  pet.state = next;
  pet.stateTimer = 0;
  pet.smoothRunExit = false;
  pet.stateDuration =
    next === 'charge'
      ? 650 + Math.random() * 250 // a quick dash, not a long wander
      : next === 'run'
        ? randomDuration() * 0.7
        : randomDuration();
  pet.currentFrame = 0;
  debugLog('behavior', pet.speciesId, '->', next);

  if (next === 'walk' || next === 'run' || next === 'charge') {
    pet.direction = Math.random() < 0.5 ? -1 : 1;
  } else if (next === 'idle') {
    if (Math.random() < 0.5) playSound(idleSound);
  }
}

// Returns the frame duration (ms) for a pet based on its current state.
function frameDurationForState(pet) {
  // Per-animation override (e.g. fast punch) wins before state defaults.
  const animName = pet.eventAnimation || animationNameFor(pet);
  const override = ANIM_FRAME_DURATION_MS[`${pet.speciesId}/${animName}`];
  if (override) return override;
  if (pet.state === 'run') return FRAME_DURATION_RUN_MS;
  if (pet.state === 'walk') return FRAME_DURATION_WALK_MS;
  if (pet.state === 'charge') return FRAME_DURATION_CHARGE_MS;
  return FRAME_DURATION_MS; // idle, jumping, event, etc.
}

function updateAnimationFrame(pet, timestamp) {
  const animName = animationNameFor(pet);
  if (!animName) return;
  const sheet = resolvedSheets.get(`${pet.speciesId}/${animName}`);
  if (!sheet) return;

  if (timestamp - pet.lastFrameTime > frameDurationForState(pet)) {
    const nextFrame = pet.currentFrame + 1;

    if (pet.state === 'event' && nextFrame >= sheet.frameCount) {
      // One-shot "special" animation completed a full loop. If the user is
      // still holding the number key that triggered it, keep looping it;
      // otherwise resume whatever behavior the pet was doing before.
      if (pet.isControlled && heldEventAnimation === pet.eventAnimation) {
        pet.currentFrame = 0; // loop while holding
      } else {
        pet.state = pet.previousState || 'idle';
        pet.eventAnimation = null;
        pet.currentFrame = 0;
        pet.stateTimer = 0;
        pet.stateDuration = randomDuration();
      }
    } else if (pet.state === 'run' && pet.smoothRunExit && nextFrame >= sheet.frameCount) {
      // Smooth-loop species (e.g. GingerCat): the run timer expired mid-gait, so
      // we waited for the full stride cycle to finish. Switch states at the loop
      // boundary instead of mid-sheet, which keeps the animation looking fluid.
      pet.smoothRunExit = false;
      pet.lastFrameTime = timestamp;
      pickNextAutonomousState(pet);
      return;
    } else {
      pet.currentFrame = nextFrame % sheet.frameCount;
    }
    pet.lastFrameTime = timestamp;
  }
}

// Debug logging helper shared by all renderer modules — only active with
// DP_DEBUG (sampled through the preload bridge; sandboxed renderers can't
// touch process.env themselves), so production builds are quiet.
function debugLog(...args) {
  const enabled = typeof __dpDebug === 'function' ? __dpDebug() : false;
  if (enabled) console.log(...args); // main forwards renderer console as [renderer] when DP_DEBUG
}
