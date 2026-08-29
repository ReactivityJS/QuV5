/**
 * KIND-SCHEMA — the V5 replacement for `@qu/services`' `EntityTypeRegistry`
 * (`packages/services/src/entity-types.js`), same shallow "static
 * composition record, not a persisted schema store" idea, rewritten against
 * fields that declare a Yjs shape directly instead of a generic JSON type:
 *
 *   'atomic-encrypted' - a single value, replaced wholesale on write,
 *                        stored as a QuCrypto-encrypted envelope (see
 *                        field.js). Right for anything without a
 *                        concurrent-character-editing need: a title, a
 *                        label, a chat message.
 *   'text'             - a Y.Text, edited character-by-character with real
 *                        CRDT merge. Plaintext necessarily exists locally
 *                        while a member is actively editing (see
 *                        field.js's doc comment) - encryption for this
 *                        field type happens one layer out, at the
 *                        transport/storage envelope (see envelope.js), not
 *                        on the field's value itself.
 *   'list'             - a top-level Y.Array of small encrypted items.
 *                        Concurrent appends from different peers converge
 *                        in a deterministic order via Yjs' own
 *                        relative-position CRDT - no bespoke cursor/`(ts,
 *                        rel)` pagination logic needed for the common,
 *                        realtime-shaped case (a thread's messages, a
 *                        channel's posts). Large historical pagination is
 *                        explicitly not solved here - see docs/v5-space-core-guide.md.
 *
 * `acl.write` names who may sign updates to a Node of this kind - kept
 * intentionally simple for the PoC ('members': every space member may
 * write). A real ACL (per-field read/write, role-based, ...) is later work,
 * not part of proving the sync/signing/encryption mechanism itself.
 */

const FIELD_TYPES = new Set(['atomic-encrypted', 'text', 'list']);

/**
 * @param {string} kind
 * @param {{fields: Record<string, 'atomic-encrypted'|'text'|'list'>, acl?: {write?: 'members'}}} def
 */
export function defineKind(kind, { fields, acl = { write: 'members' } }) {
  if (!kind || typeof kind !== 'string') throw new Error('defineKind: "kind" must be a non-empty string');
  for (const [name, type] of Object.entries(fields ?? {})) {
    if (!FIELD_TYPES.has(type)) {
      throw new Error(`defineKind("${kind}"): field "${name}" has unknown type "${type}" (expected ${[...FIELD_TYPES].join(' | ')})`);
    }
  }
  return Object.freeze({ kind, fields: Object.freeze({ ...fields }), acl: Object.freeze({ ...acl }) });
}

/** Small static registry, same public surface as EntityTypeRegistry (register/get/list) so the pattern stays familiar. */
export class KindRegistry {
  #kinds = new Map();

  register(kindSchema) {
    this.#kinds.set(kindSchema.kind, kindSchema);
    return this;
  }

  get(kind) {
    const schema = this.#kinds.get(kind);
    if (!schema) throw new Error(`KindRegistry: unknown kind "${kind}"`);
    return schema;
  }

  list() {
    return [...this.#kinds.values()];
  }
}
