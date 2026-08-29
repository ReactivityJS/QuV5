/**
 * FIELD — typed accessors over one Node's Yjs shared types, dispatched by
 * Kind-Schema field type (see kind-schema.js). This is where the
 * per-field-type encryption split actually lives:
 *
 *   'atomic-encrypted': the plaintext is encrypted (QuCrypto.encrypt, same
 *     recipient-envelope shape QuStore's `#seal()` already uses) BEFORE it
 *     ever becomes a Y.Map value. The resulting Yjs update - and therefore
 *     any storage/transport envelope built from it - carries only
 *     ciphertext. `get()` decrypts locally; a non-recipient's `get()`
 *     returns `undefined` (still-ciphertext, unreadable), not an error -
 *     the value is genuinely present in the CRDT, just opaque to them.
 *
 *   'text': backed by a real Y.Text, edited character-by-character. Yjs'
 *     merge algorithm operates directly on the plaintext ops, so this
 *     field's value is NOT pre-encrypted the way an atomic field's is -
 *     doing so would collapse concurrent character-level edits into
 *     "whoever wrote last overwrites the opaque blob," destroying the one
 *     property Y.Text exists for. Confidentiality for this field type is
 *     therefore enforced one layer out, at the envelope (see envelope.js):
 *     plaintext exists only locally, in the RAM of an actively-editing,
 *     authorized member - exactly like every other E2EE collaborative
 *     editor (this was a deliberate, discussed tradeoff, not an oversight).
 *
 *   'list': a top-level Y.Array of small QuCrypto-encrypted items - same
 *     per-item encryption as an atomic field, but many items instead of
 *     one value, so concurrent pushes from different peers merge via Yjs'
 *     own CRDT ordering instead of a bespoke append/cursor scheme.
 *
 * `set()`/`push()` both accept an optional `{notify}` option - see
 * envelope.js's own doc comment for what a `notify` hint IS and why it
 * exists (routing a content-blind relay's push decision without ever
 * decrypting). This is where it's VALIDATED, the one place that actually
 * has the Kind-Schema in hand: `notify.topic` must be one of this Node's
 * `kindSchema.notifyTopics` (see kind-schema.js), or the write throws
 * BEFORE it ever reaches Yjs/the network - a typo'd or invented topic
 * fails loudly, locally, instead of silently producing an envelope no
 * relay-side handler will ever match. The validated hint then rides as
 * the local Yjs transaction's `origin` (see `withNotify()` below) purely
 * as a carrier - `Space._handleLocalUpdate()` (space.js) is what actually
 * reads it back off `origin` and threads it into `sealUpdate()`.
 */
import * as Y from 'yjs';
import { QuCrypto } from '@qu/core';

async function encryptForRecipients(plainValue, identity, recipientXPubKeys) {
  const bytes = new TextEncoder().encode(JSON.stringify(plainValue));
  const { iv, ct, to } = await QuCrypto.encrypt(bytes, recipientXPubKeys, identity.xPrivateKey);
  return { iv, ct, to, senderXPub: identity.xPublicKey };
}

/**
 * Validates `notify.topic` against this Node's Kind-Schema allowlist (if a
 * hint was given at all - `notify` is optional, most writes have none),
 * then runs `mutateFn` inside a `doc.transact()` call carrying `{notify}`
 * as the transaction's origin - the mechanism that gets it from a field
 * write all the way to `sealUpdate()` (see this file's own top doc
 * comment, and `Space._handleLocalUpdate()` in space.js).
 * @param {Y.Doc} doc @param {() => void} mutateFn
 * @param {{topic: string, to?: string[]}|undefined} notify
 * @param {object} kindSchema
 */
function withNotify(doc, mutateFn, notify, kindSchema) {
  if (notify) {
    const allowed = kindSchema?.notifyTopics ?? [];
    if (!allowed.includes(notify.topic)) {
      throw new Error(`field write: notify.topic "${notify.topic}" is not declared in Kind-Schema "${kindSchema?.kind}"'s notifyTopics (${allowed.length ? allowed.join(', ') : 'none declared'})`);
    }
  }
  doc.transact(mutateFn, notify ? { notify } : undefined);
}

/** @returns {*|undefined} `undefined` if the caller is not an intended recipient (still ciphertext to them). */
async function decryptEnvelopeFor(envelope, identity) {
  if (!envelope) return null;
  const myPubB64 = QuCrypto.toBase64(identity.xPublicKey);
  const entry = envelope.to.find((t) => QuCrypto.toBase64(t.pub) === myPubB64);
  if (!entry) return undefined;
  const bytes = await QuCrypto.decrypt(envelope.iv, envelope.ct, entry.key, envelope.senderXPub, identity.xPrivateKey);
  return JSON.parse(new TextDecoder().decode(bytes));
}

