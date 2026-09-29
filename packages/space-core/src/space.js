/**
 * SPACE — the V5 replacement for QuStore's `mount()`/pipeline. A Space is
 * one peer's live view of a set of Nodes, wired to exactly one Transport
 * and (optionally) one Storage adapter. There is no QuStore-shaped
 * `get(path)`/`put(path, val)` facade here on purpose (see docs/v5-space-core-guide.md's
 * decision to drop path/QuBit compatibility) - callers work with typed
 * Node/Field handles directly (see node.js/field.js).
 *
 * Four ways to get a `SpaceNode` handle, each for a different situation -
 * `useNode()` (see its own doc comment below) is the recommended DEFAULT
 * for app/UI code that just wants "give me this Node": local-first, lazy,
 * reference-counted, no need to think about which of the other three
 * applies. The other three exist because SOMETHING has to implement that
 * default, and each is occasionally useful directly: `createNode()` (this
 * peer originates a brand-new Node), `subscribeNode()` (a known Node id,
 * live sync, no reference counting), `loadNode()` (local storage only, no
 * network at all - the "durable persistence survives a reload with zero
 * live sync" tier).
 *
 * The only two things a Space does that a bare Y.Doc doesn't:
 *   1. Every LOCALLY produced Yjs update gets sealed (signed + encrypted,
 *      see envelope.js) before it reaches storage.append()/transport.send() -
 *      a Node never leaks a raw, unsigned update.
 *   2. Every INCOMING envelope gets its write-signature verified against
 *      this Node's Kind-Schema ACL, THEN decrypted, THEN applied via
 *      `Y.applyUpdate(doc, bytes, REMOTE_ORIGIN)` - the `REMOTE_ORIGIN`
 *      marker is what stops step 1 from re-sealing and re-broadcasting an
 *      update this Space just received, the same "don't echo a synced
 *      write back out" problem QuStore's own `putSealed()` doc comment
 *      describes for `origin: 'sync'`.
 *
 * An optional `bus` (`@qu/events`' `EventBus`) turns every applied update -
 * local OR remote - into two kinds of granular event, so app code never
 * has to hand-roll its own "did anything change" plumbing on top of Yjs'
 * own low-level `observe()`:
 *   - `space.node.<nodeId>.changed` - ALWAYS, `{nodeId, kind, origin}`
 *     (`origin` is `'local'` or `'remote'`) - the generic change-event feed
 *     (UI reactivity, caches, ...), independent of any notify hint.
 *   - `notification.<kind>.<topic>` - ONLY when the write carried a
 *     `notify` hint (see field.js's `{notify}` option / envelope.js's own
 *     doc comment) - the semantic notification feed a delivery handler
 *     (toast/browser Notification/relay-triggered push) subscribes to.
 *     `{nodeId, kind, topic, to, authorPub, origin}` - `to` is the hint's
 *     own (optional) recipient narrowing, `authorPub` is who wrote it.
 *   - `space.member.joined` - REACTIVE dynamic membership: fires the
 *     instant this Space receives a relay's `{type:'member-joined', pub,
 *     xPub, name?}` broadcast (see `@qu/space-transport`'s relay.js
 *     `addMember()`) - `{pub, xPub, name}` (base64). This Space's own
 *     `addMember()` (see below) has ALREADY run by the time this fires, so
 *     a handler reacting to it (e.g. re-rendering a member list) sees a
 *     Space that's already able to encrypt-for/accept-from that member -
 *     no separate step needed, and deliberately no polling: the transport
 *     connection this arrives on is already open for every other message
 *     type, so a new member is learned about exactly as promptly as a
 *     Node update is.
 *   - `space.member.left` - the exact inverse, on a relay's `{type:
 *     'member-left', pub}` broadcast (see relay.js's own `removeMember()`)
 *     - `{pub}` (base64). `removeMember()` has ALREADY run by the time this
 *     fires, same ordering as `space.member.joined` above.
 *   - `space.relay-admin.added` / `.removed` - the SAME reactive shape as
 *     `space.member.joined`/`.left`, for the SEPARATE `acl.write:
 *     'relay-admins'` list instead (kind-schema.js's own doc comment on the
 *     mode) - `{pub}` (base64, no `xPub` - this list is never an encryption
 *     recipient set, see this file's own constructor doc comment on
 *     `relayAdmins`).
 *   - `space.status.changed` - `{status}`, straight from the transport's
 *     own `onStatusChange()` if it has one (see e.g. `@qu/space-transport`'s
 *     `WsClientTransport` - `InProcessTransport` has none, so this never
 *     fires there): `'connected'`/`'disconnected'`/`'reconnecting'`/
 *     `'reconnected'` - a UI's own "you're offline"/"reconnecting…" banner
 *     reads this feed directly, no separate connectivity API needed.
 * Custom presence status and "member X is typing" are DELIBERATELY not a
 * feed documented here - see `presence.js`'s own doc comment: they're
 * ordinary Node writes (`presenceKind`, `acl.write: 'owner'`,
 * `persistence: 'volatile'`), so they emit the exact SAME `space.node.
 * <nodeId>.changed` this doc comment already describes, nothing special.
 *
 * RESYNC ON RECONNECT: the same `onStatusChange` wiring that emits
 * `space.status.changed` also re-sends `hello` and re-subscribes every
 * currently attached Node (`this._nodes`) on `'connected'`/`'reconnected'` -
 * a relay answers each re-`subscribe` by replaying its full mirror for that
 * Node (see relay.js's `handleSubscribe()`), so whatever changed while this
 * Space was offline (this peer's own queued writes included - see
 * `WsClientTransport`'s own send-queue doc comment) arrives the same way
 * initial catch-up already does. No separate "diff" protocol needed: Yjs
 * updates are idempotent to re-apply, so replaying already-known history
 * is harmless, just occasionally redundant - `compactNode()` is the
 * existing answer for keeping that redundant history small.
 * Omitting `bus` (the default) makes a Space behave exactly as before this
 * existed - nothing is emitted, nothing else changes. Resync itself does
 * NOT depend on `bus` - it runs regardless, `bus` only reports it.
 *
 * WARM-RELEASE CACHE (opt-in, default OFF - `warmNodeTTL: 0`, exactly
 * today's behavior, unchanged): `useNode()`/`release()`'s reference count
 * hitting zero has always meant "tear the local Y.Doc down and unsubscribe
 * right now" (`_releaseNode()` below) - correct, but means EVERY later
 * re-resolution of the SAME Node (a visitor navigating back to a page they
 * were just on, a second `<div data-qu-view>` reading the same source a
 * moment after the first) pays a full fresh `subscribe` + wait-for-
 * `sync-ack` round trip again, even though nothing about that Node could
 * possibly have gone stale in between (it was live-subscribed the whole
 * time - see `resolver.js`'s `waitFor()`/`isNodeSynced()` own doc comments
 * for why that round trip exists at all). Passing `warmNodeTTL > 0` changes
 * ONLY what happens at refcount-zero: instead of unsubscribing immediately,
 * the Node stays attached AND subscribed (still receiving live updates
 * completely normally - nothing about "warm" means "paused") for up to
 * `warmNodeTTL` ms, real teardown deferred until either that timer fires or
 * `maxWarmNodes` is exceeded (oldest-warmed evicted first - insertion order
 * into `_warmSince` IS recency order, since a warm entry, by definition,
 * isn't touched again until either re-`useNode()`d or evicted/expired - see
 * `_releaseNode()`'s own doc comment). A `useNode()` call for a still-warm
 * id cancels the pending teardown and hands back the SAME already-synced
 * handle - `waitFor()`'s own very first, synchronous `checkFn()` call
 * (`resolver.js`) then resolves INSTANTLY, no network wait at all, for
 * free, with ZERO changes needed in `resolver.js`/`ContentResolver` - this
 * is deliberately not a second, parallel "resolved value" cache with its
 * own invalidation rules (a real, previously-caught bug class in this exact
 * codebase - see `resolver.js`'s own doc comments on stale-read races this
 * project has already been bitten by): it is the EXISTING live subscription
 * + `isNodeSynced()` state, simply kept a while longer before being thrown
 * away, so staying correct is automatic (self-correcting via the ordinary
 * live-update path) rather than something a cache invalidation scheme has
 * to get right.
 *
 * `staleAfter` (ms, default `0` = disabled) is the DEFENSIVE belt-and-
 * suspenders on top: even a warm, continuously-subscribed Node could in
 * principle miss a write if a relay silently dropped its in-memory
 * subscriber-list entry for this peer without the transport itself
 * detecting a disconnect (`_handleTransportStatus()`'s own "RESYNC ON
 * RECONNECT" doc comment already covers the ordinary "genuinely went
 * offline" case for free - any Node still warm at reconnect time gets
 * automatically re-subscribed then, no separate mechanism needed for that).
 * `staleAfter` covers the narrower remaining gap: a `useNode()` reacquiring
 * a warm Node whose last confirmed `sync-ack` is older than `staleAfter`
 * clears `isNodeSynced()` for it and sends one fresh `subscribe` before
 * returning - the SAME real round trip a cold resolve pays, just bounded to
 * "at most once every `staleAfter` ms per Node," not every single
 * re-resolution. `forceRevalidate: true` on `useNode()` does the identical
 * thing unconditionally, regardless of age - the explicit "I want this
 * proven fresh right now" escape hatch (a pull-to-refresh action, an
 * editor's own "did my save actually land" check).
 *
 * The SAME `bus` also gets a `debug.space.*` family, purely for optional
 * debugging/observability (see `@qu/events`' `createDebugLogger()`) - every
 * write-lifecycle step the two app-facing topics above only summarize:
 *   - `debug.space.write.local` - a local update was sealed and sent,
 *     `{nodeId, kind, bytes, notify}` (`bytes` = the raw Yjs update's
 *     length, before encryption - a rough "how big was this write" signal).
 *   - `debug.space.write.remote.accepted` - an incoming envelope passed
 *     signature verification and was applied, `{nodeId, kind, authorPub, bytes}`.
 *   - `debug.space.write.remote.rejected` - an incoming envelope FAILED
 *     signature verification (tampered, or signed by a non-member) and was
 *     dropped before touching the CRDT, `{nodeId, authorPub}`.
 *   - `debug.space.write.remote.ignored` - an incoming envelope arrived for
 *     a Node this Space never subscribed to (ordinary relay fan-out, not
 *     an error) and was silently ignored, `{nodeId}`.
 *   - `debug.space.write.remote.undecryptable` - an incoming envelope was
 *     authentic and ACL-authorized (passed `verifyEnvelope()`) but this
 *     identity isn't among ITS OWN recipient list (`openUpdate()` throwing -
 *     see envelope.js's own doc comment) - routinely expected for history
 *     sealed before this identity became a Space member, never applied to
 *     the doc, `{nodeId}`.
 *   - `debug.space.subscribe.sent` / `debug.space.unsubscribe.sent` /
 *     `debug.space.hello.sent` - the signed control messages this Space
 *     sends on its own, `{nodeId}` / `{nodeId}` / `{}`.
 *   - `debug.space.grant.received` / `.rejected` - an incoming `grant`
 *     control message (see grant.js) was verified and applied, or wasn't, `{nodeId}`.
 *   - `debug.space.compact.sent` - this Space compacted a Node it owns/may
 *     write to (see `compactNode()`), `{nodeId, bytes}`.
 * Deliberately NOT instrumented: plain local reads (`field.get()`/
 * `toArray()`) - they touch no network/storage and aren't where a sync bug
 * usually hides; this stays scoped to what actually crosses a process
 * boundary or gets persisted.
 *
 * A Space also announces itself to whatever it's connected to with one
 * signed `{type:'hello', pub, sig}` message on construction (fire-and-
 * forget, same posture as `subscribeNode()`'s own subscribe request) -
 * `sig` over the fixed `HELLO_DOMAIN` string, proving possession of the
 * signing key without revealing anything else. A relay's own
 * `PresenceTracker` (`@qu/space-transport`) is the intended reader: it's
 * how the relay learns "this pubkey is on THIS connection right now,"
 * which is what makes "only Push if the recipient is actually offline"
 * possible (see relay.js's own doc comment). A peer-to-peer transport with
 * no relay simply never reads this message - harmless, not required.
 */
