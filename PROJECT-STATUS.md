# Desktop Pets — Project Guide & Handoff Notes

> Onboarding document for anyone (a coworker or another AI) picking up this project cold.
> Read **§1** to run it, **§2–§5** to understand it, and **§8+** to work on it safely.

## What is this?

**Desktop Pets** is a Windows-only Electron app that puts little animated characters on your
desktop. They walk along the taskbar, wander across monitors, react to clicks, make sounds,
and swap their species on demand. The fancy part is the **P2P "Friends" feature**: two installs
can connect over WebRTC and one can "send" a pet to appear on the other person's screen, like a
Tamagotchi visit.

There is **no backend server, no database, and no build step** — plain HTML5 Canvas rendering,
and a free public WebRTC signaling broker (PeerJS) is the only external service.

---

**Where things stand (handoff snapshot):**

- **Working:** multi-monitor transparent pets + autonomous AI, tray controls, settings & global
  hotkeys, roster/position persistence, single-instance lock, and P2P Friends (multi-connection,
  pet migration, chat + chat-echo) — see §6 and §11.
- **Species:** `FireWizard`, `LightningMage`, `WandererMagican` (full kits) plus `GingerCat` (now a
  full kit too: Idle/Walk/Run/Jump/Angry/Punch/Kick, so it no longer relies on the §11.9 fallback).
  Adding a species is just dropping a folder in — see §11.10.
- **Verification:** `npm test` 25/25 green, `npm run lint` + `npm run format:check` clean,
  `npm run smoke` exits 0.
- **Only known open item:** installer/update code signing (SmartScreen warning) — §8.

---

## 1. Quick Start

**Prereqs:** Windows 10/11, Node 24.x (built against v24.18.0 / npm 11.16.0).

```bash
npm install        # if npm blocks install scripts, run:
                   #   npm approve-scripts electron
                   #   npm approve-scripts electron-builder
                   #   npm approve-scripts --allow-scripts-pending

npm start          # launch the app (dev mode)
npm run smoke      # launch + auto-quit after 10s = boot health check
```

**What you should see:** transparent pixel-art pets standing on the taskbar, plus a system tray
icon (add/remove pets, pause/mute, Settings, Friends, Quit).

| Command                | What it does                                                      |
| ---------------------- | ----------------------------------------------------------------- |
| `npm start`            | Run the app in dev mode                                           |
| `npm test`             | 25 unit tests (`node --test`)                                     |
| `npm run lint`         | ESLint 9 (flat config)                                            |
| `npm run format:check` | Prettier across the repo                                          |
| `npm run smoke`        | Boot the app, open all 3 windows, auto-quit with a pass/fail code |
| `npm run dist`         | Build the Windows NSIS installer into `release/`                  |
| `npm run publish`      | Build + upload installer to a GitHub Release (needs `GH_TOKEN`)   |
| `npm run gen-icon`     | Regenerate `build/icon.ico` + `assets/tray-icon.png`              |

> The repo has `node_modules/` and `release/` gitignored — never commit them. The git history is
> currently messy (many source files are untracked, and `node_modules`/`release` were committed at
> some point); tidy that up before the first real push.

---

## 2. Tech Stack

| Piece                             | Version  | Role                                                             |
| --------------------------------- | -------- | ---------------------------------------------------------------- |
| Electron                          | ^44      | App shell; transparent/click-through overlay + 2 helper windows  |
| HTML5 Canvas 2D                   | —        | All rendering (no game engine, no UI framework)                  |
| Howler.js                         | ^2.2.4   | Sound effects (a global `<script>`, never `require()` — see §12) |
| PeerJS                            | ^1.5.5   | WebRTC wrapper for the P2P Friends feature (free public broker)  |
| electron-builder                  | ^26.15.3 | NSIS installer packaging                                         |
| electron-updater                  | ^6.8.9   | Self-update from GitHub Releases                                 |
| Node `--test` / ESLint / Prettier | —        | Test + lint + format tooling                                     |

All renderer processes are **sandboxed** (`contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`) and reach Node only through the whitelisted `window.api` bridge in `preload.js`.

---

## 3. Project Structure

