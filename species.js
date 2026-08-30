// species.js — scans assets/Characters/<SpeciesName>/<AnimationName>.png
// Each animation is ONE image file: a horizontal strip of square frames
// (frame width == image height), e.g. a 896x128 file = 7 frames of 128x128.
//
// This matches asset packs like FireWizard/Idle.png, Walk.png, etc.
// No JSON manifest or per-frame files needed — frame count is inferred
// automatically from (imageWidth / imageHeight), since frames are square.
//
// Runs in the renderer process (nodeIntegration: true gives us fs/path here).

const fs = require('fs');
const path = require('path');

const CHARACTERS_DIR = path.join(__dirname, 'assets', 'Characters');

function scanSpeciesLibrary() {
  const registry = {};

  console.log('[species.js] Scanning:', CHARACTERS_DIR);

  if (!fs.existsSync(CHARACTERS_DIR)) {
    console.warn('[species.js] No Characters folder found at', CHARACTERS_DIR);
    return registry;
  }

  const speciesFolders = fs.readdirSync(CHARACTERS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  console.log('[species.js] Found species folders:', speciesFolders);

  for (const speciesName of speciesFolders) {
    const speciesPath = path.join(CHARACTERS_DIR, speciesName);
    const animationFiles = fs.readdirSync(speciesPath, { withFileTypes: true })
      .filter(d => d.isFile() && /\.(png|jpg|jpeg)$/i.test(d.name))
      .map(d => d.name);

    console.log(`[species.js]   ${speciesName} → animation files:`, animationFiles);

    const animations = {};
    for (const fileName of animationFiles) {
      const animName = path.basename(fileName, path.extname(fileName)); // "Idle.png" -> "Idle"
      animations[animName] = {
        // path relative to app root — usable directly as an Image src
        src: `assets/Characters/${speciesName}/${fileName}`
        // frameWidth/frameHeight/frameCount are resolved later at load time
        // once we know the real image dimensions (see resolveSheet() in renderer.js)
      };
    }

    if (Object.keys(animations).length > 0) {
      registry[speciesName] = { id: speciesName, name: speciesName, animations };
    } else {
      console.warn(`[species.js] Species "${speciesName}" has no animation image files — skipped.`);
    }
  }

  console.log('[species.js] Final registry keys:', Object.keys(registry));
  return registry;
}

module.exports = { scanSpeciesLibrary };