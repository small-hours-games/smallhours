const CARD_PRESET = {
  id: 'crazy-eights-custom',
  kind: 'card-rules',
  label: 'Crazy Eights',
  icon: '🎱',
  blurb: 'Match suit or rank — 8s are wild!',
  min: 2,
  max: 6,
  aiMax: 3,
  deck: { decks: 1, aceHigh: false, opaqueIds: false },
  deal: { hand: 7, flipStarter: true },
  rules: {
    playMatch: 'suitOrRank',
    wildRanks: [8],
    allowMultiSameRank: false,
    drawOnPass: 1,
    specialEffects: { '2': 'nextDraw2', '12': 'reverse', '1': 'skip' },
    reshuffleDiscardWhenEmpty: true,
    allowPass: true,
  },
};

const QUIZ_PRESET = {
  id: 'custom-trivia-pack',
  kind: 'quiz',
  label: 'Custom Trivia',
  icon: '🧠',
  blurb: 'API-powered custom question pack',
  max: 20,
  questionCount: 5,
  tts: true,
  questions: [
    {
      question: 'Which card rank is wild in standard Crazy Eights?',
      correctAnswer: '8',
      incorrectAnswers: ['7', 'Ace', 'King'],
      difficulty: 'easy',
    },
    {
      question: 'How many cards are in a standard playing deck (without jokers)?',
      correctAnswer: '52',
      incorrectAnswers: ['48', '54', '60'],
      difficulty: 'easy',
    },
  ],
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    window.location.href = '/admin/login';
    throw new Error('Unauthorized');
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function loadMe() {
  const { user } = await api('/admin/api/me');
  document.getElementById('adminUserLabel').textContent = user.email || user.name || user.sub;
}

async function loadKeys() {
  const { keys } = await api('/admin/api/keys');
  const tbody = document.getElementById('keysTableBody');
  if (!keys.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="py-4 text-center text-slate-500">No API keys yet.</td></tr>';
    return;
  }
  tbody.innerHTML = keys.map(k => `
    <tr>
      <td class="py-2.5 pr-3 font-medium">${esc(k.name)}</td>
      <td class="py-2.5 pr-3 font-mono text-xs text-sky-300">${esc(k.prefix)}…</td>
      <td class="py-2.5 pr-3 text-xs text-slate-400">${esc(new Date(k.createdAt).toLocaleString())}</td>
      <td class="py-2.5 pr-3 text-xs text-slate-400">${k.lastUsedAt ? esc(new Date(k.lastUsedAt).toLocaleString()) : 'Never'}</td>
      <td class="py-2.5 text-right">
        ${k.revokedAt
          ? '<span class="text-xs text-rose-400">Revoked</span>'
          : `<button data-revoke="${esc(k.id)}" class="px-2.5 py-1 rounded bg-rose-900/60 hover:bg-rose-800 text-rose-200 text-xs font-semibold">Revoke</button>`}
      </td>
    </tr>
  `).join('');
  tbody.querySelectorAll('[data-revoke]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await api(`/admin/api/keys/${encodeURIComponent(btn.dataset.revoke)}`, { method: 'DELETE' });
      loadKeys();
    });
  });
}

