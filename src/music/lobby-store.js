// Small Hours - Lobby Music Store & Chunked Upload Service
// Reconciles read-only built-in music/lobby/ tracks with persisted uploads in
// data/music/lobby/ and ordered enable/disable config in data/admin/lobby-music.json.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_BUILTIN_DIR = path.resolve(__dirname, '../../music/lobby');
export const DEFAULT_UPLOADS_DIR = path.resolve(__dirname, '../../data/music/lobby');
export const DEFAULT_CONFIG_FILE = path.resolve(__dirname, '../../data/admin/lobby-music.json');

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024;

const ALLOWED_EXTS = new Set(['.mp3', '.ogg', '.m4a', '.wav']);
const AUDIO_EXT_RE = /\.(mp3|ogg|m4a|wav)$/i;
const MAX_FILENAME_LEN = 120;
const XING_SCAN_BYTES = 8192;

// Kept in sync with TBS_SHOWS in public/js/topbar-show.js (verified by unit test).
export const LIVE_SHOW_TRACKS = Object.freeze({
  'Looks-good-to-me-remix.mp3': { showUrl: '/shows/looks-good-to-me.json' },
});

function isInsideDir(parentDir, targetPath) {
  const rel = path.relative(path.resolve(parentDir), path.resolve(targetPath));
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function titleFromFilename(filename) {
  const stem = filename.replace(AUDIO_EXT_RE, '');
  return stem.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim() || filename;
}

export function sanitizeAudioFilename(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'Filename is required' };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'Filename is required' };
  if (/[/\\\0]/.test(trimmed) || trimmed.includes('..')) {
    return { ok: false, error: 'Invalid filename' };
  }
  if (trimmed.startsWith('.')) {
    return { ok: false, error: 'Hidden filenames are not allowed' };
  }

  const extMatch = trimmed.match(AUDIO_EXT_RE);
  if (!extMatch) {
    return { ok: false, error: 'Unsupported file type. Allowed: .mp3, .ogg, .m4a, .wav' };
  }
  const ext = extMatch[0].toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) {
    return { ok: false, error: 'Unsupported file type' };
  }

  const rawStem = trimmed.slice(0, trimmed.length - extMatch[0].length);
  const cleanStem = rawStem
    .replace(/[^A-Za-z0-9._ ()-]/g, ' ')
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .trim();

  if (!cleanStem) {
    return { ok: false, error: 'Invalid filename' };
  }

  const maxStemLen = Math.max(1, MAX_FILENAME_LEN - ext.length);
  const finalStem = cleanStem.slice(0, maxStemLen).trim();
  if (!finalStem) {
    return { ok: false, error: 'Invalid filename' };
  }

  return { ok: true, filename: `${finalStem}${ext}`, ext };
}

export function validateAudioMagic(buf, ext) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  const lowerExt = String(ext || '').toLowerCase();
  if (lowerExt === '.mp3') {
    const isId3 = buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33;
    const isMpegSync = buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
    return isId3 || isMpegSync;
  }
  if (lowerExt === '.ogg') {
    return buf.subarray(0, 4).toString('ascii') === 'OggS';
  }
  if (lowerExt === '.wav') {
    return (
      buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WAVE'
    );
  }
  if (lowerExt === '.m4a') {
    return buf.subarray(4, 8).toString('ascii') === 'ftyp';
  }
  return false;
}

function id3v2BodyOffset(headerBuf) {
  if (!Buffer.isBuffer(headerBuf) || headerBuf.length < 10) return 0;
  if (headerBuf[0] !== 0x49 || headerBuf[1] !== 0x44 || headerBuf[2] !== 0x33) return 0;
  const flags = headerBuf[5];
  const tagSize =
    ((headerBuf[6] & 0x7f) << 21) |
    ((headerBuf[7] & 0x7f) << 14) |
    ((headerBuf[8] & 0x7f) << 7) |
    (headerBuf[9] & 0x7f);
  const footer = (flags & 0x10) ? 10 : 0;
  return 10 + tagSize + footer;
}

export function mp3HasXingHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return false;
  const start = id3v2BodyOffset(buf);
  if (start >= buf.length) return false;
  const slice = buf.subarray(start, Math.min(buf.length, start + XING_SCAN_BYTES));
  return slice.includes(Buffer.from('Xing', 'ascii')) || slice.includes(Buffer.from('Info', 'ascii'));
}

