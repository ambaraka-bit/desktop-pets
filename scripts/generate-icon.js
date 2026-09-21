// generate-icon.js — draws the "Desktop Pets" round blob mascot as pixel art
// and writes:
//   build/icon.ico         (multi-size ICO for electron-builder / Windows)
//   assets/tray-icon.png   (32px PNG for the system tray)
//
// Pure Node, no dependencies. Run: node scripts/generate-icon.js
//
// The mascot is an original design (a round yellow "pet blob" with ears and a
// face) — deliberately NOT derived from any third-party character/asset pack,
// so the branding can ship without trademark concerns.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// --- minimal PNG encoder (8-bit RGBA, no interlace) ---
function crc32(buf) {
  if (!crc32.table) {
    crc32.table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32.table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crc32.table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// --- ICO container (PNG-compressed entries) ---
function encodeICO(pngSizes) {
  // pngSizes: array of { size, data }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngSizes.length, 4);
  const entries = [];
  const images = [];
  let offset = 6 + 16 * pngSizes.length;
  for (const { size, data } of pngSizes) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // 0 means 256
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette count
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    images.push(data);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...images]);
}

// --- drawing helpers (SDF-ish, coordinates normalized to a 256-unit canvas) ---
function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax,
    aby = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby)));
  return Math.hypot(px - (ax + t * abx), py - (ay + t * aby));
}

function alphaFromD(dist) {
  return Math.max(0, Math.min(1, 0.5 - dist));
}

const OUTLINE = [18, 18, 46]; // deep navy
const BODY = [255, 217, 77]; // warm yellow
const FACE = [26, 26, 58]; // near-black navy
const CHEEK = [255, 143, 143]; // soft pink

// Round pet blob with face features; no ears (kept the design simple and
// reliably symmetric — the original ear-triangle attempt produced art bugs).
function renderPet(size) {
  const buf = Buffer.alloc(size * size * 4);
  const s = size / 256;
  const cx = 128,
    cy = 150,
    bodyR = 82;
  const RIM = 2.5; // outline thickness (in 256-units)

  function paint(px, py, color, alpha) {
    if (alpha <= 0) return;
    const idx = (py * size + px) * 4;
    const a = Math.min(1, alpha);
    const outA = a + (buf[idx + 3] / 255) * (1 - a); // src-over
    if (outA <= 0) return;
    buf[idx] = Math.round((color[0] * a + buf[idx] * (buf[idx + 3] / 255) * (1 - a)) / outA);
    buf[idx + 1] = Math.round(
      (color[1] * a + buf[idx + 1] * (buf[idx + 3] / 255) * (1 - a)) / outA
    );
    buf[idx + 2] = Math.round(
      (color[2] * a + buf[idx + 2] * (buf[idx + 3] / 255) * (1 - a)) / outA
    );
    buf[idx + 3] = Math.round(outA * 255);
  }

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const ux = (px + 0.5) / s;
      const uy = (py + 0.5) / s;
      const d = sdCircle(ux, uy, cx, cy, bodyR); // negative inside

      if (d < 0) {
        // interior (with soft edge)
        paint(px, py, BODY, alphaFromD(d + 0.75));
      } else if (d <= RIM) {
        // outline rim just outside the surface
        paint(px, py, OUTLINE, 1 - d / RIM);
      }
      // else: transparent

      // face (inside body only)
      if (d < -4) {
        const eyeL = sdCircle(ux, uy, 104, 142, 12);
        const eyeR = sdCircle(ux, uy, 152, 142, 12);
        const glintL = sdCircle(ux, uy, 109, 137, 5);
        const glintR = sdCircle(ux, uy, 157, 137, 5);
        const cheekL = sdCircle(ux, uy, 78, 168, 10);
        const cheekR = sdCircle(ux, uy, 178, 168, 10);
        paint(px, py, FACE, alphaFromD(eyeL));
        paint(px, py, FACE, alphaFromD(eyeR));
        paint(px, py, [255, 255, 255], alphaFromD(glintL));
        paint(px, py, [255, 255, 255], alphaFromD(glintR));
        paint(px, py, CHEEK, alphaFromD(cheekL) * 0.7);
        paint(px, py, CHEEK, alphaFromD(cheekR) * 0.7);

        const smileDist = sdSegment(ux, uy, 110, 167, 146, 167);
        paint(px, py, FACE, alphaFromD(smileDist - 4));
      }
    }
  }
  return buf;
}

// box-average downscale (maintains alpha edge quality)
function downscale(src, srcSize, dstSize) {
  const dst = Buffer.alloc(dstSize * dstSize * 4);
  const f = srcSize / dstSize;
  for (let y = 0; y < dstSize; y++) {
    for (let x = 0; x < dstSize; x++) {
      const y0 = Math.floor(y * f),
        y1 = Math.min(srcSize, Math.ceil((y + 1) * f));
      const x0 = Math.floor(x * f),
        x1 = Math.min(srcSize, Math.ceil((x + 1) * f));
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * srcSize + sx) * 4;
          const aa = src[i + 3];
          r += src[i] * aa;
          g += src[i + 1] * aa;
          b += src[i + 2] * aa;
          a += aa;
          n += 255;
        }
      }
      const denom = Math.max(1, n);
      const di = (y * dstSize + x) * 4;
      dst[di] = Math.round(r / denom);
      dst[di + 1] = Math.round(g / denom);
      dst[di + 2] = Math.round(b / denom);
      dst[di + 3] = Math.round(a / denom);
    }
  }
  return dst;
}

const root = path.join(__dirname, '..');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const full = renderPet(256);
const icoSizes = SIZES.map(size => {
  const rgba = size === 256 ? full : downscale(full, 256, size);
  return { size, data: encodePNG(size, size, rgba) };
});
const ico = encodeICO(icoSizes);
fs.writeFileSync(path.join(root, 'build', 'icon.ico'), ico);

// tray icon: 32px PNG (crisp enough on typical tray DPI)
fs.writeFileSync(
  path.join(root, 'assets', 'tray-icon.png'),
  encodePNG(32, 32, downscale(full, 256, 32))
);

// dev aid: dump a 256px PNG when DP_ICON_PREVIEW is set, for eyeballing the art
if (process.env.DP_ICON_PREVIEW) {
  const out = path.join(process.env.DP_ICON_PREVIEW, 'icon-preview.png');
  fs.writeFileSync(out, encodePNG(256, 256, full));
  console.log('[generate-icon.js] Wrote preview', out);
}

console.log('[generate-icon.js] Wrote build/icon.ico', ico.length, 'bytes');
console.log('[generate-icon.js] Wrote assets/tray-icon.png');
