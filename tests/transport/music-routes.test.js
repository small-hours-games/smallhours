import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import http from 'node:http';
import { setupRoutes } from '../../src/transport/http.js';
import { createLobbyMusicStore } from '../../src/music/lobby-store.js';

const file = name => ({ name, isFile: () => true });

describe('music playlists', () => {
  let server, base, tmpDir, store;
  beforeAll(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sh-music-routes-'));
    store = createLobbyMusicStore({
      builtinDir: path.join(tmpDir, 'music', 'lobby'),
      uploadsDir: path.join(tmpDir, 'uploads'),
      configFile: path.join(tmpDir, 'config.json'),
    });
    const app = express();
    setupRoutes(app, { rooms: new Map(), stats: () => ({ roomCount: 0, playerCount: 0 }), getRoom: () => null, createRoom: () => ({ code: 'TEST' }) }, { lobbyMusicStore: store });
    server = http.createServer(app).listen(0);
    await new Promise(r => server.on('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) server.close();
    if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true });
  });
  afterEach(() => vi.restoreAllMocks());

  const tracks = async urlPath => (await (await fetch(base + urlPath)).json()).tracks;
  const withFiles = () => vi.spyOn(fs.promises, 'readdir').mockImplementation(async dir => {
    const p = String(dir);
    if (p.endsWith('uploads')) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    if (p.endsWith('lobby')) return [file('The Final Stretch.mp3'), file('notes.txt'), { name: 'old.mp3', isFile: () => false }];
    return [file('quiz-and-cards.mp3'), file('quiz-and-cards-two.mp3')];
  });

  it('plays the lobby folder in the lobby', async () => {
    withFiles();
    expect(await tracks('/api/lobby-music')).toEqual(['/music/lobby/The%20Final%20Stretch.mp3']);
  });

  it('plays the quiz-card folder in games', async () => {
    withFiles();
    expect(await tracks('/api/game-music')).toEqual(['/music/quiz-card/quiz-and-cards-two.mp3', '/music/quiz-card/quiz-and-cards.mp3']);
  });

  it('returns an empty list when the music folder is missing', async () => {
    vi.spyOn(fs.promises, 'readdir').mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));
    expect(await tracks('/api/game-music')).toEqual([]);
    expect(await tracks('/api/lobby-music')).toEqual([]);
  });
});