async function fileHasXingHeader(filePath) {
  let fh;
  try {
    fh = await fsp.open(filePath, 'r');
    const hdr = Buffer.alloc(10);
    const { bytesRead } = await fh.read(hdr, 0, 10, 0);
    if (bytesRead < 4) return false;
    const offset = id3v2BodyOffset(hdr);
    const probe = Buffer.alloc(XING_SCAN_BYTES);
    const res = await fh.read(probe, 0, XING_SCAN_BYTES, offset);
    const slice = probe.subarray(0, res.bytesRead);
    return slice.includes(Buffer.from('Xing', 'ascii')) || slice.includes(Buffer.from('Info', 'ascii'));
  } catch {
    return true; // Do not emit false warnings if file cannot be probed (e.g. mocked readdir)
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

async function defaultFfmpegRunner(inPath, outPath) {
  await execFileAsync(
    'ffmpeg',
    ['-y', '-i', inPath, '-c', 'copy', '-write_xing', '1', outPath],
    { timeout: 15000 }
  );
}

async function atomicWriteJson(filePath, data) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await fsp.rename(tmp, filePath);
}

async function readConfig(configFile) {
  try {
    const raw = await fsp.readFile(configFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.tracks)) {
      return parsed.tracks
        .filter(item => item && typeof item.id === 'string' && item.id.trim())
        .map(item => ({ id: item.id.trim(), enabled: Boolean(item.enabled) }));
    }
    return null;
  } catch {
    return null;
  }
}

async function scanAudioDir(dir, source) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const audioFiles = entries
    .filter(entry => entry.isFile() && AUDIO_EXT_RE.test(entry.name) && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const tracks = [];
  for (const filename of audioFiles) {
    const fullPath = path.join(dir, filename);
    let sizeBytes = 0;
    let xingWarning = false;
    try {
      const stat = await fsp.stat(fullPath);
      sizeBytes = stat.size;
      if (filename.toLowerCase().endsWith('.mp3')) {
        xingWarning = !(await fileHasXingHeader(fullPath));
      }
    } catch {
      sizeBytes = 0;
      xingWarning = false;
    }

    const urlPrefix = source === 'builtin' ? '/music/lobby/' : '/music/lobby/uploads/';
    tracks.push({
      id: `${source}:${filename}`,
      filename,
      title: titleFromFilename(filename),
      url: `${urlPrefix}${encodeURIComponent(filename)}`,
      source,
      enabled: true,
      liveShow: source === 'builtin' && Object.prototype.hasOwnProperty.call(LIVE_SHOW_TRACKS, filename),
      sizeBytes,
      xingWarning,
    });
  }
  return tracks;
}

async function uniqueFilename(dir, filename) {
  const extMatch = filename.match(AUDIO_EXT_RE);
  const ext = extMatch ? extMatch[0].toLowerCase() : '';
  const stem = filename.slice(0, filename.length - ext.length);

  let candidate = `${stem}${ext}`;
  let suffix = 2;
  while (true) {
    const target = path.join(dir, candidate);
    try {
      await fsp.access(target, fs.constants.F_OK);
      candidate = `${stem} (${suffix})${ext}`;
      suffix += 1;
    } catch {
      return candidate;
    }
  }
}