```
desktop-pets/
  main.js                  Main process: windows, tray, IPC hub, settings persistence,
                           multi-monitor virtual desktop, foreground-window watcher, DND
                           auto-pause, single-instance lock, global hotkeys, auto-updater,
                           P2P consent dialogs, smoke-test harness
  preload.js               contextBridge: the ONLY surface sandboxed renderers get (window.api)
  renderer.js              Overlay glue: IPC subscriptions, async boot, rAF main loop (tick)
  state.js                 Shared renderer globals + screen-relative helpers + sound playback
                           (must load FIRST of the renderer files — see §12)
  pet-ai.js                Pet lifecycle + autonomous AI state machine; roster sync (syncPetsToMain)
  renderer-draw.js         Sprite-sheet resolution, frame detection, chat bubbles, all drawing
  p2p.js                   PeerJS client, multi-friend connections, message handling, migration
                           timeouts, away-pet recall, chat echo, friend status/badge
  interaction.js           Pet menu (CHAT/RENAME/CONTROL/HISTORY/SWAP…), drag-drop,
                           keyboard control mode, panels
  settings.js              MAIN-ONLY settings schema: defaults, ranges, sanitizeSettings,
                           atomic saves (~.bak), crypto peer-code generation
  utils.js                 Pure helpers shared by renderer AND Node tests (no DOM/Electron)
  species.js               MAIN-ONLY: scans assets/Characters/ via the species:scan IPC handle
  index.html               Overlay window markup + CSS (canvas, pet menu, chat, history, echo)
  settings.html + settings-renderer.js   Settings window UI
  friends.html + friends-renderer.js     P2P Friends window UI (connect, away/guest lists)
  tests/core.test.js       Unit tests: utils.js + settings.js + P2P message sanitization
  scripts/                 generate-icon.js (app/tray icons), generate-pet.js (procedural demo Kitty pet)
  build/icon.ico           App icon (generated blob mascot)
  assets/
    Characters/<Species>/<Anim>.png      One sprite-sheet PNG per animation
    sounds/footstep.wav, idle.wav        Placeholder sounds
  .github/workflows/ci.yml CI: npm ci → test → lint → format on windows-latest
```

---

## 4. Architecture (how it fits together)

### 4.1 Process model

Four processes are involved at runtime:

```
┌──────────────────────────────────────────────────────────────┐
│ MAIN PROCESS (main.js — Node, has fs/child_process/net)      │
│  windows · tray · settings.json · foreground watcher · IPC   │
└───┬──────────────┬───────────────┬───────────────┬───────────┘
    │ overlay      │ Settings win  │ Friends win   │ (PowerShell watcher,
    │ index.html   │ settings.html │ friends.html  │  child process)
    └──────────────┴───────────────┴───────────────┘
      all sandboxed renderers — only talk via window.api
```

The **overlay window is special**: transparent, frameless, spans every display, always-on-top,
and **click-through except while the cursor is over a pet** (`setIgnoreMouseEvents(true,
{forward: true})`). The renderer hit-tests the cursor against pet bounding boxes on every
mousemove and asks main to un-ignore the mouse only while hovering a pet or an open panel.

### 4.2 Renderer boot & main loop

`index.html` loads scripts in a strict order (see §12). `renderer.js`'s `boot()`:

1. `setupIPC()` — subscribe to all main→renderer events (see 4.3).
2. Ask main for the species registry (`species:scan`) — this produces `SPECIES` and
   `DEFAULT_SPECIES_ID`.
3. Apply the saved settings + pet roster (`restore-settings`), spawning saved pets.
4. Preload all sprite sheets (`Image.src` per animation).
5. Start `requestAnimationFrame` `tick()`: for each pet run `updateState()` (AI state machine),
   `updateAnimationFrame()`, then `draw()` everything.

Pets freeze **only** when explicitly paused (user toggle via tray/hotkey/Ctrl+Alt+P or the DND
auto-pause for fullscreen apps). Nothing else stops the loop — notably, the pets keep moving
while the overlay itself has focus (that was a real bug, see §11.5).

### 4.3 IPC surface (mirrors `preload.js` exactly — keep it in sync)

