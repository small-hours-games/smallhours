# Admin Lobby Music Management & Uploads — Design

**Date:** 2026-11-22
**Status:** Draft (pending approval)

## Intent & Why

Today, lobby music on the shared TV display is an alphabetical listing of `music/lobby/` (`GET /api/lobby-music`), so admins cannot choose which tracks play, cannot decide whether the live topbar show track (`Looks-good-to-me-remix.mp3` — singer, AI robots, Board Crash) arrives first in the lobby scene or later, and cannot upload new lobby songs without rebuilding the Docker image.

This change adds a **Lobby Music** section directly to `/admin` so an authenticated admin can:
1. Enable/disable tracks and reorder the lobby playlist — including positioning the **Live Show** track at #1 or later (or turning it off).
2. Upload new audio tracks that persist across restarts and container rebuilds, and delete uploaded tracks when no longer needed.
3. Have every track (built-in, live show, and uploaded) follow the exact same smooth fade-in and fade-out playback logic, including smooth transitions when changes are applied to live TVs.

## Goals, Non-Goals & Anti-Goals

### Goals
- Manage lobby music selection, playback order, and uploads directly inside `/admin` (OIDC-protected).
- Clearly badge live-show tracks (`Looks-good-to-me-remix.mp3`) and the #1 opening track so admins can tell at a glance what arrives first in the lobby scene.
- Persist playlist configuration and uploaded audio under `data/` (mounted into Docker via `./data:/app/data`) without mutating git-tracked `music/lobby/`.
- Keep all playback transitions (track start, end-of-track tail, lobby exit, track removal, and live-TV restart) using `createLobbyMusic`'s fade-in (1.5s) and fade-out (2s tail / 1.2s exit or switch).
- Sync playlist updates to open lobby TVs over WebSocket without requiring a page refresh.
- Keep zero new npm dependencies (use Express 5 built-in middleware and Node 22 standard library).

### Non-Goals
- Managing game music (`music/quiz-card/` / `/api/game-music`).
- Toggling the 3D Lion vs. Frog mascot duel or decoupling the topbar live show from its beat-mapped song.
- Authoring or editing beat maps (`public/shows/*.json`) from `/admin`.
- Per-room playlists (the lobby playlist is server-wide, matching Lobby Visibility).

### Anti-Goals
- Storing uploads inside git-tracked `music/lobby/` (lost on container rebuild and pollutes the repo).
- Abrupt audio cuts when an admin removes the currently playing track or restarts live TVs from #1.
- Allowing arbitrary file uploads, path traversal, or deletion of built-in tracks.
- Breaking existing `/api/lobby-music` response shape (`{ tracks: string[] }`) or `topbar-show.js` filename matching.

## Constraints

- **Docker volume persistence (`docker-compose.yml`):** Only `./data:/app/data` is persisted; `music/` is baked into the image. Uploaded audio must live in `data/music/lobby/` and config in `data/admin/lobby-music.json`.
- **Vanilla frontend stack:** No frontend build step; `/admin` uses plain HTML + Tailwind CDN (`public/admin.html`) and vanilla JS (`public/js/admin.js`); TV uses `public/host.html`, `public/js/lobby-music.js`, and `public/js/topbar-show.js`.
- **Topbar show coupling:** `public/js/topbar-show.js` activates the live show by matching `trackName()` (the decoded basename of `audio.currentSrc` / `audio.src`) against `TBS_SHOWS` (`Looks-good-to-me-remix.mp3`). Serving built-in tracks at `/music/lobby/<encoded>` preserves this without changes to `topbar-show.js`.
- **MP3 duration / tail fade accuracy (`AGENTS.md`):** Browsers can misreport duration on VBR MP3s lacking a Xing header, causing `lobby-music.js`'s 2-second tail fade to fire early.

## Approaches Considered

