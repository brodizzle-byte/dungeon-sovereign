'use strict';
/**
 * Dungeon Sovereign v7.0 — Web Worker for Lockstep Parity Checks
 *
 * Offloads continuous FNV-1a checkpoint hashing and state serialization
 * to a background worker, preventing rendering hitching or frame drops on the main thread.
 */

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

self.onmessage = function (e) {
  const data = e.data;
  if (!data) return;

  if (data.type === 'hash') {
    const hash = fnv1a(data.stateStr || '');
    self.postMessage({
      type: 'hash_result',
      id: data.id,
      tick: data.tick,
      hash: hash,
    });
  } else if (data.type === 'checkpoint') {
    const hash = fnv1a(data.stateStr || '');
    self.postMessage({
      type: 'checkpoint_result',
      tick: data.tick,
      hash: hash,
      raw: data.debug ? data.stateStr : undefined,
    });
  }
};
