/**
 * BLOG ACTIONS — the framework-provided interactivity `blog-bundle.js`'s
 * own inert new-post form attaches to, by CONVENTION - see
 * `guestbook-actions.js`'s own top doc comment for the shared posture
 * (identical here, just wiring `[data-qu-action="blog-post-form"]`
 * instead). `boot.js` calls `wireBlog()` unconditionally after every
 * `renderPage()` (via `installed-apps-actions.js`'s `wireInstalledApps()`) -
 * a correct no-op on any page that isn't a Blog's own index.
 *
 * Publishing a GLOBAL post writes `qu-admin-page`/`qu-admin-route-registry`
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
 *
 * UPDATE - "klare Pfade":
 *
 * ADMIN-ONLY VISIBILITY: every `[data-qu-admin-only]` element in either
 * form's own page content (`blog-bundle.js`'s own markup - the global post
 * form itself, the personal form's "auch im globalen Feed veröffentlichen"
 * checkbox, both feeds' "Views verwalten"/"Bearbeiten" links) starts
 * `hidden` (the safe default - matches what actually happens if submitted
 * by a non-admin: `acl.write: 'relay-admins'` silently rejects it) and is
 * un-hidden here, once, based on `space.isRelayAdmin()` - a normal visitor
 * on the global feed now sees ONLY the cross-link to their own feed, never
 * a form they can't actually use. The post-list's own per-item "Bearbeiten"
 * links (`blog-bundle.js`'s `GLOBAL_ITEM_TEMPLATE`) render LIVE and
 * asynchronously (`view-actions.js`'s own `wireViews()`/`bindList()`, wired
 * independently of this file) - each freshly-stamped item starts `hidden`
 * again, so a short settle-delayed re-application catches the initial
 * population burst; a post published by someone ELSE while this admin is
 * already on the page needs a reload to reveal ITS OWN edit link - the same
 * "no live cross-session UI patching beyond the View's own content" limit
 * every other admin-only affordance in this codebase already accepts.
 *
 * OPTIONAL DUAL-PUBLISH: the personal form's own admin-only "auch im
 * globalen Feed veröffentlichen" checkbox, when checked (only possible for
 * a relay-admin - see above), publishes the SAME title/content into the
 * GLOBAL feed too, right after the personal write - `publishGlobalPost()`
 * below is the exact same global-write sequence the bare global form's own
 * submit already used, factored out so both call sites share it.
 *
 * INLINE EDIT: a `[data-qu-blog-edit-link]` click (event-delegated on
 * `mountEl`, the same `event.target.closest()` idiom `forum-actions.js`
 * already uses for its own `[data-qu-view-link]`) reads the ROUTE off its
 * sibling `[data-qu-view-link]`'s own `dataset.route` - NOT its `href`,
 * which `view-actions.js`'s `renderItem()` rewrites to a navigation-shaped
 * `/u/<ref>/...` path for a personal feed (its own doc comment on why);
 * `dataset.route` always stays the STORED, unprefixed route regardless -
 * resolves that page through
 * a `ContentResolver` scoped to whichever form is on THIS page (personal:
 * the default self-owned resolver; global: `appAdminPub: globalAppAnchor
 * (prefix)` + the `qu-admin-*` Kinds override, the exact same shape
 * `cms-actions.js`'s own `wireCms()` already uses for a global app), with
 * `{hold: true}` - `cms-actions.js`'s own top doc comment on
 * "KEEPING THE EDITED NODE'S SUBSCRIPTION ALIVE" applies unchanged here,
 * including its accepted "a later render/navigation before this session's
 * own next edit-load leaks this one held subscription" scope cut (the SAME
 * `activeEdit`-without-cross-render-teardown shape `cms-actions.js` itself
 * already ships with, not a new risk this file introduces). Loads the
 * result into the SAME create form (title/content, `slug` becomes
 * read-only - editing never renames a route, the same "no rename support"
 * scope cut every other `editX()` in this codebase already has), flips the
 * submit button to "Aktualisieren", and the submit handler then calls
 * `editPage()`/`editGlobalPage()` instead of `createPage()`/
 * `createGlobalPage()` - no `publishRoute()`/`publishGlobalRoute()` needed,
 * the route already exists.
 *
 * AGGREGATE INDEX (`mode: 'personal'`'s own read-only merged feed,
 * `blog-bundle.js`'s `aggregateFeedViewFields()`): every NEW personal post
 * (never an EDIT of an existing one - see `pushAggregateIndexEntry()`'s own
 * doc comment) pushes a small index entry into the shared list
 * `<prefix>:personal`, right after the post itself is durably confirmed.
 * This is the ONLY thing that makes `mode: 'personal'` possible for Blog at
 * all (unlike Guestbook, a Blog post is a self-owned PAGE, not a
 * shared-list entry, with no cross-identity discovery mechanism otherwise).
 */