1. **Section on `/admin` + zero-dependency chunked upload + live TV sync *(Picked)***
   - New `src/music/lobby-store.js` persists order/enabled state in `data/admin/lobby-music.json` and uploads in `data/music/lobby/`.
   - Chunked raw binary uploads (2 MB chunks via Express 5 `express.raw()`) stay safely below Pangolin / CrowdSec AppSec's 10 MB body limit and tunnel timeouts while needing zero new npm dependencies, with magic-byte validation and `ffmpeg -c copy -write_xing 1` normalization for MP3s.
   - New **Lobby Music** card on `/admin` below Lobby Visibility; broadcasts `LOBBY_MUSIC_UPDATED` to connected host TVs via `wsControls`.
   - *Why picked:* Zero new npm dependencies, lives right on `/admin` as requested, works cleanly behind Pangolin, survives container rebuilds, and gives immediate smooth live-TV updates.
2. **Separate `/admin/music` tab + `multer` + refresh-only**
   - Adds a new npm dependency (`multer`) and a separate nav tab; TVs only pick up changes on reload.
   - *Rejected:* Adds dependency bloat and extra navigation while losing live-TV updates and risking Pangolin 10 MB request-body rejections on single-shot uploads.
3. **Mount `./music` in Docker and edit `music/lobby/` directly *(Ruled out)***
   - Mixes user uploads into git-tracked assets, requires changing compose mounts across deployments, and still needs a separate config file for order and enable/disable state.

## Detailed Design

### 1. Storage & Domain Model (`src/music/lobby-store.js`)

- **Paths (overridable via options for isolated testing):**
  - Built-in tracks: `music/lobby/` (read-only).
  - Uploaded tracks: `data/music/lobby/` (created on demand).
  - Playlist config: `data/admin/lobby-music.json` (atomic temp-file + rename write, matching `src/games/visibility.js`).
- **Allowed audio extensions:** `.mp3`, `.ogg`, `.m4a`, `.wav` (case-insensitive).
- **Track IDs & URLs:**
  - Built-in: `id = "builtin:<filename>"`, `url = "/music/lobby/<encodeURIComponent(filename)>"`.
  - Uploaded: `id = "upload:<filename>"`, `url = "/music/lobby/uploads/<encodeURIComponent(filename)>"`.
  - Namespace separation ensures uploads never overwrite built-in files and `DELETE` can never remove built-in files.
- **Live Show detection:**
  - `LIVE_SHOW_TRACKS` maps known beat-mapped built-in filenames (currently `'Looks-good-to-me-remix.mp3'`) to metadata (`{ showUrl: '/shows/looks-good-to-me.json' }`). A unit test verifies `LIVE_SHOW_TRACKS` keys match `TBS_SHOWS` in `public/js/topbar-show.js` so they cannot drift.
- **Config schema (`data/admin/lobby-music.json`):**
  ```json
  {
    "tracks": [
      { "id": "builtin:Looks-good-to-me-remix.mp3", "enabled": true },
      { "id": "builtin:The Final Stretch.mp3", "enabled": true },
      { "id": "upload:warm-intro.mp3", "enabled": true },
      { "id": "builtin:looks-good-to-me-remix.High.wav", "enabled": false }
    ]
  }
  ```
- **Reconciliation on read (`listLobbyTracks` / `getActiveLobbyTrackUrls`):**
  1. Scan `music/lobby/` (ignoring `ENOENT`, non-files, and non-audio files) and `data/music/lobby/` (same filter).
  2. If no config exists yet: built-in tracks sorted alphabetically (preserving existing default behavior and tests), followed by uploaded tracks sorted alphabetically, all `enabled: true`.
  3. If config exists: emit saved entries whose file still exists on disk in saved order; append any newly present disk files not yet in config (built-ins then uploads, alphabetically) with `enabled: true`.
  4. `getActiveLobbyTrackUrls()` returns the ordered `url` array for `enabled: true` tracks only.
