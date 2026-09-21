// interaction.js — mouse/keyboard interaction: hover-to-click-through toggle,
// pet context menu (Chat / Rename / Control / Send-to-Friend / Send-Home /
// SWAP TO species switcher / HISTORY chat log), drag-and-drop, keyboard
// control mode, and click reactions.

// Clamp a popup (menu / chat panel) position so it stays fully on-screen:
// inside the current display's work area (i.e. above the taskbar and within
// screen edges). If the cursor is over a monitor seam/gap or the display list
// is empty, it falls back to the whole overlay window so the popup is never
// left dangling off an edge.
function clampMenuPosition(x, y, menuEl) {
  const menuW = menuEl.offsetWidth;
  const menuH = menuEl.offsetHeight;

  // Prefer the display that actually contains the anchor point. Matching by
  // x-range alone picks the wrong zone on stacked / overlapping monitors.
  const zone = displays.find(
    d => x >= d.x && x < d.x + d.width && y >= d.y && y < d.y + d.height
  ) ||
    displays.find(d => x >= d.x && x < d.x + d.width) || {
      x: 0,
      y: 0,
      width: canvas.width,
      height: canvas.height,
      workAreaX: 0,
      workAreaY: 0,
      workAreaWidth: canvas.width,
      workAreaHeight: canvas.height
    };

  const maxX = Math.max(zone.workAreaX, zone.workAreaX + zone.workAreaWidth - menuW);
  const maxY = Math.max(zone.workAreaY, zone.workAreaY + zone.workAreaHeight - menuH);
  return {
    x: Math.max(zone.workAreaX, Math.min(x, maxX)),
    y: Math.max(zone.workAreaY, Math.min(y, maxY))
  };
}

// The overlay window is click-through by default. Electron still forwards
// mousemove events while click-through, so we hit-test the cursor against pet
// bounding boxes and only "unlock" real mouse input while hovering a pet (or
// while a panel is open) — everywhere else stays fully clickable.
function setWindowInteractive(interactive) {
  if (interactive === isWindowInteractive) return;
  isWindowInteractive = interactive;
  api.send('set-mouse-ignore', !interactive);
  canvas.style.cursor = interactive ? 'grab' : 'default';
}

function triggerClickReaction(pet) {
  const species = SPECIES[pet.speciesId];
  if (!species) return;
  // A click plays one of the species' signature moves. Species without any
  // special art (idle/walk only) fall back to their base sheets so clicking
  // still visibly reacts instead of doing nothing.
  let pool = specialAnimationsFor(pet.speciesId);
  if (pool.length === 0) {
    pool = ['walk', 'idle'].map(b => animForBehavior(pet.speciesId, b)).filter(Boolean);
  }
  const chosen = pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : null;
  if (!chosen) return;
  pet.previousState = pet.state === 'event' ? pet.previousState || 'idle' : pet.state;
  pet.state = 'event';
  pet.eventAnimation = chosen;
  pet.currentFrame = 0;
  pet.lastFrameTime = 0;
  pet.eventTimer = 0;
  pet.eventInterval = randomEventInterval();
}

const petMenu = document.getElementById('pet-menu');
const chatPanel = document.getElementById('chat-panel');
const chatInput = document.getElementById('chat-input');
const sendFriendBtn = document.getElementById('send-friend-btn');
const sendHomeBtn = document.getElementById('send-home-btn');
const swapRow = document.getElementById('pet-menu-swap');
const swapBtns = document.getElementById('swap-btns');
const swapBtnTitle = document.getElementById('swap-title');
const historyButton = document.getElementById('pet-menu-history');
const historyPanel = document.getElementById('history-panel');
const historyList = document.getElementById('history-list');

function hideAllPanels() {
  petMenu.style.display = 'none';
  chatPanel.style.display = 'none';
  historyPanel.style.display = 'none';
  menuOpen = false;
  chatOpen = false;
  chatRenameMode = false;
  historyOpen = false;
  menuTargetPet = null;
  chatTargetPet = null;
  historyTargetPet = null;
  const stillHovering = !!petAtPoint(mouseX, mouseY);
  setWindowInteractive(stillHovering);
}

