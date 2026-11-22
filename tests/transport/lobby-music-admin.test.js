import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';
import { setupRoutes } from '../../src/transport/http.js';
import { setupWebSocket } from '../../src/transport/ws-adapter.js';
import { RoomManager } from '../../src/session/manager.js';
import { createLobbyMusicStore, MAX_UPLOAD_BYTES } from '../../src/music/lobby-store.js';

function fakeMp3(withXing = true, size = 128) {
  const buf = Buffer.alloc(size, 0);
  buf[0] = 0xff;
  buf[1] = 0xfb;
  buf[2] = 0x90;
  if (withXing) buf.write('Xing', 36, 'ascii');
  return buf;
}

describe('Admin lobby music routes & live host WS sync', () => {
  const savedEnv = { ...process.env };
  let root;
  let builtinDir;
  let uploadsDir;
  let configFile;
  let store;
  let manager;
  let server;
  let wss;
  let baseUrl;
  let wsBaseUrl;
  const authHeaders = { 'x-admin-dev-token': 'music-dev-token' };

  beforeEach(async () => {
    process.env.ADMIN_DEV_TOKEN = 'music-dev-token';
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_CLIENT_ID;

    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sh-music-admin-'));
    builtinDir = path.join(root, 'music', 'lobby');
    uploadsDir = path.join(root, 'data', 'music', 'lobby');
    configFile = path.join(root, 'data', 'admin', 'lobby-music.json');
    await fs.mkdir(builtinDir, { recursive: true });
    await fs.writeFile(path.join(builtinDir, 'LGTM-remix.mp3'), fakeMp3(true));
    await fs.writeFile(path.join(builtinDir, 'Looks-good-to-me-remix.mp3'), fakeMp3(true));
    await fs.writeFile(path.join(builtinDir, 'The Final Stretch.mp3'), fakeMp3(true));

    store = createLobbyMusicStore({
      builtinDir,
      uploadsDir,
      configFile,
      ffmpegRunner: async (inPath, outPath) => {
        const raw = await fs.readFile(inPath);
        await fs.writeFile(outPath, fakeMp3(true, Math.max(128, raw.length)));
      },
    });

    manager = new RoomManager();
    const app = express();
    app.use(express.json());
    setupRoutes(app, manager, { lobbyMusicStore: store });
    server = http.createServer(app);
    ({ wss } = setupWebSocket(server, manager));

    await new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        baseUrl = `http://127.0.0.1:${port}`;
        wsBaseUrl = `ws://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    process.env = { ...savedEnv };
    for (const client of wss.clients) client.terminate();
    wss.close();
    manager.destroy();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  function connectWs(wsPath) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsBaseUrl}${wsPath}`);
      const messages = [];
      const waiters = [];
      ws.on('message', raw => {
        const msg = JSON.parse(raw.toString());
        const idx = waiters.findIndex(w => !w.type || w.type === msg.type);
        if (idx !== -1) {
          const [w] = waiters.splice(idx, 1);
          w.resolve(msg);
        } else {
          messages.push(msg);
        }
      });
      ws.messages = messages;
      ws.waitFor = (type, timeoutMs = 2000) => {
        const idx = messages.findIndex(m => m.type === type);
        if (idx !== -1) return Promise.resolve(messages.splice(idx, 1)[0]);
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error(`Timed out waiting for ${type}`)), timeoutMs);
          waiters.push({ type, resolve: m => { clearTimeout(t); res(m); } });
        });
      };
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
  }

  it('requires admin auth on all /admin/api/lobby-music routes', async () => {
    expect((await fetch(`${baseUrl}/admin/api/lobby-music`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/admin/api/lobby-music`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await fetch(`${baseUrl}/admin/api/lobby-music/uploads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await fetch(`${baseUrl}/admin/api/lobby-music/restart`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${baseUrl}/admin/api/lobby-music/upload:a.mp3`, { method: 'DELETE' })).status).toBe(401);
  });

  it('lists tracks with liveShow badge, saves order/toggles, updates /api/lobby-music, and broadcasts to hosts only', async () => {
    const room = manager.createRoom();
    const hostWs = await connectWs(`/ws/host/${room.code}`);
    await hostWs.waitFor('DISPLAY_OK');
    const playerWs = await connectWs(`/ws/player/${room.code}`);

    const getRes = await fetch(`${baseUrl}/admin/api/lobby-music`, { headers: authHeaders });
    expect(getRes.status).toBe(200);
    const listData = await getRes.json();
    expect(listData.activeCount).toBe(3);
    expect(listData.tracks.find(t => t.filename === 'Looks-good-to-me-remix.mp3')?.liveShow).toBe(true);

    const putRes = await fetch(`${baseUrl}/admin/api/lobby-music`, {
      method: 'PUT',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tracks: [
          { id: 'builtin:Looks-good-to-me-remix.mp3', enabled: true },
          { id: 'builtin:The Final Stretch.mp3', enabled: true },
          { id: 'builtin:LGTM-remix.mp3', enabled: false },
        ],
      }),
    });
    expect(putRes.status).toBe(200);
    const putData = await putRes.json();
    expect(putData.activeCount).toBe(2);

    const expectedActive = [
      '/music/lobby/Looks-good-to-me-remix.mp3',
      '/music/lobby/The%20Final%20Stretch.mp3',
    ];
    const pub = await (await fetch(`${baseUrl}/api/lobby-music`)).json();
    expect(pub.tracks).toEqual(expectedActive);

    const hostMsg = await hostWs.waitFor('LOBBY_MUSIC_UPDATED');
    expect(hostMsg).toEqual({
      type: 'LOBBY_MUSIC_UPDATED',
      tracks: expectedActive,
      restart: false,
    });
    // Player sockets must not receive LOBBY_MUSIC_UPDATED
    await new Promise(r => setTimeout(r, 50));
    expect(playerWs.messages.some(m => m.type === 'LOBBY_MUSIC_UPDATED')).toBe(false);

    // Restart broadcasts restart: true and returns notified host count
    const restartRes = await fetch(`${baseUrl}/admin/api/lobby-music/restart`, {
      method: 'POST',
      headers: authHeaders,
    });
    expect(restartRes.status).toBe(200);
    expect(await restartRes.json()).toEqual({ ok: true, notifiedHosts: 1 });
    const restartMsg = await hostWs.waitFor('LOBBY_MUSIC_UPDATED');
    expect(restartMsg).toEqual({
      type: 'LOBBY_MUSIC_UPDATED',
      tracks: expectedActive,
      restart: true,
    });

    hostWs.close();
    playerWs.close();
  });

  it('handles full chunked upload, serves uploaded file, denies .uploads dotfiles, rejects invalid uploads, and deletes uploads safely', async () => {
    const room = manager.createRoom();
    const hostWs = await connectWs(`/ws/host/${room.code}`);
    await hostWs.waitFor('DISPLAY_OK');

    // Oversized declaration rejected
    const tooBig = await fetch(`${baseUrl}/admin/api/lobby-music/uploads`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'huge.mp3', size: MAX_UPLOAD_BYTES + 1 }),
    });
    expect(tooBig.status).toBe(413);

    // Chunked happy path
    const audio = fakeMp3(false, 256);
    const initRes = await fetch(`${baseUrl}/admin/api/lobby-music/uploads`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'Night Opener.mp3', size: audio.length, position: 'first' }),
    });
    expect(initRes.status).toBe(201);
    const { uploadId } = await initRes.json();

    // Dotfile in staging dir is denied over HTTP
    const dotRes = await fetch(`${baseUrl}/music/lobby/uploads/.uploads/${uploadId}.part`);
    expect([403, 404]).toContain(dotRes.status);

    // Wrong offset returns 409
    const badOffset = await fetch(`${baseUrl}/admin/api/lobby-music/uploads/${uploadId}`, {
      method: 'PUT',
      headers: { ...authHeaders, 'Content-Type': 'application/octet-stream', 'X-Chunk-Offset': '50' },
      body: audio.subarray(0, 50),
    });
    expect(badOffset.status).toBe(409);

    // Two valid chunks
    const c1 = await fetch(`${baseUrl}/admin/api/lobby-music/uploads/${uploadId}`, {
      method: 'PUT',
      headers: { ...authHeaders, 'Content-Type': 'application/octet-stream', 'X-Chunk-Offset': '0' },
      body: audio.subarray(0, 120),
    });
    expect(c1.status).toBe(200);
    expect(await c1.json()).toEqual({ receivedBytes: 120 });

    const c2 = await fetch(`${baseUrl}/admin/api/lobby-music/uploads/${uploadId}`, {
      method: 'PUT',
      headers: { ...authHeaders, 'Content-Type': 'application/octet-stream', 'X-Chunk-Offset': '120' },
      body: audio.subarray(120),
    });
    expect(c2.status).toBe(200);
    expect(await c2.json()).toEqual({ receivedBytes: 256 });

    const finRes = await fetch(`${baseUrl}/admin/api/lobby-music/uploads/${uploadId}/finish`, {
      method: 'POST',
      headers: authHeaders,
    });
    expect(finRes.status).toBe(201);
    const fin = await finRes.json();
    expect(fin.track.id).toBe('upload:Night Opener.mp3');
    expect(fin.xingNormalized).toBe(true);
    expect(fin.tracks[0].id).toBe('upload:Night Opener.mp3');

    // Uploaded file is served publicly
    const dl = await fetch(`${baseUrl}/music/lobby/uploads/Night%20Opener.mp3`);
    expect(dl.status).toBe(200);
    const downloaded = Buffer.from(await dl.arrayBuffer());
    expect(downloaded.length).toBeGreaterThanOrEqual(128);

    const wsAfterUpload = await hostWs.waitFor('LOBBY_MUSIC_UPDATED');
    expect(wsAfterUpload.tracks[0]).toBe('/music/lobby/uploads/Night%20Opener.mp3');

    // Spoofed upload rejected at finish
    const spoofBuf = Buffer.from('plain text masquerading as mp3 file');
    const spoofInit = await (await fetch(`${baseUrl}/admin/api/lobby-music/uploads`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'fake.mp3', size: spoofBuf.length }),
    })).json();
    await fetch(`${baseUrl}/admin/api/lobby-music/uploads/${spoofInit.uploadId}`, {
      method: 'PUT',
      headers: { ...authHeaders, 'Content-Type': 'application/octet-stream', 'X-Chunk-Offset': '0' },
      body: spoofBuf,
    });
    const spoofFin = await fetch(`${baseUrl}/admin/api/lobby-music/uploads/${spoofInit.uploadId}/finish`, {
      method: 'POST',
      headers: authHeaders,
    });
    expect(spoofFin.status).toBe(400);

    // Refuses deleting built-in track
    const delBuiltin = await fetch(`${baseUrl}/admin/api/lobby-music/${encodeURIComponent('builtin:LGTM-remix.mp3')}`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    expect(delBuiltin.status).toBe(400);

    // Deletes uploaded track and broadcasts update
    const delUpload = await fetch(`${baseUrl}/admin/api/lobby-music/${encodeURIComponent('upload:Night Opener.mp3')}`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    expect(delUpload.status).toBe(200);
    const delData = await delUpload.json();
    expect(delData.ok).toBe(true);
    expect(delData.tracks.some(t => t.id === 'upload:Night Opener.mp3')).toBe(false);

    const wsAfterDel = await hostWs.waitFor('LOBBY_MUSIC_UPDATED');
    expect(wsAfterDel.tracks).not.toContain('/music/lobby/uploads/Night%20Opener.mp3');

    hostWs.close();
  });
});
