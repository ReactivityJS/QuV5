/**
 * ALIAS SPACE — the "dead drop" comfort helper: derives THIS real identity's
 * per-space pseudonym (`@qu/space-core`'s `publishAlias()` - that function's
 * own doc comment already calls its return value "ready to construct a
 * second Space with," this is simply that composition, packaged) and
 * bootstraps a SECOND, independent `Space` that signs as the alias instead
 * of the real identity - see `docs/routing-anonymity.md` for the full
 * design and threat model this answers.
 *
 * THE "DEAD DROP" MENTAL MODEL, precisely: the alias is NOT a keypair both
 * correspondents hold - only the REAL identity ever has the alias's PRIVATE
 * key (derived from the real private key, see `deriveAliasIdentity()`'s own
 * doc comment). A correspondent never needs it either - they interact with
 * the alias exactly like any other identity (read its `'owner'`-ACL Nodes,
 * receive its signed writes), the same way they'd interact with anyone
 * else's pubkey. What makes it a "mailbox with a hidden owner" rather than
 * just another identity is `AliasRegistry`: a registry entry, encrypted for
 * exactly this Space's current membership, mapping `aliasPub -> realPub` -
 * a fellow Space member who has it (via `AliasRegistry.resolve()`) learns
 * "this mailbox is really X"; the relay, which never holds a decryption
 * key, never can. THAT resolution happens entirely LOCALLY, client-side,
 * exactly the "wird lokal erst klar, welche Identität wirklich dahinter
 * steckt" behavior being asked for.
 *
 * SCOPE: this only covers SELF-CERTIFYING Kinds (`acl.write: 'owner'`/
 * `'named'`/`'content'`) - the alias identity can immediately create/write
 * its own such Nodes with zero relay-side setup, exactly like any other
 * identity (kind-schema.js's own doc comment on why). Writing ANONYMOUSLY
 * to a flat `acl.write: 'members'` Kind additionally requires the alias's
 * own pubkey to be registered as a Space member in the first place - HOW a
 * deployment's relay accepts new members (`@qu/app-shell`'s `joinSpace()`/
 * `POST /join`, or any other self-service join a different deployment
 * might use) is deployment-specific, not something this framework-core
 * package can generically wrap - see `docs/routing-anonymity.md`'s own
 * worked example for the `@qu/app-shell` recipe.
 */
import { publishAlias } from '@qu/space-core';
import { bootstrapSpace } from './bootstrap-space.js';

/**
 * @param {import('@qu/space-core').Space} realSpace - This peer's own, already-connected Space - its `identity` is what the alias is derived FROM (never sent anywhere - `deriveAliasIdentity()`'s own doc comment), and it's where the (encrypted, members-only) alias->real registry entry gets published.
 * @param {string} spaceId - Any stable string identifying the Space this alias is scoped to - same real identity + same spaceId always re-derives the SAME alias (stable across reloads, nothing extra to persist); a DIFFERENT spaceId yields a computationally unrelated keypair (see `deriveAliasIdentity()`'s own doc comment on why that's what makes aliases unlinkable ACROSS spaces).
 * @param {object} config - Everything `bootstrapSpace()` itself takes EXCEPT `identity` (always overridden with the derived alias - any `identity` passed here is ignored) - `transport`/`storage`/`members`/`registry`/etc., exactly as that function documents. Typically a SEPARATE transport connection from `realSpace`'s own (a genuinely independent `Space`, not a second identity multiplexed over the same connection).
 * @returns {Promise<{identity: object, transport: object, storage: object|undefined, volatileStorage: object|undefined, bus: object|null, space: import('@qu/space-core').Space}>} Same shape `bootstrapSpace()` itself returns - `identity` here is the ALIAS, not the real one.
 */
export async function bootstrapAliasSpace(realSpace, spaceId, config = {}) {
  const alias = await publishAlias(realSpace, spaceId);
  return bootstrapSpace({ ...config, identity: alias });
}
