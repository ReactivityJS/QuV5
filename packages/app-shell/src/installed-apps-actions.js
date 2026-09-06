/**
 * INSTALLED-APPS ACTIONS — a single aggregating call for every REFERENCE
 * app's own wiring (`guestbook-actions.js`/`blog-actions.js`/
 * `forum-actions.js`, all found in `packages/app-shell/`), so `boot.js`'s
 * own dispatch tree adds exactly ONE call per render site instead of one
 * per app - a 4th reference app later only touches THIS file, not every
 * one of `boot.js`'s five render call sites again. Each wired function is
 * already a correct, cheap no-op on any page that isn't its own
 * (`guestbook-actions.js`'s own doc comment) - this file adds no NEW
 * behavior, purely fewer places to remember to call from.
 */
import { wireGuestbook } from './guestbook-actions.js';
import { wireBlog } from './blog-actions.js';
import { wireForum } from './forum-actions.js';

/** @param {{mountEl: Element, doc: Document, space: import('@qu/space-core').Space}} params */
export async function wireInstalledApps({ mountEl, doc, space }) {
  await Promise.all([wireGuestbook({ mountEl, doc, space }), wireBlog({ mountEl, doc, space }), wireForum({ mountEl, doc, space })]);
}
