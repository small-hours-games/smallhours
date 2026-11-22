import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const tennisPhoneJs = readFileSync(new URL('../../games/arcade-tennis/client/phone.js', import.meta.url), 'utf8');
const tennisPhoneHtml = readFileSync(new URL('../../games/arcade-tennis/client/phone.html', import.meta.url), 'utf8');
const tennisTvJs = readFileSync(new URL('../../games/arcade-tennis/client/tv.js', import.meta.url), 'utf8');
const runnerPhoneJs = readFileSync(new URL('../../games/arcade-runner/client/phone.js', import.meta.url), 'utf8');
const runnerPhoneHtml = readFileSync(new URL('../../games/arcade-runner/client/phone.html', import.meta.url), 'utf8');
const tiltBallPhoneJs = readFileSync(new URL('../../games/arcade-tilt-ball/client/phone.js', import.meta.url), 'utf8');

function makeEl(id, dataset = {}) {
  const listeners = {};
  const classes = new Set();
  return {
    id,
    dataset,
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    clientWidth: 200,
    offsetWidth: 38,
    style: {
      setProperty: vi.fn(),
    },
    classList: {
      add: (...cs) => cs.forEach(c => classes.add(c)),
      remove: (...cs) => cs.forEach(c => classes.delete(c)),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : Boolean(force);
        if (on) classes.add(c);
        else classes.delete(c);
        return on;
      },
      contains: c => classes.has(c),
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter(f => f !== fn);
    },
    trigger(type, ev = {}) {
      const eventObj = { preventDefault: vi.fn(), ...ev };
      for (const fn of [...(listeners[type] || [])]) fn(eventObj);
    },
    setPointerCapture: vi.fn(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 200 }),
  };
}

