/**
 * RELAY FEDERATION — a relay federates with another (upstream) relay by
 * being a SUBSCRIBING PEER to it, exactly like an ordinary `Space` client
 * would (see `@qu/space-core`'s space.js): the same signed `hello`/
 * `subscribe` control messages, over an ordinary Transport connection.
 * There is no relay-to-relay-specific wire protocol - a relay federating
 * "looks like" one more client to the relay it federates with, and
 * federation.js is the thin layer that plugs the two ordinary relay
 * mechanisms this already needs together:
 *   - `subscribers`/`acceptWrite()`/`ingestFederated()` (relay.js's own
 *     "SUBSCRIBER-TRACKING"/"FEDERATION" doc comments) on the LOCAL relay.
 *   - The exact same `subscribe` request shape `Space.subscribeNode()`
 *     sends, addressed at the UPSTREAM relay.
 *
 * DEMAND-DRIVEN, the whole point (see this repo's own design notes on
 * avoiding a broadcast storm across a federation): `federateRelay()` does
 * NOT eagerly mirror every Node the upstream relay has - it wires the
 * LOCAL relay's own `debug.relay.subscribe.received` event (fired only
 * when an actual local peer subscribes to something) to also send an
 * upstream `subscribe` for that SAME nodeId, exactly once per nodeId ever
 * (idempotent - a second local subscriber for an already-federated Node
 * costs nothing extra upstream). Nothing before the first real local
 * subscriber existed ever crosses the federation link. This is the same
 * "don't forward what nobody asked for" rule `SUBSCRIBER-TRACKING` already
 * applies between a relay and its own clients, applied one hop further.
 *
 * BIDIRECTIONAL once federated: `acceptWrite()`'s `relay.write.local` event
 * (fired only for a write that genuinely originated from one of THIS
 * relay's own local peers, never for one federation itself just brought
 * in - see relay.js's own doc comment on exactly why that distinction
 * exists) is forwarded upstream for any nodeId this link has federated,
 * so peers on the OTHER side of the link see this relay's own local
 * writes too, not just the reverse.
 *
 * TRUST: an upstream relay is trusted no more than a single ordinary local
 * peer would be - every envelope it sends down is independently verified
 * against this Node's real write-ACL by `ingestFederated()` before
 * anything happens with it (mirrored, forwarded, applied). A malicious or
 * compromised upstream relay cannot inject unauthorized content into this
 * relay's own downstream peers; it can only ever withhold/delay what a
 * legitimate writer produced.
 *
 * A KNOWN, accepted scope boundary for a first version: `hello` is sent
 * once on construction (mirroring `Space`'s own posture) purely so an
 * upstream relay whose Kinds require flat `'members'` ACL can route
 * presence/push for THIS relay's own identity if it ever mattered: it
 * does not currently make this relay itself a member of the upstream
 * relay's `members` list (that still has to be provisioned out-of-band,
 * exactly like any other member - see relay.js's own "DYNAMIC MEMBERSHIP"
 * doc comment on `addMember()`). Only `'owner'`/`'named'`-ACL Nodes on the
 * upstream side are federate-able without that provisioning step, for the
 * exact same self-certifying reasons Task 3/4's own relay-side ACL/
 * subscribe relaxation already established.
 */
import { QuCrypto } from '@qu/core';

const HELLO_DOMAIN = 'qu-space-hello-v1'; // MUST match @qu/space-core's HELLO_DOMAIN - see relay.js's own identical, identically-justified duplication of this constant.

/**
 * @param {{relay: object, bus: import('@qu/events').EventBus, transport: object, identity: {signingKey: Uint8Array, signingPub: Uint8Array}}} params
 *   `relay` - the LOCAL relay, the object `createRelayForwarder()` returned (needs its `ingestFederated`).
 *   `bus` - the SAME `EventBus` passed to that `createRelayForwarder()` call - federation listens
 *     on it (`debug.relay.subscribe.received`, `relay.write.local`) and needs the real thing, not a copy.
 *   `transport` - an ALREADY-CONNECTED Transport (e.g. `WsClientTransport`/`InProcessTransport`)
 *     pointed at the UPSTREAM relay - federateRelay() sends `hello`/`subscribe`/writes over it and
 *     reads incoming `{nodeId, envelope}` messages from it, exactly as `Space` would.
 *   `identity` - THIS relay's own signing identity for the upstream connection (only the Ed25519
 *     half is ever used - federation never decrypts anything, see this file's own "TRUST" doc comment).
 * @returns {{isFederated: (nodeId: string) => boolean}}
 */
export function federateRelay({ relay, bus, transport, identity }) {
  /** @type {Set<string>} nodeIds this link has ever sent an upstream `subscribe` for - see this file's own "DEMAND-DRIVEN" doc comment. */
  const federatedNodeIds = new Set();

  transport.onMessage(({ data }) => {
    if (data?.nodeId && data?.envelope) relay.ingestFederated(data.nodeId, data.envelope);
    // Anything else (an upstream 'member-joined'/'grant' broadcast, etc.) is out of scope for this
    // first version - this relay's OWN local ACL/membership state is provisioned independently,
    // see this file's own "A KNOWN, accepted scope boundary" doc comment.
  });

  (async () => {
    const sig = await QuCrypto.sign(new TextEncoder().encode(HELLO_DOMAIN), identity.signingKey);
    transport.send({ type: 'hello', pub: identity.signingPub, sig });
  })();

  async function subscribeUpstream(nodeId) {
    if (federatedNodeIds.has(nodeId)) return;
    federatedNodeIds.add(nodeId);
    const sig = await QuCrypto.sign(new TextEncoder().encode(nodeId), identity.signingKey);
    transport.send({ type: 'subscribe', nodeId, pub: identity.signingPub, sig });
  }

  bus.on('debug.relay.subscribe.received', ({ nodeId }) => {
    subscribeUpstream(nodeId);
  });
  bus.on('relay.write.local', ({ nodeId, envelope }) => {
    if (federatedNodeIds.has(nodeId)) transport.send({ nodeId, envelope });
  });

  return { isFederated: (nodeId) => federatedNodeIds.has(nodeId) };
}
