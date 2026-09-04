<?php
/**
 * DUNGEON SOVEREIGN — web API. Sips OUT only; never pays.
 *
 *   POST op=state            -> balance, prices, open run, last run verdict, HoF
 *   POST op=start&mode=      -> debit entry, mint seed + run_id       [dungeon_entry]
 *   POST op=refill&run_id=   -> debit one refill (cap per run)         [dungeon_refill]
 *   POST op=finish&run_id=   -> body = gzipped payload; run -> pending (bot verifies + pays)
 *   POST op=abandon&run_id=  -> close an open run without a claim
 *
 * Identity: signed jb_casino cookie (same as the casino). Every debit is
 * an atomic conditional UPDATE. Bounties are credited ONLY by the bot,
 * after replay/run.js re-simulates the uploaded input log and agrees.
 */
header('Content-Type: application/json');
require_once dirname(__DIR__) . '/casino/_casino.php';
require_once __DIR__ . '/_dungeon.php';

$you = casino_auth();
if (casino_is_tour($you)) { echo json_encode(['ok' => false, 'msg' => '👀 practice mode — nothing at stake, nothing to buy.']); exit; }
$me = casino_member($you);
if (!$me) { echo json_encode(['ok' => false, 'auth' => false, 'msg' => 'Use your personal link from Discord (!dungeon).']); exit; }
if (!dg_may_test($you)) {
  echo json_encode(['ok' => false, 'msg' => 'The dungeon is still in the lab — admins and testers only for now.']); exit;
}
if ($_SERVER['REQUEST_METHOD'] !== 'POST') { echo json_encode(['ok' => false, 'msg' => 'POST required.']); exit; }

$pdo = jrs_sips_db();
$id = (string)$you;
$op = $_POST['op'] ?? $_GET['op'] ?? 'state';
dg_ensure_dirs();

