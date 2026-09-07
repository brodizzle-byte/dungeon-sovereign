#!/usr/bin/env node
'use strict';
/* Gladiator Nights — the lockstep relay.
 *
 *     node server/gladiator.js            (listens on 127.0.0.1:8787)
 *
 * Every machine simulates the whole arena itself; only INPUTS cross the
 * wire. So this process does not run the game. It does three things:
 *
 *   1. seats people into a match after checking a ticket PHP minted,
 *   2. decides, for each tick, the one authoritative set of inputs and
 *      broadcasts it,
 *   3. watches the state hashes clients report and calls a desync.
 *
 * Point 2 is the whole design. A client NEVER guesses what a missing
 * player did - if it did, two clients could guess differently and the
 * match would quietly fork. When somebody's packet is late the server
 * decides on their behalf (repeat their last input) and tells everyone
 * the same thing. Late players lose fidelity; the match stays true.
 *
 * The match's real result is not decided here either. Every input is
 * logged, and the bot replays the whole match afterwards with the same
 * headless engine that already verifies solo bounties - so the winner is
 * decided by a simulation nobody playing can reach.
 *
 * No dependencies on purpose: the droplet has node but no npm, and a
 * WebSocket server is a handshake and a frame parser.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.GLAD_PORT || '8787', 10);
const HOST = process.env.GLAD_HOST || '127.0.0.1';
const DATA = process.env.GLAD_DATA || path.join(__dirname, '..', 'data', 'matches');
const SECRET_FILE = process.env.GLAD_SECRET_FILE || path.join(__dirname, '..', 'data', 'gladiator.secret');

const TICK_MS = 1000 / 60;
const MIN_DELAY = 2;            // ticks of input delay, floor
const MAX_DELAY = 12;           // ~200ms; past here the match is unplayable anyway
const LATE_MS = 250;            // how long a tick waits for a straggler
const REDUNDANCY = 3;           // ticks of input repeated in every packet

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function log(...a) { console.log(new Date().toISOString(), ...a); }

let SECRET = process.env.GLAD_SECRET || '';
try { if (!SECRET) SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (e) {}
if (!SECRET) {
  console.error(`no shared secret: set GLAD_SECRET or write ${SECRET_FILE}`);
  process.exit(2);
}

/* ─────────────────────────── websocket ─────────────────────────── */
/* Just enough of RFC 6455 to carry small JSON both ways. */

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function frame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeUInt32BE(0, 2);
    head.writeUInt32BE(len, 6);
  }
  head[0] = 0x81;                      // FIN + text
  return Buffer.concat([head, payload]);
}

/* Pull whole frames out of a growing buffer. Returns [messages, rest]. */
function unframe(buf, state) {
  const out = [];
  for (;;) {
    if (buf.length < 2) break;
    const fin = (buf[0] & 0x80) !== 0;
    const op = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) break;
      len = buf.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (buf.length < 10) break;
      const hi = buf.readUInt32BE(2);
      if (hi !== 0) return [out, buf, true];        // >4GB frame: nonsense
      len = buf.readUInt32BE(6); off = 10;
    }
    if (masked) { if (buf.length < off + 4) break; off += 4; }
    if (buf.length < off + len) break;
    const maskKey = masked ? buf.slice(off - 4, off) : null;
    const body = buf.slice(off, off + len);
    if (maskKey) for (let i = 0; i < body.length; i++) body[i] ^= maskKey[i & 3];
    buf = buf.slice(off + len);

    if (op === 0x8) return [out, buf, true];        // close
    if (op === 0x9) { out.push({ ping: body }); continue; }
    if (op === 0xa) { out.push({ pong: true }); continue; }
    if (op === 0x1 || op === 0x0) {
      state.frag = (state.frag || '') + body.toString('utf8');
      if (fin) { out.push({ text: state.frag }); state.frag = ''; }
      continue;
    }
    // binary or anything else: not part of this protocol
  }
  return [out, buf, false];
}

/* ─────────────────────────── tickets ─────────────────────────── */
/* PHP mints `base64url(payload).base64url(hmac)`. It is the only thing
 * that decides who someone is - this process never sees a Discord login,
 * and never trusts a name the client sends. */

