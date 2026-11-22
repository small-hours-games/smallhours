import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {
  MAX_UPLOAD_BYTES,
  UPLOAD_CHUNK_BYTES,
  LIVE_SHOW_TRACKS,
  sanitizeAudioFilename,
  validateAudioMagic,
  mp3HasXingHeader,
  createLobbyMusicStore,
} from '../../src/music/lobby-store.js';

function fakeMp3({ withXing = true, size = 128 } = {}) {
  const buf = Buffer.alloc(size, 0);
  // MPEG1 Layer3 frame sync: FF FB 90 00
  buf[0] = 0xff;
  buf[1] = 0xfb;
  buf[2] = 0x90;
  buf[3] = 0x00;
  if (withXing) {
    buf.write('Xing', 36, 'ascii');
  }
  return buf;
}

function fakeId3Mp3({ withInfo = true, pad = 20 } = {}) {
  const header = Buffer.alloc(10, 0);
  header.write('ID3', 0, 'ascii');
  header[3] = 3; // v2.3
  // syncsafe size
  header[6] = (pad >> 21) & 0x7f;
  header[7] = (pad >> 14) & 0x7f;
  header[8] = (pad >> 7) & 0x7f;
  header[9] = pad & 0x7f;
  const tagBody = Buffer.alloc(pad, 0x20);
  const audio = Buffer.alloc(96, 0);
  audio[0] = 0xff;
  audio[1] = 0xfb;
  if (withInfo) audio.write('Info', 36, 'ascii');
  return Buffer.concat([header, tagBody, audio]);
}

function fakeWav(size = 64) {
  const buf = Buffer.alloc(size, 0);
  buf.write('RIFF', 0, 'ascii');
  buf.write('WAVE', 8, 'ascii');
  return buf;
}

function fakeOgg(size = 64) {
  const buf = Buffer.alloc(size, 0);
  buf.write('OggS', 0, 'ascii');
  return buf;
}

function fakeM4a(size = 64) {
  const buf = Buffer.alloc(size, 0);
  buf.writeUInt32BE(24, 0);
  buf.write('ftypM4A ', 4, 'ascii');
  return buf;
}

describe('lobby-store helpers', () => {
  it('keeps LIVE_SHOW_TRACKS keys synced with TBS_SHOWS in public/js/topbar-show.js', () => {
    const src = readFileSync(new URL('../../public/js/topbar-show.js', import.meta.url), 'utf8');
    const ctx = { module: { exports: {} } };
    runInNewContext(src, ctx);
    const tbsKeys = Object.keys(ctx.TBS_SHOWS || {}).sort();
    expect(Object.keys(LIVE_SHOW_TRACKS).sort()).toEqual(tbsKeys);
  });

  it('sanitizes filenames and rejects traversal, dotfiles, and non-audio extensions', () => {
    expect(sanitizeAudioFilename('../../evil.mp3').ok).toBe(false);
    expect(sanitizeAudioFilename('sub/dir/track.mp3').ok).toBe(false);
    expect(sanitizeAudioFilename('sub\\track.mp3').ok).toBe(false);
    expect(sanitizeAudioFilename('.hidden.mp3').ok).toBe(false);
    expect(sanitizeAudioFilename('song.exe').ok).toBe(false);
    expect(sanitizeAudioFilename('   ').ok).toBe(false);

    const good = sanitizeAudioFilename('My Track (Live).MP3');
    expect(good).toEqual({ ok: true, filename: 'My Track (Live).mp3', ext: '.mp3' });
  });

  it('validates audio magic bytes for mp3, ogg, wav, and m4a and rejects spoofed files', () => {
    expect(validateAudioMagic(fakeMp3(), '.mp3')).toBe(true);
    expect(validateAudioMagic(fakeId3Mp3(), '.mp3')).toBe(true);
    expect(validateAudioMagic(fakeOgg(), '.ogg')).toBe(true);
    expect(validateAudioMagic(fakeWav(), '.wav')).toBe(true);
    expect(validateAudioMagic(fakeM4a(), '.m4a')).toBe(true);

    const spoof = Buffer.from('not really audio content at all');
    expect(validateAudioMagic(spoof, '.mp3')).toBe(false);
    expect(validateAudioMagic(spoof, '.ogg')).toBe(false);
    expect(validateAudioMagic(spoof, '.wav')).toBe(false);
    expect(validateAudioMagic(spoof, '.m4a')).toBe(false);
    expect(validateAudioMagic(fakeWav(), '.mp3')).toBe(false);
  });

  it('detects Xing/Info headers inside MP3 buffers with or without ID3 tags', () => {
    expect(mp3HasXingHeader(fakeMp3({ withXing: true }))).toBe(true);
    expect(mp3HasXingHeader(fakeMp3({ withXing: false }))).toBe(false);
    expect(mp3HasXingHeader(fakeId3Mp3({ withInfo: true }))).toBe(true);
    expect(mp3HasXingHeader(fakeId3Mp3({ withInfo: false }))).toBe(false);
  });
});

