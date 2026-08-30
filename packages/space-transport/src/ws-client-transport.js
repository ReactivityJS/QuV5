/**
 * WS CLIENT TRANSPORT — connects one peer to a relay over a real WebSocket.
 * Same shape as InProcessTransport (`connect()`/`send()`/`onMessage()`/
 * `getPeerId()`), so a `Space` never needs to know which one it's talking
 * to (see space.js - it only ever calls `send()`/`onMessage()`), PLUS one
 * optional extra both transports don't have to share: `onStatusChange()`
 * (see below) - `Space` calls it if it exists (`?.`), so InProcessTransport
 * staying without one is not a breaking gap.
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
 * caller never has to serialize "wait for connect, then start writing." The
 * SAME queue is what makes a write made WHILE OFFLINE durable across a
 * reconnect: nothing is dropped, it just waits for the next `open`.
 *
 * Every send/receive goes through wire-codec.js's `encodeForWire()`/
 * `decodeFromWire()` - a bare `JSON.stringify(envelope)` would silently
 * corrupt every `Uint8Array` field in it (see that module's doc comment).
 *
 * RECONNECT (on by default, `{ reconnect: false }` to opt out): a dropped
 * connection - relay restart, laptop sleep, a mobile network handoff -
 * schedules a fresh `_openSocket()` with exponential backoff + jitter
 * (`minReconnectDelay`..`maxReconnectDelay`, default 500ms..15s), not a
 * single retry. `onStatusChange(cb)` reports `{status}` through the whole
 * lifecycle - `'connected'` (first successful open), `'disconnected'` (the
 * socket closed and a retry is scheduled), `'reconnecting'` (a retry
 * attempt is about to fire, `{attempt, delay}`), `'reconnected'` (a RETRY
 * succeeded, as opposed to the first-ever connect) - `Space` (see
 * space.js's own `onStatusChange` wiring) uses exactly the `'connected'`/
 * `'reconnected'` transitions to re-send `hello` and re-subscribe every
 * attached Node, which is what makes reconnect actually resync instead of
 * just reopening a socket to nowhere: a relay answers a fresh `subscribe`
 * by replaying its full mirror for that Node (see relay.js's own
 * `handleSubscribe()`), so whatever changed while this peer was offline
 * arrives the same way any other catch-up would, no separate "diff" wire
 * message needed - Yjs updates are idempotent to re-apply, so replaying
 * already-known history is harmless, not just tolerated.
 *
 * A BACKGROUNDED BROWSER TAB is the one case a `close` event can't be
 * trusted to fire promptly for (mobile OSes and some browsers freeze timers
 * and suspend sockets without ever signaling "closed") - when running in a
 * browser (`globalThis.document` exists), this also listens for
 * `visibilitychange` (tab regains foreground) and `online` (network comes
 * back) and, if the socket isn't actually `OPEN`/`CONNECTING` at that
 * point, forces an immediate reconnect attempt rather than waiting for a
 * `close` event that may never come.
 *
 * `close()` is the one thing that permanently disables reconnect - it's the
 * caller's explicit "I'm done," not a transient drop, so no retry is
 * scheduled afterward.
 *
 * Importable on its own via the `@qu/space-transport/ws-client-transport`
 * subpath (see package.json's `exports`), separate from the package's main
 * `.` entry - a browser bundle (see `demo/web/main.js`) needs exactly this
 * file and nothing else from this package; the main entry's `index.js`
 * also re-exports `createWsServerHub`, which imports `node:crypto` and has
 * no browser build. Bundling THAT into a browser page would fail (or drag
 * in a Node-core polyfill for code a browser client never calls) - this
 * subpath sidesteps the problem entirely rather than needing one.
 */
import { encodeForWire, decodeFromWire } from '@qu/space-core';

