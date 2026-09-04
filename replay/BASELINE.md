# Determinism baseline

Two commands guard this engine:

    node replay/parity.js    # the browser and the server simulate the same run
    node replay/checks.js    # the run does the right thing

`parity.js` is the gate — nothing ships unless it prints **ALL GREEN**,
because a run the server cannot re-simulate is a run the bot will not pay a
bounty on. But green does not mean *correct*: a bug reproduces perfectly on
both sides. That is what `checks.js` is for, and why every fix below has a
check pinned to it.

Green also does not prove a change was *invisible*. For that, compare the
recorded line against the table for the current version: a refactor or a
performance pass must reproduce those numbers exactly. A change that
deliberately alters gameplay will move them, and the new table gets written
here in the same commit that moves it.

Two scenarios end by running out of ticks rather than by dying. Those are
arguably the most useful, since they compare a state hash over thousands of
ticks instead of a handful of end-of-run totals — but their `status` and
`score` come from the harness forcing an ending, so the comparison ignores
those two fields and checks the hash instead.

## v7 step 6 — current

| seed   | mode  | cap  | result                                          | tick | log | rng  | hash     |
|--------|-------|------|-------------------------------------------------|------|-----|------|----------|
| 12345  | story | 6000 | FAILED floor 4, 26 kills, 1125 gold, 6150 pts   | 4338 | 638 | 3443 | —        |
| 777    | story | 6000 | tick cap, floor 6, 32 kills, 1275 gold          | 6000 | 850 | 4712 | 47cdf6ea |
| 424242 | story | 6000 | FAILED floor 4, 20 kills, 975 gold, 4950 pts    | 3170 | 449 | 2246 | —        |
| 12345  | arena | 9000 | FAILED floor 1, 6 kills, 150 gold, 1200 pts     | 3715 | 456 | 1168 | —        |
| 777    | arena | 9000 | tick cap, floor 1, 5 kills, 125 gold            | 9000 | 324 | 1138 | 3df98044 |

## v7 step 5

| seed   | mode  | cap  | result                                          | tick | log | rng  | hash     |
|--------|-------|------|-------------------------------------------------|------|-----|------|----------|
| 12345  | story | 6000 | FAILED floor 4, 24 kills, 1075 gold, 5750 pts   | 4630 | 693 | 3820 | —        |
| 777    | story | 6000 | FAILED floor 4, 26 kills, 1125 gold, 6150 pts   | 4645 | 699 | 4468 | —        |
| 424242 | story | 6000 | FAILED floor 4, 22 kills, 1025 gold, 5350 pts   | 4551 | 599 | 3930 | —        |
| 12345  | arena | 9000 | FAILED floor 1, 6 kills, 150 gold, 1200 pts     | 3715 | 456 | 1168 | —        |
| 777    | arena | 9000 | tick cap, floor 1, 5 kills, 125 gold            | 9000 | 324 | 1138 | 3df98044 |

## v7 step 4

| seed   | mode  | cap  | result                                          | tick | log | rng  | hash     |
|--------|-------|------|-------------------------------------------------|------|-----|------|----------|
| 12345  | story | 6000 | tick cap, floor 3, 15 kills, 850 gold           | 6000 | 739 | 2118 | 60f7213c |
| 777    | story | 6000 | FAILED floor 4, 17 kills, 900 gold, 4350 pts    | 3686 | 569 | 2680 | —        |
| 424242 | story | 6000 | FAILED floor 6, 30 kills, 1225 gold, 6950 pts   | 5850 | 921 | 5023 | —        |
| 12345  | arena | 9000 | FAILED floor 1, 3 kills, 75 gold, 600 pts       | 3863 | 475 | 1096 | —        |
| 777    | arena | 9000 | FAILED floor 1, 6 kills, 150 gold, 1200 pts     | 6327 | 654 | 1272 | —        |

## v7 steps 1-3

