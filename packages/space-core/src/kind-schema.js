/**
 * KIND-SCHEMA — the V5 replacement for `@qu/services`' `EntityTypeRegistry`
 * (`packages/services/src/entity-types.js`), same shallow "static
 * composition record, not a persisted schema store" idea, rewritten against
 * fields that declare a Yjs shape directly instead of a generic JSON type.
 *
 * Each field declares TWO INDEPENDENT properties, deliberately kept apart
 * rather than folded into one type string (a real, live design mistake this
 * schema went through once already - see git history/conversation for "why
 * not just a field type string"):
 *
 *   `shape` - the LOCAL CRDT structure: `'atomic'` (a single value, replaced
 *     wholesale on write), `'text'` (a real Y.Text, edited character-by-
 *     character), or `'list'` (a top-level Y.Array, concurrent appends
 *     converge via Yjs' own relative-position CRDT - no bespoke cursor
 *     logic needed). Matters ONLY to whichever peer is reading/writing that
 *     field right now (see field.js/node.js) - it never appears on the
 *     wire, never needs to be known by a relay or storage adapter. A raw
 *     Yjs update is just bytes to everything downstream of the peer that
 *     produced it, regardless of which shape produced it.
 *
 *   `visibility` - which ENVELOPE MODE a write to this field seals with
 *     (see envelope.js's "ENVELOPE v2" doc comment): `'encrypted'`
 *     (default-safe; QuCrypto.encrypt for `'atomic'`, field-level
 *     encryption too - see field.js; for `'text'`/`'list'`, confidentiality
 *     lives at the envelope layer only, same as before this existed) or
 *     `'public'` (no encryption at ANY layer - field-level OR transport -
 *     the value is plaintext for anyone, relay included, by design). This
 *     DOES matter on the wire: it decides whether a write seals via
 *     `sealUpdate()` or `sealPublicUpdate()` - but it is read ONCE, by the
 *     writer, from this schema (see field.js) and stamped directly onto
 *     the envelope's own `mode` - nothing downstream ever needs to
 *     re-consult this schema to know it.
 *
 * `'public'` visibility exists for exactly one real case so far: an
 * identity/profile Node (`acl.write: 'owner'`, see below) whose `pub`/
 * `epub` fields must be discoverable by someone who has never shared a
 * Space with the owner before - there IS no membership list to encrypt
 * for at that point. `'atomic'`+`'public'` skips field-level encryption
 * entirely (the raw value sits in the Y.Map, not a QuCrypto envelope) -
 * anything else would defeat the point of "public." Mixing `'public'` and
 * `'encrypted'` fields in the SAME Kind is fine and expected (e.g. a
 * profile's `pub`/`epub` public, `bio`/`age` encrypted) - each field write
 * is its own Yjs transaction/envelope already (see field.js), so there is
 * no "half-public, half-encrypted envelope" problem to solve.
 *
 * `acl.write` names who may sign updates to a Node of this kind:
 *   - `'members'` - every space member may write (the original, still-
 *     simplest mode - genuinely flat/shared write access, no single owner;
 *     see `'relay-admins'` further below for the RELAY-WIDE counterpart of
 *     this same idea, used by the built-in admin app's own content).
 *   - `'owner'` - only the pubkey the Node's own `nodeId` cryptographically
 *     commits to may write (see `deriveOwnerNodeId()` below) - a
 *     self-certifying "~pub" identity/user-space, verifiable with ZERO
 *     relay-side state: the check is a pure function of `(nodeId,
 *     envelope.pub)`, nothing to bootstrap, no race between "who wrote
 *     first." ONE Node per owner per Kind - see `'content'` below for many.
 *   - `'named'` - the owner (same self-certifying `nodeId` as `'owner'`)
 *     PLUS anyone the owner has explicitly authorized via a signed `grant`
 *     control message (see `@qu/space-transport`'s relay.js and
 *     `Space.grantWriter()`) - state the relay/a Space hold is 100%
 *     derived from signed messages they already verified, never invented.
 *   - `'content'` - `'named'`'s MANY-PER-OWNER counterpart: real, per-Node,
 *     grant-derived write-ACL (owner + explicit grantees, exactly like
 *     `'named'`) for a Kind that has many Nodes per owner (a page per
 *     route, a template per name, ...) instead of one. `Space.createNode()`
 *     requires a `{path}` option for this mode and derives the id itself
 *     via `deriveContentNodeId(callerPub, kind, path)` (below) - a pure,
 *     self-certifying function of `(ownerPub, kind, path)`, the SAME idea
 *     `deriveOwnerNodeId()` already gives `'owner'`/`'named'`, just with an
 *     extra `path` component so many Nodes fit under one owner. Unlike
 *     `'named'`, there is no owner-pubkey SHORTCUT in the write-ACL check
 *     (an id alone cannot be inverted back to its `path`) - `createNode()`
 *     issues the creating owner a SELF-grant transparently, before any
 *     field write, so ordinary callers (`@qu/app-core`'s `createPage()`/
 *     `createTemplate()`/`createStyle()`) need no code of their own beyond
 *     passing `path` - see `grant.js`'s own doc comment for the exact
 *     mechanics, and space.js's `createNode()`. THIS is the general,
 *     Kind-agnostic "who may edit THIS specific page/event/post" primitive
 *     any many-per-owner content Kind wants - chat, calendar, forum, and
 *     CMS content alike, not something reinvented per app.
 *   - `'relay-admins'` - a FLAT, symmetric list of writers, exactly like
 *     `'members'`, but checked against a list a `Space`/relay is
 *     constructed with SEPARATELY from ordinary Space membership (a new
 *     `relayAdmins` constructor param on both - see space.js's
 *     `_isAuthorizedWriter()` and `@qu/space-transport`'s relay.js
 *     `buildWriteAcl()`), never against `members`/`QU_ALLOW_JOIN`-style
 *     self-registration. Exists for content that must (a) live in an
 *     OPEN-JOIN Space (so ordinary visitors can read it with zero
 *     membership - `'members'`-ACL there would let ANY self-joined visitor
 *     write it too, which is never wanted) and (b) be writable by SEVERAL
 *     co-equal, boot-time-configured admin identities with no single
 *     "owner" and no manual per-admin `grantWriter()` dance (unlike
 *     `'named'`, which needs one real keypair as the self-certifying
 *     "owner" before anyone else can be granted, and the OWNER's own
 *     private key to sign each grant - something a relay operator's config
 *     alone can never do). `@qu/app-core`'s `platformAppsKind` (the
 *     relay-admin-managed app registry) is the reference use - see that
 *     file's own doc comment. A Node id under this mode carries no
 *     ownership meaning at all (any fixed, precomputable value works, e.g.
 *     `deriveOwnerNodeId(SOME_FIXED_ANCHOR, kind)`) since authorization
 *     never depends on it, only on the signer's pubkey being in the
 *     configured list.
 * A Node's meta-stamp (see node.js's `stampMeta()`) follows `'public'`
 * visibility automatically when `acl.write === 'owner'`/`'named'` (an
 * identity Node's own existence/kind should be as discoverable as its
 * public fields), `'encrypted'` otherwise (`'members'`/`'content'`) -
 * matches the pre-existing behavior for `'members'`-mode Kinds exactly; a
 * Kind that wants many-per-owner content to ALSO be publicly discoverable
 * overrides `metaVisibility` itself (see `@qu/app-core`'s `kinds.js`
 * `publicMeta()` for why/how - unchanged by `'content'` mode's addition).
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
 *
 * `persistence` (optional, default `'durable'`) says WHICH storage tier a
 * write to a Node of this Kind mirrors/hydrates through - `'durable'` keeps
 * using whatever adapter a `Space`/relay was configured with (unchanged
 * from before this existed), `'volatile'` routes it to a SEPARATE,
 * memory-only adapter instead (see space.js's `_storageFor()` and
 * `@qu/space-transport`'s relay.js "PERSISTENCE TIERS" doc comment) - never
 * to disk, gone the moment the process holding it exits. This is the same
 * "the storage adapter decides durability" idea `@qu/space-storage`'s own
 * memory/durable/file adapters already embody at the whole-space level,
 * now selectable PER KIND: a Kind whose data is inherently short-lived and
 * high-churn (a presence/typing signal, see `presence.js`) declares
 * `persistence: 'volatile'` and gets that behavior through the EXACT SAME
 * write/subscribe/mirror code path every other Kind uses - never a
 * bespoke protocol message, never something the transport layer treats
 * differently. A caller who wants even DURABLE Kinds to only last as long
 * as, say, a browser tab does so by handing `Space` a `sessionStorage`-
 * backed adapter as `storage` itself - this flag is about which of a
 * caller's OWN two adapters a Kind uses, not a hardcoded lifetime.
 */
