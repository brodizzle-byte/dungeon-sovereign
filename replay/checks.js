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
const { makeWindow, gameScripts } = require('./dom.js');

const here = __dirname;
const SRC = fs.readFileSync(path.join(here, '..', 'game.html'), 'utf8');

function boot() {
  const html = SRC.split('Math.random(').join('JB.rng(');
  const scripts = gameScripts(html);
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
  const body = SRC.slice(SRC.indexOf('render(dt) {'), SRC.indexOf('buildTileLayer(dungeon) {'));
  // The reset has to restore the renderer's BASE transform, not identity:
  // Obsidian draws 3x supersampled (a 1440 backing store shown at 480), so
  // resetting to 1:1 would leave everything a third size for the rest of
  // the run. Take the base from where the canvas is configured so this
  // keeps working the next time the resolution changes.
  const base = SRC.match(/setTransform\(([^)]*)\)[\s\S]{0,80}?previewCanvas|canvas\.width\s*=[\s\S]{0,120}?setTransform\(([^)]*)\)/);
  const want = ((base && (base[1] || base[2])) || '1, 0, 0, 1, 0, 0').trim();
  assert(!/catch \(e\) \{\}/.test(body), 'render still has an empty catch');
  assert(body.includes('setTransform(' + want + ')'),
    `a render error must reset the transform to the renderer's base (${want})`);
  assert(/console\.error/.test(body), 'a render error says nothing');
  return `logged, and the transform resets to ${want}`;
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
  assert(hits.length === 5, `${hits.length} freeze sites, expected 5 and all in frames`);
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

// ── the chain, and presses that used to be thrown away ─────────────────
function armed(JB, game) {
  const p = game.player;
  p.stamina = p.maxStamina;
  p.attackCd = 0;
  game.playerAttack();
  JB.tick(game);
  return p;
}

check('three swings inside the window make a finisher, the fourth resets', () => {
  const { JB, game } = boot();
  game.selectedClassId = 'knight';
  game.selectedWeaponId = 'iron_greatsword';
  game.startStoryMode();
  const seen = [];
  for (let n = 0; n < 4; n++) {
    const p = armed(JB, game);
    seen.push(p.comboStage);
    for (let i = 0; i < 3; i++) JB.tick(game);     // stay inside the window
  }
  assert(seen.join() === '0,1,2,0', `stages went ${seen.join()}, expected 0,1,2,0`);
  return seen.join(' -> ');
});

check('letting the window lapse drops you back to a first hit', () => {
  const { JB, game } = boot();
  game.selectedClassId = 'knight';
  game.selectedWeaponId = 'iron_greatsword';
  game.startStoryMode();
  armed(JB, game);
  for (let i = 0; i < 3; i++) JB.tick(game);
  assert(armed(JB, game).comboStage === 1, 'the chain did not advance at all');
  for (let i = 0; i < 40; i++) JB.tick(game);      // well past COMBO_WINDOW
  assert(game.player.comboStage === 0, 'the window expired without resetting the stage');
  assert(armed(JB, game).comboStage === 0, 'a lapsed chain carried on anyway');
  return 'window closes, stage resets';
});

check('the finisher costs more recovery than a light hit', () => {
  const { JB, game } = boot();
  game.selectedClassId = 'knight';
  game.selectedWeaponId = 'iron_greatsword';
  game.startStoryMode();
  const light = armed(JB, game).attackCd;
  for (let i = 0; i < 3; i++) JB.tick(game);
  armed(JB, game);
  for (let i = 0; i < 3; i++) JB.tick(game);
  const heavy = armed(JB, game).attackCd;
  assert(game.player.comboStage === 2, 'that third swing was not the finisher');
  assert(heavy > light, `finisher recovery ${heavy.toFixed(3)}s vs light ${light.toFixed(3)}s`);
  return `${light.toFixed(3)}s light, ${heavy.toFixed(3)}s finisher`;
});