import * as Y from 'yjs';
import { QuCrypto } from '@qu/core';
import { SpaceNode, stampMeta } from './node.js';
import { sealUpdate, sealPublicUpdate, verifyEnvelope, openUpdate } from './envelope.js';
import { deriveOwnerNodeId, deriveContentNodeId, defineKind } from './kind-schema.js';
import { signGrant, verifyGrant } from './grant.js';
import { signGroupMembership } from './group-membership.js';
import { sealStrategies } from './seal-strategies.js';

const REMOTE_ORIGIN = Symbol('space-core:remote-update');

/** Signed by a Space on connect to prove key possession for presence purposes - see this file's own doc comment. Exported so `@qu/space-transport`'s relay verifies against the exact same bytes. */
export const HELLO_DOMAIN = 'qu-space-hello-v1';

/**
 * The zero-config default for a `persistence: 'volatile'` Kind's storage
 * (see kind-schema.js's own doc comment) when a caller doesn't hand
 * `Space` a `volatileStorage` of their own - same tiny in-memory shape as
 * `@qu/space-storage`'s `createMemoryStore()` (this file can't import that
 * package directly: `@qu/space-storage` itself depends on `@qu/space-core`,
 * so the dependency would be circular) - a caller who wants volatile Kinds
 * to live somewhere OTHER than plain process memory (e.g. a browser's
 * `sessionStorage`, cleared when the tab closes rather than the process
 * exiting) passes their own adapter as `volatileStorage` instead; this is
 * only ever the fallback for "didn't ask for anything specific."
 */
function createInMemoryVolatileStore() {
  const log = new Map();
  return {
    async append(nodeId, envelope) {
      const list = log.get(nodeId) ?? [];
      list.push(envelope);
      log.set(nodeId, list);
    },
    async load(nodeId) {
      return [...(log.get(nodeId) ?? [])];
    },
    async replace(nodeId, envelopes) {
      log.set(nodeId, [...envelopes]);
    },
  };
}

/**
 * The MINIMAL shape `_isAuthorizedWriter()`'s own `'group'`-ACL branch below
 * needs to read a Group's CURRENT membership (kind-schema.js's own doc
 * comment on that mode) - deliberately NOT an import of `@qu/app-core`'s
 * real `groupKind` (`packages/app-core/src/kinds.js`): `@qu/space-core` is
 * the lower framework layer and must never depend on the App layer above
 * it, the exact same "stays blind to app-level Kinds" boundary
 * `@qu/space-transport`'s relay.js already holds for its own
 * `resolveKindSchema` callback, and the same "can't import the real thing,
 * keep a minimal local echo" posture `createInMemoryVolatileStore()` right
 * above already takes for an unrelated circular-dependency reason. MUST
 * stay wire-compatible with `groupKind` - same `kind: 'qu-group'` string,
 * same `members` field shape (`Array<{pub, xPub}>`, base64 strings,
 * `shape: 'atomic'`, `visibility: 'public'` - `groupKind`'s own doc comment
 * on why membership is deliberately public) - built via this file's own
 * `defineKind()` rather than hand-rolled, so it gets the exact same
 * normalization/`metaVisibility` `groupKind` itself gets. Omits `name` -
 * this reader never needs it, only `members`.
 */
const GROUP_REF_KIND = defineKind('qu-group', {
  fields: { members: { shape: 'atomic', visibility: 'public' } },
  acl: { write: 'content' },
});

export class Space {
  /**
   * @param {{identity: object, members: Array<{pub: Uint8Array, xPub: Uint8Array}>, relayAdmins?: Array<Uint8Array>, transport: object, storage?: object, volatileStorage?: object, bus?: import('@qu/events').EventBus}} params
   *   `identity` = `{signingKey, signingPub, xPrivateKey, xPublicKey}` (Ed25519 + X25519 pairs, e.g. from QuCrypto.generateKeypair()).
   *   `members` = every space member's public keys (encryption recipients + write-ACL, kept simple for the PoC - see kind-schema.js).
   *   `relayAdmins` = optional, default `[]` - signing pubkeys authorized to write an `acl.write:
   *     'relay-admins'` Kind (kind-schema.js's own doc comment on that mode), checked completely
   *     independently of `members`/self-join. Unlike `members`, these are never encryption
   *     recipients (a `Uint8Array` list, not `{pub, xPub}` pairs) - `'relay-admins'`-ACL content is
   *     expected to be `'public'`-visibility (an open-join Space's readers have no membership to
   *     encrypt for in the first place), same posture `'owner'`/`'named'` identity Nodes already take.
   *   `storage` = optional; omitting it is the "flüchtig/memory-only" tier (see docs/v5-space-core-guide.md) - a Node still syncs live, nothing survives a reload. Used for every Kind EXCEPT a `persistence: 'volatile'` one (see `_storageFor()` below).
   *   `volatileStorage` = optional; the storage used for a `persistence: 'volatile'` Kind (e.g. `presenceKind`, see `presence.js`) regardless of what `storage` above is - defaults to a private in-memory adapter if omitted. Pass your own (e.g. a `sessionStorage`-backed one in a browser) to control exactly how/where "ephemeral" data lives, same swappable-adapter idea `storage` already offers for durable data.
   *   `bus` = optional - see this file's own doc comment for what gets emitted on it.
   *   `sealStrategy` = optional, default `sealStrategies.none` (unchanged behavior from before this
   *     param existed) - a pluggable, pure function deciding which ADDITIONAL member X25519
   *     pubkeys get a padding (dummy, byte-indistinguishable) entry in an outgoing envelope's `to`
   *     list, alongside the real recipients - see `seal-strategies.js`'s own doc comment and
   *     docs/routing-anonymity.md. Pass `sealStrategies.padToMembers` to hide a
   *     `{recipients}`-narrowed write's real audience from a relay/network observer.
   *   `warmNodeTTL` = optional, default `0` (disabled - exactly today's behavior: `release()` at
   *     refcount-zero unsubscribes immediately). See this file's own "WARM-RELEASE CACHE" doc
   *     comment above for the full design; `use-node.test.js`'s own existing tests encode the
   *     default-`0` behavior as a contract, so this default must never change.
   *   `maxWarmNodes` = optional, default `100` - only consulted while `warmNodeTTL > 0`; bounds how
   *     many refcount-zero Nodes stay warm at once (oldest-warmed evicted first), independent of how
   *     long `warmNodeTTL` itself is - see this file's own "WARM-RELEASE CACHE" doc comment on why a
   *     time budget alone isn't a sufficient scalability bound.
   *   `staleAfter` = optional, default `0` (disabled) - see this file's own "WARM-RELEASE CACHE" doc
   *     comment's own paragraph on this param.
   */
  constructor({
    identity,
    members,
    relayAdmins = [],
    transport,
    storage = null,
    volatileStorage = createInMemoryVolatileStore(),
    bus = null,
    sealStrategy = sealStrategies.none,
    warmNodeTTL = 0,
    maxWarmNodes = 100,
    staleAfter = 0,
  }) {
    this._identity = identity;
    this._members = [...members]; // own copy - addMember() (see below) must never mutate the caller's own array out from under them.
    this._relayAdmins = new Set(relayAdmins.map((pub) => QuCrypto.toBase64(pub)));
    this._transport = transport;
    this._storage = storage;
    this._volatileStorage = volatileStorage;
    this._bus = bus;
    this._sealStrategy = sealStrategy;
    this._warmNodeTTL = warmNodeTTL;
    this._maxWarmNodes = maxWarmNodes;
    this._staleAfter = staleAfter;
    /** @type {Map<string, SpaceNode>} */
    this._nodes = new Map();
    /** @type {Map<string, Set<string>>} nodeId -> Set<base64 Ed25519 pubkey> - 'named'-mode write-ACL state, 100% derived from verified `grant` messages (see grant.js), never invented. */
    this._grants = new Map();
    /** @type {Map<string, number>} nodeId -> active reference count - see `useNode()`'s own doc comment below. */
    this._refCounts = new Map();
    /** @type {Set<string>} nodeIds a subscribed relay has explicitly confirmed (`sync-ack`, `_handleIncoming()`'s own doc comment) it has told us everything it currently has for - see `isNodeSynced()`'s own doc comment. Cleared on `unsubscribeNode()` (below) - this flag is only ever meaningful relative to the CURRENT local Y.Doc for that id, never across a teardown/resubscribe. */
    this._syncedNodes = new Set();
    /** @type {Map<string, number>} nodeId -> Date.now() of the last confirmed `sync-ack` - see "WARM-RELEASE CACHE"'s own `staleAfter` paragraph. Cleared alongside `_syncedNodes`, same lifetime. */
    this._lastSyncAckAt = new Map();
    /** @type {Map<string, number>} nodeId -> Date.now() it went warm (refcount hit zero with `warmNodeTTL > 0`) - insertion order IS oldest-warmed-first order, see "WARM-RELEASE CACHE"'s own doc comment. Absence means "not currently warm" (either never released, or already torn down/re-acquired). */
    this._warmSince = new Map();
    /** @type {Map<string, ReturnType<typeof setTimeout>>} nodeId -> pending real-teardown timer for a warm Node - see `_releaseNode()`/`_teardownWarmNode()`. */
    this._warmTimers = new Map();
    /** @type {Map<string, {members: Set<string>, release: () => void, offChanged: (() => void)|undefined}>} `"<groupOwnerPub-b64>:<groupName>" -> live-cached state - see `_currentGroupMembers()`'s own doc comment (kind-schema.js's own `'group'` ACL mode). Grows lazily, only for a Group actually referenced by a `'group'`-ACL write this Space had to verify - never all Groups this Space happens to know about. */
    this._groupMembershipCache = new Map();
    // Serialized (never overlapping) - see _handleIncoming()'s own doc comment on why processing
    // order must match ARRIVAL order for a 'content'-ACL Kind's grant-then-write sequence to be
    // race-free, and why relying on each _handleIncoming() call's own internal await timing to
    // "happen to" preserve order is not safe.
    this._incomingQueue = Promise.resolve();
    this._transport.onMessage((msg) => {
      // .catch() here, not just on the chain's tail: an uncaught rejection from any ONE message
      // must never wedge every LATER message behind it (a permanently-rejected chain would stop
      // calling _handleIncoming() at all, silently) - see _handleIncoming()'s own doc comment.
      this._incomingQueue = this._incomingQueue.then(() => this._handleIncoming(msg.data)).catch((err) => this._bus?.emit('debug.space.incoming.error', { message: err?.message }));
    });
    this._transport.onStatusChange?.((update) => this._handleTransportStatus(update));
    this._sendHello(); // fire-and-forget, see this file's own doc comment.
  }

