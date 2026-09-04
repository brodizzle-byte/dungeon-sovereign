#!/usr/bin/env node
'use strict';
/* Determinism self-test: record a synthetic run headless (bridge in
 * 'play' mode, practice), then replay the payload through run.js and
 * compare. Usage: node selftest.js [seed] [mode] [ticks]  */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');
const { execFileSync } = require('child_process');
const { makeWindow } = require('./dom.js');

const seed = parseInt(process.argv[2] || '12345', 10) >>> 0;
const mode = process.argv[3] || 'story';
const maxTicks = parseInt(process.argv[4] || '6000', 10);

const here = __dirname;
let html = fs.readFileSync(path.join(here, '..', 'game.html'), 'utf8');
html = html.replace("document.getElementById('go-stat-score').innerText = score;\n        this.setState(STATES.GAME_OVER);",
                    "document.getElementById('go-stat-score').innerText = this.runStats.score;\n        this.setState(STATES.GAME_OVER);");
html = html.split('Math.random(').join('JB.rng(');   // same rewrite index.php serves
const scripts = [];
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m; while ((m = re.exec(html)) !== null) scripts.push(m[1]);

const win = makeWindow();
win.JB_MODE = 'play';
win.JB_CFG = { practice: true, prices: { entry: 20, refill: 10 } };
const ctx = vm.createContext(win);
scripts.forEach((s, i) => vm.runInContext(s, ctx, { filename: `game-${i}.js` }));
win._fire('DOMContentLoaded');
vm.runInContext(fs.readFileSync(path.join(here, '..', 'bridge.js'), 'utf8'), ctx, { filename: 'bridge.js' });
const JB = vm.runInContext('JB', ctx);
const game = vm.runInContext('game', ctx);

// grant a fixed seed instead of the practice random one
JB.run.granted = { seed, id: process.argv[5] || 'selftest', refills_left: 0 };
game.selectedClassId = 'knight'; game.selectedWeaponId = 'iron_greatsword';
if (mode === 'arena') game.startArenaBattleRoyale(); else game.startStoryMode();

