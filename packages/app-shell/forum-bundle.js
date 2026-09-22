/**
 * THE FORUM APP, AS A PLAIN BUNDLE — `realm: 'global'`, same reasoning as
 * `guestbook-bundle.js`'s own top doc comment (an independent content
 * namespace per installed prefix, no per-app identity to manage).
 *
 * TOPICS AND REPLIES ARE `'members'`-ACL SHARED-LIST ENTRIES, NEVER
 * `qu-page`/`qu-admin-page` NODES — the one genuinely load-bearing design
 * decision this bundle makes, worth spelling out in full since an earlier
 * version got this wrong: a `qu-page` (self-owned `'content'`-ACL) or
 * `qu-admin-page` (`'relay-admins'`-ACL) can only ever be WRITTEN by its
 * own owner or a configured relay-admin - never by an arbitrary Space
 * member. "Any member can start a topic or reply" - the entire point of a
 * forum - is therefore IMPOSSIBLE to build on either Kind: whoever isn't
 * the app's owner/a relay-admin would have their `createPage()` call
 * succeed LOCALLY (their own identity self-certifies it fine) yet be
 * COMPLETELY UNREACHABLE through the forum's own resolved route (which
 * only ever looks under the APP's own owner/anchor, never the visitor's)
 * - a real, confirmed bug an earlier version of this bundle shipped with,
 * caught only because a test happened to reuse one identity for both
 * "installer" and "visitor" and never noticed the mismatch.
 *
 * `sharedListKind` has NO such restriction (`'members'`-ACL - any CURRENT
 * Space member may push an entry, `pushToSharedList()`'s own doc comment),
 * so this bundle stores a topic's ENTIRE content (title/author/body) and
 * every reply directly as list entries on two named lists,
 * `${prefix}:topics` and `${prefix}:replies` - both already declared to
 * `registerApp()`'s own `sharedLists` param at install time (`admin-
 * actions.js`'s own `APP_INSTALLERS`), same as before.
 *
 * THE PRACTICAL TRADE-OFF: since a topic is no longer its own Page, it has
 * no route of its own either - visiting a topic is in-page client state
 * (`forum-actions.js`'s `wireForum()`), not a separate, bookmarkable
 * `#/<prefix>/topic/<id>` URL the way an earlier version offered. Real,
 * deliberate future work if that's ever needed: a general
 * "parameterized/wildcard route" capability in `@qu/app-core`'s own
 * router/resolver, which does not exist today and is a substantially
 * bigger feature than this reference app warrants on its own.
 */
import { publishGlobalRoute } from '@qu/app-core';
import { upsertGlobalPage, upsertGlobalView } from './bundle-upsert.js';

/** Bumped whenever this bundle's own shipped content changes - see `guestbook-bundle.js`'s own `GUESTBOOK_VERSION` doc comment, identical reasoning. Previously MISSING entirely (a real, reported gap: an already-installed Forum had no "Update verfügbar" path at all, `admin-actions.js`'s own button only renders when `APP_INSTALLERS[appType].update` is set) - `installForum()` already used the same upsert-based helpers `updateForum()` below needs, so closing this gap needed no change to `installForum()` itself, only the missing update entry point. */
export const FORUM_VERSION = 1;

function globalPageFields(prefix) {
  return {
    route: '/',
    title: 'Forum',
    content: `<h1>Forum</h1>
<form data-qu-action="forum-topic-form" data-qu-prefix="${prefix}">
  <label>Titel: <input name="title" required></label><br>
  <label>Dein Name: <input name="author" required></label><br>
  <label>Beitrag:<br><textarea name="body" rows="5" cols="60" required></textarea></label><br>
  <button type="submit">Thema erstellen</button>
  <p data-qu-status></p>
</form>

<div data-qu-forum-detail data-qu-prefix="${prefix}" hidden>
  <button type="button" data-qu-action="forum-back">← Zurück zur Übersicht</button>
  <h2 data-qu-forum-title></h2>
  <p data-qu-forum-byline></p>
  <div data-qu-forum-body></div>
  <h3>Antworten</h3>
  <ul data-qu-forum-replies></ul>
  <form data-qu-action="forum-reply-form" data-qu-prefix="${prefix}">
    <label>Dein Name: <input name="author" required></label><br>
    <label>Antwort:<br><textarea name="message" rows="3" cols="50" required></textarea></label><br>
    <button type="submit">Antworten</button>
    <p data-qu-status></p>
  </form>
</div>

<div data-qu-forum-list>
  <h2>Themen</h2>
  <div data-qu-view="${prefix}-topics"></div>
</div>`,
  };
}

function topicsViewFields(prefix) {
  return {
    name: `${prefix}-topics`,
    sources: [{ type: 'shared-list', name: `${prefix}:topics` }],
    sortBy: 'timestamp',
    sortOrder: 'desc',
    itemTemplate: '<p><a href="#" data-qu-view-link><qu-slot name="title"></qu-slot></a> — <qu-slot name="excerpt"></qu-slot></p>',
  };
}

/**
 * @param {import('@qu/space-core').Space} space @param {{prefix: string}} params
 *
 * UPSERT, NOT A BLIND `create*()` - see `guestbook-bundle.js`'s `installGuestbook()` own doc
 * comment for the full "Deinstallieren + reinstall" bug this fixes (identical reasoning here).
 */
export async function installForum(space, { prefix }) {
  await publishGlobalRoute(space, prefix, { route: '/', title: 'Forum' });
  await new Promise((resolve) => setTimeout(resolve, 400));
  await upsertGlobalPage(space, prefix, globalPageFields(prefix));
  await upsertGlobalView(space, prefix, topicsViewFields(prefix));
}

/**
 * Re-applies this bundle's own GLOBAL content in place - the admin
 * console's own "Update verfügbar" button (`admin-actions.js`'s own doc
 * comment) calls this for an ALREADY-installed prefix, via `bundle-
 * upsert.js`'s edit-with-create-fallback helpers - safe on existing
 * content, unlike a raw `createGlobalPage()`/`createGlobalView()` call
 * would be (this file's own top doc comment has the full "why upsert, not
 * a blind create" reasoning, identical to `installForum()` above). Never
 * touches `${prefix}:topics`/`${prefix}:replies` or any member's own
 * topics/replies already posted into them - only the page/View
 * DEFINITIONS this bundle itself owns.
 */
export async function updateForum(space, { prefix }) {
  await publishGlobalRoute(space, prefix, { route: '/', title: 'Forum' }); // harmless no-op re-publish - publishGlobalRoute()'s own "deduplicates by route" doc comment.
  await upsertGlobalPage(space, prefix, globalPageFields(prefix));
  await upsertGlobalView(space, prefix, topicsViewFields(prefix));
}
