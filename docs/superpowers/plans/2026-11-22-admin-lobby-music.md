# Admin Lobby Music Management & Uploads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/admin` controls to toggle, reorder (including the live topbar show track), preview, delete, and chunk-upload lobby music tracks that persist in `data/` and sync smoothly with fade-in/fade-out to live TVs.

**Architecture:** A dedicated store (`src/music/lobby-store.js`) reconciles read-only built-in `music/lobby/` tracks with persisted uploads in `data/music/lobby/` and playlist config in `data/admin/lobby-music.json`, using 2 MB chunked uploads + optional `ffmpeg -c copy -write_xing 1` normalization. Express routes expose public playback (`/api/lobby-music`, `/music/lobby/uploads/*`) and OIDC-guarded `/admin/api/lobby-music*` endpoints, broadcasting `LOBBY_MUSIC_UPDATED` over WebSocket to host TVs where `lobby-music.js` applies the new queue using the existing 1.5s fade-in and 1.2s/2s fade-out envelope.

**Tech Stack:** Node.js 22+ ESM, Express 5 (`express.raw` + `express.json`, zero new npm dependencies), `ws`, Vanilla browser JS + Tailwind CDN, Alpine `ffmpeg` in Docker, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-22-admin-lobby-music-design.md`

## Global Constraints

- Zero new npm dependencies in `package.json`; use Express 5 built-ins and Node 22 standard library only.
- Persist uploaded audio in `data/music/lobby/` and playlist config in `data/admin/lobby-music.json` (atomic temp-file + rename); never write to or delete files in git-tracked `music/lobby/`.
- Allowed audio extensions: `.mp3`, `.ogg`, `.m4a`, `.wav` (case-insensitive, lowercased on upload); max assembled upload size `25 MB` (`25 * 1024 * 1024`); upload chunk size `2 MB` (`2 * 1024 * 1024`, Express raw limit `4mb`).
- Preserve `GET /api/lobby-music` response shape `{ tracks: string[] }` and built-in URL format `/music/lobby/<encodeURIComponent(filename)>` so `topbar-show.js` keeps matching `Looks-good-to-me-remix.mp3` by basename without changes to `topbar-show.js`.
- Every lobby track transition follows `lobby-music.js` fade timing: `1500ms` fade-in, `2s` end-of-track tail fade-out, `1200ms` exit/switch fade-out; clicking "Play from #1 on live TVs" leaves TVs already playing `#1` undisturbed.
- Vitest tests must use explicit imports (`describe`, `it`, `expect`, etc.) — test globals are disabled. Never let tests read or mutate real `data/admin/lobby-music.json` or `data/music/lobby/`.

## Review Focus

1. **Path traversal, dotfiles, & spoofed audio uploads:** filenames like `../../evil.mp3`, `.hidden.mp3`, or non-audio bytes with `.mp3` extension must be rejected (`400`), leave no `.part` or final file on disk, and `DELETE` must refuse `builtin:*` IDs (`400`). *(Pinned in Task 1 & Task 2)*
2. **Stale, out-of-order, or oversized chunk uploads:** chunks with mismatched `X-Chunk-Offset`, overflowing declared size or `25 MB`, premature `/finish`, or abandoned `.part` files on startup must fail cleanly (`400`/`404`/`409`) and clean up `.part` files. *(Pinned in Task 1 & Task 2)*
3. **Missing or failing `ffmpeg` during `.mp3` upload:** when `ffmpeg` is absent (`ENOENT`) or exits non-zero, the upload still succeeds with original bytes intact and reports `xingWarning: true` if no `Xing`/`Info` frame header is present. *(Pinned in Task 1)*
4. **Mid-transition races on TV (`lobby-music.js`):** starting a game (`setActive(false)`) during a `1200ms` track-switch fade-out cancels the pending switch and pauses cleanly; disabling all tracks fades out to silence and re-enabling a track resumes with a `1500ms` fade-in; `restart: true` when already playing `tracks[0]` does not interrupt playback. *(Pinned in Task 3)*
5. **Admin UI rollback, preview cleanup & `TBS_SHOWS` sync:** failed reorder/toggle `PUT` restores the prior UI state and surfaces an error; deleting the currently previewing track stops the preview `<audio>`; `LIVE_SHOW_TRACKS` keys stay identical to `TBS_SHOWS` in `public/js/topbar-show.js`. *(Pinned in Task 1 & Task 4)*