  async _sendHello() {
    const sig = await QuCrypto.sign(new TextEncoder().encode(HELLO_DOMAIN), this._identity.signingKey);
    this._transport.send({ type: 'hello', pub: this._identity.signingPub, sig });
    this._bus?.emit('debug.space.hello.sent', {});
  }

  /**
   * See this file's own "RESYNC ON RECONNECT" doc comment: the transport's
   * `onStatusChange()` (optional - only `WsClientTransport` has one today)
   * drives both the `space.status.changed` bus event AND the actual resync
   * work, so a caller with no `bus` at all still gets working reconnect
   * behavior, not just a missed notification.
   */
  _handleTransportStatus({ status }) {
    this._bus?.emit('space.status.changed', { status });
    if (status !== 'connected' && status !== 'reconnected') return;
    this._sendHello();
    for (const nodeId of this._nodes.keys()) this._sendSubscribeRequest(nodeId);
  }

  /** This Space's own identity, `{signingKey, signingPub, xPrivateKey, xPublicKey}` - read-only, for framework-level add-ons (e.g. alias.js's `publishAlias()`) that need it without reaching into a "private" field. */
  get identity() {
    return this._identity;
  }

  /**
   * This Space's own `EventBus` (`null` if none was passed to the
   * constructor) - read-only, for the same "framework-level add-on needs
   * it without reaching into a private field" reason `identity` above
   * exists. Lets a caller holding only a `Space` reference (not the
   * original construction-site `bus` variable) still listen for
   * `debug.space.write.local`/`space.node.<id>.write-ack` - e.g. to verify
   * a write it did not itself issue actually reached the relay, rather than
   * reporting success the instant the local optimistic mutation applied
   * (see `@qu/app-shell`'s `cms-actions.js` for a caller that does exactly
   * this - a write silently REJECTED by the relay is otherwise
   * indistinguishable, client-side, from one that simply hasn't arrived
   * yet, both looking like "saved" until a reload proves otherwise).
   */
  get bus() {
    return this._bus;
  }

  _recipientXPubKeys() {
    return this._members.map((m) => m.xPub);
  }

  /**
   * Adds one member to THIS Space's own live view of the Space's
   * membership - the client-side counterpart to `@qu/space-transport`'s
   * `relay.addMember()` (same shape, same purpose, different half of the
   * problem: the relay accepting a new member's signed writes and routing
   * pushes for them does NOTHING for an already-constructed `Space`
   * elsewhere, which still encrypts new writes only for its OLD member
   * list and would reject the new member's incoming writes as
   * unauthorized - both `_recipientXPubKeys()` and `_isAuthorizedWriter()`
   * read `this._members` fresh on every call, so calling this is enough;
   * no other internal state needs touching).
   *
   * Callers decide HOW they learn about a new member (there is no
   * membership-change notification built into `Space`/the relay protocol
   * itself - see `demo/web/main.js`'s own periodic `/members.json` poll
   * for one concrete, demo-scoped answer). Idempotent: adding an
   * already-known pubkey is a no-op.
   * @param {{pub: Uint8Array, xPub: Uint8Array}} member
   */
  addMember(member) {
    const pubB64 = QuCrypto.toBase64(member.pub);
    if (this._members.some((m) => QuCrypto.toBase64(m.pub) === pubB64)) return;
    this._members.push(member);
  }

  /**
   * The exact inverse of `addMember()` above - see `@qu/space-transport`'s
   * relay.js own `removeMember()` doc comment for the full "why" (dynamic
   * membership shrinking, not just growing) and its one real, accepted
   * limitation (not retroactive - already-delivered ciphertext stays
   * exactly as readable to a removed member as it always was; this only
   * narrows who NEW writes are sealed for/accepted from going forward).
   * Idempotent - removing an unknown pubkey is a no-op.
   * @param {Uint8Array} pub
   */
  removeMember(pub) {
    const pubB64 = QuCrypto.toBase64(pub);
    const idx = this._members.findIndex((m) => QuCrypto.toBase64(m.pub) === pubB64);
    if (idx !== -1) this._members.splice(idx, 1);
  }

  /**
   * The client-side counterpart to `@qu/space-transport`'s relay.js own
   * `addRelayAdmin()`/`removeRelayAdmin()` - updates THIS Space's own
   * independent view of `acl.write: 'relay-admins'` authorization (see
   * `_isAuthorizedWriter()` below and kind-schema.js's own doc comment on
   * the mode), same "never trust the relay, verify independently" posture
   * `addMember()`/`removeMember()` already take for ordinary membership.
   * Deliberately a bare pubkey, never `{pub, xPub}` - `'relay-admins'`-ACL
   * content is expected to be `'public'`-visibility (see this file's own
   * constructor doc comment on `relayAdmins`), so there is no encryption
   * recipient to track here the way `_members` needs one.
   * @param {Uint8Array} pub
   */
  addRelayAdmin(pub) {
    this._relayAdmins.add(QuCrypto.toBase64(pub));
  }

  /** Inverse of `addRelayAdmin()` - see that method's own doc comment. Idempotent. @param {Uint8Array} pub */
  removeRelayAdmin(pub) {
    this._relayAdmins.delete(QuCrypto.toBase64(pub));
  }

  /**
   * Read-only check against THIS Space's own independent `relayAdmins` view
   * (constructor param, kept current by `addRelayAdmin()`/`removeRelayAdmin()`
   * - never trusts the relay's own say-so, same posture as everything else
   * `_isAuthorizedWriter()` checks) - for a caller that wants to know "is
   * pub a relay-admin" WITHOUT actually attempting a `'relay-admins'`-ACL
   * write just to find out (e.g. deciding whether to even RENDER admin UI
   * at all - `@qu/app-shell`'s `boot.js` own `startPlatform()`). Defaults to
   * this Space's own identity - the common "am I one" case.
   * @param {Uint8Array} [pub]
   * @returns {boolean}
   */
  isRelayAdmin(pub = this._identity.signingPub) {
    return this._relayAdmins.has(QuCrypto.toBase64(pub));
  }

  /**
   * Returns this Node's write-ACL check, shaped exactly like
   * `verifyEnvelope()` wants: `(pubBase64) => boolean|Promise<boolean>`.
   * Branches on `kindSchema.acl.write` (see kind-schema.js's own doc
   * comment on the four modes):
   *   - `'members'` - unchanged from before this Task: any current Space
   *     member (`this._members`), a flat, synchronous Set lookup.
   *   - `'owner'`/`'named'` - self-certifying: a signer is authorized iff
   *     `deriveOwnerNodeId(signerPub, kindSchema.kind) === nodeId` (proves
   *     THIS Node's own id cryptographically commits to them, independent
   *     of `this._members` entirely - an owner never needs to be
   *     "added" anywhere to write their own Node) OR - `'named'` only -
   *     their pubkey appears in `this._grants.get(nodeId)`, which is
   *     populated ONLY by `_handleIncoming()` verifying an actual signed
   *     `grant` message (see grant.js), never trusted from anywhere else.
   *   - `'content'` - `'named'`'s many-per-owner counterpart: PURELY
   *     grant-derived, no owner-pubkey shortcut (an id alone cannot be
   *     inverted back to the `path` that would let a verifier recompute it
   *     - see kind-schema.js's own doc comment) - `this._grants.get(nodeId)`
   *     only, populated by `createNode()`'s own transparent self-grant for
   *     the creating owner, or by an explicit `grantWriter(..., {path})`.
   *   - `'relay-admins'` - a flat Set lookup against `this._relayAdmins`
   *     (the constructor's own `relayAdmins` param), completely independent
   *     of `this._members` - see kind-schema.js's own doc comment on this
   *     mode and this file's own constructor doc comment.
   *   - `'group'` - `'content'`'s REVOCABLE counterpart (kind-schema.js's own
   *     doc comment on this mode in full) - `groupRef` (the SECOND argument
   *     here, carried on the incoming write message itself, see
   *     `_handleLocalUpdate()`/`_handleIncoming()`) is REQUIRED: no
   *     `groupRef` at all means never authorized, same "nothing to check it
   *     against" fail-closed posture every other mode already takes for its
   *     own missing-state case. Two checks, both must pass: (1)
   *     self-certifying - `nodeId` must actually equal
   *     `deriveContentNodeId(groupRef.groupOwnerPub, kindSchema.kind,
   *     groupRef.groupName)`, exactly the same "recompute and compare"
   *     `'content'` mode already relies on, just committing to the
   *     REFERENCED GROUP's identity instead of a Node-owning identity of its
   *     own - a mismatched claim here is rejected outright, regardless of
   *     what it claims; (2) the signer is a CURRENT member of that Group,
   *     via `_currentGroupMembers()`'s own live cache.
   * @param {object} kindSchema
   * @param {string} nodeId
   * @param {{groupOwnerPub: Uint8Array, groupName: string}|null|undefined} [groupRef] - ONLY consulted
   *   for `acl.write: 'group'` - see this method's own doc comment above and kind-schema.js's own
   *   "'group'" doc comment. Ignored for every other mode.
   */
  _isAuthorizedWriter(kindSchema, nodeId, groupRef) {
    const mode = kindSchema?.acl?.write;
    if (mode === 'relay-admins') {
      return (pubB64) => this._relayAdmins.has(pubB64);
    }
    if (mode === 'group') {
      if (!groupRef) return () => false;
      return async (pubB64) => {
        const expectedId = await deriveContentNodeId(groupRef.groupOwnerPub, kindSchema.kind, groupRef.groupName);
        if (expectedId !== nodeId) return false; // self-certifying check failed - this write's own nodeId does not actually commit to the group it claims.
        const members = await this._currentGroupMembers(groupRef);
        return members.has(pubB64);
      };
    }
    if (mode !== 'owner' && mode !== 'named' && mode !== 'content') {
      const writerPubs = new Set(this._members.map((m) => QuCrypto.toBase64(m.pub)));
      return (pubB64) => writerPubs.has(pubB64);
    }
    if (mode === 'content') {
      return (pubB64) => this._grants.get(nodeId)?.has(pubB64) ?? false;
    }
    return async (pubB64) => {
      const ownerNodeId = await deriveOwnerNodeId(QuCrypto.fromBase64(pubB64), kindSchema.kind);
      if (ownerNodeId === nodeId) return true;
      if (mode === 'named') return this._grants.get(nodeId)?.has(pubB64) ?? false;
      return false;
    };
  }

