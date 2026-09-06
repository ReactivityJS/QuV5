/**
 * BLOG ACTIONS — the framework-provided interactivity `blog-bundle.js`'s
 * own inert new-post form attaches to, by CONVENTION - see
 * `guestbook-actions.js`'s own top doc comment for the shared posture
 * (identical here, just wiring `[data-qu-action="blog-post-form"]`
 * instead). `boot.js` calls `wireBlog()` unconditionally after every
 * `renderPage()` (via `installed-apps-actions.js`'s `wireInstalledApps()`) -
 * a correct no-op on any page that isn't a Blog's own index.
 *
 * Publishing a post is ORDINARY page authoring - `createPage()` +
 * `publishRoute()`, the exact same two calls `cms-actions.js`'s own
 * `wirePages()` makes for any other page - this file adds no new
 * mechanism, only a smaller, purpose-built form (title + slug + content,
 * no template/structured-data fields) for the single "write a blog post"
 * task.
 */
import { createPage, publishRoute, pageKind, deriveContentNodeId } from '@qu/app-core';
import { verifyWritesAcked } from './verify-writes.js';

/** @param {{mountEl: Element, doc: Document, space: import('@qu/space-core').Space}} params */
export function wireBlog({ mountEl, doc, space }) {
  const form = mountEl.querySelector('form[data-qu-action="blog-post-form"]');
  if (!form) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = form.querySelector('[data-qu-status]') ?? form.appendChild(doc.createElement('p'));
    status.setAttribute('data-qu-status', '');
    status.textContent = '';
    try {
      const title = form.querySelector('[name="title"]').value.trim();
      const slug = form.querySelector('[name="slug"]').value.trim();
      const content = form.querySelector('[name="content"]').value;
      const route = `/post/${slug}`;
      const id = await deriveContentNodeId(space.identity.signingPub, pageKind.kind, route);
      await verifyWritesAcked(space, id, async () => {
        await createPage(space, { route, title, content });
        await publishRoute(space, { route, title });
      });
      form.reset();
      status.textContent = 'Veröffentlicht und vom Relay bestätigt.';
    } catch (err) {
      status.textContent = `Fehler: ${err.message}`;
    }
  });
}