---

## File Map

- Create: `src/music/lobby-store.js` — track discovery, config persistence, sanitization, magic-byte check, MP3 Xing detection + optional `ffmpeg` remux, chunked upload sessions, deletion.
- Modify: `src/transport/http.js` — mount `/music/lobby/uploads` before `/music`; serve `/api/lobby-music` from lobby music store.
- Modify: `src/transport/ws-adapter.js` — add `broadcastHosts(message)` to `wsControls`.
- Modify: `src/transport/admin-routes.js` — add `/admin/api/lobby-music*` routes.
- Modify: `src/server.js` — invoke `cleanupStaleUploads()` on startup.
- Modify: `Dockerfile`, `Dockerfile.dev` — add `RUN apk add --no-cache ffmpeg`.
- Modify: `public/js/lobby-music.js` — add `setTracks(nextTracks, { restart })` and `reload()` with smooth fade transitions.
- Modify: `public/host.html` — handle `LOBBY_MUSIC_UPDATED` and reconnect `DISPLAY_OK` reload.
- Modify: `public/admin.html`, `public/js/admin.js` — add Lobby Music section UI and client controller.
- Modify: `AGENTS.md` — document `data/music/lobby/` and `data/admin/lobby-music.json`.
- Create: `tests/music/lobby-store.test.js`, `tests/transport/lobby-music-admin.test.js`, `tests/frontend/admin-lobby-music.test.js`.
- Modify: `tests/transport/music-routes.test.js`, `tests/frontend/lobby-music.test.js`.

---

### Task 1: Lobby Music Store & Chunked Upload Service

**Files:**
- Create: `src/music/lobby-store.js`
- Test: `tests/music/lobby-store.test.js`

**Interfaces:**
- Consumes: `public/js/topbar-show.js` (`TBS_SHOWS` keys mirrored in `LIVE_SHOW_TRACKS`, verified by test).
- Produces (exported from `src/music/lobby-store.js`):
  - Constants: `MAX_UPLOAD_BYTES` (`25 * 1024 * 1024`), `UPLOAD_CHUNK_BYTES` (`2 * 1024 * 1024`), `LIVE_SHOW_TRACKS` (`{ 'Looks-good-to-me-remix.mp3': { showUrl: '/shows/looks-good-to-me.json' } }`), `DEFAULT_UPLOADS_DIR`, `DEFAULT_CONFIG_FILE`.
  - Helpers: `sanitizeAudioFilename(raw) -> { ok, filename, ext, error }`, `validateAudioMagic(buf, ext) -> boolean`, `mp3HasXingHeader(buf) -> boolean`.
  - Factory: `createLobbyMusicStore({ builtinDir, uploadsDir, configFile, ffmpegRunner, uploadTtlMs, maxSessions } = {}) -> store`:
    - `store.uploadsDir` (`string`, resolved path to uploaded audio directory)
    - `store.listTracks() -> Promise<Array<{ id, filename, title, url, source, enabled, liveShow, sizeBytes, xingWarning }>>`
    - `store.getActiveUrls() -> Promise<string[]>`
    - `store.saveConfig(entries) -> Promise<Track[]>` (`entries: Array<{ id: string, enabled: boolean }>`)
    - `store.startUpload({ filename, size, position }) -> Promise<{ ok, status?, error?, uploadId?, chunkSize? }>`
    - `store.appendUploadChunk(uploadId, offset, buffer) -> Promise<{ ok, status?, error?, receivedBytes? }>`
    - `store.finishUpload(uploadId) -> Promise<{ ok, status?, error?, track?, tracks?, xingNormalized?, xingWarning? }>`
    - `store.abortUpload(uploadId) -> Promise<{ ok: boolean }>`
    - `store.deleteUpload(id) -> Promise<{ ok, status?, error?, tracks? }>`
    - `store.cleanupStaleUploads() -> Promise<number>`
  - Default singleton: `defaultLobbyMusicStore` (using `music/lobby`, `data/music/lobby`, `data/admin/lobby-music.json`).

- [ ] **Step 1: Write failing unit tests in `tests/music/lobby-store.test.js`**