import { QuCrypto } from '@qu/core';

const SHAPES = new Set(['atomic', 'text', 'list']);
const VISIBILITIES = new Set(['encrypted', 'public']);
const ACL_MODES = new Set(['members', 'owner', 'named', 'content', 'relay-admins']);
const PERSISTENCE_MODES = new Set(['durable', 'volatile']);

/** Prefix for a self-certifying owner/named Node id - see `deriveOwnerNodeId()`. Deliberately the same "~" convention Qu's earlier path-based identity Nodes used. */
const OWNER_NODE_PREFIX = '~';
/** Prefix for a self-certifying, many-per-owner `'content'`-ACL Node id - see `deriveContentNodeId()`. */
const CONTENT_NODE_PREFIX = '~content:';

/**
 * @param {string} kind
 * @param {{fields: Record<string, {shape: 'atomic'|'text'|'list', visibility?: 'encrypted'|'public'}>, acl?: {write?: 'members'|'owner'|'named'|'content'}, notifyTopics?: string[], persistence?: 'durable'|'volatile'}} def
 */
export function defineKind(kind, { fields, acl = { write: 'members' }, notifyTopics = [], persistence = 'durable' }) {
  if (!kind || typeof kind !== 'string') throw new Error('defineKind: "kind" must be a non-empty string');
  if (!PERSISTENCE_MODES.has(persistence)) {
    throw new Error(`defineKind("${kind}"): persistence must be one of ${[...PERSISTENCE_MODES].join(' | ')}, got "${persistence}"`);
  }

  const normalizedFields = {};
  for (const [name, decl] of Object.entries(fields ?? {})) {
    if (!decl || typeof decl !== 'object' || Array.isArray(decl)) {
      throw new Error(`defineKind("${kind}"): field "${name}" must be declared as {shape, visibility?}, got ${JSON.stringify(decl)}`);
    }
    const { shape, visibility = 'encrypted' } = decl;
    if (!SHAPES.has(shape)) {
      throw new Error(`defineKind("${kind}"): field "${name}" has unknown shape "${shape}" (expected ${[...SHAPES].join(' | ')})`);
    }
    if (!VISIBILITIES.has(visibility)) {
      throw new Error(`defineKind("${kind}"): field "${name}" has unknown visibility "${visibility}" (expected ${[...VISIBILITIES].join(' | ')})`);
    }
    normalizedFields[name] = Object.freeze({ shape, visibility });
  }

  if (!ACL_MODES.has(acl?.write)) {
    throw new Error(`defineKind("${kind}"): acl.write must be one of ${[...ACL_MODES].join(' | ')}, got "${acl?.write}"`);
  }
  if (!Array.isArray(notifyTopics) || notifyTopics.some((t) => typeof t !== 'string' || !t)) {
    throw new Error(`defineKind("${kind}"): "notifyTopics" must be an array of non-empty strings`);
  }

  return Object.freeze({
    kind,
    fields: Object.freeze(normalizedFields),
    acl: Object.freeze({ ...acl }),
    notifyTopics: Object.freeze([...notifyTopics]),
    persistence,
    // A 'members'/'content'/'relay-admins'-Kind Node's meta stays 'encrypted' (pre-existing
    // behavior for 'members', unchanged; 'content' and 'relay-admins' follow it since neither is a
    // self-certifying identity Node either); an 'owner'/'named' identity Node's meta is 'public'
    // automatically - see this file's own doc comment. A Kind that wants 'relay-admins' content to
    // ALSO be publicly readable (the common case - e.g. `platformAppsKind`) overrides
    // `metaVisibility` itself, same as `@qu/app-core`'s `publicMeta()` already does for `'content'`.
    metaVisibility: acl.write === 'members' || acl.write === 'content' || acl.write === 'relay-admins' ? 'encrypted' : 'public',
  });
}

