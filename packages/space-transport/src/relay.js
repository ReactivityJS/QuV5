/**
 * RELAY FORWARDER — the relay is itself a Space member's peer, not just a
 * dumb pipe: it verifies an incoming envelope's write signature against
 * the space's membership, forwards it live to every SUBSCRIBED peer (see
 * this file's own "SUBSCRIBER-TRACKING" doc comment below - deliberately
 * NOT "every connected peer" any more, see that section for why), AND
 * (when given a `storage` adapter) MIRRORS it - so a peer that comes
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
 * Three message shapes flow through here (all defined by @qu/space-core's
 * `Space`, see space.js):
 *   - `{nodeId, envelope}` - a write. Verified, forwarded live to `nodeId`'s
 *     subscribers, mirrored.
 *   - `{type:'subscribe', nodeId, pub, sig}` - a peer asking to (a) become a
 *     live forward target for `nodeId` from now on, AND (b), if `storage`
 *     is configured, catch up on everything already mirrored for it (sent
 *     by `Space.subscribeNode()`/`createNode()` - see this file's own
 *     "SUBSCRIBER-TRACKING" doc comment on why `createNode()` sends one
 *     too). `sig` is that peer's signature over `nodeId` itself, proving
 *     the request came from an actual space member - without this check,
 *     anyone who can connect to the relay could ask for and receive any
 *     Node's full mirrored envelope history (still ciphertext-only, but
 *     node activity/metadata is not nothing). Catch-up (when available) is
 *     answered by replaying every mirrored envelope for that Node straight
 *     to the requester, in storage order.
 *   - `{type:'unsubscribe', nodeId, pub, sig}` - the exact inverse of
 *     `subscribe`'s tracking half (see `Space.unsubscribeNode()`): stops
 *     `nodeId` from being forwarded to this connection. Never touches
 *     mirrored storage (nothing is deleted) - purely a live-forwarding
 *     opt-out.
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
 * SUBSCRIBER-TRACKING: `handleWrite()`'s forward loop reads ONLY from
 * `subscribers` (`nodeId -> Set<peerId>`, populated exclusively by
 * verified `subscribe`/`unsubscribe` messages and pruned on disconnect) -
 * NEVER from `hub.peerIds()` (every connected peer). This is the traffic-
 * shaping half of this Task: a peer that is a space member/Node owner but
 * has never subscribed to a given Node receives literally nothing about
 * it, no matter how small the space is - membership/ownership answers
 * "may I," subscription answers "do I actually want this pushed to me
 * right now," and only the second question governs live traffic. A Node's
 * OWN creator is made a subscriber automatically (`Space.createNode()`
 * sends a `subscribe` too, not just `subscribeNode()`) precisely so this
 * doesn't surprise the one case where "of course I want updates to my own
 * Node" is obviously true (e.g. a `'named'`-ACL grantee writing back to
 * the owner - see @qu/space-core's acl.test.js). A `peerId` is a
 * CONNECTION identity, not a durable one: a reconnecting peer (new
 * WebSocket, new `peerId` from `ws-server-hub.js`) is a stranger to every
 * `subscribers` set until it re-sends its own `subscribe` requests -
 * exactly what constructing a fresh `Space`/calling `subscribeNode()`
 * again already does, so this falls out of the existing Dev API for free
 * rather than needing a reconnect-specific code path. A KNOWN, accepted
 * scope boundary for now (revisit in the relay-federation task): this
 * state is 100% in-memory and per-relay-process, same lifetime as
 * `presence`/`grants` - a relay restart loses it, same as those.
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
 * A FIFTH shape, GRANTS (`'named'`-mode write-ACL only - see
 * `@qu/space-core`'s kind-schema.js on the three `acl.write` modes):
 * `{type:'grant', nodeId, kind, ownerPub, granteePub, sig}`, sent by
 * `Space.grantWriter()` and verified here with `verifyGrant()` (see
 * `@qu/space-core`'s grant.js) BEFORE this relay adds `granteePub` to
 * `grants` (this relay's own `nodeId -> Set<granteePubB64>`, 100% derived
 * from verified grants, mirroring `Space`'s identically-shaped `_grants`)
 * or forwards it onward - a forged grant (wrong owner, tampered
 * `granteePub`, bad signature) is dropped exactly like a forged write,
 * never trusted just because it arrived over an already-open connection.
 * Once verified, it is REACTIVELY broadcast to every OTHER connected peer
 * (same "no polling" shape as `member-joined` above) so every other
 * `Space`'s own `_grants` learns the same fact independently - a relay
 * restart loses this state exactly like it loses `presence`, which is
 * fine: a `grant` is re-sent by the owner whenever they next add the
 * writer's Space to a fresh session, same as `hello`/`subscribe` are
 * re-sent on every reconnect already.
 *
 * FEDERATION (`ingestFederated()` + the `relay.write.local` bus event, see
 * federation.js's own doc comment for the full mechanism): a relay
 * federates with another relay by being a SUBSCRIBING PEER to it -
 * exactly the same `hello`/`subscribe` shapes any ordinary `Space` client
 * sends, over an ordinary Transport connection, nothing relay-specific in
 * the wire protocol at all. `ingestFederated(nodeId, envelope)` is the
 * one integration point: an envelope obtained from upstream is verified
 * and routed through the EXACT same `acceptWrite()` path a local peer's
 * write takes (mirrored, forwarded to THIS relay's own local subscribers,
 * notify-routed) - an upstream relay is trusted no more than a single
 * local peer would be, never automatically. The other direction (a local
 * write reaching a federated Node upstream too) is driven by the
 * `relay.write.local` event `acceptWrite()` fires for every LOCALLY-
 * originated write (never for one `ingestFederated()` just brought in,
 * which is what stops an infinite upstream<->downstream ping-pong without
 * needing a separate dedup mechanism) - `federateRelay()` is the only
 * intended subscriber of it. Demand-driven end to end: nothing is fetched
 * from upstream until a local peer's OWN `subscribe` request for a Node
 * this relay doesn't already have proves there is real local interest -
 * see federation.js for exactly how that trigger is wired.
 *
 * PRESENCE/TYPING/CUSTOM-STATUS - deliberately NOT special-cased here at
 * all. Online/offline liveness stays exactly the pre-existing `hello`/
 * `PresenceTracker` mechanism above (push-routing only, unchanged). Custom
 * status and a "member X is typing" signal are ordinary `acl.write:
 * 'owner'` Node writes (see `@qu/space-core`'s `presence.js` -
 * `presenceKind`, `Space.setStatus()`/`setTyping()`/`watchPresence()`) that
 * flow through the EXACT SAME `handleWrite()`/`handleSubscribe()` path as
 * any other Kind - the only thing that makes them "ephemeral" is that
 * `presenceKind` declares `persistence: 'volatile'` (see this file's own
 * "PERSISTENCE TIERS" doc comment below and kind-schema.js), which routes
 * their mirroring to an in-memory store instead of `storage`, not a
 * transport-level bypass. This was a deliberate design correction: an
 * earlier draft of this Task added bespoke `'typing'`/`'presence'` wire
 * messages with their own relay code paths - reverted in favor of this,
 * because "the storage adapter decides persistence, not the protocol" is a
 * strictly more reusable mechanism (any future low-value/high-churn Kind
 * gets it for free) and keeps the relay's own message vocabulary exactly
 * as small as it was before this Task.
 *
 * PERSISTENCE TIERS: `resolveKindSchema(nodeId)`'s returned Kind-Schema now
 * also decides WHICH storage a write mirrors to - `kindSchema.persistence
 * === 'volatile'` routes to `volatileStorage` (an in-memory store, created
 * automatically if the caller doesn't supply one - see this function's own
 * parameters), anything else (including a relay like `relay-server.js`'s
 * own `resolveKindSchema: () => true`, which resolves no real Kind-Schema
 * at all) keeps using `storage` exactly as before this existed. This is
 * the SAME swappable-adapter idea `@qu/space-storage`'s own memory/durable/
 * file stores already embody at the whole-space level, now selectable
 * PER KIND - a caller wanting even `storage`-backed Kinds to survive only
 * as long as a browser tab (e.g. sessionStorage instead of localStorage)
 * does so by handing `Space`/the relay a differently-backed adapter
 * object, never by this framework treating the DATA differently.
 *
 * WRITE-ACK: once `acceptWrite()` has mirrored a LOCALLY-originated write
 * to `storage` (when one is configured), it sends `{type:'write-ack',
 * nodeId, seq}` back to that write's own author (`excludePeerId`) -
 * `seq` is simply "how many envelopes this Node's mirror now holds", a
 * cheap, storage-derived acknowledgment a Kind-Schema/plugin can compare
 * against "how many writes I've sent" to know a write reached the relay's
 * durable mirror (`'relay-synced'`), as distinct from a live peer merely
 * having received and applied it (`'client-synced'`, which a Space already
 * observes as an ordinary remote write) - see `@qu/space-plugins`'
 * `delivery-status.js` for the intended consumer. A no-op when no `storage`
 * is configured - there is nothing to have durably mirrored yet.
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
 *     (`{nodeId, toPeerIds}`) / `.mirrored` (`{nodeId, snapshot}`, only when
 *     a `storage` adapter is configured - `snapshot: true` means this
 *     envelope REPLACED the Node's whole mirrored log, see "SNAPSHOT/
 *     COMPACTION" in @qu/space-core's envelope.js).
 *   - `debug.relay.subscribe.received` / `.rejected` (`{nodeId, reason}`)
 *     / `.replayed` (`{nodeId, count}`).
 *   - `debug.relay.unsubscribe.received` (`{nodeId, pub}`) / `.rejected`
 *     (`{nodeId, reason}`).
 *   - `debug.relay.hello.received` / `.rejected` (`{reason}`).
 *   - `debug.relay.presence.online` / `.offline` (`{pub}`).
 *   - `debug.relay.grant.received` (`{nodeId, granteePub}`) / `.rejected` (`{nodeId}`).
 * A relay never has a decryption key regardless of whether `bus` is wired
 * up - none of this exposes anything `seen`/`emitNotify()` don't already.
 */
