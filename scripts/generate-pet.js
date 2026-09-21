// generate-pet.js — procedurally draws a new pixel-art pet ("Kitty", an orange
// tabby) from scratch and writes sibling sprite-sheet PNGs in the same format
// the app expects: a horizontal strip of square frames (frame size 128x128,
// cell size 32x32 upscaled x4 nearest-neighbor).
//
// Output: assets/Characters/Kitty/{Idle,Walk,Jump,Dance,Hurt}.png
// Run:    node scripts/generate-pet.js
// The app needs no manifest — species.js auto-scans that folder.
//
// A preview contact-sheet is written to the opencode temp dir for visual
// checking (also emitted anywhere else via the KITTY_PREVIEW env var).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CELL = 32; // design grid (pixels)
const SCALE = 4; // upscale factor -> 128x128 frames
const FRAME = CELL * SCALE;

const OUT_DIR = path.join(__dirname, '..', 'assets', 'Characters', 'Kitty');
const PREVIEW_DIR =
  process.env.KITTY_PREVIEW || path.join(process.env.TEMP || '.', 'opencode', 'kitty-preview.png');

// --- Minimal PNG encoder (RGBA, 8-bit, no dependencies) ---
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function writeSheet(filePath, frames) {
  const width = FRAME * frames.length;
  const height = FRAME;
  const out = Buffer.alloc(width * height * 4);
  for (let f = 0; f < frames.length; f++) {
    const frame = frames[f];
    for (let y = 0; y < FRAME; y++) {
      for (let x = 0; x < FRAME; x++) {
        const src = frame[((y / SCALE) | 0) * CELL + ((x / SCALE) | 0)];
        const dst = ((f * FRAME + y) * width + x) * 4;
        out[dst] = src[0];
        out[dst + 1] = src[1];
        out[dst + 2] = src[2];
        out[dst + 3] = src[3];
      }
    }
  }
  fs.writeFileSync(filePath, encodePng(width, height, out));
  console.log('Wrote', filePath, width + 'x' + height, '-', frames.length, 'frames');
}

// --- Palette (packed RGBA) ---
const C = (hex, a = 255) => {
  const c = hex.slice(1);
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16), a];
};
const TRANSPARENT = C('#000000', 0);
const pal = {
  outline: C('#2b1a10'),
  body: C('#f2a25c'),
  bodyDark: C('#c47a38'),
  belly: C('#ffd9a8'),
  stripe: C('#a55a26'),
  nose: C('#e85d6d'),
  eye: C('#221d17'),
  glint: C('#ffffff'),
  blush: C('#f2a2a2'),
  whisker: C('#4a2a18'),
  mouth: C('#7a2a2a'),
  tailTip: C('#a55a26')
};

// --- Pixel helpers on a flat [CELL*CELL*4] buffer ---
function newFrame() {
  return new Uint8Array(CELL * CELL * 4);
}

function setPx(frame, x, y, c) {
  if (x < 0 || x >= CELL || y < 0 || y >= CELL) return;
  const i = (y * CELL + x) * 4;
  frame[i] = c[0];
  frame[i + 1] = c[1];
  frame[i + 2] = c[2];
  frame[i + 3] = c[3];
}

// Draw all shape rects into both a mask and an art grid; setPx draws body parts
// to the mask (alpha), fill parts to the art (color).
const mask = newFrame();
const art = newFrame();

// cat == the whole silhouette (drawn to `mask` only, or full color)
let shapeParts = [];

function addShape(x, y, w, h) {
  for (let yy = y; yy < y + h; yy++)
    for (let xx = x; xx < x + w; xx++) setPx(mask, xx, yy, C('#fff'));
}

function addFill(x, y, w, h, color) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) setPx(art, xx, yy, color);
}

function addPx(x, y, color) {
  addShape(x, y, 1, 1);
  setPx(art, x, y, color);
}

