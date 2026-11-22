---
title: Admin audio uploads use 2 MB chunks stored in data/ to clear Pangolin proxy limits and survive container rebuilds
author: Niklas
date: 2026-11-22
branch: dev
id: l-d849d71a
scope: repo
status: active
src: agent
touches:
  - AGENTS.md
  - Dockerfile
  - Dockerfile.dev
  - package-lock.json
  - package.json
  - public/admin.html
  - public/css/player.css
  - public/css/topbar-show.css
  - public/host.html
  - public/js/admin.js
---

## Decided
- Upload lobby audio in 2 MB binary chunks (`POST /admin/api/lobby-music/uploads` -> `PUT` with `X-Chunk-Offset` -> `POST /finish`) instead of a single 25 MB `POST`, because `smallhours.se` sits behind a Pangolin proxy (Traefik + CrowdSec AppSec + Newt/Gerbil tunnel) whose AppSec default rejects single request bodies over 10 MB with 403/502.
- Persist uploaded audio in `data/music/lobby/` and playlist order/toggles in `data/admin/lobby-music.json`, leaving `music/lobby/` read-only, because `docker-compose.yml` only mounts `./data:/app/data`.

## Tried and ruled out
- Single-request 25 MB `express.raw` upload: fails behind Pangolin CrowdSec AppSec's 10 MB body cap and tunnel timeouts without modifying external proxy configuration.
- Writing uploads into git-tracked `music/lobby/`: lost on container rebuilds and pollutes the repository.

## Watch out
- Uploaded MP3s without a Xing header cause browsers to misreport duration and fade out early; both `Dockerfile` and `Dockerfile.dev` install `ffmpeg` so `lobby-store.js` runs `-c copy -write_xing 1` automatically on upload.
- In the code: `src/music/lobby-store.js`, `src/transport/admin-routes.js`, `src/transport/http.js`, `public/js/admin.js`, `Dockerfile`, `Dockerfile.dev`, `docker-compose.yml`.
