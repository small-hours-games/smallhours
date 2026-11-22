import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const adminHtml = readFileSync(new URL('../../public/admin.html', import.meta.url), 'utf8');
const adminJs = readFileSync(new URL('../../public/js/admin.js', import.meta.url), 'utf8');

function makeEl(id) {
  const listeners = {};
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    className: '',
    dataset: {},
    classList: {
      add: vi.fn(),
      remove: vi.fn(),
      toggle: vi.fn(),
    },
    addEventListener(event, fn) {
      (listeners[event] = listeners[event] || []).push(fn);
    },
    trigger(event, payload = {}) {
      for (const fn of listeners[event] || []) fn(payload);
    },
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };
}

function createHarness(fetchImpl, { confirmResult = true } = {}) {
  const ids = [
    'adminUserLabel', 'keysTableBody', 'lobbyVisibilityList', 'customGamesList',
    'newKeyForm', 'keyNameInput', 'newKeySecretBox', 'newKeySecretValue', 'copyKeyBtn',
    'logoutBtn', 'presetCardBtn', 'presetQuizBtn', 'gameJsonForm', 'gameJsonInput',
    'gameJsonStatus', 'curlExample',
    'lobbyMusicSection', 'lobbyMusicList', 'lobbyMusicStatus', 'lobbyMusicRestartBtn',
    'lobbyMusicDropzone', 'lobbyMusicFileInput', 'lobbyMusicAddFirst', 'lobbyMusicUploadStatus',
  ];
  const elements = Object.fromEntries(ids.map(id => [id, makeEl(id)]));

  const audioInstances = [];
  class FakeAudio {
    constructor() {
      this.src = '';
      this.paused = true;
      this.currentTime = 0;
      this._listeners = {};
      this.play = vi.fn(() => { this.paused = false; return Promise.resolve(); });
      this.pause = vi.fn(() => { this.paused = true; });
      this.addEventListener = (ev, fn) => { (this._listeners[ev] = this._listeners[ev] || []).push(fn); };
      audioInstances.push(this);
    }
  }

  const document = {
    getElementById: id => elements[id] || null,
    querySelector: () => ({ open: false }),
  };

  const context = {
    document,
    window: { location: { href: '/admin' } },
    location: { origin: 'https://smallhours.se' },
    navigator: { clipboard: { writeText: vi.fn() } },
    fetch: vi.fn(fetchImpl),
    confirm: vi.fn(() => confirmResult),
    Audio: FakeAudio,
    Date,
    URL,
    encodeURIComponent,
    decodeURIComponent,
    setTimeout,
    clearTimeout,
    Promise,
    JSON,
    Math,
    Number,
    String,
    Array,
    Boolean,
    Error,
  };

  runInNewContext(adminJs, context);
  return { context, elements, audioInstances, fetchMock: context.fetch, confirmMock: context.confirm };
}

function sampleTracks() {
  return [
    {
      id: 'builtin:LGTM-remix.mp3',
      filename: 'LGTM-remix.mp3',
      title: 'LGTM remix',
      url: '/music/lobby/LGTM-remix.mp3',
      source: 'builtin',
      enabled: false,
      liveShow: false,
      sizeBytes: 3823300,
      xingWarning: false,
    },
    {
      id: 'builtin:Looks-good-to-me-remix.mp3',
      filename: 'Looks-good-to-me-remix.mp3',
      title: 'Looks good to me remix',
      url: '/music/lobby/Looks-good-to-me-remix.mp3',
      source: 'builtin',
      enabled: true,
      liveShow: true,
      sizeBytes: 6369982,
      xingWarning: false,
    },
    {
      id: 'upload:friday-groove.mp3',
      filename: 'friday-groove.mp3',
      title: 'friday groove',
      url: '/music/lobby/uploads/friday-groove.mp3',
      source: 'upload',
      enabled: true,
      liveShow: false,
      sizeBytes: 4000000,
      xingWarning: true,
    },
  ];
}

function defaultResponder(tracksRef, overrides = {}) {
  return async (url, opts = {}) => {
    const key = `${(opts.method || 'GET').toUpperCase()} ${url}`;
    if (overrides[key]) return overrides[key](url, opts);
    if (url === '/admin/api/me') return { ok: true, status: 200, json: async () => ({ user: { email: 'admin@test' } }) };
    if (url === '/admin/api/keys') return { ok: true, status: 200, json: async () => ({ keys: [] }) };
    if (url === '/admin/api/games') return { ok: true, status: 200, json: async () => ({ custom: [], builtIn: [] }) };
    if (url === '/admin/api/lobby-music' && (!opts.method || opts.method === 'GET')) {
      return { ok: true, status: 200, json: async () => ({ tracks: tracksRef.current, activeCount: tracksRef.current.filter(t => t.enabled).length }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, tracks: tracksRef.current }) };
  };
}

