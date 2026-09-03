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
 *
 * THE ADMIN APP (architecture.md §7's "One relay Space, not two"): lives in
 * this SAME main Space now, not a separate confidential relay-forwarder -
 * `adminAppManifestKind`/`adminPageKind`/`adminTemplateKind`/
 * `adminStyleKind` are `acl.write: 'relay-admins'` (a DIFFERENT mode from
 * `pageKind`'s `'content'` fallback below, so they genuinely need their own
 * classification, unlike Collections above) anchored on the fixed
 * `ADMIN_REALM_ANCHOR` (kinds.js's own "THE ADMIN APP" doc comment) - since
 * all four share that SAME `acl`/`persistence` shape, telling them apart
 * from EACH OTHER is only for correctness of the returned Kind-Schema
 * object's OWN field list, never required for the ACL/persistence check
 * itself. The manifest id is precomputable with no extra input
 * (`deriveOwnerNodeId(ADMIN_REALM_ANCHOR, ...)`, a singleton); PAGES/
 * TEMPLATES/STYLES are content-addressed by NAME
 * (`deriveContentNodeId(ADMIN_REALM_ANCHOR, kind, name)`), so their names
 * must be told to this function - `adminTemplateNames`/`adminPageRoutes`/
 * `adminStyleNames` default to exactly what the built-in
 * `admin-console-bundle.js` ships (one template `"main"`, one page `"/"`,
 * no style) - pass your own if a deployment's admin console grows beyond
 * that reference bundle. (Dynamic, registry-driven admin-content discovery
 * - the same live-reactive idea `qu-platform-apps` now uses for app-admins
 * - is real, separate future work; the admin console's own content stays a
 * small, fixed, known set for now, same scope boundary this design already
 * documents elsewhere.)
 */
import { deriveOwnerNodeId } from '@qu/space-core';
import { deriveContentNodeId } from './content-id.js';
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
  adminTemplateKind,
  adminStyleKind,
  ADMIN_REALM_ANCHOR,
} from './kinds.js';

/** @param {{appAdminPub?: Uint8Array, appAdminPubs?: Uint8Array[], collectionRegistryKinds?: object[], adminTemplateNames?: string[], adminPageRoutes?: string[], adminStyleNames?: string[]}} params - `appAdminPub` (singular) is a convenience alias for `appAdminPubs: [appAdminPub]`. `collectionRegistryKinds` - every Collection's `registryKind` this relay should recognize (see this file's own top doc comment on "COLLECTIONS") - each is checked against every configured owner. `adminTemplateNames`/`adminPageRoutes`/`adminStyleNames` - see this file's own top doc comment on "THE ADMIN APP". @returns {Promise<(nodeId: string) => object>} */
export async function createAppResolveKindSchema({
  appAdminPub,
  appAdminPubs,
  collectionRegistryKinds = [],
  adminTemplateNames = ['main'],
  adminPageRoutes = ['/'],
  adminStyleNames = [],
} = {}) {
  const owners = [...(appAdminPubs ?? []), ...(appAdminPub ? [appAdminPub] : [])];
  const manifestIds = new Set(await Promise.all(owners.map((pub) => deriveOwnerNodeId(pub, appManifestKind.kind))));
  const registryIds = new Set(await Promise.all(owners.map((pub) => deriveOwnerNodeId(pub, routeRegistryKind.kind))));
  const templateRegistryIds = new Set(await Promise.all(owners.map((pub) => deriveOwnerNodeId(pub, templateRegistryKind.kind))));
  const styleRegistryIds = new Set(await Promise.all(owners.map((pub) => deriveOwnerNodeId(pub, styleRegistryKind.kind))));
  const platformId = await deriveOwnerNodeId(PLATFORM_REGISTRY_ANCHOR, platformAppsKind.kind);

  const adminManifestId = await deriveOwnerNodeId(ADMIN_REALM_ANCHOR, adminAppManifestKind.kind);
  const adminTemplateIds = new Set(await Promise.all(adminTemplateNames.map((name) => deriveContentNodeId(ADMIN_REALM_ANCHOR, adminTemplateKind.kind, name))));
  const adminPageIds = new Set(await Promise.all(adminPageRoutes.map((route) => deriveContentNodeId(ADMIN_REALM_ANCHOR, adminPageKind.kind, route))));
  const adminStyleIds = new Set(await Promise.all(adminStyleNames.map((name) => deriveContentNodeId(ADMIN_REALM_ANCHOR, adminStyleKind.kind, name))));

  const collectionRegistryById = new Map();
  for (const registryKind of collectionRegistryKinds) {
    for (const pub of owners) {
      collectionRegistryById.set(await deriveOwnerNodeId(pub, registryKind.kind), registryKind);
    }
  }

  return (nodeId) => {
    if (nodeId === adminManifestId) return adminAppManifestKind;
    if (adminTemplateIds.has(nodeId)) return adminTemplateKind;
    if (adminPageIds.has(nodeId)) return adminPageKind;
    if (adminStyleIds.has(nodeId)) return adminStyleKind;
    if (manifestIds.has(nodeId)) return appManifestKind;
    if (registryIds.has(nodeId)) return routeRegistryKind;
    if (templateRegistryIds.has(nodeId)) return templateRegistryKind;
    if (styleRegistryIds.has(nodeId)) return styleRegistryKind;
    if (collectionRegistryById.has(nodeId)) return collectionRegistryById.get(nodeId);
    if (nodeId === platformId) return platformAppsKind;
    return pageKind;
  };
}