Cover with isolated `os.tmpdir()` directories per test:
1. Default listing when no config exists: returns built-ins alphabetically (`builtin:<name>`, `/music/lobby/<encoded>`), tags `Looks-good-to-me-remix.mp3` with `liveShow: true`, ignores non-audio files and subdirectories, and `LIVE_SHOW_TRACKS` keys exactly equal `TBS_SHOWS` keys parsed from `public/js/topbar-show.js`.
2. `saveConfig` + reconciliation: reorders tracks (moving `builtin:Looks-good-to-me-remix.mp3` to index 0), disables a track (`enabled: false`), omits disabled tracks from `getActiveUrls()`, drops stale config IDs whose files vanished from disk, and appends newly added disk files at the end with `enabled: true`.
3. `sanitizeAudioFilename` & `validateAudioMagic`: rejects `../../evil.mp3`, `.hidden.mp3`, `song.exe`, empty names; accepts `My Track (Live).MP3` (lowercasing `.mp3`); validates magic bytes for `.mp3` (`ID3` and `0xFF 0xFB`), `.ogg` (`OggS`), `.wav` (`RIFF....WAVE`), `.m4a` (`....ftyp`), and rejects spoofed text bytes.
4. Chunked upload happy path + collision disambiguation + `position: 'first'` vs `'end'`: `startUpload` → two `appendUploadChunk` calls → `finishUpload` writes into `uploadsDir`, serves `/music/lobby/uploads/<encoded>`, disambiguates duplicate names as `track (2).mp3`, and persists in config at requested position.
5. Chunked upload failure modes: rejects size `0` or `> MAX_UPLOAD_BYTES` (`400`/`413`), mismatched `X-Chunk-Offset` (`409`), overflow chunk (`400`), premature `finishUpload` (`400`), spoofed magic bytes on `finishUpload` (`400`, deletes `.part`), `abortUpload` removes `.part`, and `cleanupStaleUploads` removes leftover `.uploads/*.part` files.
6. `ffmpeg` normalization & fallback: injected `ffmpegRunner` succeeds (`xingNormalized: true`, `xingWarning: false`); injected `ffmpegRunner` throws `ENOENT` or error (`finishUpload` still succeeds with original bytes, `xingNormalized: false`, and `xingWarning: true` when MP3 lacks `Xing`/`Info`, `false` when `Xing`/`Info` is present).
7. `deleteUpload`: refuses `builtin:*` (`ok: false, status: 400`), returns `404` for unknown `upload:*`, deletes real uploaded file + removes from config.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/music/lobby-store.test.js`
Expected: FAIL (`Cannot find module '../../src/music/lobby-store.js'`).

- [ ] **Step 3: Implement `src/music/lobby-store.js`**

Implement all exported constants, helpers, `createLobbyMusicStore`, and `defaultLobbyMusicStore`:
- Atomic config writes (`${configFile}.${process.pid}.${Date.now()}.tmp` → `rename`, creating parent dir).
- `mp3HasXingHeader(buf)`: skip optional ID3v2 header (`10 + syncsafeSize`, plus 10 if footer flag `0x10` set), scan next `8192` bytes for ASCII `Xing` or `Info`; `listTracks` checks the first `16384` bytes of `.mp3` files (`fs.promises.open` + `read`) to populate `xingWarning` (only `true` for `.mp3` when `!mp3HasXingHeader(slice)` and not CBR-flagged? Per spec: `xingWarning: !mp3HasXingHeader(slice)` for `.mp3`, `false` for non-MP3).
- Default `ffmpegRunner(inPath, outPath)`: `execFile('ffmpeg', ['-y', '-i', inPath, '-c', 'copy', '-write_xing', '1', outPath], { timeout: 15000 })` — no shell interpolation.
- Store temp `.part` files inside `path.join(uploadsDir, '.uploads')`; enforce `maxSessions = 8`, `uploadTtlMs = 10 * 60 * 1000`, and `path.resolve(uploadsDir, filename)` containment before any unlink/write.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/music/lobby-store.test.js`
Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
git add src/music/lobby-store.js tests/music/lobby-store.test.js
git commit -m "feat: add lobby music store with chunked upload validation"
```

---

### Task 2: HTTP Routes, WebSocket Broadcast, Admin API & Docker `ffmpeg`

**Files:**
- Modify: `src/transport/http.js:15-60`
- Modify: `src/transport/ws-adapter.js:730-740`
- Modify: `src/transport/admin-routes.js:1-40,350-381`
- Modify: `src/server.js:1-55`
- Modify: `Dockerfile:1-12`
- Modify: `Dockerfile.dev:1-10`
- Modify: `tests/transport/music-routes.test.js`
- Create: `tests/transport/lobby-music-admin.test.js`

**Interfaces:**
- Consumes: `defaultLobbyMusicStore`, `createLobbyMusicStore`, `MAX_UPLOAD_BYTES` from `src/music/lobby-store.js`; `requireAdminSession` from `src/auth/oidc.js`.
- Produces:
  - `setupRoutes(app, manager, { lobbyMusicStore = defaultLobbyMusicStore } = {})` in `src/transport/http.js`:
    - `GET /api/lobby-music` → `{ tracks: string[] }` via `lobbyMusicStore.getActiveUrls()`
    - Static `/music/lobby/uploads` mounted before `/music` serving `lobbyMusicStore.uploadsDir` with `{ index: false, dotfiles: 'deny' }`
  - `wsControls.broadcastHosts(message) -> number` in `src/transport/ws-adapter.js` (sends to every open socket where `socketMeta.get(ws)?.role === 'host'`, returns count sent).
  - `setupAdminRoutes(app, manager = defaultManager, { lobbyMusicStore = defaultLobbyMusicStore } = {})` in `src/transport/admin-routes.js`:
    - `GET /admin/api/lobby-music` → `200 { tracks, activeCount }`
    - `PUT /admin/api/lobby-music` → `200 { tracks, activeCount }` + broadcasts `{ type: 'LOBBY_MUSIC_UPDATED', tracks: activeUrls, restart: false }`
    - `POST /admin/api/lobby-music/uploads` → `201 { uploadId, chunkSize }`
    - `PUT /admin/api/lobby-music/uploads/:uploadId` (`express.raw({ type: () => true, limit: '4mb' })`, header `X-Chunk-Offset`) → `200 { receivedBytes }`
    - `POST /admin/api/lobby-music/uploads/:uploadId/finish` → `201 { track, tracks, activeCount, xingNormalized, xingWarning }` + broadcasts `{ type: 'LOBBY_MUSIC_UPDATED', tracks: activeUrls, restart: false }`
    - `DELETE /admin/api/lobby-music/uploads/:uploadId` → `200 { ok: true }`
    - `DELETE /admin/api/lobby-music/:id` → `200 { ok: true, tracks, activeCount }` + broadcasts `{ type: 'LOBBY_MUSIC_UPDATED', tracks: activeUrls, restart: false }`
    - `POST /admin/api/lobby-music/restart` → `200 { ok: true, notifiedHosts }` + broadcasts `{ type: 'LOBBY_MUSIC_UPDATED', tracks: activeUrls, restart: true }`

- [ ] **Step 1: Write failing transport/admin integration tests in `tests/transport/lobby-music-admin.test.js` and update `tests/transport/music-routes.test.js`**

In `tests/transport/lobby-music-admin.test.js` (with temp dirs + isolated `createLobbyMusicStore`, `setupRoutes`, `setupWebSocket`, and authenticated admin session cookie via OIDC helper or session cookie helper from `src/auth/oidc.js`):
1. Unauthenticated requests to `/admin/api/lobby-music*` return `401`.
2. `GET /admin/api/lobby-music` returns built-in tracks with `liveShow` badge and `activeCount`.
3. `PUT /admin/api/lobby-music` reorders tracks (Live Show #1), disables a track, updates `GET /api/lobby-music` accordingly, and broadcasts `LOBBY_MUSIC_UPDATED` (`restart: false`) to connected **host** WebSockets only (never player WebSockets).
4. Full chunked upload (`POST /uploads` → `PUT /uploads/:id` with `X-Chunk-Offset` → `POST /uploads/:id/finish`), verifies uploaded file is downloadable via `GET /music/lobby/uploads/<name>` (`200`), dotfiles under `.uploads/` are denied (`403`/`404`), and `LOBBY_MUSIC_UPDATED` is broadcast.
5. Invalid uploads (bad magic bytes, wrong chunk offset, oversized declaration) return `400`/`409`/`413` and do not pollute track list.
6. `DELETE /admin/api/lobby-music/builtin:...` returns `400`; `DELETE /admin/api/lobby-music/upload:...` deletes file, updates `/api/lobby-music`, and broadcasts `LOBBY_MUSIC_UPDATED`.
7. `POST /admin/api/lobby-music/restart` broadcasts `LOBBY_MUSIC_UPDATED` with `restart: true` and returns `{ ok: true, notifiedHosts: 1 }`.

In `tests/transport/music-routes.test.js`: pass an isolated `lobbyMusicStore` (pointing `uploadsDir`/`configFile` at an empty temp dir so real `data/` never leaks into the test) while preserving all existing assertions plus checking `/api/lobby-music` respects store ordering.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/transport/lobby-music-admin.test.js tests/transport/music-routes.test.js`
Expected: FAIL (routes/methods not implemented yet).

