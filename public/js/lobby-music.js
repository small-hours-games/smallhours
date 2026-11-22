// TV speakers provide the lobby soundtrack; phones stay quiet.
function createLobbyMusic(audio, onPlaybackChange = () => {}, { playlistUrl = '/api/lobby-music' } = {}) {
  const volume = 0.12;
  const fadeInMs = 1500;
  const fadeOutMs = 1200;
  const duckGainLevel = 0.35;
  const duckDownMs = 300;
  const duckUpMs = 500;
  let base = 0; // the fade envelope, before ducking
  let ducked = false;
  let duck = { from: 1, to: 1, started: 0, duration: 1 };
  let active = false;
  let tracks = [];
  let index = 0;
  let loaded = false;
  let loading = null;
  let timer = null;
  let fade = null;
  let buffering = false;
  let motion = false;
  let pendingSwitch = null;
  let clearSrcOnStop = false;
  let playlistVersion = 0;
  audio.volume = 0;
  function updateMotion() {
    const playing = active && !audio.paused && !audio.muted && !buffering && audio.volume > 0.001;
    if (playing !== motion) { motion = playing; onPlaybackChange(playing); }
  }
  function stopTimer() { clearInterval(timer); timer = null; }
  function clearAudioSrc() {
    audio.src = '';
    if (typeof audio.removeAttribute === 'function') audio.removeAttribute('src');
  }
  function duckGain() {
    const progress = Math.min(1, Math.max(0, (Date.now() - duck.started) / duck.duration));
    return duck.from + (duck.to - duck.from) * progress;
  }
  function tick() {
    if (!fade) return;
    const progress = Math.min(1, Math.max(0, (Date.now() - fade.started) / fade.duration));
    const level = fade.from + (fade.to - fade.from) * progress;
    // Fade the actual track tail, even when duration becomes available late.
    const remaining = Number.isFinite(audio.duration) ? audio.duration - audio.currentTime : Infinity;
    const tail = Math.max(0, Math.min(1, remaining / 2));
    base = Math.max(0, Math.min(volume, level, volume * tail));
    audio.volume = base * duckGain();
    if (progress === 1 && fade.to === 0) {
      audio.pause();
      stopTimer();
      fade = null;
      base = 0;
      audio.volume = 0;
      if (pendingSwitch && active && tracks.length) {
        const nextUrl = pendingSwitch;
        pendingSwitch = null;
        clearSrcOnStop = false;
        audio.src = nextUrl;
        retry();
      } else if (clearSrcOnStop) {
        clearSrcOnStop = false;
        clearAudioSrc();
      }
    }
    updateMotion();
  }
  function fadeTo(target, duration) {
    fade = { from: base, to: target, started: Date.now(), duration };
    if (!timer) timer = setInterval(tick, 50);
    tick();
  }
  audio.addEventListener('playing', () => {
    buffering = false;
    if (!active) { audio.pause(); return; }
    if (pendingSwitch || clearSrcOnStop) return;
    fadeTo(volume, fadeInMs);
  });
  audio.addEventListener('pause', () => { stopTimer(); updateMotion(); });
  audio.addEventListener('waiting', () => { buffering = true; updateMotion(); });
  audio.addEventListener('timeupdate', tick);
  function retry() {
    if (!active || !tracks.length || !audio.paused) return;
    if (!audio.getAttribute('src')) audio.src = tracks[index];
    audio.play().catch(() => { buffering = true; updateMotion(); });
  }
  audio.addEventListener('ended', () => {
    stopTimer();
    audio.volume = 0;
    base = 0;
    fade = null;
    updateMotion();
    if (!active || !tracks.length) {
      pendingSwitch = null;
      if (clearSrcOnStop) { clearSrcOnStop = false; clearAudioSrc(); }
      return;
    }
    if (pendingSwitch) {
      const nextUrl = pendingSwitch;
      pendingSwitch = null;
      audio.src = nextUrl;
      retry();
      return;
    }
    index = (index + 1) % tracks.length;
    audio.src = tracks[index];
    retry();
  });
  function setTracks(nextTracks, { restart = false } = {}) {
    playlistVersion += 1;
    const currentTrack = audio.getAttribute('src') || tracks[index] || '';
    tracks = Array.isArray(nextTracks) ? nextTracks.slice() : [];
    loaded = true;

    if (!tracks.length) {
      index = 0;
      pendingSwitch = null;
      if (!audio.paused && base > 0) {
        clearSrcOnStop = true;
        if (!fade || fade.to !== 0) fadeTo(0, fadeOutMs);
      } else {
        stopTimer();
        fade = null;
        base = 0;
        audio.volume = 0;
        audio.pause();
        clearSrcOnStop = false;
        clearAudioSrc();
        updateMotion();
      }
      return;
    }

    clearSrcOnStop = false;
    const stillPresent = currentTrack ? tracks.indexOf(currentTrack) : -1;

    if (!active || audio.paused) {
      pendingSwitch = null;
      if (restart || stillPresent === -1) {
        index = 0;
        if (!audio.paused && base > 0) {
          clearSrcOnStop = true;
        } else {
          clearAudioSrc();
        }
      } else {
        index = stillPresent;
      }
      if (active) retry();
      return;
    }

    if (stillPresent !== -1 && (!restart || tracks[0] === currentTrack)) {
      index = stillPresent;
      if (pendingSwitch || (fade && fade.to === 0)) {
        pendingSwitch = null;
        clearSrcOnStop = false;
        fadeTo(volume, fadeInMs);
      }
      return;
    }

    index = 0;
    pendingSwitch = tracks[0];
    clearSrcOnStop = true;
    if (base > 0) {
      if (!fade || fade.to !== 0) fadeTo(0, fadeOutMs);
    } else {
      pendingSwitch = null;
      clearSrcOnStop = false;
      audio.pause();
      stopTimer();
      fade = null;
      audio.src = tracks[0];
      retry();
    }
  }
  function reload() {
    if (!loaded || loading) return Promise.resolve();
    const startVersion = playlistVersion;
    loading = fetch(playlistUrl).then(response => {
      if (!response.ok) throw new Error('Music unavailable');
      return response.json();
    }).then(data => {
      if (playlistVersion === startVersion) {
        setTracks(data.tracks || [], { restart: false });
      }
    }).catch(() => {}).finally(() => { loading = null; });
    return loading;
  }
  return {
    setActive(value) {
      // Broadcasts may repeat the same state; keep the current envelope intact.
      if (value === active) return;
      active = value;
      if (!active) {
        pendingSwitch = null;
        if (!audio.paused && base > 0) {
          if (!fade || fade.to !== 0) fadeTo(0, fadeOutMs);
        } else {
          stopTimer();
          audio.pause();
          if (clearSrcOnStop) {
            clearSrcOnStop = false;
            clearAudioSrc();
          }
        }
        updateMotion();
        return;
      }
      if (!audio.paused) {
        const currentTrack = audio.getAttribute('src') || '';
        const currentRemoved = clearSrcOnStop || (loaded && currentTrack && tracks.indexOf(currentTrack) === -1);
        if (!tracks.length && loaded) {
          pendingSwitch = null;
          clearSrcOnStop = true;
          if (!fade || fade.to !== 0) fadeTo(0, fadeOutMs);
          return;
        }
        if (currentRemoved && tracks.length) {
          index = 0;
          pendingSwitch = tracks[0];
          clearSrcOnStop = true;
          if (!fade || fade.to !== 0) fadeTo(0, fadeOutMs);
          return;
        }
        pendingSwitch = null;
        clearSrcOnStop = false;
        fadeTo(volume, fadeInMs);
        return;
      }
      if (loaded) { retry(); return; }
      if (!loading) {
        const startVersion = playlistVersion;
        loading = fetch(playlistUrl).then(response => {
          if (!response.ok) throw new Error('Music unavailable');
          return response.json();
        }).then(data => {
          if (playlistVersion === startVersion) {
            tracks = data.tracks || [];
            loaded = true;
          }
          retry(); // A game may have started during the fetch.
        }).catch(() => {}).finally(() => { loading = null; });
      }
    },
    setMuted(value) { audio.muted = value; updateMotion(); },
    // Make room for a voice. Repeated calls keep the ramp already running.
    setDucked(value) {
      if (value === ducked) return;
      ducked = value;
      duck = { from: duckGain(), to: value ? duckGainLevel : 1, started: Date.now(), duration: value ? duckDownMs : duckUpMs };
      tick();
    },
    setTracks,
    reload,
    retry,
  };
}
