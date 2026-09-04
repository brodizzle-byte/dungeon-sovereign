<?php
/**
 * Dungeon Sovereign — shared constants + run-file helpers.
 * ⚠️ Prices mirror config.py (DUNGEON_*) — change BOTH or drift.
 */

const DUNGEON_TEST_ONLY = true;                    // admins only while in the lab
const DUNGEON_TEST_IDS  = ['189399665354080257', '494226132670087188', '69451914542055424']; // config.ADMIN_IDS

/** While gated: admins, plus anyone the bot exported from the 🧪 Dungeon
 *  Tester role (data/testers.json, refreshed every 30 s by cogs/dungeon.py). */
function dg_may_test($discordId) {
  if (!DUNGEON_TEST_ONLY) return true;
  $id = (string)$discordId;
  if (in_array($id, DUNGEON_TEST_IDS, true)) return true;
  $t = json_decode(@file_get_contents(__DIR__ . '/data/testers.json'), true);
  return is_array($t) && in_array($id, array_map('strval', $t['ids'] ?? []), true);
}

const DUNGEON_ENTRY_SIPS      = 20;
const DUNGEON_REFILL_SIPS     = 10;
const DUNGEON_REFILLS_PER_RUN = 3;
const DUNGEON_BOUNTY_CLEAR    = 50;   // story floor-10 clear (paid by the bot, verified)
const DUNGEON_BOUNTY_BR_WIN   = 30;   // battle-royale #1 (paid by the bot, verified)
const DUNGEON_RUNS_PER_DAY    = 10;
const DUNGEON_RUN_TTL_HOURS   = 6;
const DUNGEON_MAX_LOG_BYTES   = 2 * 1024 * 1024;   // compressed upload cap
const DUNGEON_MAX_JSON_BYTES  = 24 * 1024 * 1024;  // decompressed cap

define('DUNGEON_DATA', __DIR__ . '/data');
define('DUNGEON_RUNS', DUNGEON_DATA . '/runs');
define('DUNGEON_MEMBERS', DUNGEON_DATA . '/members');

function dg_ensure_dirs() {
  foreach ([DUNGEON_DATA, DUNGEON_RUNS, DUNGEON_MEMBERS] as $d) if (!is_dir($d)) @mkdir($d, 0775, true);
}

function dg_run_file($id) {
  $id = preg_replace('/[^a-z0-9-]/', '', (string)$id);
  return $id ? DUNGEON_RUNS . "/{$id}.json" : null;
}
function dg_log_file($id) {
  $id = preg_replace('/[^a-z0-9-]/', '', (string)$id);
  return $id ? DUNGEON_RUNS . "/{$id}.log.gz" : null;
}
function dg_read_run($id) {
  $f = dg_run_file($id);
  if (!$f || !file_exists($f)) return null;
  $r = json_decode(@file_get_contents($f), true);
  return is_array($r) ? $r : null;
}
/** Read-modify-write under an exclusive lock. $fn gets the array (or null) and returns the new array. */
function dg_update_run($id, $fn) {
  $f = dg_run_file($id);
  if (!$f) return null;
  $h = fopen($f, 'c+');
  if (!$h) return null;
  flock($h, LOCK_EX);
  $cur = json_decode(stream_get_contents($h), true);
  $new = $fn(is_array($cur) ? $cur : null);
  if ($new !== null) {
    ftruncate($h, 0); rewind($h);
    fwrite($h, json_encode($new, JSON_UNESCAPED_UNICODE));
    fflush($h);
  }
  flock($h, LOCK_UN); fclose($h);
  return $new;
}

/** Per-member pointer file: {open, last, day, runs_today}. */
function dg_member_file($discordId) {
  return DUNGEON_MEMBERS . '/' . preg_replace('/\D/', '', (string)$discordId) . '.json';
}
function dg_read_member($discordId) {
  $m = json_decode(@file_get_contents(dg_member_file($discordId)), true);
  return is_array($m) ? $m : ['open' => null, 'last' => null, 'day' => '', 'runs_today' => 0];
}
function dg_update_member($discordId, $fn) {
  dg_ensure_dirs();
  $h = fopen(dg_member_file($discordId), 'c+');
  if (!$h) return null;
  flock($h, LOCK_EX);
  $cur = json_decode(stream_get_contents($h), true);
  if (!is_array($cur)) $cur = ['open' => null, 'last' => null, 'day' => '', 'runs_today' => 0];
  $new = $fn($cur);
  ftruncate($h, 0); rewind($h);
  fwrite($h, json_encode($new));
  fflush($h);
  flock($h, LOCK_UN); fclose($h);
  return $new;
}

function dg_now_iso() { return (new DateTime('now', new DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.u'); }
function dg_today() { return gmdate('Y-m-d'); }

/** Public view of a run for the page. */
function dg_run_public($r) {
  if (!$r) return null;
  return ['id' => $r['id'], 'mode' => $r['mode'] ?? null, 'status' => $r['status'] ?? null,
          'refills' => (int)($r['refills'] ?? 0),
          'refills_left' => max(0, DUNGEON_REFILLS_PER_RUN - (int)($r['refills'] ?? 0)),
          'bounty' => (int)($r['bounty'] ?? 0), 'note' => $r['note'] ?? null,
          'verified' => $r['verified'] ?? null, 'claimed' => $r['claimed'] ?? null,
          'started' => $r['started'] ?? null];
}