  /**
   * Live-cached, event-invalidated CURRENT membership for a Group referenced by a `'group'`-ACL
   * write (`_isAuthorizedWriter()`'s own doc comment, kind-schema.js's own "'group'" doc comment) -
   * the SAME "live-watched registry" pattern `@qu/app-shell`'s `live-app-resolver.js` already
   * established for `qu-platform-apps`, generalized here to whichever Groups a `'group'`-ACL write
   * actually references - grows lazily (never every Group this Space happens to know about), never
   * evicted (a deliberate v1 simplification - see `docs/chat-app-concept.md` §2a: the user's own
   * explicit "a cache for some time is fine" allowance covers this too; an LRU-style cap, mirroring
   * this file's own "WARM-RELEASE CACHE" `maxWarmNodes`, is real future work if this ever needs
   * bounding). The underlying Group Node is `useNode()`'d and never released - lives for this
   * Space's own lifetime, same posture `live-app-resolver.js`'s own registry watch already takes.
   *
   * NEVER blocks on network I/O, deliberately - this is the one thing this method's own doc comment
   * must get right: it is called from `_isAuthorizedWriter()`'s `'group'` branch, itself called from
   * `verifyEnvelope()` while VERIFYING an incoming write - i.e. from INSIDE `_handleIncoming()`,
   * chained onto this Space's own single, fully serial `_incomingQueue` (this file's own top doc
   * comment on why that chain is serial at all: grant-before-write safety for 'content'-ACL Kinds).
   * The Group Node's OWN catch-up data (its creation write, a later membership edit, even its
   * `sync-ack`) arrives over that EXACT SAME queue, as ordinary later messages - so a version of
   * this method that AWAITED "until the Group is confirmed synced" (an earlier draft of this method
   * did exactly that, via a since-removed `_waitForNodeSynced()` helper) would deadlock: the queued
   * message this call itself is part of can never finish, and so can never let the queue advance to
   * the very later message this call is waiting on. Confirmed by hand while building this Task - see
   * git history for the exact symptom: a 'group'-ACL write to a not-yet-locally-known Group timing
   * out after 4s, every single time, even when the Group's own data demonstrably arrived moments
   * later on the wire.
   *
   * Instead: `readMembers()` reads whatever this Space ALREADY has locally for the Group RIGHT NOW,
   * synchronously correct or not - a genuinely not-yet-synced Group simply reads back an empty Set
   * (fail closed: nobody authorized YET, same posture every other "don't know" case in this file
   * already takes), and the `space.node.<groupId>.changed` subscription (fires on EVERY accepted
   * write for that Node, per this file's own top doc comment - the Group's own FIRST creation write
   * included, no `sync-ack`-specific mechanism needed) refreshes the cached `Set` the moment real
   * data lands, whether that arrives while THIS message is still being verified or ten writes later.
   * Consequence worth being explicit about: a 'group'-ACL write that reaches a peer who has never
   * independently seen that Group before (no relay-side ordering guarantee ties the two together)
   * can be dropped even from a genuine member, if the Group's own data hasn't arrived yet - Yjs does
   * not retroactively replay a discarded update once a LATER one has been accepted; only a
   * SUBSEQUENT write from that author recovers. In practice this is rarely reachable: any real
   * reader of a 'group'-ACL room (`ContentResolver.resolveGroup()`) already reads the Group's own
   * membership before ever caring about its messages, which warms this exact cache first.
   * @param {{groupOwnerPub: Uint8Array, groupName: string}} groupRef
   * @returns {Promise<Set<string>>} base64 Ed25519 pubkeys of the Group's CURRENTLY KNOWN members -
   *   never awaited to be complete/fresh, see this method's own doc comment above.
   */
  async _currentGroupMembers({ groupOwnerPub, groupName }) {
    const key = `${QuCrypto.toBase64(groupOwnerPub)}:${groupName}`;
    const cached = this._groupMembershipCache.get(key);
    if (cached) return cached.members;

    const groupId = await deriveContentNodeId(groupOwnerPub, GROUP_REF_KIND.kind, groupName);
    const { node, release } = await this.useNode(groupId, GROUP_REF_KIND);
    const readMembers = async () => new Set(((await node.field('members').get()) ?? []).map((m) => m.pub));

    const entry = { members: await readMembers(), release, offChanged: undefined };
    this._groupMembershipCache.set(key, entry);
    entry.offChanged = this._bus?.on(`space.node.${groupId}.changed`, async () => {
      entry.members = await readMembers();
    });
    return entry.members;
  }

  /**
   * Authorizes `granteePub` to write to the `'named'`-ACL Node `nodeId`
   * (of the given `kind`) - only meaningful when THIS identity is that
   * Node's actual owner; a grant signed by anyone else is verifiably
   * worthless (see grant.js's own doc comment) and every honest
   * relay/Space will reject it on arrival, so calling this as a
   * non-owner just wastes a message, it does not "work anyway."
   *
   * Applies the grant to THIS Space's own `_grants` state immediately
   * (so the owner's own subsequent writes/reads already reflect it,
   * without waiting for a relay to echo it back - relay.js's own
   * broadcast deliberately excludes the sender, same pattern as
   * `handleWrite()`'s forward loop), then sends the same signed message
   * over the transport for the relay (and, via its broadcast, every
   * other connected peer's Space) to independently verify and adopt.
   * @param {string} nodeId
   * @param {string} kind
   * @param {Uint8Array} granteePub
   * @param {{path?: string}} [options] - REQUIRED (and must match how `nodeId` was actually derived) for an `acl.write: 'content'` Kind - see kind-schema.js's own doc comment; omit for `'named'`.
   */
  async grantWriter(nodeId, kind, granteePub, { path } = {}) {
    const message = await signGrant({ nodeId, kind, granteePub, path }, this._identity);
    await this._applyGrant(message);
    this._transport.send(message);
  }

  async _applyGrant(message) {
    if (!(await verifyGrant(message))) return false;
    const granteePubB64 = QuCrypto.toBase64(message.granteePub);
    if (!this._grants.has(message.nodeId)) this._grants.set(message.nodeId, new Set());
    this._grants.get(message.nodeId).add(granteePubB64);
    return true;
  }

  /**
   * Tells this Space's relay who CURRENTLY belongs to a Group this identity owns, so the relay can
   * enforce a `'group'`-ACL write's live membership check itself (relay.js's own `buildWriteAcl()` -
   * its `groupMemberships` map is 100% derived from this exact message, never invented) WITHOUT ever
   * having to decode that Group's own Yjs content - group-membership.js's own top doc comment has the
   * full "why a signed declaration, not relay-side Yjs decoding" reasoning. Only meaningful for THIS
   * identity's own Groups (`groupName` under `this._identity.signingPub` as owner) - there is no way
   * to declare membership on someone else's behalf, by construction (the message is self-certifying,
   * signed by the exact `groupOwnerPub` it carries).
   *
   * Callers should send this ALONGSIDE every write to a Group's own `members` field (see
   * `@qu/app-core`'s `createGroup()`/`editGroup()`) - same "self-grant before any field write"
   * discipline `createNode()`'s own `'content'`-ACL branch already establishes for `grantWriter()`,
   * just for a REVOCABLE fact instead of a permanent one. Skipping this call for a given Group is
   * safe for CLIENT-side enforcement (every client already reads the Group's real field content
   * directly - `_currentGroupMembers()`'s own doc comment) but leaves the RELAY unable to enforce
   * that Group's writes at all until the first declaration arrives - relay-side rejection is
   * fail-closed (kind-schema.js's own "'group'" doc comment), so an undeclared Group's writes are
   * simply dropped by the relay, never silently over-permitted.
   * @param {{groupName: string, members: Array<Uint8Array>}} params - `members`: every CURRENT
   *   member's signing pubkey (raw bytes) - see group-membership.js's own doc comment on why only
   *   the signing pubkey half is needed here.
   */
  async declareGroupMembership({ groupName, members }) {
    const message = await signGroupMembership({ groupName, members }, this._identity);
    this._transport.send(message);
  }

