/* JuiceBox bridge for Dungeon Sovereign.
 *
 * The member's game (game.html) is served untouched. This file loads
 * after it and patches GameEngine.prototype from the outside so a run is
 * DETERMINISTIC: seeded randomness, portable math, a fixed 60 Hz tick,
 * tick-scheduled timers, and input applied only at tick boundaries and
 * written to a log. The same file runs headless in Node (replay/run.js,
 * window.JB_MODE = 'replay') to re-simulate a log the browser sent —
 * that replay, not the browser's word, decides whether a bounty is paid.
 *
 * Nothing here touches sips directly: api.php debits entry/refills
 * before the game gets anything, and the bot pays bounties only after
 * the replay agrees with the claimed result.
 */
(function () {
  'use strict';
  const root = (typeof window !== 'undefined') ? window : globalThis;
  const MODE = root.JB_MODE || 'play';
  const IS_PLAY = MODE === 'play';
  const CFG = root.JB_CFG || {};
  const DT = 1 / 60;
  const CHECK_EVERY = root.JB_CHECK_EVERY || 600;   // one checkpoint hash every 10 s of sim
  const DEBUG_STATE = !!root.JB_DEBUG_STATE;         // keep the raw state string per checkpoint
  const TRACE = root.JB_TRACE_TICKS || null;         // [from, to]: record every random() call site
  const MAX_STEPS_PER_FRAME = 4;    // a stalled tab slows the sim, never skips it
  // Bumped whenever the engine's simulation changes shape. A payload
  // recorded under a different number cannot be replayed by this one,
  // and the bot refuses to judge it rather than calling it a cheat.
  //   1  the author's v6.5 engine
  //   2  v7: real knockback, telegraphed enemy attacks, the attack chain
  const VERSION = 2;

  /* ───────────────────────── portable math ─────────────────────────
   * +,-,*,/ and sqrt are correctly rounded on every engine; sin/cos/
   * atan2/exp/pow/hypot are NOT guaranteed bit-identical between V8
   * (Chrome, Node) and JavaScriptCore (Safari/iPhone). A chaotic sim
   * amplifies one ulp into a different outcome, so the game gets these
   * pure-JS versions in the browser and in the replay alike. */
  const PI = Math.PI, TWO_PI = 2 * Math.PI, HALF_PI = Math.PI / 2;
  const LN2 = 0.6931471805599453;
  const nativeRandom = Math.random;

  function reduceSin(x) {
    x = x - Math.floor((x + PI) / TWO_PI) * TWO_PI;       // (-π, π]
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
  function pCos(x) { x = +x; if (x !== x || x === Infinity || x === -Infinity) return NaN; return pSin(HALF_PI - x); }
  function pAtan(x) {
    let neg = false, inv = false;
    if (x < 0) { x = -x; neg = true; }
    if (x > 1) { x = 1 / x; inv = true; }
    x = x / (1 + Math.sqrt(1 + x * x));                    // atan(x) = 2·atan(...)
    x = x / (1 + Math.sqrt(1 + x * x));                    // twice → |x| ≤ tan(π/16)
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
    // ln(x) = 2·atanh((x-1)/(x+1)), x in [1,2)
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
  function installMath() {
    Math.sin = pSin; Math.cos = pCos; Math.atan2 = pAtan2; Math.atan = pAtan;
    Math.hypot = pHypot; Math.exp = pExp; Math.pow = pPow; Math.log = pLog;
  }
  installMath();

  // mulberry32: integer arithmetic only → the same stream everywhere
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }
  // quantised AND finite: a zero-size canvas rect can hand the game NaN
  // coordinates, and JSON turns NaN into null — the sim must never see
  // a number the log can't carry
  const fin = v => (Number.isFinite(v) ? v : 0);
  const q2 = v => fin(Math.round(v * 2) / 2);            // mouse: half-pixel
  const q256 = v => fin(Math.round(v * 256) / 256);      // joystick vector
  const q1024 = v => fin(Math.round(v * 1024) / 1024);   // touch facing

  /* ───────────────────────── run state ───────────────────────── */
  const run = {
    active: false, granted: null, id: null, seed: 0, mode: null, loadout: null,
    tick: 0, log: [], checkpoints: [], rng: null, rngCalls: 0,
    refillsLeft: 0, refillsUsed: 0, ended: null, timers: [], timerSeq: 0,
  };
  let pending = [];          // actions queued by events, applied at the next tick
  let inTick = false;
  let cosmetic = 0;          // >0 while rendering / making noise: draws come from the native RNG

  // The game's own `Math.random(` calls are rewritten to `JB.rng(` at
  // serve time (index.php) and in the replay loader — so ONLY the game
  // draws from the seeded stream. The Tailwind CDN runtime, browser
  // extensions and this bridge's UI keep the native Math.random, which
  // is exactly what broke bit-for-bit replay before this existed.
  function rng() {
    if (!run.active || cosmetic > 0 || !run.rng) return nativeRandom();
    run.rngCalls++;
    if (TRACE && run.tick >= TRACE[0] && run.tick <= TRACE[1]) {
      const st = (new Error().stack || '').split(String.fromCharCode(10));
      const line = (st[2] || '').trim();
      const cut = Math.max(line.lastIndexOf('/'), line.lastIndexOf(String.fromCharCode(92)));
      run.trace.push(run.tick + ' ' + (cut >= 0 ? line.slice(0, line.indexOf('(') + 1) + line.slice(cut + 1) : line));
    }
    return run.rng();
  }
  let acc = 0;
  let last = { k: -1, m: null, t: null, f: null };
  let lastPayload = null;

  function resetRun() {
    run.active = false; run.id = null; run.seed = 0; run.mode = null; run.loadout = null;
    run.tick = 0; run.log = []; run.checkpoints = []; run.rng = null; run.rngCalls = 0;
    run.refillsLeft = 0; run.refillsUsed = 0; run.ended = null; run.timers = []; run.timerSeq = 0;
    pending = []; acc = 0; last = { k: -1, m: null, t: null, f: null };
  }

  /* ───────────────────────── virtual timers ─────────────────────────
   * While a run is live, setTimeout schedules on the tick clock. The
   * floor-transition timer (1800 ms → 108 ticks) becomes reproducible;
   * audio timeouts ride along. Restored — and flushed to real time — on
   * run end, so the victory jingle still plays. */
  const realSetTimeout = root.setTimeout, realClearTimeout = root.clearTimeout;
  function vSetTimeout(fn, ms) {
    const args = Array.prototype.slice.call(arguments, 2);
    const id = ++run.timerSeq;
    const at = run.tick + Math.max(1, Math.ceil(((+ms) || 0) * 60 / 1000));
    run.timers.push({ id, at, fn, args });
    return id;
  }
  function vClearTimeout(id) { run.timers = run.timers.filter(t => t.id !== id); }
  function fireTimers(tick) {
    if (!run.timers.length) return;
    const due = run.timers.filter(t => t.at <= tick).sort((a, b) => a.at - b.at || a.id - b.id);
    if (!due.length) return;
    run.timers = run.timers.filter(t => t.at > tick);
    for (const t of due) { try { t.fn.apply(null, t.args); } catch (e) { warn('timer', e); } }
  }
  function installTimers() { root.setTimeout = vSetTimeout; root.clearTimeout = vClearTimeout; }
  function restoreTimers() {
    if (!IS_PLAY) { run.timers = []; return; }
    root.setTimeout = realSetTimeout; root.clearTimeout = realClearTimeout;
    const left = run.timers; run.timers = [];
    for (const t of left) realSetTimeout(() => { try { t.fn.apply(null, t.args); } catch (e) {} },
                                        Math.max(0, (t.at - run.tick)) * 1000 / 60);
  }

  function warn() { try { (root.console || console).warn.apply(null, ['[JB]'].concat(Array.prototype.slice.call(arguments))); } catch (e) {} }

  /* ───────────────────────── engine patches ───────────────────────── */
  const P = GameEngine.prototype;
  const O = {};
  ['loop', 'startStoryMode', 'startArenaMatchmaking', 'startArenaBattleRoyale',
   'playerAttack', 'playerSkill', 'playerDodge', 'playerSip',
   'triggerVictory', 'triggerGameOver', 'setState', 'render'].forEach(n => { O[n] = P[n]; });

  // render() only touches cosmetics (particles, floating text, the canvas)
  // but it does roll Math.random — keep that off the sim stream so the
  // replay can skip drawing entirely and still count the same draws.
  P.render = function () {
    cosmetic++;
    try { return O.render.apply(this, arguments); } finally { cosmetic--; }
  };

  // audio noise must not eat the sim's random stream (buffer length
  // depends on the device's sample rate)
  if (typeof ProceduralAudio !== 'undefined') {
    const oNoise = ProceduralAudio.prototype.playNoise;
    ProceduralAudio.prototype.playNoise = function () {
      cosmetic++;
      try { return oNoise.apply(this, arguments); } finally { cosmetic--; }
    };
  }

  // the game's Hall of Fame tab reads localStorage seeds; give it the
  // club's weekly leaderboard (verified runs only) instead
  if (typeof TelemetryManager !== 'undefined' && IS_PLAY) {
    const oHof = TelemetryManager.prototype.getHallOfFame;
    TelemetryManager.prototype.getHallOfFame = function () {
      const top = (CFG.hof && CFG.hof.top) || [];
      if (!top.length) return CFG.practice ? oHof.apply(this, arguments) : [];
      return top.map(e => ({ name: e.name, date: e.date, mode: e.mode, class: e.class,
                             result: e.result, score: e.score, kills: e.kills, cause: e.cause }));
    };
    TelemetryManager.prototype.saveHoFEntry = function () {};   // the server keeps the real one
  }

  function captureLoadout(g) {
    return { c: g.selectedClassId, w: g.selectedWeaponId, s: g.selectedSkinId, p: g.selectedPerk,
             a: g.selectedAccessory, k: g.selectedCapeStyle, col: Object.assign({}, g.customColors) };
  }
  function applyLoadout(g, L) {
    g.selectedClassId = L.c; g.selectedWeaponId = L.w; g.selectedSkinId = L.s; g.selectedPerk = L.p;
    g.selectedAccessory = L.a; g.selectedCapeStyle = L.k; g.customColors = Object.assign({}, L.col);
  }

  function beginRun(g, mode) {
    const gr = run.granted; run.granted = null;
    resetRun();
    run.seed = (gr && gr.seed) >>> 0; run.id = gr ? gr.id : null; run.mode = mode;
    run.refillsLeft = gr ? (gr.refills_left | 0) : 0;
    run.loadout = captureLoadout(g);
    run.rng = mulberry32(run.seed);
    run.trace = [];
    // The replay simulates on a FRESH GameEngine; a browser that has already
    // played a run on this page carries these over (the author's start
    // methods don't reset them) and frameCount feeds enemy AI timing.
    // "Play Again" must look exactly like a first run.
    g.frameCount = 0; g.animTime = 0; g.currentFloor = 1;
    g.isTransitioningFloor = false; g.hitStopTimer = 0; g.screenShake = 0;
    g.spawnGraceTimer = 0; g.previewFlourishTimer = 0;
    g.cam = { x: 0, y: 0 }; g.floatingTexts = [];
    g.enemies = []; g.pendingEnemies = []; g.projectiles = []; g.shockwaves = [];
    g.hazardPuddles = []; g.particles = []; g.bloodDecals = []; g.weaponSwings = [];
    g.spawnBeacons = []; g.activeBoss = null;
    g.stormRadius = 450; g.stormCenter = { x: 512, y: 512 }; g.stormTimer = 30;
    g.totalArenaCompetitors = 50; g.gladiatorsAlive = 50; g.queuedGladiators = 30; g.reinforcementTimer = 0;
    installTimers();
    run.active = true;
    if (IS_PLAY) ui.onRunStart();
  }

  function endRun(g, status) {
    if (!run.active) return;
    run.active = false;
    const rs = g.runStats || {};
    run.ended = { status, floor: g.currentFloor | 0, kills: rs.kills | 0, gold: rs.gold | 0,
                  score: rs.score | 0, tick: run.tick, mode: run.mode, hash: fnv1a(stateString(g)) };
    restoreTimers();
    lastPayload = {
      v: VERSION, run_id: run.id, seed: run.seed, mode: run.mode, loadout: run.loadout,
      log: run.log, checkpoints: run.checkpoints, refills_used: run.refillsUsed,
      rng_calls: run.rngCalls, claimed: run.ended,
    };
    if (IS_PLAY) ui.onRunEnd(status, lastPayload);
  }

  // ── start gating ──
  P.startStoryMode = function () {
    if (IS_PLAY && !run.granted) { ui.requestStart(this, 'story'); return; }
    beginRun(this, 'story');
    return O.startStoryMode.apply(this, arguments);
  };
  P.startArenaMatchmaking = function () {
    if (IS_PLAY && !run.granted) { ui.requestStart(this, 'arena'); return; }
    return O.startArenaMatchmaking.apply(this, arguments);   // fake lobby, real timers
  };
  P.startArenaBattleRoyale = function () {
    if (!run.granted && IS_PLAY) { ui.requestStart(this, 'arena'); return; }
    beginRun(this, 'arena');
    return O.startArenaBattleRoyale.apply(this, arguments);
  };

  // ── actions: events enqueue, the tick applies ──
  const ACTION = { playerAttack: 'a', playerSkill: 's', playerDodge: 'd', playerSip: 'h' };
  Object.keys(ACTION).forEach(name => {
    P[name] = function () {
      if (inTick) return O[name].apply(this, arguments);
      if (this.state !== STATES.PLAYING) return;
      if (name === 'playerSip' && this.player && this.player.sips <= 0) {
        if (IS_PLAY) ui.offerRefill(this);
        return;
      }
      pending.push(ACTION[name]);
    };
  });
  // Queue on the acting seat; applySeatActions drains them in seat order.
  // Solo (one seat) keeps the original immediate path, so nothing about a
  // bounty run changes.
  function applyAction(g, code) {
    if (g.players && g.players.length > 1 && g.player) {
      (g.player.pendingActions || (g.player.pendingActions = [])).push(code);
      return;
    }
    rawAction(g, code);
  }

  /* Every seat's queued actions, applied in SEAT order on every machine.
   * The order is the whole point: an attack resolves damage as it is
   * applied, so two clients that disagree about who swung first have
   * already desynced by the end of the tick. */
  function applySeatActions(g) {
    const sp = g.player, sk = g.keys, sm = g.mousePos, st = g.touchMovement;
    for (let i = 0; i < g.players.length; i++) {
      const p = g.players[i];
      if (!p || !p.pendingActions || !p.pendingActions.length) continue;
      g.player = p;
      const inp = (i === g.mySeat) ? null : p.input;
      g.keys = inp ? inp.keys : sk;
      g.mousePos = inp ? inp.mousePos : sm;
      g.touchMovement = inp ? inp.touchMovement : st;
      const q = p.pendingActions;
      p.pendingActions = [];
      for (let j = 0; j < q.length; j++) rawAction(g, q[j]);
    }
    g.player = sp; g.keys = sk; g.mousePos = sm; g.touchMovement = st;
  }

  function rawAction(g, code) {
    switch (code) {
      case 'a': O.playerAttack.call(g); break;
      case 's': O.playerSkill.call(g); break;
      case 'd': O.playerDodge.call(g); break;
      case 'h': O.playerSip.call(g); break;
      case 'r':                                   // server-granted refill: +1 sip, drink it
        run.refillsUsed++;
        if (g.player) { g.player.sips += 1; O.playerSip.call(g); }
        break;
    }
  }

  // ── run end ──
  P.triggerVictory = function () {
    const r = O.triggerVictory.apply(this, arguments);
    endRun(this, 'CLEARED');
    return r;
  };
  P.triggerGameOver = function () {
    const r = O.triggerGameOver.apply(this, arguments);
    endRun(this, 'FAILED');
    return r;
  };
  P.setState = function (s) {
    if (run.active && s === STATES.MAIN_MENU) endRun(this, 'ABANDONED');
    return O.setState.apply(this, arguments);
  };

  /* ───────────────────────── the tick ───────────────────────── */
  function captureInput(g) {
    const K = g.keys || {};
    const k = ((K['w'] || K['arrowup']) ? 1 : 0) | ((K['s'] || K['arrowdown']) ? 2 : 0)
            | ((K['a'] || K['arrowleft']) ? 4 : 0) | ((K['d'] || K['arrowright']) ? 8 : 0);
    const m = [q2(g.mousePos.x), q2(g.mousePos.y)];
    const T = g.touchMovement;
    const t = [T.active ? 1 : 0, q256(T.x), q256(T.y)];
    const F = g.player && g.player.facing;
    const fNow = F ? [F.x, F.y] : null;
    const fChanged = (fNow === null) !== (last.f === null) || (fNow && (fNow[0] !== last.f[0] || fNow[1] !== last.f[1]));
    const e = {};
    if (k !== last.k) e.k = k;
    if (!last.m || m[0] !== last.m[0] || m[1] !== last.m[1]) e.m = m;
    if (!last.t || t[0] !== last.t[0] || t[1] !== last.t[1] || t[2] !== last.t[2]) e.t = t;
    if (fChanged && fNow) e.f = [q1024(fNow[0]), q1024(fNow[1])];
    if (pending.length) e.a = pending.splice(0);
    // the live sim always runs on exactly the numbers the log carries —
    // even when nothing changed (a NaN that quantises to the same value
    // as last tick would otherwise stay NaN in the browser only)
    e._full = { k, m, t, f: e.f || null };
    return e;
  }
  function applyInput(g, e) {
    if (!e) return;
    if (e.k !== undefined) {
      const k = e.k;
      // the browser's keys object is the source of truth (arrow keys and
      // wasd both live in it); only the replay has to reconstruct it
      if (!IS_PLAY) g.keys = { w: !!(k & 1), s: !!(k & 2), a: !!(k & 4), d: !!(k & 8) };
      last.k = k;
    }
    if (e.m) { g.mousePos.x = e.m[0]; g.mousePos.y = e.m[1]; last.m = e.m; }
    if (e.t) { g.touchMovement.active = !!e.t[0]; g.touchMovement.x = e.t[1]; g.touchMovement.y = e.t[2]; last.t = e.t; }
    if (e.f && g.player) { g.player.facing = { x: e.f[0], y: e.f[1] }; g.player.facingAngle = pAtan2(e.f[1], e.f[0]); }
  }
  function stateString(g) {
    const p = g.player || {};
    const rs = g.runStats || {};
    let alive = 0;
    for (const en of g.enemies || []) if (!en.dead) alive++;
    return [run.tick, p.hp, p.x, p.y, p.sips, rs.kills, rs.gold, g.currentFloor, alive,
            g.frameCount, run.rngCalls, g.animTime].join('|');
  }
  function checkpoint(g) {
    const st = stateString(g);
    run.checkpoints.push(DEBUG_STATE ? [run.tick, fnv1a(st), st] : [run.tick, fnv1a(st)]);
  }
  function tick(g, entry) {
    run.tick++;
    inTick = true;
    try {
      fireTimers(run.tick);
      if (run.ended) return;
      let e;
      if (IS_PLAY) {
        e = captureInput(g);
        if (e.k !== undefined || e.m || e.t || e.f || e.a) { e.i = run.tick; run.log.push(e); }
      } else {
        e = entry;
      }
      if (IS_PLAY) {
        // quantise the live state so browser and replay simulate identical numbers
        const full = e._full; delete e._full;
        applyInput(g, { k: full.k, m: full.m, t: full.t, f: full.f });
        if (e.a) for (const a of e.a) applyAction(g, a);
      } else if (e) {
        applyInput(g, e);
        if (e.a) for (const a of e.a) applyAction(g, a);
      }
      // Online: the local queue above and every remote seat's queue (filled
      // by net.js before this tick) are drained together, in seat order.
      if (g.players && g.players.length > 1) applySeatActions(g);
      const F = g.player && g.player.facing;
      last.f = F ? [F.x, F.y] : null;
      g.animTime += DT;
      g.frameCount++;
      if (g.hitStopTimer > 0) g.hitStopTimer -= DT; else g.update(DT);
      if (IS_PLAY) g.render(DT);           // cosmetic only; the replay skips it
      const F2 = g.player && g.player.facing;
      last.f = F2 ? [F2.x, F2.y] : null;
      if (run.tick % CHECK_EVERY === 0) checkpoint(g);
    } finally {
      inTick = false;
    }
  }

  // fixed-timestep loop (browser only; the replay drives tick() itself)
  P.loop = function () {
    if (!IS_PLAY) return;
    const now = performance.now();
    const real = Math.min(0.1, Math.max(0, (now - this.lastTime) / 1000));
    this.lastTime = now;
    if (this.previewFlourishTimer > 0) this.previewFlourishTimer -= real;
    if (this.state === STATES.PLAYING) {
      if (run.active) {
        acc += real;
        let n = 0;
        while (acc >= DT && n < MAX_STEPS_PER_FRAME && this.state === STATES.PLAYING) { acc -= DT; n++; tick(this); }
        if (n === MAX_STEPS_PER_FRAME) acc = 0;
      } else {
        // no run bookkeeping (should not happen: every PLAYING state is a run)
        this.animTime += real; this.frameCount++;
        if (this.hitStopTimer > 0) this.hitStopTimer -= real; else this.update(real);
        this.render(real);
      }
    } else if (this.state === STATES.CHAR_SELECT) {
      this.updateCharPreview();
    }
    if (this.loopRunning) requestAnimationFrame(() => this.loop());
  };

  /* ───────────────────────── replay driver ───────────────────────── */
  function replay(payload, opts) {
    opts = opts || {};
    const g = (typeof game !== 'undefined') ? game : null;
    if (!g) throw new Error('game not constructed');
    const maxTicks = opts.maxTicks || 216000;
    const refillsAllowed = (opts.refillsAllowed === undefined) ? Infinity : opts.refillsAllowed;
    applyLoadout(g, payload.loadout);
    run.granted = { seed: payload.seed, id: payload.run_id, refills_left: 0 };
    if (payload.mode === 'arena') g.startArenaBattleRoyale(); else g.startStoryMode();
    const entries = payload.log || [];
    const cps = payload.checkpoints || [];
    const claimedTick = (payload.claimed && payload.claimed.tick) | 0;
    let ci = 0, cpi = 0;
    while (!run.ended && run.tick < claimedTick) {
      const next = run.tick + 1;
      let e = null;
      while (ci < entries.length && entries[ci].i < next) ci++;      // tolerate junk ordering
      if (ci < entries.length && entries[ci].i === next) e = entries[ci++];
      tick(g, e);
      if (run.refillsUsed > refillsAllowed) {
        return { status: 'CHEAT', reason: 'more refills than paid', first_bad_tick: run.tick, ticks: run.tick };
      }
      if (next % CHECK_EVERY === 0) {
        const mine = run.checkpoints[run.checkpoints.length - 1];
        const theirs = cps[cpi++];
        if (theirs && (theirs[0] !== mine[0] || theirs[1] !== mine[1])) {   // the final hash still gates a log without checkpoints
          return { status: 'DIVERGED', first_bad_tick: next, mine, theirs: theirs || null, ticks: run.tick,
                   rng_calls: run.rngCalls, prev_mine: run.checkpoints[run.checkpoints.length - 2] || null,
                   prev_theirs: cps[cpi - 2] || null, trace: TRACE ? run.trace : undefined };
        }
      }
      if (run.tick > maxTicks) return { status: 'TIMEOUT', ticks: run.tick };
    }
    if (!run.ended) return { status: 'NO_END', ticks: run.tick, rng_calls: run.rngCalls,
                             floor: g.currentFloor | 0, kills: (g.runStats || {}).kills | 0,
                             hash: fnv1a(stateString(g)), state: stateString(g) };
    return Object.assign({ ticks: run.tick, refills_used: run.refillsUsed, rng_calls: run.rngCalls,
                           checkpoints: run.checkpoints.length, trace: TRACE ? run.trace : undefined }, run.ended);
  }

  /* ───────────────────────── browser UI ───────────────────────── */
  const ui = {
    busy: false, chip: null, toast: null,
    api(op, params) {
      const body = new URLSearchParams(Object.assign({ op }, params || {}));
      return fetch((CFG.api || 'api.php'), { method: 'POST', body, credentials: 'same-origin' })
        .then(r => r.json());
    },
    el(id) { return document.getElementById(id); },
    say(html, ms) {
      if (!this.toast) {
        this.toast = document.createElement('div');
        this.toast.id = 'jb-toast';
        this.toast.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:9999;'
          + 'background:#0f172a;border:2px solid #7C3AED;color:#e2e8f0;padding:10px 16px;border-radius:14px;'
          + 'font:700 12px/1.4 "JetBrains Mono",monospace;box-shadow:0 10px 30px rgba(0,0,0,.6);max-width:92vw;text-align:center';
        document.body.appendChild(this.toast);
      }
      this.toast.innerHTML = html; this.toast.style.display = 'block';
      realClearTimeout(this._sayT);
      if (ms) this._sayT = realSetTimeout(() => { this.toast.style.display = 'none'; }, ms);
    },
    setBalance(n) {
      if (typeof n !== 'number') return;
      CFG.balance = n;
      if (this.chip) this.chip.querySelector('b').textContent = n.toLocaleString();
    },
    mount() {
      const header = document.querySelector('header');
      if (header && !CFG.practice) {
        this.chip = document.createElement('div');
        this.chip.id = 'jb-chip';
        this.chip.style.cssText = 'margin-left:8px;padding:3px 10px;border:1px solid #7C3AED;border-radius:999px;'
          + 'font:800 11px "JetBrains Mono",monospace;color:#e9d5ff;background:rgba(124,58,237,.15);white-space:nowrap';
        this.chip.innerHTML = '🧃 <b>' + (CFG.balance | 0).toLocaleString() + '</b>';
        header.appendChild(this.chip);
      }
      const btn = this.el('btn-launch-run');
      if (btn) btn.textContent = CFG.practice
        ? 'LAUNCH — PRACTICE (nothing at stake)'
        : 'LAUNCH — ' + (CFG.prices.entry | 0) + ' 🧃';
      if (CFG.practice) this.say('👀 practice mode — free runs, no sips, no bounties', 5000);
    },
    requestStart(g, mode) {
      if (this.busy) return;
      if (CFG.practice) {
        run.granted = { seed: Math.floor(nativeRandom() * 4294967296), id: null, refills_left: 0 };
        if (mode === 'arena') g.startArenaMatchmaking(); else g.startStoryMode();
        return;
      }
      this.busy = true;
      this.say('🧃 paying ' + (CFG.prices.entry | 0) + ' sips for the run…');
      this.api('start', { mode }).then(r => {
        this.busy = false;
        if (!r.ok) { this.say('❌ ' + (r.msg || 'could not start'), 5000); return; }
        this.setBalance(r.balance);
        run.granted = { seed: r.seed, id: r.run_id, refills_left: r.refills_left };
        this.say('▶️ run ' + r.run_id + ' — good luck', 2500);
        if (mode === 'arena') g.startArenaMatchmaking(); else g.startStoryMode();
      }).catch(e => { this.busy = false; this.say('❌ network error — try again', 5000); });
    },
    offerRefill(g) {
      if (CFG.practice) { this.say('🧪 out of sips — practice runs have no refills', 2500); return; }
      if (!run.active || !run.id) return;
      if (run.refillsLeft <= 0) { this.say('🧪 out of sips — no refills left this run', 2500); return; }
      if (this.buying) return;
      this.buying = true;
      const price = CFG.prices.refill | 0;
      this.say('🧪 out of sips — <b>buy one for ' + price + ' 🧃</b>? (' + run.refillsLeft + ' left) '
        + '<button id="jb-buy" style="margin-left:8px;padding:4px 10px;border-radius:8px;background:#7C3AED;color:#fff;border:0;font:800 11px monospace">BUY</button>'
        + '<button id="jb-no" style="margin-left:6px;padding:4px 10px;border-radius:8px;background:#334155;color:#fff;border:0;font:800 11px monospace">NO</button>');
      const done = () => { this.buying = false; this.toast.style.display = 'none'; };
      this.el('jb-no').onclick = done;
      this.el('jb-buy').onclick = () => {
        this.el('jb-buy').disabled = true;
        this.api('refill', { run_id: run.id }).then(r => {
          if (!r.ok) { this.say('❌ ' + (r.msg || 'no refill'), 4000); this.buying = false; return; }
          this.setBalance(r.balance);
          run.refillsLeft = r.refills_left | 0;
          if (run.active) pending.push('r');
          this.say('🧪 sip bought — drink up (' + run.refillsLeft + ' refills left)', 2500);
          this.buying = false;
        }).catch(() => { this.say('❌ network error', 4000); this.buying = false; });
      };
    },
    onRunStart() { this.buying = false; },
    onRunEnd(status, payload) {
      if (CFG.practice || !payload.run_id) return;
      const id = payload.run_id;
      if (status === 'ABANDONED') {
        this.api('abandon', { run_id: id }).then(r => { if (r && r.ok) this.setBalance(r.balance); }).catch(() => {});
        return;
      }
      this.say('📼 sending your run for verification…');
      const json = JSON.stringify(payload);
      gzipBytes(json).then(bytes => fetch((CFG.api || 'api.php') + '?op=finish&run_id=' + encodeURIComponent(id), {
        method: 'POST', body: bytes, credentials: 'same-origin',
        headers: { 'Content-Type': 'application/octet-stream' },
      })).then(r => r.json()).then(r => {
        if (!r.ok) { this.say('❌ ' + (r.msg || 'upload failed'), 6000); return; }
        this.say('🔎 verifying your run on the server… (bounties pay after the replay agrees)');
        this.pollVerdict(id, 0);
      }).catch(() => this.say('❌ upload failed — the run is not verified', 6000));
    },
    pollVerdict(id, n) {
      realSetTimeout(() => {
        this.api('state', {}).then(s => {
          const lr = s && s.last_run;
          if (lr && lr.id === id && lr.status && lr.status !== 'pending') {
            this.setBalance(s.balance);
            let msg;
            if (lr.bounty > 0) msg = '✅ verified — <b>+' + lr.bounty + ' 🧃</b> bounty paid';
            else if (lr.status === 'verified') msg = '✅ verified — ' + (lr.note || 'no bounty this time');
            else if (lr.status === 'cheat') msg = '🚫 run rejected: ' + (lr.note || '');
            else msg = '⚠️ could not verify this run (' + (lr.note || lr.status) + ') — no bounty';
            this.say(msg, 9000);
            if (s.hof) CFG.hof = { top: s.hof, week: s.week };
            return;
          }
          if (n < 30) this.pollVerdict(id, n + 1);
          else this.say('⏳ still verifying — the result shows in Discord', 5000);
        }).catch(() => { if (n < 30) this.pollVerdict(id, n + 1); });
      }, 3000);
    },
  };

  function gzipBytes(str) {
    const enc = new TextEncoder().encode(str);
    if (typeof CompressionStream === 'undefined') return Promise.resolve(enc);
    try {
      const cs = new CompressionStream('gzip');
      const w = cs.writable.getWriter();
      w.write(enc); w.close();
      return new Response(cs.readable).arrayBuffer().then(b => new Uint8Array(b));
    } catch (e) { return Promise.resolve(enc); }
  }

  if (IS_PLAY) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => ui.mount());
    else ui.mount();
  }

  root.JB = {
    version: VERSION, mode: MODE, run, replay, tick,
    dumpLog() { return JSON.stringify(lastPayload); },
    get lastPayload() { return lastPayload; },
    math: { sin: pSin, cos: pCos, atan2: pAtan2, exp: pExp, pow: pPow, hypot: pHypot, log: pLog },
    mulberry32, fnv1a, rng,
    realSetTimeout, realClearTimeout,
    get inTick() { return inTick; },
  };
})();