async function loadGames() {
  const { custom, builtIn } = await api('/admin/api/games');

  const visList = document.getElementById('lobbyVisibilityList');
  if (visList) {
    const all = [
      ...(builtIn || []).map(g => ({ ...g, typeLabel: g.defaultHidden ? 'Built-in · no UI' : 'Built-in' })),
      ...(custom || []).filter(g => g.enabled).map(g => ({ ...g, typeLabel: 'Custom · ' + g.kind })),
    ];
    visList.innerHTML = all.map(g => `
      <div class="rounded-xl p-3 flex items-center justify-between gap-2 border transition ${g.visibleInLobby ? 'bg-slate-800/80 border-emerald-500/40' : 'bg-slate-950/60 border-slate-800 opacity-55'}">
        <div class="min-w-0">
          <div class="text-sm font-semibold truncate ${g.visibleInLobby ? 'text-white' : 'text-slate-400'}">${esc(g.icon || '🎮')} ${esc(g.label)}</div>
          <div class="text-[11px] text-slate-400 truncate">${esc(g.id)} • ${esc(g.typeLabel)}</div>
        </div>
        <button data-vis-id="${esc(g.id)}" data-vis="${g.visibleInLobby ? '1' : '0'}"
          class="shrink-0 px-2.5 py-1 rounded-lg text-xs font-semibold ${g.visibleInLobby ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-slate-800 hover:bg-slate-700 text-slate-400'}">
          ${g.visibleInLobby ? 'Shown' : 'Hidden'}
        </button>
      </div>
    `).join('');
    visList.querySelectorAll('[data-vis-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const nextVisible = btn.dataset.vis !== '1';
        await api(`/admin/api/lobby-visibility/${encodeURIComponent(btn.dataset.visId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ visible: nextVisible }),
        });
        loadGames();
      });
    });
  }

  const list = document.getElementById('customGamesList');
  if (!custom.length) {
    list.innerHTML = '<div class="col-span-2 text-sm text-slate-500 py-3">No custom games yet. Use a preset or POST to <code>/api/v1/games</code>.</div>';
    return;
  }
  list.innerHTML = custom.map(g => `
    <div class="bg-slate-950 border border-slate-800 rounded-xl p-4 flex items-start justify-between gap-3">
      <div>
        <div class="font-semibold">${esc(g.icon || '🎮')} ${esc(g.label)} <span class="text-xs font-mono text-slate-400">(${esc(g.id)})</span></div>
        <div class="text-xs text-slate-400 mt-0.5">${esc(g.kind)} • ${esc(g.blurb || '')}</div>
      </div>
      <div class="flex items-center gap-1.5 shrink-0">
        <button data-toggle="${esc(g.id)}" data-enabled="${g.enabled ? '1' : '0'}" class="px-2.5 py-1 rounded text-xs font-semibold ${g.enabled ? 'bg-emerald-900/60 text-emerald-200' : 'bg-slate-800 text-slate-300'}">${g.enabled ? 'Enabled' : 'Disabled'}</button>
        <button data-delete-game="${esc(g.id)}" class="px-2.5 py-1 rounded bg-rose-900/60 hover:bg-rose-800 text-rose-200 text-xs font-semibold">Delete</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('[data-toggle]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await api(`/admin/api/games/${encodeURIComponent(btn.dataset.toggle)}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: btn.dataset.enabled !== '1' }),
      });
      loadGames();
    });
  });
  list.querySelectorAll('[data-delete-game]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await api(`/admin/api/games/${encodeURIComponent(btn.dataset.deleteGame)}`, { method: 'DELETE' });
      loadGames();
    });
  });
}

document.getElementById('newKeyForm').addEventListener('submit', async e => {
  e.preventDefault();
  const input = document.getElementById('keyNameInput');
  const { secret } = await api('/admin/api/keys', { method: 'POST', body: JSON.stringify({ name: input.value }) });
  input.value = '';
  document.getElementById('newKeySecretValue').textContent = secret;
  document.getElementById('newKeySecretBox').classList.remove('hidden');
  loadKeys();
});

document.getElementById('copyKeyBtn').addEventListener('click', () => {
  navigator.clipboard?.writeText(document.getElementById('newKeySecretValue').textContent);
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await api('/admin/logout', { method: 'POST' });
  window.location.href = '/';
});

document.getElementById('presetCardBtn').addEventListener('click', () => {
  document.getElementById('gameJsonInput').value = JSON.stringify(CARD_PRESET, null, 2);
  document.querySelector('details').open = true;
});

document.getElementById('presetQuizBtn').addEventListener('click', () => {
  document.getElementById('gameJsonInput').value = JSON.stringify(QUIZ_PRESET, null, 2);
  document.querySelector('details').open = true;
});

document.getElementById('gameJsonForm').addEventListener('submit', async e => {
  e.preventDefault();
  const status = document.getElementById('gameJsonStatus');
  try {
    const spec = JSON.parse(document.getElementById('gameJsonInput').value);
    await api('/admin/api/games', { method: 'POST', body: JSON.stringify(spec) });
    status.textContent = 'Saved and registered!';
    status.className = 'text-xs text-emerald-400';
    loadGames();
  } catch (err) {
    status.textContent = err.message;
    status.className = 'text-xs text-rose-400';
  }
});

