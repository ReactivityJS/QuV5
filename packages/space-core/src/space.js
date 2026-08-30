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
 * Omitting `bus` (the default) makes a Space behave exactly as before this
 * existed - nothing is emitted, nothing else changes.
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
 *   - `debug.space.subscribe.sent` / `debug.space.unsubscribe.sent` /
 *     `debug.space.hello.sent` - the signed control messages this Space
 *     sends on its own, `{nodeId}` / `{nodeId}` / `{}`.
 *   - `debug.space.grant.received` / `.rejected` - an incoming `grant`
 *     control message (see grant.js) was verified and applied, or wasn't, `{nodeId}`.
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
import { deriveOwnerNodeId } from './kind-schema.js';
import { signGrant, verifyGrant } from './grant.js';

const REMOTE_ORIGIN = Symbol('space-core:remote-update');

/** Signed by a Space on connect to prove key possession for presence purposes - see this file's own doc comment. Exported so `@qu/space-transport`'s relay verifies against the exact same bytes. */
export const HELLO_DOMAIN = 'qu-space-hello-v1';

export class Space {
  /**
   * @param {{identity: object, members: Array<{pub: Uint8Array, xPub: Uint8Array}>, transport: object, storage?: object, bus?: import('@qu/events').EventBus}} params
   *   `identity` = `{signingKey, signingPub, xPrivateKey, xPublicKey}` (Ed25519 + X25519 pairs, e.g. from QuCrypto.generateKeypair()).
   *   `members` = every space member's public keys (encryption recipients + write-ACL, kept simple for the PoC - see kind-schema.js).
   *   `storage` = optional; omitting it is the "flüchtig/memory-only" tier (see docs/v5-space-core-guide.md) - a Node still syncs live, nothing survives a reload.
   *   `bus` = optional - see this file's own doc comment for what gets emitted on it.
   */
  constructor({ identity, members, transport, storage = null, bus = null }) {
    this._identity = identity;
    this._members = [...members]; // own copy - addMember() (see below) must never mutate the caller's own array out from under them.
    this._transport = transport;
    this._storage = storage;
    this._bus = bus;
    /** @type {Map<string, SpaceNode>} */
    this._nodes = new Map();
    /** @type {Map<string, Set<string>>} nodeId -> Set<base64 Ed25519 pubkey> - 'named'-mode write-ACL state, 100% derived from verified `grant` messages (see grant.js), never invented. */
    this._grants = new Map();
    /** @type {Map<string, number>} nodeId -> active reference count - see `useNode()`'s own doc comment below. */
    this._refCounts = new Map();
    this._transport.onMessage((msg) => this._handleIncoming(msg.data));
    this._sendHello(); // fire-and-forget, see this file's own doc comment.
  }

  async _sendHello() {
    const sig = await QuCrypto.sign(new TextEncoder().encode(HELLO_DOMAIN), this._identity.signingKey);
    this._transport.send({ type: 'hello', pub: this._identity.signingPub, sig });
    this._bus?.emit('debug.space.hello.sent', {});
  }

