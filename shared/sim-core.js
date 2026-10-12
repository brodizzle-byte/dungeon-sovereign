'use strict';
/**
 * Dungeon Sovereign v7.0 — Shared Agnostic Simulation & Math Core
 *
 * Provides bit-identical portable math, fixed-point quantization,
 * seeded PRNG (mulberry32), state hashing (fnv1a), and collision/kinematics.
 * Shared between client (bridge.js), relay (gladiator.js), and headless harness.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SimCore = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const PI = Math.PI, TWO_PI = 2 * Math.PI, HALF_PI = Math.PI / 2;
  const LN2 = 0.6931471805599453;

  function reduceSin(x) {
    x = x - Math.floor((x + PI) / TWO_PI) * TWO_PI;
    if (x > HALF_PI) x = PI - x; else if (x < -HALF_PI) x = -PI - x;
    return x;
  }

  function pSin(x) {
    x = +x;
    if (x !== x || x === Infinity || x === -Infinity) return NaN;
    x = reduceSin(x);
    const x2 = x * x;
    let term = x, sum = x;
    for (let i = 1; i <= 9; i++) { term *= -x2 / ((2 * i) * (2 * i + 1)); sum += term; }
    return sum;
  }

  function pCos(x) {
    x = +x;
    if (x !== x || x === Infinity || x === -Infinity) return NaN;
    return pSin(HALF_PI - x);
  }

  function pAtan(x) {
    let neg = false, inv = false;
    if (x < 0) { x = -x; neg = true; }
    if (x > 1) { x = 1 / x; inv = true; }
    x = x / (1 + Math.sqrt(1 + x * x));
    x = x / (1 + Math.sqrt(1 + x * x));
    const x2 = x * x;
    let term = x, sum = x;
    for (let i = 1; i <= 7; i++) { term *= -x2; sum += term / (2 * i + 1); }
    let r = 4 * sum;
    if (inv) r = HALF_PI - r;
    return neg ? -r : r;
  }

  function pAtan2(y, x) {
    y = +y; x = +x;
    if (y !== y || x !== x) return NaN;
    if (x > 0) return pAtan(y / x);
    if (x < 0) return (y >= 0 && !(y === 0 && 1 / y < 0)) ? pAtan(y / x) + PI : pAtan(y / x) - PI;
    if (y > 0) return HALF_PI;
    if (y < 0) return -HALF_PI;
    if (1 / x < 0) return (1 / y < 0) ? -PI : PI;
    return (1 / y < 0) ? -0 : 0;
  }

  function pHypot() {
    let s = 0;
    for (let i = 0; i < arguments.length; i++) { const v = +arguments[i]; s += v * v; }
    return Math.sqrt(s);
  }

  function pExp(x) {
    x = +x;
    if (x !== x) return NaN;
    if (x > 709.7) return Infinity;
    if (x < -745.2) return 0;
    let k = Math.round(x / LN2);
    const r = x - k * LN2;
    let term = 1, sum = 1;
    for (let i = 1; i <= 14; i++) { term *= r / i; sum += term; }
    while (k > 0) { sum *= 2; k--; }
    while (k < 0) { sum /= 2; k++; }
    return sum;
  }

  function pLog(x) {
    x = +x;
    if (x !== x || x < 0) return NaN;
    if (x === 0) return -Infinity;
    if (x === Infinity) return Infinity;
    let k = 0;
    while (x >= 2) { x /= 2; k++; }
    while (x < 1) { x *= 2; k--; }
    const t = (x - 1) / (x + 1), t2 = t * t;
    let term = t, sum = t;
    for (let i = 1; i <= 12; i++) { term *= t2; sum += term / (2 * i + 1); }
    return 2 * sum + k * LN2;
  }

  function pPow(a, b) {
    a = +a; b = +b;
    if (b === 0) return 1;
    if (a !== a || b !== b) return NaN;
    if (b === Math.floor(b) && Math.abs(b) <= 64) {
      let n = Math.abs(b), r = 1, base = a;
      while (n > 0) { if (n & 1) r *= base; base *= base; n = Math.floor(n / 2); }
      return b < 0 ? 1 / r : r;
    }
    if (a < 0) return NaN;
    return pExp(b * pLog(a));
  }

  // Mulberry32 deterministic PRNG
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // FNV-1a 32-bit state hashing
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  // Fixed-point / quantization helpers
  const fin = v => (Number.isFinite(v) ? v : 0);
  const q2 = v => fin(Math.round(v * 2) / 2);            // half-pixel
  const q256 = v => fin(Math.round(v * 256) / 256);      // joystick vector
  const q1024 = v => fin(Math.round(v * 1024) / 1024);   // touch facing

  // Fixed-point vector normalization with portable math
  function normalizeVector(x, y) {
    const len = pHypot(x, y);
    if (len < 0.0001) return { x: 0, y: 0, len: 0 };
    return { x: q1024(x / len), y: q1024(y / len), len };
  }

  // Pure kinematics & collision resolution
  function stepKnockbackEntity(e, dt, isWallFn) {
    if (!e.kx && !e.ky) return;
    const decay = pExp(-10 * dt);
    const nx = e.x + e.kx * dt;
    const ny = e.y + e.ky * dt;
    e.kx *= decay;
    e.ky *= decay;
    if (Math.abs(e.kx) < 1) e.kx = 0;
    if (Math.abs(e.ky) < 1) e.ky = 0;
    if (isWallFn) {
      if (!isWallFn(nx, e.y)) e.x = nx; else e.kx = 0;
      if (!isWallFn(e.x, ny)) e.y = ny; else e.ky = 0;
    } else {
      e.x = nx;
      e.y = ny;
    }
  }

  return {
    PI, TWO_PI, HALF_PI,
    pSin, pCos, pAtan, pAtan2, pHypot, pExp, pLog, pPow,
    mulberry32, fnv1a,
    fin, q2, q256, q1024,
    normalizeVector,
    stepKnockbackEntity,
  };
});
