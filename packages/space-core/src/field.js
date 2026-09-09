/**
 * FIELD — typed accessors over one Node's Yjs shared types, dispatched by a
 * Kind-Schema field declaration's `shape` (see kind-schema.js). This is
 * where the per-field encryption split actually lives:
 *
 *   'atomic' + visibility 'encrypted' (the historical default): the
 *     plaintext is encrypted (QuCrypto.encrypt, same recipient-envelope
 *     shape QuStore's `#seal()` already used) BEFORE it ever becomes a
 *     Y.Map value. `get()` decrypts locally; a non-recipient's `get()`
 *     returns `undefined` (still-ciphertext, unreadable), not an error -
 *     the value is genuinely present in the CRDT, just opaque to them.
 *
 *   'atomic' + visibility 'public': the RAW value sits in the Y.Map,
 *     unencrypted - no field-level wrapping, no envelope-level wrapping
 *     either (see envelope.js's `sealPublicUpdate()`). `get()` never
 *     returns `undefined` for this visibility - there is no "not a
 *     recipient" concept when everyone already is one, by design.
 *
 *   'text': backed by a real Y.Text, edited character-by-character. Yjs'
 *     merge algorithm operates directly on the plaintext ops, so this
 *     field's value is NEVER pre-encrypted at the field level, for EITHER
 *     visibility - doing so would collapse concurrent character-level
 *     edits into "whoever wrote last overwrites the opaque blob,"
 *     destroying the one property Y.Text exists for. Confidentiality for
 *     `visibility: 'encrypted'` text is therefore enforced one layer out,
 *     at the envelope: plaintext exists only locally, in the RAM of an
 *     actively-editing, authorized member - exactly like every other E2EE
 *     collaborative editor (a deliberate, discussed tradeoff, not an
 *     oversight). `visibility: 'public'` text (e.g. a public wiki page
 *     body) skips that outer wrapping too - genuinely plaintext end to end.
 *
 *   'list': a top-level Y.Array of items - `visibility: 'encrypted'` items
 *     are individually QuCrypto-encrypted (same shape as an atomic field);
 *     `visibility: 'public'` items are the raw pushed value. Concurrent
 *     pushes from different peers merge via Yjs' own CRDT ordering either
 *     way - no bespoke append/cursor scheme needed.
 *
 * WHERE VISIBILITY ACTUALLY TAKES EFFECT ON THE WIRE: every mutating call
 * here wraps its Yjs mutation in `doc.transact(fn, {notify, visibility,
 * recipients})` - `Space._handleLocalUpdate()` (space.js) reads
 * `visibility` back off that transaction's origin to decide `sealUpdate()`
 * (encrypted) vs. `sealPublicUpdate()` (public) for the envelope this
 * write produces. A field never talks to envelope.js directly - this is
 * the one, sole mechanism by which a field's declared visibility becomes
 * an actual envelope mode, and it is the SAME mechanism for all three
 * shapes.
 *
 * `recipients` (optional, `visibility: 'encrypted'` only) NARROWS who this
 * ONE write is encrypted for, below the Space's own full member list -
 * `space.js`'s `_recipientXPubKeys()` stays the default whenever it's
 * omitted, unchanged from before this existed. This is what lets a
 * `'content'`-ACL Kind (self-owned - `pageKind`'s sibling
 * `privatePageKind` is the reference consumer, `kinds.js`'s own doc
 * comment) be shared with an arbitrary GROUP instead of every Space
 * member - a group is nothing more than a caller-resolved list of X25519
 * pubkeys (`@qu/app-core`'s `resolveGroup()`) handed down through
 * `Space.createNode()`/`editPage()`-shaped Dev API calls, all the way to
 * here. For `'atomic'`/`'list'` shapes, ALSO narrows the field's own
 * VALUE-level `encryptForRecipients()` call (defense in depth: the field's
 * own ciphertext is unreadable to a non-recipient even if they somehow
 * obtained the outer envelope's plaintext update bytes some other way);
 * `'text'` has no field-level encryption at all (this file's own doc
 * comment above) so `recipients` matters there ONLY at the envelope layer
 * - still fully sufficient, since the envelope is a text field's ONLY
 * confidentiality boundary regardless.
 *
 * `set()`/`push()`/text edits all accept an optional `{notify}` (atomic/
 * list only - see this file's own git history for why text never grew
 * this) - see envelope.js's own doc comment for what a `notify` hint IS
 * and why it exists. Validated here, the one place that actually has the
 * Kind-Schema in hand: `notify.topic` must be one of this Node's
 * `kindSchema.notifyTopics`, or the write throws BEFORE it ever reaches
 * Yjs/the network.
 */
import * as Y from 'yjs';
import { QuCrypto } from '@qu/core';

