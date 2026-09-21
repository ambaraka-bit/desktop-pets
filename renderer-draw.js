// renderer-draw.js — sprite-sheet resolution + everything that's drawn onto
// the pet canvas, plus the DOM speech bubbles (chat-bubble.js) layered above
// it and pet names.

// --- Sheet cache: resolves each animation's image + frame geometry once ---
// resolvedSheets["FireWizard/Idle"] = { img, frameWidth, frameHeight, frameCount }
const resolvedSheets = new Map();

// Some sprite sheets have their frames packed in a non-sequential order.
// This maps "speciesId/animName" → array where output[i] = source frame index
// to display when currentFrame is i. GingerCat's artist exported both the run
// and idle sheets with scrambled frame indices (a brute-force Hamiltonian-cycle
// search over each sheet found the true temporal order — the least-change loop:
// run 0→1→2→5→3→4, idle 0→1→5→2→4→7→8→6→3).
const FRAME_REORDER = {
  'GingerCat/GingerCatRun': [0, 1, 2, 5, 3, 4],
  'GingerCat/GingerCatIdle': [0, 1, 5, 2, 4, 7, 8, 6, 3],
  'GingerCat/GingerCatSleep': [0, 1, 2, 4, 5, 3]
};

// loadImage with a per-image timeout: a corrupt/unreachable sheet must not
// hang preloadAllSpecies forever (it silently renders nothing otherwise).
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timeoutMs = 10000;
    const timer = setTimeout(() => {
      img.src = '';
      reject(new Error(`Image load timed out after ${timeoutMs}ms: ${src}`));
    }, timeoutMs);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`Failed to load image: ${src}`));
    };
    img.src = src;
  });
}

async function resolveSheet(speciesId, animName) {
  const key = `${speciesId}/${animName}`;
  if (resolvedSheets.has(key)) return resolvedSheets.get(key);

  const anim = SPECIES[speciesId]?.animations?.[animName];
  if (!anim) return null;
  if (!anim.src) return null;

  const img = await loadImage(anim.src);
  const frameHeight = img.height;
  // Frame width is read from the pixels rather than assumed. Most strips pack
  // square cells (e.g. FireWizard/Idle.png = seven 128x128), and when the
  // height-multiple seams really are blank that assumption holds. But some
  // packs mix in wide cells (e.g. GingerCatRun.png = six 316x291 frames)
  // whose width is ALSO a clean multiple of the height — assuming square cells
  // there would slice every pose in half. So we only trust the square reading
  // after verifying the seam columns, otherwise we sniff the true dividers.
  const probe = document.createElement('canvas');
  probe.width = img.width;
  probe.height = frameHeight;
  const probeCtx = probe.getContext('2d', { willReadFrequently: true });
  probeCtx.drawImage(img, 0, 0);
  const { blankness, contentTop, contentBottom, hasContent } = analyzeColumns(
    probeCtx,
    img.width,
    frameHeight
  );
  const frameWidth =
    img.width % frameHeight === 0 && hasSquareRhythm(blankness, img.width, frameHeight)
      ? frameHeight
      : detectFrameWidthFromBlankness(blankness, img.width, frameHeight);
  const frameCount = img.width / frameWidth;

  const sheet = {
    img,
    frameWidth,
    frameHeight,
    frameCount,
    // Vertical extent of the character art (union over all frames). Sheets are
    // often authored at very different zooms (e.g. GingerCat idle = 948px-tall
    // frames, punch = only 170px), so this is used to resize each animation so
    // the cat body renders at the same size instead of scaling every frame to a
    // fixed height.
    charTop: hasContent ? contentTop : 0,
    charHeight: hasContent ? contentBottom - contentTop + 1 : frameHeight,
    charBottom: hasContent ? contentBottom : frameHeight - 1
  };
  resolvedSheets.set(key, sheet);
  return sheet;
}

// Fraction of each column that is (nearly) transparent — a divider column
// between frames scores ~1, a mid-sprite column scores ~0. Also tracks the
// vertical extent of opaque (>= 16 alpha) pixels so the draw routine can size
// each animation by its real character content.
function analyzeColumns(cctx, width, height) {
  const pixels = cctx.getImageData(0, 0, width, height).data;
  const blankness = new Array(width);
  let contentTop = height;
  let contentBottom = -1;
  for (let x = 0; x < width; x++) {
    let nearTransparent = 0;
    for (let y = 0; y < height; y++) {
      const alpha = pixels[(y * width + x) * 4 + 3];
      if (alpha < 64) nearTransparent++;
      if (alpha >= 16) {
        if (y < contentTop) contentTop = y;
        if (y > contentBottom) contentBottom = y;
      }
    }
    blankness[x] = nearTransparent / height;
  }
  return {
    blankness,
    hasContent: contentBottom >= 0,
    contentTop,
    contentBottom
  };
}

