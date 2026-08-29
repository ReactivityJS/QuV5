/**
 * PRESENCE TRACKER — the relay's own live map of "which space member (by
 * Ed25519 pubkey) is on which currently-open connection (by peerId)",
 * built from signed `{type:'hello', pub, sig}` messages (see relay.js's
 * own `handleHello()`) and torn down again on disconnect (see
 * `createRelayForwarder()`'s hub-disconnect wiring).
 *
 * This is the ONE piece of state that makes "push only if the recipient
 * is offline" possible - the relay already forwards every write live to
 * `hub.peerIds()` regardless of who they are (see relay.js's
 * `handleWrite()`), so a member who's genuinely connected already gets
 * their copy that way; presence just answers "is there any point also
 * sending them a Web Push," never gates delivery itself.
 *
 * Deliberately NOT a claim of identity strength beyond "holds the private
 * key" - a peerId maps to at most one pubkey at a time (a later `hello` on
 * the same connection replaces the earlier one, matching one WebSocket
 * being one Space's one transport in every topology this PoC targets), and
 * a pubkey maps to at most one peerId (a member opening a second
 * connection simply moves their "online" flag to the new one).
 */
export class PresenceTracker {
  /** @type {Map<string, string>} pubB64 -> peerId */
  #peerIdByPub = new Map();
  /** @type {Map<string, string>} peerId -> pubB64 */
  #pubByPeerId = new Map();

  /** @param {string} pubB64 @param {string} peerId */
  setOnline(pubB64, peerId) {
    const previousPeerId = this.#peerIdByPub.get(pubB64);
    if (previousPeerId && previousPeerId !== peerId) this.#pubByPeerId.delete(previousPeerId);
    const previousPub = this.#pubByPeerId.get(peerId);
    if (previousPub && previousPub !== pubB64) this.#peerIdByPub.delete(previousPub);
    this.#peerIdByPub.set(pubB64, peerId);
    this.#pubByPeerId.set(peerId, pubB64);
  }

  /** Call when a connection closes - clears whichever pubkey (if any) was mapped to it. */
  disconnect(peerId) {
    const pubB64 = this.#pubByPeerId.get(peerId);
    if (pubB64) this.#peerIdByPub.delete(pubB64);
    this.#pubByPeerId.delete(peerId);
  }

  /** @param {string} pubB64 @returns {boolean} */
  isOnline(pubB64) {
    return this.#peerIdByPub.has(pubB64);
  }

  /** @param {string} peerId @returns {string|null} The pubkey currently mapped to this connection, if any - read BEFORE disconnect() clears it (see relay.js's own disconnect wiring, which needs this to emit a debug.relay.presence.offline event naming who went offline). */
  pubFor(peerId) {
    return this.#pubByPeerId.get(peerId) ?? null;
  }
}