  /**
   * @param {object} kindSchema - From defineKind()/KindRegistry.
   * @param {Record<string, *>} initialFields - Only 'atomic-encrypted'/'text' fields (list fields start empty; use `.field(name).push()`).
   * @param {{id?: string, path?: string, groupOwnerPub?: Uint8Array, groupName?: string}} [options] -
   *   `id` is IGNORED for an `'owner'`/`'named'`/`'content'`/`'group'`-ACL kindSchema: its Node id is
   *   never a caller's choice. `'owner'`/`'named'` derive it as
   *   `deriveOwnerNodeId(this._identity.signingPub, kindSchema.kind)` (see kind-schema.js) -
   *   self-certifying by construction. `'content'` REQUIRES `path` instead and derives
   *   `deriveContentNodeId(this._identity.signingPub, kindSchema.kind, path)` - see that function's
   *   own doc comment - then issues itself a SELF-grant (`grantWriter(id, kindSchema.kind,
   *   this._identity.signingPub, {path})`) BEFORE attaching/writing anything, so the creating
   *   identity is immediately an authorized writer without any extra call of its own (see
   *   grant.js's own "WRITE-BEFORE-GRANT IS A TRAP" - this ordering is what avoids it). `'group'`
   *   REQUIRES `groupOwnerPub`/`groupName` instead (see kind-schema.js's own doc comment on this
   *   mode) and derives `deriveContentNodeId(groupOwnerPub, kindSchema.kind, groupName)` - committing
   *   to the REFERENCED GROUP's own identity, never this Node's own creator - no self-grant needed
   *   (the resulting `node.groupRef` is what `_handleLocalUpdate()` reads to attach `{groupOwnerPub,
   *   groupName}` to every write message this Node makes, so a verifier can check membership live
   *   instead of consulting a permanent grant). For `'members'`/`'relay-admins'`-ACL kinds, `id` is
   *   used exactly as given (a random one if omitted) - NEITHER mode derives an id from the caller's
   *   own identity, since authorization under both is a flat list lookup, never self-certification
   *   (see kind-schema.js's own doc comment) - `'relay-admins'` content typically passes a fixed,
   *   precomputed anchor id instead (e.g. `@qu/app-core`'s `platformAppsKind`, always created at the
   *   same well-known id).
   * @returns {Promise<SpaceNode>}
   */
  /**
   * @param {object} kindSchema
   * @param {object} [initialFields]
   * @param {{id?: string, path?: string, groupOwnerPub?: Uint8Array, groupName?: string, recipients?: Array<Uint8Array>}} [options] - `recipients`
   *   (`'content'`/`'group'`-ACL Kinds with `visibility: 'encrypted'` fields only) narrows this Node's
   *   audience below the Space's own full member list, for EVERY write this call makes (meta
   *   included) - see field.js's own doc comment on it. Omit for the ordinary, unchanged
   *   "every Space member" behavior. For a `'group'`-ACL Kind, a caller almost always wants this
   *   narrowed to the referenced Group's OWN current members (`ContentResolver.resolveGroup()`) -
   *   this method never does that automatically, since "the Group's current membership" is a live
   *   read this Node's own Kind-Schema has no way to express as a fixed default.
   */
  async createNode(kindSchema, initialFields = {}, { id = crypto.randomUUID(), path, groupOwnerPub, groupName, recipients } = {}) {
    let groupRef = null;
    if (kindSchema.acl.write === 'content') {
      if (!path) throw new Error(`createNode: kind "${kindSchema.kind}" is 'content'-ACL - "path" is required`);
      id = await deriveContentNodeId(this._identity.signingPub, kindSchema.kind, path);
      await this.grantWriter(id, kindSchema.kind, this._identity.signingPub, { path });
    } else if (kindSchema.acl.write === 'group') {
      if (!groupOwnerPub || !groupName) throw new Error(`createNode: kind "${kindSchema.kind}" is 'group'-ACL - "groupOwnerPub"/"groupName" are required`);
      id = await deriveContentNodeId(groupOwnerPub, kindSchema.kind, groupName);
      groupRef = { groupOwnerPub, groupName };
    } else if (kindSchema.acl.write !== 'members' && kindSchema.acl.write !== 'relay-admins') {
      id = await deriveOwnerNodeId(this._identity.signingPub, kindSchema.kind);
    }
    // _attach() FIRST, so the update listener is already registered before
    // stampMeta()'s mutation happens - see stampMeta()'s doc comment for
    // why doing this the other way round permanently breaks sync for
    // every later update on this Node.
    const doc = new Y.Doc();
    const node = this._attach(id, kindSchema, doc, { groupRef });
    // A relay only ever forwards a write to a Node's SUBSCRIBERS (see @qu/space-transport's
    // relay.js "SUBSCRIBER-TRACKING" doc comment) - without this, the creator of a Node would
    // never see anyone ELSE's later, otherwise-authorized write to it (e.g. a 'named'-ACL
    // grantee writing back - see acl.test.js), since creating a Node is not, by itself, asking to
    // be pushed updates for it. Fire-and-forget, same posture as subscribeNode()'s own request.
    this._sendSubscribeRequest(id);
    stampMeta(doc, kindSchema, this._identity.signingPub, { recipients });
    for (const [name, value] of Object.entries(initialFields)) {
      const field = node.field(name);
      if (typeof field.set === 'function') await field.set(value, { recipients });
      else if (typeof field.insert === 'function') field.insert(0, value, { recipients });
      else throw new Error(`createNode: field "${name}" (shape ${kindSchema.fields[name]?.shape}) has no initial-value setter`);
    }
    return node;
  }

  /**
   * Registers this Space's interest in an already-known Node id (e.g. one
   * another peer created) - subsequent envelopes for it will be accepted
   * and applied. Also sends a SIGNED `{type:'subscribe', nodeId}` request
   * over the transport - a relay mirroring this Node (see
   * @qu/space-transport's relay.js) answers it by replaying every
   * envelope it has stored, so this Space catches up even if the Node's
   * author is offline right now. Fire-and-forget, same as a local write's
   * own seal/send (see `_handleLocalUpdate`): the returned Node is usable
   * immediately either way, catch-up (if any) arrives asynchronously as
   * ordinary incoming envelopes.
   * @param {{groupRef?: {groupOwnerPub: Uint8Array, groupName: string}}} [options] - REQUIRED (and,
   *   per the self-certifying check below, must match this exact `id`) for any caller that intends
   *   to WRITE to an `acl.write: 'group'` Kind's Node via this method rather than `useNode()` - see
   *   `useNode()`'s/`loadNode()`'s own doc comments on why: `node.groupRef` is what
   *   `_handleLocalUpdate()` reads back to attach `{groupOwnerPub, groupName}` to THIS peer's own
   *   outgoing writes (node.js's own doc comment on `groupRef` - never needed just to READ, since an
   *   INCOMING write's own `groupRef` arrives on that write's wire message itself, not from this
   *   peer's local Node state). Ignored for every other ACL mode.
   */
  subscribeNode(id, kindSchema, { groupRef = null } = {}) {
    if (this._nodes.has(id)) return this._nodes.get(id);
    const doc = new Y.Doc(); // meta/content arrive via sync, not stamped locally - this peer did not create this Node.
    const node = this._attach(id, kindSchema, doc, { groupRef });
    this._sendSubscribeRequest(id);
    return node;
  }

  async _sendSubscribeRequest(nodeId) {
    const sig = await QuCrypto.sign(new TextEncoder().encode(nodeId), this._identity.signingKey);
    this._transport.send({ type: 'subscribe', nodeId, pub: this._identity.signingPub, sig });
    this._bus?.emit('debug.space.subscribe.sent', { nodeId });
  }

  /**
   * The exact inverse of `subscribeNode()`: tells a relay (see
   * @qu/space-transport's relay.js) to stop live-forwarding `id` to this
   * connection, and drops this Space's own local handle for it (its Y.Doc
   * included - nothing more references it after this call returns, so it
   * becomes eligible for GC the moment the caller drops its own reference
   * to the `SpaceNode` too). Deliberately NOT reference-counted here (a
   * caller-tracked "how many things still want this Node" policy is
   * `Space`'s own local-first lazy query API's job - a later, separate
   * task - not this method's) - calling this once always fully
   * unsubscribes, regardless of how many call sites hold a reference to
   * the same Node.
   *
   * Dropping the local Y.Doc means a later `subscribeNode(id, ...)` call
   * for the SAME id starts completely fresh (a brand-new empty doc, a
   * brand-new `subscribe` request) rather than being a no-op - see that
   * method's own early-return-if-already-attached check, which is exactly
   * what would otherwise make an unsubscribe-then-resubscribe permanently
   * stuck.
   * @param {string} id
   */
  async unsubscribeNode(id) {
    if (!this._nodes.has(id)) return;
    this._nodes.delete(id);
    this._syncedNodes.delete(id); // see isNodeSynced()'s own doc comment - stale relative to whatever NEW local Y.Doc a later subscribeNode()/useNode() for this SAME id builds.
    this._lastSyncAckAt.delete(id); // same lifetime as _syncedNodes - see "WARM-RELEASE CACHE"'s own staleAfter paragraph.
    // Defensive, not the normal path (a warm id's own _goWarm()/_teardownWarmNode() already clear
    // these themselves): covers a direct unsubscribeNode() call for an id that happens to still be
    // warm (e.g. test code, or a caller mixing raw subscribeNode()/unsubscribeNode() with useNode()
    // for the same id despite useNode()'s own doc comment advising against it) - never leaves a
    // stale timer pointed at a Node this call just tore down for real.
    clearTimeout(this._warmTimers.get(id));
    this._warmTimers.delete(id);
    this._warmSince.delete(id);
    const sig = await QuCrypto.sign(new TextEncoder().encode(id), this._identity.signingKey);
    this._transport.send({ type: 'unsubscribe', nodeId: id, pub: this._identity.signingPub, sig });
    this._bus?.emit('debug.space.unsubscribe.sent', { nodeId: id });
  }