| Direction                | Channels                                                                                                                                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Renderer → main `send`   | `settings-changed`, `set-mouse-ignore`, `pets-changed`, `copy-to-clipboard`, `friends:connect-request`, `friends:disconnect-request`, `friends:recall-request`, `friends:send-home-request`, `friends:request-status`, `friends:status-update` |
| Renderer → main `invoke` | `species:scan`, `generate-peer-code`, `show-confirm-dialog`                                                                                                                                                                                    |
| main → renderer `on`     | `display-info`, `restore-settings`, `set-paused`, `add-pet`, `remove-pet`, `apply-settings`, `foreground-window`, all `friends:*` above, `init-settings-values`, `settings-roster-update`                                                      |

The **Friends window and the overlay live in different processes**, so main relays every
`friends:*` message between them.

### 4.4 Settings & persistence

- Saved to `%APPDATA%/desktop-pets/settings.json` (atomic write + rolling `.bak` for corruption
  recovery).
- **Every read and write goes through `sanitizeSettings()`** (settings.js) which clamps ranges,
  coerces booleans, and caps strings — so a corrupt file or tampered IPC payload can't poison
  the app.
- The pet roster is `settings.activePets`, an array of **profiles** `{ speciesId, name?, x? }`
  (legacy string entries are auto-upgraded). The overlay is the source of truth for the roster
  and pushes a full snapshot via `pets-changed` after every add/remove/migrate/disconnect.
- Settings window values flow: settings window → `settings-changed` → main sanitizes → main
  re-broadcasts `apply-settings` to the overlay.

### 4.5 Species / animation system

- A species is a folder under `assets/Characters/`. Each animation is **one sprite-sheet PNG**
  (`Idle.png`, `Walk.png`, `Attack_1.png`, …), a horizontal strip of square frames.
- The main process scans the folders (`species.js`); the frame count/width is sniffed **at load
  time** from the actual pixel geometry (`resolveSheet()` in renderer-draw.js), so non-square
  frames work too.
- Current species: `FireWizard`, `GingerCat`, `LightningMage`, `WandererMagican`. Add a new one by
  dropping a folder in — no code changes. Animation file names are matched case-insensitively
  (`idle.png` works the same as `Idle.png`), and frame layout is sniffed from the pixels at load
  time, so both square-frame strips (e.g. `FireWizard/Idle.png` = seven 128×128 cells) and
  non-square packed sheets (e.g. `GiingerCatAngry.png` = six 366×330 cells — yes, that sheet ships
  with a double-i typo in its filename — `GingerCatRun.png` = eight 381×238 cells,
  `GingerCatPunch.png` = twelve 280×170 cells, `GingerCatKick.png` = nine 348×302 cells) resolve
  automatically.
- **Behavior fallback parity:** a species only _needs_ Idle/Walk art. When a dedicated sheet is
  missing the engine reuses the walk/idle sheet at that behavior's speed, so a partial asset set
  can still run, charge, jump, and trigger click/number-key reactions — full mobility with
  repurposed art instead of inert idle/walk-only pets.

### 4.6 P2P Friends (the interesting part)

- Each install has a persistent 6-character **friend code** (crypto-generated, no
  confusing-looking characters).
- `p2p.js` runs in the **overlay renderer** (it has the Peer instance). Connections are tracked
  in a `friendConnections` Map; one is the "primary" for the status badge + Send-to-Friend.
- **Pet migration**: Send → `pet-migrate-request`; receiver gets a native Accept/Decline dialog →
  `pet-migrate-accept/reject`; the pet leaves your roster (`awayPets`) and appears on their
  screen as a guest with a `migrationId`. Timeouts auto-recall pets if the friend never answers.
- **Chat**: caret shows bubbles locally; chatting _through_ a guest pet sends a `chat-echo` so its
  owner sees a banner. All message types are schema-validated (`sanitizeP2PMessage`) on arrival.
- On disconnect, only that friend's away pets are recalled and only their guests removed; the
  next connected friend is auto-promoted to primary.

---

## 5. Concepts / Glossary

| Term           | Meaning                                                                      |
| -------------- | ---------------------------------------------------------------------------- |
| Local pet      | A pet you own, in your `pets` array.                                         |
| Guest pet      | A pet sent to you by a friend (`isGuest`, has `migrationId` + `guestOwner`). |
| Away pet       | A pet you sent to a friend; lives in `awayPets` until recalled.              |
| Primary friend | The connected friend the UI treats as "the" friend.                          |
| `migrationId`  | Unique token naming one pet transfer; used for accept/reject/recall/echo.    |
| Click-through  | Mouse events pass through the overlay to windows underneath, except on pets. |
| DND            | Do-Not-Disturb: auto-pause when a fullscreen app owns the screen.            |