class AtomicEncryptedField {
  constructor(contentMap, key, ctx, doc) {
    this._map = contentMap;
    this._key = key;
    this._ctx = ctx;
    this._doc = doc;
  }

  /** @param {*} value @param {{notify?: {topic: string, to?: string[]}}} [options] - see this file's own doc comment. */
  async set(value, { notify } = {}) {
    const envelope = await encryptForRecipients(value, this._ctx.identity, this._ctx.recipientXPubKeys());
    withNotify(this._doc, () => this._map.set(this._key, envelope), notify, this._ctx.kindSchema);
  }

  /** @returns {Promise<*|null|undefined>} `null` = unset. `undefined` = set, but this identity is not a recipient. */
  async get() {
    return decryptEnvelopeFor(this._map.get(this._key), this._ctx.identity);
  }

  /** True the moment ciphertext exists for this key, before any decryption is attempted. */
  isSet() {
    return this._map.has(this._key);
  }

  observe(callback) {
    const handler = (event) => {
      if (event.keysChanged.has(this._key)) callback();
    };
    this._map.observe(handler);
    return () => this._map.unobserve(handler);
  }
}

class TextField {
  // Deliberately does NOT auto-create the Y.Text on access, and does NOT
  // cache a reference to it at construction time. The creating peer always
  // pre-creates every 'text' field's Y.Text atomically alongside meta (see
  // node.js's stampMeta()) - a field handle here only ever reads the
  // content map's CURRENT value for this key, fresh, every time. Caching
  // would risk holding a stale/detached Y.Text if two peers ever raced to
  // create the same key (the bug this design avoids by construction).
  constructor(contentMap, key) {
    this._map = contentMap;
    this._key = key;
  }

  /** Direct handle to the underlying Y.Text - bind ProseMirror/Quill straight to this, no wrapper needed. Throws if this Node's creation envelope (which always carries every 'text' field's placeholder) has not synced yet. */
  get ytext() {
    const ytext = this._map.get(this._key);
    if (!ytext) throw new Error(`TextField("${this._key}"): not synced yet - this Node's creation envelope has not arrived`);
    return ytext;
  }

  get() {
    return this._map.get(this._key)?.toString() ?? '';
  }

  insert(index, text) {
    this.ytext.insert(index, text);
  }

  delete(index, length) {
    this.ytext.delete(index, length);
  }

  /** @param {(delta: Array<object>) => void} callback - Yjs' own insert/retain/delete delta, for atomic UI patching (see docs/v5-space-core-guide.md's <qu-text>). */
  observe(callback) {
    const ytext = this.ytext;
    const handler = (event) => callback(event.delta);
    ytext.observe(handler);
    return () => ytext.unobserve(handler);
  }
}

class ListField {
  constructor(yarray, ctx, doc) {
    this._yarray = yarray;
    this._ctx = ctx;
    this._doc = doc;
  }

  /** @param {*} value @param {{notify?: {topic: string, to?: string[]}}} [options] - see this file's own doc comment. */
  async push(value, { notify } = {}) {
    const envelope = await encryptForRecipients(value, this._ctx.identity, this._ctx.recipientXPubKeys());
    withNotify(this._doc, () => this._yarray.push([envelope]), notify, this._ctx.kindSchema);
  }

  async toArray() {
    const decrypted = await Promise.all(this._yarray.toArray().map((envelope) => decryptEnvelopeFor(envelope, this._ctx.identity)));
    return decrypted;
  }

  get length() {
    return this._yarray.length;
  }

  observe(callback) {
    const handler = () => callback();
    this._yarray.observe(handler);
    return () => this._yarray.unobserve(handler);
  }
}

/**
 * @param {'atomic-encrypted'|'text'|'list'} type
 * @param {Y.Map} contentMap
 * @param {Y.Doc} doc
 * @param {string} name
 * @param {object} ctx - `{identity, recipientXPubKeys, kindSchema}`
 */
export function createField(type, { contentMap, doc, name, ctx }) {
  if (type === 'atomic-encrypted') return new AtomicEncryptedField(contentMap, name, ctx, doc);
  if (type === 'text') return new TextField(contentMap, name);
  if (type === 'list') return new ListField(doc.getArray(name), ctx, doc);
  throw new Error(`createField: unknown field type "${type}"`);
}