document.getElementById('gameJsonInput').value = JSON.stringify(CARD_PRESET, null, 2);
document.getElementById('curlExample').textContent =
`# 1. Create a card game via API
curl -X POST ${location.origin}/api/v1/games \\
  -H "Authorization: Bearer sh_live_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify({ id: 'uno-lite', kind: 'card-rules', label: 'UNO Lite', deal: { hand: 7 }, rules: { playMatch: 'suitOrRank', wildRanks: [8] } })}'

# 2. Deal cards using shared card logic
curl -X POST ${location.origin}/api/v1/cards/deck \\
  -H "Authorization: Bearer sh_live_YOUR_KEY" \\
  -H "Content-Type: application/json" -d '{"decks":1,"aceHigh":true}'`;

// --- Lobby Music management, ordering, preview, and chunked uploads ---
let lobbyMusicTracks = [];
let lastConfirmedLobbyTracks = null;
let lobbyMusicSaveSeq = 0;
let previewAudio = null;
let previewTrackId = null;
let draggedTrackId = null;

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

function setMusicStatus(message, tone = 'muted') {
  const el = document.getElementById('lobbyMusicStatus');
  if (!el) return;
  el.textContent = message;
  el.className =
    tone === 'error'
      ? 'text-xs text-rose-400'
      : tone === 'ok'
        ? 'text-xs text-emerald-400'
        : 'text-xs text-slate-400';
}

function setUploadStatus(message, tone = 'muted') {
  const el = document.getElementById('lobbyMusicUploadStatus');
  if (!el) return;
  el.textContent = message;
  el.className =
    tone === 'error'
      ? 'w-full text-xs text-rose-400'
      : tone === 'warn'
        ? 'w-full text-xs text-amber-300'
        : tone === 'ok'
          ? 'w-full text-xs text-emerald-400'
          : 'w-full text-xs text-slate-400';
}

function stopLobbyPreview() {
  if (previewAudio) {
    try { previewAudio.pause(); } catch {}
  }
  previewTrackId = null;
}

function renderLobbyMusic() {
  const list = document.getElementById('lobbyMusicList');
  if (!list) return;
  if (!lobbyMusicTracks.length) {
    list.innerHTML = '<div class="text-sm text-slate-500 py-3">No lobby tracks yet. Upload an audio file below.</div>';
    return;
  }

  let enabledRank = 0;
  list.innerHTML = lobbyMusicTracks.map((t, idx) => {
    if (t.enabled) enabledRank += 1;
    const isFirst = t.enabled && enabledRank === 1;
    const isPreviewing = previewTrackId === t.id && previewAudio && !previewAudio.paused;
    const rankLabel = t.enabled ? `#${enabledRank}` : '—';
    const badges = [
      t.liveShow ? '<span title="Triggers the live topbar singer & robot show" class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-200 border border-amber-400/40">Live Show</span>' : '',
      isFirst ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-200 border border-emerald-400/40">First</span>' : '',
      t.source === 'upload' ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-sky-500/20 text-sky-200 border border-sky-400/40">Uploaded</span>' : '',
      t.xingWarning ? '<span title="MP3 lacks a Xing header — browser end-of-track fade may trigger early" class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-900/60 text-amber-200 border border-amber-500/40">No Xing</span>' : '',
    ].filter(Boolean).join(' ');

    return `
      <div draggable="true" data-music-row-id="${esc(t.id)}"
        class="rounded-xl p-3 flex flex-wrap items-center justify-between gap-3 border transition ${t.enabled ? 'bg-slate-800/80 border-slate-700' : 'bg-slate-950/60 border-slate-800 opacity-60'}">
        <div class="flex items-center gap-3 min-w-0 flex-1">
          <span class="cursor-grab text-slate-500 hover:text-slate-300 select-none text-sm" title="Drag to reorder" aria-hidden="true">⋮⋮</span>
          <span class="w-7 text-center font-mono text-xs font-bold ${isFirst ? 'text-emerald-300' : 'text-slate-400'}">${rankLabel}</span>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="text-sm font-semibold truncate ${t.enabled ? 'text-white' : 'text-slate-400'}">${esc(t.title || t.filename)}</span>
              ${badges}
            </div>
            <div class="text-[11px] text-slate-400 truncate">${esc(t.filename)} · ${esc(formatBytes(t.sizeBytes))} · ${t.source === 'upload' ? 'Uploaded' : 'Built-in'}</div>
          </div>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <button type="button" data-music-preview="${esc(t.id)}" title="${isPreviewing ? 'Stop preview' : 'Preview track'}"
            class="px-2.5 py-1 rounded-lg text-xs font-semibold ${isPreviewing ? 'bg-sky-600 text-white' : 'bg-slate-900 hover:bg-slate-700 text-slate-200'}">${isPreviewing ? '■' : '▶'}</button>
          <button type="button" data-music-up="${esc(t.id)}" ${idx === 0 ? 'disabled' : ''} title="Move up"
            class="px-2 py-1 rounded-lg text-xs font-semibold bg-slate-900 hover:bg-slate-700 text-slate-200 disabled:opacity-35">↑</button>
          <button type="button" data-music-down="${esc(t.id)}" ${idx === lobbyMusicTracks.length - 1 ? 'disabled' : ''} title="Move down"
            class="px-2 py-1 rounded-lg text-xs font-semibold bg-slate-900 hover:bg-slate-700 text-slate-200 disabled:opacity-35">↓</button>
          <button type="button" data-music-toggle="${esc(t.id)}"
            class="px-2.5 py-1 rounded-lg text-xs font-semibold ${t.enabled ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-slate-800 hover:bg-slate-700 text-slate-400'}">${t.enabled ? 'On' : 'Off'}</button>
          ${t.source === 'upload'
            ? `<button type="button" data-music-delete="${esc(t.id)}" title="Delete uploaded track" class="px-2 py-1 rounded-lg bg-rose-900/60 hover:bg-rose-800 text-rose-200 text-xs font-semibold">✕</button>`
            : ''}
        </div>
      </div>
    `;
  }).join('');
}