function fail($msg, $extra = []) { echo json_encode(array_merge(['ok' => false, 'msg' => $msg], $extra)); exit; }
function win($extra = []) {
  echo json_encode(array_merge(['ok' => true, 'balance' => jrs_sips_balance($GLOBALS['id'])], $extra), JSON_UNESCAPED_UNICODE);
  exit;
}
function debit($pdo, $id, $amt, $event, $detail) {
  $sp = $pdo->prepare("UPDATE members SET sips_balance = sips_balance - ?
                       WHERE discord_id = ? AND sips_balance >= ?");
  $sp->execute([$amt, $id, $amt]);
  if ($sp->rowCount() === 0) return false;
  jrs_sips_log($pdo, $event, $id, -$amt, $detail);
  return true;
}
function throttle_ok($id, $sec = 1.0) {
  $lock = DUNGEON_DATA . '/t_' . preg_replace('/\D/', '', $id) . '.lock';
  $last = @filemtime($lock);
  if ($last !== false && (microtime(true) - $last) < $sec) return false;
  @touch($lock);
  return true;
}
function bounty_today($pdo, $id, $kind) {
  $q = $pdo->prepare("SELECT 1 FROM ledger WHERE event_type='dungeon_bounty' AND discord_id=?
                      AND detail LIKE ? AND timestamp >= ? LIMIT 1");
  $q->execute([$id, $kind . '%', dg_today() . 'T00:00:00']);
  return (bool)$q->fetchColumn();
}
function hof_top() {
  $h = json_decode(@file_get_contents(DUNGEON_DATA . '/hof.json'), true);
  return is_array($h) ? array_slice($h['top'] ?? [], 0, 10) : [];
}

/* ── state ─────────────────────────────────────────────────────── */
if ($op === 'state') {
  $m = dg_read_member($id);
  $open = $m['open'] ? dg_read_run($m['open']) : null;
  if ($open && ($open['status'] ?? '') !== 'open') $open = null;
  $last = $m['last'] ? dg_read_run($m['last']) : null;
  win([
    'name' => $me['username'],
    'prices' => ['entry' => DUNGEON_ENTRY_SIPS, 'refill' => DUNGEON_REFILL_SIPS, 'refills' => DUNGEON_REFILLS_PER_RUN,
                 'clear' => DUNGEON_BOUNTY_CLEAR, 'br' => DUNGEON_BOUNTY_BR_WIN],
    'open_run' => dg_run_public($open),
    'last_run' => dg_run_public($last),
    'runs_today' => ($m['day'] === dg_today()) ? (int)$m['runs_today'] : 0,
    'runs_per_day' => DUNGEON_RUNS_PER_DAY,
    'bounty_claimed_today' => ['story' => bounty_today($pdo, $id, 'story'), 'arena' => bounty_today($pdo, $id, 'arena')],
    'hof' => hof_top(),
    'week' => (json_decode(@file_get_contents(DUNGEON_DATA . '/hof.json'), true)['week'] ?? null),
  ]);
}

/* ── start ─────────────────────────────────────────────────────── */
if ($op === 'start') {
  $mode = ($_POST['mode'] ?? 'story') === 'arena' ? 'arena' : 'story';
  if (!throttle_ok($id, 2.0)) fail('Easy — one run at a time.');
  $m = dg_read_member($id);
  $today = dg_today();
  $runsToday = ($m['day'] === $today) ? (int)$m['runs_today'] : 0;
  if ($runsToday >= DUNGEON_RUNS_PER_DAY) fail('That is ' . DUNGEON_RUNS_PER_DAY . ' runs today — the dungeon reopens at midnight UTC.');

  // an open run is abandoned by starting a new one
  if ($m['open']) {
    dg_update_run($m['open'], function ($r) {
      if ($r && ($r['status'] ?? '') === 'open') { $r['status'] = 'abandoned'; $r['ended'] = dg_now_iso(); $r['note'] = 'replaced by a new run'; }
      return $r;
    });
  }

  $runId = gmdate('Ymd') . '-' . bin2hex(random_bytes(4));
  $seed = random_int(1, 0xFFFFFFFF);
  if (!debit($pdo, $id, DUNGEON_ENTRY_SIPS, 'dungeon_entry', "{$mode} run {$runId}"))
    fail('A run costs ' . DUNGEON_ENTRY_SIPS . ' sips — you have ' . jrs_sips_balance($id) . '. Earn some in the city first.');

  $run = ['id' => $runId, 'discord_id' => $id, 'name' => $me['username'], 'mode' => $mode, 'seed' => $seed,
          'started' => dg_now_iso(), 'refills' => 0, 'status' => 'open', 'entry_paid' => DUNGEON_ENTRY_SIPS];
  dg_update_run($runId, function () use ($run) { return $run; });
  dg_update_member($id, function ($m) use ($runId, $today) {
    if ($m['day'] !== $today) { $m['day'] = $today; $m['runs_today'] = 0; }
    $m['runs_today']++;
    $m['open'] = $runId;
    return $m;
  });
  win(['run_id' => $runId, 'seed' => $seed, 'mode' => $mode, 'refills_left' => DUNGEON_REFILLS_PER_RUN,
       'msg' => "Run {$runId} paid — " . DUNGEON_ENTRY_SIPS . " sips."]);
}

/* ── refill ────────────────────────────────────────────────────── */
if ($op === 'refill') {
  $runId = (string)($_POST['run_id'] ?? '');
  if (!throttle_ok($id, 0.5)) fail('Slow down.');
  $r = dg_read_run($runId);
  if (!$r || $r['discord_id'] !== $id) fail('Not your run.');
  if (($r['status'] ?? '') !== 'open') fail('That run is over.');
  if (strtotime($r['started']) < time() - DUNGEON_RUN_TTL_HOURS * 3600) fail('That run timed out.');
  if ((int)$r['refills'] >= DUNGEON_REFILLS_PER_RUN) fail('No refills left this run (' . DUNGEON_REFILLS_PER_RUN . ' max).');
  if (!debit($pdo, $id, DUNGEON_REFILL_SIPS, 'dungeon_refill', "run {$runId} refill #" . ((int)$r['refills'] + 1)))
    fail('A refill is ' . DUNGEON_REFILL_SIPS . ' sips — you have ' . jrs_sips_balance($id) . '.');
  $r = dg_update_run($runId, function ($r) { $r['refills'] = (int)$r['refills'] + 1; return $r; });
  win(['refills' => (int)$r['refills'], 'refills_left' => DUNGEON_REFILLS_PER_RUN - (int)$r['refills']]);
}

/* ── finish: store the log, hand off to the bot ────────────────── */
if ($op === 'finish') {
  $runId = (string)($_GET['run_id'] ?? $_POST['run_id'] ?? '');
  $r = dg_read_run($runId);
  if (!$r || $r['discord_id'] !== $id) fail('Not your run.');
  if (($r['status'] ?? '') !== 'open') fail('That run already closed (' . $r['status'] . ').');
  $raw = file_get_contents('php://input', false, null, 0, DUNGEON_MAX_LOG_BYTES + 1);
  if ($raw === false || strlen($raw) === 0) fail('Empty upload.');
  if (strlen($raw) > DUNGEON_MAX_LOG_BYTES) fail('Run log too large.');
  $isGz = strlen($raw) > 2 && ord($raw[0]) === 0x1f && ord($raw[1]) === 0x8b;
  $json = $isGz ? @gzdecode($raw, DUNGEON_MAX_JSON_BYTES) : $raw;
  if ($json === false || $json === null) fail('Bad compression.');
  if (strlen($json) > DUNGEON_MAX_JSON_BYTES) fail('Run log too large.');
  $p = json_decode($json, true);
  if (!is_array($p) || ($p['run_id'] ?? '') !== $runId || !isset($p['log'], $p['claimed'], $p['seed']))
    fail('Malformed run payload.');
  if ((int)$p['seed'] !== (int)$r['seed']) fail('Seed mismatch.');
  $gz = $isGz ? $raw : gzencode($json, 6);
  if (@file_put_contents(dg_log_file($runId), $gz, LOCK_EX) === false) fail('Could not store the run.');
  $claimed = $p['claimed'];
  $abandoned = (($claimed['status'] ?? '') === 'ABANDONED');   // nothing to verify, nothing to pay
  $r = dg_update_run($runId, function ($r) use ($claimed, $p, $abandoned) {
    $r['status'] = $abandoned ? 'abandoned' : 'pending';
    $r['ended'] = dg_now_iso();
    $r['mode'] = ($p['mode'] ?? $r['mode']) === 'arena' ? 'arena' : 'story';
    $r['claimed'] = ['status' => (string)($claimed['status'] ?? ''), 'floor' => (int)($claimed['floor'] ?? 0),
                     'kills' => (int)($claimed['kills'] ?? 0), 'gold' => (int)($claimed['gold'] ?? 0),
                     'score' => (int)($claimed['score'] ?? 0), 'tick' => (int)($claimed['tick'] ?? 0),
                     'hash' => preg_replace('/[^0-9a-f]/', '', (string)($claimed['hash'] ?? ''))];
    $r['refills_used_claimed'] = (int)($p['refills_used'] ?? 0);
    return $r;
  });
  dg_update_member($id, function ($m) use ($runId) { $m['open'] = null; $m['last'] = $runId; return $m; });
  win(['status' => $abandoned ? 'abandoned' : 'pending', 'msg' => $abandoned ? 'Run closed.' : 'Run stored — verifying.']);
}

/* ── abandon ───────────────────────────────────────────────────── */
if ($op === 'abandon') {
  $runId = (string)($_POST['run_id'] ?? '');
  $r = dg_read_run($runId);
  if (!$r || $r['discord_id'] !== $id) fail('Not your run.');
  if (($r['status'] ?? '') === 'open') {
    dg_update_run($runId, function ($r) { $r['status'] = 'abandoned'; $r['ended'] = dg_now_iso(); return $r; });
    dg_update_member($id, function ($m) use ($runId) { if ($m['open'] === $runId) $m['open'] = null; $m['last'] = $runId; return $m; });
  }
  win(['status' => 'abandoned']);
}

fail('Unknown op.');
