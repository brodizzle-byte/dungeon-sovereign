#!/usr/bin/env node
'use strict';
/* Behaviour regression checks.
 *
 *     node replay/checks.js
 *
 * parity.js proves the browser and the server simulate the same run. It
 * cannot prove the run does the right thing - a bug reproduces perfectly on
 * both sides. These checks pin the specific things that were broken and are
 * now fixed, so nobody quietly reintroduces one.
 *
 * They load game.html into the same headless vm the replay uses, so they
 * test the file we actually ship rather than a copy of its logic. A check
 * fails by throwing; the string it returns is just something to print.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeWindow } = require('./dom.js');

const here = __dirname;
const SRC = fs.readFileSync(path.join(here, '..', 'game.html'), 'utf8');

function boot() {
  const html = SRC.split('Math.random(').join('JB.rng(');
  const scripts = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) scripts.push(m[1]);
  const win = makeWindow();
  win.JB_MODE = 'play';
  win.JB_CFG = { practice: true, prices: { entry: 20, refill: 10 } };
  const ctx = vm.createContext(win);
  scripts.forEach((s, i) => vm.runInContext(s, ctx, { filename: `game-${i}.js` }));
  win._fire('DOMContentLoaded');
  vm.runInContext(fs.readFileSync(path.join(here, '..', 'bridge.js'), 'utf8'), ctx, { filename: 'bridge.js' });
  const JB = vm.runInContext('JB', ctx);
  const game = vm.runInContext('game', ctx);
  JB.run.granted = { seed: 1, id: 'checks', refills_left: 0 };
  return { JB, game, read: expr => vm.runInContext(expr, ctx) };
}

/* The bridge turns playerAttack into a queued input; the real call happens
 * on the next tick. Anything testing what an attack DOES has to tick. */
function attackOnce(JB, game) {
  game.player.attackCd = 0;
  game.player.stamina = game.player.maxStamina;
  game.playerAttack();
  JB.tick(game);
}

