/* Gladiator Nights — the client half of the lockstep match.
 *
 * Loaded only for an online match (index.php sets window.JB_NET). Solo
 * runs never execute a line of this.
 *
 * The rule this file exists to enforce: NOBODY simulates a tick until the
 * relay has told them what every seat did on that tick - including
 * themselves. Your own keypresses are not applied when you press them;
 * they are sent, settled by the server, and handed back to every machine
 * together. That delay is the cost of the whole design, and it is also
 * the only reason all the machines stay identical.
 *
 * So there is no prediction here, and no reconciliation, because there is
 * nothing to reconcile: every client runs the same inputs through the same
 * simulation and gets the same arena. What that buys is honesty; what it
 * costs is the input delay, which the server keeps as small as the worst
 * connection in the match allows.
 */
(function () {
  'use strict';
  const root = window;
  const CFG = root.JB_NET;
  if (!CFG || !CFG.url || !CFG.ticket) return;

  const DT = 1 / 60;
  const HASH_EVERY = 60;          // one agreement check a second
  const REDUNDANCY = 3;           // repeat this many ticks in every packet

  const net = {
    ws: null,
    seat: -1,
    seed: 0,
    seats: [],
    delay: 3,
    tick: 0,                      // the next tick to simulate
    sent: -1,                     // the highest tick we have sent input for
    settled: new Map(),           // tick -> { seat: packet }
    recent: [],                   // [tick, packet] we still repeat
    started: false,
    over: false,
    reported: false,
    status: 'connecting',
  };
  root.JBNet = net;

  function say(msg, cls) {
    net.status = msg;
    const el = document.getElementById('jb-net-status');
    if (el) { el.textContent = msg; el.className = cls || ''; }
    // `game` is declared with `let` at the top of game.html, so it lives in
    // the global LEXICAL scope and is not a property of window - reaching
    // for root.game finds undefined, in the browser as well as the harness.
    try { if (typeof game !== 'undefined' && game.addCombatLog) game.addCombatLog(msg, cls || 'text-cyan-300'); } catch (e) {}
  }

  function send(obj) {
    if (net.ws && net.ws.readyState === 1) net.ws.send(JSON.stringify(obj));
  }

  /* ── the local player's intent, as a packet ──
   * Read straight off the live input objects, exactly what the engine
   * would have read this frame - then held back and sent instead. */
  // Same quantisation bridge.js uses for the recorded log, so a match can
  // be re-simulated later by the same machinery that verifies solo runs.
  function q1024(v) { return Math.round(v * 1024) / 1024; }

  function sample(game, facing) {
    const K = game.keys || {};
    const k = ((K['w'] || K['arrowup']) ? 1 : 0) | ((K['s'] || K['arrowdown']) ? 2 : 0)
            | ((K['a'] || K['arrowleft']) ? 4 : 0) | ((K['d'] || K['arrowright']) ? 8 : 0);
    const T = game.touchMovement || { active: false, x: 0, y: 0 };
    const r2 = v => Math.round(v * 100) / 100;
    return {
      k,
      m: [r2(game.mousePos.x), r2(game.mousePos.y)],
      t: [T.active ? 1 : 0, r2(T.x), r2(T.y)],
      // Where this player is pointing. controls.js writes facing directly
      // - the aim stick and the aim-assist both do - so it is intent that
      // has to travel, exactly like a keypress. Without it every machine
      // guesses everybody else's angle and the arenas come apart.
      f: facing ? [q1024(facing.x), q1024(facing.y)] : null,
      // Taken, not applied: the bridge would otherwise fire these on the
      // next tick, ahead of everybody else's.
      a: root.JB.takeActions(),
    };
  }

  /* ── hand a settled tick to the engine ──
   * Every seat, including our own, is written from the packet the server
   * settled. The local seat reads the LIVE objects, so those are what get
   * written for it - never a copy, which would go stale. */
  function applyInputs(game, by) {
    for (let i = 0; i < game.players.length; i++) {
      const p = game.players[i];
      if (!p) continue;
      const pk = by[i];
      if (!pk) continue;
      const keys = {
        w: !!(pk.k & 1), s: !!(pk.k & 2), a: !!(pk.k & 4), d: !!(pk.k & 8),
      };
      const mouse = { x: pk.m[0], y: pk.m[1] };
      const touch = { active: !!pk.t[0], x: pk.t[1], y: pk.t[2] };
      // Every seat, ours included. Writing our own live objects here would
      // overwrite the keys the player is currently holding with the echo of
      // what they held `delay` ticks ago, and a held key would die.
      p.input.keys = keys;
      p.input.mousePos = mouse;
      p.input.touchMovement = touch;
      if (pk.f) {
        p.facing = { x: pk.f[0], y: pk.f[1] };
        p.facingAngle = Math.atan2(pk.f[1], pk.f[0]);   // the portable atan2
      }
      if (pk.a && pk.a.length) {
        p.pendingActions = (p.pendingActions || []).concat(pk.a);
      }
    }
  }

  function reportHash(game, tick) {
    let s = '';
    for (const p of game.players) {
      s += `${p.seat},${p.hp.toFixed(4)},${p.x.toFixed(4)},${p.y.toFixed(4)},`
         + `${p.stamina.toFixed(3)},${p.mp.toFixed(3)},${p.eliminated ? 1 : 0},`
         + `${(p.facingAngle || 0).toFixed(4)}|`;
    }
    s += `storm:${game.stormRadius.toFixed(4)}:${game.stormTimer.toFixed(4)}`;
    send({ op: 'hash', tick, h: root.JB.fnv1a(s) });
  }

  function pushInput(forTick, packet) {
    // If the delay just rose, `forTick` jumps past a number we never sent.
    // The server would wait LATE_MS for it and then fill it with a repeat -
    // a quarter-second stall for everyone, every time the delay moves. Send
    // the skipped numbers ourselves, carrying this same input.
    if (net.sent >= 0 && forTick > net.sent + 1) {
      for (let t = net.sent + 1; t < forTick; t++) net.recent.push([t, packet]);
    }
    net.recent.push([forTick, packet]);
    // Keep the gap fill in the packet as well as the redundancy window.
    while (net.recent.length > REDUNDANCY + 8) net.recent.shift();
    // Every packet repeats the last few ticks, so a single dropped one
    // does not stall the barrier for everybody else in the match.
    send({ op: 'input', in: net.recent });
    net.sent = forTick;
  }

  function sendInput(game, forTick) {
    const me = game.players && game.players[game.mySeat];
    pushInput(forTick, sample(game, me && me.facing));
  }

  /* ── the clock ──
   * Called from the engine's frame loop instead of its accumulator. We
   * advance only as far as the relay has settled, and we render regardless
   * so a stall looks like a freeze, not a crash. */
  function gate(game, real) {
    if (net.over) { game.render(real); return; }

    let ran = 0;
    while (net.settled.has(net.tick)) {
      const by = net.settled.get(net.tick);
      net.settled.delete(net.tick);
      // Read our own aim BEFORE applying the settled tick: applying sets
      // this seat's facing to what it was `delay` ticks ago, and sampling
      // after that would send back the echo instead of where the player is
      // actually pointing now.
      const me = game.players[game.mySeat];
      const aim = (me && me.facing) ? { x: me.facing.x, y: me.facing.y } : null;
      applyInputs(game, by);
      // Take our own presses BEFORE the engine ticks. The bridge captures
      // and applies pending actions itself at the top of every tick, so
      // leaving them there means your swing lands on THIS machine and
      // nowhere else - two arenas, one tick apart, immediately.
      const mine = net.started ? sample(game, aim) : null;
      root.JB.tick(game);
      const done = net.tick;
      net.tick++;
      ran++;
      // Having simulated a tick, declare what we are doing `delay` ticks
      // from now. Sampling is paced by the simulation, not by the frame
      // rate, so a fast machine cannot flood the relay.
      if (mine) pushInput(net.tick + net.delay, mine);
      if (done % HASH_EVERY === 0) reportHash(game, done);

      // The run ends when the MATCH does - the last seat standing, or this
      // one being eliminated after everybody else. Report once.
      if (!net.reported && root.JB.run.ended) {
        net.reported = true;
        const me = game.players[game.mySeat];
        // run.ended is the whole end-of-run record, not a word - sending it
        // as the status put "[object Object]" in the match report.
        const ended = root.JB.run.ended || {};
        send({
          op: 'done',
          status: ended.status || 'ENDED',
          placed: me ? me.placement : 0,
          kills: me ? (me.kills || 0) : 0,
          score: ended.score | 0,
          tick: done,
        });
      }
      if (ran > 8) break;                 // catching up, but not in one frame
    }
    if (!ran) game.render(real);           // waiting on somebody
  }

  /* ── protocol ── */
  function onSeated(msg) {
    net.seat = msg.seat;
    net.seed = msg.seed;
    net.seats = msg.seats || [];
    net.delay = msg.delay || 3;
    say(`seated ${net.seat + 1}/${net.seats.length} — waiting for everyone`, 'text-cyan-300');
  }

  function onStart(msg) {
    if (net.started) return;
    net.delay = msg.delay || net.delay;
    net.started = true;

    // Seed the run exactly as a solo run is seeded, then seat everybody.
    root.JB.run.granted = { seed: net.seed, id: CFG.match, refills_left: 0 };
    game.startPvpMatch({ seed: net.seed, mySeat: net.seat, seats: net.seats });
    root.JB.setGate(gate);

    // Prime the pipe: the first `delay` ticks are already in flight before
    // anybody has simulated anything.
    for (let t = 0; t <= net.delay; t++) sendInput(game, t);
    say(`fight — ${net.seats.length} in, ${(net.delay * 16.7).toFixed(0)}ms delay`, 'text-amber-300');
  }

  function onInputs(msg) {
    net.settled.set(msg.tick, msg.by);
  }

  function onDesync(msg) {
    net.over = true;
    say(`desync at tick ${msg.tick} — this match cannot be scored`, 'text-rose-400');
  }

  function onOver(msg) {
    net.over = true;
    say(`match over (${msg.why || 'finished'})`, 'text-amber-300');
  }

  function connect() {
    const ws = new WebSocket(CFG.url);
    net.ws = ws;
    ws.onopen = () => {
      say('connected — joining', 'text-cyan-300');
      send({ op: 'join', ticket: CFG.ticket });
    };
    ws.onmessage = ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      switch (msg.op) {
        case 'seated':  onSeated(msg); break;
        case 'start':   onStart(msg); break;
        case 'inputs':  onInputs(msg); break;
        case 'delay':   net.delay = msg.d; break;   // gap handled in pushInput
        case 'desync':  onDesync(msg); break;
        case 'over':    onOver(msg); break;
        case 'denied':  say(`denied: ${msg.why}`, 'text-rose-400'); break;
        case 'here':    say(`${msg.name} joined (${msg.in}/${msg.of})`, 'text-cyan-300'); break;
        case 'left':    say(`${msg.name} dropped — they stand still now`, 'text-rose-300'); break;
        case 'ping':    send({ op: 'pong' }); break;
      }
    };
    ws.onclose = () => { if (!net.over) say('connection lost', 'text-rose-400'); };
    ws.onerror = () => say('connection error', 'text-rose-400');
  }

  // Tell the relay how it ended, so it can stop waiting on us.
  const origVictory = null;
  root.JBNetReport = function (status, placed) {
    send({ op: 'done', status, placed });
  };

  net.connect = connect;
  // Lets replay/netmatch.js drive this exact file against the real relay,
  // instead of testing a second implementation that could be wrong in a
  // different way than the one players run.
  net.step = real => gate(game, real);
  if (CFG.auto !== false) connect();
})();
