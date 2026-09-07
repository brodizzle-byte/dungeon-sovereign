#!/usr/bin/env node
'use strict';
/* Re-simulate a Dungeon Sovereign run from its input log.
 *
 *   node run.js <payload.json | payload.json.gz> [--refills N] [--max-ticks N]
 *
 * Loads game.html's inline scripts and bridge.js into a vm context with a
 * fake DOM, seeds the run exactly as the browser did, feeds the recorded
 * input tick by tick, and prints one JSON line:
 *   {status: CLEARED|FAILED|ABANDONED|DIVERGED|CHEAT|TIMEOUT|NO_END|ERROR, ...}
 * The bot compares `status`/`mode`/`score` with what the browser claimed.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const { makeWindow, gameScripts } = require('./dom.js');

function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function main() {
  const args = process.argv.slice(2);
  const file = args[0];
  if (!file) { out({ status: 'ERROR', error: 'usage: run.js <payload.json[.gz]> [--refills N] [--max-ticks N]' }); process.exit(2); }
  let refills = Infinity, maxTicks = 216000, checkEvery = 0, debug = false, trace = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--refills') refills = parseInt(args[++i], 10);
    if (args[i] === '--max-ticks') maxTicks = parseInt(args[++i], 10);
    if (args[i] === '--check-every') checkEvery = parseInt(args[++i], 10);
    if (args[i] === '--debug') debug = true;
    if (args[i] === '--trace') trace = args[++i].split('-').map(Number);
  }
  let raw = fs.readFileSync(file);
  if (raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw);
  const payload = JSON.parse(raw.toString('utf8'));

  const here = __dirname;
  let html = fs.readFileSync(path.join(here, '..', 'game.html'), 'utf8');
  html = html.split('Math.random(').join('JB.rng(');   // same rewrite index.php serves
  const scripts = gameScripts(html);
  if (!scripts.length) { out({ status: 'ERROR', error: 'no inline scripts in game.html' }); process.exit(2); }

  const win = makeWindow();
  if (checkEvery) win.JB_CHECK_EVERY = checkEvery;
  if (debug) win.JB_DEBUG_STATE = 1;
  if (trace) win.JB_TRACE_TICKS = trace;
  const ctx = vm.createContext(win);
  const t0 = Date.now();
  try {
    scripts.forEach((src, i) => vm.runInContext(src, ctx, { filename: `game-${i}.js` }));
    win._fire('DOMContentLoaded');                       // constructs `game`
    const bridge = fs.readFileSync(path.join(here, '..', 'bridge.js'), 'utf8');
    vm.runInContext(bridge, ctx, { filename: 'bridge.js' });
    const JB = vm.runInContext('JB', ctx);
    const res = JB.replay(payload, { refillsAllowed: refills, maxTicks });
    res.ms = Date.now() - t0;
    // Which engine recorded this, and which one just re-simulated it. If
    // they differ, nothing below the surface is comparable and the bot must
    // not read a mismatch as dishonesty.
    res.payload_version = payload.v || 0;
    res.engine_version = JB.version;
    res.claimed = payload.claimed || null;
    res.mode = res.mode || payload.mode;
    res.log_entries = (payload.log || []).length;
    if (debug) res.checkpoints_mine = JB.run.checkpoints;
    out(res);
  } catch (e) {
    out({ status: 'ERROR', error: String(e && e.stack || e).slice(0, 800), ms: Date.now() - t0 });
    process.exit(1);
  }
}

main();
