'use strict';
/* A permissive fake browser for replaying Dungeon Sovereign headless.
 * Every DOM/canvas call the game makes lands on a Proxy that accepts
 * anything and returns more of itself; nothing it returns feeds the
 * simulation (the sim reads only its own state), so this is safe. */

function anyProxy() {
  const target = function () {};
  const p = new Proxy(target, {
    get(t, prop) {
      if (prop === Symbol.toPrimitive) return () => '';
      if (prop === 'then') return undefined;            // never thenable
      if (prop === 'toString') return () => '';
      if (prop === 'valueOf') return () => 0;
      if (prop === 'length') return 0;
      if (typeof prop === 'symbol') return undefined;
      return p;
    },
    set() { return true; },
    has() { return true; },
    apply() { return p; },
    construct() { return p; },
    deleteProperty() { return true; },
  });
  return p;
}

function makeWindow() {
  const el = anyProxy();
  const listeners = {};
  const storage = new Map();
  const win = {
    JB_MODE: 'replay',
    tailwind: {},
    AudioContext: undefined, webkitAudioContext: undefined,
    document: {
      getElementById: () => el,
      querySelector: () => el,
      querySelectorAll: () => el,
      createElement: () => el,
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      removeEventListener() {},
      body: el, head: el, documentElement: el, readyState: 'complete',
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    requestAnimationFrame() { return 0; },
    cancelAnimationFrame() {},
    setTimeout() { return 0; },                    // replaced by the bridge's virtual timers during a run
    clearTimeout() {},
    setInterval() { return 0; },
    clearInterval() {},
    performance: { now: () => 0 },
    navigator: { vibrate() { return false; }, userAgent: 'jb-replay' },
    localStorage: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => { storage.set(k, String(v)); },
      removeItem: k => { storage.delete(k); },
    },
    console: { log() {}, warn() {}, error() {}, info() {} },
    innerWidth: 480, innerHeight: 480, devicePixelRatio: 1,
    _fire(type) { for (const fn of listeners[type] || []) fn({ type }); },
  };
  win.window = win;
  win.self = win;
  win.globalThis = win;
  return win;
}

module.exports = { makeWindow, anyProxy };
