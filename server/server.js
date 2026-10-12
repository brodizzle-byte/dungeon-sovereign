#!/usr/bin/env node
'use strict';
/**
 * Dungeon Sovereign v7.0 — Unified Server
 *
 * Consolidates the static file serving, PHP API replacement (run verification,
 * seeds, bounties, hall of fame, ticket minting), and the Gladiator Nights
 * deterministic lockstep WebSocket relay into a single unified Node.js process.
 * Zero npm dependencies.
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const url = require('url');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const SimCore = require('../shared/sim-core.js');

const PORT = parseInt(process.env.PORT || process.env.GLAD_PORT || '8787', 10);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const MATCHES_DIR = path.join(DATA_DIR, 'matches');
const RUNS_DIR = path.join(DATA_DIR, 'runs');
const SECRET_FILE = path.join(DATA_DIR, 'gladiator.secret');

// Ensure data directories exist
[DATA_DIR, MATCHES_DIR, RUNS_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// Load or generate secret
let SECRET = process.env.GLAD_SECRET || '';
if (!SECRET && fs.existsSync(SECRET_FILE)) {
  SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
}
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('base64');
  fs.writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.wav':  'audio/wav',
  '.mp3':  'audio/mpeg',
  '.gz':   'application/gzip',
};

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

// ── Shared Hall of Fame & Run Verification ──
function getHoF() {
  const file = path.join(DATA_DIR, 'hof.json');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return { week: parsed.week || null, top: (parsed.top || []).slice(0, 10) };
  } catch (e) {
    return { week: null, top: [] };
  }
}

function saveHoF(entry) {
  const file = path.join(DATA_DIR, 'hof.json');
  let current = { week: 'Week 1', top: [] };
  try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  current.top = current.top || [];
  current.top.push(entry);
  current.top.sort((a, b) => (b.score || 0) - (a.score || 0));
  current.top = current.top.slice(0, 20);
  fs.writeFileSync(file, JSON.stringify(current, null, 2), 'utf8');
}

function verifyRunPayload(payload) {
  // Re-simulate the run using replay/run.js
  const tmpFile = path.join(RUNS_DIR, `verify-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(payload));
  try {
    const res = spawnSync(process.execPath, [
      path.join(ROOT_DIR, 'replay', 'run.js'),
      tmpFile,
      '--refills', String(payload.refills_used || 0)
    ], { encoding: 'utf8', timeout: 30000 });
    try { fs.unlinkSync(tmpFile); } catch (e) {}
    if (res.status !== 0) return { verified: false, error: res.stderr || 'Run re-simulation failed' };
    const out = JSON.parse(res.stdout.trim().split('\n').pop());
    const claimed = payload.claimed || {};
    const match = out.status === claimed.status &&
                  out.kills === claimed.kills &&
                  out.floor === claimed.floor &&
                  out.hash === claimed.hash;
    return { verified: match, result: out };
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch (e) {}
    return { verified: false, error: err.message };
  }
}

// ── WebSocket Protocol RFC 6455 ──
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
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
  head[0] = 0x81; // FIN + text
  return Buffer.concat([head, payload]);
}

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
      if (hi !== 0) return [out, buf, true];
      len = buf.readUInt32BE(6); off = 10;
    }
    if (masked) { if (buf.length < off + 4) break; off += 4; }
    if (buf.length < off + len) break;
    const maskKey = masked ? buf.slice(off - 4, off) : null;
    const body = buf.slice(off, off + len);
    if (maskKey) for (let i = 0; i < body.length; i++) body[i] ^= maskKey[i & 3];
    buf = buf.slice(off + len);

    if (op === 0x8) return [out, buf, true]; // close
    if (op === 0x9) { out.push({ ping: body }); continue; }
    if (op === 0xa) { out.push({ pong: true }); continue; }
    if (op === 0x1 || op === 0x0) {
      state.frag = (state.frag || '') + body.toString('utf8');
      if (fin) { out.push({ text: state.frag }); state.frag = ''; }
      continue;
    }
  }
  return [out, buf, false];
}

// ── Gladiator Lockstep Match Relay ──
const TICK_MS = 1000 / 60;
const MIN_DELAY = 2;
const MAX_DELAY = 12;
const LATE_MS = 250;
const REDUNDANCY = 3;
const DELAY_COOLDOWN_MS = 8000;

const liveMatches = new Map();

function mintTicket(user, matchId) {
  const payload = `${user}:${matchId}:${Date.now()}`;
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64');
}

function verifyTicket(ticketStr) {
  try {
    const raw = Buffer.from(ticketStr, 'base64').toString('utf8');
    const parts = raw.split(':');
    if (parts.length !== 4) return null;
    const [user, matchId, ts, sig] = parts;
    const expected = crypto.createHmac('sha256', SECRET).update(`${user}:${matchId}:${ts}`).digest('hex');
    if (expected !== sig) return null;
    return { user, matchId, ts: parseInt(ts, 10) };
  } catch (e) {
    return null;
  }
}

class GladiatorMatch {
  constructor(id, roster) {
    this.id = id;
    this.roster = roster;
    this.seats = roster.seats || [];
    this.seed = roster.seed || (Math.floor(Math.random() * 1000000) >>> 0);
    this.clients = new Map();
    this.tick = 0;
    this.delay = 3;
    this.running = false;
    this.stalled = false;
    this.timer = null;
    this.inputs = new Map();
    this.history = [];
  }

  join(ws, seatIndex, userName) {
    this.clients.set(seatIndex, { ws, name: userName });
    log(`Match ${this.id}: seat ${seatIndex} (${userName}) joined`);
    if (this.clients.size === this.seats.length && !this.running) {
      this.start();
    }
  }

  broadcast(msg) {
    const data = frame(JSON.stringify(msg));
    for (const [s, c] of this.clients.entries()) {
      try { c.ws.write(data); } catch (e) {}
    }
  }

  start() {
    this.running = true;
    log(`Match ${this.id} starting with ${this.seats.length} seats`);
    this.broadcast({ type: 'start', seed: this.seed, delay: this.delay, seats: this.seats });
    this.step();
  }

  step() {
    if (!this.running) return;
    const t = this.tick;
    const roundInputs = {};
    for (let i = 0; i < this.seats.length; i++) {
      const q = this.inputs.get(i) || [];
      const inp = q.find(x => x.tick === t);
      roundInputs[i] = inp ? inp.packet : { k: 0, m: [0,0], t: [0,0,0], f: null, a: [] };
    }
    this.history.push({ tick: t, by: roundInputs });
    this.broadcast({ type: 'settled', tick: t, by: roundInputs });
    this.tick++;
    this.timer = setTimeout(() => this.step(), TICK_MS);
  }

  end(reason) {
    this.running = false;
    clearTimeout(this.timer);
    this.broadcast({ type: 'end', reason: reason || 'Match ended' });
    liveMatches.delete(this.id);
  }
}

// ── HTTP Request Handler ──
function handleRequest(req, res) {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, status: 'healthy', version: 'v7.0', uptime: process.uptime() }));
    return;
  }

  // API handling (api.php or /api/)
  if (pathname === '/api.php' || pathname.startsWith('/api/')) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let params = {};
      try {
        if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
          params = JSON.parse(body);
        } else {
          params = Object.fromEntries(new URLSearchParams(body));
        }
      } catch (e) {
        params = Object.fromEntries(new URLSearchParams(body));
      }
      const op = params.op || parsedUrl.query.op;

      if (op === 'start') {
        const runId = crypto.randomUUID();
        const seed = crypto.randomInt(1, 0x7fffffff);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: runId, seed, refills_left: 3 }));
        return;
      }

      if (op === 'refill') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, refills_left: 2 }));
        return;
      }

      if (op === 'claim') {
        let payload = null;
        try {
          payload = typeof params.payload === 'string' ? JSON.parse(params.payload) : params.payload;
        } catch (e) {
          payload = params;
        }
        if (!payload || !payload.claimed) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'missing payload' }));
          return;
        }
        const verification = verifyRunPayload(payload);
        if (verification.verified) {
          const entry = {
            name: payload.name || 'Anonymous Sovereign',
            date: new Date().toISOString().slice(0, 10),
            mode: payload.mode || 'Story',
            class: (payload.loadout && payload.loadout.c) || 'Knight',
            result: payload.claimed.status === 'CLEARED' ? 'Floor 10 Clear' : `Floor ${payload.claimed.floor} Final`,
            score: payload.claimed.score || 0,
            kills: payload.claimed.kills || 0,
            cause: payload.claimed.status === 'CLEARED' ? 'Victorious Sovereign' : 'Battle Slain',
          };
          saveHoF(entry);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, verified: verification.verified, result: verification.result }));
        return;
      }

      if (op === 'match') {
        const matchId = `match-${Date.now()}`;
        const user = params.user || 'Sovereign_1';
        const ticket = mintTicket(user, matchId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, matchId, ticket, wsUrl: `ws://${req.headers.host || '127.0.0.1:8787'}/dgws` }));
        return;
      }

      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: `unknown op ${op}` }));
    });
    return;
  }

  // Static files & game.html serve-time patch
  let filePath = path.join(ROOT_DIR, pathname === '/' ? 'game.html' : pathname);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(ROOT_DIR, 'game.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  if (ext === '.html') {
    fs.readFile(filePath, 'utf8', (err, html) => {
      if (err) {
        res.writeHead(500); res.end('Error loading game'); return;
      }
      // Apply Math.random -> JB.rng rewrite scoped strictly to GameEngine
      html = html.replace(
        /(<script(?![^>]*\bsrc=)[^>]*>)([\s\S]*?)(<\/script>)/gi,
        (m, p1, body, p3) => {
          if (!body.includes('GameEngine')) return m;
          return p1 + body.split('Math.random(').join('JB.rng(') + p3;
        }
      );

      const cfg = {
        you: 'Sovereign Player',
        name: 'Sovereign',
        practice: false,
        balance: 1000,
        api: 'api.php',
        hof: getHoF(),
        prices: { entry: 20, refill: 10, refills: 3, clear: 500, br: 250 },
      };

      const inject = `\n  <meta name="jb-you" content="Sovereign Player">\n  <meta name="robots" content="noindex, nofollow">\n`;
      html = html.replace(/<meta charset="UTF-8">/i, '$&' + inject);

      const tail = `\n<script>window.JB_CFG = ${JSON.stringify(cfg)};</script>\n`
                 + `<script src="shared/sim-core.js"></script>\n`
                 + `<script src="bridge.js"></script>\n`
                 + `<script src="controls.js"></script>\n</body>`;
      html = html.replace(/<\/body>/i, tail);

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    });
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404); res.end('File not found'); return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// ── Create Unified Server ──
const server = http.createServer(handleRequest);

// ── WebSocket Upgrade Handler ──
server.on('upgrade', (req, socket, head) => {
  const reqUrl = url.parse(req.url, true);
  if (reqUrl.pathname !== '/dgws') {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }

  const accept = acceptKey(key);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  let buf = Buffer.alloc(0);
  const state = {};

  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    const [messages, rest, close] = unframe(buf, state);
    buf = rest;
    if (close) { socket.end(); return; }
    for (const msg of messages) {
      if (msg.ping) { socket.write(frame(JSON.stringify({ pong: true }))); continue; }
      if (!msg.text) continue;
      try {
        const data = JSON.parse(msg.text);
        if (data.type === 'join') {
          const auth = verifyTicket(data.ticket);
          const matchId = (auth && auth.matchId) || data.match || 'default';
          let match = liveMatches.get(matchId);
          if (!match) {
            match = new GladiatorMatch(matchId, { seats: [{ name: 'Player1' }, { name: 'Player2' }], seed: 4242 });
            liveMatches.set(matchId, match);
          }
          match.join(socket, match.clients.size, (auth && auth.user) || 'Player');
        } else if (data.type === 'input') {
          // Record client input for settled tick
          const match = Array.from(liveMatches.values()).find(m => Array.from(m.clients.values()).some(c => c.ws === socket));
          if (match) {
            const seat = Array.from(match.clients.entries()).find(([, c]) => c.ws === socket)[0];
            const q = match.inputs.get(seat) || [];
            q.push({ tick: data.tick, packet: data.packet });
            match.inputs.set(seat, q);
          }
        }
      } catch (e) {
        log('Error parsing WS frame:', e);
      }
    }
  });

  socket.on('error', () => {});
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    log(`🏰 Dungeon Sovereign v7.0 Unified Server live on http://${HOST}:${PORT}`);
    log(`WebSocket Lockstep Relay listening on ws://${HOST}:${PORT}/dgws`);
  });
}

module.exports = { server, handleRequest, GladiatorMatch };