---

## 6. Features (what a user actually experiences)

- Pets idle/walk autonomously, wrap around screen edges, and break into "event" animations
  (attack/fireball/jump) on a random 8–20s timer.
- **Click a pet** → pixel menu: CHAT (speech bubble, 4s), RENAME, CONTROL (keyboard: arrows/WASD
  walk, Up/Space jump, 1-0 trigger animations, Esc releases), HISTORY (chat log panel),
  SWAP TO (change species in place), SEND TO FRIEND / SEND HOME (P2P, context-dependent).
- Click-and-drag pets anywhere; they re-snap to the taskbar floor when dropped.
- Settings: size 20–200%, speed 20–300%, volume/mute, reduce-motion, high-contrast,
  larger-sprites, show-over-apps, walk-on-borders, DND, auto-launch. Global hotkeys
  `Ctrl+Alt+P` (pause) and `Ctrl+Alt+M` (mute).
- **Multi-monitor**: one overlay spans all displays; each pet lands on the correct taskbar
  height per monitor (`floorYForX()`), including while dragging across screens.
- **Screen-relative scaling**: everything scales from a `canvas.height/1080` factor, so pets look
  consistent on 720p → 4K.
- **Tray**: Add/Remove Pet, Pause/Resume, Mute/Unmute, Settings, Friends, Check for Updates, Quit.
- **Foreground-window watcher** (a PowerShell child process sampling Win32 APIs every 250ms):
  drives DND auto-pause and "walk on window borders".

---

## 7. Security model (do not weaken)

- Renderers are fully sandboxed; `window.api` is the **only** way into Node, and every channel
  must be listed in `preload.js` or the call is blocked with a console warning.
- Both inbound P2P data (`sanitizeP2PMessage`) and on-disk settings (`sanitizeSettings`) are
  validated at the two main entry gates. New message types/settings must go through these.
- PeerJS uses a public broker only for signaling; chat/pet data goes peer-to-peer over WebRTC.

---

## 8. Known Issues / Unresolved

1. **No code signing.** Installer + updates are unsigned → SmartScreen "Unknown Publisher"
   warnings. `signAndEditExecutable: false` stays because electron-builder's `winCodeSign`
   package breaks on Windows symlinks. To sign, supply `CSC_LINK` + `CSC_KEY_PASSWORD` (or
   `win.certificateFile`/`win.certificatePassword`) and keep `signAndEditExecutable: false`.

That's the only known open item. Everything else in §11 is verified done.

---

## 9. Testing & Verification

```bash
npm test              # 25 unit tests (utils.js + settings.js + sanitizeP2PMessage)
npm run lint          # ESLint 9 flat config
npm run format:check  # Prettier (printWidth 100, single quotes, no trailing commas)
npm run smoke         # boots all 3 windows, auto-quits: exit 0 = pass
node --check main.js  # fast syntax sanity check on hand-edited files
```

CI (`.github/workflows/ci.yml`) runs `npm ci` → `npm test` → `npm run lint` →
`npm run format:check` on `windows-latest`. The GUI smoke boot is left out of CI because it
needs an interactive display; run it locally.

---

## 10. Packaging & Release

- `npm run dist` → `release/Desktop Pets Setup <version>.exe` (NSIS). Version comes from
  `package.json`; pump it for real releases.
- `npm run publish` → build **and** upload to a GitHub Release via electron-builder's GitHub
  provider (needs a `GH_TOKEN` env var). This is entirely separate from `git push`.
- Auto-update: packaged builds check GitHub Releases on launch (dev mode is guarded with
  `app.isPackaged`), ask before downloading, ask before restarting.

---

## 11. Recent Changes

### 11.1 Single-instance lock + hardened smoke exit code

Second launches now quit and focus the existing overlay instead of spawning a duplicate instance
(previously a duplicate could steal the peer code and make the tray count look wrong). Smoke test
exits 0 only when all three windows report `did-finish-load`.

### 11.2 Pet names & positions survive relaunch

`activePets` is now `{ speciesId, name?, x? }` profiles; restore re-clamps positions to the live
canvas. Legacy string rosters upgrade automatically.

