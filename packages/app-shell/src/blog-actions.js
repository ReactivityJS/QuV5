/**
 * BLOG ACTIONS — the framework-provided interactivity `blog-bundle.js`'s
 * own inert new-post form attaches to, by CONVENTION - see
 * `guestbook-actions.js`'s own top doc comment for the shared posture
 * (identical here, just wiring `[data-qu-action="blog-post-form"]`
 * instead). `boot.js` calls `wireBlog()` unconditionally after every
 * `renderPage()` (via `installed-apps-actions.js`'s `wireInstalledApps()`) -
 * a correct no-op on any page that isn't a Blog's own index.
 *
 * Publishing a post writes `qu-admin-page`/`qu-admin-route-registry`
 * (`createGlobalPage()`/`publishGlobalRoute()`, `acl.write: 'relay-admins'`)
 * - `blog-bundle.js`'s own doc comment on why: Blog is now a `realm:
 * 'global'` app (anchored on its own prefix, `globalAppAnchor()`), so ONLY
 * a currently-configured relay-admin's signature is accepted here, not
 * "whoever happens to be signed in." `publishGlobalRoute()` FIRST, THEN
 * `createGlobalPage()` - `dev.js`'s `createGlobalView()` own doc comment
 * has the full "why this order, specifically" reasoning (the relay's
 * `live-app-resolver.js` needs to have observed the route before it will
 * classify the matching page write correctly).
 *
 * `data-qu-mode="personal"` (set only by `installPersonalBlog()`, absent
 * from the GLOBAL blog's own form) switches this SAME form's submit
 * handler to the self-owned `createPage()`/`publishRoute()` pair instead -
 * ANY Space member may publish to their OWN personal blog (ordinary
 * `'content'`-ACL self-certification, no relay-admin needed), at
 * `/<prefix>/post/<slug>` instead of the global blog's bare `/post/<slug>`
 * - see `installPersonalBlog()`'s own doc comment for the full "why
 * prefixed" reasoning.
 *
 * `data-qu-route-template` (baked in by `blog-bundle.js`'s own
 * `installBlog()`/`installPersonalBlog()`, e.g. `"/post/{yyyy}/{mm}/{dd}/
 * {slug}"` for a date-segmented `routeScheme`) is resolved via
 * `qu-placeholders.js`'s `resolvePlaceholders()` at SUBMIT time - `{slug}`
 * comes from the form's own field, `{yyyy}`/`{mm}`/`{dd}` from TODAY's date
 * (`AMBIENT_PLACEHOLDERS`), so a post published on a given day always lands
 * under that day's own archive segment regardless of when it's later read.
 * Falls back to the pre-existing flat `/post/{slug}` (or `/<prefix>/post/
 * {slug}` for a personal one) when the attribute is absent - an
 * already-published Blog instance from before `routeScheme` existed keeps
 * behaving exactly as it always did.
 */
import { createGlobalPage, publishGlobalRoute, adminPageKind, globalAppAnchor, createPage, publishRoute, pageKind, deriveContentNodeId } from '@qu/app-core';
import { verifyWritesAcked } from './verify-writes.js';
import { resolvePlaceholders } from './qu-placeholders.js';

/** @param {{mountEl: Element, doc: Document, space: import('@qu/space-core').Space}} params */
export function wireBlog({ mountEl, doc, space }) {
  const form = mountEl.querySelector('form[data-qu-action="blog-post-form"]');
  if (!form) return;
  const prefix = form.getAttribute('data-qu-prefix');
  const isPersonal = form.getAttribute('data-qu-mode') === 'personal';
  const routeTemplate = form.getAttribute('data-qu-route-template') || (isPersonal ? `/${prefix}/post/{slug}` : '/post/{slug}');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = form.querySelector('[data-qu-status]') ?? form.appendChild(doc.createElement('p'));
    status.setAttribute('data-qu-status', '');
    status.textContent = '';
    try {
      const title = form.querySelector('[name="title"]').value.trim();
      const slug = form.querySelector('[name="slug"]').value.trim();
      const content = form.querySelector('[name="content"]').value;
      const route = resolvePlaceholders(routeTemplate, { space, fields: { slug } });
      if (isPersonal) {
        const id = await deriveContentNodeId(space.identity.signingPub, pageKind.kind, route);
        await verifyWritesAcked(space, id, async () => {
          await createPage(space, { route, title, content });
          await publishRoute(space, { route, title });
        });
      } else {
        const anchor = await globalAppAnchor(prefix);
        const id = await deriveContentNodeId(anchor, adminPageKind.kind, route);
        await verifyWritesAcked(space, id, async () => {
          await publishGlobalRoute(space, prefix, { route, title });
          await new Promise((resolve) => setTimeout(resolve, 400));
          await createGlobalPage(space, prefix, { route, title, content });
        });
      }
      form.reset();
      status.textContent = 'Veröffentlicht und vom Relay bestätigt.';
    } catch (err) {
      status.textContent = `Fehler: ${err.message}`;
    }
  });
}
