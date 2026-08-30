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
 *
 * A THIRD message shape flows through here, for presence/push routing
 * only, never for content: `{type:'hello', pub, sig}` (sent once by every
 * `Space` on construction, see `@qu/space-core`'s own doc comment on it) -
 * `sig` proves possession of `pub`'s signing key, and on success just
 * updates `presence` (a `PresenceTracker`, see that file) to say "this
 * pubkey is on this connection right now." Nothing about it is forwarded
 * or mirrored - it never enters `seen`.
 *
 * A FOURTH shape flows the OTHER way - relay to peer, never peer to relay:
 * `{type:'member-joined', pub, xPub, name?}`, broadcast to every connected
 * peer by `addMember()` (see that function's own doc comment) the moment
 * a new member is added. This is what makes dynamic membership REACTIVE
 * instead of something a client has to poll for - see that doc comment.
 *
 * PUSH ROUTING (the `notify`/`bus` pair): when a write's envelope carries
 * a `notify` hint (see `@qu/space-core`'s `envelope.js` - a small,
 * UNENCRYPTED `{topic, to?}` the AUTHOR attached, never something this
 * relay infers from content it can't read), this relay emits one
 * `relay.notify.<kind>.<topic>` event per intended recipient on `bus` (an
 * `@qu/events` `EventBus`, optional - omitting it makes notify hints a
 * no-op here, same as before this existed), carrying `online` (from
 * `presence`). It is bus SUBSCRIBERS - a push-handler plugin, see
 * `push-handler.js` - that decide what to actually DO with that
 * (`online: false` => send a Web Push; `online: true` => typically
 * nothing, the live-forwarded envelope above already reaches them) -
 * this class itself makes no delivery decision, only routes the event,
 * consistent with "toast vs. browser-notification vs. push is the
 * handler's call based on state" (see this repo's own design notes on
 * `@qu/events`).
 *
 * The SAME `bus` (optional, same as above) also gets a `debug.relay.*`
 * family, for optional debugging/observability only (see `@qu/events`'
 * `createDebugLogger()`) - every write/subscribe/hello/presence event this
 * relay handles, not just the ones that end up notify-routed:
 *   - `debug.relay.write.received` / `.rejected` (`{nodeId, reason}`,
 *     `reason` one of `'unknown-node'`/`'bad-signature'`) / `.forwarded`
 *     (`{nodeId, toPeerIds}`) / `.mirrored` (`{nodeId}`, only when a
 *     `storage` adapter is configured).
 *   - `debug.relay.subscribe.received` / `.rejected` (`{nodeId, reason}`)
 *     / `.replayed` (`{nodeId, count}`).
 *   - `debug.relay.hello.received` / `.rejected` (`{reason}`).
 *   - `debug.relay.presence.online` / `.offline` (`{pub}`).
 * A relay never has a decryption key regardless of whether `bus` is wired
 * up - none of this exposes anything `seen`/`emitNotify()` don't already.
 */
import { verifyEnvelope } from '@qu/space-core';
import { QuCrypto } from '@qu/core';
import { PresenceTracker } from './presence-tracker.js';

const HELLO_DOMAIN = 'qu-space-hello-v1'; // MUST match @qu/space-core's own HELLO_DOMAIN (space.js) - duplicated as a literal rather than imported, to keep this package's only @qu/space-core dependency at "the same version, not a live shared module" (matches this file's own already-existing `verifyEnvelope` import boundary).

/**
 * @param {{hub: object, members: Array<{pub: Uint8Array}>, resolveKindSchema: (nodeId: string) => object, storage?: object, bus?: import('@qu/events').EventBus, presence?: PresenceTracker}} params
 */
export function createRelayForwarder({ hub, members, resolveKindSchema, storage = null, bus = null, presence = new PresenceTracker() }) {
  // A local, mutable copy - addMember() (see the returned API, and this
  // file's own "DYNAMIC MEMBERSHIP" doc comment below) appends to THIS
  // array/Set, never to the caller's original `members` argument.
  const memberList = [...members];
  const memberPubs = new Set(memberList.map((m) => QuCrypto.toBase64(m.pub)));
  const isSpaceMember = (pubB64) => memberPubs.has(pubB64);

  /** @type {Array<{nodeId: string, envelope: object}>} Every envelope this relay ever handled, ciphertext/signature only - for tests to assert "no plaintext ever passed through here." */
  const seen = [];

  hub.registerRelay(async (fromPeerId, message) => {
    if (message?.type === 'hello') {
      await handleHello(fromPeerId, message);
      return;
    }
    if (message?.type === 'subscribe') {
      await handleSubscribe(fromPeerId, message);
      return;
    }
    await handleWrite(fromPeerId, message);
  });
  hub.registerDisconnect?.((peerId) => {
    const pubB64 = presence.pubFor?.(peerId) ?? null;
    presence.disconnect(peerId);
    if (pubB64) bus?.emit('debug.relay.presence.offline', { pub: pubB64 });
  });

  /** See this file's own "A THIRD message shape" doc comment. */
  async function handleHello(fromPeerId, { pub, sig }) {
    if (!pub || !sig) {
      bus?.emit('debug.relay.hello.rejected', { reason: 'malformed' });
      return;
    }
    const pubB64 = QuCrypto.toBase64(pub);
    if (!isSpaceMember(pubB64)) {
      bus?.emit('debug.relay.hello.rejected', { reason: 'not-member' });
      return; // not a member - presence is only meaningful for who the relay would ever route to anyway.
    }
    const ok = await QuCrypto.verify(new TextEncoder().encode(HELLO_DOMAIN), sig, pub);
    if (!ok) {
      bus?.emit('debug.relay.hello.rejected', { reason: 'bad-signature' });
      return; // claims a pubkey it can't prove possession of - ignore.
    }
    presence.setOnline(pubB64, fromPeerId);
    bus?.emit('debug.relay.hello.received', { pub: pubB64 });
    bus?.emit('debug.relay.presence.online', { pub: pubB64 });
  }

  /** Mirror-storage catch-up: hand a requesting member everything this relay has mirrored for one Node, regardless of whether the original author is still connected. */
  async function handleSubscribe(fromPeerId, { nodeId, pub, sig }) {
    if (!storage) return; // this relay isn't mirroring anything - nothing to catch a late peer up on.
    if (!pub || !sig) {
      bus?.emit('debug.relay.subscribe.rejected', { nodeId, reason: 'malformed' });
      return;
    }
    const pubB64 = QuCrypto.toBase64(pub);
    if (!isSpaceMember(pubB64)) {
      bus?.emit('debug.relay.subscribe.rejected', { nodeId, reason: 'not-member' });
      return; // not a member - no history for you, mirrored ciphertext or not.
    }
    const ok = await QuCrypto.verify(new TextEncoder().encode(nodeId), sig, pub);
    if (!ok) {
      bus?.emit('debug.relay.subscribe.rejected', { nodeId, reason: 'bad-signature' });
      return; // signature doesn't match the claimed pub - reject, don't trust the claim.
    }
    bus?.emit('debug.relay.subscribe.received', { nodeId, pub: pubB64 });

    const envelopes = await storage.load(nodeId);
    for (const envelope of envelopes) {
      hub.deliverTo(fromPeerId, 'relay', { nodeId, envelope });
    }
    bus?.emit('debug.relay.subscribe.replayed', { nodeId, count: envelopes.length });
  }

  async function handleWrite(fromPeerId, { nodeId, envelope }) {
    const kindSchema = resolveKindSchema(nodeId);
    if (!kindSchema) {
      bus?.emit('debug.relay.write.rejected', { nodeId, reason: 'unknown-node' });
      return; // unknown Node - nothing to route to.
    }
    if (!(await verifyEnvelope(envelope, isSpaceMember))) {
      bus?.emit('debug.relay.write.rejected', { nodeId, reason: 'bad-signature' });
      return; // bad/foreign signature - drop, never forwarded or mirrored.
    }
    bus?.emit('debug.relay.write.received', { nodeId, kind: kindSchema.kind });

    seen.push({ nodeId, envelope });
    if (storage) {
      await storage.append(nodeId, envelope); // the mirror - present even if the author disconnects the instant after this line runs.
      bus?.emit('debug.relay.write.mirrored', { nodeId });
    }

    const toPeerIds = [];
    for (const peerId of hub.peerIds()) {
      if (peerId === fromPeerId) continue; // never echo a write back to its own author.
      hub.deliverTo(peerId, fromPeerId, { nodeId, envelope });
      toPeerIds.push(peerId);
    }
    bus?.emit('debug.relay.write.forwarded', { nodeId, toPeerIds });

    await emitNotify(kindSchema, nodeId, envelope);
  }

  /** See this file's own "PUSH ROUTING" doc comment. No-op entirely when the write carried no `notify` hint, or when `bus` was never given. Awaited by handleWrite() (same as the mirror-storage append above) so a caller awaiting a write's own forwarding also sees every notify-driven handler (a push send included) actually run, not just scheduled. */
  async function emitNotify(kindSchema, nodeId, envelope) {
    if (!bus || !envelope.notify) return;
    const authorPubB64 = QuCrypto.toBase64(envelope.pub);
    const recipients = envelope.notify.to?.length
      ? envelope.notify.to
      : memberList.map((m) => QuCrypto.toBase64(m.pub)).filter((p) => p !== authorPubB64);
    for (const toPubB64 of recipients) {
      await bus.emit(`relay.notify.${kindSchema.kind}.${envelope.notify.topic}`, {
        nodeId,
        kind: kindSchema.kind,
        topic: envelope.notify.topic,
        to: toPubB64,
        authorPub: authorPubB64,
        online: presence.isOnline(toPubB64),
      });
    }
  }

  /**
   * DYNAMIC MEMBERSHIP: adds one new authorized member to this ALREADY
   * RUNNING relay - no restart needed. Intended for exactly one case: a
   * client that generates its own keypair itself (e.g. in a browser, see
   * `demo/web/main.js`) and registers only its PUBLIC halves here - this
   * relay is never handed anything decryptable, same guarantee as every
   * member set at construction time.
   *
   * Deliberately NOT what `docs/v5-space-core-guide.md`'s own "known gaps"
   * section means by "member/key rotation" (that's about a Kind-Schema's
   * write-ACL evolving safely for an EXISTING encrypted Node's readers,
   * which this does nothing for - a newly added member can't retroactively
   * decrypt history they weren't an original recipient of). This only
   * widens WHO may sign/be-routed-to from this point forward.
   *
   * No proof-of-anything is required to call this beyond well-formed keys
   * - see `demo/relay.mjs`'s own `/join` endpoint doc comment for why that
   * is an accepted, loudly-documented demo-only tradeoff, not something to
   * copy into a production relay unmodified.
   *
   * REACTIVE, NOT POLLED: every currently connected peer is told about the
   * new member immediately, over the SAME WebSocket connection they
   * already have open - `{type: 'member-joined', pub, xPub, name}`,
   * broadcast to every `hub.peerIds()` entry the moment this runs. A
   * `Space` on the receiving end handles this message type itself (see
   * `@qu/space-core`'s `space.js` - it calls its own `addMember()` and
   * emits `space.member.joined` on its `bus`), so an already-connected
   * client's membership view updates the instant this fires, not on some
   * client-side poll interval. Trust-wise this asks nothing new of a
   * client: bootstrapping a Space's initial `members` list already means
   * trusting the relay's word for who's in the Space (see e.g.
   * `demo/web/main.js`'s own `/members.json` fetch) - this is that same
   * trust applied continuously instead of once at page-load, not a new
   * boundary crossed.
   * @param {{pub: Uint8Array, xPub: Uint8Array, name?: string}} member
   */
  function addMember(member) {
    const pubB64 = QuCrypto.toBase64(member.pub);
    if (memberPubs.has(pubB64)) return; // already a member - idempotent, not an error.
    memberList.push(member);
    memberPubs.add(pubB64);
    for (const peerId of hub.peerIds()) {
      hub.deliverTo(peerId, 'relay', { type: 'member-joined', pub: member.pub, xPub: member.xPub, name: member.name });
    }
    bus?.emit('debug.relay.member.joined', { pub: pubB64, name: member.name });
  }

  return { seen, presence, addMember };
}