### 11.3 Multiple simultaneous friends

Every connection lives in a Map with per-friend timeouts, recalls, and guest cleanup. Only the
primary is shown in the badge/Friends window; a dying connection promotes the next friend.

### 11.4 Pet menu grew: HISTORY, SWAP TO, chat echo

Chat history panel (`chatHistory`, capped at 30 entries), in-place species swap
(`changePetSpecies`, hidden for guests), and `chat-echo` banners for messages sent through guest
pets.

### 11.5 Fixed: pets froze after clicking a character

Clicking a pet focused the overlay; main's foreground watcher (which excludes our own PID) then
reported "no foreground window", and the renderer mis-read that as a pause signal, freezing every
pet until focus moved elsewhere. Pets now pause **only** on explicit pause / DND. This also
fixed walk-on-borders (the foreground-window rect was never actually stored before).

### 11.6 Legacy Swordsman species removed

`FireWizard`, `LightningMage`, `WandererMagican` remain, later joined by `GingerCat` (originally a
pair of single-frame portraits, later replaced with nine-frame `GingerCatIdle.png` /
`GingerCatWalk.png` strips). Docs updated.

### 11.7 App icon regenerated

`scripts/generate-icon.js` draws an original pixel blob mascot → `build/icon.ico` +
`assets/tray-icon.png` (regenerated 2026-09-12).

### 11.8 CI + smoke script added

`.github/workflows/ci.yml` + `npm run smoke`.

### 11.9 Behavior fallback parity (partial asset sets)

The engine was fully generic already, but pets whose species folder lacked dedicated sheets were
visually crippled: missing run/charge/jump art meant no sprint/dash/jump and dead click/number-key
reactions. `animForBehaviorWithFallback()` (pet-ai.js) now reuses a species' walk/idle sheets at
the target behavior's speed, and the interaction number-key + click-reaction pools fall back to
idle/walk. GingerCat (Idle/Walk only) now behaves like a full pet. The interim
`scripts/generate-gingercat.js` was removed (its output would have duplicated the new
`GingerCatIdle.png`/`GingerCatWalk.png` sheets).

### 11.10 GingerCat asset handoff + adding a species