/**
 * `recipientXPubKeys` PLUS the sender's own key, always - defensively, the
 * SAME "never let a caller lock themselves out of their own just-written
 * data" reasoning `space.js`'s own `_effectiveRecipients()` applies at the
 * ENVELOPE layer (see that method's own doc comment) - a real bug this
 * exact duplication caught: a Kind-Schema-level default like
 * `this._ctx.recipientXPubKeys()` (the Space's full member list) already
 * includes the caller, but a NARROWED, explicit `recipients` list (e.g.
 * `createPrivatePage()`'s own `recipients = []` for "nobody but me") does
 * NOT self-include by construction - without this, the field's OWN
 * ciphertext would be unreadable even to its own owner, while the OUTER
 * envelope (already defended by `_effectiveRecipients()`) stayed readable
 * - an inconsistent, confusing half-fix. Local here (not imported from
 * space.js) - this file has no `Space` instance to call a method on, only
 * the plain `identity` object `_ctx` already carries.
 */
function includingSelf(recipientXPubKeys, selfXPub) {
  const selfB64 = QuCrypto.toBase64(selfXPub);
  if (recipientXPubKeys.some((xPub) => QuCrypto.toBase64(xPub) === selfB64)) return recipientXPubKeys;
  return [...recipientXPubKeys, selfXPub];
}

async function encryptForRecipients(plainValue, identity, recipientXPubKeys) {
  const bytes = new TextEncoder().encode(JSON.stringify(plainValue));
  const { iv, ct, to } = await QuCrypto.encrypt(bytes, includingSelf(recipientXPubKeys, identity.xPublicKey), identity.xPrivateKey);
  return { iv, ct, to, senderXPub: identity.xPublicKey };
}

/**
 * Validates `notify.topic` (if given) against this Node's Kind-Schema
 * allowlist, then runs `mutateFn` inside a `doc.transact()` call carrying
 * `{notify, visibility, recipients}` as the transaction's origin - see
 * this file's own top doc comment for why `visibility`/`recipients` ride
 * here too (it's how `Space._handleLocalUpdate()` picks the right envelope
 * mode/audience).
 * @param {Y.Doc} doc @param {() => void} mutateFn
 * @param {{notify?: {topic: string, to?: string[]}, visibility: 'encrypted'|'public', recipients?: Array<Uint8Array>}} writeContext
 * @param {object} kindSchema
 */