- **Metadata returned per track to `/admin`:**
  ```json
  {
    "id": "builtin:Looks-good-to-me-remix.mp3",
    "filename": "Looks-good-to-me-remix.mp3",
    "title": "Looks good to me remix",
    "url": "/music/lobby/Looks-good-to-me-remix.mp3",
    "source": "builtin",
    "enabled": true,
    "liveShow": true,
    "sizeBytes": 6369982,
    "xingWarning": false
  }
  ```
  *(Builder call: `title` strips extension and turns `-`/`_` into spaces for readability while showing the raw `filename` underneath.)*

### 2. Chunked Upload Validation & MP3 Xing Normalization (`src/music/lobby-store.js`)

- **Why chunked (2 MB chunks):** Pangolin (Traefik + CrowdSec AppSec + Newt/Gerbil tunnel) commonly enforces a 10 MB default AppSec body limit and tunnel write timeouts. Uploading in 2 MB chunks keeps every HTTP request small, avoids 403/413/502 proxy rejections, and gives `/admin` an accurate upload progress indicator.
- **Size & session limits:**
  - Max assembled file size: 25 MB (`MAX_UPLOAD_BYTES = 25 * 1024 * 1024`).
  - Chunk size: 2 MB (`UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024`, Express raw cap `4mb` per chunk).
  - Temporary files stored in `data/music/lobby/.uploads/<uploadId>.part` (dotfiles denied by static serving), with a 10-minute inactivity TTL, max 8 concurrent open sessions, and stale `.part` cleanup on startup.
- **Filename sanitization:**
  - Extract `path.basename`, strip control chars and path separators, allow `[A-Za-z0-9._ ()-]`, collapse repeated whitespace/dots, reject dotfiles or names without an allowed audio extension, cap basename length at 120 chars.
  - Lowercase the extension; if a file with that name already exists in `data/music/lobby/`, disambiguate cleanly (`name (2).mp3`, `name (3).mp3`, ...).
- **Magic-byte validation (on assembled file before committing):**
  - `.mp3`: `ID3` header (`49 44 33`) or MPEG frame sync (`buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0`).
  - `.ogg`: `OggS` (`4f 67 67 53`).
  - `.wav`: `RIFF` at 0 and `WAVE` at 8.
  - `.m4a`: `ftyp` at offset 4.
  - Reject with `400` and delete the temp `.part` file if bytes do not match the declared extension or assembled size mismatches the declared size.
- **MP3 Xing header handling *(my call — please confirm)*:**
  - Install `ffmpeg` in both `Dockerfile` and `Dockerfile.dev` (`RUN apk add --no-cache ffmpeg`) so production and dev containers automatically run `ffmpeg -y -i <tmpIn> -c copy -write_xing 1 <tmpOut>` (15s timeout, no shell interpolation via `execFile`) on every uploaded `.mp3` without re-encoding.
  - If `ffmpeg` is unavailable (e.g. a local run without it) or fails, keep the original uploaded bytes rather than failing the upload, and inspect the first frames after any ID3v2 header for `Xing`/`Info` to set `xingWarning: true` (also checked dynamically on `GET /admin/api/lobby-music` for `.mp3` files so any warning badge stays visible on the row).

### 3. HTTP & Admin API Routes

- **Public routes (`src/transport/http.js`):**
  - Mount `app.use('/music/lobby/uploads', express.static(UPLOADS_DIR, { index: false, dotfiles: 'deny' }))` **before** `app.use('/music', express.static(MUSIC_DIR, ...))`.
  - `GET /api/lobby-music` calls `getActiveLobbyTrackUrls()` and returns `{ tracks }` (same contract as today; `GET /api/game-music` stays unchanged).
