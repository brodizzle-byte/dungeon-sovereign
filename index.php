<?php
/**
 * 🏰 DUNGEON SOVEREIGN — a member-built game we maintain from v7.0
 * on, served with the JuiceBox bridge attached. This page only:
 *   1. checks who you are (signed jb_casino cookie / ?auth= link),
 *   2. rewrites the game's own Math.random( to JB.rng( and injects two meta
 *      tags, and
 *   3. injects the bridge that makes runs deterministic + wired to sips.
 * The RNG rewrite is the one patch that stays: it keeps third-party code on
 * the page (Tailwind's runtime) off the seeded stream. Everything else goes
 * IN game.html — replay/run.js loads that file straight off disk, so a fix
 * applied only here would diverge every replay.
 * Sips move only in api.php; bounties are paid only by the bot after the
 * server replays the run (replay/run.js).
 */
require_once dirname(__DIR__) . '/casino/_casino.php';
require_once __DIR__ . '/_dungeon.php';

$you = casino_auth();
$me  = casino_member($you);

if (!$me) {
  http_response_code(403);
  echo '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>The Dungeon</title>'
     . '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/casino/casino.css"></head><body>';
  casino_locked_page('THE DUNGEON');
  echo '</body></html>';
  exit;
}

$practice = casino_is_tour($you);
if (!$practice && !dg_may_test($you)) {
  http_response_code(403);
  echo '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>The Dungeon</title>'
     . '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/casino/casino.css"></head><body>'
     . '<div class="locked"><h2>🏰 THE DUNGEON</h2><p>Still in the lab — admins and testers only.<br>'
     . 'It opens to the whole club once the economy checks out.</p>'
     . '<p style="margin-top:14px"><a href="/city/" style="color:#c4b5fd;font-weight:700;text-decoration:none">← back to the city</a></p></div>'
     . '</body></html>';
  exit;
}

$html = @file_get_contents(__DIR__ . '/game.html');
if ($html === false) { http_response_code(500); echo 'game.html missing'; exit; }

// ── serve-time patch ──
// Only the game draws from the seeded stream: its own Math.random( calls
// become JB.rng( (the bridge dispatches seeded vs native). Third-party
// code on the page (Tailwind's runtime!) keeps the real Math.random.
// replay/run.js applies the identical rewrite.
$html = str_replace('Math.random(', 'JB.rng(', $html, $rngPatched);
if ($rngPatched < 10) error_log("dungeon: only {$rngPatched} Math.random calls rewritten (new game version?)");

$cfg = [
  'you'      => (string)$you,
  'name'     => $me['username'],
  'practice' => $practice,
  'balance'  => (int)$me['sips_balance'],
  'api'      => 'api.php',
  'hof'      => (function () { $h = json_decode(@file_get_contents(DUNGEON_DATA . '/hof.json'), true);
                               return is_array($h) ? ['week' => $h['week'] ?? null, 'top' => array_slice($h['top'] ?? [], 0, 10)] : ['week' => null, 'top' => []]; })(),
  'prices'   => ['entry' => DUNGEON_ENTRY_SIPS, 'refill' => DUNGEON_REFILL_SIPS,
                 'refills' => DUNGEON_REFILLS_PER_RUN, 'clear' => DUNGEON_BOUNTY_CLEAR,
                 'br' => DUNGEON_BOUNTY_BR_WIN],
];
$inject = "\n  <meta name=\"jb-you\" content=\"" . htmlspecialchars($me['username'], ENT_QUOTES) . "\">\n"
        . "  <meta name=\"robots\" content=\"noindex, nofollow\">\n";
$html = preg_replace('/<meta charset="UTF-8">/', '$0' . $inject, $html, 1);

$debug = (!empty($_GET['debug']) && (dg_may_test($you) || $practice))
       ? "window.JB_CHECK_EVERY = " . max(1, (int)$_GET['debug']) . "; window.JB_DEBUG_STATE = 1; " : "";
if ($debug && !empty($_GET['trace']) && preg_match('/^(\d+)-(\d+)$/', $_GET['trace'], $tm))
  $debug .= "window.JB_TRACE_TICKS = [{$tm[1]}, {$tm[2]}]; ";
$tail = "\n<script>{$debug}window.JB_CFG = " . json_encode($cfg, JSON_UNESCAPED_UNICODE) . ";</script>\n"
      . "<script src=\"bridge.js?v=" . filemtime(__DIR__ . '/bridge.js') . "\"></script>\n"
      . "<script src=\"controls.js?v=" . filemtime(__DIR__ . '/controls.js') . "\"></script>\n</body>";
$html = preg_replace('/<\/body>/i', $tail, $html, 1);

header('Content-Type: text/html; charset=UTF-8');
header('Cache-Control: no-store');
echo $html;
