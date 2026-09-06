/**
 * VIEW ACTIONS — the framework-provided interactivity a `viewKind`'s
 * `itemTemplate` renders THROUGH: `wireViews()` finds every
 * `[data-qu-view="<name>"]` element in the just-rendered page, resolves
 * that View's own config (`@qu/app-core`'s `resolveView()`), opens it
 * LIVE (`openLiveView()`), and keeps the element's contents in sync via
 * `@qu/space-ui`'s `bindList()` - the SAME "framework code wires ordinary
 * DOM elements a content author declared by attribute" posture
 * `cms-actions.js`/`admin-actions.js` already use, just for a READ-side
 * concern (embedding a live feed) instead of a write-side one (an editor
 * form). `boot.js` calls `wireViews()` unconditionally after EVERY
 * `renderPage()`, for EVERY app/realm - a correct no-op whenever the
 * rendered page has no `[data-qu-view]` element, regardless of whether
 * that page came from the built-in CMS, a Forum, a Live-Ticker, or any
 * other app built on `@qu/app-core` - see this file's own "REUSABLE BY
 * DESIGN" section below.
 *
 * REUSABLE BY DESIGN, not CMS-specific: this file imports nothing from
 * `cms-actions.js`/`cms-bundle.js`, and `kinds.js`'s own `viewKind` doc
 * comment makes the same point from the data side (`acl.write: 'content'`,
 * the same self-owned shape `qu-template`/`qu-style` already use, not
 * gated behind the CMS in any way). A future Forum/Live-Ticker/GeoChase
 * app author's pages just need a `[data-qu-view="name"]` element and a
 * View Node at that name under THEIR OWN `appAdminPub` - `wireViews()`
 * never assumes it's rendering CMS content specifically. Authoring a View
 * (creating/editing one) is a SEPARATE concern from rendering one -
 * `cms-actions.js`'s own View form (if/when added) is simply the first of
 * possibly several "editors" that could exist for the same underlying
 * `createView()`/`editView()` Dev API, matching the "editors as plugins"
 * direction this is meant to leave room for, without building a full
 * plugin mechanism now.
 *
 * SELF-CLEANING ACROSS ROUTE CHANGES: unlike `wireCms()`'s forms (inert
 * DOM listeners only, nothing left open if the page navigates away),
 * `openLiveView()` holds REAL `Space` subscriptions open for as long as a
 * View stays wired - a route change that never closed the PREVIOUS page's
 * views would leak one subscription set per navigation over a session.
 * `wireViews()` tracks what it opened for a given `mountEl` in
 * `openViewsByMountEl` (module-level, keyed by the mount element itself,
 * never the DOM subtree churned by each render) and closes that batch
 * FIRST, before opening the new one - callers never need to remember to
 * tear anything down themselves, the same "correct no-op, just call it
 * again" ergonomic `wireCms()` already has, extended to cover this file's
 * own extra state.
 */
import { ContentResolver, openLiveView } from '@qu/app-core';
import { sanitizeHtml, resolveSlots } from '@qu/app-renderer';
import { bindList } from '@qu/space-ui';

/** @type {WeakMap<Element, () => void>} mountEl -> "close every View this file opened for it last time". See this file's own "SELF-CLEANING ACROSS ROUTE CHANGES" doc comment. */
const openViewsByMountEl = new WeakMap();

function renderItem(item, itemTemplate, doc) {
  const filled = resolveSlots(
    sanitizeHtml(itemTemplate, doc),
    {
      title: sanitizeHtml(item.title ?? '', doc),
      excerpt: sanitizeHtml(item.excerpt ?? '', doc),
    },
    doc
  );
  const wrapper = doc.createElement('div');
  wrapper.innerHTML = filled;
  // `route` is a LINK TARGET, not markup - `<qu-slot>` only ever replaces an ELEMENT with content,
  // it has no attribute-interpolation mode (`slots.js`'s own doc comment) - so an item template
  // wanting its title/excerpt to link to the item's own route wraps them in `<a data-qu-view-link>`
  // and this framework code (never content-authored `onclick`, so Stufe 1 is untouched) sets its
  // `href` directly, same "trusted code wires a plain element a content author declared by
  // attribute" posture as every other framework-provided interactivity in this package.
  const links = wrapper.querySelectorAll('[data-qu-view-link]');
  if (item.route) {
    for (const link of links) link.setAttribute('href', `#${item.route}`);
  }
  // Every SCALAR field of the source's own raw item (e.g. a shared-list entry's own `topicId`) is
  // ALSO exposed as a `data-*` attribute on `[data-qu-view-link]` - not just `title`/`excerpt`/
  // `route`. Needed for an item that has no meaningful ROUTE of its own (`@qu/app-shell`'s
  // `forum-actions.js` own doc comment: a Forum topic is `'members'`-ACL shared-list data, not a
  // `'content'`-ACL page any member could actually own - so it can never be a real, resolvable
  // route) but still needs its OWN identifying key back once a visitor clicks it, for whatever
  // framework-provided interactivity (never content-authored `onclick`) reads it from there.
  if (item.raw && typeof item.raw === 'object') {
    for (const [key, value] of Object.entries(item.raw)) {
      if (value === null || typeof value === 'object') continue; // lists/objects have no single attribute-string form worth exposing this way.
      for (const link of links) link.dataset[key] = String(value);
    }
  }
  return wrapper;
}

/**
 * Wires every `[data-qu-view="<name>"]` element in `mountEl` to that
 * View's own live, merged feed - see this file's own top doc comment.
 * @param {{mountEl: Element, doc: Document, space: import('@qu/space-core').Space, appAdminPub: Uint8Array, kinds?: object}} params - `kinds`/`appAdminPub` are the SAME override `ContentResolver`/`openLiveView()` already accept (e.g. `cms-actions.js`'s own `GLOBAL_KINDS` for a `realm: 'global'` app) - a View's OWN sources resolve against these too, so a global app's View correctly reads ITS OWN route registry, not the default one.
 */
export async function wireViews({ mountEl, doc, space, appAdminPub, kinds }) {
  openViewsByMountEl.get(mountEl)?.();
  openViewsByMountEl.delete(mountEl);

  const elements = [...mountEl.querySelectorAll('[data-qu-view]')];
  if (elements.length === 0) return;

  const resolver = new ContentResolver(space, { appAdminPub, kinds });
  const closers = [];

  await Promise.all(
    elements.map(async (container) => {
      const name = container.getAttribute('data-qu-view');
      const config = await resolver.resolveView(name);
      if (!config) return; // no such View (or not synced within the default timeout) - leave the element as authored, same "correct no-op" posture as an unresolved page.
      const view = await openLiveView(space, { appAdminPub, kinds, ...config });
      closers.push(() => view.close());
      const stopBinding = bindList(container, view, {
        key: (item, i) => item.route ?? `${i}:${item.title}`,
        render: (item) => renderItem(item, config.itemTemplate, doc),
      });
      closers.push(stopBinding);
    })
  );

  openViewsByMountEl.set(mountEl, () => {
    for (const close of closers) close();
  });
}