check('a press late in recovery is remembered, not eaten', () => {
  const { JB, game } = boot();
  game.selectedClassId = 'knight';
  game.selectedWeaponId = 'iron_greatsword';
  game.startStoryMode();
  const p = game.player;
  p.stamina = p.maxStamina;
  p.attackCd = 0.1;                               // inside ATTACK_BUFFER
  game.playerAttack();
  JB.tick(game);
  assert(p.attackBuffered === true, 'the press was dropped');
  let fired = 0;
  for (let i = 0; i < 20 && !fired; i++) {
    JB.tick(game);
    if (!p.attackBuffered && p.attackCd > 0.15) fired = i + 1;
  }
  assert(fired, 'the buffered press never fired');
  return `fired ${fired} ticks later`;
});

check('a press early in recovery is still dropped', () => {
  const { JB, game } = boot();
  game.selectedClassId = 'knight';
  game.selectedWeaponId = 'iron_greatsword';
  game.startStoryMode();
  const p = game.player;
  p.stamina = p.maxStamina;
  p.attackCd = 0.21;                              // outside ATTACK_BUFFER
  game.playerAttack();
  JB.tick(game);
  assert(p.attackBuffered !== true, 'the whole recovery is buffering');
  return 'only the tail of recovery buffers';
});

// ── enemies attack; they do not leak damage into you ───────────────────
function inRangeOf(game) {
  // Floor 1 mixes melee skulkers with ranged cultists, and a caster will
  // never wind up a melee swing however long you stand on it.
  const e = game.enemies.find(x => !x.dead && x.archetype === 'abyssal_skulker')
         || game.enemies.find(x => !x.dead);
  if (!e) throw new Error('the floor spawned no hostiles to test with');
  e.archetype = 'abyssal_skulker';
  e.skulkerState = 'advance';
  e.x = game.player.x + 12;
  e.y = game.player.y;
  e.stunTimer = 0;
  e.atkState = null;
  e.swingCd = 0;
  return e;
}

check('standing inside a hostile does not drain health', () => {
  const { JB, game } = boot();
  game.selectedClassId = 'knight';
  game.selectedWeaponId = 'iron_greatsword';
  game.startStoryMode();
  game.spawnGraceTimer = 0;
  const p = game.player;
  const e = inRangeOf(game);
  const drops = [];
  let last = p.hp;
  for (let i = 0; i < 90; i++) {
    e.x = p.x + 12; e.y = p.y;                    // pinned in contact
    JB.tick(game);
    if (p.hp < last) { drops.push(+(last - p.hp).toFixed(2)); last = p.hp; }
    if (p.hp <= 0) break;
  }
  assert(drops.length, 'a hostile in contact for a second and a half did nothing at all');
  assert(drops.length <= 3, `${drops.length} separate damage events in 90 ticks - that is a drain`);
  assert(drops.every(d => d >= 1 && Number.isInteger(d)),
    `damage arrived in fractions: ${drops.join(', ')}`);
  return `${drops.length} discrete hit(s): ${drops.join(', ')}`;
});

check('walking out of a windup means the swing misses', () => {
  const { JB, game } = boot();
  game.selectedClassId = 'knight';
  game.selectedWeaponId = 'iron_greatsword';
  game.startStoryMode();
  game.spawnGraceTimer = 0;
  const p = game.player;
  const e = inRangeOf(game);
  for (let i = 0; i < 40 && !e.atkState; i++) { e.x = p.x + 12; e.y = p.y; JB.tick(game); }
  assert(e.atkState === 'windup', 'the hostile never wound up');
  const hp = p.hp;
  e.x = p.x + 400;                                 // step out of the swing
  for (let i = 0; i < 40; i++) { e.x = p.x + 400; JB.tick(game); }
  assert(p.hp === hp, `took ${(hp - p.hp).toFixed(2)} damage from a swing it walked out of`);
  return 'no damage from a swing you left';
});

check('stunning a hostile mid-windup cancels the swing', () => {
  const { JB, game } = boot();
  game.selectedClassId = 'knight';
  game.selectedWeaponId = 'iron_greatsword';
  game.startStoryMode();
  game.spawnGraceTimer = 0;
  const p = game.player;
  const e = inRangeOf(game);
  for (let i = 0; i < 40 && !e.atkState; i++) { e.x = p.x + 12; e.y = p.y; JB.tick(game); }
  assert(e.atkState === 'windup', 'the hostile never wound up');
  const hp = p.hp;
  e.stunTimer = 0.5;
  for (let i = 0; i < 20; i++) { e.x = p.x + 12; e.y = p.y; JB.tick(game); }
  assert(e.atkState === null, 'the stun did not cancel the swing');
  assert(p.hp === hp, `the cancelled swing still did ${(hp - p.hp).toFixed(2)} damage`);
  return 'swing cancelled, no damage';
});