async function loadLobbyMusic() {
  const seq = lobbyMusicSaveSeq;
  const data = await api('/admin/api/lobby-music');
  if (seq !== lobbyMusicSaveSeq) return lobbyMusicTracks;
  lobbyMusicTracks = data.tracks || [];
  lastConfirmedLobbyTracks = lobbyMusicTracks.map(t => ({ ...t }));
  renderLobbyMusic();
  return lobbyMusicTracks;
}

async function saveLobbyMusicOrder(nextTracks, previousTracks) {
  if (!lastConfirmedLobbyTracks) {
    lastConfirmedLobbyTracks = previousTracks.map(t => ({ ...t }));
  }
  const seq = ++lobbyMusicSaveSeq;
  lobbyMusicTracks = nextTracks;
  renderLobbyMusic();
  setMusicStatus('Saving…');
  try {
    const payload = { tracks: nextTracks.map(t => ({ id: t.id, enabled: Boolean(t.enabled) })) };
    const data = await api('/admin/api/lobby-music', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    if (seq !== lobbyMusicSaveSeq) return;
    lobbyMusicTracks = data.tracks || nextTracks;
    lastConfirmedLobbyTracks = lobbyMusicTracks.map(t => ({ ...t }));
    renderLobbyMusic();
    setMusicStatus('Saved · live TVs updated', 'ok');
  } catch (err) {
    if (seq !== lobbyMusicSaveSeq) return;
    lobbyMusicTracks = (lastConfirmedLobbyTracks || previousTracks).map(t => ({ ...t }));
    renderLobbyMusic();
    setMusicStatus(err.message || 'Could not save playlist', 'error');
  }
}

async function moveLobbyTrack(id, delta) {
  const idx = lobbyMusicTracks.findIndex(t => t.id === id);
  const nextIdx = idx + delta;
  if (idx === -1 || nextIdx < 0 || nextIdx >= lobbyMusicTracks.length) return;
  const previous = lobbyMusicTracks.map(t => ({ ...t }));
  const next = previous.slice();
  const [moved] = next.splice(idx, 1);
  next.splice(nextIdx, 0, moved);
  await saveLobbyMusicOrder(next, previous);
}

async function reorderLobbyTrack(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return;
  const fromIdx = lobbyMusicTracks.findIndex(t => t.id === fromId);
  const toIdx = lobbyMusicTracks.findIndex(t => t.id === toId);
  if (fromIdx === -1 || toIdx === -1) return;
  const previous = lobbyMusicTracks.map(t => ({ ...t }));
  const next = previous.slice();
  const [moved] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, moved);
  await saveLobbyMusicOrder(next, previous);
}

