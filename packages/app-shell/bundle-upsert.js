/**
 * BUNDLE UPSERT HELPERS — the "safely re-apply a reference app's own
 * shipped content" primitive every `installX()`/`updateX()` pair in this
 * package's bundle files (`guestbook-bundle.js`/`blog-bundle.js`/...) needs,
 * kept HERE rather than in `@qu/app-core`'s `dev.js` deliberately: this is
 * entirely a concern of "installable reference apps whose content happens
 * to live in the Space" - a concept this package (`@qu/app-shell`) is free
 * to drop or replace later (e.g. for a more complex app whose own content
 * ships as ordinary files instead) without `@qu/app-core`'s own generic
 * `create*()`/`edit*()` primitives ever needing to change or care.
 *
 * THE PROBLEM these wrap: `@qu/app-core`'s own `create*()` functions must
 * never be called twice for the same id (`dev.js`'s own `editTemplate()`
 * doc comment - a second `createNode()` produces a competing local Y.Doc
 * that silently clobbers the first, a real, previously-shipped bug), while
 * its `edit*()` counterparts require the Node to ALREADY exist (they THROW
 * otherwise, by design - see e.g. `editGlobalPage()`'s own doc comment). A
 * bundle's own `updateX()` (called from a relay-admin's "Update verfügbar"
 * button, or a visitor's own personal-instance equivalent) has no reliable
 * way to know in advance which case it's in - the SAME content may have
 * been installed under an OLDER bundle version that lacked a given page, so
 * "update" genuinely means "create whatever's missing, edit whatever's
 * already there," every time.
 *
 * THE FIX: try `edit()` first (an existing Node's common case, and the one
 * that must never be mistaken for absent), and fall back to `create()` only
 * when it reports the Node doesn't exist. This inherits the exact same
 * residual ambiguity `editGlobalPage()`'s own doc comment already accepts
 * for that error ("does not exist (or has not synced within Xms)") - a
 * genuinely existing but very slow-to-sync Node could, in principle, be
 * misdiagnosed as absent and hit `create()` instead, reproducing the
 * competing-Y.Doc bug this file exists to avoid. Not a new risk introduced
 * here - the exact same one `edit*()`'s own generous default timeout
 * already lives with elsewhere in this codebase - so this file uses that
 * SAME default (never overrides `timeout`) to keep the odds exactly as good
 * as any other `edit*()` call site's.
 */
import {
  createGlobalPage,
  editGlobalPage,
  createGlobalView,
  editGlobalView,
  createPage,
  editPage,
  createView,
  editView,
} from '@qu/app-core';

async function upsert(editFn, createFn) {
  try {
    return await editFn();
  } catch (err) {
    if (!/does not exist/.test(err.message)) throw err; // a genuinely different failure (ACL, network) must surface, never be swallowed into a wrong create() attempt.
    return await createFn();
  }
}

/** `@qu/app-core`'s `editGlobalPage()`/`createGlobalPage()` pair, upserted - see this file's own top doc comment. */
export function upsertGlobalPage(space, prefix, fields) {
  return upsert(
    () => editGlobalPage(space, prefix, fields),
    () => createGlobalPage(space, prefix, fields)
  );
}

/** `@qu/app-core`'s `editGlobalView()`/`createGlobalView()` pair, upserted - see this file's own top doc comment. */
export function upsertGlobalView(space, prefix, fields) {
  return upsert(
    () => editGlobalView(space, prefix, fields),
    () => createGlobalView(space, prefix, fields)
  );
}

/** `@qu/app-core`'s `editPage()`/`createPage()` pair (self-owned content), upserted - see this file's own top doc comment. Used by a PERSONAL instance's own self-service update, never a global one. */
export function upsertPage(space, fields) {
  return upsert(
    () => editPage(space, fields),
    () => createPage(space, fields)
  );
}

/** `@qu/app-core`'s `editView()`/`createView()` pair (self-owned content), upserted - see this file's own top doc comment. */
export function upsertView(space, fields) {
  return upsert(
    () => editView(space, fields),
    () => createView(space, fields)
  );
}