function setupTennisPhone({ iosPermission = false } = {}) {
  let nowMs = 1000;
  const winListeners = {};
  const els = {
    tennisSection: makeEl('tennisSection'),
    tnLinkPill: makeEl('tnLinkPill'),
    tnSensorBtn: makeEl('tnSensorBtn'),
    tnTossBtn: makeEl('tnTossBtn'),
    tnRacketPad: makeEl('tnRacketPad'),
    tnSensorReadout: makeEl('tnSensorReadout'),
    tnMyAvatar: makeEl('tnMyAvatar'),
    tnMyName: makeEl('tnMyName'),
    tnScorePill: makeEl('tnScorePill'),
    tnGamesPill: makeEl('tnGamesPill'),
    tnStatusText: makeEl('tnStatusText'),
  };
  const shotBtns = ['topspin', 'slice', 'lob', 'smash'].map(s => makeEl(`shot_${s}`, { tnShot: s }));

  const dcSent = [];
  const wsSent = [];
  let registered = null;

  const DeviceMotionEvent = iosPermission
    ? { requestPermission: vi.fn(async () => 'granted') }
    : function DeviceMotionEvent() {};
  const DeviceOrientationEvent = iosPermission
    ? { requestPermission: vi.fn(async () => 'granted') }
    : function DeviceOrientationEvent() {};

  let pcInstance = null;
  class FakeRTCPeerConnection {
    constructor() {
      this.ondatachannel = null;
      this.onicecandidate = null;
      this.close = vi.fn();
      pcInstance = this;
    }
  }

  const windowObj = {
    addEventListener(type, fn) {
      (winListeners[type] = winListeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      if (!winListeners[type]) return;
      winListeners[type] = winListeners[type].filter(f => f !== fn);
    },
    emit(type, ev) {
      for (const fn of [...(winListeners[type] || [])]) fn(ev);
    },
    listeners: winListeners,
  };

  const context = {
    window: windowObj,
    document: {
      getElementById: id => els[id] || null,
      querySelectorAll: sel => (sel === '[data-tn-shot]' ? shotBtns : []),
    },
    navigator: { vibrate: vi.fn() },
    performance: { now: () => nowMs },
    requestAnimationFrame: fn => fn(),
    setTimeout,
    clearTimeout,
    DeviceMotionEvent,
    DeviceOrientationEvent,
    RTCPeerConnection: FakeRTCPeerConnection,
    RTCSessionDescription: function (x) { return x; },
    RTCIceCandidate: function (x) { return x; },
    SH: {
      registerGame: (_id, def) => { registered = def; },
      avatarSvg: () => '<svg></svg>',
    },
    state: { playerId: 'p1', name: 'Alice', players: [{ playerId: 'p1', avatar: '🦊' }] },
    send: msg => wsSent.push(msg),
    showToast: vi.fn(),
    Math,
    Number,
    String,
    Boolean,
    JSON,
    Promise,
  };

  runInNewContext(tennisPhoneJs, context);

  function openDataChannel() {
    if (!pcInstance || !pcInstance.ondatachannel) return;
    const dc = {
      readyState: 'open',
      send: raw => dcSent.push(JSON.parse(raw)),
      close: vi.fn(),
    };
    pcInstance.ondatachannel({ channel: dc });
    dc.onopen?.();
  }

  return {
    registered,
    els,
    windowObj,
    dcSent,
    wsSent,
    DeviceMotionEvent,
    DeviceOrientationEvent,
    openDataChannel,
    advanceTime(ms) { nowMs += ms; },
    setTime(ms) { nowMs = ms; },
  };
}

describe('Tennis 1:1 gyro + accelerometer controller', () => {
  it('auto-activates sensors immediately on Android and on first touch anywhere on iOS', async () => {
    const android = setupTennisPhone({ iosPermission: false });
    android.registered.render({ phase: 'playing', players: ['p1', 'p2'], serverId: 'p2' });
    expect((android.windowObj.listeners.devicemotion || []).length).toBe(1);
    expect((android.windowObj.listeners.deviceorientation || []).length).toBe(1);
    expect(android.els.tnSensorBtn.textContent).toContain('Recenter');

    const ios = setupTennisPhone({ iosPermission: true });
    ios.registered.render({ phase: 'playing', players: ['p1', 'p2'], serverId: 'p2' });
    expect((ios.windowObj.listeners.devicemotion || []).length || 0).toBe(0);

    // First touch anywhere inside #tennisSection requests permission and attaches sensors
    ios.els.tennisSection.trigger('pointerdown', {});
    await new Promise(r => setTimeout(r, 10));
    expect(ios.DeviceMotionEvent.requestPermission).toHaveBeenCalledTimes(1);
    expect(ios.DeviceOrientationEvent.requestPermission).toHaveBeenCalledTimes(1);
    expect((ios.windowObj.listeners.devicemotion || []).length).toBe(1);
    expect((ios.windowObj.listeners.deviceorientation || []).length).toBe(1);
  });

  it('auto-zeros initial phone holding posture and streams 1:1 racket orientation over P2P', () => {
    const h = setupTennisPhone();
    h.registered.render({ phase: 'playing', players: ['p1', 'p2'], serverId: 'p2' });
    h.openDataChannel();

    // Initial couch holding angle (beta=44 deg pitch, gamma=-10 deg roll, alpha=120 deg yaw) -> auto-zeros to 0
    h.windowObj.emit('deviceorientation', { alpha: 120, beta: 44, gamma: -10 });
    const firstPose = h.dcSent.find(m => m.type === 'racket');
    expect(firstPose).toBeDefined();
    expect(firstPose.aim).toBeCloseTo(0, 2);
    expect(firstPose.pitch).toBeCloseTo(0, 2);
    expect(firstPose.roll).toBeCloseTo(0, 2);
    expect(firstPose.yaw).toBeCloseTo(0, 2);

    // Tilting +18 deg right and pitching +15 deg forward streams 1:1 relative pose
    h.dcSent.length = 0;
    h.advanceTime(30);
    h.windowObj.emit('deviceorientation', { alpha: 105, beta: 59, gamma: 8 });
    const secondPose = h.dcSent.find(m => m.type === 'racket');
    expect(secondPose).toBeDefined();
    expect(secondPose.aim).toBeGreaterThan(0.35);
    expect(secondPose.pitch).toBeGreaterThan(0.25);
    expect(secondPose.roll).toBeGreaterThan(0.35);
    expect(secondPose.yaw).toBeLessThan(-0.2);

    // Clicking #tnSensorBtn recenters neutral grip to current orientation
    h.dcSent.length = 0;
    h.advanceTime(30);
    h.els.tnSensorBtn.trigger('click');
    h.windowObj.emit('deviceorientation', { alpha: 105, beta: 59, gamma: 8 });
    const recentered = h.dcSent.find(m => m.type === 'racket');
    expect(recentered.aim).toBeCloseTo(0, 2);
    expect(recentered.pitch).toBeCloseTo(0, 2);
    expect(recentered.roll).toBeCloseTo(0, 2);
  });

  it('tracks peak velocity over the swing window for true 1:1 soft vs power swing speeds', () => {
    const h = setupTennisPhone();
    h.registered.render({ phase: 'playing', players: ['p1', 'p2'], serverId: 'p2' });
    h.openDataChannel();

    // 1. Gentle wrist swing (onset -> slight peak -> decay)
    h.windowObj.emit('devicemotion', {
      acceleration: { x: 3.5, y: 0.4, z: 2.5 },
      rotationRate: { alpha: 80, beta: 20, gamma: 110 },
    });
    h.advanceTime(15);
    h.windowObj.emit('devicemotion', {
      acceleration: { x: 5.2, y: 0.6, z: 3.8 },
      rotationRate: { alpha: 110, beta: 30, gamma: 155 },
    });
    h.advanceTime(18);
    h.windowObj.emit('devicemotion', {
      acceleration: { x: 2.0, y: 0.2, z: 1.5 },
      rotationRate: { alpha: 40, beta: 10, gamma: 60 },
    });

    const softSwing = h.dcSent.find(m => m.type === 'swing');
    expect(softSwing).toBeDefined();
    expect(softSwing.speed).toBeGreaterThanOrEqual(0.6);
    expect(softSwing.speed).toBeLessThan(0.95);
    expect(softSwing.side).toBe('backhand');

    // 2. Fast power forehand whip (starts with a moderate onset sample, then peaks high 14ms later)
    h.dcSent.length = 0;
    h.advanceTime(300);
    // Moderate onset sample that old code would have locked in at ~0.95x
    h.windowObj.emit('devicemotion', {
      acceleration: { x: -5.5, y: 1.2, z: 3.5 },
      rotationRate: { alpha: -130, beta: 45, gamma: -160 },
    });
    expect(h.dcSent.find(m => m.type === 'swing')).toBeUndefined();

    // Peak whip sample 14ms later
    h.advanceTime(14);
    h.windowObj.emit('devicemotion', {
      acceleration: { x: -22.0, y: 4.5, z: 14.0 },
      rotationRate: { alpha: -460, beta: 160, gamma: -540 },
    });
    // Window completes 16ms later
    h.advanceTime(16);
    h.windowObj.emit('devicemotion', {
      acceleration: { x: -8.0, y: 1.5, z: 5.0 },
      rotationRate: { alpha: -180, beta: 60, gamma: -200 },
    });

    const fastSwing = h.dcSent.find(m => m.type === 'swing');
    expect(fastSwing).toBeDefined();
    expect(fastSwing.speed).toBeGreaterThan(1.55);
    expect(fastSwing.side).toBe('forehand');
  });

  it('strips gravity accurately when only accelerationIncludingGravity is available and never misfires toss mid-rally', () => {
    const h = setupTennisPhone();
    // p2 is serving -> p1 is returning a rally (not serving)
    h.registered.render({ phase: 'playing', players: ['p1', 'p2'], serverId: 'p2' });
    h.openDataChannel();

    // Settle gravity baseline at ~45 deg tilt (gy=6.9, gz=6.9)
    for (let i = 0; i < 12; i++) {
      h.windowObj.emit('devicemotion', {
        acceleration: null,
        accelerationIncludingGravity: { x: 0, y: 6.9, z: 6.9 },
        rotationRate: { alpha: 0, beta: 0, gamma: 0 },
      });
    }

    // Upward topspin swing during rally (ay > 18, az near gravity=6.9 so |lz| < 2) must emit SWING, never TOSS
    h.advanceTime(250);
    h.windowObj.emit('devicemotion', {
      acceleration: null,
      accelerationIncludingGravity: { x: -12, y: 19, z: 7.2 },
      rotationRate: { alpha: -240, beta: 210, gamma: -260 },
    });
    h.advanceTime(32);
    h.windowObj.emit('devicemotion', {
      acceleration: null,
      accelerationIncludingGravity: { x: -2, y: 7.1, z: 6.9 },
      rotationRate: { alpha: -30, beta: 20, gamma: -40 },
    });

    expect(h.dcSent.some(m => m.type === 'toss')).toBe(false);
    const rallySwing = h.dcSent.find(m => m.type === 'swing');
    expect(rallySwing).toBeDefined();
    expect(rallySwing.side).toBe('forehand');
  });

  it('replicates 1:1 swing speed and live racket pose in Tennis TV simulation', () => {
    expect(tennisTvJs).toContain("d.type === 'racket'");
    expect(tennisTvJs).toContain('liveRacket');
    // Swing duration scales inversely with 1:1 shot speed
    expect(tennisTvJs).toMatch(/swingDuration\s*=\s*Math\.max\(/);
    expect(tennisPhoneHtml).toContain('id="tnSensorBtn"');
  });
});

describe('Runner arrow-first controller (no gyro/tilt)', () => {
  it('removes tilt toggle and motion listeners from Runner phone UI and binds arrow controls', () => {
    expect(runnerPhoneHtml).not.toContain('rnMotionToggle');
    expect(runnerPhoneHtml).not.toContain('Tilt:');
    expect(runnerPhoneHtml).toContain('id="rnLeftBtn"');
    expect(runnerPhoneHtml).toContain('id="rnJumpBtn"');
    expect(runnerPhoneHtml).toContain('id="rnRightBtn"');

    const winListeners = {};
    const els = {
      runnerSection: makeEl('runnerSection'),
      rnLinkPill: makeEl('rnLinkPill'),
      rnMyAvatar: makeEl('rnMyAvatar'),
      rnMyName: makeEl('rnMyName'),
      rnMyLives: makeEl('rnMyLives'),
      rnMyScore: makeEl('rnMyScore'),
      rnSwipePad: makeEl('rnSwipePad'),
      rnCssOrb: makeEl('rnCssOrb'),
      rnCssOrbShadow: makeEl('rnCssOrbShadow'),
      rnLeftBtn: makeEl('rnLeftBtn'),
      rnJumpBtn: makeEl('rnJumpBtn'),
      rnRightBtn: makeEl('rnRightBtn'),
    };
    const wsSent = [];
    let registered = null;

    const context = {
      window: {
        addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); },
        removeEventListener() {},
        emit(type, ev) { for (const fn of winListeners[type] || []) fn(ev); },
      },
      document: {
        getElementById: id => els[id] || null,
        querySelectorAll: () => [],
      },
      navigator: { vibrate: vi.fn() },
      requestAnimationFrame: fn => fn(),
      setTimeout,
      clearTimeout,
      RTCPeerConnection: function () {},
      RTCSessionDescription: function (x) { return x; },
      RTCIceCandidate: function (x) { return x; },
      SH: {
        registerGame: (_id, def) => { registered = def; },
        avatarSvg: () => '<svg></svg>',
      },
      state: { playerId: 'p1', name: 'Runner1', players: [{ playerId: 'p1', avatar: '⚡' }] },
      send: msg => wsSent.push(msg),
      showToast: vi.fn(),
      Math,
      Number,
      String,
      Boolean,
      JSON,
      Promise,
    };

    runInNewContext(runnerPhoneJs, context);
    registered.render({ phase: 'playing', players: ['p1'] });

    // Never registers deviceorientation or devicemotion
    expect(winListeners.deviceorientation).toBeUndefined();
    expect(winListeners.devicemotion).toBeUndefined();

    // Arrow buttons emit left, jump, right
    els.rnLeftBtn.trigger('pointerdown');
    els.rnJumpBtn.trigger('pointerdown');
    els.rnRightBtn.trigger('pointerdown');
    expect(wsSent.map(m => m.signal?.rnCmd)).toEqual(['left', 'jump', 'right']);

    // Keyboard arrow keys emit left, jump, right
    wsSent.length = 0;
    context.window.emit('keydown', { key: 'ArrowLeft', preventDefault: vi.fn() });
    context.window.emit('keydown', { key: 'ArrowUp', preventDefault: vi.fn() });
    context.window.emit('keydown', { key: 'ArrowRight', preventDefault: vi.fn() });
    expect(wsSent.map(m => m.signal?.rnCmd)).toEqual(['left', 'jump', 'right']);
  });
});