// Compose one 32x32 frame: outline around the mask silhouette, art colors inside.
function drawCat(opts) {
  const {
    bob = 0,
    blink = false,
    footLUp = false,
    footRUp = false,
    armLift = 0,
    wag = 0,
    mouthSad = false
  } = opts;
  mask.fill(0);
  art.fill(0);

  const dy = bob;

  // Tail (behind the body). A column attached along the body's right edge,
  // ending in a small hook that wags across animation frames.
  for (let yr = 21; yr <= 29; yr++) {
    addShape(22, yr + dy, 2, 1);
    addFill(22, yr + dy, 2, 1, pal.body);
  }
  addFill(22, 24 + dy, 2, 1, pal.stripe);
  addFill(22, 27 + dy, 2, 1, pal.stripe);
  // hook/tip that sweeps side to side
  const hx = wag >= 2 ? 1 : 0;
  addShape(23 + hx, 19 + dy, 1, 4);
  addShape(24 + hx, 20 + dy, 1, 1);
  addFill(24 + hx, 19 + dy, 1, 1, pal.tailTip);
  addFill(23 + hx, 20 + dy, 1, 3, pal.tailTip);
  addFill(24 + hx, 20 + dy, 1, 1, pal.tailTip);

  // Ears (chunky triangles, 5 rows tall)
  addShape(10, 1 + dy, 1, 2);
  addShape(9, 2 + dy, 3, 2);
  addShape(9, 4 + dy, 4, 2); // base widens and merges into the head
  addShape(21, 1 + dy, 1, 2);
  addShape(20, 2 + dy, 3, 2);
  addShape(19, 4 + dy, 4, 2);
  addFill(10, 1 + dy, 1, 2, pal.bodyDark);
  addFill(9, 2 + dy, 3, 2, pal.body);
  addFill(9, 4 + dy, 4, 2, pal.body);
  addFill(21, 1 + dy, 1, 2, pal.bodyDark);
  addFill(20, 2 + dy, 3, 2, pal.body);
  addFill(19, 4 + dy, 4, 2, pal.body);

  // Head
  addShape(9, 5 + dy, 14, 13);
  addFill(9, 5 + dy, 14, 13, pal.body);

  // Eyes
  const eyeY = 9 + dy;
  if (blink) {
    addFill(11, eyeY + 1, 2, 1, pal.eye);
    addFill(19, eyeY + 1, 2, 1, pal.eye);
  } else {
    addFill(11, eyeY, 2, 3, pal.eye);
    addFill(19, eyeY, 2, 3, pal.eye);
    addPx(11, eyeY, pal.glint);
    addPx(19, eyeY, pal.glint);
  }

  // Nose + mouth
  addFill(15, 13 + dy, 2, 1, pal.nose);
  const my = 14 + dy;
  if (mouthSad) {
    addFill(14, my, 4, 1, pal.mouth);
  } else {
    addPx(14, my, pal.mouth);
    addPx(17, my, pal.mouth);
  }

  // Blush cheeks
  addPx(9, 12 + dy, pal.blush);
  addPx(22, 12 + dy, pal.blush);

  // Whiskers
  for (let wy = 0; wy < 2; wy++) {
    for (let wx = 5; wx <= 7; wx++) {
      addPx(wx, 11 + dy + wy, pal.whisker);
      addPx(31 - wx, 11 + dy + wy, pal.whisker);
    }
  }

  // Body
  addShape(10, 18 + dy, 12, 12);
  addFill(10, 18 + dy, 12, 12, pal.body);
  // side shading (darker on the edges)
  addFill(10, 18 + dy, 1, 12, pal.bodyDark);
  addFill(21, 18 + dy, 1, 12, pal.bodyDark);
  // belly patch
  addFill(13, 20 + dy, 6, 10, pal.belly);
  // torso stripes (sides)
  addFill(10, 20 + dy, 1, 1, pal.stripe);
  addFill(11, 20 + dy, 1, 1, pal.stripe);
  addFill(20, 20 + dy, 1, 1, pal.stripe);
  addFill(21, 20 + dy, 1, 1, pal.stripe);
  addFill(11, 25 + dy, 1, 1, pal.stripe);
  addFill(20, 25 + dy, 1, 1, pal.stripe);

  // Arms (side nubs)
  const armY = armLift ? 18 + dy : 22 + dy;
  addShape(9, armY, 2, 4);
  addShape(21, armY, 2, 4);
  addFill(9, armY, 2, 4, pal.body);
  addFill(21, armY, 2, 4, pal.body);
  addFill(9, armY, 1, 4, pal.bodyDark);
  addFill(21, armY, 1, 4, pal.bodyDark);

  // Feet
  const lfy = footLUp ? 27 + dy : 28 + dy;
  const rfy = footRUp ? 27 + dy : 28 + dy;
  addShape(11, lfy, 4, 2);
  addShape(17, rfy, 4, 2);
  addFill(11, lfy, 4, 2, pal.body);
  addFill(17, rfy, 4, 2, pal.body);

  // Composite with automatic outline
  const frame = newFrame();
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const mi = (y * CELL + x) * 4;
      if (mask[mi + 3] === 0) continue; // empty: stays transparent
      const nearEmpty =
        x === 0 ||
        y === 0 ||
        x === CELL - 1 ||
        y === CELL - 1 ||
        mask[(y * CELL + (x - 1)) * 4 + 3] === 0 ||
        mask[(y * CELL + (x + 1)) * 4 + 3] === 0 ||
        mask[((y - 1) * CELL + x) * 4 + 3] === 0 ||
        mask[((y + 1) * CELL + x) * 4 + 3] === 0;
      const color = nearEmpty ? pal.outline : [art[mi], art[mi + 1], art[mi + 2], art[mi + 3]];
      setPx(frame, x, y, color);
    }
  }
  return frame;
}