function openPetMenu(pet, screenX, screenY) {
  hideAllPanels();
  menuTargetPet = pet;
  menuOpen = true;

  // "Send to Friend" only makes sense for your own pets while connected.
  // "Send Home" only makes sense for a guest pet visiting you.
  sendFriendBtn.style.display = !pet.isGuest && connectionState === 'connected' ? 'block' : 'none';
  sendHomeBtn.style.display = pet.isGuest ? 'block' : 'none';
  historyButton.style.display = 'block';
  buildSpeciesSwapRow(pet);

  petMenu.style.left = `${screenX}px`;
  petMenu.style.top = `${screenY}px`;
  petMenu.style.display = 'flex';

  const clamped = clampMenuPosition(screenX, screenY, petMenu);
  petMenu.style.left = `${clamped.x}px`;
  petMenu.style.top = `${clamped.y}px`;

  setWindowInteractive(true); // force interactive while the menu is open
}

// Fill the "SWAP TO" row with every other available species. Hidden for guest
// pets (they belong to their owner).
function buildSpeciesSwapRow(pet) {
  swapRow.style.display = 'none';
  swapBtns.innerHTML = '';
  if (pet.isGuest) return;
  const entries = Object.entries(SPECIES);
  if (entries.length < 2) {
    swapBtnTitle.textContent = 'SWAP TO';
    return;
  }
  swapBtnTitle.textContent = `SWAP TO (${SPECIES[pet.speciesId] ? SPECIES[pet.speciesId].name : pet.speciesId})`;
  for (const [id, species] of entries) {
    if (id === pet.speciesId) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.swap = id;
    b.textContent = species.name || id;
    b.title = `Switch this pet to ${species.name || id}`;
    swapBtns.append(b);
  }
  swapRow.style.display = 'flex';
}

swapBtns.addEventListener('click', e => {
  const targetId = e.target.dataset.swap;
  if (!targetId || !menuTargetPet) return;
  changePetSpecies(menuTargetPet, targetId);
  hideAllPanels();
});

// Open the chat-log panel for a pet. Opens regardless of species/guest status —
// it's a local log of everything said to/by this pet.
function openHistoryPanel(pet, menuRect) {
  hideAllPanels();
  historyTargetPet = pet;
  historyOpen = true;
  historyPanel.style.display = 'block';
  renderHistory();
  const rect = menuRect || { left: 0, top: 0 };
  historyPanel.style.left = `${Math.max(0, rect.left - historyPanel.offsetWidth - 8)}px`;
  historyPanel.style.top = `${Math.max(0, rect.top)}px`;
  setWindowInteractive(true);
}

function renderHistory() {
  historyList.innerHTML = '';
  const key = historyTargetPet ? petKey(historyTargetPet) : null;
  const label = historyTargetPet ? historyTargetPet.name || historyTargetPet.speciesId : 'everyone';
  const titleEl = document.getElementById('history-title');
  if (titleEl) titleEl.textContent = `${label}'s chat log`;
  const rows = key ? chatHistory.filter(h => h.key === key) : chatHistory;
  if (rows.length === 0) {
    const li = document.createElement('li');
    li.className = 'history-empty';
    li.textContent = 'Nothing said yet.';
    historyList.append(li);
    return;
  }
  for (const h of rows) {
    const li = document.createElement('li');
    li.textContent = `[${new Date(h.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}] ${h.label}: ${h.text}`;
    historyList.append(li);
  }
}

// `opts.rename` repurposes the chat panel as a "set pet name" input.
function openChatPanel(pet, screenX, screenY, opts) {
  hideAllPanels();
  chatTargetPet = pet;
  chatOpen = true;
  chatRenameMode = !!(opts && opts.rename);

  chatInput.placeholder = chatRenameMode ? 'New name...' : 'Say something...';
  chatPanel.style.left = `${screenX}px`;
  chatPanel.style.top = `${screenY}px`;
  chatPanel.style.display = 'block';

  const clamped = clampMenuPosition(screenX, screenY, chatPanel);
  chatPanel.style.left = `${clamped.x}px`;
  chatPanel.style.top = `${clamped.y}px`;

  setWindowInteractive(true);
  chatInput.value = chatRenameMode && pet.name ? pet.name : '';
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
  pet.vy = 0;
  pet.currentFrame = 0;
  pet.controlMoveDir = 0;
  pet.controlIsRunning = false;
  lastDirectionPressTime = { left: 0, right: 0 };
  heldEventAnimation = null;
}