/**
 * Derives the self-certifying `nodeId` for an `acl.write: 'owner'|'named'`
 * Kind - see this file's own doc comment. Pure function of `(ownerPub,
 * kind)`: no registry, no relay round-trip, no race between two peers
 * both trying to be "first" for the same id - verifying a write is just
 * `nodeId === deriveOwnerNodeId(envelope.pub, kindSchema.kind)`.
 * @param {Uint8Array} ownerPub - The owner's Ed25519 signing public key.
 * @param {string} kind
 * @returns {Promise<string>}
 */
export async function deriveOwnerNodeId(ownerPub, kind) {
  const digest = await QuCrypto.sha256(new TextEncoder().encode(`${kind}:${QuCrypto.toBase64(ownerPub)}`));
  return OWNER_NODE_PREFIX + QuCrypto.toBase64Url(digest);
}

/**
 * Derives the self-certifying `nodeId` for an `acl.write: 'content'` Kind's
 * ONE Node at `path` - `deriveOwnerNodeId()`'s many-per-owner counterpart
 * (see this file's own doc comment on the `'content'` ACL mode). Pure
 * function of `(ownerPub, kind, path)` - anyone who knows an owner's pubkey
 * and a content path (a route, a template name, ...) can compute the exact
 * Node id without asking anything "where is X." Verifying a write still
 * needs a GRANT too (see `grant.js`) - unlike `deriveOwnerNodeId()`, this
 * alone does not prove authorization, only IDENTIFIES the Node; `path`
 * cannot be recovered from `nodeId` alone, so there is no owner-pubkey
 * shortcut in the write-ACL check the way `'owner'`/`'named'` get one.
 * @param {Uint8Array} ownerPub
 * @param {string} kind
 * @param {string} path - Any stable string identifying this one piece of content within `kind`.
 * @returns {Promise<string>}
 */
export async function deriveContentNodeId(ownerPub, kind, path) {
  if (!path || typeof path !== 'string') throw new Error('deriveContentNodeId: "path" must be a non-empty string');
  const digest = await QuCrypto.sha256(new TextEncoder().encode(`${kind}:${QuCrypto.toBase64(ownerPub)}:${path}`));
  return CONTENT_NODE_PREFIX + QuCrypto.toBase64Url(digest);
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
