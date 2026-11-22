// Small Hours Tennis — Phone 1:1 Racket Sensor & Touch Controller
(function () {
  'use strict';

  const SWING_COOLDOWN_MS = 190;
  const SWING_WINDOW_MS = 28;
  const POSE_INTERVAL_MS = 25;
  const SWING_ONSET_V = 8.0;
  const SWING_MAX_V = 40.0;
  const MIN_SWING_SPEED = 0.60;
  const MAX_SWING_SPEED = 1.85;

  const tn = {
    active: false,
    listening: false,
    permissionPending: false,
    isMyServe: false,
    canToss: false,
    shotType: 'topspin',
    aim: 0,
    pitch: 0,
    roll: 0,
    yaw: 0,
    calibrated: false,
    rawOrient: { alpha: 0, beta: 0, gamma: 0 },
    zeroOrient: { alpha: 0, beta: 0, gamma: 0 },
    gravity: { x: 0, y: 0, z: 9.81, init: false },
    swingCapture: null,
    swingFlushTimer: null,
    lastSwingAt: -1000,
    lastPoseSentAt: -1000,
    pc: null,
    dc: null,
    pendingIce: [],
    remoteSet: false,
    bound: false,
    padStart: null,
    padPeakV: 0,
    padLast: null,
    padFired: false,
  };

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function normAngle(deg) {
    let a = deg % 360;
    if (a > 180) a -= 360;
    if (a < -180) a += 360;
    return a;
  }

  function mapSwingSpeed(vRacket) {
    const norm = clamp((vRacket - SWING_ONSET_V) / (SWING_MAX_V - SWING_ONSET_V), 0, 1);
    return Number((MIN_SWING_SPEED + norm * (MAX_SWING_SPEED - MIN_SWING_SPEED)).toFixed(2));
  }

  function setLinkBadge(isP2p) {
    const pill = document.getElementById('tnLinkPill');
    if (!pill) return;
    pill.textContent = isP2p ? 'P2P' : 'WS';
    pill.classList.toggle('is-p2p', !!isP2p);
  }

  function vibrate(pattern) {
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      try { navigator.vibrate(pattern); } catch { /* ignore */ }
    }
  }

  function sendInput(payload) {
    if (tn.dc && tn.dc.readyState === 'open') {
      try { tn.dc.send(JSON.stringify(payload)); return; } catch { /* ignore */ }
    }
    if (payload.type === 'swing') {
      send({ type: 'RTC_SIGNAL', signal: { tnSwing: payload } });
    } else if (payload.type === 'toss') {
      send({ type: 'RTC_SIGNAL', signal: { tnToss: true } });
    }
  }

  function emitSwing(opts) {
    const now = performance.now();
    if (now - tn.lastSwingAt < SWING_COOLDOWN_MS) return;
    tn.lastSwingAt = now;
    tn.canToss = false;
    const speed = clamp(Number(opts.speed) || 1.1, MIN_SWING_SPEED, MAX_SWING_SPEED);
    const shotType = opts.shotType || tn.shotType;
    const side = opts.side || null;
    const dirX = clamp(opts.dirX != null ? opts.dirX : tn.aim, -1, 1);

    sendInput({
      type: 'swing',
      shotType,
      speed,
      side,
      dirX,
    });

    const ro = document.getElementById('tnSensorReadout');
    if (ro) {
      const sideLabel = side ? ` · ${side}` : '';
      ro.textContent = `Swing! ${shotType.toUpperCase()} (${speed.toFixed(2)}x${sideLabel})`;
    }

    requestAnimationFrame(() => {
      vibrate(25);
      const pad = document.getElementById('tnRacketPad');
      if (pad) {
        pad.classList.remove('swinging');
        requestAnimationFrame(() => pad.classList.add('swinging'));
      }
    });
  }

  function recenterRacket() {
    tn.zeroOrient = { ...tn.rawOrient };
    tn.calibrated = true;
    tn.aim = 0;
    tn.pitch = 0;
    tn.roll = 0;
    tn.yaw = 0;
    const ro = document.getElementById('tnSensorReadout');
    if (ro) ro.textContent = 'Racket recentered ✓ — swing 1:1!';
  }

  function onDeviceOrientation(e) {
    if (!tn.active) return;
    const alpha = Number(e.alpha);
    const beta = Number(e.beta);
    const gamma = Number(e.gamma);
    if (!Number.isFinite(beta) && !Number.isFinite(gamma)) return;

    tn.rawOrient = {
      alpha: Number.isFinite(alpha) ? alpha : tn.rawOrient.alpha,
      beta: Number.isFinite(beta) ? beta : tn.rawOrient.beta,
      gamma: Number.isFinite(gamma) ? gamma : tn.rawOrient.gamma,
    };

    if (!tn.calibrated) {
      tn.zeroOrient = { ...tn.rawOrient };
      tn.calibrated = true;
    }

    const dAlpha = normAngle(tn.rawOrient.alpha - tn.zeroOrient.alpha);
    const dBeta = normAngle(tn.rawOrient.beta - tn.zeroOrient.beta);
    const dGamma = normAngle(tn.rawOrient.gamma - tn.zeroOrient.gamma);

    tn.yaw = clamp(dAlpha / 45, -1, 1);
    tn.pitch = clamp(dBeta / 45, -1, 1);
    tn.roll = clamp(dGamma / 38, -1, 1);
    tn.aim = clamp(tn.roll - tn.yaw * 0.35, -1, 1);

    const now = performance.now();
    if (now - tn.lastPoseSentAt >= POSE_INTERVAL_MS) {
      tn.lastPoseSentAt = now;
      if (tn.dc && tn.dc.readyState === 'open') {
        try {
          tn.dc.send(JSON.stringify({
            type: 'racket',
            yaw: Number(tn.yaw.toFixed(3)),
            pitch: Number(tn.pitch.toFixed(3)),
            roll: Number(tn.roll.toFixed(3)),
            aim: Number(tn.aim.toFixed(3)),
          }));
        } catch { /* ignore */ }
      }
    }
  }

  function extractLinearAccel(e) {
    const lin = e.acceleration;
    if (lin && (lin.x != null || lin.y != null || lin.z != null)) {
      const lx = Number(lin.x) || 0;
      const ly = Number(lin.y) || 0;
      const lz = Number(lin.z) || 0;
      if (Math.abs(lx) > 0.001 || Math.abs(ly) > 0.001 || Math.abs(lz) > 0.001) {
        return { lx, ly, lz };
      }
    }
    const accG = e.accelerationIncludingGravity;
    if (!accG) return null;
    const gx = Number(accG.x) || 0;
    const gy = Number(accG.y) || 0;
    const gz = Number(accG.z) || 0;
    if (!tn.gravity.init) {
      tn.gravity.x = gx;
      tn.gravity.y = gy;
      tn.gravity.z = gz;
      tn.gravity.init = true;
      return { lx: 0, ly: 0, lz: 0 };
    }
    const alpha = 0.86;
    tn.gravity.x = alpha * tn.gravity.x + (1 - alpha) * gx;
    tn.gravity.y = alpha * tn.gravity.y + (1 - alpha) * gy;
    tn.gravity.z = alpha * tn.gravity.z + (1 - alpha) * gz;
    return {
      lx: gx - tn.gravity.x,
      ly: gy - tn.gravity.y,
      lz: gz - tn.gravity.z,
    };
  }

  function finalizeCapturedSwing() {
    if (tn.swingFlushTimer) {
      clearTimeout(tn.swingFlushTimer);
      tn.swingFlushTimer = null;
    }
    const cap = tn.swingCapture;
    tn.swingCapture = null;
    if (!cap) return;

    const speed = mapSwingSpeed(cap.peakV);
    const side = cap.peakLateral < -1.8 ? 'backhand' : cap.peakLateral > 1.8 ? 'forehand' : null;
    const swingDirX = clamp(-cap.peakLateral / 20, -0.75, 0.75);
    const dirX = clamp(tn.aim * 0.65 + swingDirX * 0.55, -1, 1);

    let shotType = tn.shotType;
    if (cap.peakV > 23 && cap.peakVert < -12) {
      shotType = 'smash';
    } else if (cap.peakV < 18 && cap.peakVert > 12 && tn.shotType === 'topspin') {
      shotType = 'lob';
    }

    emitSwing({ speed, side, dirX, shotType });
  }

  function onDeviceMotion(e) {
    if (!tn.active) return;
    const now = performance.now();
    if (now - tn.lastSwingAt < SWING_COOLDOWN_MS) return;

    const lin = extractLinearAccel(e);
    if (!lin) return;
    const { lx, ly, lz } = lin;
    const linMag = Math.hypot(lx, ly, lz);

    const rot = e.rotationRate || {};
    const rAlpha = Number(rot.alpha) || 0;
    const rBeta = Number(rot.beta) || 0;
    const rGamma = Number(rot.gamma) || 0;
    const rotMag = Math.hypot(rAlpha, rBeta, rGamma);

    // Combined 1:1 physical racket head speed metric (m/s² + scaled deg/s)
    const vRacket = linMag + rotMag * 0.045;

    // Gentle upward toss gesture is ONLY recognized when waiting to serve, never mid-rally
    if (!tn.swingCapture && tn.isMyServe && tn.canToss && ly > 10.5 && Math.abs(lx) < 6 && Math.abs(lz) < 7 && rotMag < 210) {
      tn.canToss = false;
      tn.lastSwingAt = now - SWING_COOLDOWN_MS * 0.5;
      sendInput({ type: 'toss' });
      vibrate(18);
      return;
    }

    const lateralScore = -lx + (-rGamma - rAlpha * 0.55) * 0.035;
    const vertScore = ly + rBeta * 0.035;

    if (!tn.swingCapture) {
      if (vRacket < SWING_ONSET_V) return;
      tn.swingCapture = {
        startedAt: now,
        peakV: vRacket,
        peakLateral: lateralScore,
        peakVert: vertScore,
      };
      tn.swingFlushTimer = setTimeout(finalizeCapturedSwing, SWING_WINDOW_MS + 4);
      return;
    }

    const cap = tn.swingCapture;
    if (vRacket > cap.peakV) {
      cap.peakV = vRacket;
    }
    if (Math.abs(lateralScore) > Math.abs(cap.peakLateral)) {
      cap.peakLateral = lateralScore;
    }
    if (Math.abs(vertScore) > Math.abs(cap.peakVert)) {
      cap.peakVert = vertScore;
    }

    const elapsed = now - cap.startedAt;
    if (elapsed >= SWING_WINDOW_MS || (elapsed >= 12 && vRacket < cap.peakV * 0.62)) {
      finalizeCapturedSwing();
    }
  }

  function updateSensorUi() {
    const btn = document.getElementById('tnSensorBtn');
    const ro = document.getElementById('tnSensorReadout');
    if (tn.listening) {
      if (btn) btn.textContent = '🎯 Recenter Racket';
      if (ro && (!ro.textContent || ro.textContent.includes('Touch') || ro.textContent.includes('Tap'))) {
        ro.textContent = '1:1 racket sensors active — swing phone!';
      }
    } else {
      if (btn) btn.textContent = '📱 Tap to Activate Racket';
    }
  }

  function attachSensors() {
    if (tn.listening) return;
    tn.listening = true;
    tn.calibrated = false;
    tn.gravity.init = false;
    window.addEventListener('deviceorientation', onDeviceOrientation);
    window.addEventListener('devicemotion', onDeviceMotion);
    updateSensorUi();
  }

  async function requestAndAttachSensors() {
    if (tn.listening || tn.permissionPending) return;
    tn.permissionPending = true;
    try {
      if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        const res = await DeviceMotionEvent.requestPermission();
        if (res !== 'granted') {
          tn.permissionPending = false;
          return;
        }
      }
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        await DeviceOrientationEvent.requestPermission().catch(() => {});
      }
      attachSensors();
    } catch {
      // Leave touch pad fallback active
    } finally {
      tn.permissionPending = false;
    }
  }

  function needsIosPermission() {
    return (
      (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') ||
      (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function')
    );
  }

  function startRtc() {
    if (tn.pc) return;
    tn.pendingIce = [];
    tn.remoteSet = false;
    setLinkBadge(false);
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    tn.pc = pc;
    pc.ondatachannel = ev => {
      tn.dc = ev.channel;
      tn.dc.onopen = () => setLinkBadge(true);
      tn.dc.onclose = () => setLinkBadge(false);
      tn.dc.onmessage = msgEv => {
        try {
          const d = JSON.parse(msgEv.data);
          if (d.type === 'haptic') {
            if (d.kind === 'perfect') vibrate([40, 25, 65]);
            else if (d.kind === 'hit') vibrate(30);
            else if (d.kind === 'fault') vibrate([20, 40, 20]);
          }
        } catch { /* ignore */ }
      };
    };
    pc.onicecandidate = e => {
      if (e.candidate) send({ type: 'RTC_SIGNAL', signal: { candidate: e.candidate } });
    };
  }

  function bindUi() {
    if (tn.bound) return;
    tn.bound = true;

    const section = document.getElementById('tennisSection');
    if (section) {
      const autoActivateOnFirstTouch = () => {
        if (!tn.listening && needsIosPermission()) {
          requestAndAttachSensors();
        }
      };
      section.addEventListener('pointerdown', autoActivateOnFirstTouch);
      section.addEventListener('touchstart', autoActivateOnFirstTouch);
    }

    document.getElementById('tnSensorBtn')?.addEventListener('click', async () => {
      if (tn.listening) {
        recenterRacket();
        vibrate(12);
        return;
      }
      await requestAndAttachSensors();
    });

    document.getElementById('tnTossBtn')?.addEventListener('pointerdown', e => {
      e.preventDefault();
      if (!tn.listening && needsIosPermission()) requestAndAttachSensors();
      sendInput({ type: 'toss' });
      vibrate(15);
    });

    document.querySelectorAll('[data-tn-shot]').forEach(btn => {
      btn.addEventListener('click', () => {
        tn.shotType = btn.dataset.tnShot || 'topspin';
        document.querySelectorAll('[data-tn-shot]').forEach(b => b.classList.toggle('active', b === btn));
      });
    });

    const pad = document.getElementById('tnRacketPad');
    if (pad) {
      pad.addEventListener('pointerdown', e => {
        e.preventDefault();
        if (!tn.listening && needsIosPermission()) requestAndAttachSensors();
        pad.setPointerCapture?.(e.pointerId);
        const now = performance.now();
        tn.padStart = { x: e.clientX, y: e.clientY, t: now };
        tn.padLast = { x: e.clientX, y: e.clientY, t: now };
        tn.padPeakV = 0;
        tn.padFired = false;
      });
      pad.addEventListener('pointermove', e => {
        if (!tn.padStart || tn.padFired) return;
        const now = performance.now();
        const stepDt = Math.max(4, now - tn.padLast.t);
        const stepDist = Math.hypot(e.clientX - tn.padLast.x, e.clientY - tn.padLast.y);
        const instV = stepDist / stepDt;
        if (instV > tn.padPeakV) tn.padPeakV = instV;
        tn.padLast = { x: e.clientX, y: e.clientY, t: now };

        const dx = e.clientX - tn.padStart.x;
        const dy = e.clientY - tn.padStart.y;
        const dist = Math.hypot(dx, dy);
        const totalDt = now - tn.padStart.t;
        if (dist < 42 || (totalDt < 36 && dist < 85)) return;

        tn.padFired = true;
        if (tn.isMyServe && tn.canToss && dy < -48 && Math.abs(dy) > Math.abs(dx) * 1.5) {
          tn.canToss = false;
          sendInput({ type: 'toss' });
          vibrate(15);
          return;
        }
        const avgV = dist / Math.max(14, totalDt);
        const effV = Math.max(avgV, tn.padPeakV * 0.75);
        const speed = clamp(0.6 + effV * 0.36, MIN_SWING_SPEED, MAX_SWING_SPEED);
        const side = dx > 18 ? 'backhand' : dx < -18 ? 'forehand' : null;
        const dirX = clamp(dx / 130, -1, 1);
        let shotType = tn.shotType;
        if (dy > 45 && speed > 1.35) shotType = 'smash';
        emitSwing({ speed: Number(speed.toFixed(2)), side, dirX, shotType });
      });
      const finishPad = e => {
        if (!tn.padStart) return;
        if (!tn.padFired) {
          const dx = (e?.clientX ?? tn.padLast.x) - tn.padStart.x;
          const dy = (e?.clientY ?? tn.padLast.y) - tn.padStart.y;
          const dist = Math.hypot(dx, dy);
          if (dist >= 16) {
            const dt = Math.max(14, performance.now() - tn.padStart.t);
            const effV = Math.max(dist / dt, tn.padPeakV * 0.75);
            const speed = clamp(0.6 + effV * 0.36, MIN_SWING_SPEED, MAX_SWING_SPEED);
            const side = dx > 14 ? 'backhand' : dx < -14 ? 'forehand' : null;
            const dirX = clamp(dx / 130, -1, 1);
            emitSwing({ speed: Number(speed.toFixed(2)), side, dirX });
          } else {
            emitSwing({ speed: 1.0 });
          }
        }
        tn.padStart = null;
        tn.padLast = null;
        tn.padPeakV = 0;
        tn.padFired = false;
      };
      pad.addEventListener('pointerup', finishPad);
      pad.addEventListener('pointercancel', () => {
        tn.padStart = null;
        tn.padLast = null;
        tn.padPeakV = 0;
        tn.padFired = false;
      });
    }
  }

  function renderTennisPhone(msg) {
    bindUi();
    tn.active = msg.phase === 'playing';
    if (tn.active && !tn.pc) startRtc();

    const myId = state.playerId;
    const nextServe = msg.serverId === myId;
    if (nextServe && (!tn.isMyServe || msg.pointSerial !== tn.lastPointSerial)) {
      tn.canToss = true;
    }
    tn.isMyServe = nextServe;
    tn.lastPointSerial = msg.pointSerial;

    if (!needsIosPermission() && !tn.listening) {
      attachSensors();
    } else {
      updateSensorUi();
    }

    const p1 = msg.players?.[0];
    const p2 = msg.players?.[1];
    const myAvatar = (state.players || []).find(p => p.playerId === myId)?.avatar || '\u{1F3BE}';

    const avEl = document.getElementById('tnMyAvatar');
    if (avEl && SH.avatarSvg) avEl.innerHTML = SH.avatarSvg(myAvatar, { size: 40 });
    const nameEl = document.getElementById('tnMyName');
    if (nameEl) nameEl.textContent = state.name || 'Player';

    const scoreEl = document.getElementById('tnScorePill');
    if (scoreEl && p1 && p2) {
      scoreEl.textContent = `${msg.pointLabels?.[p1] || '0'} – ${msg.pointLabels?.[p2] || '0'}`;
    }
    const gamesEl = document.getElementById('tnGamesPill');
    if (gamesEl && p1 && p2) {
      gamesEl.textContent = `Games: ${msg.games?.[p1] || 0} – ${msg.games?.[p2] || 0}`;
    }
    const statusEl = document.getElementById('tnStatusText');
    if (statusEl) {
      if (msg.phase === 'finished') {
        statusEl.textContent = msg.winner === myId ? '🏆 You won the match!' : 'Match finished!';
      } else {
        statusEl.textContent = msg.serverId === myId ? 'Your serve — Toss & Swing!' : 'Return the rally — swing 1:1!';
      }
    }
  }

  SH.registerGame('tennis', {
    section: 'tennisSection',
    render: renderTennisPhone,
    onRtcSignal(msg) {
      const sig = msg.signal;
      if (!sig) return;
      if (sig.tnPoint) {
        send({ type: 'GAME_ACTION', action: { type: 'reportPoint', ...sig.tnPoint } });
        return;
      }
      if (!tn.pc) startRtc();
      if (sig.sdp) {
        tn.pc.setRemoteDescription(new RTCSessionDescription(sig.sdp))
          .then(async () => {
            tn.remoteSet = true;
            const queued = tn.pendingIce.splice(0);
            for (const cand of queued) {
              await tn.pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
            }
            const ans = await tn.pc.createAnswer();
            await tn.pc.setLocalDescription(ans);
            send({ type: 'RTC_SIGNAL', signal: { sdp: tn.pc.localDescription } });
          })
          .catch(() => {});
      } else if (sig.candidate) {
        if (tn.remoteSet) {
          tn.pc.addIceCandidate(new RTCIceCandidate(sig.candidate)).catch(() => {});
        } else {
          tn.pendingIce.push(sig.candidate);
        }
      }
    },
    reset() {
      tn.active = false;
      tn.calibrated = false;
      tn.gravity.init = false;
      if (tn.swingFlushTimer) {
        clearTimeout(tn.swingFlushTimer);
        tn.swingFlushTimer = null;
      }
      tn.swingCapture = null;
      if (tn.listening) {
        window.removeEventListener('deviceorientation', onDeviceOrientation);
        window.removeEventListener('devicemotion', onDeviceMotion);
        tn.listening = false;
      }
      try { tn.dc?.close(); tn.pc?.close(); } catch { /* ignore */ }
      tn.dc = null;
      tn.pc = null;
      tn.pendingIce = [];
      tn.remoteSet = false;
      setLinkBadge(false);
    },
  });
})();
