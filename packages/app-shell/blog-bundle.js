/**
 * THE BLOG APP, AS A PLAIN BUNDLE — `docs/example-apps.md`'s own "§2 Blog"
 * doc comment: no new Kind-Schema at all, a post is an ordinary `qu-page`
 * under `/post/<slug>`, the index is a View over the `'pages'` source
 * adapter (`@qu/app-core`'s `view-sources.js`) filtered to that prefix.
 * `installBlog()` is the "glue" the docs describe - a new-post form plus
 * that index View, nothing more.
 */
import { createPage, publishRoute, createView } from '@qu/app-core';

/** @param {import('@qu/space-core').Space} space @param {{prefix: string}} params - `prefix` names this install's own View (so several Blog installs under different app prefixes never collide) - it plays no role in post ROUTES themselves (`/post/<slug>` is already app-scoped by `AppRuntime`'s own per-owner namespace). */
export async function installBlog(space, { prefix }) {
  await createPage(space, {
    route: '/',
    title: 'Blog',
    content: `<h1>Blog</h1>
<form data-qu-action="blog-post-form">
  <label>Titel: <input name="title" required></label><br>
  <label>Route (z.B. "erster-post", nur Kleinbuchstaben/Zahlen/Bindestriche): <input name="slug" required pattern="[a-z0-9-]+"></label><br>
  <label>Inhalt (HTML):<br><textarea name="content" rows="6" cols="60" required></textarea></label><br>
  <button type="submit">Veröffentlichen</button>
  <p data-qu-status></p>
</form>
<h2>Beiträge</h2>
<div data-qu-view="${prefix}-index"></div>`,
  });
  await publishRoute(space, { route: '/', title: 'Blog' });
  await createView(space, {
    name: `${prefix}-index`,
    sources: [{ type: 'pages', prefix: '/post/' }],
    sortBy: 'title',
    sortOrder: 'asc',
    itemTemplate: '<p><a data-qu-view-link><qu-slot name="title"></qu-slot></a></p>',
  });
}
