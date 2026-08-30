/**
 * UPLOAD OUTBOX — "save locally now, queue for sync, mark done once
 * synced, retry on failure" for (multiple) file uploads, WITHOUT this
 * framework inventing a new binary wire protocol: a relay only ever
 * forwards/mirrors signed CRDT envelopes (see `@qu/space-transport`'s
 * relay.js), which is a poor fit for large file bytes - so this class
 * manages the QUEUE/STATE MACHINE and lets the caller supply how bytes
 * actually move, same "framework provides the mechanism, app supplies the
 * policy" split `push-handler.js` already uses for notification delivery.
 *
 * Two collaborators the caller supplies:
 *   - `localStore` - `{save(id, blob), load(id), remove(id)}`. Same
 *     swappable-adapter idea as `@qu/space-storage`'s memory/durable/file
 *     stores: an IndexedDB-backed one in a browser, a filesystem one in
 *     Node, an in-memory one for tests. This class never inspects `blob`,
 *     only round-trips it through these three calls.
 *   - `upload(record, blob)` - actually moves the bytes wherever they need
 *     to go (a media server, object storage, chunked over your own
 *     transport - anything). Throwing marks the record `'failed'`
 *     (retryable via `retry(id)`); resolving marks it `'done'`.
 *
 * METADATA (name/size/mimeType/status/error) lives in an ordinary,
 * self-certifying `'owner'`-ACL Node (`uploadOutboxKind`) - one per
 * uploader, `records` an ENCRYPTED map keyed by file id. This is the SAME
 * "Space stays unaware this is a concept" shape as `@qu/space-core`'s
 * `alias.js`/`presence.js` - reading it (a fellow Space member who
 * subscribes) is exactly how "Alice is uploading a file" / a remote-sync
 * status icon (see the framework's own UI layer) gets its data, live, with
 * zero relay-side awareness of "uploads" as a concept.
 */
import { defineKind, deriveOwnerNodeId } from '@qu/space-core';

/**
 * One per uploader: `records` is a `{ [fileId]: {name, size, mimeType,
 * status, error?, addedAt} }` map. `'public'` visibility (like
 * `@qu/space-core`'s `presenceKind`, not `readReceiptKind`'s `'encrypted'`)
 * so the UPLOADER can always read their own status back without also
 * having to remember to include themselves in `members` (an `'encrypted'`
 * field only decrypts for its actual recipients, self included) - and so a
 * remote-sync status icon (see the framework's own UI layer) works for any
 * subscribed fellow member with zero extra membership bookkeeping. File
 * NAMES are visible to anyone who discovers the outbox Node id this way -
 * an app with stricter confidentiality needs should encrypt sensitive
 * metadata (e.g. `name`) itself before ever passing it to `enqueue()`,
 * rather than relying on this Kind's own field-level encryption.
 */
export const uploadOutboxKind = defineKind('qu-upload-outbox', {
  fields: { records: { shape: 'atomic', visibility: 'public' } },
  acl: { write: 'owner' },
});

function randomId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export class UploadOutbox {
  /**
   * @param {import('@qu/space-core').Space} space
   * @param {{save(id: string, blob: *): Promise<void>, load(id: string): Promise<*>, remove(id: string): Promise<void>}} localStore
   * @param {(record: object, blob: *) => Promise<void>} upload
   */
  constructor(space, localStore, upload) {
    this._space = space;
    this._localStore = localStore;
    this._upload = upload;
    this._node = null;
  }

  async _ensureNode() {
    if (this._node) return this._node;
    const nodeId = await deriveOwnerNodeId(this._space.identity.signingPub, uploadOutboxKind.kind);
    this._node = this._space.getNode(nodeId) ?? (await this._space.createNode(uploadOutboxKind, {}, { id: nodeId }));
    return this._node;
  }

  async _patch(id, patch) {
    const node = await this._ensureNode();
    const records = (await node.field('records').get()) ?? {};
    records[id] = { ...records[id], ...patch };
    await node.field('records').set(records);
    return records[id];
  }

  /**
   * Saves `blob` locally FIRST (so the file survives a reload/crash before
   * any network attempt is even made), records `'pending'` metadata, then
   * immediately attempts the upload - failure leaves it `'failed'` for a
   * later `retry()`, it is never dropped from the queue on its own.
   * @param {{id?: string, name: string, size: number, mimeType: string}} meta
   * @param {*} blob - whatever `localStore` expects (a `Blob`/`File` in a browser, a `Buffer` in Node, ...).
   * @returns {Promise<string>} the file id (generated if `meta.id` was omitted).
   */
  async enqueue(meta, blob) {
    const id = meta.id ?? randomId();
    await this._localStore.save(id, blob);
    await this._patch(id, { ...meta, id, status: 'pending', addedAt: Date.now(), error: null });
    await this._attempt(id, blob);
    return id;
  }

  /** Re-attempts a `'failed'` (or any) queued upload, reloading its bytes from `localStore` first - so a retry works even across a reload where the original `blob` reference is long gone. @param {string} id */
  async retry(id) {
    const blob = await this._localStore.load(id);
    await this._attempt(id, blob);
  }

  async _attempt(id, blob) {
    const record = await this.statusOf(id);
    if (!record) return;
    await this._patch(id, { status: 'uploading' });
    try {
      await this._upload(record, blob);
      await this._patch(id, { status: 'done', error: null });
      await this._localStore.remove(id); // "nach relay sync abhaken" - once durably uploaded, the local copy no longer needs to be kept around for a retry.
    } catch (err) {
      await this._patch(id, { status: 'failed', error: String(err?.message ?? err) });
    }
  }

  /** @param {string} id @returns {Promise<object|undefined>} this file's current metadata record, or `undefined` if unknown. */
  async statusOf(id) {
    const node = await this._ensureNode();
    const records = (await node.field('records').get()) ?? {};
    return records[id];
  }

  /** @returns {Promise<object[]>} every queued/attempted file's current metadata record. */
  async list() {
    const node = await this._ensureNode();
    return Object.values((await node.field('records').get()) ?? {});
  }
}