- [ ] **Step 3: Implement changes in `http.js`, `ws-adapter.js`, `admin-routes.js`, `server.js`, `Dockerfile`, and `Dockerfile.dev`**

- `src/transport/ws-adapter.js`: implement `broadcastHosts(message)` iterating `roomSockets.values()` and sending to every socket with `ws.readyState === ws.OPEN && socketMeta.get(ws)?.role === 'host'`; expose in `wsControls`.
- `src/transport/http.js`: accept optional `{ lobbyMusicStore = defaultLobbyMusicStore }` third arg, mount `/music/lobby/uploads` static middleware before `/music`, wire `GET /api/lobby-music` to `lobbyMusicStore.getActiveUrls()`, pass `{ lobbyMusicStore }` into `setupAdminRoutes`.
- `src/transport/admin-routes.js`: register all 8 `/admin/api/lobby-music*` routes (note: mount `/uploads` routes **before** `DELETE /admin/api/lobby-music/:id` so `/uploads/:uploadId` matches first; decode `req.params.id` cleanly).
- `src/server.js`: call `defaultLobbyMusicStore.cleanupStaleUploads().catch(() => {})` at startup.
- `Dockerfile` & `Dockerfile.dev`: add `RUN apk add --no-cache ffmpeg` right after `WORKDIR /app`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/transport/lobby-music-admin.test.js tests/transport/music-routes.test.js tests/transport/dashboard.test.js`
Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
git add src/transport/http.js src/transport/ws-adapter.js src/transport/admin-routes.js src/server.js Dockerfile Dockerfile.dev tests/transport/music-routes.test.js tests/transport/lobby-music-admin.test.js
git commit -m "feat: add admin lobby music routes, live WS broadcast, and Docker ffmpeg"
```

