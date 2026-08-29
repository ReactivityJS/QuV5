/**
 * WS CLIENT TRANSPORT — connects one peer to a relay over a real WebSocket.
 * Same shape as InProcessTransport (`connect()`/`send()`/`onMessage()`/
 * `getPeerId()`), so a `Space` never needs to know which one it's talking
 * to (see space.js - it only ever calls `send()`/`onMessage()`).
 *
 * Works with the native `WebSocket` global (browsers, Node 22+) or the `ws`
 * package (pass `{ WebSocketImpl: WebSocket }` from `import WebSocket from
 * 'ws'` - needed for older Node, or when you want `ws`'s Node-native
 * behaviour explicitly). Uses `addEventListener()`, not `ws`'s Node-style
 * `.on()`, specifically because `ws` v8 implements BOTH - `addEventListener`
 * is the one that also works against a native browser `WebSocket`, so one
 * implementation covers both runtimes.
 *
 * `send()` QUEUES if the socket isn't OPEN yet rather than throwing - a
 * `Space` starts producing updates (e.g. from `createNode()`) immediately,
 * often before `connect()`'s handshake has finished; queueing means the
 * caller never has to serialize "wait for connect, then start writing."
 *
 * Every send/receive goes through wire-codec.js's `encodeForWire()`/
 * `decodeFromWire()` - a bare `JSON.stringify(envelope)` would silently
 * corrupt every `Uint8Array` field in it (see that module's doc comment).
 *
 * Deliberately NOT included (see docs/v5-space-core-guide.md's own "known
 * gaps" section): auto-reconnect with backoff. Catch-up/backfill for a
 * peer that comes online AFTER a Node's author already went offline IS
 * covered, though not by this transport itself - `Space.subscribeNode()`
 * sends a signed `{type:'subscribe', nodeId}` request (see space.js),
 * which a relay configured with a storage adapter (see relay.js's mirror-
 * storage handling) answers by replaying every envelope it has mirrored
 * for that Node, regardless of whether the original author is still
 * connected.
 */
import { encodeForWire, decodeFromWire } from '@qu/space-core';

export class WsClientTransport {
  /**
   * @param {string} url - e.g. "ws://localhost:8081".
   * @param {{WebSocketImpl?: typeof WebSocket}} [options]
   */
  constructor(url, { WebSocketImpl } = {}) {
    this._url = url;
    this._WebSocket = WebSocketImpl ?? globalThis.WebSocket;
    if (!this._WebSocket) {
      throw new Error('WsClientTransport: no global WebSocket on this runtime - pass { WebSocketImpl } (e.g. `import WebSocket from "ws"`)');
    }
    this._ws = null;
    this._onMessage = null;
    this._sendQueue = [];
    this._peerId = `peer-${Math.random().toString(36).slice(2)}`;
  }

  /** @returns {Promise<void>} Resolves once the handshake completes and any queued sends have flushed. */
  async connect() {
    return new Promise((resolve, reject) => {
      const ws = new this._WebSocket(this._url);
      this._ws = ws;
      ws.addEventListener('open', () => {
        for (const data of this._sendQueue.splice(0)) ws.send(JSON.stringify(encodeForWire(data)));
        resolve();
      });
      ws.addEventListener('message', (event) => {
        let data;
        try {
          data = decodeFromWire(JSON.parse(event.data.toString()));
        } catch {
          return;
        }
        this._onMessage?.({ data, peerId: 'relay' });
      });
      ws.addEventListener('error', (event) => reject(event.error ?? new Error('WsClientTransport: connection failed')));
    });
  }

  /** @param {object} data - Sent to the relay (a Space never broadcasts to specific peers itself - see space.js). */
  send(data) {
    if (this._ws && this._ws.readyState === this._ws.OPEN) this._ws.send(JSON.stringify(encodeForWire(data)));
    else this._sendQueue.push(data);
  }

  /** A relay-connected client's only counterpart IS the relay - `sendTo()` degrades to `send()` rather than needing a real routing table. */
  sendTo(_peerId, data) {
    this.send(data);
  }

  onMessage(callback) {
    this._onMessage = callback;
  }

  getPeerId() {
    return this._peerId;
  }

  close() {
    this._ws?.close();
  }
}
