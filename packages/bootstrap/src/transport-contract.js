/**
 * TRANSPORT CONTRACT — fail-fast validation for the `transport` slot, per
 * `docs/peer-transport-contract.md` (Arbeitspaket 4): a `Transport` needs
 * exactly three methods (`connect`/`send`/`onMessage`) - everything
 * `InProcessTransport`/`WsClientTransport` already implement, and exactly
 * what a future WebRTC-backed transport would need to implement too, no
 * more. `onStatusChange`/`getPeerId`/`close` are OPTIONAL (see that doc's
 * own contract) and deliberately never checked here.
 *
 * Exists so a typo'd/incomplete custom transport adapter (`send` missing,
 * `onMessage` misspelled `onMsg`) fails LOUDLY, at the exact bootstrap call
 * site that named it, instead of silently deep inside `Space._sendHello()`
 * as a cryptic `TypeError: transport.send is not a function` with no
 * indication of WHICH transport or WHERE it was configured.
 */

/** The transport contract's required methods - see this file's own doc comment. */
export const REQUIRED_TRANSPORT_METHODS = ['connect', 'send', 'onMessage'];

/**
 * @param {object} transport
 * @throws {Error} naming every missing required method, if any.
 */
export function assertTransportShape(transport) {
  if (!transport || typeof transport !== 'object') {
    throw new Error(`bootstrapSpace: "transport" must be an object implementing ${REQUIRED_TRANSPORT_METHODS.join('/')} - see docs/peer-transport-contract.md`);
  }
  const missing = REQUIRED_TRANSPORT_METHODS.filter((method) => typeof transport[method] !== 'function');
  if (missing.length > 0) {
    throw new Error(`bootstrapSpace: "transport" is missing required method(s): ${missing.join(', ')} - see docs/peer-transport-contract.md`);
  }
}