check('no contact damage formula survives anywhere', () =>
  assert(!/hp -= [a-zA-Z.]+ [*] dt [*] 3[.]5/.test(SRC),
    'the per-tick contact drain is still in the file') || 'gone');

check('the windup is drawn', () => {
  assert(/atkState === 'windup'/.test(RENDER), 'nothing draws the telegraph');
  return 'a closing ring, red until it lands';
});

// ── nothing ends up inside a wall ──────────────────────────────────────
/* A wall to roll at: a floor tile with solid rock immediately east of it. */
function wallSpot(game) {
  const T = 32;
  for (let ty = 1; ty < 31; ty++) {
    for (let tx = 1; tx < 30; tx++) {
      if (game.dungeon.tiles[ty][tx] === 0 && game.dungeon.tiles[ty][tx + 1] === 1) {
        return { x: tx * T + 16, y: ty * T + 16, wallX: (tx + 1) * T + 16 };
      }
    }
  }
  throw new Error('no floor tile with a wall to its east on this floor');
}

check('a dodge roll cannot end up inside a wall', () => {
  const { JB, game } = boot();
  game.selectedClassId = 'knight';
  game.selectedWeaponId = 'iron_greatsword';
  game.startStoryMode();
  const spot = wallSpot(game);
  const p = game.player;
  p.x = spot.x; p.y = spot.y;
  p.isDodging = true;
  p.dodgeTimer = p.dodgeDuration;
  p.dodgeAngle = 0;                       // due east, straight at the wall
  for (let i = 0; i < 60; i++) JB.tick(game);
  assert(!game.dungeon.isWall(p.x, p.y),
    `rolled to (${p.x.toFixed(1)}, ${p.y.toFixed(1)}) which is inside a wall`);
  assert(p.x < spot.wallX, `rolled through to x=${p.x.toFixed(1)}, past the wall at ${spot.wallX}`);
  return `stopped at x=${p.x.toFixed(1)}, wall begins ${spot.wallX}`;
});

check('a diagonal roll slides along a wall instead of sticking', () => {
  const { JB, game } = boot();
  game.selectedClassId = 'knight';
  game.selectedWeaponId = 'iron_greatsword';
  game.startStoryMode();
  const spot = wallSpot(game);
  const p = game.player;
  p.x = spot.x; p.y = spot.y;
  const y0 = p.y;
  p.isDodging = true;
  p.dodgeTimer = p.dodgeDuration;
  p.dodgeAngle = Math.PI / 4;             // into the wall AND downward
  for (let i = 0; i < 60; i++) JB.tick(game);
  assert(!game.dungeon.isWall(p.x, p.y), 'ended up inside the wall');
  assert(Math.abs(p.y - y0) > 1,
    'blocked on x killed the y movement too - that is sticking, not sliding');
  return `slid ${(p.y - y0).toFixed(1)}px along it`;
});

check('the 130px blink cannot cross a wall', () => {
  const { game } = boot();
  game.selectedClassId = 'assassin';
  game.startStoryMode();
  const spot = wallSpot(game);
  const p = game.player;
  p.x = spot.x; p.y = spot.y;
  game.moveBlocked(p, 130, 0);            // four tiles, straight at the wall
  assert(!game.dungeon.isWall(p.x, p.y), 'blinked inside a wall');
  assert(p.x < spot.wallX, `blinked through to x=${p.x.toFixed(1)}, wall at ${spot.wallX}`);
  return `stopped short at x=${p.x.toFixed(1)}`;
});

check('every position write goes through a collision-aware move', () => {
  // The four bugs fixed here were all the same shape: a raw `+=` on x/y.
  // This is the assertion that would have caught them on day one.
  const raw = SRC.match(/this\.player\.[xy] \+=|enemy\.[xy] \+=/g) || [];
  assert(raw.length === 0,
    `${raw.length} raw position write(s) bypass moveBlocked/stepKnockback`);
  assert(/moveBlocked\(e, dx, dy\)/.test(SRC), 'moveBlocked is gone');
  return 'no raw += on any entity position';
});

console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