import {
  createGlobalPage,
  publishGlobalRoute,
  adminPageKind,
  adminRouteRegistryKind,
  adminViewKind,
  globalAppAnchor,
  createPage,
  publishRoute,
  pageKind,
  deriveContentNodeId,
  editPage,
  editGlobalPage,
  ContentResolver,
  pushToSharedList,
  sharedListAnchor,
  sharedListKind,
} from '@qu/app-core';
import { deriveOwnerNodeId } from '@qu/space-core';
import { QuCrypto } from '@qu/core';
import { verifyWritesAcked } from './verify-writes.js';
import { resolvePlaceholders } from './qu-placeholders.js';

const GLOBAL_KINDS = { pageKind: adminPageKind, routeRegistryKind: adminRouteRegistryKind, viewKind: adminViewKind };

/** `[data-qu-blog-edit-link]` clicks are delegated on `mountEl` itself (see this file's own top doc comment, "INLINE EDIT") - unlike the FORM's own submit listener (naturally discarded with the old, now-detached form element on the next render), `mountEl` persists ACROSS renders (only its children are replaced, `render.js`'s own `mountEl.innerHTML = ...`), so a delegated listener attached directly to it would otherwise accumulate one more copy every time `wireBlog()` runs - the SAME "SELF-CLEANING ACROSS ROUTE CHANGES" bookkeeping `view-actions.js`'s own `openViewsByMountEl` already established, applied here to a plain listener instead of a held View subscription. */
const clickListenerByMountEl = new WeakMap();

function applyAdminVisibility(root, isAdmin) {
  for (const el of root.querySelectorAll('[data-qu-admin-only]')) el.hidden = !isAdmin;
}

/** The global-write sequence both the bare global form AND the personal form's own "auch im globalen Feed" checkbox use - see this file's own top doc comment, "OPTIONAL DUAL-PUBLISH". */
async function publishGlobalPost(space, prefix, { route, title, content }) {
  const anchor = await globalAppAnchor(prefix);
  const id = await deriveContentNodeId(anchor, adminPageKind.kind, route);
  await verifyWritesAcked(space, id, async () => {
    await publishGlobalRoute(space, prefix, { route, title });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await createGlobalPage(space, prefix, { route, title, content });
  });
}

/** `personalTemplate` (`/<prefix>/post/...`) -> the GLOBAL blog's own template (`/post/...`), by stripping the `/<prefix>` namespace `blog-bundle.js`'s `personalPageFields()` always prepends - see that file's own doc comment on why the personal template IS exactly the global one, prefixed. Falls back to the flat default if the namespace isn't present (an unexpected/hand-authored template). */
function toGlobalRouteTemplate(personalTemplate, prefix) {
  const ns = `/${prefix}`;
  return personalTemplate.startsWith(ns) ? personalTemplate.slice(ns.length) || '/post/{slug}' : '/post/{slug}';
}

/**
 * Pushes ONE index entry `{name: title, route, ts, ownerPub}` into
 * `<prefix>:personal` - `blog-bundle.js`'s own `aggregateFeedViewFields()`
 * doc comment on why this is what actually makes `mode: 'personal'`'s
 * aggregate feed possible for a self-owned-PAGE app like Blog (unlike
 * Guestbook, whose shared-list entry already IS the visible content).
 * `route` is stored ABSOLUTE, with the `/u/<ownerRef>/` segment already
 * baked in (`QuCrypto.toBase64Url()` - the SAME base64url encoding
 * `boot.js`'s own `resolveUserRef()` decodes) - the aggregate feed renders
 * outside any one visitor's own `/u/<ref>/` context (`boot.js`'s
 * `renderAggregateShell()` calls `wireViews()` with no `routeNamespace`/
 * `userRef` at all, unlike a personal-instance render), so `view-actions.js`'s
 * `renderItem()` never rewrites this item's own link the way it would for a
 * View rendered INSIDE that context - the route has to already be
 * click-through-correct as stored.
 * @param {import('@qu/space-core').Space} space @param {string} prefix
 * @param {{personalRoute: string, title: string}} params - `personalRoute` is the UNPREFIXED-by-owner route this post was just saved at (`/<prefix>/post/<slug>`).
 */
async function pushAggregateIndexEntry(space, prefix, { personalRoute, title }) {
  const listName = `${prefix}:personal`;
  const ownerRef = QuCrypto.toBase64Url(space.identity.signingPub);
  const route = `/${prefix}/u/${ownerRef}${personalRoute.slice(prefix.length + 1)}`;
  const entry = { name: title, route, ts: Date.now(), ownerPub: QuCrypto.toBase64(space.identity.signingPub) };
  const id = await deriveOwnerNodeId(await sharedListAnchor(listName), sharedListKind.kind);
  await verifyWritesAcked(space, id, () => pushToSharedList(space, listName, entry));
}