  /** This Space's own identity, `{signingKey, signingPub, xPrivateKey, xPublicKey}` - read-only, for framework-level add-ons (e.g. alias.js's `publishAlias()`) that need it without reaching into a "private" field. */
  get identity() {
    return this._identity;
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
   * Returns this Node's write-ACL check, shaped exactly like
   * `verifyEnvelope()` wants: `(pubBase64) => boolean|Promise<boolean>`.
   * Branches on `kindSchema.acl.write` (see kind-schema.js's own doc
   * comment on the three modes):
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
   * @param {object} kindSchema
   * @param {string} nodeId
   */
  _isAuthorizedWriter(kindSchema, nodeId) {
    if (kindSchema?.acl?.write !== 'owner' && kindSchema?.acl?.write !== 'named') {
      const writerPubs = new Set(this._members.map((m) => QuCrypto.toBase64(m.pub)));
      return (pubB64) => writerPubs.has(pubB64);
    }
    return async (pubB64) => {
      const ownerNodeId = await deriveOwnerNodeId(QuCrypto.fromBase64(pubB64), kindSchema.kind);
      if (ownerNodeId === nodeId) return true;
      if (kindSchema.acl.write === 'named') return this._grants.get(nodeId)?.has(pubB64) ?? false;
      return false;
    };
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
   */
  async grantWriter(nodeId, kind, granteePub) {
    const message = await signGrant({ nodeId, kind, granteePub }, this._identity);
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
   * @param {object} kindSchema - From defineKind()/KindRegistry.
   * @param {Record<string, *>} initialFields - Only 'atomic-encrypted'/'text' fields (list fields start empty; use `.field(name).push()`).
   * @param {{id?: string}} [options] - `id` is IGNORED for an `'owner'`/`'named'`-ACL kindSchema:
   *   its Node id is never a caller's choice, it is `deriveOwnerNodeId(this._identity.signingPub,
   *   kindSchema.kind)` (see kind-schema.js) - self-certifying by construction, so there is
   *   nothing to pass. For `'members'`-ACL kinds, omitting `id` picks a random one, same as before.
   * @returns {Promise<SpaceNode>}
   */
  async createNode(kindSchema, initialFields = {}, { id = crypto.randomUUID() } = {}) {
    if (kindSchema.acl.write !== 'members') id = await deriveOwnerNodeId(this._identity.signingPub, kindSchema.kind);
    // _attach() FIRST, so the update listener is already registered before
    // stampMeta()'s mutation happens - see stampMeta()'s doc comment for
    // why doing this the other way round permanently breaks sync for
    // every later update on this Node.
    const doc = new Y.Doc();
    const node = this._attach(id, kindSchema, doc);
    // A relay only ever forwards a write to a Node's SUBSCRIBERS (see @qu/space-transport's
    // relay.js "SUBSCRIBER-TRACKING" doc comment) - without this, the creator of a Node would
    // never see anyone ELSE's later, otherwise-authorized write to it (e.g. a 'named'-ACL
    // grantee writing back - see acl.test.js), since creating a Node is not, by itself, asking to
    // be pushed updates for it. Fire-and-forget, same posture as subscribeNode()'s own request.
    this._sendSubscribeRequest(id);
    stampMeta(doc, kindSchema, this._identity.signingPub);
    for (const [name, value] of Object.entries(initialFields)) {
      const field = node.field(name);
      if (typeof field.set === 'function') await field.set(value);
      else if (typeof field.insert === 'function') field.insert(0, value);
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
   */
  subscribeNode(id, kindSchema) {
    if (this._nodes.has(id)) return this._nodes.get(id);
    const doc = new Y.Doc(); // meta/content arrive via sync, not stamped locally - this peer did not create this Node.
    const node = this._attach(id, kindSchema, doc);
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
    const sig = await QuCrypto.sign(new TextEncoder().encode(id), this._identity.signingKey);
    this._transport.send({ type: 'unsubscribe', nodeId: id, pub: this._identity.signingPub, sig });
    this._bus?.emit('debug.space.unsubscribe.sent', { nodeId: id });
  }

  /** Replays a Node's envelope history from storage (see @qu/space-storage) - the "durable persistence survives a reload" path. */
  async loadNode(id, kindSchema) {
    if (!this._storage) throw new Error('Space.loadNode: no storage adapter mounted');
    const doc = new Y.Doc();
    const node = this._attach(id, kindSchema, doc, { skipReSeal: true });
    await this._hydrateFromStorage(id, kindSchema, doc);
    node._skipReSeal = false;
    return node;
  }

  /** Shared by `loadNode()` and `useNode()`: applies every already-verified-on-write envelope this Space's OWN storage holds for `id` into `doc`, oldest first. Never trusts storage blindly - a tampered/foreign entry is skipped, same as any other unverified envelope. */
  async _hydrateFromStorage(id, kindSchema, doc) {
    const envelopes = await this._storage.load(id);
    const isAuthorized = this._isAuthorizedWriter(kindSchema, id);
    for (const envelope of envelopes) {
      if (!(await verifyEnvelope(envelope, isAuthorized))) continue;
      const bytes = await openUpdate(envelope, this._identity);
      Y.applyUpdate(doc, bytes, REMOTE_ORIGIN);
    }
    this._bus?.emit('debug.space.load', { nodeId: id, envelopeCount: envelopes.length });
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
   * releases it. Mixing this with a raw `subscribeNode()`/
   * `unsubscribeNode()` call for the SAME id is not supported - pick one
   * discipline per Node id (this one is the recommended default for any
   * caller that doesn't have a specific reason to use the lower-level
   * methods directly).
   * @param {string} id
   * @param {object} kindSchema
   * @returns {Promise<{node: SpaceNode, release: () => void}>}
   */
  async useNode(id, kindSchema) {
    this._refCounts.set(id, (this._refCounts.get(id) ?? 0) + 1);

    let node = this._nodes.get(id);
    if (!node) {
      const doc = new Y.Doc();
      node = this._attach(id, kindSchema, doc, { skipReSeal: true });
      if (this._storage) await this._hydrateFromStorage(id, kindSchema, doc);
      node._skipReSeal = false;
      await this._sendSubscribeRequest(id); // awaited (unlike subscribeNode()'s own fire-and-forget) - useNode() already returns a Promise, so a caller awaiting it can rely on the subscribe request having actually left by the time it resolves.
    }
    return { node, release: () => this._releaseNode(id) };
  }

  /** The other half of `useNode()`'s reference count - see that method's own doc comment. Fire-and-forget, same posture as every other control-message-sending method here. */
  _releaseNode(id) {
    const count = (this._refCounts.get(id) ?? 1) - 1;
    if (count > 0) {
      this._refCounts.set(id, count);
      return;
    }
    this._refCounts.delete(id);
    this.unsubscribeNode(id);
  }

  _attach(id, kindSchema, doc, { skipReSeal = false } = {}) {
    const node = new SpaceNode({ id, kindSchema, doc, identity: this._identity, recipientXPubKeys: () => this._recipientXPubKeys() });
    node._skipReSeal = skipReSeal;
    this._nodes.set(id, node);
    doc.on('update', (update, origin) => this._handleLocalUpdate(id, node, update, origin));
    return node;
  }

  async _handleLocalUpdate(nodeId, node, update, origin) {
    if (origin === REMOTE_ORIGIN || node._skipReSeal) return; // never re-seal/re-broadcast a write we just received or are replaying from storage.
    // A plain object origin is field.js's withWriteContext()/stampMeta()'s carrier for
    // {notify, visibility} (see those files' own doc comments) - both always set `visibility`
    // now; `notify` is optional. Anything else (a raw doc.transact() with no origin at all,
    // which nothing in this codebase does anymore, but a caller reaching straight for Y.Doc
    // could) defaults to the safe 'encrypted' mode, same as this Space's behavior before
    // visibility existed.
    const notify = origin && typeof origin === 'object' ? origin.notify ?? null : null;
    const visibility = origin && typeof origin === 'object' ? origin.visibility ?? 'encrypted' : 'encrypted';
    const envelope =
      visibility === 'public'
        ? await sealPublicUpdate(update, this._identity, notify)
        : await sealUpdate(update, this._identity, this._recipientXPubKeys(), notify);
    await this._storage?.append(nodeId, envelope);
    this._transport.send({ nodeId, envelope });
    this._bus?.emit('debug.space.write.local', { nodeId, kind: node.kind, bytes: update.length, notify });
    this._emitChangeEvents(nodeId, node, { origin: 'local', notify, authorPub: this._identity.signingPub });
  }

  async _handleIncoming(message) {
    const { nodeId, envelope, type, pub, xPub, name } = message;
    if (type === 'subscribe' || type === 'unsubscribe' || type === 'hello') return; // all three are relay-bound, not peer-bound (see _sendSubscribeRequest/unsubscribeNode/_sendHello) - defensive no-op if one ever reaches here anyway.
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
    if (!envelope) return;
    const node = this._nodes.get(nodeId);
    if (!node) {
      this._bus?.emit('debug.space.write.remote.ignored', { nodeId }); // not subscribed to this Node - ordinary relay fan-out, not an error, see this file's own doc comment.
      return;
    }
    const isAuthorized = this._isAuthorizedWriter(node.kindSchema, nodeId);
    if (!(await verifyEnvelope(envelope, isAuthorized))) {
      // envelope.pub is guaranteed well-formed here: verifyEnvelope() already base64-encoded it internally without throwing.
      this._bus?.emit('debug.space.write.remote.rejected', { nodeId, authorPub: QuCrypto.toBase64(envelope.pub) });
      return; // bad/foreign signature - reject before it ever touches the CRDT.
    }
    const bytes = await openUpdate(envelope, this._identity);
    Y.applyUpdate(node.doc, bytes, REMOTE_ORIGIN);
    await this._storage?.append(nodeId, envelope);
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
