/**
 * RELAY KIND RESOLVER — builds the `resolveKindSchema(nodeId)` function
 * `@qu/space-transport`'s `createRelayForwarder()` needs to enforce
 * per-Kind ACL (see relay.js's own doc comment on why an unresolvable
 * nodeId can only ever fall back to flat `'members'` ACL - the same
 * documented gap `relay-server.js`'s own `resolveKindSchema: () => true`
 * accepts).
 *
 * `qu-app`/`qu-route-registry`/`qu-template-registry`/`qu-style-registry`
 * (per app-admin) and `qu-platform-apps` (per relay-admin) need to be told
 * apart individually - they're the SELF-CERTIFYING (`'owner'`/`'named'`)
 * singletons (see kinds.js), and their ids are precomputable from an
 * owner's pubkey alone, with no `path` involved (`deriveOwnerNodeId`).
 * Every content-addressed Kind (`qu-page`/`qu-template`/`qu-style`) shares
 * the EXACT SAME `acl`/`persistence` shape (`'content'`, durable)
 * regardless of WHICH app-admin owns it - the relay only ever consults
 * those two properties (`buildWriteAcl()`/`storageFor()`), never the field
 * list - so any one of them stands in for all three here; `pageKind` is
 * used arbitrarily. Getting a registry Kind's id WRONG here is not
 * cosmetic: `qu-template-registry`/`qu-style-registry` are `'named'`-ACL
 * (owner-shortcut, no grant needed - `dev.js`'s `registerContentName()`
 * relies on this), but the fallback below is `'content'`-ACL (grant-only,
 * no shortcut - kind-schema.js's own doc comment) - misclassifying one as
 * the other would make `createTemplate()`'s own registry write silently
 * rejected by the relay even though the CLIENT (which resolves the SAME
 * Kind correctly, see kinds.js) never sent a grant for it, having no
 * reason to expect it'd need one.
 *
 * MULTIPLE APPS (a platform, docs §19-21): pass every app-admin pubkey the
 * relay should recognize as `appAdminPubs`. This function alone always
 * takes a STATIC, caller-supplied list - see this file's own
 * `createLiveAppResolveKindSchema()`-style callers (e.g.
 * `@qu/app-shell`'s `live-app-resolver.js`) for a REACTIVE wrapper that
 * keeps calling this function again as `qu-platform-apps` (now a
 * `'relay-admins'`-ACL registry ANY configured relay-admin may write, see
 * kinds.js's own doc comment) changes at runtime, with no relay restart
 * needed to onboard a new app-admin - this function itself stays a small,
 * pure, synchronous-result builder either way.
 *
 * `qu-platform-apps` itself needs NO caller-supplied pubkey to classify
 * any more (a real, deliberate change from an earlier revision that took a
 * `relayAdminPub` here): its id is now `PLATFORM_REGISTRY_ANCHOR`-derived,
 * a FIXED constant every deployment shares (kinds.js's own doc comment) -
 * `platformId` below is therefore always computed, never conditional.
 *
 * COLLECTIONS (`kinds.js`'s `defineCollectionKind()`): an item Kind needs
 * NO entry here at all - it shares `pageKind`'s exact `acl`/`persistence`
 * shape (`'content'`, durable), so the fallback below already classifies
 * it correctly, same as `qu-template`/`qu-style` themselves. A
 * Collection's own REGISTRY Kind is the one piece that DOES need
 * telling apart, for the SAME reason `qu-template-registry`/
 * `qu-style-registry` do (this file's own opening paragraph) - pass every
 * Collection's `registryKind` (from `defineCollectionKind()`'s own return
 * value) via `collectionRegistryKinds`, or its enumeration writes
 * (`dev.js`'s `createCollectionItem()`) get silently rejected exactly
 * like a misclassified `qu-template-registry` would.
 */
import { deriveOwnerNodeId } from '@qu/space-core';
import {
  appManifestKind,
  routeRegistryKind,
  templateRegistryKind,
  styleRegistryKind,
  pageKind,
  platformAppsKind,
  PLATFORM_REGISTRY_ANCHOR,
  adminAppManifestKind,
  adminPageKind,
  ADMIN_REALM_ANCHOR,
} from './kinds.js';

/** @param {{appAdminPub?: Uint8Array, appAdminPubs?: Uint8Array[], collectionRegistryKinds?: object[]}} params - `appAdminPub` (singular) is a convenience alias for `appAdminPubs: [appAdminPub]`. `collectionRegistryKinds` - every Collection's `registryKind` this relay should recognize (see this file's own top doc comment on "COLLECTIONS") - each is checked against every configured owner. @returns {Promise<(nodeId: string) => object>} */
export async function createAppResolveKindSchema({ appAdminPub, appAdminPubs, collectionRegistryKinds = [] } = {}) {
  const owners = [...(appAdminPubs ?? []), ...(appAdminPub ? [appAdminPub] : [])];
  const manifestIds = new Set(await Promise.all(owners.map((pub) => deriveOwnerNodeId(pub, appManifestKind.kind))));
  const registryIds = new Set(await Promise.all(owners.map((pub) => deriveOwnerNodeId(pub, routeRegistryKind.kind))));
  const templateRegistryIds = new Set(await Promise.all(owners.map((pub) => deriveOwnerNodeId(pub, templateRegistryKind.kind))));
  const styleRegistryIds = new Set(await Promise.all(owners.map((pub) => deriveOwnerNodeId(pub, styleRegistryKind.kind))));
  const platformId = await deriveOwnerNodeId(PLATFORM_REGISTRY_ANCHOR, platformAppsKind.kind);

  const collectionRegistryById = new Map();
  for (const registryKind of collectionRegistryKinds) {
    for (const pub of owners) {
      collectionRegistryById.set(await deriveOwnerNodeId(pub, registryKind.kind), registryKind);
    }
  }

  return (nodeId) => {
    if (manifestIds.has(nodeId)) return appManifestKind;
    if (registryIds.has(nodeId)) return routeRegistryKind;
    if (templateRegistryIds.has(nodeId)) return templateRegistryKind;
    if (styleRegistryIds.has(nodeId)) return styleRegistryKind;
    if (collectionRegistryById.has(nodeId)) return collectionRegistryById.get(nodeId);
    if (nodeId === platformId) return platformAppsKind;
    return pageKind;
  };
}

/**
 * THE ADMIN REALM'S OWN `resolveKindSchema` - for the SEPARATE relay-
 * forwarder instance that serves it (see `packages/app-shell/relay-server.js`'s
 * own "ADMIN REALM" doc comment), never the main one above: this realm has
 * no per-owner disambiguation to do at all (there is exactly one admin
 * realm, anchored on the fixed `ADMIN_REALM_ANCHOR` - kinds.js's own "THE
 * ADMIN REALM" doc comment), so the only real branch is "the one manifest
 * id" vs. "everything else" - same "any one Kind stands in for the rest,
 * the relay only ever consults `acl`/`persistence`" reasoning
 * `createAppResolveKindSchema()` above already documents for `pageKind`.
 * @returns {Promise<(nodeId: string) => object>}
 */
export async function createAdminResolveKindSchema() {
  const manifestId = await deriveOwnerNodeId(ADMIN_REALM_ANCHOR, adminAppManifestKind.kind);
  return (nodeId) => (nodeId === manifestId ? adminAppManifestKind : adminPageKind);
}
