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
 * relay should recognize as `appAdminPubs` - a STATIC, operator-decided
 * list at relay startup, the SAME posture `relay-server.js`'s own
 * `QU_MEMBERS_JSON` already takes (see that file's own doc comment).
 * Deliberately NOT auto-discovered from `relayAdminPub`'s own
 * `qu-platform-apps` registry at runtime: a relay that trusted whatever
 * pubkeys happen to be written there would need to re-verify write-ACL for
 * a BRAND NEW app-admin's Nodes the instant `qu-platform-apps` changes,
 * which - since `resolveKindSchema` is a plain synchronous function
 * (`relay.js` never awaits it) - would need this relay to itself run a
 * live, subscribed `Space` watching that registry, real, separate work.
 * Registering a genuinely new app-admin therefore still needs a relay
 * restart with an updated `appAdminPubs` list, exactly like adding a new
 * `'members'`-mode member already does today.
 */
import { deriveOwnerNodeId } from '@qu/space-core';
import {
  appManifestKind,
  routeRegistryKind,
  templateRegistryKind,
  styleRegistryKind,
  pageKind,
  platformAppsKind,
  adminAppManifestKind,
  adminPageKind,
  ADMIN_REALM_ANCHOR,
} from './kinds.js';

/** @param {{appAdminPub?: Uint8Array, appAdminPubs?: Uint8Array[], relayAdminPub?: Uint8Array}} params - `appAdminPub` (singular) is a convenience alias for `appAdminPubs: [appAdminPub]`. @returns {Promise<(nodeId: string) => object>} */
export async function createAppResolveKindSchema({ appAdminPub, appAdminPubs, relayAdminPub } = {}) {
  const owners = [...(appAdminPubs ?? []), ...(appAdminPub ? [appAdminPub] : [])];
  const manifestIds = new Set(await Promise.all(owners.map((pub) => deriveOwnerNodeId(pub, appManifestKind.kind))));
  const registryIds = new Set(await Promise.all(owners.map((pub) => deriveOwnerNodeId(pub, routeRegistryKind.kind))));
  const templateRegistryIds = new Set(await Promise.all(owners.map((pub) => deriveOwnerNodeId(pub, templateRegistryKind.kind))));
  const styleRegistryIds = new Set(await Promise.all(owners.map((pub) => deriveOwnerNodeId(pub, styleRegistryKind.kind))));
  const platformId = relayAdminPub ? await deriveOwnerNodeId(relayAdminPub, platformAppsKind.kind) : null;
  return (nodeId) => {
    if (manifestIds.has(nodeId)) return appManifestKind;
    if (registryIds.has(nodeId)) return routeRegistryKind;
    if (templateRegistryIds.has(nodeId)) return templateRegistryKind;
    if (styleRegistryIds.has(nodeId)) return styleRegistryKind;
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
