// ESLint flat config (ESLint 9.x).
//
// The renderer is a BUNDLE of classic browser scripts that share one global
// namespace and are loaded by index.html in a fixed order. Cross-file
// references are resolved at call-time (see state.js header), so per-file
// no-undef / no-unused-vars rules can't apply to them. We keep the strict
// checks for the main-process modules and only sanity-check the renderer set
// (browser globals + the bridge/script-tag libs it legitimately sees).
const globals = require('globals');
const eslint = require('@eslint/js');
const eslintConfigPrettier = require('eslint-config-prettier');

/** @type {import('eslint').Linter.Config[]} */
module.exports = [
  {
    ignores: [
      'node_modules/**',
      'release/**',
      'tests/**',
      'package-lock.json',
      'scripts/generate-pet.js'
    ]
  },
  {
    // Main-process modules: full static analysis applies.
    files: ['main.js', 'preload.js', 'settings.js', 'species.js', 'scripts/**/*.js'],
    languageOptions: { globals: { ...globals.node } },
    ...eslint.configs.recommended
  },
  {
    // utils.js runs in BOTH the browser (script tag) and the Node test runner,
    // so it sees the browser globals plus the module/require CJS pair.
    files: ['utils.js'],
    languageOptions: {
      globals: { ...globals.browser, module: 'readonly', require: 'readonly', exports: 'readonly' }
    },
    ...eslint.configs.recommended
  },
  {
    // Renderer bundle: shared global namespace across files.
    files: [
      'state.js',
      'pet-ai.js',
      'chat-bubble.js',
      'renderer-draw.js',
      'p2p.js',
      'interaction.js',
      'renderer.js'
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
        api: 'readonly',
        __dpDebug: 'readonly',
        Peer: 'readonly',
        Howl: 'readonly',
        Howler: 'readonly'
      }
    },
    rules: {
      'no-undef': 'off', // cross-file globals (state.js defines, others use)
      'no-unused-vars': 'off' // cross-file functions are used by sibling modules
    }
  },
  {
    // Isolated settings/friends windows: only know their bridge + DOM.
    files: ['settings-renderer.js', 'friends-renderer.js'],
    languageOptions: { globals: { ...globals.browser, api: 'readonly' } },
    ...eslint.configs.recommended
  },
  eslintConfigPrettier
];