function withWriteContext(doc, mutateFn, { notify, visibility, recipients }, kindSchema) {
  if (notify) {
    const allowed = kindSchema?.notifyTopics ?? [];
    if (!allowed.includes(notify.topic)) {
      throw new Error(`field write: notify.topic "${notify.topic}" is not declared in Kind-Schema "${kindSchema?.kind}"'s notifyTopics (${allowed.length ? allowed.join(', ') : 'none declared'})`);
    }
  }
  doc.transact(mutateFn, { notify, visibility, recipients });
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

class AtomicField {
  constructor(contentMap, key, ctx, doc, visibility) {
    this._map = contentMap;
    this._key = key;
    this._ctx = ctx;
    this._doc = doc;
    this._visibility = visibility;
  }

  /** @param {*} value @param {{notify?: {topic: string, to?: string[]}, recipients?: Array<Uint8Array>}} [options] - see this file's own doc comment on `recipients`. */
  async set(value, { notify, recipients } = {}) {
    const stored = this._visibility === 'public' ? value : await encryptForRecipients(value, this._ctx.identity, recipients ?? this._ctx.recipientXPubKeys());
    withWriteContext(this._doc, () => this._map.set(this._key, stored), { notify, visibility: this._visibility, recipients }, this._ctx.kindSchema);
  }

  /** @returns {Promise<*|null|undefined>} `null` = unset. `undefined` = set, but (encrypted-visibility only) this identity is not a recipient. */
  async get() {
    if (this._visibility === 'public') return this._map.get(this._key) ?? null;
    return decryptEnvelopeFor(this._map.get(this._key), this._ctx.identity);
  }

  /** True the moment a value exists for this key, before any decryption is attempted. */
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
  constructor(contentMap, key, doc, visibility, kindSchema) {
    this._map = contentMap;
    this._key = key;
    this._doc = doc;
    this._visibility = visibility;
    this._kindSchema = kindSchema;
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

  /** @param {{recipients?: Array<Uint8Array>}} [options] - see this file's own top doc comment on `recipients` - text has no field-level encryption, so this affects only the envelope, which is a text field's ONLY confidentiality boundary. */
  insert(index, text, { recipients } = {}) {
    withWriteContext(this._doc, () => this.ytext.insert(index, text), { visibility: this._visibility, recipients }, this._kindSchema);
  }

  /** @param {{recipients?: Array<Uint8Array>}} [options] - see `insert()`'s own doc comment. */
  delete(index, length, { recipients } = {}) {
    withWriteContext(this._doc, () => this.ytext.delete(index, length), { visibility: this._visibility, recipients }, this._kindSchema);
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
  constructor(yarray, ctx, doc, visibility) {
    this._yarray = yarray;
    this._ctx = ctx;
    this._doc = doc;
    this._visibility = visibility;
  }

  /** @param {*} value @param {{notify?: {topic: string, to?: string[]}, recipients?: Array<Uint8Array>}} [options] - see this file's own doc comment on `recipients`. */
  async push(value, { notify, recipients } = {}) {
    const stored = this._visibility === 'public' ? value : await encryptForRecipients(value, this._ctx.identity, recipients ?? this._ctx.recipientXPubKeys());
    withWriteContext(this._doc, () => this._yarray.push([stored]), { notify, visibility: this._visibility, recipients }, this._ctx.kindSchema);
  }

  async toArray() {
    if (this._visibility === 'public') return this._yarray.toArray();
    return Promise.all(this._yarray.toArray().map((envelope) => decryptEnvelopeFor(envelope, this._ctx.identity)));
  }

  /**
   * Removes `length` entries starting at `index` - Yjs' own
   * `Y.Array.delete()`, CRDT-merged against a concurrent insert/remove
   * exactly like `TextField.delete()` already is for `Y.Text` (this file's
   * own top doc comment on `'list'`) - two peers removing DIFFERENT indices
   * at the same time never corrupt each other's edit the way a naive
   * "replace the whole array" last-write-wins field would. `index` is
   * this array's OWN index order, the same order `toArray()` returns -
   * find the entry to remove by reading `toArray()` first (this class has
   * no built-in "find by predicate," callers already need to decrypt
   * `'encrypted'`-visibility entries to compare them anyway, so a bespoke
   * search primitive here would just duplicate that same read).
   * @param {number} index @param {number} [length] @param {{recipients?: Array<Uint8Array>}} [options] - see this file's own top doc comment on `recipients`.
   */
  remove(index, length = 1, { recipients } = {}) {
    withWriteContext(this._doc, () => this._yarray.delete(index, length), { visibility: this._visibility, recipients }, this._ctx.kindSchema);
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
 * @param {{shape: 'atomic'|'text'|'list', visibility: 'encrypted'|'public'}} fieldDecl
 * @param {Y.Map} contentMap
 * @param {Y.Doc} doc
 * @param {string} name
 * @param {object} ctx - `{identity, recipientXPubKeys, kindSchema}`
 */
export function createField(fieldDecl, { contentMap, doc, name, ctx }) {
  const { shape, visibility } = fieldDecl;
  if (shape === 'atomic') return new AtomicField(contentMap, name, ctx, doc, visibility);
  if (shape === 'text') return new TextField(contentMap, name, doc, visibility, ctx.kindSchema);
  if (shape === 'list') return new ListField(doc.getArray(name), ctx, doc, visibility);
  throw new Error(`createField: unknown shape "${shape}"`);
}

/**
 * Writes a COMPLETE new value to `field`, regardless of its SHAPE - the
 * one thing an 'atomic' field's own `set()` and a 'text' field's own
 * `insert()`/`delete()` pair both ultimately mean ("this field's whole
 * value is now X"), but expose through two INCOMPATIBLE APIs (`TextField`
 * deliberately has no `set()` - collaborative text editing means Yjs needs
 * the actual insert/delete OPERATIONS, not a last-write-wins replace, this
 * file's own top doc comment on `'text'`). A caller that genuinely wants
 * "replace the whole thing" either way (an inline-edit UI committing a
 * fully-retyped value, a form's "cancel my draft, reload the real value"
 * reset) previously had to know which shape it was talking to and branch
 * itself - `@qu/app-core`'s `dev.js` has its own PRIVATE `replaceText()`
 * doing the identical "delete everything, then insert" logic for exactly
 * this reason, left as its own internal helper here rather than migrated
 * onto this one (13 already-working call sites, zero behavior change
 * needed there - not worth the churn/regression risk of a pure rename).
 * `setFieldValue()` exists for NEW/lower-layer consumers that don't
 * already have their own copy - `@qu/space-ui`'s `bindField()`/
 * `makeInlineEditable()` are the first, closing a REAL, previously-
 * unaddressed gap: `<qu-bind editable="inline">` calling a bare
 * `field.set()` would have thrown outright for ANY 'text'-shape field (a
 * Blog post's own `content`, e.g.) before this existed.
 * @param {*} field - whatever `createField()` above returned.
 * @param {string} value
 * @param {{recipients?: Array<Uint8Array>}} [options] - see this file's own top doc comment on `recipients` - passed through to whichever underlying write actually runs.
 */
export async function setFieldValue(field, value, options) {
  if (typeof field.set === 'function') {
    await field.set(value, options);
    return;
  }
  const current = field.get();
  if (current) field.delete(0, current.length, options);
  if (value) field.insert(0, value, options);
}