// --- Animation definitions ---
function idleFrames() {
  const bobCycle = [0, 0, -1, -1, -1, 0, 0];
  const wagCycle = [0, 1, 2, 2, 1, 0, 1];
  return bobCycle.map((bob, i) => drawCat({ bob, blink: i === 4, wag: wagCycle[i] || 0 }));
}

function walkFrames() {
  const defs = [
    { bob: 0, footLUp: true },
    { bob: -1, footLUp: false },
    { bob: 0, footRUp: true },
    { bob: -1, footRUp: false },
    { bob: 0, footLUp: true },
    { bob: -1, footLUp: false }
  ];
  return defs.map((d, i) => drawCat({ ...d, wag: i % 3 }));
}

function jumpFrames() {
  const defs = [
    { bob: 0, footLUp: false, footRUp: false, armLift: 0 }, // crouch into spring
    { bob: -1, armLift: 1 }, // takeoff
    { bob: -2, footLUp: true, footRUp: true, armLift: 1 }, // apex, legs tucked
    { bob: -2, footLUp: true, footRUp: true, armLift: 1 }, // hang
    { bob: -1, armLift: 1 }, // falling
    { bob: 1, armLift: 0 } // land (squash)
  ];
  return defs.map((d, i) => drawCat({ ...d, wag: i % 2 }));
}

function danceFrames() {
  const defs = [
    { bob: 0, footLUp: true, armLift: 1, wag: 0 },
    { bob: -1, footRUp: true, armLift: 1, wag: 2 },
    { bob: 0, footLUp: true, armLift: 0, wag: 1 },
    { bob: -1, footRUp: true, armLift: 1, wag: 2 },
    { bob: 0, footLUp: true, armLift: 1, wag: 0 },
    { bob: -1, footRUp: true, armLift: 0, wag: 2 }
  ];
  return defs.map(d => drawCat(d));
}

function hurtFrames() {
  const defs = [
    { bob: 0, blink: true, wag: 1 },
    { bob: 1, blink: true, wag: 0 },
    { bob: 0, blink: true, wag: 1, mouthSad: true },
    { bob: 1, blink: true, wag: 0, mouthSad: true }
  ];
  return defs.map(d => drawCat(d));
}

// --- PNGs ---
fs.mkdirSync(OUT_DIR, { recursive: true });
writeSheet(path.join(OUT_DIR, 'Idle.png'), idleFrames());
writeSheet(path.join(OUT_DIR, 'Walk.png'), walkFrames());
writeSheet(path.join(OUT_DIR, 'Jump.png'), jumpFrames());
writeSheet(path.join(OUT_DIR, 'Dance.png'), danceFrames());
writeSheet(path.join(OUT_DIR, 'Hurt.png'), hurtFrames());

