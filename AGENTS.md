# AGENTS.md — AI Developer Handoff for Desktop Pets

> Read this file when you start a session in this repo. It tells you how to run/verify the
> project, where everything lives, the rules you must never break, and the current state of
> the repo (including several traps the git history will show you).
>
> **Read `PROJECT-STATUS.md` too** — it is the deep design/handoff document (architecture,
> security model, full change log). This file is the short operational companion: same facts,
> aimed at an AI agent that is about to edit code.

---

## 1. What this project is

**Desktop Pets** is a **Windows-only** Electron app that draws animated pixel pets on your
desktop in a transparent, click-through overlay that spans all monitors. Pets walk/idle
autonomously, react to clicks, can be renamed/controlled/dragged, and — the flagship feature —
can be "sent" to a friend over **WebRTC (PeerJS)** so they appear on the friend's screen as a
guest pet (P2P "Friends").

- No backend, no database, no bundler/build step. Plain HTML5 Canvas rendering.
- Renderers are fully sandboxed (`contextIsolation`, no `nodeIntegration`, `sandbox: true`);
  the only Node surface is the whitelisted `window.api` bridge (`preload.js`).
- Deps: Electron 44, Howler (sound), PeerJS (P2P), electron-builder + electron-updater
  (packaging/auto-update). See `package.json`.

---

## 2. Run & verify (do this before and after every change)

Prereqs: Windows 10/11, Node 24.x. (npm 11 blocks install scripts — run
`npm approve-scripts electron` / `electron-builder` once if `npm install` complains.)

| Command                            | Purpose                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `npm start`                        | Launch the app (dev mode).                                                |
| `npm test`                         | Unit tests via `node --test` — currently **25/25 green** (confirmed).     |
| `npm run lint`                     | ESLint 9 flat config.                                                     |
| `npm run format:check`             | Prettier (printWidth 100, single quotes, no trailing commas, semicolons). |
| `npm run smoke`                    | `DP_SMOKE_TEST=1` boot; opens all 3 windows, auto-quits. exit 0 = pass.   |
| `node --check <file>`              | Fast syntax sanity on a hand-edited file.                                 |
| `npm run dist` / `npm run publish` | NSIS installer into `release/`; publish needs `GH_TOKEN`.                 |
| `npm run gen-icon`                 | Regenerate `build/icon.ico` + `assets/tray-icon.png`.                     |

**Golden rule: after any code change, run `npm test && npm run lint && npm run format:check`
(and `npm run smoke` for anything touching main/renderer boot).** CI enforces the first three on
`windows-latest`.

---

## 3. File map (what lives where, and the important symbols)

All root-level JS. Note: renderer modules share **one global namespace** and are loaded by
`index.html` in a fixed order (see §4). `utils.js` is the only module that runs in BOTH the
browser and Node's test runner.

**Main process (Node, `require()` allowed):**

- `main.js` — everything: windows, tray, IPC hub, settings persistence, multi-monitor virtual
  desktop (`buildVirtualDesktop`/`computeVirtualDesktop`), PowerShell foreground-window watcher
  (`startForegroundWatcher`), DND auto-pause (`maybeApplyDnd`), single-instance lock, global
  hotkeys, auto-updater, P2P consent dialogs, smoke harness. `MAX_PETS = 20` (line ~28).
- `settings.js` — **single source of truth** for the settings schema: `DEFAULT_SETTINGS`,
  `RANGES`, `sanitizeSettings()` (the integrity gate for `settings.json`), `generatePeerCode()`
  (crypto, look-alike-free 6-char codes).
- `species.js` — `scanSpeciesLibrary()`: reads `assets/Characters/<Species>/<Anim>.png` and
  builds the registry. Main-only (invoked over IPC via `species:scan`).
- `preload.js` — the ONLY bridge. Three whitelists: `SEND_CHANNELS`, `INVOKE_CHANNELS`,
  `RECEIVE_CHANNELS`. **Any IPC channel not listed here is silently blocked.**
- `scripts/generate-icon.js`, `scripts/generate-pet.js` — procedural PNG/ICO generators
  (pure Node, no deps). `generate-pet.js` draws a "Kitty" species; both embed minimal PNG
  encoders (see the PNG gotcha in §6).

