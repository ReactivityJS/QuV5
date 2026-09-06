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
import { createGlobalPage, publishGlobalRoute, createGlobalView } from '@qu/app-core';

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