function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function checkTicket(ticket) {
  if (typeof ticket !== 'string' || ticket.length > 2048) return null;
  const dot = ticket.lastIndexOf('.');
  if (dot < 1) return null;
  const body = ticket.slice(0, dot);
  const sig = b64urlDecode(ticket.slice(dot + 1));
  const want = crypto.createHmac('sha256', SECRET).update(body).digest();
  if (sig.length !== want.length || !crypto.timingSafeEqual(sig, want)) return null;
  let p;
  try { p = JSON.parse(b64urlDecode(body).toString('utf8')); } catch (e) { return null; }
  if (!p || typeof p.m !== 'string' || typeof p.u !== 'string') return null;
  if (!p.e || Date.now() / 1000 > p.e) return null;
  return p;                               // { m: matchId, u: discordId, e: expiry }
}

/* ─────────────────────────── matches ─────────────────────────── */

const matches = new Map();

function loadMatch(id) {
  if (matches.has(id)) return matches.get(id);
  let def;
  try {
    def = JSON.parse(fs.readFileSync(path.join(DATA, `${id}.json`), 'utf8'));
  } catch (e) {
    return null;
  }
  const m = {
    id,
    seed: def.seed | 0,
    // Seat order is fixed by the file the bot wrote, NOT by who connects
    // first. Every client must build the same array in the same order or
    // the seat indices mean different people on different machines.
    roster: (def.seats || []).map((s, i) => ({
      seat: i,
      uid: String(s.uid),
      name: String(s.name || `Seat ${i + 1}`),
      classId: s.classId || 'knight',
      weaponId: s.weaponId || null,
      skinId: s.skinId || null,
      perk: s.perk || null,
      accessory: s.accessory || 'crown',
      capeStyle: s.capeStyle || 'grand',
    })),
    conns: new Map(),          // seat -> conn
    inputs: new Map(),         // tick -> { seat: packet }
    settled: new Map(),        // tick -> the authoritative set, once decided
    last: new Map(),           // seat -> last packet seen (what a straggler repeats)
    hashes: new Map(),         // tick -> { seat: hash }
    started: false,
    over: false,
    cursor: 0,                 // lowest tick not yet settled
    delay: MIN_DELAY,
    timer: null,
    logStream: null,
  };
  matches.set(id, m);
  return m;
}

function send(conn, obj) {
  if (conn.socket.destroyed) return;
  try { conn.socket.write(frame(JSON.stringify(obj))); } catch (e) {}
}

function broadcast(m, obj) {
  for (const c of m.conns.values()) send(c, obj);
}

/* The one authoritative input set for a tick. Called when every seat has
 * reported, or when the wait ran out - either way the answer is decided
 * HERE, once, and everybody is told the same thing. */
function settle(m, tick) {
  if (m.settled.has(tick)) return;
  const got = m.inputs.get(tick) || {};
  const by = {};
  for (const r of m.roster) {
    if (got[r.seat] !== undefined) {
      by[r.seat] = got[r.seat];
      m.last.set(r.seat, got[r.seat]);
    } else {
      // Late or gone: they keep doing whatever they were doing. Decided
      // once, by the server, so no two clients can guess differently.
      by[r.seat] = m.last.get(r.seat) || null;
    }
  }
  m.settled.set(tick, by);
  m.inputs.delete(tick);
  broadcast(m, { op: 'inputs', tick, by });
  if (m.logStream) m.logStream.write(JSON.stringify({ t: tick, by }) + '\n');

  // Keep the settled window small; a reconnecting client resyncs from a
  // snapshot rather than replaying an hour of history.
  if (m.settled.size > 600) {
    const oldest = tick - 600;
    for (const k of m.settled.keys()) if (k < oldest) m.settled.delete(k);
  }
}

function pump(m) {
  // Settle every tick that has a full house, in order.
  for (;;) {
    const got = m.inputs.get(m.cursor);
    if (!got) break;
    let full = true;
    for (const r of m.roster) if (got[r.seat] === undefined) { full = false; break; }
    if (!full) break;
    settle(m, m.cursor);
    m.cursor++;
  }
}

/* A straggler cannot hold the match forever. */
function sweep(m) {
  if (m.over || !m.started) return;
  const now = Date.now();
  if (m.cursor <= m.headTick && now - m.cursorSince > LATE_MS) {
    settle(m, m.cursor);
    m.cursor++;
    m.cursorSince = now;
    pump(m);
  }
}

