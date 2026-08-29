/**
 * SPACE — the V5 replacement for QuStore's `mount()`/pipeline. A Space is
 * one peer's live view of a set of Nodes, wired to exactly one Transport
 * and (optionally) one Storage adapter. There is no QuStore-shaped
 * `get(path)`/`put(path, val)` facade here on purpose (see docs/v5-space-core-guide.md's
 * decision to drop path/QuBit compatibility) - callers work with typed
 * Node/Field handles directly (see node.js/field.js).
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
 * Omitting `bus` (the default) makes a Space behave exactly as before this
 * existed - nothing is emitted, nothing else changes.
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
import { sealUpdate, verifyEnvelope, openUpdate } from './envelope.js';

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
    this._members = members;
    this._transport = transport;
    this._storage = storage;
    this._bus = bus;
    /** @type {Map<string, SpaceNode>} */
    this._nodes = new Map();
    this._transport.onMessage((msg) => this._handleIncoming(msg.data));
    this._sendHello(); // fire-and-forget, see this file's own doc comment.
  }

  async _sendHello() {
    const sig = await QuCrypto.sign(new TextEncoder().encode(HELLO_DOMAIN), this._identity.signingKey);
    this._transport.send({ type: 'hello', pub: this._identity.signingPub, sig });
  }

  _recipientXPubKeys() {
    return this._members.map((m) => m.xPub);
  }

  _isAuthorizedWriter(kindSchema) {
    const writerPubs = new Set(this._members.map((m) => QuCrypto.toBase64(m.pub)));
    return (pubB64) => writerPubs.has(pubB64); // kindSchema.acl.write === 'members' is the only mode the PoC supports.
  }

  /**
   * @param {object} kindSchema - From defineKind()/KindRegistry.
   * @param {Record<string, *>} initialFields - Only 'atomic-encrypted'/'text' fields (list fields start empty; use `.field(name).push()`).
   * @param {{id?: string}} [options]
   * @returns {Promise<SpaceNode>}
   */
  async createNode(kindSchema, initialFields = {}, { id = crypto.randomUUID() } = {}) {
    // _attach() FIRST, so the update listener is already registered before
    // stampMeta()'s mutation happens - see stampMeta()'s doc comment for
    // why doing this the other way round permanently breaks sync for
    // every later update on this Node.
    const doc = new Y.Doc();
    const node = this._attach(id, kindSchema, doc);
    stampMeta(doc, kindSchema, this._identity.signingPub);
    for (const [name, value] of Object.entries(initialFields)) {
      const field = node.field(name);
      if (typeof field.set === 'function') await field.set(value);
      else if (typeof field.insert === 'function') field.insert(0, value);
      else throw new Error(`createNode: field "${name}" (type ${kindSchema.fields[name]}) has no initial-value setter`);
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
  }

  /** Replays a Node's envelope history from storage (see @qu/space-storage) - the "durable persistence survives a reload" path. */
  async loadNode(id, kindSchema) {
    if (!this._storage) throw new Error('Space.loadNode: no storage adapter mounted');
    const doc = new Y.Doc();
    const node = this._attach(id, kindSchema, doc, { skipReSeal: true });
    const envelopes = await this._storage.load(id);
    const isAuthorized = this._isAuthorizedWriter(kindSchema);
    for (const envelope of envelopes) {
      if (!(await verifyEnvelope(envelope, isAuthorized))) continue; // tampered/foreign entry in the log - skip, never trust storage blindly.
      const bytes = await openUpdate(envelope, this._identity);
      Y.applyUpdate(doc, bytes, REMOTE_ORIGIN);
    }
    node._skipReSeal = false;
    return node;
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
    // A plain object origin is field.js's withNotify() carrier for a
    // validated {notify} option (see that file's own doc comment) - any
    // OTHER local mutation (stampMeta(), a field write with no `notify`
    // option) leaves `origin` undefined/null, same as before this existed.
    const notify = origin && typeof origin === 'object' ? origin.notify ?? null : null;
    const envelope = await sealUpdate(update, this._identity, this._recipientXPubKeys(), notify);
    await this._storage?.append(nodeId, envelope);
    this._transport.send({ nodeId, envelope });
    this._emitChangeEvents(nodeId, node, { origin: 'local', notify, authorPub: this._identity.signingPub });
  }

  async _handleIncoming({ nodeId, envelope, type }) {
    if (type === 'subscribe' || type === 'hello' || !envelope) return; // both are relay-bound, not peer-bound (see _sendSubscribeRequest/_sendHello) - defensive no-op if one ever reaches here anyway.
    const node = this._nodes.get(nodeId);
    if (!node) return; // not subscribed to this Node - ignore, same as QuStore's watch() only reacting to watched paths.
    const isAuthorized = this._isAuthorizedWriter(node.kindSchema);
    if (!(await verifyEnvelope(envelope, isAuthorized))) return; // bad/foreign signature - reject before it ever touches the CRDT.
    const bytes = await openUpdate(envelope, this._identity);
    Y.applyUpdate(node.doc, bytes, REMOTE_ORIGIN);
    await this._storage?.append(nodeId, envelope);
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