**Renderer (sandboxed, classic `<script>`s, no `require`):**

- `state.js` — shared mutable globals + constant tables + sound wrapper (`playSound`). Must load
  FIRST of the renderer files (after howler/peerjs/utils). Holds `pets[]`, `awayPets[]`,
  `friendConnections`, `displays`, `SPECIES`, `foregroundWindow`, frame-duration constants,
  jump physics, `maxPets`.
- `pet-ai.js` — pet lifecycle + autonomous state machine: `makePet`, `addPet`, `removePet`,
  `changePetSpecies`, `persistentRoster`/`syncPetsToMain` (roster push to main), `updateState`
  (the AI), `pickNextAutonomousState`, `animationNameFor`, `updateAnimationFrame`. Key tables:
  `SMOOTH_RUN_SPECIES`, `ANIM_FRAME_DURATION_MS` (per-animation pacing overrides).
- `renderer-draw.js` — sprite-sheet resolution + all drawing: `resolvedSheets` cache,
  `resolveSheet` (pixel-sniffs frame width/height/char extent), `FRAME_REORDER` (maps scrambled
  source cell order to temporal order), `preloadAllSpecies`, `draw()`, chat-bubble anchoring.
- `chat-bubble.js` — `ChatBubble` class: 9-slice border-image bubble DOM element.
- `p2p.js` — PeerJS "Friends": `initPeer`, `connectToFriend`, `setupConnection`,
  `handleP2PMessage` (every inbound msg → `sanitizeP2PMessage`), `sendPetToFriend`,
  `addGuestPet`, migration timeouts + auto-recall, `reportFriendsStatus`, on-canvas badge.
- `interaction.js` — hover→click-through toggle, pet menu (CHAT/RENAME/CONTROL/HISTORY/
  SWAP-TO/SEND-TO-FRIEND/SEND-HOME), drag-drop, keyboard Control mode.
- `renderer.js` — boot + IPC wiring: `applySettings`, `applyRestoredSettings`, `setupIPC`,
  `tick` (the rAF main loop), `boot`.