function recomputeDelay(m) {
  // Input delay is set by the WORST connection in the match, because
  // lockstep moves at the pace of the slowest machine. Measured, not
  // guessed: a good lobby should not eat a conservative fixed 100ms.
  let worst = 0;
  for (const c of m.conns.values()) if (c.rtt > worst) worst = c.rtt;
  const ticks = Math.ceil((worst / 2) / TICK_MS) + 1;
  const d = Math.max(MIN_DELAY, Math.min(MAX_DELAY, ticks));
  if (d !== m.delay) {
    m.delay = d;
    broadcast(m, { op: 'delay', d });
    log(`match ${m.id}: input delay -> ${d} ticks (${(d * TICK_MS).toFixed(0)}ms), worst rtt ${worst.toFixed(0)}ms`);
  }
}

function checkHashes(m, tick) {
  const h = m.hashes.get(tick);
  if (!h) return;
  let seen = 0;
  for (const r of m.roster) if (h[r.seat] !== undefined) seen++;
  if (seen < 2) return;
  const vals = Object.values(h);
  const first = vals[0];
  if (vals.every(v => v === first)) { m.hashes.delete(tick); return; }
  m.over = true;
  log(`match ${m.id}: DESYNC at tick ${tick} ${JSON.stringify(h)}`);
  broadcast(m, { op: 'desync', tick, hashes: h });
  m.hashes.delete(tick);
}

function startIfReady(m) {
  if (m.started || m.over) return;
  for (const r of m.roster) if (!m.conns.has(r.seat)) return;
  m.started = true;
  m.cursor = 0;
  m.headTick = 0;
  m.cursorSince = Date.now();
  try {
    fs.mkdirSync(DATA, { recursive: true });
    m.logStream = fs.createWriteStream(path.join(DATA, `${m.id}.log`), { flags: 'a' });
    m.logStream.write(JSON.stringify({ seed: m.seed, seats: m.roster, at: Date.now() }) + '\n');
  } catch (e) { log(`match ${m.id}: cannot open input log`, e.message); }
  recomputeDelay(m);
  broadcast(m, { op: 'start', delay: m.delay });
  log(`match ${m.id}: START seed ${m.seed}, ${m.roster.length} seats`);
  m.timer = setInterval(() => sweep(m), 40);
}

function dropConn(m, conn) {
  if (m.conns.get(conn.seat) === conn) m.conns.delete(conn.seat);
  broadcast(m, { op: 'left', seat: conn.seat, name: conn.name });
  log(`match ${m.id}: seat ${conn.seat} (${conn.name}) left`);
  // The match does NOT stop. A disconnected seat keeps repeating its last
  // input and gets swept by the storm like anybody standing still, which
  // is both simpler and fairer than pausing everyone else.
  if (m.started && m.conns.size === 0) endMatch(m, 'everybody left');
}

function endMatch(m, why) {
  if (m.over) return;
  m.over = true;
  if (m.timer) clearInterval(m.timer);
  if (m.logStream) m.logStream.end();
  broadcast(m, { op: 'over', why });
  log(`match ${m.id}: over (${why})`);
  setTimeout(() => matches.delete(m.id), 30000);
}

/* ─────────────────────────── connections ─────────────────────────── */