- **Admin routes (`src/transport/admin-routes.js`, all guarded by `requireAdminSession`):**
  - `GET /admin/api/lobby-music` → `{ tracks, activeCount }`.
  - `PUT /admin/api/lobby-music` (JSON `{ tracks: [{ id, enabled }] }`) → validates entries, persists `data/admin/lobby-music.json`, broadcasts `LOBBY_MUSIC_UPDATED` (`{ tracks: activeUrls, restart: false }`) to all host TVs, returns `{ tracks, activeCount }`.
  - `POST /admin/api/lobby-music/uploads` (JSON `{ filename, size, position?: 'end' | 'first' }`) → validates filename/extension/size (1..25 MB), creates upload session, returns `201 { uploadId, chunkSize }`.
  - `PUT /admin/api/lobby-music/uploads/:uploadId` (`express.raw({ type: () => true, limit: '4mb' })`, header `X-Chunk-Offset`) → validates sequential offset and cumulative size, appends chunk to `.part`, returns `{ receivedBytes }`.
  - `POST /admin/api/lobby-music/uploads/:uploadId/finish` → verifies total bytes, validates magic bytes, normalizes MP3 Xing header when `ffmpeg` is present, moves into `data/music/lobby/`, inserts into `data/admin/lobby-music.json` (`enabled: true` at top or end), broadcasts `LOBBY_MUSIC_UPDATED` (`restart: false`), returns `201 { track, tracks, activeCount, xingNormalized, xingWarning }`.
  - `DELETE /admin/api/lobby-music/uploads/:uploadId` → aborts an in-progress upload and removes its `.part` file.
  - `DELETE /admin/api/lobby-music/:id` → rejects non-`upload:` IDs (`400`), deletes file and config entry (`404` if missing), broadcasts `LOBBY_MUSIC_UPDATED` (`restart: false`), returns `{ ok: true, tracks, activeCount }`.
  - `POST /admin/api/lobby-music/restart` → broadcasts `LOBBY_MUSIC_UPDATED` (`{ tracks: activeUrls, restart: true }`) to all connected host TVs, returns `{ ok: true, notifiedHosts }`.

### 4. WebSocket Push & TV Playback Fades

- **WebSocket (`src/transport/ws-adapter.js`):**
  - Add `broadcastHosts(message)` to `wsControls`: iterates all open host sockets across all rooms and sends `JSON.stringify(message)`, returning the count of notified host displays.
