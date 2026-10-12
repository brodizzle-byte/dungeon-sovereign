# 🏰 Dungeon Sovereign v7.0: 2.5D Overhaul, Lockstep Unity & Synergies

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-brightgreen.svg)](https://nodejs.org)
[![Status](https://img.shields.io/badge/Determinism-ALL%20GREEN-success.svg)](replay/parity.js)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An atmospheric, deterministic 2.5D action rogue-lite dungeon crawler and Gladiator PvP arena built on obsidian stone aesthetics, fixed-point deterministic kinematics, and multi-client lockstep networking.

---

## ⚡ Key Overhaul Pillars (v7.0)

### 1. Architectural Unification & Agnostic Core
* **Unified Node.js Architecture (`server/server.js`)**: Consolidates static asset serving, ticket minting, run verification, Hall of Fame persistence, and WebSocket lockstep multiplayer into a zero-dependency unified process.
* **Agnostic Simulation Core (`shared/sim-core.js`)**: Pure, bit-identical portable trigonometric math (`pSin`, `pCos`, `pAtan2`, `pHypot`), seeded PRNG (`mulberry32`), fixed-point quantization (`q2`, `q256`, `q1024`), state hashing (`fnv1a`), and collision resolution shared seamlessly across client and server.
* **Worker-Thread Parity Offloading (`worker-parity.js`)**: State checkpoint serialization and FNV-1a hashing offloaded to background Web Workers to maintain locked 60 FPS rendering on the main thread.

### 2. Visceral Combat & Kinematics
* **Micro-Hitstops & Camera Trauma**: 3–6 freeze frames on heavy blows, finishers, and critical strikes. Directional, deterministic trauma-decay screen shake replacing random jitter.
* **3-Stage Combo Cadence**: Light $\to$ Light $\to$ Heavy Finisher with a strict 0.4s decay window and 150ms tail-input buffering. Finishers deliver 1.6× damage, directional trauma impulses, and wide cleaves.
* **Explicit Enemy State Machines**: Completely eliminates passive contact damage. Enemies transition through `IDLE` $\to$ `AGGRO` $\to$ `WINDUP` (with dynamic closing telegraph rings) $\to$ `ATTACK` $\to$ `RECOVERY`. Stepping out of a windup dodges the strike; stunning mid-windup cancels it entirely.

### 3. UI/UX & Canvas Migration
* **DOM Decluttering**: High-frequency dynamic elements (Player HP/MP/Stamina bars, boss vitality gauges, combo counters, floating damage text, minimap radar, pedestal tooltips) are rendered directly inside the Canvas rendering loop. HTML/CSS is reserved strictly for modal menus.
* **Floating 360° Dynamic Thumbstick**: Dynamic analog joystick spawns anywhere on the left half of the display on touch contact, automatically orienting facing angles.
* **Client-Side Prediction**: Client-side positional visual interpolation in `net.js` masks input latency during lockstep delay ticks while strictly preserving authoritative server state agreement.

### 4. 2.5D Projection & Visual Engine
* **Z-Axis Kinematics**: Parabolic projectile arcs, dodge roll hops, and lofted knockback elevation calculated using `y_screen = y_world - z_world`.
* **Dynamic Floor Drop-Shadows & Y-Sorting**: Grounded elliptical shadows scaled inversely by entity Z-height. Entities rendered with Y-sorting depth passes to guarantee correct visual overlapping.
* **Obsidian Palette**: Weathered basalt masonry, deep slate floor tiles, and pre-baked offscreen lighting stamps for torches, lanterns, and spells.

### 5. Loot Ecosystem & Synergies
* **3-Pillar Synergy System**:
  * 🔴 **Brutality**: Boosts melee attack power, critical strike frequency, bleed, and knockback.
  * 🟣 **Tactics**: Enhances active skill cooldown recovery, mana efficiency, and status chain effects.
  * 🟢 **Survival**: Increases max vitality, armor defense rating, dodge barriers, and flask potency.
* **7 Equipment Loadout Slots**: Primary Weapon, Secondary/Off-hand, 2 Active Skills, and 3 Passive Relics.
* **Interactive Treasure Pedestals & Affixes**: Generates 3 color-coded pedestals offering choices with comparison tooltips. Random affixes include *Spike Burst*, *Thunderstruck*, *Toxic Trail*, *Oil & Fire*, and *Vampiric Leech*.

---

## 🛠️ Quick Start

### Standalone Browser
Open `index.html` directly in any modern desktop or mobile browser. Zero build step or web server required.

### Unified Server
```bash
# Start unified HTTP and WebSocket lockstep server (port 8787)
npm start

# Or directly with node
node server/server.js
```

### Determinism & Test Suite
```bash
# Run all validation gates
npm test

# Run individual suites
npm run test:checks    # 47 behavioral assertion checks
npm run test:lockstep  # 3600-tick multi-seat lockstep simulation
npm run test:parity    # Multi-seed browser vs headless replay gate
```

---

## 🎮 Controls

| Action | Keyboard / Mouse | Touch |
|---|---|---|
| **Move** | `W`, `A`, `S`, `D` / Arrow Keys | Floating dynamic stick (Left 50% screen) |
| **Aim** | Cursor / Mouse Position | Tap on canvas / Joystick angle |
| **Primary Attack** | Left Click / `J` | ⚔️ Radial Button |
| **Active Skill** | `K` | ⚡ Radial Button |
| **Dodge Roll** | `Space` / `L` | 🏃 Radial Button |
| **Sip Flask** | `H` | 🧪 Radial Button |
| **Interact / Claim Pedestal** | `E` | Tap on Pedestal / Interact Button |
| **Inventory / Character** | `I` | 🎒 Header Button |
| **Pause** | `Escape` / `P` | ⏸️ Header Button |

---

## 📱 Native Android APK Packaging

Dungeon Sovereign v7.0 includes a fully configured native Android wrapper and Gradle build pipeline powered by local Android SDK 35 and Capacitor runtime:

```bash
# Sync game web assets into Android project
npm run apk:sync

# Assemble signed Debug APK
npm run apk:debug

# Assemble optimized Release APK
npm run apk:release

# Assemble both APKs and output to dist-apk/ with SHA-256 hashes
npm run apk:bundle
```

Built APK artifacts:
* **Release APK**: `dist-apk/dungeon-sovereign-v7.0.0-release.apk` (Zip-aligned, v1+v2 signed, ~3.5MB)
* **Debug APK**: `dist-apk/dungeon-sovereign-v7.0.0-debug.apk` (Zip-aligned, debug signed, ~4.5MB)

---

## 📜 License
MIT License. Crafted with precision for the Sovereign guild.