let failed = 0;
function check(name, fn) {
  try {
    const detail = fn();
    console.log(`ok   ${name}${detail ? `  — ${detail}` : ''}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}  — ${e.message || e}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ── three mage traits compared a trait id against a WEAPON id ───────────
for (const [weapon, flag] of [['storm_wand', 'isChainLightning'],
                              ['pocket_singularity', 'isSingularity'],
                              ['debt_codex', 'isMidasCurse']]) {
  check(`${weapon} fires projectiles carrying ${flag}`, () => {
    const { JB, game } = boot();
    game.selectedClassId = 'mage';
    game.selectedWeaponId = weapon;
    game.startStoryMode();
    attackOnce(JB, game);
    const shots = game.projectiles.filter(p => p.fromPlayer);
    assert(shots.length, 'no projectile was fired at all');
    assert(shots.every(p => p[flag] === true), `${flag} came back ${shots[0][flag]}`);
    return `${shots.length} shot(s)`;
  });
}

check('a weapon without those traits does not get them', () => {
  const { JB, game } = boot();
  game.selectedClassId = 'mage';
  game.selectedWeaponId = 'sapphire_arch_staff';   // arcane_homing
  game.startStoryMode();
  attackOnce(JB, game);
  const p = game.projectiles.find(x => x.fromPlayer);
  assert(p, 'no projectile was fired at all');
  assert(p.isHoming === true, 'arcane_homing did not apply');
  assert(!p.isChainLightning && !p.isSingularity && !p.isMidasCurse,
    'a trait leaked onto the wrong weapon');
  return 'homing only';
});

// ── the skin's stat line has to be the stat you actually get ────────────
check('skin hpMod and defMod reach the player', () => {
  const { game, read } = boot();
  const cls = read('HERO_CLASSES.knight');
  const skin = read("CLASS_SKINS.knight.find(s => s.id === 'ironbark_vanguard')");
  game.selectedClassId = 'knight';
  game.selectedSkinId = 'ironbark_vanguard';
  game.selectedWeaponId = 'iron_greatsword';
  game.selectedPerk = null;
  game.startStoryMode();
  assert(skin.hpMod && skin.defMod, 'the fixture skin has no modifiers to test');
  assert(game.player.maxHp === cls.hp + skin.hpMod,
    `maxHp ${game.player.maxHp}, expected ${cls.hp + skin.hpMod}`);
  assert(game.player.def === cls.def + skin.defMod,
    `def ${game.player.def}, expected ${cls.def + skin.defMod}`);
  return `${game.player.maxHp} hp / ${game.player.def} def`;
});

check('a skin with no modifiers changes nothing', () => {
  const { game, read } = boot();
  const cls = read('HERO_CLASSES.knight');
  game.selectedClassId = 'knight';
  game.selectedSkinId = 'sunforged_champion';      // hpMod 0, defMod 0
  game.selectedWeaponId = 'iron_greatsword';
  game.selectedPerk = null;
  game.startStoryMode();
  assert(game.player.maxHp === cls.hp && game.player.def === cls.def,
    `${game.player.maxHp}/${game.player.def} vs ${cls.hp}/${cls.def}`);
  return `${cls.hp} hp / ${cls.def} def`;
});

check('a negative skin modifier is a real downside', () => {
  const { game, read } = boot();
  const cls = read('HERO_CLASSES.knight');
  game.selectedClassId = 'knight';
  game.selectedSkinId = 'debt_knight';             // hpMod -10, defMod +4
  game.selectedWeaponId = 'iron_greatsword';
  game.selectedPerk = null;
  game.startStoryMode();
  assert(game.player.maxHp === cls.hp - 10, `maxHp ${game.player.maxHp}`);
  assert(game.player.def === cls.def + 4, `def ${game.player.def}`);
  return `${game.player.maxHp} hp / ${game.player.def} def`;
});

// ── poison and snares have to actually slow something ──────────────────
check('slowTimer reduces movement speed', () => {
  const { game } = boot();
  const e = { speed: 100, slowTimer: 0 };
  assert(game.moveSpeed(e) === 100, 'an unslowed enemy moved at a different speed');
  e.slowTimer = 1; e.slowMul = 0.6;
  assert(game.moveSpeed(e) === 60, `snared speed ${game.moveSpeed(e)}, expected 60`);
  e.slowMul = 0.75;
  assert(game.moveSpeed(e) === 75, `poisoned speed ${game.moveSpeed(e)}, expected 75`);
  assert(game.moveSpeed(e, 155) === 116.25, 'a caller-supplied speed escaped the slow');
  return '100 -> 60 snared, 75 poisoned';
});

check('the snare trait sets both the timer and the amount', () => {
  const set = SRC.match(/traitId === 'extended_snare'\)\s*\{[^}]*\}/);
  assert(set, 'the extended_snare branch moved');
  assert(/slowTimer/.test(set[0]) && /slowMul/.test(set[0]), 'it sets a timer with no amount');
  return '2.0s at 0.60';
});

// ── source-level fixes with no runtime handle ──────────────────────────
check('the light canvas resets its composite mode', () => {
  const i = SRC.indexOf("globalCompositeOperation = 'destination-out'");
  const j = SRC.indexOf("globalCompositeOperation = 'source-over'");
  assert(i > 0 && j > i, 'destination-out is never set back');
  assert(j < SRC.indexOf('drawImage(this.lightCanvas', i), 'the reset lands after the composite');
  return 'reset before the sheet is composited';
});

check('render errors are not swallowed', () => {
  const body = SRC.slice(SRC.indexOf('render(dt) {'), SRC.indexOf('renderMinimapRadar() {'));
  assert(!/catch \(e\) \{\}/.test(body), 'render still has an empty catch');
  assert(/setTransform\(1, 0, 0, 1, 0, 0\)/.test(body), 'a render error leaves the transform stack unbalanced');
  assert(/console\.error/.test(body), 'a render error says nothing');
  return 'logged, and the transform is reset';
});

check('no raw enemy.speed movement reads', () =>
  assert(!/enemy\.speed \* dt/.test(SRC), 'a movement read bypasses moveSpeed()') || 'all through moveSpeed()');

for (const dead of ['player.cooldown', 'player.invuln', 'player.stagger',
                    'attackCooldown', 'hazardPuddles', 'aiType']) {
  check(`${dead} stays gone`, () => assert(!SRC.includes(dead), 'it is referenced again') || '');
}

// ── update() owns the simulation, render() only draws it ───────────────
/* Comments talk ABOUT the rules, so a check that reads them would fail on
 * the sentence explaining why it passes. Drop whole-line comments first. */
const code = t => t.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const RENDER = code(SRC.slice(SRC.indexOf('render(dt) {'), SRC.indexOf('buildTileLayer(dungeon) {')));
const UPDATE = code(SRC.slice(SRC.indexOf('update(dt) {'), SRC.indexOf('render(dt) {')));

check('render does not push into the simulation particle pool', () => {
  assert(!/this\.particles\.push/.test(RENDER), 'render still writes to this.particles');
  assert(!/this\.particles\.shift/.test(RENDER), 'render still prunes this.particles');
  assert(/this\.fx\.push/.test(RENDER), 'the render-owned pool is not being used');
  return 'trails live in this.fx';
});

check('render does not expire floating text', () => {
  assert(!/this\.floatingTexts\.splice/.test(RENDER), 'render still removes floating text');
  assert(/this\.floatingTexts\.splice/.test(UPDATE), 'nothing expires floating text any more');
  return 'update owns the clock';
});

check('the simulation never reads the wall clock', () => {
  assert(!/performance\.now\(\)/.test(RENDER), 'render still reads performance.now()');
  assert(!/performance\.now\(\)/.test(UPDATE), 'update reads performance.now()');
  return 'animTime only';
});

check('update never touches the render-owned pool', () =>
  assert(!/this\.fx/.test(UPDATE), 'update can see render decoration') || 'this.fx is invisible to the sim');

// ── combat kinematics: force, not teleportation ────────────────────────
check('knockback is an impulse that decays, not a teleport', () => {
  const { game } = boot();
  game.dungeon = { isWall: () => false };
  const e = { x: 0, y: 0 };
  game.knockback(e, 0, 35);
  const first = e.x;
  game.stepKnockback(e, 1 / 60);
  assert(e.x > 0, 'the impulse moved nothing');
  assert(e.x < 35, `one tick covered ${e.x.toFixed(1)}px - that is a teleport`);
  let ticks = 0;
  while ((e.kx || e.ky) && ticks < 600) { game.stepKnockback(e, 1 / 60); ticks++; }
  assert(ticks > 5 && ticks < 120, `it took ${ticks} ticks to settle`);
  assert(Math.abs(e.x - 35) < 12, `travelled ${e.x.toFixed(1)}px, meant to be about 35`);
  return `${e.x.toFixed(1)}px over ${ticks} ticks (was ${first}px instantly)`;
});

check('knockback cannot push anything through a wall', () => {
  const { game } = boot();
  game.dungeon = { isWall: (x) => x > 20 };
  const e = { x: 0, y: 0 };
  game.knockback(e, 0, 200);
  for (let i = 0; i < 200; i++) game.stepKnockback(e, 1 / 60);
  assert(e.x <= 20, `ended up at x=${e.x.toFixed(1)}, inside the wall`);
  return `stopped at ${e.x.toFixed(1)}`;
});

check('a stunned hostile still slides from the hit that stunned it', () => {
  const UP = code(SRC.slice(SRC.indexOf('update(dt) {'), SRC.indexOf('render(dt) {')));
  const step = UP.indexOf('this.stepKnockback(enemy, dt)');
  const stun = UP.indexOf('Stunned: skips movement and attacks');
  assert(step > 0 && stun > 0, 'one of the two moved');
  assert(step < stun, 'the stun check runs first and swallows the knockback');
  return 'impulse drains before the stun continue';
});

check('hit-stop freezes whole frames', () => {
  const hits = SRC.match(/hitStopTimer = Math[.]max[(][^;]*[/] 60[)]/g) || [];
  assert(hits.length === 3, `${hits.length} freeze sites, expected 3 and all in frames`);
  assert(!/hitStopTimer = 0[.]0[0-9]+/.test(SRC), 'a freeze is still set in raw seconds');
  assert(!/hitStopTimer = [(]?[a-zA-Z0-9 ?:]+[/] 60/.test(SRC),
    'a freeze assigns instead of taking the longest one asked for this frame');
  return `${hits.length} sites, all whole frames, all Math.max`;
});

check('trauma replaced the per-frame random jitter', () => {
  assert(!/[(]Math[.]random[(][)] - 0[.]5[)] [*] this[.]screenShake/.test(SRC),
    'the shake still draws a random number every frame');
  assert(/addTrauma[(]/.test(RENDER) === false, 'render is adding trauma');
  assert(/this[.]shakeAngle/.test(SRC), 'the shake has no direction');
  // three run resets, the decay, and addTrauma's own accumulate
  const bare = (SRC.match(/this[.]screenShake = /g) || []).length;
  assert(bare === 5, `${bare} direct writes to screenShake, expected 5`);
  assert(!/this[.]screenShake = 0[.][0-9]/.test(SRC), 'a hit still sets the shake directly');
  return 'directional, decaying, deterministic';
});

console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
