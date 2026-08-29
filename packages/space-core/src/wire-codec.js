/**
 * WIRE CODEC — makes any envelope or subscribe-request (see envelope.js/
 * space.js) safe to round-trip through `JSON.stringify`/`JSON.parse`.
 * Used at every REAL serialization boundary this PoC has: a WebSocket
 * connection (`@qu/space-transport`'s WsClientTransport/ws-server-hub) and
 * a real on-disk file (`@qu/space-storage`'s file-store.js). The
 * in-process transport/durable-store never needed this - objects there are
 * passed by reference, never actually serialized.
 *
 * `JSON.stringify` does NOT preserve `Uint8Array` - it serializes one as a
 * plain byte-indexed object (`{"0":1,"1":2,...}`), not an array, and
 * `JSON.parse` has no way to reconstruct it. Every envelope carries several
 * Uint8Array fields (`iv`, `ct`, `pub`, `sig`, `senderXPub`, and
 * `to[].pub`/`to[].key`), nested inside plain objects/arrays - exactly the
 * shape a generic, single-field helper like `QuCrypto.toBytes()` can't
 * reach on its own. This is a *real* bug this PoC hit once WebSocket
 * transport actually existed (the in-process demo never could have caught
 * it) - `encodeForWire()`/`decodeFromWire()` fix it once, generically, for
 * every current and future message shape, rather than a bespoke
 * per-message-type codec that would need updating every time the wire
 * protocol - or the on-disk format - grows a field.
 */
const TAG = '__u8';

/** @param {*} value - Recursively walks arrays/plain objects; tags every Uint8Array as base64. */
export function encodeForWire(value) {
  if (value instanceof Uint8Array) return { [TAG]: bytesToBase64(value) };
  if (Array.isArray(value)) return value.map(encodeForWire);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) out[key] = encodeForWire(v);
    return out;
  }
  return value;
}

/** @param {*} value - The inverse of encodeForWire(): restores every tagged entry back into a real Uint8Array. */
export function decodeFromWire(value) {
  if (value && typeof value === 'object' && typeof value[TAG] === 'string') {
    return base64ToBytes(value[TAG]);
  }
  if (Array.isArray(value)) return value.map(decodeFromWire);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) out[key] = decodeFromWire(v);
    return out;
  }
  return value;
}

// Small, dependency-free base64 helpers (identical behaviour to
// @qu/core's QuCrypto.toBase64/fromBase64) - kept local rather than
// importing QuCrypto here purely to keep this module usable in a raw
// WebSocket/Worker context with zero dependencies; behaviourally
// interchangeable with QuCrypto's own.
function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(base64) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(base64, 'base64'));
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
