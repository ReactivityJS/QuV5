/**
 * RELAY FORWARDER — the relay is itself a Space member's peer, not just a
 * dumb pipe: it verifies an incoming envelope's write signature against
 * the space's membership, forwards it live to every other connected peer,
 * AND (when given a `storage` adapter) MIRRORS it - so a peer that comes
 * online after the original author has already gone offline still gets
 * caught up, from the relay's own mirror, without the author needing to
 * be connected at the same time.
 *
 * The relay is given ONLY public keys, never an X25519 private key
 * anywhere in its construction - so unlike a real peer, it cannot call
 * `openUpdate()` even if its code tried to. That is what "the relay never
 * sees plaintext" means here: not a policy this class promises to follow,
 * but a capability it was never handed in the first place (see
 * envelope.js's `verifyEnvelope()` vs `openUpdate()` split). Mirroring
 * does not change this - it stores the exact same sealed envelope it
 * already forwards, never anything decrypted.
 *
 * Two message shapes flow through here (both defined by @qu/space-core's
 * `Space`, see space.js):
 *   - `{nodeId, envelope}` - a write. Verified, forwarded live, mirrored.
 *   - `{type:'subscribe', nodeId, pub, sig}` - a peer asking to catch up
 *     on a Node (sent by `Space.subscribeNode()`). `sig` is that peer's
 *     signature over `nodeId` itself, proving the request came from an
 *     actual space member - without this check, anyone who can connect to
 *     the relay could ask for and receive any Node's full mirrored
 *     envelope history (still ciphertext-only, but node activity/metadata
 *     is not nothing). Answered by replaying every mirrored envelope for
 *     that Node straight to the requester, in storage order.
 *
 * `resolveKindSchema(nodeId)` lets the relay gate WRITES to only Node ids
 * it's willing to route for, without needing to understand what a Node's
 * content means - same "blind to content, aware only of routing/ACL
 * metadata" posture QuStore's own relay has today. It is NOT consulted for
 * subscribe/catch-up requests - the ONLY gate there is "is this a
 * signed-for space member," precisely because a relay with mirrored
 * history for a Node it doesn't otherwise recognize should still be able
 * to hand that history back to a legitimate member.
 */
import { verifyEnvelope } from '@qu/space-core';
import { QuCrypto } from '@qu/core';

/**
 * @param {{hub: object, members: Array<{pub: Uint8Array}>, resolveKindSchema: (nodeId: string) => object, storage?: object}} params
 */
export function createRelayForwarder({ hub, members, resolveKindSchema, storage = null }) {
  const memberPubs = new Set(members.map((m) => QuCrypto.toBase64(m.pub)));
  const isSpaceMember = (pubB64) => memberPubs.has(pubB64);

  /** @type {Array<{nodeId: string, envelope: object}>} Every envelope this relay ever handled, ciphertext/signature only - for tests to assert "no plaintext ever passed through here." */
  const seen = [];

  hub.registerRelay(async (fromPeerId, message) => {
    if (message?.type === 'subscribe') {
      await handleSubscribe(fromPeerId, message);
      return;
    }
    await handleWrite(fromPeerId, message);
  });

  /** Mirror-storage catch-up: hand a requesting member everything this relay has mirrored for one Node, regardless of whether the original author is still connected. */
  async function handleSubscribe(fromPeerId, { nodeId, pub, sig }) {
    if (!storage) return; // this relay isn't mirroring anything - nothing to catch a late peer up on.
    if (!pub || !sig) return;
    const pubB64 = QuCrypto.toBase64(pub);
    if (!isSpaceMember(pubB64)) return; // not a member - no history for you, mirrored ciphertext or not.
    const ok = await QuCrypto.verify(new TextEncoder().encode(nodeId), sig, pub);
    if (!ok) return; // signature doesn't match the claimed pub - reject, don't trust the claim.

    const envelopes = await storage.load(nodeId);
    for (const envelope of envelopes) {
      hub.deliverTo(fromPeerId, 'relay', { nodeId, envelope });
    }
  }

  async function handleWrite(fromPeerId, { nodeId, envelope }) {
    const kindSchema = resolveKindSchema(nodeId);
    if (!kindSchema) return; // unknown Node - nothing to route to.
    if (!(await verifyEnvelope(envelope, isSpaceMember))) return; // bad/foreign signature - drop, never forwarded or mirrored.

    seen.push({ nodeId, envelope });
    await storage?.append(nodeId, envelope); // the mirror - present even if the author disconnects the instant after this line runs.

    for (const peerId of hub.peerIds()) {
      if (peerId === fromPeerId) continue; // never echo a write back to its own author.
      hub.deliverTo(peerId, fromPeerId, { nodeId, envelope });
    }
  }

  return { seen };
}