---

### Task 3: TV Smooth Fade Transitions & Live Playlist Sync

**Files:**
- Modify: `public/js/lobby-music.js:1-110`
- Modify: `public/host.html:444-455`
- Modify: `tests/frontend/lobby-music.test.js`

**Interfaces:**
- Consumes: WebSocket message `{ type: 'LOBBY_MUSIC_UPDATED', tracks: string[], restart?: boolean }` from Task 2; `GET /api/lobby-music`.
- Produces (on object returned by `createLobbyMusic` in `public/js/lobby-music.js`):
  - `setTracks(nextTracks, { restart = false } = {})`
  - `reload()` (re-fetches `playlistUrl` if `loaded`, calls `setTracks(data.tracks, { restart: false })`).

- [ ] **Step 1: Write failing fade-transition tests in `tests/frontend/lobby-music.test.js`**

Add tests pinning every live-update transition rule:
1. Reordering while playing when current track stays enabled (`restart: false`): does NOT cut or restart current track; after current track finishes its 2s tail fade-out and `ended`, advances to the next track in the new order with `1500ms` fade-in.
2. Disabling/removing the currently playing track: smoothly fades out over `1200ms` (`0.12` → `0.06` at `600ms` → `0` at `1200ms`), pauses, switches `audio.src` to new `tracks[0]`, and fades in over `1500ms`.
3. `restart: true` when `tracks[0]` differs from currently playing track: fades out current track over `1200ms`, pauses, switches to `tracks[0]`, and fades in over `1500ms`.
4. `restart: true` when already playing `tracks[0]`: leaves current track playing undisturbed (no pause, no volume dip, `index = 0`).
5. Emptying the playlist (`setTracks([])`): fades out over `1200ms`, pauses, clears `audio.src`; later `setTracks(['/music/new.mp3'])` while active resumes playback at `tracks[0]` with `1500ms` fade-in.
6. Game starts (`setActive(false)`) mid-switch fade-out: cancels the pending switch so the next track does NOT start; completes fade-out to pause cleanly.
7. `reload()` re-fetches `playlistUrl` and applies updated queue via `setTracks`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/frontend/lobby-music.test.js`
Expected: FAIL (`music.setTracks is not a function`).

- [ ] **Step 3: Implement `setTracks` and `reload` in `public/js/lobby-music.js` and wire `public/host.html`**

- In `public/js/lobby-music.js`:
  - Track `pendingSwitch` (URL or `null`) and `clearSrcOnStop` (boolean).
  - In `tick()`: when `progress === 1` and `fade.to === 0`, pause audio, `stopTimer()`, `fade = null`, `base = 0`, `audio.volume = 0`; if `pendingSwitch && active && tracks.length`, switch `audio.src = pendingSwitch`, clear `pendingSwitch`, call `retry()`; else if `clearSrcOnStop`, clear `audio.src = ''` and `clearSrcOnStop = false`.
  - In `setActive(false)`: cancel `pendingSwitch = null` so starting a game never starts a queued switch.
  - Implement `setTracks(nextTracks, { restart = false } = {})` matching Rules 1–5 of the spec exactly, plus `reload()`.
- In `public/host.html`:
  - In `handleMessage`: add `case 'LOBBY_MUSIC_UPDATED': lobbyMusic.setTracks(msg.tracks || [], { restart: Boolean(msg.restart) }); break;`.
  - In `case 'DISPLAY_OK'`: call `lobbyMusic.reload();` so reconnecting TVs pick up playlist changes made while disconnected.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/frontend/lobby-music.test.js tests/frontend/topbar-show.test.js`