  /**
   * COMPACTION — replaces `id`'s ENTIRE stored envelope history (this
   * Space's own storage AND, once the resulting envelope propagates,
   * every other subscriber's storage and the relay's own mirror - see
   * relay.js's `handleWrite()`) with a single envelope holding the Node's
   * current, garbage-collected state. See envelope.js's own "SNAPSHOT/
   * COMPACTION" doc comment for the full design and WHY this is needed
   * even though Yjs already GCs deleted content from a live `Y.Doc`'s own
   * memory automatically - the gap this closes is storage/mirror growth,
   * not the live doc.
   *
   * Re-applies the Node's current full state into a FRESH `Y.Doc({gc:
   * true})` rather than just calling `Y.encodeStateAsUpdate(node.doc)`
   * directly - a standard, defensive Yjs idiom to force a complete GC
   * pass regardless of exactly when the live doc's own incremental GC
   * last ran, rather than relying on that timing.
   *
   * Authorization needs no new mechanism: the resulting envelope is
   * sealed and verified EXACTLY like any other write to this Node (same
   * `_isAuthorizedWriter()` check on the receiving end) - whoever may
   * already write to a Node may also compact it, nothing more.
   *
   * Only supported for a Kind whose meta AND every field share the SAME
   * `visibility` - a single compaction envelope bundles the WHOLE Node
   * (meta + every field) into one envelope, which (unlike an ordinary
   * per-field write, see kind-schema.js's own doc comment on why THAT
   * never has a "half-public, half-encrypted" problem) genuinely can't
   * represent a Node whose fields disagree on visibility. Throws rather
   * than silently picking one field's visibility for the whole Node,
   * which could leak an 'encrypted' field's plaintext (if 'public' were
   * chosen) or needlessly hide a 'public' field from non-members (if
   * 'encrypted' were chosen). A REAL, accepted consequence worth being
   * explicit about: `kindSchema.metaVisibility` is ALWAYS `'encrypted'`
   * for an `acl.write: 'members'`/`'content'` Kind (see kind-schema.js),
   * regardless of any individual field's own visibility - so such a Kind
   * can only ever be compacted whole if EVERY one of its fields is ALSO
   * `'encrypted'` (the common/default case). A Kind with even one
   * `'public'`-visibility field can never satisfy this check; such a
   * Kind's fields still sync/persist correctly, they simply can't be
   * compacted as one unit under this design.
   * @param {string} id
   */
  async compactNode(id) {
    const node = this._nodes.get(id);
    if (!node) throw new Error(`Space.compactNode: Node "${id}" is not attached - subscribe/create/use it first`);
    const kindSchema = node.kindSchema;
    const visibilities = new Set([kindSchema.metaVisibility, ...Object.values(kindSchema.fields).map((f) => f.visibility)]);
    if (visibilities.size > 1) {
      throw new Error(
        `Space.compactNode: Kind "${kindSchema.kind}" mixes visibilities across its meta/fields (${[...visibilities].join(', ')}) - ` +
          'compaction needs a single envelope for the whole Node, which only a uniform-visibility Kind can safely provide.'
      );
    }
    const visibility = [...visibilities][0];

    const gcDoc = new Y.Doc({ gc: true });
    Y.applyUpdate(gcDoc, Y.encodeStateAsUpdate(node.doc));
    const snapshotBytes = Y.encodeStateAsUpdate(gcDoc);
    gcDoc.destroy();

    // No sealStrategy/padding here (unlike _handleLocalUpdate() above) - a compaction snapshot
    // always seals for this Space's FULL current membership (this._recipientXPubKeys()), never a
    // {recipients}-narrowed subset, so there is no "real audience smaller than the member list" to
    // hide in the first place - sealStrategies.padToMembers would compute an empty padding set here
    // anyway.
    const envelope =
      visibility === 'public'
        ? await sealPublicUpdate(snapshotBytes, this._identity, null, true)
        : await sealUpdate(snapshotBytes, this._identity, this._recipientXPubKeys(), null, true);

    await this._storageFor(kindSchema)?.replace(id, [envelope]);
    this._transport.send({ nodeId: id, envelope });
    this._bus?.emit('debug.space.compact.sent', { nodeId: id, bytes: snapshotBytes.length });
  }

  /**
   * How many envelopes THIS Space's own storage currently holds for `id` -
   * `null` if `id` isn't attached, or its Kind has no storage adapter
   * mounted (nothing to count against - a purely memory-only Space, or one
   * using a `persistence: 'volatile'` Kind with no `volatileStorage`
   * override). Meant for `compaction.js`'s `compactIfNeeded()` to decide
   * whether a Node has grown enough to be worth compacting - `_hydrateFromStorage()`
   * itself never needs this, it already reads the full array directly.
   * @param {string} id
   * @returns {Promise<number|null>}
   */
  async envelopeCount(id) {
    const node = this._nodes.get(id);
    if (!node) return null;
    const storage = this._storageFor(node.kindSchema);
    if (!storage) return null;
    return (await storage.load(id)).length;
  }

  /**
   * Which storage adapter a Kind's writes go through - see kind-schema.js's
   * own `persistence` doc comment. `'volatile'` ALWAYS resolves to
   * something (a caller-supplied `volatileStorage` or the private default
   * created in this file's own constructor) - only the `'durable'` (the
   * default, unnamed) tier can be `null` (the pre-existing "flüchtig/
   * memory-only whole Space" behavior, unchanged).
   */
  _storageFor(kindSchema) {
    return kindSchema?.persistence === 'volatile' ? this._volatileStorage : this._storage;
  }

  /**
   * Replays a Node's envelope history from storage (see @qu/space-storage) - the "durable
   * persistence survives a reload" path.
   * @param {string} id @param {object} kindSchema
   * @param {{groupRef?: {groupOwnerPub: Uint8Array, groupName: string}}} [options] - REQUIRED for an
   *   `acl.write: 'group'` `kindSchema` (kind-schema.js's own doc comment on the mode) - stored
   *   envelope history for a `'group'`-ACL Node still needs it to re-verify each envelope on replay,
   *   same as a live incoming write does (this Space's own storage never persists `groupRef` itself,
   *   only ever the envelope - see `_handleLocalUpdate()`'s own doc comment on why that's enough:
   *   the caller who already knows `id` for a `'group'`-ACL Kind necessarily already knows the
   *   `groupRef` that derives it).
   */
  async loadNode(id, kindSchema, { groupRef = null } = {}) {
    if (!this._storageFor(kindSchema)) throw new Error('Space.loadNode: no storage adapter mounted');
    const doc = new Y.Doc();
    const node = this._attach(id, kindSchema, doc, { skipReSeal: true, groupRef });
    await this._hydrateFromStorage(id, kindSchema, doc, groupRef);
    node._skipReSeal = false;
    return node;
  }

  /**
   * Shared by `loadNode()` and `useNode()`: applies every already-verified-on-write envelope this
   * Space's OWN storage holds for `id` into `doc`, oldest first. Never trusts storage blindly - a
   * tampered/foreign entry is skipped, same as any other unverified envelope.
   *
   * An AUTHENTIC, ACL-authorized envelope this identity simply isn't a decryption RECIPIENT of
   * (`openUpdate()` throwing - see that function's own doc comment) is likewise skipped, not
   * fatal: this happens routinely for history sealed before this identity became a Space member -
   * exactly the same "not a recipient -> skip" outcome `field.js`'s own `AtomicField.get()` already
   * gives per-field, just at the whole-envelope level. Skipping here specifically (a `for` loop
   * over possibly many envelopes) matters more than at `_handleIncoming()`'s own single-envelope
   * call site below: an uncaught throw here would abort hydrating every envelope AFTER the
   * unreadable one too, not just that one - a real, previously-unhandled bug this Task fixes.
   * @param {{groupRef?: {groupOwnerPub: Uint8Array, groupName: string}}} [groupRef] - see `loadNode()`'s own doc comment.
   */
  async _hydrateFromStorage(id, kindSchema, doc, groupRef = null) {
    const envelopes = await this._storageFor(kindSchema).load(id);
    const isAuthorized = this._isAuthorizedWriter(kindSchema, id, groupRef);
    let skipped = 0;
    for (const envelope of envelopes) {
      if (!(await verifyEnvelope(envelope, isAuthorized))) continue;
      let bytes;
      try {
        bytes = await openUpdate(envelope, this._identity);
      } catch {
        skipped++;
        continue;
      }
      Y.applyUpdate(doc, bytes, REMOTE_ORIGIN);
    }
    this._bus?.emit('debug.space.load', { nodeId: id, envelopeCount: envelopes.length, skipped });
  }

  /**
   * THE LOCAL-FIRST, LAZY, REFERENCE-COUNTED QUERY ENTRYPOINT this Task
   * exists for: "a client should keep locally what it needs, subscribe
   * remotely and diff-sync only what it's actually asked for, and only
   * once it's actually asked for it." A caller that just wants "give me
   * this Node, I don't care whether it's already local or needs fetching"
   * calls this instead of manually choosing between `loadNode()`/
   * `subscribeNode()`/`createNode()`:
   *
   *   1. Already attached (by ANY of the four entrypoints, this one
   *      included)? Return the existing handle immediately - no network,
   *      no storage read, no duplicate subscribe.
   *   2. Otherwise, hydrate from LOCAL storage FIRST if one is mounted
   *      (instant, no network - see `_hydrateFromStorage()`), THEN send a
   *      live `subscribe` request regardless of what local storage had -
   *      a synced Node is presumed still-changing, so "I have a local
   *      snapshot" is never a reason to skip asking for what's new, only
   *      a reason not to START from nothing while that request is in
   *      flight. This is the exact ordering the framework's own "local-
   *      first" design commits to (see the top-level architecture notes):
   *      READ local, THEN sync remote - never the other way round.
   *
   * Reference-counted so multiple independent call sites (e.g. two UI
   * components both interested in the same Node) can each `useNode()`/
   * `release()` independently without racing each other's unsubscribe -
   * the underlying Node stays subscribed until the LAST interested party
   * releases it (and, with `warmNodeTTL > 0`, possibly a while longer still -
   * see this file's own "WARM-RELEASE CACHE" doc comment). Mixing this with
   * a raw `subscribeNode()`/`unsubscribeNode()` call for the SAME id is not
   * supported - pick one discipline per Node id (this one is the
   * recommended default for any caller that doesn't have a specific reason
   * to use the lower-level methods directly).
   * @param {string} id
   * @param {object} kindSchema
   * @param {{forceRevalidate?: boolean, groupRef?: {groupOwnerPub: Uint8Array, groupName: string}}} [options]
   *   `forceRevalidate` (default `false`) - see this file's own "WARM-RELEASE CACHE" doc comment's
   *   own paragraph on it. Meaningless (and ignored) for a genuinely cold `id` - a brand-new
   *   subscribe already IS a full revalidation. `groupRef` - ONLY for an `acl.write: 'group'`
   *   `kindSchema` (see that mode's own doc comment, kind-schema.js) a caller intends to WRITE to
   *   (never needed for a purely read-only `useNode()` call, nor for a re-acquire of an
   *   already-attached/warm handle, which already has it from its own creation) - stored on the
   *   returned `SpaceNode` so `_handleLocalUpdate()` can attach it to this Node's own later writes.
   * @returns {Promise<{node: SpaceNode, release: () => void}>}
   */
  async useNode(id, kindSchema, { forceRevalidate = false, groupRef = null } = {}) {
    const wasWarm = this._warmSince.has(id);
    if (wasWarm) {
      this._warmSince.delete(id);
      clearTimeout(this._warmTimers.get(id));
      this._warmTimers.delete(id);
    }
    this._refCounts.set(id, (this._refCounts.get(id) ?? 0) + 1);

    let node = this._nodes.get(id);
    if (!node) {
      const doc = new Y.Doc();
      node = this._attach(id, kindSchema, doc, { skipReSeal: true, groupRef });
      if (this._storageFor(kindSchema)) await this._hydrateFromStorage(id, kindSchema, doc, groupRef);
      node._skipReSeal = false;
      await this._sendSubscribeRequest(id); // awaited (unlike subscribeNode()'s own fire-and-forget) - useNode() already returns a Promise, so a caller awaiting it can rely on the subscribe request having actually left by the time it resolves.
    } else if (forceRevalidate || this._isStale(id)) {
      // Re-acquiring an EXISTING (warm or still actively in-use) handle, but this caller wants - or
      // this Node's own age demands - proof it's still current: clear `isNodeSynced()` for it first
      // (exactly what a genuine fresh subscribe starts from) so `resolver.js`'s own `waitFor()`
      // genuinely waits for a NEW `sync-ack` instead of short-circuiting on the synchronous
      // already-known value its own first `checkFn()` call would otherwise return - see this file's
      // own "WARM-RELEASE CACHE" doc comment.
      this._syncedNodes.delete(id);
      await this._sendSubscribeRequest(id);
    }
    return { node, release: () => this._releaseNode(id) };
  }