| seed   | mode  | cap  | result                                          | tick | log | rng  | hash     |
|--------|-------|------|-------------------------------------------------|------|-----|------|----------|
| 12345  | story | 6000 | FAILED floor 4, 15 kills, 850 gold, 3950 pts    | 2765 | 390 | 2059 | —        |
| 777    | story | 6000 | tick cap, floor 5, 34 kills, 1325 gold          | 6000 | 816 | 5299 | 3f73b204 |
| 424242 | story | 6000 | tick cap, floor 4, 24 kills, 1075 gold          | 6000 | 909 | 2995 | ddec3bdd |
| 12345  | arena | 9000 | FAILED floor 1, 3 kills, 75 gold, 600 pts       | 3980 | 392 | 1582 | —        |
| 777    | arena | 9000 | FAILED floor 1, 1 kill, 25 gold, 200 pts        | 4379 | 661 | 1109 | —        |

## v6.5 — the engine as the author delivered it

| seed   | mode  | cap  | result                                          | tick | log | rng  | hash     |
|--------|-------|------|-------------------------------------------------|------|-----|------|----------|
| 12345  | story | 6000 | FAILED floor 4, 15 kills, 850 gold, 3950 pts    | 2758 | 389 | 2038 | —        |
| 777    | story | 6000 | FAILED floor 4, 26 kills, 1125 gold, 6150 pts   | 4394 | 678 | 4215 | —        |
| 424242 | story | 6000 | tick cap, floor 5, 37 kills, 1400 gold          | 6000 | 825 | 5157 | 29c71783 |
| 12345  | arena | 9000 | FAILED floor 1, 2 kills, 50 gold, 400 pts       | 3877 | 466 | 932  | —        |
| 777    | arena | 9000 | tick cap, floor 1, 2 kills, 50 gold             | 9000 | 549 | 1164 | 537589b2 |

## Why the numbers moved

**Step 0 (take ownership)** reproduced v6.5 exactly, which was the point:
it proved the tooling around the engine can change without the engine
moving.

**Step 1a (lighting, dead fields, the swallowed render error)** also
reproduced v6.5 exactly. Nothing it touched was reachable from the
simulation, and the run confirming that is what makes the deletions safe
rather than hopeful.

**Step 1b (three fixes to things the game promised and never did)** moved
every scenario, and had to. The self-test bot picks the first skin in the
list, which for the knight is Ironbark Vanguard: +15 HP and +2 DEF that had
never once been applied. It now survives longer everywhere, which is why
777/story stops dying on floor 4 and runs into the tick cap on floor 5.

**Step 2 (the tile layer cached to an offscreen canvas)** reproduced step 1
exactly, hash for hash. It is a render-only change and the state hashes
prove it.

**Step 3 (the update/render split)** reproduced step 2 exactly, hash for
hash. That was the design goal, not a happy accident: projectile trails
moved to a render-owned pool instead of into update() precisely so the
seeded RNG stream would not start paying for sparkles.

**Step 4 (combat kinematics)** moved everything, as a change to how fights
resolve should. Enemies are shoved with force now instead of being teleported
28-35px, so they spend a moment out of reach and then walk back in; hit-stop
freezes whole frames at two moments instead of 25ms on a crit. The self-test
bot has no opinion about feel, so what its numbers show is only that the
fights are different - the runs are longer, and one seed now reaches floor 6.

**Step 5 (the chain and the input buffer)** moved them again. The self-test
bot swings on a fixed cadence rather than reacting, so it lands the finisher
by accident rather than on purpose - which is the honest limit of what these
numbers can tell you about feel. They tell you the fights changed. Whether
the chain is satisfying is a question for a person with a phone.

**Step 6 (enemies attack instead of leaking damage)** is the change with
the most balance risk in the whole overhaul, and the table cannot settle it.
Contact damage was 3.5x a full hit per second of standing still; a landed
swing is now worth about half a second of that, on a cycle of roughly a
second, and it can be walked out of, dodged, or cancelled with a stun. On
paper that is a large nerf to every hostile in the game, and the self-test
bot - which never dodges and never retreats - now survives to floor 6 on a
seed that used to stop it on 4.

Three numbers decide whether that is right, all together at the top of the
file: ENEMY_HIT_SCALE (2.0), ENEMY_SWING_CD (0.5) and ENEMY_WINDUP (0.34).
They are deliberately in one place because this wants a person playing it,
not a bot averaging it.