- `settings-renderer.js` / `friends-renderer.js` — UIs for the two helper windows (each a
  separate isolated renderer process; they talk to each other only via main's IPC relay).

**Pages / assets:**

- `index.html` — overlay markup + CSS + the load-bearing script order (see §4) + CSP.
- `settings.html`, `friends.html` — helper-window pages.
- `assets/Characters/<Species>/` — one sprite-sheet PNG per animation. Current kit on disk:
  **`GingerCat`** (full: Idle/Walk/Run/Jump/Angry/Punch/Kick/Laugh/Sad/Sleep — note the
  `GiingerCatAngry.png` **double-i typo in its filename**, it's intentional and working).
- `assets/Chat/Chat_Bubble.png`, `assets/Layout/OptionsMenu.png`, `assets/sounds/*.wav`,
  `assets/tray-icon.png`, `build/icon.ico`.

**Tests / CI / config:**

- `tests/core.test.js` — 25 unit tests over `utils.js` + `settings.js` + `sanitizeP2PMessage`.
- `.github/workflows/ci.yml` — `npm ci` → test → lint → format on windows-latest.
- `eslint.config.js` — main-process files get strict rules; the renderer bundle has
  `no-undef`/`no-unused-vars` off (cross-file globals resolved at call time) and extra globals
  (`api`, `Peer`, `Howl`, `Howler`, `__dpDebug`).

---

## 4. Architecture essentials

### Process model

Main process owns the tray, settings, foreground watcher, and the **overlay window**: a
transparent, frameless, always-on-top window spanning every display. It is **click-through
except while the cursor hovers a pet or an open panel**: the renderer hit-tests on every
mousemove and calls `set-mouse-ignore` to flip `setIgnoreMouseEvents()` off only when needed.
Two helper windows (Settings, Friends) run in separate processes and communicate through
`main.js` relays.

### Renderer boot + loop (renderer.js `boot()`)

1. `setupIPC()` subscribes to all `main → renderer` events.
2. `await api.invoke('species:scan')` → populates `SPECIES` + `DEFAULT_SPECIES_ID`
   (a `restore-settings` payload arriving mid-scan is queued via `queueRestore`).
3. Splits `vm` is unrelated — restore payload spawns saved pets via `addPet`.
4. `await preloadAllSpecies()` loads every sheet with a per-image timeout + corrupt-sheet guard.
5. rAF `tick()`: per pet `updateState()` → `updateAnimationFrame()` → `draw()`.

Pets freeze **only** on explicit pause / DND auto-pause. Do NOT treat a `null`
`foreground-window` as a pause signal — that was a fixed bug (§11.5 of PROJECT-STATUS.md).

### IPC surface — keep in sync

The three `preload.js` whitelists MUST mirror `main.js` handlers exactly. New channel in
`main.js` → add it to the matching preload set, or it silently never reaches/leaves a renderer.
Renderer→main `send`: `settings-changed`, `set-mouse-ignore`, `pets-changed`,
`copy-to-clipboard`, and the `friends:*` relays. Renderer→main `invoke`: `species:scan`,
`generate-peer-code`, `show-confirm-dialog`. main→renderer `on`: `display-info`,
`restore-settings`, `set-paused`, `add-pet`, `remove-pet`, `apply-settings`,
`foreground-window`, `friends:*`, `init-settings-values`, `settings-roster-update`.

### Settings flow

`settings.json` lives in `%APPDATA%/desktop-pets/` (atomic tmp+rename write, rolling `.bak`).
**Every read/write runs through `sanitizeSettings()`**; the roster (`activePets`) is an array of
profiles `{ speciesId, name?, x? }` (legacy string entries auto-upgrade). The **overlay is the
source of truth for the roster**: it pushes a full snapshot via `pets-changed` after every
add/remove/migrate/disconnect; main sanitizes, persists, updates the tray + Settings roster.

### P2P Friends

Each install keeps a persistent friendly peer code. `p2p.js` runs on the overlay; every
connection lives in `friendConnections` (Map); one is "primary" for the UI badge + send target.
Pet migration: `pet-migrate-request` → native accept/decline dialog →
`pet-migrate-accept/reject`; away pets auto-recall after `MIGRATION_TIMEOUT_MS`. All inbound
messages are schema-validated by `sanitizeP2PMessage` before touching state/canvas.

---

## 5. Non-negotiable conventions (read before editing!)

1. **Renderer script order in `index.html` is load-bearing**: howler → peerjs → utils → state →
   pet-ai → chat-bubble → renderer-draw → p2p → interaction → renderer. `state.js` globals are
   used at CALL time by later modules. Do not reorder without full smoke testing.
2. **`require()` only in main-side files.** Sandboxed renderers have no `require`. Howler/PeerJS
   must stay `<script>` tags (their UMD detection breaks under Electron's isolated world).
3. **No new IPC channel without updating `preload.js`** (see §4).
4. **All settings and all inbound P2P payloads go through their sanitizer.** New settings keys
   must be added to `DEFAULT_SETTINGS` + `sanitizeSettings` (and typically `RANGES`); new P2P
   message types to `VALID_TYPES` in `sanitizeP2PMessage`.
5. **Windows-only assumptions everywhere**: PowerShell foreground watcher, `set X=1&&` smoke
   script, `app.setLoginItemSettings`, NSIS. Don't add cross-platform code expecting CI on
   Linux/macOS to pass.
6. **Behavior is driven by animation FILE NAME** (`animationBehavior` in utils.js): idle/walk/
   run/charge/jump/attack/hurt/dead/special. Missing dedicated sheets auto-fallback to
   walk/idle (`animForBehaviorWithFallback`), so partial species still run/jump/attack.
7. **Species = folder.** Drop `assets/Characters/<Name>/Idle.png` + `Walk.png` to add one — no
   code. Frame geometry is sniffed from pixels at load (`resolveSheet`); non-square frames and
   scrambled cell orders are handled, but if a sheet's frames are exported out of temporal order
   you may need to add a `FRAME_REORDER` entry.
8. **PNGs must be spec-compliant** or Chromium silently refuses them (`Failed to load image` in
   the renderer console). The scripts embed minimal encoders — a wrong CRC-32 implementation
   breaks every image. Verify regenerated art by running the app, not just opening it in Paint.
9. **Security/privacy**: never log or commit `settings.json`, friend codes, tokens. Keep the
   preload bridge surface minimal.
10. **Keep `package.json` `overrides.extract-zip@^2.0.1`** — it patches a high-severity CVE in
    Electron's install path.

---

## 6. Current repo state (IMPORTANT — read before you trust `git`)

Repo was cleaned up on 2026-09-22: history was rewritten with `git filter-repo` to strip
`node_modules/`, `release/`, and the four retired species out of **every commit**, then
force-pushed to GitHub as fresh `main` history (`ambaraka-bit/desktop-pets`). Concretely,
right now:

- **Final species set: `GingerCat` only.** `FireWizard`, `LightningMage`, `WandererMagican`,
  and `Swordman` were confirmed unused and are **permanently cut** — from disk, the index,
  and all of history. Do not restore them.
- **History is lean (~13.5MB).** Two legacy "Initial" commits + cleanup commits; no
  `node_modules`/`release`/species blobs anywhere. All source files, configs, docs, tests,
  and the `GingerCat` kit are committed and pushed on `main` — working tree is clean.
- **`node_modules/` and `release/` are gitignored** and must never re-enter the index
  (`npm install` + `npm run dist` regenerate them).
- `settings.js` fallback species is `GingerCat` (was `FireWizard`); the setting actually
  drives a fresh install's first pet.

Do NOT commit `settings.json`, `.bak`, or tokens.

---

## 7. Known issues / open work

1. **No code signing** — installer/update triggers SmartScreen "Unknown Publisher". To sign you'd
   supply `CSC_LINK`/`CSC_KEY_PASSWORD` (or `win.certificateFile`/`certificatePassword`) and keep
   `signAndEditExecutable: false` (electron-builder's `winCodeSign` breaks on Windows symlinks).
2. **Repo hygiene** (§6) — resolved 2026-09-22: history rewritten (no `node_modules`/`release`
   blobs), all source committed, retired species cut, pushed to GitHub on `main`. Remaining
   nicety: branch protection / tags if a release workflow starts depending on them.
3. **Version skew — resolved 2026-09-22.** `package.json`/`package-lock.json` bumped to 0.3.0
   (was 0.2.0, with the last actually-shipped installer still at 0.1.0). The next `npm run dist`
   / `npm run publish` will produce the first installer that matches the declared version.
4. **`GiingerCatAngry.png` filename typo** — load-bearing (species.js scans by name). If renamed,
   behavior mapping still works (`contains('angry')` → special) but grep for every reference.
5. **PeerJS depends on a free public broker** (`0.peerjs.com`, in the CSP `connect-src`) — no
   fallback if it's down or rate-limited.

### Reasonable next steps (pick one, verify with the human)

- Add a new species (drop art in `assets/Characters/<Name>/`, add a test for its `animationBehavior`).
- Improve migration UX (queued migrations, per-friend lists, guest cap).
- Cross-compile/portability study (Electron packaging is Windows-only by design — don't silently
  add mac/linux support).
- Real usage instrumentation (count pets, session metrics) via `console.log` gated behind `DP_DEBUG`.

---

## 8. Definition of done (checklist for any task)

- [ ] Understand the intended behavior first (read PROJECT-STATUS.md §4–§6 for the feature).
- [ ] Mirror any new IPC channel into `preload.js`.
- [ ] Route any new settings/P2P payload through the existing sanitizers.
- [ ] `npm test` green (25/25 — add tests for new pure logic in `tests/core.test.js`).
- [ ] `npm run lint` and `npm run format:check` clean (run `npm run lint:fix`/`npm run format` if needed).
- [ ] `npm run smoke` exits 0 if you touched boot/IPC/window code.
- [ ] `node --check <file>` on each edited Node file.
- [ ] Update `PROJECT-STATUS.md` §11 (Recent Changes) and this file's §3/§5 if you add modules,
      channels, settings, or conventions — so the next agent starts from truth.