Expected: PASS (all existing + new tests green).

- [ ] **Step 5: Commit**

```bash
git add public/js/lobby-music.js public/host.html tests/frontend/lobby-music.test.js
git commit -m "feat: add smooth fade transitions for live lobby music updates"
```

---

### Task 4: `/admin` Lobby Music UI & Documentation

**Files:**
- Modify: `public/admin.html:83-95`
- Modify: `public/js/admin.js:48-224`
- Modify: `AGENTS.md`
- Create: `tests/frontend/admin-lobby-music.test.js`

**Interfaces:**
- Consumes: `/admin/api/lobby-music*` endpoints from Task 2.
- Produces:
  - `#lobbyMusicSection` in `public/admin.html` with controls: `#lobbyMusicList`, `#lobbyMusicStatus`, `#lobbyMusicRestartBtn`, `#lobbyMusicDropzone`, `#lobbyMusicFileInput`, `#lobbyMusicAddFirst`, `#lobbyMusicUploadStatus`.
  - Client controller in `public/js/admin.js`: loads tracks on init, renders ordered list (`#1 First`, `Live Show`, `Uploaded`, `Xing` warning badges), supports HTML5 drag-and-drop + `↑`/`↓` buttons, On/Off toggle, shared `<audio>` preview (`▶`/`■`), 2 MB chunked upload loop (`POST /uploads` → `PUT /uploads/:id` with `Content-Type: application/octet-stream` & `X-Chunk-Offset` → `POST /uploads/:id/finish`, aborting via `DELETE /uploads/:id` on chunk error), uploaded track deletion with `confirm`, and "Play from #1 on live TVs" button.

- [ ] **Step 1: Write failing frontend controller tests in `tests/frontend/admin-lobby-music.test.js`**

