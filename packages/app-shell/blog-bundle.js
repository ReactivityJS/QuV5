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
 */
import { createGlobalPage, publishGlobalRoute, createGlobalView, createPage, publishRoute, createView } from '@qu/app-core';

/** @param {import('@qu/space-core').Space} space @param {{prefix: string}} params */
export async function installBlog(space, { prefix }) {
  await publishGlobalRoute(space, prefix, { route: '/', title: 'Blog' });
  await new Promise((resolve) => setTimeout(resolve, 400));
  await createGlobalPage(space, prefix, {
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
  });
  await createGlobalView(space, prefix, {
    name: `${prefix}-index`,
    sources: [{ type: 'pages', prefix: '/post/' }],
    sortBy: 'title',
    sortOrder: 'asc',
    itemTemplate: '<p><a data-qu-view-link><qu-slot name="title"></qu-slot></a></p>',
  });
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
export async function installPersonalBlog(space, { prefix }) {
  const route = `/${prefix}/`;
  await createPage(space, {
    route,
    title: 'Mein Blog',
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
  });
  await publishRoute(space, { route, title: 'Mein Blog' });
  await createView(space, {
    name: `${prefix}-personal-index`,
    sources: [{ type: 'pages', prefix: `/${prefix}/post/` }],
    sortBy: 'title',
    sortOrder: 'asc',
    itemTemplate: '<p><a data-qu-view-link><qu-slot name="title"></qu-slot></a></p>',
  });
}
