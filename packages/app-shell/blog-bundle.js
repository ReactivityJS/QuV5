/**
 * THE BLOG APP, AS A PLAIN BUNDLE — `realm: 'global'` (`globalAppAnchor(prefix)`
 * -anchored), same reasoning as `guestbook-bundle.js`'s own top doc comment
 * in full: several independently-installed reference apps must never share
 * one identity's own content namespace. A post is still an ordinary page
 * (now `qu-admin-page`, `acl.write: 'relay-admins'` instead of the
 * self-owned `qu-page`) under `/post/<slug>`; the index is still a View
 * (now `qu-admin-view`) over the `'pages'` source adapter. Practical
 * consequence of the ACL change: publishing a post is now a RELAY-ADMIN
 * action (any configured relay-admin, not just whoever ran the installer) -
 * consistent with every other global app's content, and arguably more
 * useful than the old "only the exact identity that installed it" default.
 *
 * INSTALL vs. UPDATE, DELIBERATELY SEPARATE CODE PATHS - see
 * `guestbook-bundle.js`'s own top doc comment for the full "why never
 * routed through installX()" reasoning (identical here: routing install
 * through the upsert-based update once made every fresh install pay a
 * multi-second doomed-`edit()` cost for no benefit).
 *
 * `mode: 'personal'`'s own aggregate feed (kinds.js's `platformAppsKind` doc
 * comment) is DELIBERATELY NOT built here yet - unlike Guestbook's shared
 * list (already a single, cross-owner-readable source an aggregate View can
 * merge for free), a Blog post is a self-owned PAGE with no cross-identity
 * discovery mechanism at all; aggregating "every visitor's own posts"
 * without one would need each personal post to ALSO register itself into a
 * shared index (the same pattern `forum-bundle.js`'s topics/replies already
 * use) - real, separate follow-up work, not attempted in this pass. `mode:
 * 'personal'` is still selectable for a Blog in the admin console; its bare
 * prefix will simply render an empty aggregate feed until that follow-up
 * lands.
 */
import { createGlobalPage, publishGlobalRoute, createGlobalView, createPage, publishRoute, createView } from '@qu/app-core';
import { upsertGlobalPage, upsertGlobalView, upsertPage, upsertView } from './bundle-upsert.js';

/** Bumped whenever this bundle's own shipped content changes - see `guestbook-bundle.js`'s own `GUESTBOOK_VERSION` doc comment, identical reasoning. */
export const BLOG_VERSION = 1;

const ITEM_TEMPLATE = '<p><a data-qu-view-link><qu-slot name="title"></qu-slot></a></p>';

function globalPageFields(prefix) {
  return {
    route: '/',
    title: 'Blog',
    content: `<h1>Blog</h1>
<form data-qu-action="blog-post-form" data-qu-prefix="${prefix}">
  <label>Titel: <input name="title" required></label><br>
  <label>Route (z.B. "erster-post", nur Kleinbuchstaben/Zahlen/Bindestriche): <input name="slug" required pattern="[a-z0-9\\-]+"></label><br>
  <label>Inhalt (HTML):<br><textarea name="content" rows="6" cols="60" required></textarea></label><br>
  <button type="submit">Veröffentlichen</button>
  <p data-qu-status></p>
</form>
<h2>Beiträge</h2>
<div data-qu-view="${prefix}-index"></div>`,
  };
}

function globalIndexViewFields(prefix) {
  return { name: `${prefix}-index`, sources: [{ type: 'pages', prefix: '/post/' }], sortBy: 'title', sortOrder: 'asc', itemTemplate: ITEM_TEMPLATE };
}

/** @param {import('@qu/space-core').Space} space @param {{prefix: string}} params */
export async function installBlog(space, { prefix }) {
  await publishGlobalRoute(space, prefix, { route: '/', title: 'Blog' });
  await new Promise((resolve) => setTimeout(resolve, 400));
  await createGlobalPage(space, prefix, globalPageFields(prefix));
  await createGlobalView(space, prefix, globalIndexViewFields(prefix));
}

