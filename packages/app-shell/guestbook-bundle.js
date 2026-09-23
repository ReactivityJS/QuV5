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
 * BUILT ON `../app-bundle.js`'s `defineAppBundle()` — install/update (both
 * GLOBAL and PERSONAL) are generated from ONE content declaration below,
 * never two hand-written functions that can drift apart (see that file's
 * own top doc comment for the "Forum shipped install but no update at
 * all" bug this structurally prevents). Both ALWAYS upsert (edit-first,
 * create-as-fallback, `bundle-upsert.js`'s own doc comment) - including on
 * a genuinely fresh install: a real, previously-shipped bug (`installX()`
 * calling `create*()` directly used to 404 after "Deinstallieren" +
 * reinstalling the SAME prefix, because the underlying page/View ids were
 * never actually freed - `nullGlobalAppContent()`'s own "not a genuine
 * deletion" doc comment) is what upsert-everywhere fixes for good.
 */
import { defineAppBundle } from './app-bundle.js';

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
 * list every visitor's own personal guestbook writes into, `personalPageFields()`'s
 * own doc comment below) - `boot.js`'s `renderAggregateShell()` own doc
 * comment on why `mode: 'personal'` needs it. Installed unconditionally,
 * regardless of this app's current `mode` - cheap to always have, harmless
 * when `mode` never uses it.
 */
function aggregateFeedViewFields(prefix) {
  return { name: `${prefix}-aggregate-feed`, sources: [{ type: 'shared-list', name: `${prefix}:personal` }], sortBy: 'timestamp', sortOrder: 'desc', itemTemplate: GLOBAL_ITEM_TEMPLATE };
}

/**
 * A VISITOR'S OWN PERSONAL GUESTBOOK — "not instead of the global one, an
 * ADDITIVE corner alongside it" (the user's own framing): self-provisioned
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

export const guestbookBundle = defineAppBundle({
  key: 'guestbook',
  label: 'Gästebuch',
  version: GUESTBOOK_VERSION,
  route: { title: 'Gästebuch' },
  content: (prefix) => [
    { kind: 'page', fields: globalPageFields(prefix) },
    { kind: 'view', fields: globalFeedViewFields(prefix) },
    { kind: 'view', fields: aggregateFeedViewFields(prefix) },
  ],
  personal: {
    title: 'Mein Gästebuch',
    content: (prefix, _opts, { ownerPub }) => [
      { kind: 'page', fields: personalPageFields(prefix, ownerPub) },
      { kind: 'view', fields: personalFeedViewFields(prefix, ownerPub) },
    ],
  },
  sharedLists: (prefix) => [prefix, `${prefix}:personal`],
  viewNames: (prefix) => [`${prefix}-feed`, `${prefix}-aggregate-feed`],
});

// Thin named re-exports - every EXISTING caller (admin-actions.js/installed-apps-actions.js, both
// mid-migration to reading `guestbookBundle` directly - see app-bundle.js's own top doc comment)
// keeps working unchanged until that migration lands.
export const installGuestbook = guestbookBundle.install;
export const updateGuestbook = guestbookBundle.update;
export const installPersonalGuestbook = guestbookBundle.personal.install;
export const updatePersonalGuestbook = guestbookBundle.personal.update;