describe('Tilt-Ball auto-zero neutral grip', () => {
  it('auto-calibrates neutral holding angle on the first orientation event', () => {
    const winListeners = {};
    const els = {
      tiltBallSection: makeEl('tiltBallSection'),
      tbPad: makeEl('tbPad'),
      tbPadDot: makeEl('tbPadDot'),
      tbLinkPill: makeEl('tbLinkPill'),
      tbBoostBtn: makeEl('tbBoostBtn'),
      tbRoundPill: makeEl('tbRoundPill'),
      tbScorePill: makeEl('tbScorePill'),
      tbNextBtn: makeEl('tbNextBtn'),
      tbGyroBtn: makeEl('tbGyroBtn'),
    };
    const wsSent = [];
    let registered = null;
    let nowMs = 1000;

    const context = {
      window: {
        addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); },
        removeEventListener() {},
        emit(type, ev) { for (const fn of winListeners[type] || []) fn(ev); },
      },
      document: { getElementById: id => els[id] || null },
      navigator: { vibrate: vi.fn() },
      performance: { now: () => nowMs },
      Date: { now: () => nowMs },
      setInterval: () => 1,
      clearInterval: () => {},
      DeviceOrientationEvent: function () {},
      SH: { registerGame: (_id, def) => { registered = def; } },
      state: { playerId: 'p1' },
      send: msg => wsSent.push(msg),
      showToast: vi.fn(),
      tcNum: n => String(n),
      tcName: () => 'Bot',
      tcSetStatus: vi.fn(),
      Math,
      Number,
      String,
      Boolean,
      JSON,
      Promise,
    };

    runInNewContext(tiltBallPhoneJs, context);
    registered.render({ phase: 'playing', round: 1, maxRounds: 3, scores: { p1: 0 } });

    // First reading at natural 42° pitch, -6° roll auto-zeros to (0, 0)
    wsSent.length = 0;
    nowMs += 500;
    context.window.emit('deviceorientation', { beta: 42, gamma: -6 });
    const firstAction = wsSent.find(m => m.action?.type === 'setTilt')?.action;
    expect(firstAction).toEqual({ type: 'setTilt', x: 0, y: 0, boost: 0 });

    // Tilting +17.5° right from neutral yields x = 0.5
    wsSent.length = 0;
    nowMs += 500;
    context.window.emit('deviceorientation', { beta: 42, gamma: 11.5 });
    const secondAction = wsSent.find(m => m.action?.type === 'setTilt')?.action;
    expect(secondAction.x).toBeCloseTo(0.5, 2);
    expect(secondAction.y).toBeCloseTo(0, 2);
  });
});