/**
 * Re-applies this bundle's own GLOBAL content in place - see
 * `guestbook-bundle.js`'s `updateGuestbook()` own doc comment for the full
 * "why upsert, why never routed through installX()" reasoning, identical
 * here. Never touches any already-published POST (a `realm: 'global'`
 * app's post is its own `adminPageKind` entry at its own route, untouched
 * by this - only the index page/View DEFINITIONS this bundle itself owns).
 */
export async function updateBlog(space, { prefix }) {
  await publishGlobalRoute(space, prefix, { route: '/', title: 'Blog' });
  await upsertGlobalPage(space, prefix, globalPageFields(prefix));
  await upsertGlobalView(space, prefix, globalIndexViewFields(prefix));
}

/**
 * A VISITOR'S OWN PERSONAL BLOG — "not instead of the global one, an
 * ADDITIONAL corner alongside it," self-provisioned the first time this
 * identity reaches its own `#/<prefix>/u/me/` - see `guestbook-bundle.js`'s
 * `installPersonalGuestbook()` own top doc comment for the full "why
 * ADDITIVE, why prefixed" reasoning, identical here. Self-owned
 * `pageKind`/`viewKind` this time (unlike Guestbook's shared-list problem,
 * a Blog POST is already inherently per-owner-scoped - `deriveContentNodeId
 * (ownerPub, 'qu-page', route)` - so two different visitors' own posts can
 * never collide even without any extra tagging), at route `/<prefix>/`
 * with posts under `/<prefix>/post/<slug>` - PREFIXED, so this identity's
 * personal Blog coexists with its own "Mein Bereich" root and any OTHER
 * app's own personal instance, rather than colliding with either.
 * `blog-actions.js`'s `wireBlog()` reads the form's own `data-qu-mode`
 * attribute (set here, absent from the GLOBAL blog's own form) to know it
 * must publish through the self-owned `createPage()`/`publishRoute()` Dev
 * API instead of the global `createGlobalPage()`/`publishGlobalRoute()`
 * pair, at this PREFIXED route instead of the bare `/post/<slug>` the
 * global blog uses.
 */
function personalPageFields(prefix) {
  return {
    route: `/${prefix}/`,
    title: 'Mein Blog',
    data: { bundleVersion: BLOG_VERSION },
    content: `<h1>Mein Blog</h1>
<form data-qu-action="blog-post-form" data-qu-prefix="${prefix}" data-qu-mode="personal">
  <label>Titel: <input name="title" required></label><br>
  <label>Route (z.B. "erster-post", nur Kleinbuchstaben/Zahlen/Bindestriche): <input name="slug" required pattern="[a-z0-9\\-]+"></label><br>
  <label>Inhalt (HTML):<br><textarea name="content" rows="6" cols="60" required></textarea></label><br>
  <button type="submit">Veröffentlichen</button>
  <p data-qu-status></p>
</form>
<h2>Beiträge</h2>
<div data-qu-view="${prefix}-personal-index"></div>`,
  };
}

function personalIndexViewFields(prefix) {
  return { name: `${prefix}-personal-index`, sources: [{ type: 'pages', prefix: `/${prefix}/post/` }], sortBy: 'title', sortOrder: 'asc', itemTemplate: ITEM_TEMPLATE };
}

export async function installPersonalBlog(space, { prefix }) {
  const route = `/${prefix}/`;
  await createPage(space, personalPageFields(prefix));
  await publishRoute(space, { route, title: 'Mein Blog' });
  await createView(space, personalIndexViewFields(prefix));
}

/**
 * Re-applies THIS VISITOR's own personal blog content in place - see
 * `guestbook-bundle.js`'s `updatePersonalGuestbook()` own doc comment for
 * the full "why upsert, self-service, stamped version, never routed
 * through installX()" reasoning, identical here. Never touches any
 * already-published personal post.
 */
export async function updatePersonalBlog(space, { prefix }) {
  const route = `/${prefix}/`;
  await upsertPage(space, personalPageFields(prefix));
  await publishRoute(space, { route, title: 'Mein Blog' });
  await upsertView(space, personalIndexViewFields(prefix));
}
