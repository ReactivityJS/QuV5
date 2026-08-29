/**
 * NODE — the V5 replacement for QuBit. One Y.Doc per Node, holding a
 * `meta` map (kind, owner, timestamps - the bookkeeping QuBit's `{ts, pub}`
 * used to carry) and a `content` map whose shape comes entirely from the
 * Node's Kind-Schema (see kind-schema.js). Unlike QuBit, a Node is not one
 * flat value - it is a small structured container, so metadata (label,
 * icon, ...) and content live together as one addressable, syncable,
 * ACL'd unit instead of needing a side-channel.
 */
import * as Y from 'yjs';
import { createField } from './field.js';

export class SpaceNode {
  /**
   * @param {{id: string, kindSchema: object, doc: Y.Doc, identity: object, recipientXPubKeys: () => Array<Uint8Array>}} params
   */
  constructor({ id, kindSchema, doc, identity, recipientXPubKeys }) {
    this.id = id;
    this.kind = kindSchema.kind;
    this.kindSchema = kindSchema;
    this.doc = doc;
    this._identity = identity;
    this._recipientXPubKeys = recipientXPubKeys;
    this._fields = new Map();
  }

  get meta() {
    return this.doc.getMap('meta');
  }

  /**
   * @param {string} name - Must be declared in this Node's Kind-Schema.
   * @returns {import('./field.js').AtomicEncryptedField|import('./field.js').TextField|import('./field.js').ListField}
   */
  field(name) {
    const type = this.kindSchema.fields[name];
    if (!type) throw new Error(`SpaceNode(${this.kind}).field: "${name}" is not declared in this Kind-Schema`);
    if (!this._fields.has(name)) {
      this._fields.set(
        name,
        createField(type, {
          contentMap: this.doc.getMap('content'),
          doc: this.doc,
          name,
          ctx: { identity: this._identity, recipientXPubKeys: this._recipientXPubKeys },
        })
      );
    }
    return this._fields.get(name);
  }

  /** Every Kind-Schema field name that is `'atomic-encrypted'` or `'text'` (the two `content` map keys). Excludes `'list'` fields, which live as their own top-level Y.Array, not inside `content`. */
  fieldNames() {
    return Object.entries(this.kindSchema.fields)
      .filter(([, type]) => type !== 'list')
      .map(([name]) => name);
  }

  destroy() {
    this.doc.destroy();
  }
}

/**
 * Stamps a brand-new Node's meta fields. Deliberately NOT bundled into a
 * single "create the doc" helper: the very first mutation on a Node's
 * Y.Doc must happen AFTER `doc.on('update', ...)` is already registered
 * (see Space._attach()) - Yjs updates from one client form a strict
 * per-client clock sequence, so if the FIRST update (clock 0..n) is ever
 * produced without a listener attached to capture/broadcast it, every
 * later update from that same doc references a "missing" dependency a
 * fresh peer's replica can never resolve, and silently sits unintegrated
 * forever (confirmed by hand while building this PoC - see the git history
 * for the exact symptom: content staying `{}` with no error anywhere).
 * `Space.createNode()` calls this AFTER `_attach()`, never before.
 */
export function stampMeta(doc, kindSchema, ownerPub) {
  // One doc.transact() so meta AND every 'text' field's placeholder become
  // a SINGLE atomic Yjs update (one signed envelope) - a Node's creation
  // is one atomic fact, not an observable partial state.
  doc.transact(() => {
    const meta = doc.getMap('meta');
    meta.set('kind', kindSchema.kind);
    meta.set('ownerPub', ownerPub);
    meta.set('ts', Date.now());

    // Pre-create every 'text' field's underlying Y.Text HERE, as part of
    // Node creation, so the CREATOR is always the one who originates that
    // Y.Map key - never a later reader. field.js's TextField deliberately
    // never auto-creates on access: if a subscribing peer read a
    // not-yet-synced text field before this arrived and created its OWN
    // competing Y.Text for the same key, Yjs' per-key conflict resolution
    // would silently orphan one of the two instances, and a field handle
    // that had already cached the orphaned one would keep reading/writing
    // a detached object forever - a real bug hit while building this PoC.
    const content = doc.getMap('content');
    for (const [name, type] of Object.entries(kindSchema.fields)) {
      if (type === 'text') content.set(name, new Y.Text());
    }
  });
}
