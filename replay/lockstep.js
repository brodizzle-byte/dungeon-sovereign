#!/usr/bin/env node
'use strict';
/* Lockstep determinism gate.
 *
 *     node replay/lockstep.js [ticks]
 *
 * An online match sends only INPUTS. Every machine simulates the whole
 * arena itself, so the match is only real if two machines fed the same
 * inputs reach the same state - not approximately, exactly, forever.
 *
 * This boots two completely independent copies of the game, seats them in
 * the same match with different mySeat values, feeds both the identical
 * scripted input for every seat, and compares a hash across ALL seats each
 * tick. The first tick where they disagree is the first tick a real match
 * would have started lying to somebody, so that is what it prints.
 *
 * parity.js proves browser == server for one player. This proves
 * client == client for several, which is the different and harder claim.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeWindow, gameScripts } = require('./dom.js');

const here = __dirname;
const SRC = fs.readFileSync(path.join(here, '..', 'game.html'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(here, '..', 'bridge.js'), 'utf8');

const SEED = 20260906;
const SEATS = [
  { name: 'alice', classId: 'knight',   weaponId: 'iron_greatsword' },
  { name: 'bob',   classId: 'assassin', weaponId: null },
  { name: 'carol', classId: 'mage',     weaponId: null },
];

function boot(mySeat) {
  const html = SRC.split('Math.random(').join('JB.rng(');
  const win = makeWindow();
  win.JB_MODE = 'play';
  win.JB_CFG = { practice: true, prices: { entry: 20, refill: 10 } };
  const ctx = vm.createContext(win);
  gameScripts(html).forEach((s, i) => vm.runInContext(s, ctx, { filename: `game-${i}.js` }));
  win._fire('DOMContentLoaded');
  vm.runInContext(BRIDGE, ctx, { filename: 'bridge.js' });
  const JB = vm.runInContext('JB', ctx);
  const game = vm.runInContext('game', ctx);
  JB.run.granted = { seed: SEED, id: 'lockstep', refills_left: 0 };
  game.startPvpMatch({ seed: SEED, mySeat, seats: SEATS });
  return { JB, game };
}

/* The whole arena, not just one seat: a desync usually shows up in
 * somebody else's player first, which is exactly the case a one-player
 * hash would sail straight past. */
function stateOfAll(game) {
  const parts = [];
  for (const p of game.players) {
    parts.push([
      p.seat, p.hp.toFixed(6), p.x.toFixed(6), p.y.toFixed(6),
      p.vx.toFixed(6), p.vy.toFixed(6), p.facingAngle.toFixed(6),
      p.stamina.toFixed(4), p.mp.toFixed(4), p.sips,
      p.attackCd.toFixed(6), p.comboStage, p.isDodging ? 1 : 0,
      p.dodgeTimer.toFixed(6), p.sugarLevel.toFixed(4), p.auraState,
    ].join(','));
  }
  parts.push('storm:' + game.stormRadius.toFixed(6) + ',' + game.stormTimer.toFixed(6));
  parts.push('proj:' + game.projectiles.length + ',fx:' + game.enemies.length);
  return parts.join('|');
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/* A scripted match. Both clients run this identically - it stands in for
 * what the network would deliver, so the only thing under test is the
 * simulation. Integer arithmetic only, so the script itself cannot drift. */
function inputFor(seat, tick) {
  const t = tick + seat * 977;
  const phase = Math.floor(t / 37) % 8;
  const keys = {};
  if (phase === 0 || phase === 4 || phase === 5) keys.w = true;
  if (phase === 1 || phase === 6) keys.s = true;
  if (phase === 2 || phase === 4) keys.a = true;
  if (phase === 3 || phase === 5 || phase === 6) keys.d = true;
  return {
    keys,
    mousePos: { x: 120 + ((t * 7) % 240), y: 100 + ((t * 13) % 240) },
    touchMovement: { active: false, x: 0, y: 0 },
    attack: (t % 53) === 0,
    dodge: (t % 149) === 0,
    skill: (t % 211) === 0,
    sip: (t % 331) === 0,
  };
}

function drive(inst, tick) {
  const { game } = inst;
  for (let seat = 0; seat < game.players.length; seat++) {
    const p = game.players[seat];
    const inp = inputFor(seat, tick);
    // Delivered to every seat the way the relay delivers a settled tick,
    // this machine's own included.
    p.input.keys = inp.keys;
    p.input.mousePos = inp.mousePos;
    p.input.touchMovement = inp.touchMovement;
  }
  // Actions: the local seat goes through the bridge exactly as a real
  // keypress would; every other seat's arrive the way net.js delivers
  // them, straight onto that seat's queue. Both end up drained in seat
  // order inside the tick.
  for (let seat = 0; seat < game.players.length; seat++) {
    const inp = inputFor(seat, tick);
    const codes = [];
    if (inp.attack) codes.push('a');
    if (inp.skill) codes.push('s');
    if (inp.dodge) codes.push('d');
    if (inp.sip) codes.push('h');
    if (!codes.length) continue;
    if (seat === game.mySeat) {
      if (inp.attack) game.playerAttack();
      if (inp.skill) game.playerSkill();
      if (inp.dodge) game.playerDodge();
      if (inp.sip) game.playerSip();
    } else {
      const p = game.players[seat];
      p.pendingActions = (p.pendingActions || []).concat(codes);
    }
  }
}

function main() {
  const ticks = parseInt(process.argv[2] || '3600', 10);
  const A = boot(0);
  const B = boot(1);

  if (A.game.players.length !== SEATS.length) {
    console.log(`FAIL seated ${A.game.players.length} of ${SEATS.length}`);
    process.exit(1);
  }

  const h0a = fnv1a(stateOfAll(A.game)), h0b = fnv1a(stateOfAll(B.game));
  if (h0a !== h0b) {
    console.log(`FAIL the match did not even START the same: ${h0a} vs ${h0b}`);
    console.log('  A: ' + stateOfAll(A.game));
    console.log('  B: ' + stateOfAll(B.game));
    process.exit(1);
  }
  console.log(`seated ${SEATS.length} (${SEATS.map(s => s.name).join(', ')}), start hash ${h0a}`);

  for (let t = 0; t < ticks; t++) {
    drive(A, t);
    drive(B, t);
    A.JB.tick(A.game);
    B.JB.tick(B.game);
    const ha = fnv1a(stateOfAll(A.game));
    const hb = fnv1a(stateOfAll(B.game));
    if (ha !== hb) {
      console.log(`\nDESYNC at tick ${t} (${(t / 60).toFixed(1)}s)`);
      console.log(`  seat0 view: ${ha}`);
      console.log(`  seat1 view: ${hb}`);
      const sa = stateOfAll(A.game).split('|'), sb = stateOfAll(B.game).split('|');
      for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
        if (sa[i] !== sb[i]) console.log(`  differs: ${sa[i]}\n        : ${sb[i]}`);
      }
      process.exit(1);
    }
    if ((t + 1) % 600 === 0) console.log(`  ${((t + 1) / 60).toFixed(0)}s in sync — ${ha}`);
  }

  const alive = A.game.players.filter(p => p.hp > 0).length;
  console.log(`\nIN SYNC for ${ticks} ticks (${(ticks / 60).toFixed(0)}s), ${alive}/${SEATS.length} alive`);
}

main();
