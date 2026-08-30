/**
 * CONTENT-ADDRESSED NODE IDS — the "namespace" of an app (`qu-page`,
 * `qu-template`, `qu-style`) is not a filesystem or a path stored anywhere
 * in `@qu/space-core` (there is none - see docs/app-shell-arbeitsauftrag.md
 * §12). It is a pure, deterministic function of (owner pubkey, Kind, path):
 * anyone who knows an app's owner pubkey and a content path (e.g. the
 * template name `"layout/main"`, or a route `"/hello"`) can compute the
 * exact Node id without ever asking anything "where is X" - the same idea
 * `@qu/space-core`'s own `deriveOwnerNodeId(ownerPub, kind)` already uses
 * for a Kind's SINGLE well-known Node per owner, extended with a `path`
 * component for a Kind that has MANY Nodes per owner.
 *
 * Deliberately a SEPARATE function from `deriveOwnerNodeId()`, not a change
 * to it: `@qu/space-core` stays exactly as it is (see this repo's own
 * architecture.md §1 - "Framework kennt keine konkrete Anwendung"), and
 * `Space.createNode()`'s own id-derivation for `'owner'`/`'named'`-ACL Kinds
 * (see space.js) has no `path` concept at all - it always derives from
 * `(identity.signingPub, kind)` alone, which is exactly right for a
 * SINGLETON Kind (one manifest, one route registry per app) but would
 * collapse every page/template/style of the SAME owner onto one Node id.
 *
 * That's WHY `qu-page`/`qu-template`/`qu-style` (kinds.js) are declared
 * `acl.write: 'members'`, not `'owner'`/`'named'`: `Space.createNode()`
 * only honors a caller-supplied `{id}` for `'members'`-mode Kinds (see its
 * own doc comment) - which is exactly what lets content-addressed,
 * many-per-owner Nodes exist at all with zero changes to `@qu/space-core`.
 * The tradeoff this accepts (documented, not hidden - same posture as
 * `relay-server.js`'s own doc comment on its `resolveKindSchema` gap): a
 * `'members'`-mode Node can only be SUBSCRIBED TO by an actual Space
 * member (see `@qu/space-transport`'s relay.js `handleSubscribe()`), so an
 * anonymous visitor must first join the Space (e.g. via the relay's own
 * `POST /join`, see `@qu/app-shell`'s `identity.js`) before app content
 * loads - there is no fully-public, membership-free CMS-visitor story yet.
 * Extending that is real, separate work (see
 * docs/app-shell-arbeitsauftrag.md §21) - not something this function
 * needs to solve to be useful today.
 */
import { QuCrypto } from '@qu/core';

const CONTENT_NODE_PREFIX = '~content:';

/**
 * @param {Uint8Array} ownerPub - The app's owner (app-admin) Ed25519 signing pubkey.
 * @param {string} kind - A Kind name (e.g. `pageKind.kind`).
 * @param {string} path - Any stable string identifying this one piece of content within `kind` (a route, a template name, a style name).
 * @returns {Promise<string>}
 */
export async function deriveContentNodeId(ownerPub, kind, path) {
  if (!path || typeof path !== 'string') throw new Error('deriveContentNodeId: "path" must be a non-empty string');
  const digest = await QuCrypto.sha256(new TextEncoder().encode(`${kind}:${QuCrypto.toBase64(ownerPub)}:${path}`));
  return CONTENT_NODE_PREFIX + QuCrypto.toBase64Url(digest);
}