// synthetic "player": BFS-paths to the nearest living enemy (or the exit
// portal when the floor is clear). It reads state the way a human reads
// the screen — every decision still lands in the input log.
const TS = 32;
function bfsStep(tiles, fromX, fromY, toX, toY) {
  const H = tiles.length, W = tiles[0].length;
  const sx = Math.max(0, Math.min(W - 1, Math.floor(fromX / TS))), sy = Math.max(0, Math.min(H - 1, Math.floor(fromY / TS)));
  const tx = Math.max(0, Math.min(W - 1, Math.floor(toX / TS))), ty = Math.max(0, Math.min(H - 1, Math.floor(toY / TS)));
  if (sx === tx && sy === ty) return null;
  const prev = new Int32Array(W * H).fill(-1);
  const q = [sy * W + sx]; prev[sy * W + sx] = sy * W + sx;
  let found = false;
  while (q.length) {
    const cur = q.shift(); const cx = cur % W, cy = (cur / W) | 0;
    if (cx === tx && cy === ty) { found = true; break; }
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (tiles[ny][nx] !== 0 && !(nx === tx && ny === ty)) continue;
      const ni = ny * W + nx; if (prev[ni] !== -1) continue;
      prev[ni] = cur; q.push(ni);
    }
  }
  if (!found) return null;
  let cur = ty * W + tx;
  while (prev[cur] !== sy * W + sx) cur = prev[cur];
  return { x: (cur % W) * TS + TS / 2, y: ((cur / W) | 0) * TS + TS / 2 };
}
let s = seed ^ 0x9e3779b9;
const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
const t0 = Date.now();
let ticks = 0, maxFloor = 1, step = null;
while (!JB.run.ended && ticks < maxTicks) {
  const p = game.player;
  if (p && game.dungeon) {
    if (game.currentFloor > maxFloor) maxFloor = game.currentFloor;
    let best = null, bd = 1e9;
    const pool = game.activeBoss ? [game.activeBoss].concat(game.enemies) : game.enemies;
    for (const e of pool) { if (!e || e.dead || e.hp <= 0) continue; const d = Math.hypot(e.x - p.x, e.y - p.y); if (d < bd) { bd = d; best = e; } }
    if (ticks % 6 === 0) {
      let dx = 0, dy = 0;
      if (game.gameMode === 'arena' && !process.env.AGGR) {
        // royale: survive. Drift away from the nearest gladiator, stay inside the storm.
        const cx = game.stormCenter.x, cy = game.stormCenter.y;
        const dc = Math.hypot(p.x - cx, p.y - cy);
        let vx = 0, vy = 0;
        if (best && bd < 170) { vx += (p.x - best.x) / bd; vy += (p.y - best.y) / bd; }
        if (dc > game.stormRadius * 0.55) { vx += (cx - p.x) / dc * 1.5; vy += (cy - p.y) / dc * 1.5; }
        dx = Math.abs(vx) > 0.2 ? Math.sign(vx) : 0; dy = Math.abs(vy) > 0.2 ? Math.sign(vy) : 0;
        if (best) { game.mousePos.x = best.x - game.cam.x; game.mousePos.y = best.y - game.cam.y; }
      } else {
        let goal = best ? { x: best.x, y: best.y } : game.dungeon.exitPos;
        if (goal) {
          step = (best && bd < 48) ? null : bfsStep(game.dungeon.tiles, p.x, p.y, goal.x, goal.y);
          const tgt = step || goal;
          if (!(best && bd < 48)) { dx = Math.abs(tgt.x - p.x) > 3 ? Math.sign(tgt.x - p.x) : 0; dy = Math.abs(tgt.y - p.y) > 3 ? Math.sign(tgt.y - p.y) : 0; }
        }
        if (best) { game.mousePos.x = best.x - game.cam.x; game.mousePos.y = best.y - game.cam.y; }
      }
      game.keys = { w: dy < 0, s: dy > 0, a: dx < 0, d: dx > 0 };
    }
    const arena = game.gameMode === 'arena' && !process.env.AGGR;
    if (best && bd < (arena ? 70 : 110) && ticks % 12 === 0) game.playerAttack();
    if (!arena && best && bd < 200 && ticks % 150 === 0) game.playerSkill();
    if (arena && best && bd < 90 && ticks % 240 === 0) game.playerDodge();
    if (p.hp < p.maxHp * (arena ? 0.5 : 0.35) && ticks % 90 === 0) game.playerSip();
  }
  JB.tick(game);
  ticks++;
}
console.log(`reached floor ${maxFloor}`);
if (!JB.run.ended) { game.triggerGameOver(); }
const payload = JB.lastPayload;
const recMs = Date.now() - t0;
const file = path.join(os.tmpdir(), `jb-selftest-${seed}-${mode}.json`);
fs.writeFileSync(file, JSON.stringify(payload));
const rec = payload.claimed;
console.log(`recorded: ${rec.status} floor ${rec.floor} kills ${rec.kills} gold ${rec.gold} score ${rec.score} tick ${rec.tick} ` +
            `log ${payload.log.length} entries, ${payload.checkpoints.length} checkpoints, rng ${payload.rng_calls}, ${recMs} ms`);

const out = execFileSync(process.execPath, [path.join(here, 'run.js'), file], { encoding: 'utf8' });
const rep = JSON.parse(out.trim().split('\n').pop());
console.log(`replayed: ${rep.status} floor ${rep.floor} kills ${rep.kills} gold ${rep.gold} score ${rep.score} tick ${rep.ticks} rng ${rep.rng_calls} ${rep.ms} ms`);
const same = rep.status === rec.status && rep.floor === rec.floor && rep.kills === rec.kills &&
             rep.gold === rec.gold && rep.score === rec.score && rep.ticks === rec.tick;
console.log(same ? 'MATCH ✅' : 'MISMATCH ❌ ' + JSON.stringify(rep).slice(0, 400));
process.exit(same ? 0 : 1);