- **TV audio controller (`public/js/lobby-music.js`):**
  - Add `setTracks(nextTracks, { restart = false } = {})` and `reload()` (re-fetches `playlistUrl` and calls `setTracks(data.tracks, { restart: false })`).
  - Fade rules (100% consistent with existing `fadeInMs = 1500`, `fadeOutMs = 1200`, 2s end-of-track tail):
    1. **Queue empty (`tracks.length === 0`):** if playing, fade out over `1200ms` then pause and clear `src`; if paused, clear `src` immediately.
    2. **Not active or paused:** update `tracks`; if `restart` or current track removed, reset `index = 0` and clear `src` so next lobby entry starts cleanly at `tracks[0]` with a `1500ms` fade-in. If active, paused, and tracks just became non-empty (e.g. re-enabling after all were off), load `tracks[0]` and call `retry()` (1.5s fade-in).
    3. **Actively playing & `stillPresent !== -1` & (`!restart || tracks[0] === currentTrack`) *(my call)*:** keep the current track playing undisturbed (`index = stillPresent`). It finishes with its normal 2s tail fade-out and seamlessly advances to the next track in the new order with a 1.5s fade-in. (Clicking "Play from #1 on live TVs" does not cut or restart a TV that is already playing #1.)
    4. **Actively playing & (`stillPresent === -1` OR (`restart` && `tracks[0] !== currentTrack`)):** schedule a smooth transition (`pendingSwitch = tracks[0]`, `index = 0`): fade out current track over `1200ms` to `0`, pause (which also cleanly stops `topbarShow` if the live show was playing), swap `audio.src = tracks[0]`, reset `base = 0`, and call `retry()` so the new track enters with its `1500ms` fade-in (and triggers `topbarShow` if the new track is `Looks-good-to-me-remix.mp3`).
    5. **Interrupted mid-transition:** if `setActive(false)` arrives during a `pendingSwitch` fade-out (e.g. a game starts), cancel `pendingSwitch` and finish fading out to pause. If another `setTracks` arrives mid-fade-out, update `pendingSwitch` target without restarting the fade.
- **TV page wiring (`public/host.html`):**
  - On `LOBBY_MUSIC_UPDATED`: call `lobbyMusic.setTracks(msg.tracks || [], { restart: Boolean(msg.restart) })`.
  - On `DISPLAY_OK` (initial connect or reconnect): call `lobbyMusic.reload()` if already loaded, so a TV that reconnected after an offline gap picks up the latest playlist.

### 5. Admin UI (`public/admin.html` & `public/js/admin.js`)

- Add a **Lobby Music** `<section>` right after **Lobby Visibility** in `public/admin.html`, matching the existing `bg-slate-900 border-slate-800 rounded-2xl` dark layout:
  ```text
  ┌─────────────────────────────────────────────────────────────────────┐
  │ Lobby Music                              [ Play from #1 on live TVs ]│
  │ Tracks play in order with fade-in/out. #1 starts first in the lobby.│
  ├─────────────────────────────────────────────────────────────────────┤
  │ [⋮⋮] #1  Looks good to me remix  [Live Show] [First]   [▶] [↑][↓] [On]│
  │          Looks-good-to-me-remix.mp3 · 6.1 MB · Built-in             │
  │ [⋮⋮] #2  The Final Stretch                             [▶] [↑][↓] [On]│
  │          The Final Stretch.mp3 · 4.1 MB · Built-in                  │
  │ [⋮⋮] #3  Friday Groove           [Uploaded]     [▶] [↑][↓] [On] [✕] │
  │          friday-groove.mp3 · 3.8 MB · Uploaded                      │
  │ [⋮⋮] —   looks good to me remix High                  [▶] [↑][↓] [Off]│
  │          looks-good-to-me-remix.High.wav · 52.8 MB · Built-in       │
  ├─────────────────────────────────────────────────────────────────────┤
  │  Drop audio files here (.mp3, .ogg, .m4a, .wav · max 25 MB) or      │
  │  [Choose files]   [ ] Add at #1 (play first)           Status text  │
  └─────────────────────────────────────────────────────────────────────┘
  ```
- **Interactions:**
  - Drag-and-drop rows OR click `↑` / `↓` buttons to reorder → immediately persists via `PUT /admin/api/lobby-music` (with optimistic UI update and rollback on error).
  - Click **On / Off** toggle → immediately persists via `PUT /admin/api/lobby-music`.
  - Click **`▶` / `■`** → previews the track right inside `/admin` via a single shared `Audio` instance (stops when switching tracks or deleting).
  - Click **`✕` (Delete)** on uploaded tracks → prompts `confirm(...)` and calls `DELETE /admin/api/lobby-music/:id`.
  - Click **Play from #1 on live TVs** → calls `POST /admin/api/lobby-music/restart` and displays how many live TVs were notified (`"Sent #1 to 2 live TVs"` or `"No live TVs connected"`).
  - Drag files onto the dropzone or pick files → uploads sequentially in 2 MB chunks (`POST /uploads` → `PUT /uploads/:id` → `POST /uploads/:id/finish`) with a live progress percentage, optional `position: 'first'`, and refreshes the list (showing a subtle row badge if `xingWarning` is true).

## What's Left to the Builder

- Exact Tailwind utility classes and spacing details in `public/admin.html` / `public/js/admin.js` (staying consistent with the existing Lobby Visibility card).
- Exact error message wording and drag-and-drop highlight styling.
- Test file organization (new `tests/transport/lobby-music-admin.test.js` or expanding `tests/transport/music-routes.test.js` + `tests/frontend/lobby-music.test.js` + `tests/frontend/topbar-show.test.js` sync check).
- Updating `AGENTS.md` if needed to document `data/music/lobby/` and `data/admin/lobby-music.json`.
