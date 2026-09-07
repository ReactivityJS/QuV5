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
import { createGlobalPage, publishGlobalRoute, createGlobalView, createPage, publishRoute, createView } from '@qu/app-core';
import { QuCrypto } from '@qu/core';

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

/**
 * A VISITOR'S OWN PERSONAL GUESTBOOK — "not instead of the global one, an
 * ADDITIONAL corner alongside it" (the user's own framing): self-provisioned
 * by `installed-apps-actions.js`'s `provisionPersonalInstance()` the first
 * time this identity reaches its own `#/<prefix>/u/me/` (`boot.js`'s own
 * doc comment on that ADDITIVE route - it never replaces what the bare
 * `#/<prefix>/` prefix means, unlike `mode: 'multiuser'`). Self-owned
 * `pageKind`/`viewKind` (never `adminPageKind`/`adminViewKind` - this is
 * genuinely THIS VISITOR's own content, not the relay-admins' shared one),
 * at route `/<prefix>/` - PREFIXED, not bare `/`, so it coexists with
 * whatever else this same identity has at its own root (its "Mein Bereich"
 * CMS starter, or a DIFFERENT app's own personal instance at a different
 * prefix) instead of colliding with it.
 *
 * ONE SHARED LIST FOR EVERYONE'S PERSONAL GUESTBOOK, `<prefix>:personal`
 * (registered upfront - `admin-actions.js`'s own `APP_INSTALLERS.guestbook.
 * sharedLists` - a per-visitor list name could never be pre-registered,
 * since nobody knows who'll self-provision one until they actually visit),
 * each entry tagged with its own `ownerPub` - the EXACT same "one physical
 * list, many logical feeds" pattern `forum-actions.js`'s per-topic reply
 * filtering already established (`view-sources.js`'s `'shared-list'`
 * adapter own `filter` param). This View filters that ONE list down to
 * `{ownerPub: <this identity's own base64 pubkey>}`; `guestbook-actions.js`'s
 * `wireGuestbook()` reads the form's own `data-qu-owner` attribute (set
 * here, absent from the GLOBAL guestbook's own form) to know it must tag
 * every entry it pushes with that SAME owner, not just the plain
 * `{name, message, ts}` the global guestbook's entries carry.
 */
export async function installPersonalGuestbook(space, { prefix }) {
  const ownerPub = QuCrypto.toBase64(space.identity.signingPub);
  const listName = `${prefix}:personal`;
  const route = `/${prefix}/`;
  await createPage(space, {
    route,
    title: 'Mein Gästebuch',
    content: `<h1>Mein Gästebuch</h1>
<form data-qu-action="guestbook-form" data-qu-list="${listName}" data-qu-owner="${ownerPub}">
  <label>Name: <input name="name" required></label><br>
  <label>Nachricht:<br><textarea name="message" rows="3" cols="50" required></textarea></label><br>
  <button type="submit">Eintragen</button>
  <p data-qu-status></p>
</form>
<h2>Einträge</h2>
<div data-qu-view="${prefix}-personal-feed"></div>`,
  });
  await publishRoute(space, { route, title: 'Mein Gästebuch' });
  await createView(space, {
    name: `${prefix}-personal-feed`,
    sources: [{ type: 'shared-list', name: listName, filter: { ownerPub } }],
    sortBy: 'timestamp',
    sortOrder: 'desc',
    itemTemplate: '<p><strong><qu-slot name="title"></qu-slot>:</strong> <qu-slot name="excerpt"></qu-slot></p>',
  });
}
