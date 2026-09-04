#!/usr/bin/env node
'use strict';
/* THE GATE. Runs the whole determinism suite in one command:
 *
 *     node replay/parity.js
 *
 * Every scenario records a synthetic run in the browser's code path and
 * replays it through the server's, then compares. Nothing in the v7
 * overhaul ships until this prints ALL GREEN — a run the server cannot
 * re-simulate is a run the bot will not pay a bounty on.
 *
 * The expected line for each scenario is the v6.5 baseline. A change that
 * is meant to be invisible (a refactor, a perf pass) must reproduce those
 * numbers exactly; a change that is meant to alter gameplay will not, and
 * the new numbers get pasted in here in the same commit that makes them.
 */
const path = require('path');
const { spawnSync } = require('child_process');

const SUITE = [
  { seed: 12345,  mode: 'story', ticks: 6000 },
  { seed: 777,    mode: 'story', ticks: 6000 },
  { seed: 424242, mode: 'story', ticks: 6000 },
  { seed: 12345,  mode: 'arena', ticks: 9000 },
  { seed: 777,    mode: 'arena', ticks: 9000 },
];

const only = process.argv[2];   // optional seed filter
let failed = 0;

for (const s of SUITE) {
  if (only && String(s.seed) !== only) continue;
  const label = `${s.seed} ${s.mode}`.padEnd(15);
  const r = spawnSync(process.execPath,
    [path.join(__dirname, 'selftest.js'), String(s.seed), s.mode, String(s.ticks)],
    { encoding: 'utf8' });
  const lines = (r.stdout || '').trim().split('\n');
  const rec = lines.find(l => l.startsWith('recorded:')) || '(no run)';
  const verdict = lines[lines.length - 1] || '(no verdict)';
  if (r.status !== 0) failed++;
  console.log(`${label} ${verdict}`);
  console.log(`${' '.repeat(16)}${rec.replace('recorded: ', '')}`);
  if (r.status !== 0 && r.stderr) console.log(r.stderr.trim().slice(0, 500));
}

console.log(failed ? `\n${failed} SCENARIO(S) FAILED — do not ship` : '\nALL GREEN');
process.exit(failed ? 1 : 0);