async function toggleLobbyTrack(id) {
  const idx = lobbyMusicTracks.findIndex(t => t.id === id);
  if (idx === -1) return;
  const previous = lobbyMusicTracks.map(t => ({ ...t }));
  const next = previous.map((t, i) => (i === idx ? { ...t, enabled: !t.enabled } : t));
  await saveLobbyMusicOrder(next, previous);
}

function toggleLobbyPreview(id) {
  const track = lobbyMusicTracks.find(t => t.id === id);
  if (!track) return;
  if (!previewAudio) {
    previewAudio = new Audio();
    previewAudio.addEventListener('ended', () => { previewTrackId = null; renderLobbyMusic(); });
    previewAudio.addEventListener('error', () => { previewTrackId = null; renderLobbyMusic(); });
  }
  if (previewTrackId === id && !previewAudio.paused) {
    stopLobbyPreview();
    renderLobbyMusic();
    return;
  }
  previewAudio.pause();
  previewAudio.currentTime = 0;
  previewAudio.src = track.url;
  previewTrackId = id;
  previewAudio.play().catch(() => {
    previewTrackId = null;
    renderLobbyMusic();
  });
  renderLobbyMusic();
}

async function deleteLobbyTrack(id) {
  const track = lobbyMusicTracks.find(t => t.id === id);
  if (!track || track.source !== 'upload') return;
  if (typeof confirm === 'function' && !confirm(`Delete uploaded track "${track.filename}"?`)) return;
  if (previewTrackId === id) stopLobbyPreview();
  try {
    const data = await api(`/admin/api/lobby-music/${encodeURIComponent(id)}`, { method: 'DELETE' });
    lobbyMusicSaveSeq += 1;
    lobbyMusicTracks = data.tracks || lobbyMusicTracks.filter(t => t.id !== id);
    lastConfirmedLobbyTracks = lobbyMusicTracks.map(t => ({ ...t }));
    renderLobbyMusic();
    setMusicStatus(`Deleted ${track.filename}`, 'ok');
  } catch (err) {
    setMusicStatus(err.message || 'Delete failed', 'error');
  }
}

