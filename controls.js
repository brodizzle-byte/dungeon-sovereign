/* JuiceBox controls layer for Dungeon Sovereign (play mode only).
 *
 * Touch controls that live OFF the playfield: a joystick or 8-way D-pad
 * plus the four action buttons, in the black side areas in landscape and
 * under the canvas in portrait. Canvas taps only aim. Attacks keep the
 * last aim vector (the sim already does that; nothing here ever clears
 * player.facing), with an optional soft aim-assist built on the game's
 * own getSmartAimAngle(). A ⚙️ settings panel remembers the choices.
 *
 * Determinism: every widget writes ONLY the four inputs the simulation
 * reads (game.keys, game.touchMovement, player.facing, the action
 * methods) — exactly what bridge.js snapshots into the run log — so a
 * run played with these controls replays identically on the server.
 * Preferences never touch simulation state.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.JB || window.JB.mode !== 'play') return;
  const rst = window.JB.realSetTimeout || window.setTimeout.bind(window);
  const rct = window.JB.realClearTimeout || window.clearTimeout.bind(window);
  const PREF_KEY = 'jb_controls_v1';
  const DEF = { scheme: 'stick', layout: 'auto', size: 'm', lefty: false, aimTap: true, aimAssist: null };
  const SIZES = { s: { btn: 52, stick: 110, dpad: 126 }, m: { btn: 64, stick: 132, dpad: 150 }, l: { btn: 78, stick: 154, dpad: 174 } };
  const coarse = (window.matchMedia && matchMedia('(pointer: coarse)').matches) || ('ontouchstart' in window);

  let prefs = load();
  function load() {
    try { return Object.assign({}, DEF, JSON.parse(localStorage.getItem(PREF_KEY) || '{}')); }
    catch (e) { return Object.assign({}, DEF); }
  }
  function save() { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) {} }
  function assistOn() { return prefs.aimAssist === null ? coarse : !!prefs.aimAssist; }
  function G() { return (typeof game !== 'undefined') ? game : null; }
  function playing() { const g = G(); return !!(g && g.state === STATES.PLAYING && g.player); }

  /* ───────────── CSS ───────────── */
  const css = `
#jb-left,#jb-right,#jb-bottom{display:none}
body.jb-touch #floating-action-cluster,body.jb-touch #hud-footer{display:none!important}
/* phones report 100vh as the tallest the page COULD be (URL bar hidden), so a
   100vh body hangs below the fold and everything anchored to the bottom gets
   clipped in landscape — dvh is the visible height right now */
body.jb-touch{height:100dvh!important;max-height:100dvh!important}
/* action log to the UPPER left: the bottom edge is exactly what gets cut off.
   A phone canvas is ~311px, so the whole top strip has to be re-stacked:
   log left, killfeed right (both 46% so they never meet), banners below. */
body.jb-touch #combat-log{top:8px;bottom:auto;max-width:46%;z-index:15}
body.jb-touch #arena-killfeed{left:auto;right:8px;max-width:46%;align-items:flex-end;text-align:right}
body.jb-touch #arena-storm-warning,body.jb-touch #grace-period-banner,
body.jb-touch #infusion-reward-banner{top:96px}
/* boss floors: the boss bar owns the top strip. Titan names are long enough
   to wrap to two lines on a phone, so clip the name and keep the bar one row,
   then shift the log under it (the game flips this element's inline display
   to flex when a boss spawns). */
body.jb-touch #boss-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:62%}
body.jb-touch #boss-hud-overlay[style*="flex"] ~ #combat-log{top:76px}
body.jb-touch #boss-hud-overlay[style*="flex"] ~ #grace-period-banner,
body.jb-touch #boss-hud-overlay[style*="flex"] ~ #infusion-reward-banner{top:164px}
body.jb-touch.jb-land main{flex-direction:row!important;padding:4px!important;gap:4px}
body.jb-touch.jb-land #jb-left,body.jb-touch.jb-land #jb-right{display:flex;flex:1 1 0;height:100%;min-width:0;align-items:center;justify-content:center}
body.jb-touch.jb-land #viewport-wrapper{width:auto!important;height:100%!important;flex:0 0 auto}
body.jb-touch.jb-port main{flex-direction:column!important;padding:4px!important;gap:4px}
body.jb-touch.jb-port #viewport-wrapper{width:100%!important;height:auto!important;max-height:calc(100% - 150px)!important;flex:0 1 auto}
body.jb-touch.jb-port #jb-bottom{display:flex;flex:1 1 0;min-height:150px;width:100%;align-items:center;justify-content:space-around;padding:0 6px}
.jb-zone,.jb-zone *{touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}
.jb-stick{position:relative;border-radius:50%;background:radial-gradient(circle,rgba(0,240,255,.16) 0%,rgba(15,23,42,.9) 72%);border:2px solid rgba(0,240,255,.55);box-shadow:0 0 18px rgba(0,240,255,.25)}
.jb-knob{position:absolute;left:50%;top:50%;border-radius:50%;transform:translate(-50%,-50%);background:radial-gradient(circle,#00f0ff,#0284c7);border:2px solid #fff;box-shadow:0 0 12px #00f0ff;pointer-events:none}
.jb-dpad{display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(3,1fr);gap:3px}
.jb-dpad div{background:rgba(15,23,42,.9);border:1px solid rgba(0,240,255,.4);border-radius:9px;display:flex;align-items:center;justify-content:center;color:#7dd3fc;font:900 15px "JetBrains Mono",monospace}
.jb-dpad div.on{background:rgba(0,240,255,.4);border-color:#00f0ff;color:#fff}
.jb-dpad div.c{background:transparent;border:0}
.jb-acts{display:grid;grid-template-columns:1fr 1fr;gap:9px}
.jb-btn{position:relative;border-radius:16px;border:2px solid;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;color:#fff;font:900 10px "JetBrains Mono",monospace;letter-spacing:.05em;box-shadow:0 8px 20px rgba(0,0,0,.6);transition:transform .06s}
.jb-btn .e{font-size:22px;line-height:1}
.jb-btn.down{transform:scale(.9);filter:brightness(1.35)}
.jb-btn.atk{background:linear-gradient(135deg,#e11d48,#7f1d1d);border-color:#fb7185}
.jb-btn.skl{background:linear-gradient(135deg,#0891b2,#0f172a);border-color:#22d3ee}
.jb-btn.rol{background:linear-gradient(135deg,#d97706,#78350f);border-color:#fbbf24}
.jb-btn.sip{background:linear-gradient(135deg,#059669,#064e3b);border-color:#34d399}
.jb-badge{position:absolute;top:-7px;right:-7px;padding:1px 7px;border-radius:999px;background:linear-gradient(90deg,#ec4899,#f43f5e);border:1px solid #fbcfe8;font:900 10px "JetBrains Mono",monospace}
#jb-settings{position:fixed;inset:0;z-index:10000;background:rgba(3,5,10,.93);display:flex;align-items:center;justify-content:center;padding:12px;font-family:"JetBrains Mono",monospace;color:#e2e8f0}
#jb-settings .box{background:#0f172a;border:2px solid #7C3AED;border-radius:16px;padding:14px 16px;width:min(94vw,440px);max-height:92vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.7)}
#jb-settings h3{margin:0 0 8px;font:900 14px Cinzel,serif;color:#c4b5fd;letter-spacing:.08em}
.jb-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 0;border-bottom:1px solid #1e293b;font-size:12px}
.jb-row small{display:block;color:#64748b;font-size:10px}
.jb-seg{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end}
.jb-seg button{padding:5px 9px;border-radius:8px;border:1px solid #334155;background:#1e293b;color:#cbd5e1;font:800 11px "JetBrains Mono",monospace}
.jb-seg button.on{background:#7C3AED;border-color:#a78bfa;color:#fff}
.jb-keys{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;font-size:11px;color:#94a3b8;margin-top:8px}
.jb-keys b{color:#e2e8f0;background:#1e293b;border:1px solid #334155;border-radius:5px;padding:0 6px;text-align:center}
#jb-settings .foot{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
#jb-settings .foot button{padding:8px 14px;border-radius:10px;border:0;font:900 12px "JetBrains Mono",monospace}
`;
  const style = document.createElement('style');
  style.id = 'jb-controls-css';
  style.textContent = css;
  document.head.appendChild(style);

  /* ───────────── input writers (the ONLY sim writes in this file) ───────────── */
  function setMove(active, x, y) {
    const g = G(); if (!g) return;
    g.touchMovement.active = active; g.touchMovement.x = x; g.touchMovement.y = y;
  }
  function setKeys(w, a, s, d) {
    const g = G(); if (!g) return;
    g.keys['w'] = w; g.keys['a'] = a; g.keys['s'] = s; g.keys['d'] = d;
    if (g.touchMovement.active) setMove(false, 0, 0);     // keys are ignored while touch is "active"
  }
  function setFacing(x, y) {
    const g = G(); if (!g || !g.player) return;
    const len = Math.hypot(x, y); if (!(len > 0)) return;
    g.player.facing = { x: x / len, y: y / len };
    g.player.facingAngle = Math.atan2(y / len, x / len);
  }
  function act(name) { const g = G(); if (g && typeof g[name] === 'function') g[name](); }

  /* ───────────── widgets ───────────── */
  const els = { left: null, right: null, bottom: null, move: null, acts: null, badge: null, gear: null };

  function buildStick(px) {
    const base = document.createElement('div');
    base.className = 'jb-stick jb-zone';
    base.style.width = base.style.height = px + 'px';
    const knob = document.createElement('div');
    knob.className = 'jb-knob';
    knob.style.width = knob.style.height = Math.round(px * 0.42) + 'px';
    base.appendChild(knob);
    const maxR = px * 0.36;
    let id = null;
    const move = (e) => {
      const r = base.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      let dx = e.clientX - cx, dy = e.clientY - cy;
      const d = Math.hypot(dx, dy);
      const mag = Math.min(1, d / maxR);
      if (d > 0) { dx /= d; dy /= d; }
      const vx = dx * mag, vy = dy * mag;
      knob.style.left = (50 + (vx * maxR / px) * 100) + '%';
      knob.style.top = (50 + (vy * maxR / px) * 100) + '%';
      setMove(true, vx, vy);
      if (mag > 0.1) setFacing(dx, dy);                   // same rule as the game's own stick
    };
    const end = () => {
      id = null;
      knob.style.left = knob.style.top = '50%';
      setMove(false, 0, 0);                                // facing stays: attacks remember it
    };
    base.addEventListener('pointerdown', (e) => {
      if (id !== null) return;
      id = e.pointerId; e.preventDefault();
      try { base.setPointerCapture(id); } catch (err) {}
      move(e);
    });
    base.addEventListener('pointermove', (e) => { if (e.pointerId === id) move(e); });
    const up = (e) => { if (e.pointerId === id) end(); };
    base.addEventListener('pointerup', up);
    base.addEventListener('pointercancel', up);
    base.addEventListener('lostpointercapture', up);
    return base;
  }

  const DIRS = [['nw', '↖'], ['n', '▲'], ['ne', '↗'], ['w', '◀'], ['c', ''], ['e', '▶'], ['sw', '↙'], ['s', '▼'], ['se', '↘']];
  function buildDpad(px) {
    const pad = document.createElement('div');
    pad.className = 'jb-dpad jb-zone';
    pad.style.width = pad.style.height = px + 'px';
    const cells = {};
    for (const [k, label] of DIRS) {
      const c = document.createElement('div');
      c.dataset.d = k; c.textContent = label;
      if (k === 'c') c.className = 'c';
      pad.appendChild(c); cells[k] = c;
    }
    let id = null, cur = null;
    const apply = (k) => {
      if (k === cur) return;
      cur = k;
      for (const key in cells) cells[key].classList.toggle('on', key === k && k !== 'c');
      const d = k || '';
      setKeys(d.includes('n'), d.includes('w'), d.includes('s'), d.includes('e'));
    };
    const at = (e) => {
      const r = pad.getBoundingClientRect();
      const col = Math.min(2, Math.max(0, Math.floor((e.clientX - r.left) / (r.width / 3))));
      const row = Math.min(2, Math.max(0, Math.floor((e.clientY - r.top) / (r.height / 3))));
      return DIRS[row * 3 + col][0];
    };
    pad.addEventListener('pointerdown', (e) => {
      if (id !== null) return;
      id = e.pointerId; e.preventDefault();
      try { pad.setPointerCapture(id); } catch (err) {}
      apply(at(e));
    });
    pad.addEventListener('pointermove', (e) => { if (e.pointerId === id) apply(at(e)); });
    const up = (e) => { if (e.pointerId === id) { id = null; apply(null); } };
    pad.addEventListener('pointerup', up);
    pad.addEventListener('pointercancel', up);
    pad.addEventListener('lostpointercapture', up);
    return pad;
  }

  function buildActs(px) {
    const wrap = document.createElement('div');
    wrap.className = 'jb-acts jb-zone';
    const mk = (cls, emoji, label, fn, repeat) => {
      const b = document.createElement('div');
      b.className = 'jb-btn ' + cls;
      b.style.width = b.style.height = px + 'px';
      b.innerHTML = '<span class="e">' + emoji + '</span><span>' + label + '</span>';
      let id = null, timer = null;
      const fire = () => { act(fn); if (repeat) timer = rst(fire, 150); };
      b.addEventListener('pointerdown', (e) => {
        if (id !== null) return;
        id = e.pointerId; e.preventDefault(); b.classList.add('down');
        try { b.setPointerCapture(id); } catch (err) {}
        fire();
      });
      const up = (e) => { if (e.pointerId === id) { id = null; b.classList.remove('down'); if (timer) { rct(timer); timer = null; } } };
      b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('lostpointercapture', up);
      return b;
    };
    wrap.appendChild(mk('atk', '⚔️', 'ATK', 'playerAttack', true));
    wrap.appendChild(mk('skl', '✨', 'SKILL', 'playerSkill', false));
    wrap.appendChild(mk('rol', '💨', 'ROLL', 'playerDodge', false));
    const sip = mk('sip', '🧪', 'SIP', 'playerSip', false);
    const badge = document.createElement('span');
    badge.className = 'jb-badge'; badge.textContent = '3';
    sip.appendChild(badge); els.badge = badge;
    wrap.appendChild(sip);
    return wrap;
  }

  /* ───────────── layout ───────────── */
  function layoutMode() {
    if (prefs.layout === 'off') return null;
    if (prefs.layout === 'sides') return 'land';
    if (prefs.layout === 'bottom') return 'port';
    if (!coarse) return null;                                // desktop: author's layout
    return innerWidth > innerHeight ? 'land' : 'port';
  }
  function ensureZones() {
    const main = document.querySelector('main');
    const wrap = document.getElementById('viewport-wrapper');
    if (!main || !wrap) return false;
    if (!els.left) {
      els.left = document.createElement('div'); els.left.id = 'jb-left';
      els.right = document.createElement('div'); els.right.id = 'jb-right';
      els.bottom = document.createElement('div'); els.bottom.id = 'jb-bottom';
      main.insertBefore(els.left, wrap);
      main.appendChild(els.right);
      main.appendChild(els.bottom);
    }
    return true;
  }
  function applyLayout() {
    if (!ensureZones()) return;
    const mode = layoutMode();
    document.body.classList.toggle('jb-touch', !!mode);
    document.body.classList.toggle('jb-land', mode === 'land');
    document.body.classList.toggle('jb-port', mode === 'port');
    // rebuild widgets from prefs
    const sz = SIZES[prefs.size] || SIZES.m;
    if (els.move) els.move.remove();
    if (els.acts) els.acts.remove();
    setMove(false, 0, 0); setKeys(false, false, false, false);
    if (!mode) return;
    els.move = prefs.scheme === 'dpad' ? buildDpad(sz.dpad) : buildStick(sz.stick);
    els.acts = buildActs(sz.btn);
    if (mode === 'land') {
      (prefs.lefty ? els.right : els.left).appendChild(els.move);
      (prefs.lefty ? els.left : els.right).appendChild(els.acts);
    } else {
      els.bottom.innerHTML = '';
      if (prefs.lefty) { els.bottom.appendChild(els.acts); els.bottom.appendChild(els.move); }
      else { els.bottom.appendChild(els.move); els.bottom.appendChild(els.acts); }
    }
  }
  let resizeT = null;
  const onResize = () => { rct(resizeT); resizeT = rst(applyLayout, 120); };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  // sip badge follows the player
  (function badgeLoop() {
    const g = G();
    if (els.badge && g && g.player) els.badge.textContent = String(g.player.sips);
    rst(badgeLoop, 250);
  })();

  /* ───────────── canvas: aim only (touch layout) ───────────── */
  function aimAt(clientX, clientY) {
    const g = G(); if (!g || !g.player || !prefs.aimTap) return;
    const rect = g.canvas.getBoundingClientRect();
    if (!rect.width) return;
    const wx = (clientX - rect.left) * (480 / rect.width) + g.cam.x;
    const wy = (clientY - rect.top) * (480 / rect.height) + g.cam.y;
    const dx = wx - g.player.x, dy = wy - g.player.y;
    if (Math.hypot(dx, dy) > 15) setFacing(dx, dy);
  }
  function installCanvasAim() {
    const wrap = document.getElementById('viewport-wrapper');
    if (!wrap) return;
    const own = () => document.body.classList.contains('jb-touch');
    // capture phase on the same element fires BEFORE the author's bubble
    // listeners — so in touch layout nothing on the canvas moves you
    for (const t of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
      wrap.addEventListener(t, (e) => {
        if (!own()) return;
        e.stopImmediatePropagation();
        if (t === 'touchstart' && e.changedTouches.length && playing()) {
          const tt = e.changedTouches[0];
          if (!(tt.target && tt.target.closest && tt.target.closest('button'))) aimAt(tt.clientX, tt.clientY);
        }
      }, { capture: true, passive: t !== 'touchstart' });
    }
    wrap.addEventListener('pointerdown', (e) => {
      if (!own() || e.pointerType === 'touch') return;      // touch handled above
      if (playing() && !(e.target.closest && e.target.closest('button'))) aimAt(e.clientX, e.clientY);
    }, { capture: true });
  }

  /* ───────────── aim assist (soft snap, deterministic) ───────────── */
  function installAimAssist() {
    const P = GameEngine.prototype;
    for (const name of ['playerAttack', 'playerSkill']) {
      const inner = P[name];
      P[name] = function () {
        if (assistOn() && !window.JB.inTick && this.state === STATES.PLAYING && this.player && this.player.facing
            && typeof this.getSmartAimAngle === 'function') {
          const f = this.player.facing;
          const a0 = Math.atan2(f.y, f.x);
          const a1 = this.getSmartAimAngle(a0);
          if (a1 !== a0) setFacing(Math.cos(a1), Math.sin(a1));   // logged by the bridge next tick
        }
        return inner.apply(this, arguments);
      };
    }
  }

  /* ───────────── settings panel ───────────── */
  let panel = null, wasPlaying = false;
  function seg(label, sub, options, get, set) {
    const row = document.createElement('div'); row.className = 'jb-row';
    const l = document.createElement('div'); l.innerHTML = label + (sub ? '<small>' + sub + '</small>' : '');
    const s = document.createElement('div'); s.className = 'jb-seg';
    const paint = () => { for (const b of s.children) b.classList.toggle('on', b.dataset.v === String(get())); };
    for (const [v, text] of options) {
      const b = document.createElement('button'); b.dataset.v = String(v); b.textContent = text;
      b.onclick = () => { set(v); save(); paint(); applyLayout(); };
      s.appendChild(b);
    }
    paint(); row.appendChild(l); row.appendChild(s);
    return row;
  }
  function openSettings() {
    if (panel) return;
    const g = G();
    wasPlaying = !!(g && g.state === STATES.PLAYING);
    if (wasPlaying) g.setState(STATES.PAUSED);
    panel = document.createElement('div'); panel.id = 'jb-settings';
    const box = document.createElement('div'); box.className = 'box';
    box.innerHTML = '<h3>🎮 CONTROLS</h3>';
    box.appendChild(seg('Movement', 'touch layout only', [['stick', '🕹️ Joystick'], ['dpad', '✚ D-pad']],
      () => prefs.scheme, v => { prefs.scheme = v; }));
    box.appendChild(seg('Layout', 'auto = sides in landscape, below in portrait',
      [['auto', 'Auto'], ['sides', 'Sides'], ['bottom', 'Below'], ['off', 'Original']],
      () => prefs.layout, v => { prefs.layout = v; }));
    box.appendChild(seg('Button size', '', [['s', 'S'], ['m', 'M'], ['l', 'L']], () => prefs.size, v => { prefs.size = v; }));
    box.appendChild(seg('Left-handed', 'swap the two sides', [[false, 'No'], [true, 'Yes']], () => prefs.lefty, v => { prefs.lefty = v; }));
    box.appendChild(seg('Tap canvas to aim', 'attacks keep the last aim until you change it', [[true, 'On'], [false, 'Off']],
      () => prefs.aimTap, v => { prefs.aimTap = v; }));
    box.appendChild(seg('Aim assist', 'nudges attacks toward the nearest enemy in front of you',
      [[null, 'Auto'], [true, 'On'], [false, 'Off']], () => prefs.aimAssist, v => { prefs.aimAssist = v; }));
    const keys = document.createElement('div'); keys.className = 'jb-keys';
    keys.innerHTML = '<b>W A S D</b><span>move (arrows work too)</span><b>J</b><span>attack</span><b>K</b><span>class skill</span>'
      + '<b>L</b><span>dodge roll</span><b>H</b><span>take a sip</span><b>I</b><span>inventory</span><b>P / Esc</b><span>pause</span>';
    box.appendChild(keys);
    const foot = document.createElement('div'); foot.className = 'foot';
    const reset = document.createElement('button'); reset.textContent = 'Reset'; reset.style.cssText = 'background:#334155;color:#e2e8f0';
    reset.onclick = () => { prefs = Object.assign({}, DEF); save(); closeSettings(); applyLayout(); openSettings(); };
    const done = document.createElement('button'); done.textContent = wasPlaying ? 'Resume' : 'Done'; done.style.cssText = 'background:#7C3AED;color:#fff';
    done.onclick = closeSettings;
    foot.appendChild(reset); foot.appendChild(done); box.appendChild(foot);
    panel.appendChild(box); document.body.appendChild(panel);
  }
  function closeSettings() {
    if (!panel) return;
    panel.remove(); panel = null;
    const g = G();
    if (wasPlaying && g && g.state === STATES.PAUSED) g.setState(STATES.PLAYING);
    wasPlaying = false;
  }
  window.addEventListener('keydown', (e) => {
    if (!panel) return;
    e.stopImmediatePropagation();
    if (e.key === 'Escape') closeSettings();
  }, { capture: true });

  function mountButtons() {
    const right = document.querySelector('#hud-header > div:last-child');
    const ref = document.getElementById('btn-pause-toggle');
    if (right) {
      const b = document.createElement('button');
      b.id = 'jb-gear'; b.textContent = '⚙️';
      b.className = ref ? ref.className : '';
      b.title = 'Controls';
      b.onclick = openSettings;
      right.appendChild(b); els.gear = b;
    }
    const col = document.querySelector('#screen-paused .flex.flex-col.gap-2');
    const audio = document.getElementById('btn-pause-audio');
    if (col) {
      const b = document.createElement('button');
      b.id = 'jb-pause-controls'; b.textContent = '🎮 Controls';
      b.className = audio ? audio.className : '';
      b.onclick = openSettings;
      col.insertBefore(b, audio ? audio.nextSibling : null);
    }
  }

  function mount() {
    if (!G()) { rst(mount, 50); return; }
    mountButtons();
    installCanvasAim();
    installAimAssist();
    applyLayout();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  window.JB.controls = {
    get prefs() { return prefs; },
    set(p) { Object.assign(prefs, p); save(); applyLayout(); },
    open: openSettings, close: closeSettings, applyLayout, layoutMode, coarse,
  };
})();
