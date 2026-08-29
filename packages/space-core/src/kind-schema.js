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
 *
 * `notifyTopics` (optional) is the closed vocabulary of notification hints
 * a write to a Node of this kind may attach (see envelope.js's `notify`
 * param on `sealUpdate()`, and field.js's `set()`/`push()` `{notify}`
 * option). Deliberately a fixed list, not a free-form string a writer can
 * invent on the spot: the relay routes push notifications off this hint
 * WITHOUT ever decrypting the write it's attached to (see relay.js's own
 * doc comment on why it structurally can't), so the hint is the one piece
 * of routing information the relay trusts at face value, straight from
 * whoever signed the envelope. Bounding it to a per-Kind allowlist doesn't
 * stop a malicious member from mislabeling their OWN write (same trust
 * model as any self-reported metadata), but it does stop "chat.mention"
 * silently typo'd as "chat.mentoin" from just vanishing into an unmatched
 * topic string with zero feedback, and keeps the topic namespace a Kind
 * actually emits documented in exactly one place. Omit entirely for a Kind
 * that never attaches notify hints (the default) - `notify` is then
 * rejected outright, not silently dropped.
 */

const FIELD_TYPES = new Set(['atomic-encrypted', 'text', 'list']);

/**
 * @param {string} kind
 * @param {{fields: Record<string, 'atomic-encrypted'|'text'|'list'>, acl?: {write?: 'members'}, notifyTopics?: string[]}} def
 */
export function defineKind(kind, { fields, acl = { write: 'members' }, notifyTopics = [] }) {
  if (!kind || typeof kind !== 'string') throw new Error('defineKind: "kind" must be a non-empty string');
  for (const [name, type] of Object.entries(fields ?? {})) {
    if (!FIELD_TYPES.has(type)) {
      throw new Error(`defineKind("${kind}"): field "${name}" has unknown type "${type}" (expected ${[...FIELD_TYPES].join(' | ')})`);
    }
  }
  if (!Array.isArray(notifyTopics) || notifyTopics.some((t) => typeof t !== 'string' || !t)) {
    throw new Error(`defineKind("${kind}"): "notifyTopics" must be an array of non-empty strings`);
  }
  return Object.freeze({ kind, fields: Object.freeze({ ...fields }), acl: Object.freeze({ ...acl }), notifyTopics: Object.freeze([...notifyTopics]) });
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
