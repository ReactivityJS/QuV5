/**
 * DELIVERY STATUS — the "local / relay-synced / read" lifecycle a chat or
 * forum UI typically wants per message, built ENTIRELY on `@qu/space-core`'s
 * public API and `@qu/space-transport`'s existing write-ack, never a new
 * Space/relay mechanism. Two independent, composable pieces:
 *
 *   1. `awaitRelayAck(bus, nodeId)` - resolves the next time a write to
 *      `nodeId` reaches the relay's durable mirror (see
 *      `@qu/space-transport`'s relay.js "WRITE-ACK" doc comment and
 *      `@qu/space-core`'s `space.node.<nodeId>.write-ack` bus event).
 *      Correlated by ORDERING, not a per-write id: call it right after
 *      `await`ing your own write to that Node, before issuing another one
 *      to the SAME Node - exactly the sequential-await discipline this
 *      framework's own examples already use everywhere else. "Client-
 *      synced" (a specific peer applied it) has no equivalent primitive:
 *      Yjs carries no per-update delivery receipt, so the only honest way
 *      to know is an explicit ack from the reader - which is exactly what
 *      a read receipt (below) already gives you, one step further along
 *      the SAME lifecycle.
 *
 *   2. Read receipts (`readReceiptKind`/`markRead()`/`watchReadReceipts()`/
 *      `ReadReceiptWatcher`) - one self-certifying, DURABLE (unlike
 *      `@qu/space-core`'s `presenceKind` - a read marker is meaningful
 *      history worth surviving a reload, not ephemeral churn) `'owner'`-ACL
 *      Node per reader, holding an ENCRYPTED map `{ [contentNodeId]:
 *      {upTo, at} }` - `upTo` is caller-defined (a message index, an id, a
 *      timestamp - whatever "read up to here" means for your own content
 *      Kind). Same "Space stays unaware this is a concept" shape as
 *      `@qu/space-core`'s `alias.js`/`presence.js`.
 */
import { QuCrypto } from '@qu/core';
import { defineKind, deriveOwnerNodeId } from '@qu/space-core';

/**
 * @param {import('@qu/events').EventBus} bus - the SAME bus given to the writing Space's own constructor.
 * @param {string} nodeId
 * @returns {Promise<{nodeId: string, seq: number}>}
 */
export function awaitRelayAck(bus, nodeId) {
  return new Promise((resolve) => bus.once(`space.node.${nodeId}.write-ack`, resolve));
}

/** One per reader: `marks` is an encrypted `{ [contentNodeId]: {upTo, at} }` map - see this file's own doc comment. */
export const readReceiptKind = defineKind('qu-read-receipts', {
  fields: { marks: { shape: 'atomic', visibility: 'encrypted' } },
  acl: { write: 'owner' },
});

/** @param {Uint8Array} pub @returns {Promise<string>} */
export function readReceiptNodeId(pub) {
  return deriveOwnerNodeId(pub, readReceiptKind.kind);
}

/**
 * Marks THIS Space's identity as having read `contentNodeId` up to `upTo`
 * (creates its read-receipts Node on first call, updates thereafter).
 * @param {import('@qu/space-core').Space} space
 * @param {string} contentNodeId
 * @param {*} upTo - caller-defined "read up to here" marker.
 * @returns {Promise<import('@qu/space-core').SpaceNode>}
 */
export async function markRead(space, contentNodeId, upTo) {
  const nodeId = await readReceiptNodeId(space.identity.signingPub);
  const node = space.getNode(nodeId) ?? (await space.createNode(readReceiptKind, {}, { id: nodeId }));
  const marks = (await node.field('marks').get()) ?? {};
  marks[contentNodeId] = { upTo, at: Date.now() };
  await node.field('marks').set(marks);
  return node;
}

/**
 * One-shot snapshot of `pub`'s read receipts (every contentNodeId they've
 * marked, not just one) - subscribes if not already (see `Space.useNode()`).
 * @param {import('@qu/space-core').Space} space
 * @param {Uint8Array|string} pub
 * @returns {Promise<{marks: Record<string, {upTo: *, at: number}>, release: () => void}>}
 */
export async function watchReadReceipts(space, pub) {
  const pubBytes = typeof pub === 'string' ? QuCrypto.fromBase64(pub) : pub;
  const nodeId = await readReceiptNodeId(pubBytes);
  const { node, release } = await space.useNode(nodeId, readReceiptKind);
  const marks = (await node.field('marks').get()) ?? {};
  return { marks, release };
}

/** A live, multi-reader read-receipt CACHE - same reactive-watcher shape as `@qu/space-core`'s `presence.js` `PresenceWatcher`. */
export class ReadReceiptWatcher {
  /** @param {import('@qu/space-core').Space} space @param {import('@qu/events').EventBus} bus - the SAME bus given to `space`'s own constructor. */
  constructor(space, bus) {
    this._space = space;
    /** @type {Map<string, string>} read-receipt nodeId -> the reader's pubB64 - see presence.js's identical reasoning (deriveOwnerNodeId is one-way). */
    this._pubByNodeId = new Map();
    /** @type {Map<string, Record<string, {upTo: *, at: number}>>} pubB64 -> their full marks map. */
    this._map = new Map();
    bus.on('space.node.*.changed', (payload) => {
      if (payload.kind === readReceiptKind.kind && this._pubByNodeId.has(payload.nodeId)) this._absorb(payload.nodeId);
    });
  }

  /** Starts tracking `pub`'s read receipts. @param {Uint8Array|string} pub */
  async watch(pub) {
    const pubBytes = typeof pub === 'string' ? QuCrypto.fromBase64(pub) : pub;
    const pubB64 = QuCrypto.toBase64(pubBytes);
    const nodeId = await readReceiptNodeId(pubBytes);
    this._pubByNodeId.set(nodeId, pubB64);
    await this._space.useNode(nodeId, readReceiptKind);
    await this._absorb(nodeId);
  }

  async _absorb(nodeId) {
    const node = this._space.getNode(nodeId);
    const pubB64 = this._pubByNodeId.get(nodeId);
    if (!node || !pubB64) return;
    this._map.set(pubB64, (await node.field('marks').get()) ?? {});
  }

  /** @param {string} readerPubB64 @param {string} contentNodeId @returns {*|undefined} the last `upTo` this reader marked for `contentNodeId`. */
  upToFor(readerPubB64, contentNodeId) {
    return this._map.get(readerPubB64)?.[contentNodeId]?.upTo;
  }
}