// --- Preview contact sheet (light-gray background) so it can be eyeballed ---
(function preview() {
  const anims = {
    Idle: idleFrames(),
    Walk: walkFrames(),
    Jump: jumpFrames(),
    Dance: danceFrames(),
    Hurt: hurtFrames()
  };
  const rows = Object.values(anims).map(a => a.length).length;
  const cols = 7;
  const gap = 2;
  const scale = 5;
  const pw = cols * (CELL * scale) + (cols + 1) * gap;
  const ph = Object.keys(anims).length * (CELL * scale) + Object.keys(anims).length * gap + 10;
  const buf = Buffer.alloc(pw * ph * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 0xdd;
    buf[i + 1] = 0xdd;
    buf[i + 2] = 0xdd;
    buf[i + 3] = 255;
  }
  const keys = Object.keys(anims);
  let r = 0;
  for (const key of keys) {
    const frames = anims[key];
    frames.forEach((f, c) => {
      const ox = gap + c * (CELL * scale + gap);
      const oy = 5 + r * (CELL * scale + gap);
      for (let y = 0; y < CELL; y++) {
        for (let x = 0; x < CELL; x++) {
          const sa = f[(y * CELL + x) * 4 + 3];
          if (sa === 0) continue;
          const fg = [f[(y * CELL + x) * 4], f[(y * CELL + x) * 4 + 1], f[(y * CELL + x) * 4 + 2]];
          for (let yy = 0; yy < scale; yy++) {
            for (let xx = 0; xx < scale; xx++) {
              const dst = ((oy + y * scale + yy) * pw + (ox + x * scale + xx)) * 4;
              buf[dst] = fg[0];
              buf[dst + 1] = fg[1];
              buf[dst + 2] = fg[2];
              buf[dst + 3] = 255;
            }
          }
        }
      }
    });
    r++;
  }
  fs.mkdirSync(path.dirname(PREVIEW_DIR), { recursive: true });
  fs.writeFileSync(PREVIEW_DIR, encodePng(pw, ph, buf));
  console.log('Preview:', PREVIEW_DIR);
})();

// --- Text-mode preview (KITTY_ASCII=1) so the art can be eyeballed without an image viewer ---
if (process.env.KITTY_ASCII === '1') {
  const palToChar = {
    outline: '#',
    body: 'B',
    bodyDark: 'b',
    belly: '.',
    stripe: 'S',
    nose: 'n',
    eye: 'O',
    glint: 'G',
    blush: '*',
    whisker: 'w',
    mouth: 'M',
    tailTip: 'T'
  };
  const hexToChar = {};
  const named = [
    pal.outline,
    pal.body,
    pal.bodyDark,
    pal.belly,
    pal.stripe,
    pal.nose,
    pal.eye,
    pal.glint,
    pal.blush,
    pal.whisker,
    pal.mouth,
    pal.tailTip
  ];
  const chars = ['#', 'B', 'b', 'o', 'S', 'n', 'O', 'G', '*', 'w', 'M', 'T'];
  named.forEach((c, i) => {
    hexToChar[c.slice(0, 3).join(',')] = chars[i];
  });
  const animByName = {
    Idle: idleFrames(),
    Walk: walkFrames(),
    Jump: jumpFrames(),
    Dance: danceFrames(),
    Hurt: hurtFrames()
  };
  const toPrint = { Idle: [0, 3, 6], Walk: [0, 3], Jump: [2], Dance: [2], Hurt: [2] };
  const ruler = '   ' + Array.from({ length: CELL }, (_, i) => String(i % 10)).join('');
  for (const [name, frames] of Object.entries(animByName)) {
    for (const fi of toPrint[name]) {
      const f = frames[fi];
      console.log(`\n=== ${name} frame ${fi} ===`);
      console.log(ruler);
      for (let y = 0; y < CELL; y++) {
        let line = String(y).padStart(2, '0') + ' ';
        for (let x = 0; x < CELL; x++) {
          const i = (y * CELL + x) * 4;
          const a = f[i + 3];
          if (a === 0) {
            line += '.';
            continue;
          }
          const key = [f[i], f[i + 1], f[i + 2]].join(',');
          const ch = hexToChar[key] || '?';
          line += ch;
        }
        console.log(line.replace(/\.+$/, ''));
      }
    }
  }
}
