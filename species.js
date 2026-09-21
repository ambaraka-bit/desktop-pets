const fs = require('fs');
const path = require('path');

// Log scanning activity only when DP_DEBUG is set — it was noisy on every
// boot and in packaged builds.
const DEBUG = typeof process !== 'undefined' && !!process.env.DP_DEBUG;
function debug(...args) {
  if (DEBUG) console.log('[species.js]', ...args);
}

const CHARACTERS_DIR = path.join(__dirname, 'assets', 'Characters');

function scanSpeciesLibrary() {
  const registry = {};

  debug('Scanning:', CHARACTERS_DIR);

  if (!fs.existsSync(CHARACTERS_DIR)) {
    console.warn('[species.js] No Characters folder found at', CHARACTERS_DIR);
    return registry;
  }

  const speciesFolders = fs
    .readdirSync(CHARACTERS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  debug('Found species folders:', speciesFolders);

  for (const speciesName of speciesFolders) {
    const speciesPath = path.join(CHARACTERS_DIR, speciesName);
    const animationFiles = fs
      .readdirSync(speciesPath, { withFileTypes: true })
      .filter(d => d.isFile() && /\.(png|jpg|jpeg)$/i.test(d.name))
      .map(d => d.name);

    debug(`${speciesName} → animation files:`, animationFiles);

    const animations = {};
    for (const fileName of animationFiles) {
      const animName = path.basename(fileName, path.extname(fileName)); // "Idle.png" -> "Idle"
      animations[animName] = {
        // path relative to app root — usable directly as an Image src
        src: `assets/Characters/${speciesName}/${fileName}`
        // frameWidth/frameHeight/frameCount are resolved later at load time
        // once we know the real image dimensions (see resolveSheet())
      };
    }

    if (Object.keys(animations).length > 0) {
      registry[speciesName] = { id: speciesName, name: speciesName, animations };
    } else {
      debug(`Species "${speciesName}" has no animation image files — skipped.`);
    }
  }

  debug('Final registry keys:', Object.keys(registry));
  return registry;
}

module.exports = { scanSpeciesLibrary };