  /** `true` once a warm (still-attached, refcount-zero) Node's last confirmed `sync-ack` is older than `staleAfter` (`0` = disabled, the default - always `false`) - see this file's own "WARM-RELEASE CACHE" doc comment. A Node with no recorded `sync-ack` at all (never actually confirmed synced) counts as stale, same "uncertain -> revalidate" posture. */
  _isStale(id) {
    if (this._staleAfter <= 0) return false;
    const last = this._lastSyncAckAt.get(id);
    return last === undefined || Date.now() - last >= this._staleAfter;
  }

  /**
   * `true` once a currently-subscribed relay has explicitly confirmed
   * (`sync-ack`, `_handleIncoming()`'s own doc comment) it has told this
   * Space everything it currently has mirrored for `id` - INCLUDING when
   * that turns out to be nothing at all (a genuinely nonexistent Node).
   * Meant for a caller ALREADY polling a Node's own fields for a value
   * (`@qu/app-core`'s `resolver.js`'s own `waitFor()` is the reference
   * consumer) to stop burning the REST of its own timeout budget once it's
   * clear no more data is coming - `false` (not yet synced, or was never
   * subscribed at all) is always the SAFE default: a caller that never
   * checks this at all just keeps behaving exactly as before this existed,
   * plain polling up to its own configured timeout. `false` again
   * immediately after `id` is unsubscribed (see `unsubscribeNode()`) -
   * this flag describes the CURRENT local Y.Doc for `id`, never a promise
   * about whatever NEXT one a later re-subscribe builds from scratch.
   * @param {string} id
   * @returns {boolean}
   */
  isNodeSynced(id) {
    return this._syncedNodes.has(id);
  }

  /**
   * The other half of `useNode()`'s reference count - see that method's own
   * doc comment. Fire-and-forget, same posture as every other
   * control-message-sending method here. With `warmNodeTTL` disabled (`0`,
   * the default), refcount-zero means exactly what it always has: tear down
   * and unsubscribe right now. With `warmNodeTTL > 0`, refcount-zero instead
   * hands the Node to `_goWarm()` - see this file's own "WARM-RELEASE CACHE"
   * doc comment for the full design.
   *
   * A Group Node (`kind === GROUP_REF_KIND.kind`) is NEVER torn down here, at ANY refcount,
   * regardless of `warmNodeTTL` - a real, previously-hit bug this Task fixes, not a hypothetical
   * one: `_currentGroupMembers()`'s own cache (below) captures the SPECIFIC `SpaceNode` OBJECT a
   * Group's `useNode()` call returned, the FIRST time any 'group'-ACL write ever needed verifying -
   * if an ORDINARY, unrelated caller (`@qu/app-core`'s `ContentResolver.resolveGroup()`, the most
   * natural thing an app does right after creating/editing a group) had ALREADY `useNode()`'d and
   * `release()`d that SAME Group id earlier (its own refcount hitting zero FIRST, since
   * `Space.createNode()` never itself increments it), this Node would be torn down and, on the
   * FIRST 'group'-ACL write that ever needs it, `_currentGroupMembers()`'s own COLD `useNode()` call
   * would have to `_attach()` a BRAND NEW, EMPTY Y.Doc - reading back an EMPTY membership set for
   * THAT VERY write (this method never blocks/waits for real data to arrive - see that method's own
   * doc comment), rejecting a genuinely authorized author's FIRST-EVER write to that Node - and,
   * because Yjs never integrates a LATER update from an author once an EARLIER one in their own
   * sequence was rejected (grant.js's own "WRITE-BEFORE-GRANT IS A TRAP" doc comment), EVERY
   * subsequent write from that SAME author to that SAME Node would then ALSO be silently lost,
   * permanently, even once the Group's real data caught up moments later. Groups are small and
   * infrequently written - keeping one attached for this Space's own whole lifetime, once ANY code
   * path has ever asked for it, is a deliberately cheap, unconditional guarantee against this exact
   * class of race, not something worth threading a "was this a group-ACL-critical read" flag through
   * every ordinary caller to avoid.
   */
  _releaseNode(id) {
    if (this._nodes.get(id)?.kind === GROUP_REF_KIND.kind) return;
    const count = (this._refCounts.get(id) ?? 1) - 1;
    if (count > 0) {
      this._refCounts.set(id, count);
      return;
    }
    this._refCounts.delete(id);
    if (this._warmNodeTTL > 0) this._goWarm(id);
    else this.unsubscribeNode(id);
  }

  /**
   * Keeps `id` attached and subscribed past refcount-zero for up to
   * `warmNodeTTL` ms instead of tearing it down immediately - see this
   * file's own "WARM-RELEASE CACHE" doc comment. `_warmSince`'s own
   * insertion order is what `_evictWarmOverCap()` reads as oldest-warmed-
   * first - inserting here (never touched again while warm) is what keeps
   * that order meaningful.
   */
  _goWarm(id) {
    this._warmSince.set(id, Date.now());
    this._evictWarmOverCap();
    if (!this._warmSince.has(id)) return; // _evictWarmOverCap() may have just evicted THIS id (maxWarmNodes: 0) - nothing left to schedule a timer for.
    const timer = setTimeout(() => this._teardownWarmNode(id), this._warmNodeTTL);
    timer.unref?.(); // Node.js only (browsers' timer handles have no unref()) - a pending warm-teardown timer must never keep a process alive on its own.
    this._warmTimers.set(id, timer);
  }

  /** Evicts the oldest-warmed Node(s) (real teardown, not just bookkeeping - see `_teardownWarmNode()`) until `_warmSince.size` is back within `maxWarmNodes` - the scalability bound `warmNodeTTL` alone doesn't provide, see this file's own "WARM-RELEASE CACHE" doc comment. */
  _evictWarmOverCap() {
    while (this._warmSince.size > this._maxWarmNodes) {
      const oldestId = this._warmSince.keys().next().value;
      this._teardownWarmNode(oldestId);
    }
  }

  /** The real teardown a warm Node eventually gets, either its own `warmNodeTTL` timer firing or `_evictWarmOverCap()` forcing it early - clears this Node's warm bookkeeping, then defers to the ordinary `unsubscribeNode()` every non-warm release already used. */
  _teardownWarmNode(id) {
    clearTimeout(this._warmTimers.get(id));
    this._warmTimers.delete(id);
    this._warmSince.delete(id);
    this.unsubscribeNode(id);
  }

  _attach(id, kindSchema, doc, { skipReSeal = false, groupRef = null } = {}) {
    const node = new SpaceNode({ id, kindSchema, doc, identity: this._identity, recipientXPubKeys: () => this._recipientXPubKeys(), groupRef });
    node._skipReSeal = skipReSeal;
    this._nodes.set(id, node);
    doc.on('update', (update, origin) => this._handleLocalUpdate(id, node, update, origin));
    return node;
  }

  /**
   * `recipients` (`field.js`'s own `withWriteContext()` origin, `undefined`
   * when a write never narrowed it) NARROWED to a SPECIFIC audience below
   * the Space's own full member list, PLUS this identity's own xPub, ALWAYS
   * - defensively, not because a caller is expected to remember it: a
   * `recipients` list that omitted the AUTHOR's own key would permanently
   * lock them out of their own just-written data (unable to `.get()` it
   * back, ever, since `decryptEnvelopeFor()` only tries entries actually
   * present in `envelope.to`) - a real, easy-to-make mistake this exists to
   * make structurally impossible rather than merely documented as "don't
   * forget." Falls back to the ordinary full-member list when `recipients`
   * was never set at all - unchanged behavior for every write that doesn't
   * use this.
   */
  _effectiveRecipients(recipients) {
    if (!recipients) return this._recipientXPubKeys();
    const myXPubB64 = QuCrypto.toBase64(this._identity.xPublicKey);
    if (recipients.some((xPub) => QuCrypto.toBase64(xPub) === myXPubB64)) return recipients;
    return [...recipients, this._identity.xPublicKey];
  }