// True when a "frame width == height" (square cells) layout is consistent with
// the pixels: every seam at a height-multiple stays essentially blank (≥95%).
function hasSquareRhythm(blankness, width, height) {
  const frameCount = width / height;
  for (let k = 1; k < frameCount; k++) {
    if (blankness[k * height] < 0.95) return false;
  }
  return true;
}

// Finds the real frame width of a sprite strip from its pixel columns.
// Frame boundaries are columns that stay (nearly) transparent down the full
// height, so we score every plausible frame width — a divisor of the total
// width within [height/2, 2*height] — by how blank its seam columns are, and
// pick the SMALLEST width whose seams are all essentially blank (≥95%).
// Genuine square strips resolve to their cell height; strips with wide or
// odd cells (e.g. GingerCatRun.png, GingerCatJump.png) get their real width.
function detectFrameWidthFromBlankness(blankness, width, height) {
  for (let cw = Math.ceil(height / 2); cw <= 2 * height && cw < width; cw++) {
    if (width % cw !== 0) continue;
    const frameCount = width / cw;
    if (frameCount < 2) continue;
    let mostSolid = 1;
    for (let k = 1; k < frameCount; k++) {
      if (blankness[k * cw] < mostSolid) mostSolid = blankness[k * cw];
    }
    if (mostSolid >= 0.95) return cw; // smallest width with a clean frame rhythm
  }

  // No clean divisor found — fall back to the round-to-square heuristic.
  return width / Math.round(width / height);
}

async function preloadAllSpecies() {
  const jobs = [];
  for (const species of Object.values(SPECIES)) {
    for (const animName of Object.keys(species.animations)) {
      jobs.push(
        resolveSheet(species.id, animName).catch(err => {
          console.warn(`[renderer] Failed to load ${species.id}/${animName}:`, err && err.message);
        })
      );
    }
  }
  await Promise.all(jobs);
}

// On-screen rectangle a pet's current animation occupies. EVERY animation of a
// species fills exactly the same square box (side = current displaySize): the
// source frame is stretched to that fixed footprint, so switching animations
// never changes the pet's on-screen size.
function petDisplayRect(pet) {
  const displaySize = currentDisplaySize();
  return { x: pet.x, y: pet.y, w: displaySize, h: displaySize };
}

// Returns the on-screen bounding box for a pet, matching exactly what
// draw() renders — used for mouse hit-testing (hover/click/drag).
function getPetBounds(pet) {
  const animName = animationNameFor(pet);
  const sheet = animName ? resolvedSheets.get(`${pet.speciesId}/${animName}`) : null;
  if (!sheet) {
    const displaySize = currentDisplaySize();
    return { x: pet.x, y: pet.y, w: displaySize, h: displaySize };
  }
  return petDisplayRect(pet);
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

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  pruneChatBubbles();

  for (const pet of pets) {
    const animName = animationNameFor(pet);
    if (!animName) continue;
    const sheet = resolvedSheets.get(`${pet.speciesId}/${animName}`);
    if (!sheet) continue;

    const rawFrame = pet.currentFrame % sheet.frameCount;
    const frameIndex = FRAME_REORDER[`${pet.speciesId}/${animName}`]?.[rawFrame] ?? rawFrame;
    const sx = frameIndex * sheet.frameWidth;
    // Crop each frame to the character's vertical extent (union over all
    // frames) and stretch that band into the fixed on-screen box, so every
    // animation's body renders at the same size regardless of how much of the
    // source cell the art fills (e.g. GingerCat sleep = 203px of a 334px cell).
    const sy = sheet.charTop;
    const sH = sheet.charHeight;

    const { x: rX, y: rY, w: displayW, h: displayH } = petDisplayRect(pet);

    ctx.save();
    if (highContrast) {
      // Four hard drop-shadows = a crisp outline around the sprite.
      ctx.filter =
        'drop-shadow(2px 2px 0 #000000) drop-shadow(-2px -2px 0 #000000) drop-shadow(2px -2px 0 #000000) drop-shadow(-2px 2px 0 #000000)';
    }
    if (pet.direction === -1) {
      ctx.translate(rX + displayW, rY);
      ctx.scale(-1, 1);
    } else {
      ctx.translate(rX, rY);
    }
    ctx.drawImage(
      sheet.img,
      sx,
      sy,
      sheet.frameWidth,
      sH, // source crop from the sheet
      0,
      0,
      displayW,
      displayH // destination on canvas
    );
    ctx.restore();

    // Chat speech bubble — a DOM element (chat-bubble.js) layered above the
    // canvas and anchored over the pet's head so its tail points at the sprite.
    if (pet.chatText && performance.now() < pet.chatExpiresAt) {
      updateChatBubble(pet, { x: rX, y: rY, w: displayW, h: displayH });
    } else if (pet.chatText) {
      pet.chatText = null; // expired
      hideChatBubble(pet);
    }

    // Above-pet labels, stacked to avoid overlap:
    //   pet name (custom, via Rename)  → top
    //   CONTROLLING                     → mid
    //   guest nameplate                  → lowest slot
    const hasCustomName = !pet.isGuest && pet.name;
    let labelY = rY - 6 * screenScale;
    if (hasCustomName) {
      ctx.save();
      ctx.font = `bold ${9 * screenScale}px "Courier New", monospace`;
      ctx.fillStyle = UI_COLORS.nameLabel;
      ctx.textAlign = 'center';
      ctx.fillText(pet.name, rX + displayW / 2, labelY);
      ctx.restore();
      labelY -= 12 * screenScale;
    }
    if (pet === controlledPet) {
      ctx.save();
      ctx.font = `bold ${10 * screenScale}px "Courier New", monospace`;
      ctx.fillStyle = UI_COLORS.controlling;
      ctx.textAlign = 'center';
      ctx.fillText('▲ CONTROLLING (ESC to release)', rX + displayW / 2, labelY);
      ctx.restore();
    }
    // Guest nameplate — makes it obvious this pet is visiting from a friend.
    if (pet.isGuest && !(pet.chatText && performance.now() < pet.chatExpiresAt)) {
      ctx.save();
      ctx.font = `bold ${9 * screenScale}px "Courier New", monospace`;
      ctx.fillStyle = UI_COLORS.guestNameplate;
      ctx.textAlign = 'center';
      ctx.fillText(`♦ ${pet.guestOwner}'s guest`, rX + displayW / 2, rY - 6 * screenScale);
      ctx.restore();
    }
  }
}