function exitControlMode() {
  if (!controlledPet) return;
  controlledPet.isControlled = false;
  controlledPet.controlIsRunning = false;
  controlledPet.state = 'idle';
  controlledPet.vy = 0;
  controlledPet.stateTimer = 0;
  controlledPet.stateDuration = randomDuration();
  controlledPet = null;
  lastDirectionPressTime = { left: 0, right: 0 };
  heldEventAnimation = null;
}

petMenu.addEventListener('click', e => {
  const action = e.target.dataset.action;
  if (!action || !menuTargetPet) return;
  const pet = menuTargetPet;

  if (action === 'chat') {
    const rect = petMenu.getBoundingClientRect();
    openChatPanel(pet, rect.left, rect.top);
  } else if (action === 'rename') {
    const rect = petMenu.getBoundingClientRect();
    openChatPanel(pet, rect.left, rect.top, { rename: true });
  } else if (action === 'control') {
    enterControlMode(pet);
  } else if (action === 'history') {
    const rect = petMenu.getBoundingClientRect();
    openHistoryPanel(pet, rect);
  } else if (action === 'send-friend') {
    sendPetToFriend(pet);
    hideAllPanels();
  } else if (action === 'send-home') {
    sendGuestPetHome(pet);
    hideAllPanels();
  }
});

chatInput.addEventListener('keydown', e => {
  e.stopPropagation(); // don't let control-mode keys swallow typed input
  if (e.key === 'Enter') {
    const text = chatInput.value.trim().slice(0, 40);
    if (chatTargetPet) {
      if (chatRenameMode) {
        chatTargetPet.name = text || null;
      } else if (text) {
        // Chat through a guest pet → send to its owner as a chat-echo.
        // Chat to a local pet → show the bubble locally + record in history.
        if (chatTargetPet.isGuest && chatTargetPet.migrationId) {
          sendP2P({
            type: 'chat-echo',
            migrationId: chatTargetPet.migrationId,
            text
          });
          recordChatEntry(petKey(chatTargetPet), 'you (via guest)', text);
        } else {
          chatTargetPet.chatText = text;
          chatTargetPet.chatExpiresAt = performance.now() + 4000;
          recordChatEntry(petKey(chatTargetPet), 'you', text);
        }
      }
    }
    hideAllPanels();
  } else if (e.key === 'Escape') {
    hideAllPanels();
  }
});

// Clicking anywhere outside an open panel closes it.
window.addEventListener(
  'mousedown',
  e => {
    if (!menuOpen && !chatOpen && !historyOpen) return;
    if (
      petMenu.contains(e.target) ||
      chatPanel.contains(e.target) ||
      historyPanel.contains(e.target)
    )
      return;
    hideAllPanels();
  },
  true
);