Using a lightweight VM/DOM stub (matching `tests/frontend/lobby-music.test.js` style) loading `public/js/admin.js` (and verifying matching element IDs exist in `public/admin.html`):
1. Renders tracks with `#1 First` badge on the first enabled track, `Live Show` badge on `liveShow: true`, `Uploaded` badge + delete button only on `source === 'upload'`, and Xing warning indicator when `xingWarning: true`.
2. Reorder (`↑`/`↓`) and On/Off toggle send `PUT /admin/api/lobby-music` with the exact ordered `{ tracks: [{ id, enabled }] }` payload; when `PUT` rejects, restores previous order/state and shows an error in `#lobbyMusicStatus`.
3. Preview (`▶`/`■`) plays via a single shared `Audio` instance, stops the previous track when previewing another, and stops preview if that track is deleted.
4. Chunked upload splits a 5 MB mock `File` into 2 MB + 2 MB + 1 MB `PUT` calls with `X-Chunk-Offset: 0`, `2097152`, `4194304`, passes `position: 'first'` when `#lobbyMusicAddFirst` is checked, updates progress text, and calls `POST /finish`; aborts session via `DELETE /uploads/:id` if a chunk fails.
5. "Play from #1 on live TVs" calls `POST /admin/api/lobby-music/restart` and displays the notified count.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/frontend/admin-lobby-music.test.js`
Expected: FAIL (missing DOM IDs and functions in `admin.html` / `admin.js`).

- [ ] **Step 3: Implement Lobby Music UI in `public/admin.html`, controller in `public/js/admin.js`, and update `AGENTS.md`**

- Add the Lobby Music `<section>` directly below Lobby Visibility in `public/admin.html` matching the existing Slate/Sky/Emerald dark Tailwind card design (including dropzone, file input accepting `.mp3,.ogg,.m4a,.wav`, "Add at #1 (play first)" checkbox, and "Play from #1 on live TVs" button).
- Implement the Lobby Music controller in `public/js/admin.js` and add `loadLobbyMusic()` to the startup `Promise.all(...)`.
- Add a concise note in `AGENTS.md` under Frontend conventions / Runtime data documenting `data/music/lobby/`, `data/admin/lobby-music.json`, and `/admin` lobby music management.

- [ ] **Step 4: Run focused tests and full verification suite**

Run:
```bash
npx vitest run tests/frontend/admin-lobby-music.test.js
npm run lint && npm test
```
Expected: All lint checks pass (`node --check`) and entire test suite passes.

- [ ] **Step 5: Commit**

```bash
git add public/admin.html public/js/admin.js AGENTS.md tests/frontend/admin-lobby-music.test.js
git commit -m "feat: add Lobby Music management and chunked upload UI to /admin"
```

---

### Task 5: Mobile Game-Over "Back to Lobby" Fronting Frame

**Spec:** `docs/superpowers/specs/2026-11-22-mobile-game-over-overlay-design.md`

**Files:**
- Modify: `public/player.html:175-189,919-950`
- Modify: `public/css/player.css:381-406`
- Create: `tests/frontend/game-over-overlay.test.js`

**Interfaces:**
- Consumes: existing `showGameOverBanner(msg)`, `hideGameOverBanner()`, `returnToLobby()` in `public/player.html`.
- Produces: fixed fronting overlay `#gameOverBanner` (`z-index: 220`, `.game-over-backdrop` + `.game-over-card`, `is-open` state, preserved IDs `#gameOverTitle`, `#gameOverStandings`, `#backToLobbyBtn`).

- [ ] **Step 1: Write failing tests in `tests/frontend/game-over-overlay.test.js`**

Verify against real `public/player.html` and `public/css/player.css`:
1. `#gameOverBanner` sits as a fronting dialog overlay with `role="dialog"`, `aria-modal="true"`, `.game-over-backdrop`, `.game-over-card`, `#gameOverTitle`, `#gameOverStandings`, and `#backToLobbyBtn`.
2. `.game-over-banner` in `public/css/player.css` uses `position: fixed`, `inset: 0`, `z-index: 220` (strictly above game controllers and below `.toast-container` `1000`), and `.game-over-standings` is scrollable (`overflow-y: auto`) inside a `max-height`-capped `.game-over-card` so **Back to Lobby** stays visible on small phones.
3. `showGameOverBanner(msg)` renders sorted standings, unhides `#gameOverBanner`, sets `.is-open`, and focuses `#backToLobbyBtn`; `hideGameOverBanner()` removes `.is-open` and sets `hidden = true`.

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run tests/frontend/game-over-overlay.test.js`
Expected: FAIL (static banner markup/CSS without overlay structure or `is-open`).

- [ ] **Step 3: Update `public/player.html` and `public/css/player.css`**

Wrap `#gameOverBanner` with `.game-over-backdrop` + `.game-over-card` outside `<main>` (alongside `#surrenderModal`), add fixed overlay + pop-in CSS in `public/css/player.css`, and toggle `.is-open` + focus `#backToLobbyBtn` in `showGameOverBanner` / `hideGameOverBanner`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `./node_modules/.bin/vitest run tests/frontend/game-over-overlay.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add public/player.html public/css/player.css tests/frontend/game-over-overlay.test.js
git commit -m "feat(player): show mobile game-over Back to Lobby as a fronting frame"
```