describe('/admin Lobby Music UI', () => {
  it('includes all required Lobby Music elements in public/admin.html', () => {
    for (const id of [
      'lobbyMusicSection',
      'lobbyMusicList',
      'lobbyMusicStatus',
      'lobbyMusicRestartBtn',
      'lobbyMusicDropzone',
      'lobbyMusicFileInput',
      'lobbyMusicAddFirst',
      'lobbyMusicUploadStatus',
    ]) {
      expect(adminHtml).toContain(`id="${id}"`);
    }
  });

  it('renders #1 First on first enabled track, Live Show badge, Uploaded delete button, and Xing warning', async () => {
    const tracksRef = { current: sampleTracks() };
    const { context, elements } = createHarness(defaultResponder(tracksRef));
    await context.loadLobbyMusic();

    const html = elements.lobbyMusicList.innerHTML;
    expect(html).toContain('Live Show');
    expect(html).toContain('First');
    expect(html).toContain('Uploaded');
    expect(html).toContain('Xing');
    // Delete action appears only for the uploaded track, never for built-ins
    expect(html).toContain('data-music-delete="upload:friday-groove.mp3"');
    expect(html).not.toContain('data-music-delete="builtin:LGTM-remix.mp3"');
    expect(html).not.toContain('data-music-delete="builtin:Looks-good-to-me-remix.mp3"');
  });

  it('sends PUT on reorder/toggle and rolls back UI with error message when PUT fails', async () => {
    const tracksRef = { current: sampleTracks() };
    const putCalls = [];
    const { context, elements } = createHarness(
      defaultResponder(tracksRef, {
        'PUT /admin/api/lobby-music': async (_url, opts) => {
          const body = JSON.parse(opts.body);
          putCalls.push(body);
          if (putCalls.length === 1) {
            const byId = new Map(tracksRef.current.map(t => [t.id, t]));
            tracksRef.current = body.tracks.map(x => ({ ...byId.get(x.id), enabled: x.enabled }));
            return { ok: true, status: 200, json: async () => ({ tracks: tracksRef.current, activeCount: 2 }) };
          }
          return { ok: false, status: 500, json: async () => ({ error: 'Disk full' }) };
        },
      })
    );
    await context.loadLobbyMusic();

    // Move uploaded track up by 1
    await context.moveLobbyTrack('upload:friday-groove.mp3', -1);
    expect(putCalls[0].tracks.map(t => t.id)).toEqual([
      'builtin:LGTM-remix.mp3',
      'upload:friday-groove.mp3',
      'builtin:Looks-good-to-me-remix.mp3',
    ]);

    // Toggle fails -> rollback to previous enabled state & surface error
    const htmlBefore = elements.lobbyMusicList.innerHTML;
    await context.toggleLobbyTrack('upload:friday-groove.mp3');
    expect(elements.lobbyMusicStatus.textContent).toContain('Disk full');
    expect(elements.lobbyMusicList.innerHTML).toBe(htmlBefore);
  });

  it('previews tracks using one shared Audio element and stops preview when deleting that track', async () => {
    const tracksRef = { current: sampleTracks() };
    const { context, audioInstances } = createHarness(
      defaultResponder(tracksRef, {
        [`DELETE /admin/api/lobby-music/${encodeURIComponent('upload:friday-groove.mp3')}`]: async () => {
          tracksRef.current = tracksRef.current.filter(t => t.id !== 'upload:friday-groove.mp3');
          return { ok: true, status: 200, json: async () => ({ ok: true, tracks: tracksRef.current, activeCount: 1 }) };
        },
      })
    );
    await context.loadLobbyMusic();

    context.toggleLobbyPreview('builtin:Looks-good-to-me-remix.mp3');
    expect(audioInstances.length).toBe(1);
    expect(audioInstances[0].src).toBe('/music/lobby/Looks-good-to-me-remix.mp3');
    expect(audioInstances[0].play).toHaveBeenCalledTimes(1);

    // Switching preview reuses same Audio instance
    context.toggleLobbyPreview('upload:friday-groove.mp3');
    expect(audioInstances.length).toBe(1);
    expect(audioInstances[0].src).toBe('/music/lobby/uploads/friday-groove.mp3');

    // Deleting the currently previewing track pauses preview
    await context.deleteLobbyTrack('upload:friday-groove.mp3');
    expect(audioInstances[0].pause).toHaveBeenCalled();
  });

  it('uploads files in 2 MB chunks with X-Chunk-Offset, respects Add at #1, and aborts on chunk error', async () => {
    const tracksRef = { current: sampleTracks() };
    const calls = [];
    let failOnSecondFile = false;

    const { context, elements } = createHarness(async (url, opts = {}) => {
      const method = (opts.method || 'GET').toUpperCase();
      calls.push({ method, url, headers: opts.headers || {}, body: opts.body });
      if (method === 'POST' && url === '/admin/api/lobby-music/uploads') {
        return { ok: true, status: 201, json: async () => ({ uploadId: 'up-1', chunkSize: 2 * 1024 * 1024 }) };
      }
      if (method === 'PUT' && url === '/admin/api/lobby-music/uploads/up-1') {
        if (failOnSecondFile) {
          return { ok: false, status: 500, json: async () => ({ error: 'Chunk write failed' }) };
        }
        return { ok: true, status: 200, json: async () => ({ receivedBytes: Number(opts.headers['X-Chunk-Offset']) + opts.body.byteLength }) };
      }
      if (method === 'POST' && url === '/admin/api/lobby-music/uploads/up-1/finish') {
        return {
          ok: true,
          status: 201,
          json: async () => ({
            track: { id: 'upload:five-mb.mp3', filename: 'five-mb.mp3' },
            tracks: tracksRef.current,
            activeCount: 2,
            xingNormalized: true,
            xingWarning: false,
          }),
        };
      }
      if (method === 'DELETE' && url === '/admin/api/lobby-music/uploads/up-1') {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return defaultResponder(tracksRef)(url, opts);
    });
    await context.loadLobbyMusic();

    const FIVE_MB = 5 * 1024 * 1024;
    const makeFakeFile = (name, size) => ({
      name,
      size,
      slice(start, end) {
        const len = Math.max(0, Math.min(size, end) - start);
        return { async arrayBuffer() { return new ArrayBuffer(len); } };
      },
    });

    elements.lobbyMusicAddFirst.checked = true;
    await context.uploadLobbyFiles([makeFakeFile('five-mb.mp3', FIVE_MB)]);

    const initCall = calls.find(c => c.method === 'POST' && c.url === '/admin/api/lobby-music/uploads');
    expect(JSON.parse(initCall.body)).toEqual({ filename: 'five-mb.mp3', size: FIVE_MB, position: 'first' });

    const chunkCalls = calls.filter(c => c.method === 'PUT' && c.url === '/admin/api/lobby-music/uploads/up-1');
    expect(chunkCalls.map(c => Number(c.headers['X-Chunk-Offset']))).toEqual([0, 2 * 1024 * 1024, 4 * 1024 * 1024]);
    expect(chunkCalls.map(c => c.body.byteLength)).toEqual([2 * 1024 * 1024, 2 * 1024 * 1024, 1 * 1024 * 1024]);
    expect(calls.some(c => c.method === 'POST' && c.url === '/admin/api/lobby-music/uploads/up-1/finish')).toBe(true);

    // Chunk error triggers abort DELETE
    calls.length = 0;
    failOnSecondFile = true;
    await context.uploadLobbyFiles([makeFakeFile('broken.mp3', 1024)]);
    expect(calls.some(c => c.method === 'DELETE' && c.url === '/admin/api/lobby-music/uploads/up-1')).toBe(true);
    expect(elements.lobbyMusicUploadStatus.textContent).toContain('Chunk write failed');
  });

  it('restarts live TVs from #1 and displays notified host count', async () => {
    const tracksRef = { current: sampleTracks() };
    const { context, elements } = createHarness(
      defaultResponder(tracksRef, {
        'POST /admin/api/lobby-music/restart': async () => ({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, notifiedHosts: 2 }),
        }),
      })
    );
    await context.loadLobbyMusic();
    await context.restartLiveLobbyMusic();
    expect(elements.lobbyMusicStatus.textContent).toContain('2');
  });

  it('ignores stale out-of-order PUT responses during rapid reorder clicks', async () => {
    const tracksRef = { current: sampleTracks() };
    const pendingPuts = [];
    const { context, elements } = createHarness(
      defaultResponder(tracksRef, {
        'PUT /admin/api/lobby-music': (_url, opts) =>
          new Promise(resolve => {
            pendingPuts.push({ body: JSON.parse(opts.body), resolve });
          }),
      })
    );
    await context.loadLobbyMusic();

    // Two rapid clicks moving friday-groove.mp3 from index 2 -> 1 -> 0
    const p1 = context.moveLobbyTrack('upload:friday-groove.mp3', -1);
    const p2 = context.moveLobbyTrack('upload:friday-groove.mp3', -1);

    const byId = new Map(tracksRef.current.map(t => [t.id, t]));
    const materialize = body => body.tracks.map(x => ({ ...byId.get(x.id), enabled: x.enabled }));

    // Resolve #2 BEFORE #1 (out-of-order network responses)
    expect(pendingPuts.length).toBe(2);
    pendingPuts[1].resolve({ ok: true, status: 200, json: async () => ({ tracks: materialize(pendingPuts[1].body), activeCount: 2 }) });
    await p2;
    const htmlAfterNewest = elements.lobbyMusicList.innerHTML;
    expect(htmlAfterNewest.indexOf('friday-groove.mp3')).toBeLessThan(htmlAfterNewest.indexOf('LGTM-remix.mp3'));

    // Stale #1 resolves late (or fails) -> must NOT overwrite newer order
    pendingPuts[0].resolve({ ok: false, status: 500, json: async () => ({ error: 'Stale error' }) });
    await p1;
    expect(elements.lobbyMusicList.innerHTML).toBe(htmlAfterNewest);
  });
});