describe('createLobbyMusicStore', () => {
  let root;
  let builtinDir;
  let uploadsDir;
  let configFile;
  let store;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sh-lobby-music-'));
    builtinDir = path.join(root, 'music', 'lobby');
    uploadsDir = path.join(root, 'data', 'music', 'lobby');
    configFile = path.join(root, 'data', 'admin', 'lobby-music.json');
    await fs.mkdir(builtinDir, { recursive: true });
    await fs.writeFile(path.join(builtinDir, 'LGTM-remix.mp3'), fakeMp3({ withXing: true }));
    await fs.writeFile(path.join(builtinDir, 'Looks-good-to-me-remix.mp3'), fakeMp3({ withXing: true }));
    await fs.writeFile(path.join(builtinDir, 'The Final Stretch.mp3'), fakeMp3({ withXing: true }));
    await fs.writeFile(path.join(builtinDir, 'notes.txt'), 'ignore me');
    await fs.mkdir(path.join(builtinDir, 'subfolder'));

    store = createLobbyMusicStore({
      builtinDir,
      uploadsDir,
      configFile,
      ffmpegRunner: async (inPath, outPath) => {
        const raw = await fs.readFile(inPath);
        const normalized = fakeMp3({ withXing: true, size: Math.max(128, raw.length) });
        await fs.writeFile(outPath, normalized);
      },
    });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('lists built-in tracks alphabetically by default and marks Live Show tracks', async () => {
    const tracks = await store.listTracks();
    expect(tracks.map(t => t.id)).toEqual([
      'builtin:LGTM-remix.mp3',
      'builtin:Looks-good-to-me-remix.mp3',
      'builtin:The Final Stretch.mp3',
    ]);
    expect(tracks.map(t => t.url)).toEqual([
      '/music/lobby/LGTM-remix.mp3',
      '/music/lobby/Looks-good-to-me-remix.mp3',
      '/music/lobby/The%20Final%20Stretch.mp3',
    ]);
    expect(tracks.find(t => t.filename === 'Looks-good-to-me-remix.mp3')?.liveShow).toBe(true);
    expect(tracks.find(t => t.filename === 'LGTM-remix.mp3')?.liveShow).toBe(false);
    expect(await store.getActiveUrls()).toEqual(tracks.map(t => t.url));
  });

  it('persists reordering and enable/disable toggles and reconciles disk changes', async () => {
    await store.saveConfig([
      { id: 'builtin:Looks-good-to-me-remix.mp3', enabled: true },
      { id: 'builtin:The Final Stretch.mp3', enabled: true },
      { id: 'builtin:LGTM-remix.mp3', enabled: false },
      { id: 'builtin:ghost.mp3', enabled: true },
    ]);

    await fs.writeFile(path.join(builtinDir, 'Zebra.ogg'), fakeOgg());

    const tracks = await store.listTracks();
    expect(tracks.map(t => ({ id: t.id, enabled: t.enabled }))).toEqual([
      { id: 'builtin:Looks-good-to-me-remix.mp3', enabled: true },
      { id: 'builtin:The Final Stretch.mp3', enabled: true },
      { id: 'builtin:LGTM-remix.mp3', enabled: false },
      { id: 'builtin:Zebra.ogg', enabled: true },
    ]);
    expect(await store.getActiveUrls()).toEqual([
      '/music/lobby/Looks-good-to-me-remix.mp3',
      '/music/lobby/The%20Final%20Stretch.mp3',
      '/music/lobby/Zebra.ogg',
    ]);
  });

  it('supports chunked uploads, collision disambiguation, and position first vs end', async () => {
    const payload = fakeMp3({ withXing: false, size: 256 });
    const start1 = await store.startUpload({ filename: 'Party Intro.mp3', size: payload.length, position: 'first' });
    expect(start1.ok).toBe(true);
    expect(start1.chunkSize).toBe(UPLOAD_CHUNK_BYTES);

    const c1 = await store.appendUploadChunk(start1.uploadId, 0, payload.subarray(0, 100));
    expect(c1).toEqual({ ok: true, receivedBytes: 100 });
    const c2 = await store.appendUploadChunk(start1.uploadId, 100, payload.subarray(100));
    expect(c2).toEqual({ ok: true, receivedBytes: 256 });

    const done1 = await store.finishUpload(start1.uploadId);
    expect(done1.ok).toBe(true);
    expect(done1.xingNormalized).toBe(true);
    expect(done1.xingWarning).toBe(false);
    expect(done1.track.id).toBe('upload:Party Intro.mp3');
    expect(done1.track.url).toBe('/music/lobby/uploads/Party%20Intro.mp3');
    expect(done1.tracks[0].id).toBe('upload:Party Intro.mp3');

    // Second upload with same filename disambiguates and appends to end
    const wav = fakeWav(128);
    const start2 = await store.startUpload({ filename: 'Party Intro.mp3', size: payload.length, position: 'end' });
    await store.appendUploadChunk(start2.uploadId, 0, payload);
    const done2 = await store.finishUpload(start2.uploadId);
    expect(done2.ok).toBe(true);
    expect(done2.track.filename).toBe('Party Intro (2).mp3');
    expect(done2.tracks[done2.tracks.length - 1].id).toBe('upload:Party Intro (2).mp3');

    // Non-MP3 upload skips ffmpeg and sets xingWarning: false
    const start3 = await store.startUpload({ filename: 'chime.wav', size: wav.length });
    await store.appendUploadChunk(start3.uploadId, 0, wav);
    const done3 = await store.finishUpload(start3.uploadId);
    expect(done3.ok).toBe(true);
    expect(done3.xingWarning).toBe(false);
  });

  it('rejects invalid upload sizes, bad offsets, premature finish, spoofed bytes, and cleans up stale parts', async () => {
    expect((await store.startUpload({ filename: 'empty.mp3', size: 0 })).status).toBe(400);
    expect((await store.startUpload({ filename: 'huge.mp3', size: MAX_UPLOAD_BYTES + 1 })).status).toBe(413);
    expect((await store.startUpload({ filename: '../hack.mp3', size: 100 })).status).toBe(400);

    const s = await store.startUpload({ filename: 'bad.mp3', size: 64 });
    expect((await store.appendUploadChunk(s.uploadId, 10, Buffer.alloc(10))).status).toBe(409);
    expect((await store.appendUploadChunk(s.uploadId, 0, Buffer.alloc(70))).status).toBe(400);
    await store.appendUploadChunk(s.uploadId, 0, Buffer.from('not-audio-'.padEnd(32, 'x')));
    expect((await store.finishUpload(s.uploadId)).status).toBe(400); // incomplete
    await store.appendUploadChunk(s.uploadId, 32, Buffer.from('still-not-audio'.padEnd(32, 'y')));

    const badFinish = await store.finishUpload(s.uploadId);
    expect(badFinish.ok).toBe(false);
    expect(badFinish.status).toBe(400);
    const partsAfterSpoof = await fs.readdir(path.join(uploadsDir, '.uploads')).catch(() => []);
    expect(partsAfterSpoof).toEqual([]);

    // Abort deletes part file
    const s2 = await store.startUpload({ filename: 'aborted.ogg', size: 64 });
    await store.appendUploadChunk(s2.uploadId, 0, fakeOgg(32));
    expect((await store.abortUpload(s2.uploadId)).ok).toBe(true);
    expect(await fs.readdir(path.join(uploadsDir, '.uploads'))).toEqual([]);

    // Startup cleanup removes leftover .part files
    await fs.writeFile(path.join(uploadsDir, '.uploads', 'orphaned.part'), 'leftover');
    const removed = await store.cleanupStaleUploads();
    expect(removed).toBe(1);
    expect(await fs.readdir(path.join(uploadsDir, '.uploads'))).toEqual([]);
  });

  it('keeps original MP3 when ffmpeg is unavailable and sets xingWarning accurately', async () => {
    const noFfmpegStore = createLobbyMusicStore({
      builtinDir,
      uploadsDir,
      configFile,
      ffmpegRunner: async () => {
        const err = new Error('spawn ffmpeg ENOENT');
        err.code = 'ENOENT';
        throw err;
      },
    });

    const noXing = fakeMp3({ withXing: false, size: 160 });
    const s1 = await noFfmpegStore.startUpload({ filename: 'no-xing.mp3', size: noXing.length });
    await noFfmpegStore.appendUploadChunk(s1.uploadId, 0, noXing);
    const r1 = await noFfmpegStore.finishUpload(s1.uploadId);
    expect(r1.ok).toBe(true);
    expect(r1.xingNormalized).toBe(false);
    expect(r1.xingWarning).toBe(true);
    expect(Buffer.compare(await fs.readFile(path.join(uploadsDir, 'no-xing.mp3')), noXing)).toBe(0);

    const withXing = fakeMp3({ withXing: true, size: 160 });
    const s2 = await noFfmpegStore.startUpload({ filename: 'with-xing.mp3', size: withXing.length });
    await noFfmpegStore.appendUploadChunk(s2.uploadId, 0, withXing);
    const r2 = await noFfmpegStore.finishUpload(s2.uploadId);
    expect(r2.ok).toBe(true);
    expect(r2.xingNormalized).toBe(false);
    expect(r2.xingWarning).toBe(false);
  });

  it('deletes only uploaded tracks and refuses deleting built-in tracks', async () => {
    const builtInDel = await store.deleteUpload('builtin:LGTM-remix.mp3');
    expect(builtInDel.ok).toBe(false);
    expect(builtInDel.status).toBe(400);

    const missingDel = await store.deleteUpload('upload:does-not-exist.mp3');
    expect(missingDel.ok).toBe(false);
    expect(missingDel.status).toBe(404);

    const ogg = fakeOgg(80);
    const s = await store.startUpload({ filename: 'temp-song.ogg', size: ogg.length });
    await store.appendUploadChunk(s.uploadId, 0, ogg);
    const uploaded = await store.finishUpload(s.uploadId);
    expect(uploaded.ok).toBe(true);

    const del = await store.deleteUpload('upload:temp-song.ogg');
    expect(del.ok).toBe(true);
    expect(del.tracks.some(t => t.id === 'upload:temp-song.ogg')).toBe(false);
    await expect(fs.access(path.join(uploadsDir, 'temp-song.ogg'))).rejects.toThrow();
  });

  it('serializes concurrent config mutations so rapid reorders and deletes do not clobber each other', async () => {
    const ogg = fakeOgg(80);
    const s = await store.startUpload({ filename: 'race-song.ogg', size: ogg.length });
    await store.appendUploadChunk(s.uploadId, 0, ogg);
    await store.finishUpload(s.uploadId);

    const orderA = [
      { id: 'builtin:LGTM-remix.mp3', enabled: true },
      { id: 'builtin:Looks-good-to-me-remix.mp3', enabled: true },
      { id: 'builtin:The Final Stretch.mp3', enabled: true },
      { id: 'upload:race-song.ogg', enabled: true },
    ];
    const orderB = [
      { id: 'builtin:Looks-good-to-me-remix.mp3', enabled: true },
      { id: 'builtin:The Final Stretch.mp3', enabled: false },
      { id: 'builtin:LGTM-remix.mp3', enabled: true },
      { id: 'upload:race-song.ogg', enabled: true },
    ];

    // Fire overlapping config saves + delete without awaiting between them
    const [resA, resB, resDel] = await Promise.all([
      store.saveConfig(orderA),
      store.saveConfig(orderB),
      store.deleteUpload('upload:race-song.ogg'),
    ]);
    expect(resA.length).toBeGreaterThanOrEqual(3);
    expect(resB.length).toBeGreaterThanOrEqual(3);
    expect(resDel.ok).toBe(true);

    const final = await store.listTracks();
    expect(final.map(t => ({ id: t.id, enabled: t.enabled }))).toEqual([
      { id: 'builtin:Looks-good-to-me-remix.mp3', enabled: true },
      { id: 'builtin:The Final Stretch.mp3', enabled: false },
      { id: 'builtin:LGTM-remix.mp3', enabled: true },
    ]);
  });
});
