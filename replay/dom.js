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
    // Tailwind ships INLINE in the page from the Obsidian edition on, so
    // the loader now executes it here too. It watches the DOM to decide
    // what CSS to generate — which in a headless replay is nothing at
    // all, so these are honest no-ops rather than a fake implementation.
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false, addListener() {}, removeListener() {},
                         addEventListener() {}, removeEventListener() {} }),
    innerWidth: 480, innerHeight: 480, devicePixelRatio: 1,
    _fire(type) { for (const fn of listeners[type] || []) fn({ type }); },
  };
  win.window = win;
  win.self = win;
  win.globalThis = win;
  return win;
}

/* Every inline script the page runs, in order. */
function allScripts(html) {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

/* Just the ones that ARE the simulation.
 *
 * From the Obsidian edition on the page ships ~400KB of inlined Tailwind
 * plus a couple of presentation-only helpers (the author labels one of
 * them "Kept out of the replayed simulation"). None of it can move the
 * run: it draws no random numbers and touches no game state. It does
 * throw in a headless vm, so replaying it would only add a third-party
 * crash surface to every bounty verification.
 *
 * The rule is positive - keep whatever defines the engine - and falls
 * back to running everything if nothing matches, so a future restructure
 * fails loudly on a missing symbol rather than quietly replaying nothing.
 */
function gameScripts(html) {
  const all = allScripts(html);
  const sim = all.filter(s => s.includes('GameEngine'));
  return sim.length ? sim : all;
}

module.exports = { makeWindow, anyProxy, allScripts, gameScripts };
