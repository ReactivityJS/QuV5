/**
 * RELAY KIND RESOLVER — builds the `resolveKindSchema(nodeId)` function
 * `@qu/space-transport`'s `createRelayForwarder()` needs to enforce
 * per-Kind ACL (see relay.js's own doc comment on why an unresolvable
 * nodeId can only ever fall back to flat `'members'` ACL - the same
 * documented gap `relay-server.js`'s own `resolveKindSchema: () => true`
 * accepts).
 *
 * Only `qu-app` and `qu-route-registry` need to be told apart individually
 * - they're the two SELF-CERTIFYING (`'owner'`/`'named'`) singletons (see
 * kinds.js), and their ids are precomputable from the app owner's pubkey
 * alone, with no `path` involved (`deriveOwnerNodeId`). Every
 * content-addressed Kind (`qu-page`/`qu-template`/`qu-style`) shares the
 * EXACT SAME `acl`/`persistence` shape (`'members'`, durable) - the relay
 * only ever consults those two properties (`buildWriteAcl()`/
 * `storageFor()`), never the field list - so any one of them stands in for
 * all three here; `pageKind` is used arbitrarily.
 */
import { deriveOwnerNodeId } from '@qu/space-core';
import { appManifestKind, routeRegistryKind, pageKind } from './kinds.js';

/** @param {{appAdminPub: Uint8Array}} params @returns {Promise<(nodeId: string) => object>} */
export async function createAppResolveKindSchema({ appAdminPub }) {
  const manifestId = await deriveOwnerNodeId(appAdminPub, appManifestKind.kind);
  const registryId = await deriveOwnerNodeId(appAdminPub, routeRegistryKind.kind);
  return (nodeId) => {
    if (nodeId === manifestId) return appManifestKind;
    if (nodeId === registryId) return routeRegistryKind;
    return pageKind;
  };
}
