/**
 * THE GUESTBOOK APP, AS A PLAIN BUNDLE — same "reference Package" posture
 * `cms-bundle.js`/`admin-console-bundle.js` already document, applied to
 * `sharedListKind` (`@qu/app-core`'s `kinds.js` own doc comment) instead
 * of ordinary `'content'`-ACL content. `installGuestbook(space, {prefix})`
 * writes ONE page (the sign-form + the live feed) and ONE View - no new
 * Kind-Schema, see `docs/example-apps.md`'s own "§1 Guestbook" for the
 * full design rationale.
 *
 * `prefix` becomes the shared list's own NAME (`dev.js`'s `pushToSharedList()`)
 * - installing this bundle a SECOND time under a DIFFERENT prefix gets its
 * own, entirely independent list, `sharedListAnchor(name)`'s own "many
 * independent named lists" doc comment. The relay must be TOLD this name
 * ahead of any write reaching it - `registerApp()`'s own `sharedLists`
 * param is how the admin-console installer (`admin-actions.js`) does that
 * in the SAME call that registers this app's `prefix`, so a fresh install
 * needs no relay restart (`live-app-resolver.js`'s own doc comment).
 *
 * The one interactive bit (the sign-form) is inert markup here too -
 * `<form data-qu-action="guestbook-form" data-qu-list="...">` is a
 * CONVENTION `@qu/app-shell`'s own `guestbook-actions.js` wires up after
 * render, never a `<script>` (stripped by `@qu/app-renderer`'s
 * `sanitizeHtml()` regardless).
 */
import { createPage, publishRoute, createView } from '@qu/app-core';

/** @param {import('@qu/space-core').Space} space @param {{prefix: string}} params - `prefix` is BOTH this app's own registered path prefix AND (see this file's own top doc comment) the shared list's name - the two happen to be the same string, not a coincidence: it's what keeps a caller from having to invent and remember a SEPARATE list name per install. */
export async function installGuestbook(space, { prefix }) {
  await createPage(space, {
    route: '/',
    title: 'Gästebuch',
    content: `<h1>Gästebuch</h1>
<form data-qu-action="guestbook-form" data-qu-list="${prefix}">
  <label>Name: <input name="name" required></label><br>
  <label>Nachricht:<br><textarea name="message" rows="3" cols="50" required></textarea></label><br>
  <button type="submit">Eintragen</button>
  <p data-qu-status></p>
</form>
<h2>Einträge</h2>
<div data-qu-view="${prefix}-feed"></div>`,
  });
  await publishRoute(space, { route: '/', title: 'Gästebuch' });
  await createView(space, {
    name: `${prefix}-feed`,
    sources: [{ type: 'shared-list', name: prefix }],
    sortBy: 'timestamp',
    sortOrder: 'desc',
    itemTemplate: '<p><strong><qu-slot name="title"></qu-slot>:</strong> <qu-slot name="excerpt"></qu-slot></p>',
  });
}