/** @param {{mountEl: Element, doc: Document, space: import('@qu/space-core').Space}} params */
export function wireBlog({ mountEl, doc, space }) {
  clickListenerByMountEl.get(mountEl)?.();
  clickListenerByMountEl.delete(mountEl);
  const form = mountEl.querySelector('form[data-qu-action="blog-post-form"]');
  if (!form) return;
  const prefix = form.getAttribute('data-qu-prefix');
  const isPersonal = form.getAttribute('data-qu-mode') === 'personal';
  const routeTemplate = form.getAttribute('data-qu-route-template') || (isPersonal ? `/${prefix}/post/{slug}` : '/post/{slug}');

  const isAdmin = space.isRelayAdmin();
  applyAdminVisibility(mountEl, isAdmin);
  // see this file's own top doc comment, "ADMIN-ONLY VISIBILITY" - `mountEl.contains(form)` guards
  // against a STALE re-application firing after a later render/navigation already replaced this
  // page's own content with something else entirely (the same "this specific wire-up got superseded"
  // concern `qu-list.js`'s own `_generation` counter guards against, just via the DOM itself here -
  // no separate counter needed, `form` IS this wire-up's own identity).
  if (isAdmin) setTimeout(() => mountEl.contains(form) && applyAdminVisibility(mountEl, true), 300);

  const alsoGlobalCheckbox = isPersonal ? form.querySelector('[name="alsoGlobal"]') : null;
  const slugField = form.querySelector('[name="slug"]');
  const submitBtn = form.querySelector('button[type="submit"]');
  let activeEdit = null; // see this file's own top doc comment, "INLINE EDIT" - same `cms-actions.js` shape, including its accepted scope cut.

  function enterCreateMode() {
    delete form.dataset.editingRoute;
    slugField.readOnly = false;
    submitBtn.textContent = 'Veröffentlichen';
    activeEdit?.release();
    activeEdit = null;
  }

  async function loadForEdit(route) {
    const resolver = isPersonal
      ? new ContentResolver(space, { appAdminPub: space.identity.signingPub })
      : new ContentResolver(space, { appAdminPub: await globalAppAnchor(prefix), kinds: GLOBAL_KINDS });
    activeEdit?.release();
    const { page, release } = await resolver.resolvePage(route, { timeout: 2000, hold: true });
    activeEdit = { release };
    if (!page) return;
    form.querySelector('[name="title"]').value = page.title ?? '';
    slugField.value = route.split('/').pop() ?? '';
    slugField.readOnly = true;
    form.querySelector('[name="content"]').value = page.content ?? '';
    form.dataset.editingRoute = route;
    submitBtn.textContent = 'Aktualisieren';
  }

  const onClick = (event) => {
    const link = event.target.closest('[data-qu-blog-edit-link]');
    if (!link || link.hidden || !mountEl.contains(link)) return;
    event.preventDefault();
    const viewLink = link.closest('p')?.querySelector('[data-qu-view-link]');
    // `dataset.route`, NOT the link's own `href` - `view-actions.js`'s `renderItem()` rewrites
    // `href` to a NAVIGATION-shaped path for a personal feed reached via the additive `/u/<ref>/`
    // route (re-inserting that segment, its own doc comment on why), while `dataset.route` (that
    // same file's "every SCALAR field of the source's own raw item is ALSO exposed as a `data-*`
    // attribute" behavior) always stays the STORED, unprefixed route `deriveContentNodeId()` needs.
    const route = viewLink?.dataset?.route;
    if (route) loadForEdit(route);
  };
  mountEl.addEventListener('click', onClick);
  clickListenerByMountEl.set(mountEl, () => mountEl.removeEventListener('click', onClick));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = form.querySelector('[data-qu-status]') ?? form.appendChild(doc.createElement('p'));
    status.setAttribute('data-qu-status', '');
    status.textContent = '';
    try {
      const title = form.querySelector('[name="title"]').value.trim();
      const slug = form.querySelector('[name="slug"]').value.trim();
      const content = form.querySelector('[name="content"]').value;
      const editingRoute = form.dataset.editingRoute;
      const route = editingRoute ?? resolvePlaceholders(routeTemplate, { space, fields: { slug } });

      if (isPersonal) {
        if (editingRoute) {
          await editPage(space, { route, title, content });
        } else {
          const id = await deriveContentNodeId(space.identity.signingPub, pageKind.kind, route);
          await verifyWritesAcked(space, id, async () => {
            await createPage(space, { route, title, content });
            await publishRoute(space, { route, title });
          });
          // Indexes this NEW post into the aggregate feed - see `pushAggregateIndexEntry()`'s own
          // doc comment. AFTER the post itself is durably acked, never before - a stale index entry
          // pointing at a not-yet-synced post would be worse than a brief delay before it appears
          // here (the post is already live at its own route regardless, just not indexed yet).
          await pushAggregateIndexEntry(space, prefix, { personalRoute: route, title });
          if (alsoGlobalCheckbox?.checked) {
            const globalRoute = resolvePlaceholders(toGlobalRouteTemplate(routeTemplate, prefix), { space, fields: { slug } });
            await publishGlobalPost(space, prefix, { route: globalRoute, title, content });
          }
        }
      } else if (editingRoute) {
        await editGlobalPage(space, prefix, { route, title, content });
      } else {
        await publishGlobalPost(space, prefix, { route, title, content });
      }
      form.reset();
      enterCreateMode();
      status.textContent = 'Veröffentlicht und vom Relay bestätigt.';
    } catch (err) {
      status.textContent = `Fehler: ${err.message}`;
    }
  });
}
