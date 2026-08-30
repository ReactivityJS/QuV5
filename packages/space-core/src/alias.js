/**
 * SPACE-SCOPED ALIAS IDENTITIES — per-space pseudonymity: the SAME real
 * person can act under a Space-specific pseudonymous keypair that other
 * SPACE MEMBERS can resolve back to the real identity, but an outsider (a
 * relay included) cannot, without a new crypto dependency or any relay-
 * side support at all.
 *
 * THE ALIAS ITSELF (`deriveAliasIdentity()`): deterministically derived
 * from the real identity's own Ed25519 private key + a `spaceId` string,
 * via two independent, domain-separated SHA-256-as-KDF derivations (one
 * per curve - never reusing the same raw scalar for both, which would be
 * a red flag regardless of whether anything here actually depends on
 * that). Same real identity + same `spaceId` always yields the same
 * alias (so it's stable across sessions/reloads, no extra state to
 * persist) - but a DIFFERENT `spaceId` yields a computationally
 * unrelated keypair (no attacker who only knows one of a person's
 * per-space aliases can link it to another). The derivation input is the
 * real PRIVATE key, never anything public - deriving the alias requires
 * being that real identity, exactly the same trust boundary as making
 * any other signature with it.
 *
 * Once derived, an alias is simply a REAL, independent identity for every
 * purpose this framework already has: it can own `acl.write: 'owner'`
 * Nodes (self-certifying via `deriveOwnerNodeId()`, see kind-schema.js) -
 * a pseudonymous post/profile/anything - with ZERO relay-side awareness
 * that anything alias-shaped is happening; to the relay and to anyone who
 * hasn't resolved it, an alias-authored Node is indistinguishable from any
 * other independent identity's Node. This is deliberately why alias
 * identities are scoped to `'owner'`/`'named'` Kinds, not `'members'`-mode
 * ones: the latter's write-ACL is the relay's own flat membership list,
 * which would need new relay-side plumbing to extend per-alias - the
 * former needs none, the self-certifying nodeId already does all the work.
 *
 * RESOLVING alias -> real (`aliasRegistryKind`/`AliasRegistry`): the
 * mapping is published as an ordinary ENCRYPTED Node write (kind
 * `qu-space-alias-registry`, `acl.write: 'members'`, both fields
 * `visibility: 'encrypted'` - see kind-schema.js) - the SAME envelope
 * encryption every other confidential field in a Space already uses, sealed
 * for exactly that Space's current member list. A Space member who
 * subscribes to and decrypts a registry entry learns `{aliasPub, aliasXPub}`
 * for one real member; anyone who isn't a decryption recipient (an
 * outsider, or the relay, which never holds an X25519 private key at all -
 * see envelope.js) receives only sealed ciphertext, structurally unable to
 * open it. No new protocol layer, no new relay support, no new crypto
 * dependency - this is exactly the existing "space members can decrypt,
 * outsiders can't" guarantee this framework already provides for any
 * `'encrypted'`-visibility field, applied to one particular fact (a
 * pseudonym mapping) instead of app content.
 *
 * `AliasRegistry` is a small, OPT-IN watcher over a Space's own `bus` (see
 * `@qu/events`) - Space itself stays entirely unaware that "alias" is a
 * concept, exactly the "flexible hooks/watchers, not baked-in mechanism"
 * design this framework commits to elsewhere (see e.g. push-handler.js's
 * own doc comment on the same pattern for push routing).
 */
import { QuCrypto } from '@qu/core';
import { defineKind } from './kind-schema.js';

const ALIAS_SIGN_DOMAIN = 'qu-space-alias-sign-v1';
const ALIAS_X_DOMAIN = 'qu-space-alias-x-v1';
const REGISTRY_PREFIX = 'alias-registry:';

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

async function deriveScalar(identity, spaceId, domain) {
  const material = concatBytes(new TextEncoder().encode(`${domain}:${spaceId}:`), identity.signingKey);
  return QuCrypto.sha256(material);
}

/**
 * @param {object} identity - The REAL identity, `{signingKey, signingPub, xPrivateKey, xPublicKey}`.
 * @param {string} spaceId - Any stable string identifying the Space this alias is scoped to (e.g. a Space's own well-known root Node id) - the ONE thing that makes the SAME real identity's aliases unrelated across different Spaces.
 * @returns {Promise<{signingKey: Uint8Array, signingPub: Uint8Array, xPrivateKey: Uint8Array, xPublicKey: Uint8Array}>} A complete, independently usable identity - pass it straight to `new Space({identity: alias, ...})` or any function that takes an `identity`.
 */
