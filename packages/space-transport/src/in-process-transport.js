/**
 * IN-PROCESS TRANSPORT — simulates client<->relay<->client delivery inside
 * one process, star-shaped through a relay (never peer-to-peer directly),
 * so tests can prove the sync/signing/blind-relay mechanism without a real
 * network. A production transport (WebSocket/WebRTC) would implement the
 * same shape - `connect()`/`send()`/`onMessage()`/`getPeerId()` - against
 * real sockets; nothing in @qu/space-core depends on HOW bytes move, only
 * on this shape (deliberately close to, but not required to literally
 * implement, @qu/sync's existing `Transport` interface).
 *
 * Topology: every peer's `send()` goes to the relay only. The relay (see
 * relay.js) decides what to forward to whom via `hub.deliverTo()`. A peer
 * never has another peer's direct address - this is what makes "the relay
 * only ever forwards, it doesn't participate in trust" a structural
 * property of the topology, not just a convention.
 */
export function createInProcessHub() {
  /** @type {Map<string, (fromPeerId: string, data: object) => void>} */
  const inboxes = new Map();
  /** @type {((fromPeerId: string, data: object) => void)|null} */
  let relayHandler = null;

  return {
    registerPeerInbox(peerId, onMessage) {
      inboxes.set(peerId, onMessage);
    },
    registerRelay(onMessageFromPeer) {
      relayHandler = onMessageFromPeer;
    },
    /** A peer -> the relay. */
    sendToRelay(fromPeerId, data) {
      relayHandler?.(fromPeerId, data);
    },
    /** The relay -> one specific peer. */
    deliverTo(peerId, fromPeerId, data) {
      inboxes.get(peerId)?.(fromPeerId, data);
    },
    peerIds() {
      return [...inboxes.keys()];
    },
  };
}

export class InProcessTransport {
  constructor(hub, peerId) {
    this._hub = hub;
    this._peerId = peerId;
    this._onMessage = null;
  }

  async connect() {
    this._hub.registerPeerInbox(this._peerId, (fromPeerId, data) => this._onMessage?.({ data, peerId: fromPeerId }));
  }

  send(data) {
    this._hub.sendToRelay(this._peerId, data);
  }

  sendTo(peerId, data) {
    this._hub.deliverTo(peerId, this._peerId, data);
  }

  onMessage(callback) {
    this._onMessage = callback;
  }

  getPeerId() {
    return this._peerId;
  }
}