// --- Arrow key / WASD control mode ---
window.addEventListener('keydown', e => {
  if (chatOpen) return; // chat input handles its own keys

  if (e.key === 'Escape' && controlledPet) {
    exitControlMode();
    return;
  }
  if (!controlledPet) return;

  const now = Date.now();
  const isLeft = e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A';
  const isRight = e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D';

  if (isLeft) {
    // The last arrow key pressed faces EVERY pet on screen that way, not just
    // the controlled one.
    for (const pet of pets) pet.direction = -1;
    if (controlledPet.controlMoveDir === 1) {
      controlledPet.controlIsRunning = false;
      lastDirectionPressTime.right = 0;
    }
    controlledPet.controlMoveDir = -1;
    if (
      lastDirectionPressTime.left &&
      now - lastDirectionPressTime.left < DOUBLE_PRESS_THRESHOLD_MS
    ) {
      controlledPet.controlIsRunning = true;
      lastDirectionPressTime.left = 0;
    } else {
      lastDirectionPressTime.left = now;
    }
  } else if (isRight) {
    // The last arrow key pressed faces EVERY pet on screen that way, not just
    // the controlled one.
    for (const pet of pets) pet.direction = 1;
    if (controlledPet.controlMoveDir === -1) {
      controlledPet.controlIsRunning = false;
      lastDirectionPressTime.left = 0;
    }
    controlledPet.controlMoveDir = 1;
    if (
      lastDirectionPressTime.right &&
      now - lastDirectionPressTime.right < DOUBLE_PRESS_THRESHOLD_MS
    ) {
      controlledPet.controlIsRunning = true;
      lastDirectionPressTime.right = 0;
    } else {
      lastDirectionPressTime.right = now;
    }
  } else if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W' || e.key === ' ') {
    // Jump — repeated presses re-impulse. Disabled in reduce-motion mode.
    // Uses the fallback helper so partial-set species can still jump —
    // their walk/idle sheet plays while airborne.
    const jumpAnim = animForBehaviorWithFallback(controlledPet.speciesId, 'jump');
    if (jumpAnim && !reduceMotion) {
      controlledPet.state = 'jumping';
      controlledPet.vy = JUMP_VELOCITY_BASE * screenScale;
      controlledPet.currentFrame = 0;
      controlledPet.lastFrameTime = 0;
    }
  } else if ((e.key >= '1' && e.key <= '9') || e.key === '0') {
    // Number keys 1-0 trigger specific animations in control mode.
    const index = e.key === '0' ? 9 : parseInt(e.key) - 1;
    const pool = triggerableAnimationsFor(controlledPet.speciesId);
    if (index < pool.length) {
      const animName = pool[index];
      heldEventAnimation = animName;
      if (controlledPet.state !== 'event' || controlledPet.eventAnimation !== animName) {
        controlledPet.previousState =
          controlledPet.state === 'event'
            ? controlledPet.previousState || 'idle'
            : controlledPet.state;
        controlledPet.state = 'event';
        controlledPet.eventAnimation = animName;
        controlledPet.currentFrame = 0;
        controlledPet.lastFrameTime = 0;
        controlledPet.vy = 0;
      }
    }
  }
});

window.addEventListener('keyup', e => {
  if (chatOpen) return; // (the keydown handler already guards; this one must too)

  if (e.key >= '0' && e.key <= '9') {
    heldEventAnimation = null;
  }
  if (!controlledPet) return;
  if (['ArrowLeft', 'a', 'A', 'ArrowRight', 'd', 'D'].includes(e.key)) {
    controlledPet.controlMoveDir = 0;
    controlledPet.controlIsRunning = false;
    lastDirectionPressTime = { left: 0, right: 0 };
  }
});

window.addEventListener('mousemove', e => {
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

  if (menuOpen || chatOpen || historyOpen) return; // keep window interactive while a panel is open

  const hovered = petAtPoint(mouseX, mouseY);
  setWindowInteractive(!!hovered);
});

window.addEventListener('mousedown', e => {
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
  draggingPet.vy = 0;
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
    return;
  }

  // Dropped after a real drag — snap feet onto the floor of whichever monitor
  // the pet was released over (handles dragging across displays with different
  // taskbar/floor heights). Extra clamp keeps Y inside the display's work area
  // when dropped into a seam/gap between monitors.
  const displaySize = currentDisplaySize();
  pet.y = floorYForX(pet.x) - displaySize;
  for (const d of displays) {
    if (pet.x >= d.x && pet.x < d.x + d.width) {
      const workTop = d.workAreaY;
      const workBottom = d.workAreaY + d.workAreaHeight - displaySize;
      if (pet.y < workTop) {
        pet.x = clampNum(pet.x, d.x, d.x + d.width - displaySize, pet.x); // re-center
        pet.y = workTop;
      } else if (pet.y > workBottom) {
        pet.y = workBottom;
      }
      break;
    }
  }
  pet.state = 'idle';
  pet.stateTimer = 0;
  pet.stateDuration = randomDuration();

  const stillHovering = !!petAtPoint(mouseX, mouseY);
  canvas.style.cursor = stillHovering ? 'grab' : 'default';
  setWindowInteractive(stillHovering);
});