export function createLobbyMusicStore({
  builtinDir = DEFAULT_BUILTIN_DIR,
  uploadsDir = DEFAULT_UPLOADS_DIR,
  configFile = DEFAULT_CONFIG_FILE,
  ffmpegRunner = defaultFfmpegRunner,
  uploadTtlMs = 10 * 60 * 1000,
  maxSessions = 8,
} = {}) {
  const resolvedBuiltinDir = path.resolve(builtinDir);
  const resolvedUploadsDir = path.resolve(uploadsDir);
  const resolvedConfigFile = path.resolve(configFile);
  const stagingDir = path.join(resolvedUploadsDir, '.uploads');

  const sessions = new Map();
  let configQueue = Promise.resolve();

  function withConfigLock(fn) {
    const run = configQueue.then(fn, fn);
    configQueue = run.catch(() => {});
    return run;
  }

  async function removeSession(uploadId) {
    const session = sessions.get(uploadId);
    if (!session) return false;
    sessions.delete(uploadId);
    await fsp.unlink(session.partPath).catch(() => {});
    return true;
  }

  async function pruneExpiredSessions() {
    const now = Date.now();
    for (const [id, session] of [...sessions.entries()]) {
      if (now - session.updatedAt > uploadTtlMs) {
        await removeSession(id);
      }
    }
  }

  async function listTracks() {
    const [builtins, uploads, saved] = await Promise.all([
      scanAudioDir(resolvedBuiltinDir, 'builtin'),
      scanAudioDir(resolvedUploadsDir, 'upload'),
      readConfig(resolvedConfigFile),
    ]);

    const byId = new Map();
    for (const track of builtins) byId.set(track.id, track);
    for (const track of uploads) byId.set(track.id, track);

    if (!saved) {
      return [...builtins, ...uploads];
    }

    const ordered = [];
    const seen = new Set();
    for (const item of saved) {
      if (seen.has(item.id)) continue;
      const track = byId.get(item.id);
      if (!track) continue;
      seen.add(item.id);
      ordered.push({ ...track, enabled: Boolean(item.enabled) });
    }
    for (const track of [...builtins, ...uploads]) {
      if (seen.has(track.id)) continue;
      seen.add(track.id);
      ordered.push({ ...track, enabled: true });
    }
    return ordered;
  }

  async function getActiveUrls() {
    const tracks = await listTracks();
    return tracks.filter(t => t.enabled).map(t => t.url);
  }

  async function saveConfigUnlocked(entries) {
    if (!Array.isArray(entries)) {
      throw new Error('tracks array is required');
    }
    const existing = await listTracks();
    const byId = new Map(existing.map(t => [t.id, t]));

    const next = [];
    const seen = new Set();
    for (const entry of entries) {
      if (!entry || typeof entry.id !== 'string') continue;
      const id = entry.id.trim();
      if (!byId.has(id) || seen.has(id)) continue;
      seen.add(id);
      next.push({ id, enabled: Boolean(entry.enabled) });
    }
    for (const track of existing) {
      if (!seen.has(track.id)) {
        seen.add(track.id);
        next.push({ id: track.id, enabled: track.enabled });
      }
    }

    await atomicWriteJson(resolvedConfigFile, { tracks: next });
    return listTracks();
  }

  function saveConfig(entries) {
    return withConfigLock(() => saveConfigUnlocked(entries));
  }

  async function startUpload({ filename, size, position = 'end' } = {}) {
    await pruneExpiredSessions();

    const clean = sanitizeAudioFilename(filename);
    if (!clean.ok) return { ok: false, status: 400, error: clean.error };

    const declaredSize = Number(size);
    if (!Number.isInteger(declaredSize) || declaredSize <= 0) {
      return { ok: false, status: 400, error: 'File size must be a positive integer' };
    }
    if (declaredSize > MAX_UPLOAD_BYTES) {
      return {
        ok: false,
        status: 413,
        error: `File exceeds maximum upload size of ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB`,
      };
    }
    if (sessions.size >= maxSessions) {
      return { ok: false, status: 429, error: 'Too many active uploads, try again shortly' };
    }

    const pos = position === 'first' ? 'first' : 'end';
    const uploadId = randomUUID();
    await fsp.mkdir(stagingDir, { recursive: true });
    const partPath = path.join(stagingDir, `${uploadId}.part`);
    const xingPath = path.join(stagingDir, `${uploadId}.xing.mp3`);
    await fsp.writeFile(partPath, Buffer.alloc(0));

    sessions.set(uploadId, {
      uploadId,
      filename: clean.filename,
      ext: clean.ext,
      declaredSize,
      receivedBytes: 0,
      position: pos,
      partPath,
      xingPath,
      updatedAt: Date.now(),
    });

    return { ok: true, uploadId, chunkSize: UPLOAD_CHUNK_BYTES };
  }

  async function appendUploadChunk(uploadId, offset, buffer) {
    await pruneExpiredSessions();
    const session = sessions.get(uploadId);
    if (!session) return { ok: false, status: 404, error: 'Upload session not found or expired' };

    const chunkOffset = Number(offset);
    if (!Number.isInteger(chunkOffset) || chunkOffset !== session.receivedBytes) {
      return {
        ok: false,
        status: 409,
        error: `Expected chunk offset ${session.receivedBytes}, got ${offset}`,
      };
    }

    if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
      return { ok: false, status: 400, error: 'Binary audio chunk required' };
    }
    const chunk = Buffer.isBuffer(buffer)
      ? buffer
      : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    if (chunk.byteLength === 0) {
      return { ok: false, status: 400, error: 'Empty chunk' };
    }
    if (session.receivedBytes + chunk.byteLength > session.declaredSize) {
      return { ok: false, status: 400, error: 'Chunk exceeds declared file size' };
    }

    await fsp.appendFile(session.partPath, chunk);
    session.receivedBytes += chunk.byteLength;
    session.updatedAt = Date.now();
    return { ok: true, receivedBytes: session.receivedBytes };
  }

  async function finishUpload(uploadId) {
    await pruneExpiredSessions();
    const session = sessions.get(uploadId);
    if (!session) return { ok: false, status: 404, error: 'Upload session not found or expired' };

    if (session.receivedBytes !== session.declaredSize) {
      return {
        ok: false,
        status: 400,
        error: `Upload incomplete: received ${session.receivedBytes} of ${session.declaredSize} bytes`,
      };
    }

    // Consume the session before finalization so errors always clean up the .part file.
    sessions.delete(uploadId);
    const partPath = session.partPath;
    let xingTmpPath = null;

    try {
      let fh = await fsp.open(partPath, 'r');
      const head = Buffer.alloc(Math.min(64, session.declaredSize));
      try {
        await fh.read(head, 0, head.length, 0);
      } finally {
        await fh.close();
      }

      if (!validateAudioMagic(head, session.ext)) {
        await fsp.unlink(partPath).catch(() => {});
        return {
          ok: false,
          status: 400,
          error: `File contents do not match ${session.ext} audio format`,
        };
      }

      let commitSource = partPath;
      let xingNormalized = false;
      let xingWarning = false;

      if (session.ext === '.mp3') {
        xingTmpPath = session.xingPath;
        try {
          await ffmpegRunner(partPath, xingTmpPath);
          const stat = await fsp.stat(xingTmpPath);
          if (stat.size > 0) {
            commitSource = xingTmpPath;
            xingNormalized = true;
          } else {
            await fsp.unlink(xingTmpPath).catch(() => {});
            xingTmpPath = null;
          }
        } catch {
          await fsp.unlink(xingTmpPath).catch(() => {});
          xingTmpPath = null;
        }
        xingWarning = !(await fileHasXingHeader(commitSource));
      }

      return await withConfigLock(async () => {
        await fsp.mkdir(resolvedUploadsDir, { recursive: true });
        const finalFilename = await uniqueFilename(resolvedUploadsDir, session.filename);
        const finalPath = path.join(resolvedUploadsDir, finalFilename);
        if (!isInsideDir(resolvedUploadsDir, finalPath)) {
          throw new Error('Target path escapes uploads directory');
        }

        await fsp.rename(commitSource, finalPath);
        if (commitSource !== partPath) {
          await fsp.unlink(partPath).catch(() => {});
        }

        const newId = `upload:${finalFilename}`;
        const current = await listTracks();
        const withoutNew = current.filter(t => t.id !== newId).map(t => ({ id: t.id, enabled: t.enabled }));
        const nextEntries =
          session.position === 'first'
            ? [{ id: newId, enabled: true }, ...withoutNew]
            : [...withoutNew, { id: newId, enabled: true }];

        const tracks = await saveConfigUnlocked(nextEntries);
        const track = tracks.find(t => t.id === newId);
        return {
          ok: true,
          track,
          tracks,
          xingNormalized,
          xingWarning,
        };
      });
    } catch (err) {
      await fsp.unlink(partPath).catch(() => {});
      if (xingTmpPath) await fsp.unlink(xingTmpPath).catch(() => {});
      return { ok: false, status: 500, error: err.message || 'Could not finalize upload' };
    }
  }

  async function abortUpload(uploadId) {
    const removed = await removeSession(uploadId);
    return { ok: removed };
  }

  async function deleteUpload(id) {
    const cleanId = String(id || '').trim();
    if (!cleanId.startsWith('upload:')) {
      return { ok: false, status: 400, error: 'Built-in tracks cannot be deleted' };
    }
    const filename = cleanId.slice('upload:'.length);
    if (!filename || /[/\\\0]/.test(filename) || filename.includes('..') || filename.startsWith('.')) {
      return { ok: false, status: 400, error: 'Invalid track id' };
    }
    const targetPath = path.join(resolvedUploadsDir, filename);
    if (!isInsideDir(resolvedUploadsDir, targetPath)) {
      return { ok: false, status: 400, error: 'Invalid track path' };
    }

    return withConfigLock(async () => {
      try {
        await fsp.unlink(targetPath);
      } catch (err) {
        if (err.code === 'ENOENT') {
          return { ok: false, status: 404, error: 'Uploaded track not found' };
        }
        throw err;
      }

      const existing = await listTracks();
      const tracks = await saveConfigUnlocked(
        existing.filter(t => t.id !== cleanId).map(t => ({ id: t.id, enabled: t.enabled }))
      );
      return { ok: true, tracks };
    });
  }

  async function cleanupStaleUploads() {
    let entries;
    try {
      entries = await fsp.readdir(stagingDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return 0;
      throw err;
    }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.part') && !entry.name.endsWith('.xing.mp3')) continue;
      const target = path.join(stagingDir, entry.name);
      if (isInsideDir(stagingDir, target)) {
        await fsp.unlink(target).catch(() => {});
        removed += 1;
      }
    }
    return removed;
  }

  return {
    builtinDir: resolvedBuiltinDir,
    uploadsDir: resolvedUploadsDir,
    configFile: resolvedConfigFile,
    listTracks,
    getActiveUrls,
    saveConfig,
    startUpload,
    appendUploadChunk,
    finishUpload,
    abortUpload,
    deleteUpload,
    cleanupStaleUploads,
  };
}

export const defaultLobbyMusicStore = createLobbyMusicStore();