  async _handleLocalUpdate(nodeId, node, update, origin) {
    if (origin === REMOTE_ORIGIN || node._skipReSeal) return; // never re-seal/re-broadcast a write we just received or are replaying from storage.
    // A plain object origin is field.js's withWriteContext()/stampMeta()'s carrier for
    // {notify, visibility, recipients} (see those files' own doc comments) - `visibility` is
    // always set now; `notify`/`recipients` are optional. Anything else (a raw doc.transact() with
    // no origin at all, which nothing in this codebase does anymore, but a caller reaching straight
    // for Y.Doc could) defaults to the safe 'encrypted' mode, same as this Space's behavior before
    // visibility existed.
    const notify = origin && typeof origin === 'object' ? origin.notify ?? null : null;
    const visibility = origin && typeof origin === 'object' ? origin.visibility ?? 'encrypted' : 'encrypted';
    const recipients = origin && typeof origin === 'object' ? origin.recipients ?? null : null;
    const effectiveRecipients = this._effectiveRecipients(recipients);
    // sealStrategy (constructor param, default sealStrategies.none - see seal-strategies.js's own
    // doc comment) decides which OTHER members get a padding entry alongside the real recipients -
    // only consulted for 'encrypted' mode: a 'public' write has no `to` list to pad in the first
    // place (sealPublicUpdate() never takes recipients at all).
    const paddingXPubKeys = visibility === 'public' ? [] : this._sealStrategy({ recipientXPubKeys: effectiveRecipients, memberXPubKeys: this._recipientXPubKeys() });
    const envelope =
      visibility === 'public'
        ? await sealPublicUpdate(update, this._identity, notify)
        : await sealUpdate(update, this._identity, effectiveRecipients, notify, false, paddingXPubKeys);
    await this._storageFor(node.kindSchema)?.append(nodeId, envelope);
    // `groupRef` (kind-schema.js's own "'group'" ACL mode doc comment) - carried on the OUTER wire
    // message, never inside `envelope` itself (which stays identical in shape to every other Kind's) -
    // `node.groupRef` is `null` for every Kind except `acl.write: 'group'`, so this is a no-op
    // additional field for every existing write path.
    this._transport.send(node.groupRef ? { nodeId, envelope, groupRef: node.groupRef } : { nodeId, envelope });
    this._bus?.emit('debug.space.write.local', { nodeId, kind: node.kind, bytes: update.length, notify });
    this._emitChangeEvents(nodeId, node, { origin: 'local', notify, authorPub: this._identity.signingPub });
  }

  /**
   * The constructor's own `onMessage` callback SERIALIZES calls into this
   * (a promise chain, never overlapping calls) - this method's own body may
   * `await` (crypto verification is genuinely async), so without that
   * guarantee two messages that ARRIVE in order could still COMPLETE their
   * processing out of order, whichever happens to have fewer/faster awaits
   * - normally harmless, but a real race for `acl.write: 'content'` (see
   * kind-schema.js): unlike `'owner'`/`'named'`, EVERY reader (including
   * for the content owner's OWN writes) needs an explicit `grant` message
   * processed first, no self-certifying shortcut - a `grant` that arrived
   * first but whose async verification finishes SECOND would otherwise let
   * the very next write past it lose the authorization race and be
   * rejected outright, permanently gapping that author's Yjs update
   * sequence (see grant.js's "WRITE-BEFORE-GRANT IS A TRAP"). Serial
   * processing in arrival order is what makes `Space.createNode()`'s
   * transparent self-grant-then-write sequence for `'content'`-ACL Kinds
   * safe for ANY remote reader, not just the creator's own local state.
   */
  async _handleIncoming(message) {
    const { nodeId, envelope, type, pub, xPub, name, groupRef } = message;
    if (type === 'subscribe' || type === 'unsubscribe' || type === 'hello') return; // all three are relay-bound, not peer-bound (see _sendSubscribeRequest/unsubscribeNode/_sendHello) - defensive no-op if one ever reaches here anyway.
    if (type === 'write-ack') {
      // See @qu/space-transport's relay.js "WRITE-ACK" doc comment - `seq` is this Node's mirror
      // size after the ack-triggering write landed, a cheap, storage-derived "your write reached
      // the relay's durable mirror" signal distinct from a live peer applying it (which arrives as
      // an ordinary `space.node.<nodeId>.changed` with `origin: 'remote'` on THEIR Space, not this one).
      this._bus?.emit(`space.node.${message.nodeId}.write-ack`, { nodeId: message.nodeId, seq: message.seq });
      return;
    }
    if (type === 'sync-ack') {
      // See @qu/space-transport's relay.js's own "SYNC-ACK" doc comment (in handleSubscribe()) and
      // isNodeSynced()'s own doc comment above - `count` (this Node's replayed envelope count,
      // possibly 0) isn't tracked here at all, ONLY the fact that a reply arrived: `isNodeSynced()`
      // means "nothing more is coming from what this relay already had," true regardless of whether
      // that turned out to be zero envelopes or several. Recorded ONLY if this Space still has a
      // local handle for the id (`_nodes.has()`) - a stray/late ack for an id already
      // `unsubscribeNode()`d (this exact message racing its own unsubscribe) must never resurrect a
      // stale synced-flag for whatever NEW local Y.Doc a later re-subscribe builds from scratch.
      if (this._nodes.has(message.nodeId)) {
        this._syncedNodes.add(message.nodeId);
        this._lastSyncAckAt.set(message.nodeId, Date.now()); // see "WARM-RELEASE CACHE"'s own staleAfter paragraph - same lifetime as _syncedNodes.
        this._bus?.emit(`space.node.${message.nodeId}.sync-ack`, { nodeId: message.nodeId, count: message.count });
      }
      return;
    }
    if (type === 'grant') {
      // See grant.js's own doc comment: verified independently here, never trusted just because
      // it arrived - a relay (or a malicious peer on a peer-to-peer transport) forwarding a
      // forged/mismatched grant is caught by _applyGrant()'s verifyGrant() call, same as any
      // other unauthenticated-until-verified control message this Space accepts.
      const applied = await this._applyGrant(message);
      this._bus?.emit(applied ? 'debug.space.grant.received' : 'debug.space.grant.rejected', { nodeId: message.nodeId });
      return;
    }
    if (type === 'member-joined') {
      // REACTIVE membership growth - see @qu/space-transport's relay.js `addMember()` doc comment
      // for the full "why", and this class's own doc comment for the `space.member.joined` topic.
      // No poll, no timer: this runs the instant the relay's broadcast arrives on the already-open
      // connection, same as any other incoming message.
      this.addMember({ pub, xPub });
      this._bus?.emit('space.member.joined', { pub: QuCrypto.toBase64(pub), xPub: QuCrypto.toBase64(xPub), name });
      return;
    }
    if (type === 'member-left') {
      // REACTIVE membership shrinking - the exact inverse of 'member-joined' above, see
      // @qu/space-transport's relay.js own `removeMember()` doc comment for the full "why" and its
      // one real limitation (not retroactive).
      this.removeMember(pub);
      this._bus?.emit('space.member.left', { pub: QuCrypto.toBase64(pub) });
      return;
    }
    if (type === 'relay-admin-added' || type === 'relay-admin-removed') {
      // Same reactive shape as 'member-joined'/'member-left', for the SEPARATE `_relayAdmins` list
      // instead (kind-schema.js's own doc comment on the `'relay-admins'` ACL mode) - see
      // relay.js's own `addRelayAdmin()`/`removeRelayAdmin()` doc comments.
      if (type === 'relay-admin-added') this.addRelayAdmin(pub);
      else this.removeRelayAdmin(pub);
      this._bus?.emit(`space.relay-admin.${type === 'relay-admin-added' ? 'added' : 'removed'}`, { pub: QuCrypto.toBase64(pub) });
      return;
    }
    if (!envelope) return;
    const node = this._nodes.get(nodeId);
    if (!node) {
      this._bus?.emit('debug.space.write.remote.ignored', { nodeId }); // not subscribed to this Node - ordinary relay fan-out, not an error, see this file's own doc comment.
      return;
    }
    const isAuthorized = this._isAuthorizedWriter(node.kindSchema, nodeId, groupRef);
    if (!(await verifyEnvelope(envelope, isAuthorized))) {
      // envelope.pub is guaranteed well-formed here: verifyEnvelope() already base64-encoded it internally without throwing.
      this._bus?.emit('debug.space.write.remote.rejected', { nodeId, authorPub: QuCrypto.toBase64(envelope.pub) });
      return; // bad/foreign signature - reject before it ever touches the CRDT.
    }
    let bytes;
    try {
      bytes = await openUpdate(envelope, this._identity);
    } catch {
      // Authentic, ACL-authorized write this identity simply isn't a decryption RECIPIENT of -
      // e.g. history sealed before this identity became a Space member (the writer's own
      // recipient list at write time never included it - see envelope.js's own doc comment on
      // `openUpdate()` throwing for exactly this case). Expected, not an error: skip it, same
      // "not a recipient -> not applied" outcome `_hydrateFromStorage()`'s own loop above now
      // gives too. Previously UNCAUGHT here - a real bug (an unhandled rejection on every such
      // envelope, and the write silently never reaching this peer's own doc with no diagnostic).
      this._bus?.emit('debug.space.write.remote.undecryptable', { nodeId });
      return;
    }
    Y.applyUpdate(node.doc, bytes, REMOTE_ORIGIN);
    // A `snapshot: true` envelope (see envelope.js's own "SNAPSHOT/COMPACTION" doc comment)
    // REPLACES this Space's own local storage log for the Node instead of appending to it - the
    // same compaction that just happened for the relay's mirror also has to happen for every
    // OTHER peer's own durable copy, or the point of compacting would only ever apply to one place.
    if (envelope.snapshot) await this._storageFor(node.kindSchema)?.replace(nodeId, [envelope]);
    else await this._storageFor(node.kindSchema)?.append(nodeId, envelope);
    this._bus?.emit('debug.space.write.remote.accepted', { nodeId, kind: node.kind, authorPub: QuCrypto.toBase64(envelope.pub), bytes: bytes.length });
    this._emitChangeEvents(nodeId, node, { origin: 'remote', notify: envelope.notify ?? null, authorPub: envelope.pub });
  }

  /** See this file's own top doc comment for the two topics this fires. No-op entirely when no `bus` was given (the default). */
  _emitChangeEvents(nodeId, node, { origin, notify, authorPub }) {
    if (!this._bus) return;
    this._bus.emit(`space.node.${nodeId}.changed`, { nodeId, kind: node.kind, origin });
    if (notify) {
      this._bus.emit(`notification.${node.kind}.${notify.topic}`, {
        nodeId,
        kind: node.kind,
        topic: notify.topic,
        to: notify.to ?? [],
        authorPub: QuCrypto.toBase64(authorPub),
        origin,
      });
    }
  }

  getNode(id) {
    return this._nodes.get(id);
  }
}