export class WsClientTransport {
  /**
   * @param {string} url - e.g. "ws://localhost:8081".
   * @param {{WebSocketImpl?: typeof WebSocket, reconnect?: boolean, minReconnectDelay?: number, maxReconnectDelay?: number}} [options]
   */
  constructor(url, { WebSocketImpl, reconnect = true, minReconnectDelay = 500, maxReconnectDelay = 15000 } = {}) {
    this._url = url;
    this._WebSocket = WebSocketImpl ?? globalThis.WebSocket;
    if (!this._WebSocket) {
      throw new Error('WsClientTransport: no global WebSocket on this runtime - pass { WebSocketImpl } (e.g. `import WebSocket from "ws"`)');
    }
    this._ws = null;
    this._onMessage = null;
    this._onStatusChange = null;
    this._sendQueue = [];
    this._peerId = `peer-${Math.random().toString(36).slice(2)}`;

    this._reconnect = reconnect;
    this._minDelay = minReconnectDelay;
    this._maxDelay = maxReconnectDelay;
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._closedByCaller = false;
    this._everConnected = false;

    if (this._reconnect && typeof globalThis.document !== 'undefined' && globalThis.addEventListener) {
      globalThis.addEventListener('visibilitychange', () => {
        if (globalThis.document.visibilityState === 'visible') this._ensureAlive();
      });
      globalThis.addEventListener('online', () => this._ensureAlive());
    }
  }

  /** See this file's own doc comment on backgrounded tabs. A no-op unless the socket has actually gone stale. */
  _ensureAlive() {
    if (this._closedByCaller || !this._reconnect) return;
    const state = this._ws?.readyState;
    if (state !== this._ws?.OPEN && state !== this._ws?.CONNECTING) this._scheduleReconnect(0);
  }

  /** @returns {Promise<void>} Resolves once the handshake completes and any queued sends have flushed. Only the FIRST call's rejection matters to a caller - later reconnect attempts (see this file's own doc comment) retry silently and report through `onStatusChange()` instead. */
  async connect() {
    return this._openSocket();
  }

  _openSocket() {
    return new Promise((resolve, reject) => {
      const ws = new this._WebSocket(this._url);
      this._ws = ws;
      let settled = false;

      ws.addEventListener('open', () => {
        this._reconnectAttempt = 0;
        const status = this._everConnected ? 'reconnected' : 'connected';
        this._everConnected = true;
        for (const data of this._sendQueue.splice(0)) ws.send(JSON.stringify(encodeForWire(data)));
        this._onStatusChange?.({ status });
        if (!settled) {
          settled = true;
          resolve();
        }
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
      ws.addEventListener('error', (event) => {
        if (!settled) {
          settled = true;
          reject(event.error ?? new Error('WsClientTransport: connection failed'));
        }
      });
      ws.addEventListener('close', () => {
        this._onStatusChange?.({ status: 'disconnected' });
        if (this._reconnect && !this._closedByCaller) this._scheduleReconnect();
        if (!settled) {
          settled = true;
          reject(new Error('WsClientTransport: connection failed'));
        }
      });
    });
  }

  /** Exponential backoff + jitter (so many clients dropped by the same relay outage don't all retry in lockstep) - see this file's own doc comment. @param {number} [delayOverride] - `0` for the "tab just came back, try right now" case. */
  _scheduleReconnect(delayOverride) {
    clearTimeout(this._reconnectTimer);
    const base = Math.min(this._maxDelay, this._minDelay * 2 ** this._reconnectAttempt);
    const delay = delayOverride ?? base * (0.5 + Math.random() * 0.5);
    this._reconnectAttempt++;
    this._onStatusChange?.({ status: 'reconnecting', attempt: this._reconnectAttempt, delay });
    this._reconnectTimer = setTimeout(() => {
      this._openSocket().catch(() => {}); // a failed retry already scheduled its own next attempt via the 'close'/'error' handlers above - nothing more to do here.
    }, delay);
    this._reconnectTimer.unref?.(); // Node-only (browsers' setTimeout return value has no unref) - a pending retry must never be the reason a CLI process (a test runner, a script using this transport) can't exit; close() below still cancels it outright for an intentional shutdown.
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

  /** @param {(status: {status: 'connected'|'disconnected'|'reconnecting'|'reconnected', attempt?: number, delay?: number}) => void} callback - see this file's own doc comment for the full lifecycle. Optional - `Space` (and any other caller) checks for this with `?.()`, so a transport without one (e.g. InProcessTransport) is not a gap. */
  onStatusChange(callback) {
    this._onStatusChange = callback;
  }

  close() {
    this._closedByCaller = true;
    clearTimeout(this._reconnectTimer);
    this._ws?.close();
  }
}