async function uploadSingleLobbyFile(file, position) {
  const init = await api('/admin/api/lobby-music/uploads', {
    method: 'POST',
    body: JSON.stringify({ filename: file.name, size: file.size, position }),
  });
  const uploadId = init.uploadId;
  const chunkSize = init.chunkSize || (2 * 1024 * 1024);

  try {
    let offset = 0;
    while (offset < file.size) {
      const end = Math.min(file.size, offset + chunkSize);
      const buf = await file.slice(offset, end).arrayBuffer();
      const res = await fetch(`/admin/api/lobby-music/uploads/${encodeURIComponent(uploadId)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Chunk-Offset': String(offset),
        },
        body: buf,
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        window.location.href = '/admin/login';
        throw new Error('Unauthorized');
      }
      if (!res.ok) throw new Error(data.error || `Chunk upload failed (HTTP ${res.status})`);
      offset = end;
      const pct = Math.min(100, Math.round((offset / Math.max(1, file.size)) * 100));
      setUploadStatus(`Uploading ${file.name}… ${pct}%`);
    }

    const done = await api(`/admin/api/lobby-music/uploads/${encodeURIComponent(uploadId)}/finish`, {
      method: 'POST',
    });
    lobbyMusicSaveSeq += 1;
    lobbyMusicTracks = done.tracks || lobbyMusicTracks;
    lastConfirmedLobbyTracks = lobbyMusicTracks.map(t => ({ ...t }));
    renderLobbyMusic();
    return done;
  } catch (err) {
    await fetch(`/admin/api/lobby-music/uploads/${encodeURIComponent(uploadId)}`, { method: 'DELETE' }).catch(() => {});
    throw err;
  }
}

async function uploadLobbyFiles(files) {
  const list = Array.from(files || []);
  if (!list.length) return;
  const addFirst = Boolean(document.getElementById('lobbyMusicAddFirst')?.checked);
  let uploadedCount = 0;
  let sawXingWarning = false;

  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    setUploadStatus(`Uploading ${file.name} (${i + 1}/${list.length})… 0%`);
    try {
      const done = await uploadSingleLobbyFile(file, addFirst ? 'first' : 'end');
      uploadedCount += 1;
      if (done.xingWarning) sawXingWarning = true;
    } catch (err) {
      setUploadStatus(`Upload failed for ${file.name}: ${err.message}`, 'error');
      return;
    }
  }

  if (sawXingWarning) {
    setUploadStatus(`Uploaded ${uploadedCount} track${uploadedCount === 1 ? '' : 's'} (note: MP3 missing Xing header — fade-out timing may be approximate)`, 'warn');
  } else {
    setUploadStatus(`Uploaded ${uploadedCount} track${uploadedCount === 1 ? '' : 's'} and synced to live TVs`, 'ok');
  }
}

async function restartLiveLobbyMusic() {
  try {
    const data = await api('/admin/api/lobby-music/restart', { method: 'POST' });
    const n = Number(data.notifiedHosts || 0);
    setMusicStatus(
      n > 0 ? `Sent #1 to ${n} live TV${n === 1 ? '' : 's'}` : 'No live TVs connected',
      n > 0 ? 'ok' : 'muted'
    );
  } catch (err) {
    setMusicStatus(err.message || 'Could not update live TVs', 'error');
  }
}

const lobbyMusicListEl = document.getElementById('lobbyMusicList');
if (lobbyMusicListEl) {
  lobbyMusicListEl.addEventListener('click', e => {
    const btn = e.target?.closest?.('button');
    if (!btn) return;
    if (btn.dataset.musicPreview) toggleLobbyPreview(btn.dataset.musicPreview);
    else if (btn.dataset.musicUp) moveLobbyTrack(btn.dataset.musicUp, -1);
    else if (btn.dataset.musicDown) moveLobbyTrack(btn.dataset.musicDown, 1);
    else if (btn.dataset.musicToggle) toggleLobbyTrack(btn.dataset.musicToggle);
    else if (btn.dataset.musicDelete) deleteLobbyTrack(btn.dataset.musicDelete);
  });
  lobbyMusicListEl.addEventListener('dragstart', e => {
    const row = e.target?.closest?.('[data-music-row-id]');
    if (!row) return;
    draggedTrackId = row.dataset.musicRowId;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggedTrackId);
    }
  });
  lobbyMusicListEl.addEventListener('dragover', e => {
    const row = e.target?.closest?.('[data-music-row-id]');
    if (!row || !draggedTrackId) return;
    e.preventDefault();
    row.classList?.add('border-sky-400');
  });
  lobbyMusicListEl.addEventListener('dragleave', e => {
    const row = e.target?.closest?.('[data-music-row-id]');
    row?.classList?.remove('border-sky-400');
  });
  lobbyMusicListEl.addEventListener('drop', e => {
    const row = e.target?.closest?.('[data-music-row-id]');
    if (!row || !draggedTrackId) return;
    e.preventDefault();
    row.classList?.remove('border-sky-400');
    const targetId = row.dataset.musicRowId;
    const fromId = draggedTrackId;
    draggedTrackId = null;
    reorderLobbyTrack(fromId, targetId);
  });
  lobbyMusicListEl.addEventListener('dragend', () => {
    draggedTrackId = null;
  });
}

document.getElementById('lobbyMusicRestartBtn')?.addEventListener('click', restartLiveLobbyMusic);

const musicFileInput = document.getElementById('lobbyMusicFileInput');
if (musicFileInput) {
  musicFileInput.addEventListener('change', async e => {
    const files = e.target?.files;
    if (files && files.length) await uploadLobbyFiles(files);
    if (e.target) e.target.value = '';
  });
}

const musicDropzone = document.getElementById('lobbyMusicDropzone');
if (musicDropzone) {
  musicDropzone.addEventListener('dragover', e => {
    e.preventDefault();
    musicDropzone.classList?.add('border-sky-400', 'bg-slate-900');
  });
  musicDropzone.addEventListener('dragleave', () => {
    musicDropzone.classList?.remove('border-sky-400', 'bg-slate-900');
  });
  musicDropzone.addEventListener('drop', async e => {
    e.preventDefault();
    musicDropzone.classList?.remove('border-sky-400', 'bg-slate-900');
    const files = e.dataTransfer?.files;
    if (files && files.length) await uploadLobbyFiles(files);
  });
}

Promise.all([loadMe(), loadKeys(), loadGames(), loadLobbyMusic()]).catch(() => {});