GingerCat began as two single-frame 3200×3200 portraits; a throwaway script baked them into
bob-animated strips. Those were later replaced with real nine-frame sheets (`GingerCatIdle.png`,
`GingerCatWalk.png`) whose 856/877px non-square frames resolve automatically via the pixel sniffing
in `resolveSheet()` — the folder is now the whole asset story, no code or manifest involved. The
kit later grew to a full set: `GingerCatRun.png` (eight 381×238), `GingerCatJump.png` (nine
320×285), `GiingerCatAngry.png` (six 366×330 — note the double-i typo in that sheet's filename) and
`GingerCatPunch.png` (twelve 280×170) and `GingerCatKick.png` (nine 348×302). All resolve via the
same pixel sniffing, giving GingerCat dedicated run/jump art plus three number-key / surprise
"special" moves (Angry, Punch, Kick).

To add a NEW species: create `assets/Characters/<Name>/` and drop one PNG per animation (e.g.
`Idle.png` + `Walk.png`). Naming is case-insensitive, and extra behaviors
(`Run`/`Charge`/`Jump`/`Attack_*`/`Hurt`/`Dead`) are optional — §11.9's fallback fills any gaps.
Then pick it in the tray's **Add Pet** list. PNG validity gotcha: §12.

---

### 11.11 Animation pacing tuned (slower default rates + fast punch)

Global frame durations now live in `state.js` as named constants: `FRAME_DURATION_MS` = 260
(idle/event), `FRAME_DURATION_WALK_MS` = 180, `FRAME_DURATION_RUN_MS` = 90,
`FRAME_DURATION_CHARGE_MS` = 80. The old per-state values made idle/event frames ratchet too fast
and jittery to look natural.

GingerCat's punch/kick play as **event** animations, so they inherit the slow 260ms event rate and
looked like lazy arm/leg waves instead of strikes. `ANIM_FRAME_DURATION_MS` in pet-ai.js lets a
single animation override that: `'GingerCat/GingerCatPunch': 45` snaps its 12 frames through in
~540ms and `'GingerCat/GingerCatKick': 45` its 9 frames in ~405ms.
`frameDurationForState(pet)` checks the override first (via `pet.eventAnimation ||
animationNameFor(pet)`), then falls back to the state defaults — a future fast/snappy one-shot only
needs one line in that map.

### 11.12 GingerCat run gait smoothed: smooth-run exit + frame reorder

`GingerCatRun.png`'s 6 frames are exported in a scrambled, non-temporal order, and an autonomous
run cut mid-sheet used to visibly "pop" when the state timer expired mid-stride. Two fixes:

- `FRAME_REORDER['GingerCat/GingerCatRun'] = [0, 1, 2, 5, 3, 4]` in renderer-draw.js maps logical
  frame i → source sheet column (a brute-force Hamiltonian-cycle search found the true pose order),
  so the gait animates forward instead of stutter-jumping through the sheet. The idle sheet is
  scrambled the same way — `FRAME_REORDER['GingerCat/GingerCatIdle'] = [0, 1, 5, 2, 4, 7, 8, 6, 3]`
  smooths its breathing bob the same way.
- `SMOOTH_RUN_SPECIES` + `runShouldFinishCycle()` + `pet.smoothRunExit` in pet-ai.js: when the run
  state timer expires, run-species pets don't switch states immediately — they finish the current
  stride cycle first (`smoothRunExit` is checked in `updateAnimationFrame`, which calls
  `pickNextAutonomousState()` at the loop boundary), removing the mid-stride snap.

### 11.13 Control mode faces the last arrow key pressed

In CONTROL mode, pressing ←/A or →/D now flips `controlledPet.direction` immediately in
interaction.js's `keydown` handler (line ~322/~340) instead of only being applied on the next
movement tick. The pet faces the last arrow key pressed right away — even while idle, mid-jump, or
mid-event — instead of snapping direction only once it starts moving again. The same key press also
faces EVERY pet on screen that way (guests and autonomous pets included), so the herd turns together
with the last arrow key.

### 11.14 Pixel menu / panels stay on-screen (clamp fix)

`clampMenuPosition()` (interaction.js) now picks the display by x **and** y (matching x-range
alone grabbed the wrong zone on stacked/overlapping monitors), falls back to the whole overlay
window when the cursor is in a monitor seam/gap or no display info is available, and uses
`Math.max` guards so an oversized menu never produces negative clamped coordinates. `.pixel-panel`
in index.html also caps `max-width`/`max-height` to the viewport and scrolls (`overflow: auto`),
so a large menu/SWAP-TO row can no longer be cropped at the screen edge.

---

## 12. Gotchas & Conventions (read before changing code)

- **Renderer script load order is load-bearing.** `index.html` must keep: howler → peerjs →
  utils → state → pet-ai → renderer-draw → p2p → interaction → renderer. `state.js` globals are
  used at call-time by later modules.
- **`require` only in main-side files.** Sandboxed renderers have no `require`. Howler must be a
  global `<script>` tag (its UMD detection breaks under Electron's isolated world otherwise).
- **Any new IPC channel** must be added to the matching list in `preload.js` or it silently
  blocks. Keep the `preload.js` mirrors (§4.3) accurate.
- **Windows-only assumptions:** PowerShell spawn (foreground watcher), `set X=1&&` smoke script,
  `app.setLoginItemSettings`, NSIS packaging. Don't add cross-platform code expecting a CI on
  Linux/macOS to pass.
- **Settings/privacy:** never store/commit the friend code, keys, or tokens; settings are
  sanitized per-read. Don't log `settings.json` at production log levels.
- **`package.json` `overrides` pins `extract-zip@^2.0.1`** to patch a high-severity transitive
  CVE in Electron's install path — keep it.
- **npm 11 blocks install scripts** — see §1 for `npm approve-scripts` commands.
- **PNG files must be spec-compliant or Chromium silently refuses them.** A sheet can open fine in
  Paint/GDI+ yet fail in the app with a renderer-console "Failed to load image". We hit exactly this
  with a hand-rolled encoder whose CRC-32 shift loop sat outside the per-byte loop — libpng rejected
  every image. If you regenerate sprite sheets by hand, keep the encoder standard (a correct CRC-32
  returns `cbf43926` for the ASCII check string `123456789`) or re-encode with a real PNG library,
  then verify in-app via `nativeImage.createFromPath`.