import { verifyEnvelope, deriveOwnerNodeId, verifyGrant } from '@qu/space-core';
import { QuCrypto } from '@qu/core';
import { createMemoryStore } from '@qu/space-storage';
import { PresenceTracker } from './presence-tracker.js';

const HELLO_DOMAIN = 'qu-space-hello-v1'; // MUST match @qu/space-core's own HELLO_DOMAIN (space.js) - duplicated as a literal rather than imported, to keep this package's only @qu/space-core dependency at "the same version, not a live shared module" (matches this file's own already-existing `verifyEnvelope` import boundary).

/**
 * @param {{hub: object, members: Array<{pub: Uint8Array}>, resolveKindSchema: (nodeId: string) => object, storage?: object, volatileStorage?: object, bus?: import('@qu/events').EventBus, presence?: PresenceTracker}} params
 *   `volatileStorage` - see this file's own "PERSISTENCE TIERS" doc comment: the mirror for any Kind whose Kind-Schema declares `persistence: 'volatile'` (e.g. `@qu/space-core`'s `presenceKind`), regardless of what `storage` above is. Defaults to a private `@qu/space-storage` `createMemoryStore()` - a fresh one per `createRelayForwarder()` call, never shared across relay instances by accident.
 */
export function createRelayForwarder({ hub, members, resolveKindSchema, storage = null, volatileStorage = createMemoryStore(), bus = null, presence = new PresenceTracker() }) {
  /** See this file's own "PERSISTENCE TIERS" doc comment. */
  function storageFor(kindSchema) {
    return kindSchema?.persistence === 'volatile' ? volatileStorage : storage;
  }

  /**
   * A grant's own storage key - DELIBERATELY separate from `nodeId` itself
   * (which only ever holds ENVELOPES, see handleWrite()) even though both
   * live in the SAME storage adapter: `Space.compactNode()`/`storage.
   * replace(nodeId, ...)` (see @qu/space-core's space.js) OVERWRITES a
   * Node's entire envelope log with one snapshot - if grants shared that
   * same key, compacting a `'content'`-ACL Node would silently WIPE every
   * grant it ever had, including the creating owner's own self-grant (see
   * kind-schema.js's own "THE 'content' ACL mode" doc comment on why
   * `'content'` has no owner-pubkey shortcut - unlike `'owner'`/`'named'`,
   * losing a grant is not recoverable by re-deriving anything). A separate
   * key means compaction never touches it.
   */
  function grantStorageKey(nodeId) {
    return `grant:${nodeId}`;
  }
  // A local, mutable copy - addMember() (see the returned API, and this
  // file's own "DYNAMIC MEMBERSHIP" doc comment below) appends to THIS
  // array/Set, never to the caller's original `members` argument.
  const memberList = [...members];
  const memberPubs = new Set(memberList.map((m) => QuCrypto.toBase64(m.pub)));
  const isSpaceMember = (pubB64) => memberPubs.has(pubB64);

  /** @type {Map<string, Set<string>>} nodeId -> Set<base64 Ed25519 pubkey> - 'named'-mode write-ACL state, 100% derived from verified `grant` messages (see grant.js) - see this file's own "GRANTS" doc comment below. */
  const grants = new Map();

  /**
   * @type {Map<string, Set<string>>} nodeId -> Set<peerId> - see this
   * file's own "SUBSCRIBER-TRACKING" doc comment below. The ONLY source of
   * truth `handleWrite()`'s forward loop reads from - a peer never
   * receives a write for a Node it never asked for, no matter how many
   * Nodes it's a signed-for member/owner of.
   */
  const subscribers = new Map();

  /** @type {Array<{nodeId: string, envelope: object}>} Every envelope this relay ever handled, ciphertext/signature only - for tests to assert "no plaintext ever passed through here." */
  const seen = [];

  /** @type {Map<string, number>} nodeId -> how many envelopes this relay's mirror currently holds for it - the `seq` a WRITE-ACK reports (see this file's own "WRITE-ACK" doc comment). Reset to 1 on a snapshot/compaction (`storage.replace()`), incremented on every ordinary append - mirrors exactly what `storage.load(nodeId)` would return the length of, without an extra read per write. */
  const mirrorCount = new Map();

  /**
   * @type {Map<string, Promise>} peerId -> the tail of that peer's own
   * serialized message-processing chain. Neither hub implementation
   * (`ws-server-hub.js`'s `ws.on('message', ...)`, `in-process-transport.js`'s
   * `sendToRelay()`) AWAITS the handler registered below before delivering
   * the NEXT message - each incoming message's processing (crypto
   * verification is genuinely async) can therefore COMPLETE out of arrival
   * order, exactly the same race `@qu/space-core`'s `Space` had to close on
   * its own incoming side (see that file's own `_handleIncoming()` doc
   * comment) for the identical reason: `acl.write: 'content'` (kind-
   * schema.js) needs a `grant` message's effect (`grants.set(...)` below)
   * to be VISIBLE before the write that depends on it is checked, and
   * "arrived first" only guarantees that if "finishes processing first"
   * also holds - which async work alone does not guarantee. Serialized
   * PER PEER (not globally): different peers' messages have no ordering
   * dependency on each other, so there is no reason to serialize their
   * throughput together.
   */
  const peerQueues = new Map();

  hub.registerRelay((fromPeerId, message) => {
    const tail = (peerQueues.get(fromPeerId) ?? Promise.resolve()).then(() => dispatch(fromPeerId, message));
    peerQueues.set(fromPeerId, tail.catch(() => {})); // never let one bad message wedge this peer's later ones.
    return tail;
  });

  async function dispatch(fromPeerId, message) {
    if (message?.type === 'hello') {
      await handleHello(fromPeerId, message);
      return;
    }
    if (message?.type === 'subscribe') {
      await handleSubscribe(fromPeerId, message);
      return;
    }
    if (message?.type === 'unsubscribe') {
      await handleUnsubscribe(fromPeerId, message);
      return;
    }
    if (message?.type === 'grant') {
      await handleGrant(fromPeerId, message);
      return;
    }
    await handleWrite(fromPeerId, message);
  }
  hub.registerDisconnect?.((peerId) => {
    const pubB64 = presence.pubFor?.(peerId) ?? null;
    presence.disconnect(peerId);
    if (pubB64) bus?.emit('debug.relay.presence.offline', { pub: pubB64 });
    for (const peerIds of subscribers.values()) peerIds.delete(peerId); // a dropped connection stops being a forward target for everything it had subscribed to - see this file's own "SUBSCRIBER-TRACKING" doc comment on why a fresh connection must re-subscribe from scratch anyway.
    peerQueues.delete(peerId); // that peer's own queue can never receive another message - nothing left to serialize.
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

  /**
   * Registers `fromPeerId` as a live forward target for `nodeId` (see this
   * file's own "SUBSCRIBER-TRACKING" doc comment) - happens REGARDLESS of
   * whether `storage` is configured, unlike the mirror-catch-up replay
   * below it (a live-only relay can still track who wants live pushes,
   * even with nothing to replay for a peer arriving late). Also, when
   * `storage` IS configured, hands the requester everything this relay has
   * already mirrored for the Node, regardless of whether the original
   * author is still connected.
   */
  async function handleSubscribe(fromPeerId, { nodeId, pub, sig }) {
    if (!pub || !sig) {
      bus?.emit('debug.relay.subscribe.rejected', { nodeId, reason: 'malformed' });
      return;
    }
    const pubB64 = QuCrypto.toBase64(pub);
    // Same reasoning as buildWriteAcl() below: an 'owner'/'named'/'content' Node opted OUT of the
    // flat membership model already (Task 3's whole point, extended to 'content' by the
    // per-owner-content-ACL task) - requiring membership just to SUBSCRIBE to one would silently
    // strand a legitimate owner/grantee who was never added as a "member" anywhere, now that
    // subscription (not mere connection) is what gates live forwarding at all. A 'members'-mode
    // Kind (or an unresolvable nodeId - e.g. relay-server.js's own `resolveKindSchema: () => true`)
    // keeps the original membership gate exactly as before.
    const kindSchema = resolveKindSchema(nodeId);
    const contentAclModes = new Set(['owner', 'named', 'content']);
    const requiresMembership = !contentAclModes.has(kindSchema?.acl?.write);
    if (requiresMembership && !isSpaceMember(pubB64)) {
      bus?.emit('debug.relay.subscribe.rejected', { nodeId, reason: 'not-member' });
      return; // not a member - no history for you, mirrored ciphertext or not.
    }
    const ok = await QuCrypto.verify(new TextEncoder().encode(nodeId), sig, pub);
    if (!ok) {
      bus?.emit('debug.relay.subscribe.rejected', { nodeId, reason: 'bad-signature' });
      return; // signature doesn't match the claimed pub - reject, don't trust the claim.
    }
    if (!subscribers.has(nodeId)) subscribers.set(nodeId, new Set());
    subscribers.get(nodeId).add(fromPeerId);
    bus?.emit('debug.relay.subscribe.received', { nodeId, pub: pubB64 });

    const nodeStorage = storageFor(kindSchema);
    if (!nodeStorage) return; // nothing to catch up on - but the subscription itself is tracked either way, live pushes still reach this peer from here on.
    // Grants FIRST, always - see grantStorageKey()'s own doc comment: a 'content'-ACL Node's
    // envelopes (including its very first, from the creating owner) are only verifiable by a
    // subscriber who has already seen the matching grant, exactly the "WRITE-BEFORE-GRANT IS A
    // TRAP" ordering grant.js documents, just applied to catch-up replay instead of a live sequence.
    const storedGrants = await nodeStorage.load(grantStorageKey(nodeId));
    for (const grantMessage of storedGrants) {
      hub.deliverTo(fromPeerId, 'relay', grantMessage);
    }
    const envelopes = await nodeStorage.load(nodeId);
    for (const envelope of envelopes) {
      hub.deliverTo(fromPeerId, 'relay', { nodeId, envelope });
    }
    bus?.emit('debug.relay.subscribe.replayed', { nodeId, count: envelopes.length, grants: storedGrants.length });
  }

  /**
   * The exact inverse of `handleSubscribe()`'s tracking half: removes
   * `fromPeerId` from `nodeId`'s forward-target set, same signature
   * convention as `subscribe` (`sig` over the bare `nodeId` string). Not
   * gated on anything beyond authenticity - unsubscribing narrows what a
   * peer receives, it can't be used to affect anyone else's subscription
   * (`fromPeerId` is the connection's own identity, not a claim about who
   * to remove), so there is no "who's allowed to unsubscribe whom" question
   * the way there is for a write or a grant.
   */
  async function handleUnsubscribe(fromPeerId, { nodeId, pub, sig }) {
    if (!pub || !sig) {
      bus?.emit('debug.relay.unsubscribe.rejected', { nodeId, reason: 'malformed' });
      return;
    }
    const ok = await QuCrypto.verify(new TextEncoder().encode(nodeId), sig, pub);
    if (!ok) {
      bus?.emit('debug.relay.unsubscribe.rejected', { nodeId, reason: 'bad-signature' });
      return;
    }
    subscribers.get(nodeId)?.delete(fromPeerId);
    bus?.emit('debug.relay.unsubscribe.received', { nodeId, pub: QuCrypto.toBase64(pub) });
  }

  /**
   * See this file's own "GRANTS" doc comment. Verified with `verifyGrant()`
   * BEFORE anything here trusts it - a relay never adds a pubkey to
   * `grants` on the strength of the message merely arriving, only on the
   * strength of an owner's actual signature over it, exactly as strict as
   * verifying a write's own signature.
   */
  async function handleGrant(fromPeerId, message) {
    const { nodeId } = message ?? {};
    if (!(await verifyGrant(message))) {
      bus?.emit('debug.relay.grant.rejected', { nodeId });
      return;
    }
    const granteePubB64 = QuCrypto.toBase64(message.granteePub);
    if (!grants.has(nodeId)) grants.set(nodeId, new Set());
    grants.get(nodeId).add(granteePubB64);
    bus?.emit('debug.relay.grant.received', { nodeId, granteePub: granteePubB64 });

    // Durable, same storage adapter envelopes use (a distinct key - see grantStorageKey()'s own
    // doc comment) - without this, a peer who subscribes to a 'content'-ACL Node AFTER this grant
    // was broadcast (the relay restarted, or they simply weren't connected yet - the App Shell's
    // own core "visitor arrives after the app-admin already published" scenario) would never learn
    // the creating owner was ever authorized at all: unlike 'named', 'content' has no owner-pubkey
    // shortcut (kind-schema.js), so EVERY reader needs to have actually seen a grant, not just the
    // relay's own in-memory `grants` map (which handleSubscribe()'s envelope replay alone can't fix).
    const kindSchema = resolveKindSchema(nodeId);
    await storageFor(kindSchema)?.append(grantStorageKey(nodeId), message);

    // Reactive, same pattern as addMember()'s 'member-joined' broadcast: every OTHER already-
    // connected peer's own Space needs this exact grant too, to accept the new writer's future
    // remote writes locally (see @qu/space-core's space.js `_isAuthorizedWriter()`/`_applyGrant()`).
    for (const peerId of hub.peerIds()) {
      if (peerId === fromPeerId) continue; // the owner already applied this to their own Space in grantWriter() - no need to echo it back.
      hub.deliverTo(peerId, fromPeerId, message);
    }
  }

  /**
   * Builds this Node's write-ACL check for `verifyEnvelope()` - mirrors
   * `@qu/space-core`'s own `Space._isAuthorizedWriter()` exactly (same
   * three `acl.write` modes, see kind-schema.js), just relay-side: a
   * `'members'` Kind is still gated on this relay's flat `memberList` (the
   * PoC's only mode for that kind), while `'owner'`/`'named'` is 100%
   * self-certifying/grant-derived - notably NOT gated on `memberList` at
   * all, so an owner never needs to be registered as a "member" anywhere
   * to write their own Node (see kind-schema.js's own doc comment on why
   * that's the whole point of `deriveOwnerNodeId()`). A known, accepted
   * scope boundary for now: such a not-otherwise-a-member owner's `hello`
   * still gates on `isSpaceMember` below (it carries no `nodeId`, so there
   * is no per-Kind ACL mode to consult the way `handleSubscribe()` does),
   * so presence/push don't yet extend to them - revisit in the relay-
   * federation task, which has to rethink this gate anyway.
   *
   * `kindSchema?.acl?.write` anything OTHER than exactly `'owner'`/
   * `'named'`/`'content'` (including a relay like `relay-server.js`'s own
   * that deliberately never resolves a real Kind-Schema at all, see that
   * file's own doc comment) is treated as `'members'` - the flat,
   * always-available fallback ACL every relay can enforce with zero
   * Kind-Schema knowledge, matching this relay's exact behavior before
   * this Task existed. `'content'` (many-per-owner, e.g. `@qu/app-core`'s
   * `qu-page`/`qu-template`/`qu-style`) is PURELY grant-derived - unlike
   * `'named'`, there is no owner-pubkey shortcut (a `nodeId` alone cannot
   * be inverted back to the `path` a verifier would need to recompute it -
   * see `@qu/space-core`'s kind-schema.js) - `Space.createNode()` issues
   * the creating owner a transparent SELF-grant instead (see that file's
   * own doc comment), which arrives here as an ordinary signed `grant`
   * message exactly like any other, verified by the SAME `verifyGrant()`.
   */
  function buildWriteAcl(kindSchema, nodeId) {
    const mode = kindSchema?.acl?.write;
    if (mode !== 'owner' && mode !== 'named' && mode !== 'content') return isSpaceMember;
    if (mode === 'content') return (pubB64) => grants.get(nodeId)?.has(pubB64) ?? false;
    return async (pubB64) => {
      const ownerNodeId = await deriveOwnerNodeId(QuCrypto.fromBase64(pubB64), kindSchema.kind);
      if (ownerNodeId === nodeId) return true;
      if (mode === 'named') return grants.get(nodeId)?.has(pubB64) ?? false;
      return false;
    };
  }

  async function handleWrite(fromPeerId, { nodeId, envelope }) {
    const kindSchema = resolveKindSchema(nodeId);
    if (!kindSchema) {
      bus?.emit('debug.relay.write.rejected', { nodeId, reason: 'unknown-node' });
      return; // unknown Node - nothing to route to.
    }
    if (!(await verifyEnvelope(envelope, buildWriteAcl(kindSchema, nodeId)))) {
      bus?.emit('debug.relay.write.rejected', { nodeId, reason: 'bad-signature' });
      return; // bad/foreign signature - drop, never forwarded or mirrored.
    }
    await acceptWrite(kindSchema, nodeId, envelope, fromPeerId);
  }

  /**
   * The shared "a verified write exists, do everything with it" path -
   * factored out of `handleWrite()` so `ingestFederated()` (see this
   * file's own "FEDERATION" doc comment below) can feed in an envelope
   * that arrived from an UPSTREAM relay instead of a local peer, without
   * duplicating mirror/forward/notify logic.
   *
   * `excludePeerId` is `null` for a federated envelope (nothing local to
   * exclude - an upstream relay is not one of `hub.peerIds()`) and a real
   * peerId for an ordinary local write (never echo a write back to its own
   * local author). This distinction is also EXACTLY how federation decides
   * which writes to relay upstream in the first place: only a write with a
   * real (non-null) `excludePeerId` - i.e. one that genuinely originated
   * from one of THIS relay's own local peers - fires `relay.write.local`,
   * so an envelope this relay only just received FROM upstream is never
   * immediately bounced back upstream again.
   */
  async function acceptWrite(kindSchema, nodeId, envelope, excludePeerId) {
    bus?.emit('debug.relay.write.received', { nodeId, kind: kindSchema.kind });

    seen.push({ nodeId, envelope });
    const nodeStorage = storageFor(kindSchema);
    if (nodeStorage) {
      // A `snapshot: true` envelope (see @qu/space-core's envelope.js "SNAPSHOT/COMPACTION" doc
      // comment) REPLACES this Node's entire mirrored log instead of appending to it - the actual
      // fix for a mirror that otherwise grows forever, even past content Yjs itself already
      // garbage-collected in memory. Authorized identically to any other write (verifyEnvelope()
      // above already ran the SAME ACL check) - no separate "who may compact" concept exists.
      if (envelope.snapshot) {
        await nodeStorage.replace(nodeId, [envelope]);
        mirrorCount.set(nodeId, 1);
      } else {
        await nodeStorage.append(nodeId, envelope); // the mirror - present even if the author disconnects the instant after this line runs.
        mirrorCount.set(nodeId, (mirrorCount.get(nodeId) ?? 0) + 1);
      }
      bus?.emit('debug.relay.write.mirrored', { nodeId, snapshot: envelope.snapshot === true });
      // See this file's own "WRITE-ACK" doc comment - only meaningful for a LOCALLY-originated
      // write (a real `excludePeerId`); a federated envelope has no local author on this relay to ack.
      if (excludePeerId !== null) hub.deliverTo(excludePeerId, 'relay', { type: 'write-ack', nodeId, seq: mirrorCount.get(nodeId) });
    }

    const toPeerIds = [];
    for (const peerId of subscribers.get(nodeId) ?? []) {
      if (peerId === excludePeerId) continue; // never echo a write back to its own local author.
      hub.deliverTo(peerId, excludePeerId ?? 'federation', { nodeId, envelope });
      toPeerIds.push(peerId);
    }
    bus?.emit('debug.relay.write.forwarded', { nodeId, toPeerIds });

    if (excludePeerId !== null) bus?.emit('relay.write.local', { nodeId, envelope }); // see "FEDERATION" doc comment - a federateRelay() upstream link is the only intended subscriber of this.

    await emitNotify(kindSchema, nodeId, envelope);
  }

  /**
   * FEDERATION entrypoint: accepts an envelope this relay obtained from an
   * UPSTREAM relay it federates with (see federation.js's `federateRelay()`
   * - it calls exactly this, nothing more privileged), verified and routed
   * through the EXACT same `acceptWrite()` path as any local write - an
   * upstream relay is trusted no more and no less than any single local
   * peer would be: still gated by this Node's real write-ACL
   * (`buildWriteAcl()`), still mirrored/forwarded/notify-routed identically.
   * Returns `false` (silently, no `debug.relay.write.rejected` event -
   * federation.js decides its own logging) for an unknown Node or a
   * signature that fails verification, so a compromised/misbehaving
   * upstream relay can never inject unauthorized content downstream.
   * @param {string} nodeId
   * @param {object} envelope
   * @returns {Promise<boolean>} whether the envelope was accepted.
   */
  async function ingestFederated(nodeId, envelope) {
    const kindSchema = resolveKindSchema(nodeId);
    if (!kindSchema) return false;
    if (!(await verifyEnvelope(envelope, buildWriteAcl(kindSchema, nodeId)))) return false;
    await acceptWrite(kindSchema, nodeId, envelope, null);
    return true;
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

  return { seen, presence, addMember, ingestFederated };
}