export async function deriveAliasIdentity(identity, spaceId) {
  const [signScalar, xScalar] = await Promise.all([
    deriveScalar(identity, spaceId, ALIAS_SIGN_DOMAIN),
    deriveScalar(identity, spaceId, ALIAS_X_DOMAIN),
  ]);
  const ed = await QuCrypto.keypairFromSeed('Ed25519', signScalar);
  const x = await QuCrypto.keypairFromSeed('X25519', xScalar);
  return {
    signingKey: ed.privateKeyPkcs8,
    signingPub: ed.publicKey,
    xPrivateKey: x.privateKeyPkcs8,
    xPublicKey: x.publicKey,
  };
}

/** One per real member per Space - `{aliasPub, aliasXPub}`, both base64, both `'encrypted'` visibility (see this file's own doc comment). */
export const aliasRegistryKind = defineKind('qu-space-alias-registry', {
  fields: {
    aliasPub: { shape: 'atomic', visibility: 'encrypted' },
    aliasXPub: { shape: 'atomic', visibility: 'encrypted' },
  },
});

/**
 * Deterministic per-real-member registry Node id - never secret (a
 * Space's own membership list already tells the relay who every real
 * member is, in `'members'`-mode Kinds; this reveals nothing beyond that
 * a routing coordinate), only the CONTENT at this id is confidential.
 * @param {Uint8Array} realPub
 * @returns {string}
 */
export function aliasRegistryNodeId(realPub) {
  return REGISTRY_PREFIX + QuCrypto.toBase64Url(realPub);
}

function realPubB64FromRegistryNodeId(nodeId) {
  return QuCrypto.toBase64(QuCrypto.fromBase64Url(nodeId.slice(REGISTRY_PREFIX.length)));
}

/**
 * Derives this Space's alias for `spaceId` and publishes it to the
 * per-member registry Node (creating it on first call, updating it on any
 * later call - e.g. after a deliberate identity rotation is out of scope
 * here, but overwriting is harmless: the derivation is deterministic, so
 * re-publishing the same `spaceId` is always a no-op in practice).
 * @param {import('./space.js').Space} space
 * @param {string} spaceId
 * @returns {Promise<{signingKey, signingPub, xPrivateKey, xPublicKey}>} the derived alias identity, ready to construct a second `Space` with.
 */
export async function publishAlias(space, spaceId) {
  const alias = await deriveAliasIdentity(space.identity, spaceId);
  const nodeId = aliasRegistryNodeId(space.identity.signingPub);
  const node = space.getNode(nodeId) ?? (await space.createNode(aliasRegistryKind, {}, { id: nodeId }));
  await node.field('aliasPub').set(QuCrypto.toBase64(alias.signingPub));
  await node.field('aliasXPub').set(QuCrypto.toBase64(alias.xPublicKey));
  return alias;
}

/**
 * Watches a Space's `bus` for accepted writes to ANY subscribed alias-
 * registry Node and maintains an in-memory `aliasPubB64 -> realPubB64`
 * map from them - purely additive, no effect on the Space itself (see this
 * file's own top doc comment on why this lives outside `Space`). A given
 * alias only resolves once this Space has actually subscribed to (and can
 * decrypt) that specific member's registry Node - e.g. via
 * `space.subscribeNode(aliasRegistryNodeId(memberPub), aliasRegistryKind)`
 * or `space.useNode(...)` for each member whose alias you want to be able
 * to resolve. Not being able to resolve an alias is indistinguishable from
 * "not a Space member" - by design, that IS the confidentiality guarantee.
 */
export class AliasRegistry {
  /** @param {import('./space.js').Space} space @param {import('@qu/events').EventBus} bus - the SAME bus given to `space`'s own constructor. */
  constructor(space, bus) {
    this._space = space;
    this._map = new Map(); // aliasPubB64 -> realPubB64
    bus.on('space.node.*.changed', (payload) => {
      if (payload.kind === aliasRegistryKind.kind) this._absorb(payload.nodeId);
    });
  }

  async _absorb(nodeId) {
    const node = this._space.getNode(nodeId);
    if (!node) return;
    const aliasPubB64 = await node.field('aliasPub').get();
    if (!aliasPubB64) return; // not yet written, or (shouldn't happen here - registry entries are 'members'-mode encrypted-for-this-space) not a recipient.
    this._map.set(aliasPubB64, realPubB64FromRegistryNodeId(nodeId));
  }

  /** @param {string} aliasPubB64 @returns {string|undefined} the real member's base64 Ed25519 pubkey, or `undefined` if this alias hasn't resolved (not yet subscribed/decrypted, or genuinely unknown to this Space). */
  resolve(aliasPubB64) {
    return this._map.get(aliasPubB64);
  }
}
