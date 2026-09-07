#!/usr/bin/env node
'use strict';
/* End-to-end match through the real relay.
 *
 *     node replay/netmatch.js [ticks]
 *
 * lockstep.js proves the simulation agrees when it is handed identical
 * inputs. This proves the thing that actually hands them over: it starts
 * server/gladiator.js as a real process, mints real tickets, and connects
 * two real clients running the real net.js over real sockets - then checks
 * that the two arenas stay identical anyway.
 *
 * The two failure modes it exists to catch are protocol ones, invisible to
 * lockstep.js: a tick settled from an incomplete set, and seats numbered
 * differently on different machines.
 *
 * Needs a node with a WebSocket client built in (21+). The droplet runs 18
 * and only needs the SERVER half, which uses nothing but http and crypto.
 *
 * Against a LIVE relay (through TLS and nginx, with tickets minted on the
 * box) rather than a spawned one:
 *
 *     GLAD_WS_URL=wss://juicebox.city/dgws \
 *     GLAD_MATCH=<id> GLAD_TICKETS=<ticketA>,<ticketB> \
 *       node replay/netmatch.js 600
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { makeWindow, gameScripts } = require('./dom.js');

if (typeof WebSocket !== 'function') {
  console.log(`SKIP netmatch: node ${process.version} has no WebSocket client (needs 21+)`);
  process.exit(0);
}

const here = __dirname;
const ROOT = path.join(here, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'game.html'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(ROOT, 'bridge.js'), 'utf8');
const NETJS = fs.readFileSync(path.join(ROOT, 'net.js'), 'utf8');

// Live mode: aim at a relay that is already running, with tickets that
// were minted where the real secret lives.
const LIVE_URL = process.env.GLAD_WS_URL || '';
const LIVE_TICKETS = (process.env.GLAD_TICKETS || '').split(',').filter(Boolean);
const LIVE = !!(LIVE_URL && LIVE_TICKETS.length >= 2);

const SECRET = 'netmatch-test-secret';
const PORT = 8791 + (process.pid % 97);
const MATCH = process.env.GLAD_MATCH || 'testmatch';
const SEED = 4242;
const SEATS = [
  { uid: 'u_alice', name: 'alice', classId: 'knight', weaponId: 'iron_greatsword' },
  { uid: 'u_bob', name: 'bob', classId: 'assassin' },
];

const b64url = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function ticketFor(uid) {
  const body = b64url(JSON.stringify({ m: MATCH, u: uid, e: Math.floor(Date.now() / 1000) + 600 }));
  const sig = b64url(crypto.createHmac('sha256', SECRET).update(body).digest());
  return `${body}.${sig}`;
}

function boot(uid, ticketOverride) {
  const html = SRC.split('Math.random(').join('JB.rng(');
  const win = makeWindow();
  win.JB_MODE = 'play';
  win.JB_CFG = { practice: true, prices: { entry: 20, refill: 10 } };
  win.WebSocket = WebSocket;
  win.JB_NET = {
    url: LIVE ? LIVE_URL : `ws://127.0.0.1:${PORT}/dgws`,
    ticket: ticketOverride || ticketFor(uid),
    match: MATCH,
  };
  const ctx = vm.createContext(win);
  gameScripts(html).forEach((s, i) => vm.runInContext(s, ctx, { filename: `game-${i}.js` }));
  win._fire('DOMContentLoaded');
  vm.runInContext(BRIDGE, ctx, { filename: 'bridge.js' });
  vm.runInContext(NETJS, ctx, { filename: 'net.js' });
  return {
    uid,
    JB: vm.runInContext('JB', ctx),
    net: vm.runInContext('JBNet', ctx),
    get game() { return vm.runInContext('game', ctx); },
  };
}

function stateOfAll(game) {
  return game.players.map(p => [
    p.seat, p.hp.toFixed(6), p.x.toFixed(6), p.y.toFixed(6),
    p.stamina.toFixed(4), p.mp.toFixed(4), p.eliminated ? 1 : 0,
    p.facingAngle.toFixed(6),
  ].join(',')).join('|') + `|storm:${game.stormRadius.toFixed(6)}`;
}

/* Both clients type the same thing; only the transport is under test. */
function inputFor(seat, tick) {
  const t = tick + seat * 977;
  const phase = Math.floor(t / 37) % 8;
  const keys = {};
  if (phase === 0 || phase === 4 || phase === 5) keys.w = true;
  if (phase === 1 || phase === 6) keys.s = true;
  if (phase === 2 || phase === 4) keys.a = true;
  if (phase === 3 || phase === 5 || phase === 6) keys.d = true;
  return {
    keys, mx: 120 + ((t * 7) % 240), my: 100 + ((t * 13) % 240),
    // Each client aims only its OWN seat, as a real player does. If facing
    // does not cross the wire the two arenas disagree about where everyone
    // is pointing, and attacks land in different places.
    aim: (t % 23) * (Math.PI * 2 / 23),
    attack: (t % 53) === 0, dodge: (t % 149) === 0,
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function until(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main() {
  const ticks = parseInt(process.argv[2] || '900', 10);
  let dir = null, relay = null, relayOut = '';

  if (!LIVE) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gladmatch-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${MATCH}.json`), JSON.stringify({ seed: SEED, seats: SEATS }));
    relay = spawn(process.execPath, [path.join(ROOT, 'server', 'gladiator.js')], {
      env: { ...process.env, GLAD_PORT: String(PORT), GLAD_DATA: dir, GLAD_SECRET: SECRET },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    relay.stdout.on('data', d => { relayOut += d; });
    relay.stderr.on('data', d => { relayOut += d; });
  }

  const done = code => {
    try { if (relay) relay.kill(); } catch (e) {}
    if (code && relayOut) console.log('\n--- relay log ---\n' + relayOut.trim());
    process.exit(code);
  };

  try {
    if (LIVE) console.log(`live relay: ${LIVE_URL}, match ${MATCH}`);
    else await until(() => relayOut.includes('gladiator relay on'), 5000, 'the relay to listen');

    const A = boot('u_alice', LIVE ? LIVE_TICKETS[0] : null);
    const B = boot('u_bob', LIVE ? LIVE_TICKETS[1] : null);
    await until(() => A.net.started && B.net.started, 8000, 'both seats to start');

    if (A.net.seat === B.net.seat) throw new Error(`both clients got seat ${A.net.seat}`);
    // Seat order comes from the roster file, not from who connected first.
    if (A.net.seat !== 0 || B.net.seat !== 1) throw new Error(`seats out of roster order: ${A.net.seat}, ${B.net.seat}`);
    console.log(`${LIVE ? 'live' : 'local'} relay; seats ${A.net.seat} and ${B.net.seat}, `
              + `input delay ${A.net.delay} ticks (${(A.net.delay * 16.7).toFixed(0)}ms)`);

    const h0 = stateOfAll(A.game);
    if (h0 !== stateOfAll(B.game)) throw new Error('the two arenas did not even start the same');

    let simulated = 0;
    for (let frame = 0; frame < ticks * 4 && simulated < ticks; frame++) {
      for (const C of [A, B]) {
        const g = C.game;
        const inp = inputFor(C.net.seat, C.net.tick);
        g.keys = inp.keys;
        g.mousePos = { x: inp.mx, y: inp.my };
        const me = g.players[g.mySeat];
        if (me) {
          me.facing = { x: Math.cos(inp.aim), y: Math.sin(inp.aim) };
          me.facingAngle = inp.aim;
        }
        if (inp.attack) g.playerAttack();
        if (inp.dodge) g.playerDodge();
        C.net.step(1 / 60);
      }
      await sleep(1);
      simulated = Math.min(A.net.tick, B.net.tick);

      // Compare only where both have simulated the same number of ticks;
      // one client being a few ticks ahead is normal, not a desync.
      if (A.net.tick === B.net.tick && A.net.tick > 0) {
        const sa = stateOfAll(A.game), sb = stateOfAll(B.game);
        if (sa !== sb) {
          console.log(`\nDESYNC at tick ${A.net.tick}`);
          console.log('  alice: ' + sa);
          console.log('  bob  : ' + sb);
          done(1);
        }
      }
      if (A.net.over || B.net.over) break;
    }

    if (simulated < 60) throw new Error(`the match barely moved: ${simulated} ticks`);

    // Close the sockets and let the relay finish, so its own count of ticks
    // it had to fill by timeout gets printed. A stall is a quarter second
    // where nobody's screen moved, and it is the thing that actually reads
    // as lag - separate from the honest, constant input delay, which is
    // steady and which players adapt to inside a minute.
    try { A.net.ws.close(); B.net.ws.close(); } catch (e) {}
    await sleep(400);
    const lines = relayOut.split(String.fromCharCode(10));
    const summary = lines.filter(l => l.indexOf('filled by timeout') >= 0);
    if (summary.length) {
      const last = summary[summary.length - 1];
      console.log(last.slice(last.indexOf('match ')));
    }

    console.log(`\nIN SYNC through the relay for ${simulated} ticks (${(simulated / 60).toFixed(1)}s)`);
    console.log(`alive: ${A.game.players.filter(p => !p.eliminated).length}/${SEATS.length}`);
    if (dir) console.log(`input log: ${fs.existsSync(path.join(dir, `${MATCH}.log`)) ? 'written' : 'MISSING'}`);
    done(0);
  } catch (e) {
    console.log('FAIL ' + (e.message || e));
    done(1);
  }
}

main();
