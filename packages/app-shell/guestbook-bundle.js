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
 *
 * INSTALL vs. UPDATE, DELIBERATELY SEPARATE CODE PATHS, sharing only their
 * field data: `installX()` always writes via `create*()` DIRECTLY - fast,
 * and safe, since `registerApp()`-then-`install()` ordering (`admin-
 * actions.js`'s own doc comment) guarantees a fresh prefix never has this
 * content yet. `updateX()` goes through `bundle-upsert.js`'s edit-with-
 * create-fallback helpers instead - safe to call on an ALREADY-installed
 * prefix (`bundle-upsert.js`'s own top doc comment), at the cost of one
 * doomed-to-fail `edit()` attempt (a real, measured multi-second wait) for
 * any field that turns out not to exist yet. Routing `installX()` through
 * `updateX()` was tried first and reverted - it made every fresh install
 * pay that same doomed-`edit()` cost for EVERY field, multiple seconds
 * added to ordinary app installation for no benefit (there is nothing to
 * "update" yet, the prefix is brand new by construction). The `FIELDS`
 * helpers below keep the actual markup/View config in exactly ONE place
 * regardless.
 */
import { publishGlobalRoute, createPage, publishRoute, createView } from '@qu/app-core';
import { QuCrypto } from '@qu/core';
import { upsertGlobalPage, upsertGlobalView, upsertPage, upsertView } from './bundle-upsert.js';

/**
 * Bumped whenever this bundle's own shipped content (the markup/View config
 * below, NOT a visitor's own entries) meaningfully changes - compared
 * against a registered app's own `bundleVersion` (GLOBAL instance,
 * `admin-actions.js`'s own doc comment) / a personal page's own
 * `data.bundleVersion` (PERSONAL instance, `installed-apps-actions.js`'s own
 * doc comment) to decide whether an "Update verfügbar" affordance shows at
 * all. Bump this, and only this, the next time either the global or
 * personal FIELDS below change in a way worth re-applying to already-
 * installed instances.
 */
export const GUESTBOOK_VERSION = 1;

const GLOBAL_ITEM_TEMPLATE = '<p><strong><qu-slot name="title"></qu-slot>:</strong> <qu-slot name="excerpt"></qu-slot></p>';

function globalPageFields(prefix) {
  return {
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
  };
}

function globalFeedViewFields(prefix) {
  return { name: `${prefix}-feed`, sources: [{ type: 'shared-list', name: prefix }], sortBy: 'timestamp', sortOrder: 'desc', itemTemplate: GLOBAL_ITEM_TEMPLATE };
}

/**
 * The read-only, UNFILTERED merge of `<prefix>:personal` (the same shared
 * list every visitor's own personal guestbook writes into,
 * `installPersonalGuestbook()`'s own doc comment) - `boot.js`'s
 * `renderAggregateShell()` own doc comment on why `mode: 'personal'` needs
 * it. Installed unconditionally, regardless of this app's current `mode` -
 * cheap to always have, harmless when `mode` never uses it.
 */
function aggregateFeedViewFields(prefix) {
  return { name: `${prefix}-aggregate-feed`, sources: [{ type: 'shared-list', name: `${prefix}:personal` }], sortBy: 'timestamp', sortOrder: 'desc', itemTemplate: GLOBAL_ITEM_TEMPLATE };
}

/**
 * @param {import('@qu/space-core').Space} space @param {{prefix: string}} params
 *
 * UPSERT, NOT A BLIND `create*()` - a real, found bug this fixes: "Deinstallieren"
 * (`@qu/app-core`'s `unregisterApp()`/`nullGlobalAppContent()`) never actually frees the
 * underlying page/View Node ids - it only retracts the REGISTRY entry and NULLS the page's own
 * `title`/`content` fields (`nullGlobalAppContent()`'s own doc comment: "not a genuine deletion").
 * Re-installing the SAME prefix afterward used to call `createGlobalPage()`/`createGlobalView()`
 * again for those SAME, already-existing ids - a SECOND `createNode()` for a Node that already has
 * real (if nulled) content on the relay, which `bundle-upsert.js`'s own top doc comment already
 * warns produces a "competing local Y.Doc" - two independently-stamped Y.Docs merging via CRDT
 * clock/clientID tie-breaking rather than "the newer write wins," observed to leave the page with
 * an empty `content`/unset `template` even though the reinstall's OWN write set them - a real,
 * reported "Blog 404s after Deinstallieren + reinstall" bug. `upsertGlobalPage()`/`upsertGlobalView()`
 * (the SAME safe edit-first, create-as-fallback helpers `updateGuestbook()` below already uses) fix
 * this for BOTH cases at once: a genuinely fresh prefix still hits the create() fallback (edit()
 * correctly reports "does not exist" first), while a re-install over previously-nulled content now
 * safely EDITS in place instead of racing a second creation.
 */
export async function installGuestbook(space, { prefix }) {
  // Route published BEFORE the page is created - `@qu/app-shell`'s `live-app-resolver.js` only
  // classifies a global app's page write correctly once it has observed the route in
  // `adminRouteRegistryKind` (`createGlobalView()`'s own doc comment has the full reasoning).
  await publishGlobalRoute(space, prefix, { route: '/', title: 'Gästebuch' });
  await new Promise((resolve) => setTimeout(resolve, 400));
  await upsertGlobalPage(space, prefix, globalPageFields(prefix));
  await upsertGlobalView(space, prefix, globalFeedViewFields(prefix));
  await upsertGlobalView(space, prefix, aggregateFeedViewFields(prefix));
}

/**
 * Re-applies this bundle's own GLOBAL content in place - the admin
 * console's own "Update verfügbar" button (`admin-actions.js`'s own doc
 * comment) calls this for an ALREADY-installed prefix, via `bundle-
 * upsert.js`'s edit-with-create-fallback helpers - safe on existing
 * content, unlike a raw `createGlobalPage()`/`createGlobalView()` call
 * would be (this file's own top doc comment has the full "why never
 * routed through `installGuestbook()`" reasoning). Never touches
 * `<prefix>:personal` or any visitor's own entries in it - only the
 * page/View DEFINITIONS this bundle itself owns.
 */
export async function updateGuestbook(space, { prefix }) {
  await publishGlobalRoute(space, prefix, { route: '/', title: 'Gästebuch' }); // harmless no-op re-publish - publishGlobalRoute()'s own "deduplicates by route" doc comment.
  await upsertGlobalPage(space, prefix, globalPageFields(prefix));
  await upsertGlobalView(space, prefix, globalFeedViewFields(prefix));
  await upsertGlobalView(space, prefix, aggregateFeedViewFields(prefix));
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
function personalPageFields(prefix, ownerPub) {
  const listName = `${prefix}:personal`;
  return {
    route: `/${prefix}/`,
    title: 'Mein Gästebuch',
    data: { bundleVersion: GUESTBOOK_VERSION },
    content: `<h1>Mein Gästebuch</h1>
<form data-qu-action="guestbook-form" data-qu-list="${listName}" data-qu-owner="${ownerPub}">
  <label>Name: <input name="name" required></label><br>
  <label>Nachricht:<br><textarea name="message" rows="3" cols="50" required></textarea></label><br>
  <button type="submit">Eintragen</button>
  <p data-qu-status></p>
</form>
<h2>Einträge</h2>
<div data-qu-view="${prefix}-personal-feed"></div>`,
  };
}

function personalFeedViewFields(prefix, ownerPub) {
  return {
    name: `${prefix}-personal-feed`,
    sources: [{ type: 'shared-list', name: `${prefix}:personal`, filter: { ownerPub } }],
    sortBy: 'timestamp',
    sortOrder: 'desc',
    itemTemplate: GLOBAL_ITEM_TEMPLATE,
  };
}

export async function installPersonalGuestbook(space, { prefix }) {
  const ownerPub = QuCrypto.toBase64(space.identity.signingPub);
  const route = `/${prefix}/`;
  await createPage(space, personalPageFields(prefix, ownerPub));
  await publishRoute(space, { route, title: 'Mein Gästebuch' });
  await createView(space, personalFeedViewFields(prefix, ownerPub));
}

/**
 * Re-applies THIS VISITOR's own personal guestbook content in place - the
 * self-service counterpart to `updateGuestbook()`'s relay-admin-only
 * update, called from the SAME visitor's own personal-instance page (a
 * small framework-injected "Update verfügbar" affordance,
 * `installed-apps-actions.js`'s own doc comment) whenever their stored
 * `data.bundleVersion` is older than `GUESTBOOK_VERSION` - no relay-admin
 * cooperation needed, exactly as expected for self-owned `'content'`-ACL
 * Nodes. Uses `bundle-upsert.js`'s edit-with-create-fallback helpers, same
 * "never routed through installX()" reasoning as `updateGuestbook()`'s own
 * doc comment. Never touches this visitor's own already-pushed entries in
 * `<prefix>:personal` - only the page/View DEFINITIONS this bundle itself
 * owns, stamped with the CURRENT `GUESTBOOK_VERSION` in the page's own
 * `data` field (`pageKind`'s own doc comment on that field) each time.
 */
export async function updatePersonalGuestbook(space, { prefix }) {
  const ownerPub = QuCrypto.toBase64(space.identity.signingPub);
  const route = `/${prefix}/`;
  await upsertPage(space, personalPageFields(prefix, ownerPub));
  await publishRoute(space, { route, title: 'Mein Gästebuch' });
  await upsertView(space, personalFeedViewFields(prefix, ownerPub));
}
