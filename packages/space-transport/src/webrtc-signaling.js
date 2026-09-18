/**
 * SIGNALING TRANSPORT WRAPPER — `docs/webrtc.md`'s "huckepack auf die
 * bestehende Relay-Verbindung" design: lets an app exchange WebRTC SDP/ICE
 * signaling over the SAME connection a `Space` already has open to its
 * relay, with ZERO changes to `@qu/space-core`'s `Space` itself.
 *
 * THE PROBLEM THIS SOLVES: a Transport's `onMessage(cb)` is a SINGLE-
 * listener slot - `Space` registers its own handler exactly once, in its
 * own constructor (see `docs/peer-transport-contract.md`'s own doc
 * comment: "kein Multi-Listener-Bus"). An app that ALSO wants to receive
 * `{type:'rtc-signal', ...}` messages (relay.js's own "A SIXTH shape,
 * SIGNALING" doc comment) over that same connection cannot simply call
 * `.onMessage()` a second time - that would silently steal Space's own
 * handler slot, breaking ordinary sync entirely.
 *
 * THE FIX: `wrapWithSignaling(transport)` returns a new object that itself
 * satisfies the Transport contract (`connect`/`send`/`onMessage`, plus
 * whichever of `onStatusChange`/`getPeerId`/`close` the wrapped transport
 * has) - a caller hands THIS to `bootstrapSpace()`/`new Space(...)` instead
 * of the raw transport, and `Space` never notices anything changed. The
 * wrapper claims the wrapped transport's OWN single `onMessage()` slot for
 * itself, and re-dispatches: an `rtc-signal` message is intercepted and
 * routed to `onSignal()` listeners instead, everything else is passed
 * straight through to whatever handler `Space` registered on the wrapper.
 * `send()`/`connect()`/`close()`/`getPeerId()` are plain passthroughs to
 * the wrapped transport - this wrapper adds a routing layer on the
 * RECEIVE side only, changes nothing about how Space's own messages leave.
 *
 * `sendSignal(toPubB64, signal)` calls the wrapped transport's `send()`
 * directly with `{type:'rtc-signal', to, signal}` - `signal` is opaque to
 * everything here (an SDP offer/answer or ICE candidate, entirely
 * `webrtc-peer.js`'s concern). `onSignal(cb)` supports MULTIPLE listeners
 * (unlike the single-listener `onMessage()` this wrapper itself claims) -
 * a real app may run several concurrent `createWebRTCPeer()` calls (a game
 * with several opponents, a group call) over the SAME underlying
 * connection, each registering its own listener and filtering by `from`
 * itself; `webrtc-peer.js` does exactly that.
 *
 * NEVER touches `@qu/space-core` - `Space` continues to know NOTHING about
 * `rtc-signal` as a concept, exactly as `docs/peer-transport-contract.md`'s
 * own "Mesh, Signaling-Relays, WebRTC" section anticipated ("kein Core-Code
 * ändert sich"). This is what keeps WebRTC a genuinely OPTIONAL module: an
 * app that never calls `wrapWithSignaling()`/`createWebRTCPeer()` has a
 * completely ordinary `Space`, unaware this file exists.
 */

const OPTIONAL_PASSTHROUGH_METHODS = ['onStatusChange', 'getPeerId', 'close'];

/**
 * @param {object} transport - Any Transport-contract-conforming instance (e.g. `WsClientTransport`) - NOT YET `connect()`ed; the wrapper's own `connect()` forwards to it.
 * @returns {object} A new Transport-contract-conforming object - pass THIS to `bootstrapSpace()`/`new Space(...)` instead of `transport`. Also carries `sendSignal(toPubB64, signal)` and `onSignal(cb) -> unsubscribe`.
 */
export function wrapWithSignaling(transport) {
  /** @type {((msg: {data: object}) => void)|null} Space's own registered handler - everything that ISN'T an rtc-signal is forwarded here, unmodified. */
  let spaceHandler = null;
  /** @type {Set<(payload: {from: string, signal: *}) => void>} See this file's own top doc comment on why this is multi-listener, unlike `onMessage()` itself. */
  const signalListeners = new Set();

  transport.onMessage((msg) => {
    if (msg?.data?.type === 'rtc-signal') {
      const { from, signal } = msg.data;
      for (const cb of signalListeners) cb({ from, signal });
      return;
    }
    spaceHandler?.(msg);
  });

  const wrapper = {
    connect: () => transport.connect(),
    send: (data) => transport.send(data),
    onMessage: (cb) => {
      spaceHandler = cb;
    },
    /** @param {string} toPubB64 @param {*} signal - opaque, see this file's own top doc comment. */
    sendSignal: (toPubB64, signal) => transport.send({ type: 'rtc-signal', to: toPubB64, signal }),
    /** @param {(payload: {from: string, signal: *}) => void} cb @returns {() => void} unsubscribe */
    onSignal: (cb) => {
      signalListeners.add(cb);
      return () => signalListeners.delete(cb);
    },
  };
  // Only expose an OPTIONAL Transport-contract method if the wrapped transport itself has one -
  // see docs/peer-transport-contract.md: Space checks these with `?.()`, so a wrapper around
  // InProcessTransport (no onStatusChange) must not pretend to have one either.
  for (const method of OPTIONAL_PASSTHROUGH_METHODS) {
    if (typeof transport[method] === 'function') wrapper[method] = (...args) => transport[method](...args);
  }
  return wrapper;
}
