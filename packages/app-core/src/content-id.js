/**
 * CONTENT-ADDRESSED NODE IDS — re-exported from `@qu/space-core`'s own
 * `deriveContentNodeId()` (kind-schema.js), which now OWNS this function:
 * it moved there when `acl.write: 'content'` became a real, framework-level
 * ACL mode (kind-schema.js's own "THE 'content' ACL mode" doc comment) -
 * `grant.js`'s `signGrant()`/`verifyGrant()` need to compute the exact same
 * id independently of any application package, so the canonical
 * implementation has to live in `@qu/space-core` itself, not here.
 *
 * This module stays only so nothing importing `deriveContentNodeId` from
 * `@qu/app-core` has to change - the id formula itself is UNCHANGED (same
 * `~content:` prefix, same `(kind, ownerPub, path)` hash inputs), so every
 * id this ever produced before the move is still exactly reproducible.
 *
 * `qu-page`/`qu-template`/`qu-style` (kinds.js) now declare
 * `acl.write: 'content'` (not the OLD `'members'`) - real, per-owner,
 * grant-derived write-ACL instead of "any Space member may write any
 * page," see kinds.js's own doc comment on why that was a real, accepted
 * gap in a single-app deployment that became a genuine problem the moment
 * several independently-owned apps could share one relay (architecture.md
 * §7's "The Platform layer").
 */
export { deriveContentNodeId } from '@qu/space-core';