// --- DOM speech bubbles (ChatBubble class from chat-bubble.js) ---
// One ChatBubble instance per pet, reused across messages. Repositioned every
// frame in draw() so a walking/jumping pet's bubble follows the sprite, and
// reusing the DOM node avoids layout/perf churn for repeated chats.
//
// Bubble size is tied to the pet's on-screen height (BASE_DISPLAY_SIZE px at
// 100%): CHAT_BUBBLE_SCALE is the scale of the 5000px source art for a 96px
// pet, so the bubble always reads as ~1.6x the pet no matter the size% /
// large-sprite / screen setting.
const CHAT_BUBBLE_SCALE = 0.04;
const CHAT_BUBBLE_MAX_WIDTH = 300;

const chatBubbles = new Map();

function bubbleForPet(pet) {
  let bubble = chatBubbles.get(pet.id);
  if (!bubble) {
    const scale = CHAT_BUBBLE_SCALE * (currentDisplaySize() / BASE_DISPLAY_SIZE);
    bubble = new ChatBubble({
      imagePath: 'assets/Chat/Chat_Bubble.png',
      parent: document.body,
      scale,
      maxWidth: CHAT_BUBBLE_MAX_WIDTH,
      fontScale: currentDisplaySize() / BASE_DISPLAY_SIZE
    });
    chatBubbles.set(pet.id, bubble);
  }
  return bubble;
}

function hideChatBubble(pet) {
  const bubble = chatBubbles.get(pet.id);
  if (bubble) {
    bubble.hide();
    bubble._shownText = null; // allow the exact same message to replay later
  }
}

// Bubbles are keyed by pet id; pets can be removed by several code paths that
// just re-assign the `pets` array. Sweep once per frame so a stale bubble (for
// a pet that no longer exists) can never float on screen forever.
function pruneChatBubbles() {
  for (const id of chatBubbles.keys()) {
    if (!pets.some(p => p.id === id)) {
      chatBubbles.get(id).destroy();
      chatBubbles.delete(id);
    }
  }
}

// Sync a pet's speech bubble to its current message + position. `rect` is the
// on-screen box of the pet's current animation (from petDisplayRect).
function updateChatBubble(pet, rect) {
  const bubble = bubbleForPet(pet);

  // Only write the text when it actually changed — setting textContent on every
  // frame reflows the bubble needlessly while it follows the moving pet below.
  if (bubble._shownText !== pet.chatText) {
    bubble.say(pet.chatText);
    bubble._shownText = pet.chatText;
  }

  // Horizontal: center the element (and therefore the white bubble body, which
  // sits symmetrically between the side border slices) over the pet's head.
  // NOTE: do NOT anchor the element's left edge at the head — the wide left
  // border slice holds the tail, so that would shove the whole body off the
  // pet to the right.
  //
  // Vertical: the tail's tip is NOT at the element's bottom edge — in the
  // source it sits `tailTipFromBottom` px above the image's bottom, and the
  // rest is transparent. Shift the element down by that on-screen amount so
  // the tail tip lands exactly `gap` above the pet's head instead of dangling
  // above it.
  const gap = 8 * screenScale;
  const w = bubble.el.offsetWidth || 0;
  const h = bubble.el.offsetHeight || 0;
  const tailDrop = bubble.tailTipFromBottom * bubble.scale;
  const x = clampNum(rect.x + rect.w / 2 - w / 2, 0, Math.max(0, canvas.width - w), rect.x);
  const y = Math.max(0, rect.y - gap + tailDrop - h);
  bubble.setPosition(x, y);
}
