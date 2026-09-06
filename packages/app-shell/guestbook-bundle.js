/**
 * THE GUESTBOOK APP, AS A PLAIN BUNDLE — installs as a `realm: 'global'`
 * app (`globalAppAnchor(prefix)`-anchored - `@qu/app-core`'s `kinds.js`'s
 * own "GLOBAL APP CONTENT"/`adminViewKind` doc comments), NOT a `realm:
 * 'main'` one: a `realm: 'main'` app is owned by exactly ONE identity, and
 * installing several of these reference apps from the SAME admin session
 * (the relay-admin's own identity) would derive the EXACT SAME
 * `deriveContentNodeId(ownerPub, 'qu-page', '/')` for every one of their
 * own index pages - a real, observed bug (all three installed apps
 * silently rendering whichever one's write happened to win that shared
 * slot). Anchoring on the PREFIX instead (`createGlobalPage()`/
 * `createGlobalView()`) gives every installed app its own, independent
 * content namespace for free, with no per-app identity to generate or
 * manage - and, as a bonus, the admin console's existing mode-toggle
 * (`admin-actions.js`'s `MODE_LABELS`) and "Verwalten"/"Besuchen" links
 * apply to it automatically, same as any other global app.
 *
 * The shared list itself (`entries`, `'members'`-ACL) was ALREADY
 * anchored purely by its own NAME (`sharedListAnchor()`, kinds.js), never
 * by an owner identity - unaffected by any of this, still just `prefix`
 * itself as the list's name.
 */
import { createGlobalPage, publishGlobalRoute, createGlobalView } from '@qu/app-core';

/** @param {import('@qu/space-core').Space} space @param {{prefix: string}} params */
export async function installGuestbook(space, { prefix }) {
  // Route published BEFORE the page is created - `@qu/app-shell`'s `live-app-resolver.js` only
  // classifies a global app's page write correctly once it has observed the route in
  // `adminRouteRegistryKind` (`createGlobalView()`'s own doc comment has the full reasoning).
  await publishGlobalRoute(space, prefix, { route: '/', title: 'Gästebuch' });
  await new Promise((resolve) => setTimeout(resolve, 400));
  await createGlobalPage(space, prefix, {
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
  await createGlobalView(space, prefix, {
    name: `${prefix}-feed`,
    sources: [{ type: 'shared-list', name: prefix }],
    sortBy: 'timestamp',
    sortOrder: 'desc',
    itemTemplate: '<p><strong><qu-slot name="title"></qu-slot>:</strong> <qu-slot name="excerpt"></qu-slot></p>',
  });
}