function onMessage(conn, text) {
  let msg;
  try { msg = JSON.parse(text); } catch (e) { return; }
  if (!msg || typeof msg.op !== 'string') return;
  const m = conn.match;

  if (msg.op === 'input') {
    if (!m || !m.started || m.over) return;
    const list = Array.isArray(msg.in) ? msg.in : [];
    // Every packet repeats the last few ticks, so one dropped datagram
    // does not stall the barrier for everybody.
    for (const pair of list.slice(-REDUNDANCY * 2)) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      const t = pair[0] | 0;
      if (t < m.cursor || t > m.cursor + 600) continue;      // stale or absurd
      if (m.settled.has(t)) continue;                        // already decided
      let slot = m.inputs.get(t);
      if (!slot) { slot = {}; m.inputs.set(t, slot); }
      if (slot[conn.seat] === undefined) slot[conn.seat] = pair[1];
      if (t > m.headTick) m.headTick = t;
    }
    const before = m.cursor;
    pump(m);
    if (m.cursor !== before) m.cursorSince = Date.now();
    return;
  }

  if (msg.op === 'hash') {
    if (!m || m.over) return;
    const t = msg.tick | 0;
    let slot = m.hashes.get(t);
    if (!slot) { slot = {}; m.hashes.set(t, slot); }
    slot[conn.seat] = String(msg.h || '');
    checkHashes(m, t);
    return;
  }

  if (msg.op === 'done') {
    if (!m) return;
    conn.done = true;
    log(`match ${m.id}: seat ${conn.seat} finished (${msg.status || '?'}, placed ${msg.placed || '?'})`);
    let all = true;
    for (const c of m.conns.values()) if (!c.done) all = false;
    if (all) endMatch(m, 'all seats reported');
    return;
  }

  if (msg.op === 'pong') {
    if (conn.pingAt) {
      const rtt = Date.now() - conn.pingAt;
      conn.rtt = conn.rtt ? conn.rtt * 0.7 + rtt * 0.3 : rtt;
      conn.pingAt = 0;
      if (m && m.started) recomputeDelay(m);
    }
    return;
  }
}

function onJoin(conn, msg) {
  const t = checkTicket(msg && msg.ticket);
  if (!t) { send(conn, { op: 'denied', why: 'bad or expired ticket' }); conn.socket.end(); return; }
  const m = loadMatch(t.m);
  if (!m) { send(conn, { op: 'denied', why: 'no such match' }); conn.socket.end(); return; }
  if (m.over) { send(conn, { op: 'denied', why: 'match already over' }); conn.socket.end(); return; }

  // The seat comes from the roster the bot wrote, never from the client.
  const row = m.roster.find(r => r.uid === t.u);
  if (!row) { send(conn, { op: 'denied', why: 'not on the roster' }); conn.socket.end(); return; }
  const existing = m.conns.get(row.seat);
  if (existing && existing !== conn) { send(existing, { op: 'replaced' }); existing.socket.end(); }

  conn.match = m;
  conn.seat = row.seat;
  conn.uid = row.uid;
  conn.name = row.name;
  conn.joined = true;
  m.conns.set(row.seat, conn);

  send(conn, {
    op: 'seated',
    seat: row.seat,
    seed: m.seed,
    delay: m.delay,
    started: m.started,
    seats: m.roster.map(r => ({
      name: r.name, classId: r.classId, weaponId: r.weaponId, skinId: r.skinId,
      perk: r.perk, accessory: r.accessory, capeStyle: r.capeStyle,
    })),
  });
  broadcast(m, { op: 'here', seat: row.seat, name: row.name, of: m.roster.length, in: m.conns.size });
  log(`match ${m.id}: seat ${row.seat} (${row.name}) joined — ${m.conns.size}/${m.roster.length}`);
  startIfReady(m);
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, matches: matches.size }));
    return;
  }
  res.writeHead(426); res.end('websocket only');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
  );
  socket.setNoDelay(true);               // lockstep is latency, not throughput

  const conn = { socket, seat: -1, rtt: 0, pingAt: 0, joined: false, done: false, match: null, name: '?' };
  let buf = Buffer.alloc(0);
  const state = {};

  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > 1 << 20) { socket.destroy(); return; }   // nobody needs a megabyte
    const [msgs, rest, closed] = unframe(buf, state);
    buf = rest;
    for (const msg of msgs) {
      if (msg.ping) continue;
      if (msg.pong) { onMessage(conn, '{"op":"pong"}'); continue; }
      if (!msg.text) continue;
      if (!conn.joined) {
        let j; try { j = JSON.parse(msg.text); } catch (e) { continue; }
        if (j && j.op === 'join') onJoin(conn, j);
        continue;
      }
      onMessage(conn, msg.text);
    }
    if (closed) socket.end();
  });

  const ping = setInterval(() => {
    if (socket.destroyed) return;
    conn.pingAt = Date.now();
    send(conn, { op: 'ping' });
  }, 3000);

  const bye = () => {
    clearInterval(ping);
    if (conn.match && conn.joined) dropConn(conn.match, conn);
  };
  socket.on('close', bye);
  socket.on('error', bye);
});

server.listen(PORT, HOST, () => log(`gladiator relay on ${HOST}:${PORT}, matches from ${DATA}`));
