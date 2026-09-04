# Determinism baseline

`node replay/parity.js` must print **ALL GREEN** before anything ships. That
proves the browser's simulation and the server's re-simulation agree — the
only thing that lets the bot pay a bounty.

Green alone does not prove a change was *invisible*, though. For that,
compare the recorded line against the table below: a refactor or a
performance pass must reproduce these numbers exactly, because it is not
supposed to change what happens in the game. A change that deliberately
alters gameplay will move them, and the new row gets written in here in the
same commit that moves it.

## v6.5 — the engine as the author delivered it

| seed   | mode  | ticks cap | result                                        | log | rng  | hash     |
|--------|-------|-----------|-----------------------------------------------|-----|------|----------|
| 12345  | story | 6000      | FAILED floor 4, 15 kills, 850 gold, 3950 pts  | 389 | 2038 | —        |
| 777    | story | 6000      | FAILED floor 4, 26 kills, 1125 gold, 6150 pts | 678 | 4215 | —        |
| 424242 | story | 6000      | tick cap, floor 5, 37 kills, 1400 gold        | 825 | 5157 | 29c71783 |
| 12345  | arena | 9000      | FAILED floor 1, 2 kills, 50 gold, 400 pts     | 466 | 932  | —        |
| 777    | arena | 9000      | tick cap, floor 1, 2 kills, 50 gold           | 549 | 1164 | 537589b2 |

Two scenarios end by running out of ticks rather than by dying. Those are
still useful — arguably the most useful, since they compare a state hash
over thousands of ticks instead of a handful of end-of-run totals — but
their `status` and `score` come from the harness forcing an ending, so the
comparison ignores those two fields and checks the hash instead.

## Step 0 (take ownership) — unchanged, as intended

Archiving v6.5 to the `main` branch, moving the victory-screen fix into
`game.html`, and deleting that string patch from `index.php`,
`replay/run.js` and `replay/selftest.js` reproduced every number above
byte for byte. That is the whole point of doing it first: it establishes
that the tooling around the engine can change without the engine moving.
