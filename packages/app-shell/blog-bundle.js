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
 * UPDATE - `mode: 'personal'`'s own aggregate feed now exists: unlike
 * Guestbook, a Blog post is a self-owned PAGE, not a shared-list entry, so
 * there was no single cross-identity-readable source an aggregate View
 * could merge for free - `blog-actions.js`'s own personal-post CREATE path
 * now ALSO pushes a lightweight index entry (`{name: title, route, ts,
 * ownerPub}`) into a shared list, `<prefix>:personal` (registered upfront,
 * `admin-actions.js`'s own `APP_INSTALLERS.blog.sharedLists` - the exact
 * same "one physical list, many logical feeds" pattern `forum-bundle.js`'s
 * topics/replies and Guestbook's own `<prefix>:personal` already
 * establish), which `aggregateFeedViewFields()` below reads. Post EDITS do
 * NOT update this index entry's own cached title - the SAME "no rename/no
 * full update" scope cut every other `editX()` in this codebase already
 * accepts (`ListField` has no per-index update, only `push()`/`remove()`) -
 * the entry's own `route` always still resolves to the CURRENT content,
 * only the aggregate list's displayed title text could go stale after an
 * edit. `admin-actions.js`'s own mode-button gating (`unsupportedModes()`)
 * is entirely DATA-DRIVEN off `viewNames()` - no separate "re-enable"
 * change was needed there once this file's own `viewNames` gained
 * `${prefix}-aggregate-feed`.
 *
 * UPDATE - "klare Pfade": Global Feed (`#/<prefix>/`) and User Feed
 * (`#/<prefix>/u/me/`) now cross-link each other and each label itself as
 * such, the global form is only ever SHOWN to a relay-admin (previously
 * visible to everyone but silently rejected for anyone else - `blog-
 * actions.js`'s own doc comment on the ACL), the personal form gained an
 * admin-only "auch im globalen Feed veröffentlichen" checkbox (so a relay-
 * admin's own post can default to their personal feed and OPTIONALLY also
 * land in the global one, in one submit), and each post in either feed's
 * list now shows an inline "Bearbeiten" link (admin-only on the global
 * list, always on the personal one) that loads it back into the SAME form
 * for editing - see `blog-actions.js`'s own doc comment for the mechanism.
 * `mode: 'multiuser'` is ALSO now disabled in the admin console for any app
 * with a `personalBundle` (Blog included) - see `admin-actions.js`'s own
 * mode-button doc comment for why (`boot.js`'s `mode:'multiuser'` dispatch
 * never provisions an app's OWN `personalBundle`, only the generic "Mein
 * Bereich" CMS starter - this used to be reachable, just silently wrong).
 *
 * UPDATE - ENTWURF/VERÖFFENTLICHEN: both post forms gained a second submit
 * button, `[data-qu-draft-btn]` ("Als Entwurf speichern") - see
 * `blog-actions.js`'s own `wireBlog()` doc comment for the full mechanism
 * (`kinds.js`'s `pageKind.status`/`resolver.js`'s `resolvePage()` own doc
 * comments underneath it). A draft is a REAL `qu-page`/`qu-admin-page`
 * Node, just never registered into the route registry until actually
 * published - invisible to every View/feed and to ordinary navigation
 * (`resolvePage()` treats it as "not found," the same signal an
 * unpublished route already produces) until "Veröffentlichen" is clicked.
 * No drafts-LIST UI exists yet (only the form that just saved a draft
 * stays pointed at it, for continuing in the SAME session) - a genuine
 * "Meine Entwürfe" browseable list is real, natural future work (it would
 * need its own View source, since `'pages'`/`'shared-list'` both only ever
 * read PUBLISHED/registered content), deliberately not built here.
 *
 * UPDATE - SEARCH BOX: the Global Feed's own `blog-index` View gained a
 * sibling `<input data-qu-search-for="${prefix}-index">` right above it -
 * `view-actions.js`'s `wireViews()` own "UPDATE - SEARCH BOXES" doc
 * comment wires it to that View's live `setQuery()` on every keystroke,
 * matching by NAME (the `data-qu-search-for` value === the View's own
 * `data-qu-view` name), not DOM position - no new markup convention
 * invented here, this is the framework-level mechanism's one example.
 * Searches title AND content (`view-sources.js`'s `openLiveView()` own
 * "UPDATE - CLIENT-SIDE FULL-TEXT SEARCH" doc comment on why a `'pages'`
 * source's `item.excerpt`, captured at publish time, makes this possible
 * at all). Not added to the User Feed/aggregate feed - one worked example
 * is the point, not exhaustive coverage of every Blog feed.
 *
 * UPDATE - RICH TEXT: both post forms' own `content` `<textarea>` gained
 * `data-qu-richtext` - `rich-text-actions.js`'s `wireRichText()` replaces
 * it with a small Bold/Italic/Link/H2/Aufzählung toolbar over a
 * `contenteditable` surface (`@qu/space-ui`'s `bindRichText()`), mirroring
 * back into the SAME textarea's `.value` a real user typing/formatting
 * produces - `blog-actions.js`'s own submit handler (`content = form
 * .querySelector('[name="content"]').value`) and `loadForEdit()` needed
 * NO changes for the submit path (still reads the same `.value`); loading
 * an existing post back into the form (`loadForEdit()`) now ALSO calls
 * `refreshRichText()` right after setting that value, so the visible
 * rich-text surface shows the loaded post's content instead of going
 * stale - `bindRichText()`'s own "ONE-WAY MIRRORING" doc comment on why
 * that call is needed at all.
 *
 * `routeScheme` (optional, default `'flat'` - `qu-placeholders.js`'s own
 * `ROUTE_SCHEMES` doc comment on the full list and reasoning) - a QuV3
 * requirement raised again for V5: a date-segmented post route
 * (`/post/2026/09/07/erster-post` for `'yyyy/mm/dd'`) so a year/month/day
 * ARCHIVE View (`view-sources.js`'s `'pages'` source `prefix` filter) comes
 * for free, no new resolver code. Persisted into this app's own
 * `qu-platform-apps` `config` (`dev.js`'s `setAppConfig()`) by whichever
 * caller installs it (`admin-actions.js`'s own install-form handler) so a
 * LATER `updateBlog()`/personal-instance provisioning call picks the SAME
 * scheme back up without the caller having to remember it - see
 * `blog-actions.js`'s own `wireBlog()` doc comment for how a form actually
 * resolves this at submit time.
 */
import { publishGlobalRoute, createPage, publishRoute, createView } from '@qu/app-core';
import { upsertGlobalPage, upsertGlobalView, upsertPage, upsertView } from './bundle-upsert.js';
import { ROUTE_SCHEMES } from './src/qu-placeholders.js';

/** Bumped whenever this bundle's own shipped content changes - see `guestbook-bundle.js`'s own `GUESTBOOK_VERSION` doc comment, identical reasoning. */
export const BLOG_VERSION = 6;

/** `data-qu-blog-edit-link` - ALWAYS present on the personal template (it's always the visitor's own post, no ACL question), wrapped in `data-qu-admin-only` on the global one (`blog-actions.js`'s `wireBlog()` shows/hides every `[data-qu-admin-only]` element the same way it already gates the post-forms below - only a relay-admin can actually save an edit to a GLOBAL post, `adminPageKind`'s own `acl.write: 'relay-admins'`). `wireBlog()` reads the sibling `[data-qu-view-link]`'s own already-resolved `href` (`view-actions.js`'s `renderItem()` sets it) to know which post this edit link belongs to - no separate id/route attribute needed here. */
const PERSONAL_ITEM_TEMPLATE = '<p><a data-qu-view-link><qu-slot name="title"></qu-slot></a> <a href="#" data-qu-blog-edit-link>✎ Bearbeiten</a></p>';
const GLOBAL_ITEM_TEMPLATE = '<p><a data-qu-view-link><qu-slot name="title"></qu-slot></a> <a href="#" data-qu-blog-edit-link data-qu-admin-only hidden>✎ Bearbeiten</a></p>';
/** Read-only - no edit link at all (`aggregateFeedViewFields()`'s own doc comment: this merges EVERY visitor's own posts, editing one is only ever meaningful from that visitor's OWN personal feed, `PERSONAL_ITEM_TEMPLATE` above). */
const AGGREGATE_ITEM_TEMPLATE = '<p><a data-qu-view-link><qu-slot name="title"></qu-slot></a></p>';

/** `routeScheme` -> this bundle's own `{slug}`-ending route TEMPLATE (this file's own top doc comment) - `'flat'`/unset falls back to the pre-existing, unprefixed `/post/{slug}` unchanged. */
function routeTemplate(routeScheme) {
  return `/post/${ROUTE_SCHEMES[routeScheme ?? 'flat'] ?? ROUTE_SCHEMES.flat}`;
}

function globalPageFields(prefix, routeScheme) {
  const template = routeTemplate(routeScheme);
  return {
    route: '/',
    title: 'Blog',
    content: `<h1>Blog — Globaler Feed</h1>
<p><a href="#/${prefix}/u/me/">Mein Feed →</a> <a href="#/admin/${prefix}/cms" data-qu-admin-only hidden>⚙ Views verwalten</a></p>
<form data-qu-admin-only hidden data-qu-action="blog-post-form" data-qu-prefix="${prefix}" data-qu-route-template="${template}">
  <label>Titel: <input name="title" required></label><br>
  <label>Route (z.B. "erster-post", nur Kleinbuchstaben/Zahlen/Bindestriche): <input name="slug" required pattern="[a-z0-9\\-]+"></label><br>
  <label>Inhalt (HTML):<br><textarea name="content" rows="6" cols="60" required data-qu-richtext></textarea></label><br>
  <button type="submit">Veröffentlichen</button>
  <button type="submit" data-qu-draft-btn>Als Entwurf speichern</button>
  <p data-qu-status></p>
</form>
<h2>Beiträge</h2>
<p><input type="search" placeholder="Beiträge durchsuchen…" data-qu-search-for="${prefix}-index"></p>
<div data-qu-view="${prefix}-index"></div>`,
  };
}

function globalIndexViewFields(prefix) {
  return { name: `${prefix}-index`, sources: [{ type: 'pages', prefix: '/post/' }], sortBy: 'title', sortOrder: 'asc', itemTemplate: GLOBAL_ITEM_TEMPLATE };
}

/**
 * The read-only, UNFILTERED merge of `<prefix>:personal` (the same shared
 * list every visitor's own personal blog's CREATE path pushes an index
 * entry into, `blog-actions.js`'s own doc comment) - `boot.js`'s
 * `renderAggregateShell()`/kinds.js's `platformAppsKind` doc comment on why
 * `mode: 'personal'` needs it. Installed unconditionally, regardless of
 * this app's current `mode` - cheap to always have, harmless when `mode`
 * never uses it (same posture `guestbook-bundle.js`'s own identically-named
 * function already takes).
 */
function aggregateFeedViewFields(prefix) {
  return { name: `${prefix}-aggregate-feed`, sources: [{ type: 'shared-list', name: `${prefix}:personal` }], sortBy: 'timestamp', sortOrder: 'desc', itemTemplate: AGGREGATE_ITEM_TEMPLATE };
}

/**
 * @param {import('@qu/space-core').Space} space @param {{prefix: string, routeScheme?: 'flat'|'yyyy'|'yyyy/mm'|'yyyy/mm/dd'}} params
 *
 * UPSERT, NOT A BLIND `create*()` - see `guestbook-bundle.js`'s `installGuestbook()` own doc
 * comment for the full "Deinstallieren + reinstall" bug this fixes (identical reasoning here): a
 * real, reported failure where Blog's own feed/post pages 404ed after "Deinstallieren" followed by
 * reinstalling the SAME prefix, because the underlying page/View ids were never actually freed.
 */
export async function installBlog(space, { prefix, routeScheme }) {
  await publishGlobalRoute(space, prefix, { route: '/', title: 'Blog' });
  await new Promise((resolve) => setTimeout(resolve, 400));
  await upsertGlobalPage(space, prefix, globalPageFields(prefix, routeScheme));
  await upsertGlobalView(space, prefix, globalIndexViewFields(prefix));
  await upsertGlobalView(space, prefix, aggregateFeedViewFields(prefix));
}

/**
 * Re-applies this bundle's own GLOBAL content in place - see
 * `guestbook-bundle.js`'s `updateGuestbook()` own doc comment for the full
 * "why upsert, why never routed through installX()" reasoning, identical
 * here. Never touches any already-published POST (a `realm: 'global'`
 * app's post is its own `adminPageKind` entry at its own route, untouched
 * by this - only the index page/View DEFINITIONS this bundle itself owns).
 * `routeScheme` should be the SAME value this app was installed/last
 * configured with (`admin-actions.js`'s own "Update verfügbar" button reads
 * it back off `app.config` and passes it straight through) - passing a
 * DIFFERENT one only changes the form's own template for POSTS PUBLISHED
 * AFTER this call; it never migrates already-published routes (the same
 * "no rename support" scope cut every other `updateX()`/`editX()` in this
 * codebase already accepts).
 */
export async function updateBlog(space, { prefix, routeScheme }) {
  await publishGlobalRoute(space, prefix, { route: '/', title: 'Blog' });
  await upsertGlobalPage(space, prefix, globalPageFields(prefix, routeScheme));
  await upsertGlobalView(space, prefix, globalIndexViewFields(prefix));
  await upsertGlobalView(space, prefix, aggregateFeedViewFields(prefix));
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
function personalPageFields(prefix, routeScheme) {
  const template = `/${prefix}${routeTemplate(routeScheme)}`;
  return {
    route: `/${prefix}/`,
    title: 'Mein Blog',
    data: { bundleVersion: BLOG_VERSION },
    content: `<h1>Mein Blog — Mein Feed</h1>
<p><a href="#/${prefix}/">← Globaler Feed</a> <a href="#/admin/${prefix}/cms" data-qu-admin-only hidden>⚙ Views verwalten</a></p>
<form data-qu-action="blog-post-form" data-qu-prefix="${prefix}" data-qu-mode="personal" data-qu-route-template="${template}">
  <label>Titel: <input name="title" required></label><br>
  <label>Route (z.B. "erster-post", nur Kleinbuchstaben/Zahlen/Bindestriche): <input name="slug" required pattern="[a-z0-9\\-]+"></label><br>
  <label>Inhalt (HTML):<br><textarea name="content" rows="6" cols="60" required data-qu-richtext></textarea></label><br>
  <label data-qu-admin-only hidden><input type="checkbox" name="alsoGlobal"> Auch im globalen Feed veröffentlichen</label><br>
  <button type="submit">Veröffentlichen</button>
  <button type="submit" data-qu-draft-btn>Als Entwurf speichern</button>
  <p data-qu-status></p>
</form>
<h2>Beiträge</h2>
<div data-qu-view="${prefix}-personal-index"></div>`,
  };
}

function personalIndexViewFields(prefix) {
  return { name: `${prefix}-personal-index`, sources: [{ type: 'pages', prefix: `/${prefix}/post/` }], sortBy: 'title', sortOrder: 'asc', itemTemplate: PERSONAL_ITEM_TEMPLATE };
}

/**
 * `routeScheme` (optional) - the SAME `qu-placeholders.js` scheme name the
 * GLOBAL blog was installed/configured with (`installed-apps-actions.js`'s
 * `provisionPersonalInstance()` threads `match.config` down to here, `boot.js`'s
 * own `platformAppsKind.config` doc comment) - a visitor's own personal blog
 * follows the SAME dated-or-flat convention the relay-admin picked for the
 * site overall, rather than needing its own separate setting.
 */
export async function installPersonalBlog(space, { prefix, routeScheme }) {
  const route = `/${prefix}/`;
  await createPage(space, personalPageFields(prefix, routeScheme));
  await publishRoute(space, { route, title: 'Mein Blog' });
  await createView(space, personalIndexViewFields(prefix));
}

/**
 * Re-applies THIS VISITOR's own personal blog content in place - see
 * `guestbook-bundle.js`'s `updatePersonalGuestbook()` own doc comment for
 * the full "why upsert, self-service, stamped version, never routed
 * through installX()" reasoning, identical here. Never touches any
 * already-published personal post. `routeScheme` - see `installPersonalBlog()`'s
 * own doc comment.
 */
export async function updatePersonalBlog(space, { prefix, routeScheme }) {
  const route = `/${prefix}/`;
  await upsertPage(space, personalPageFields(prefix, routeScheme));
  await publishRoute(space, { route, title: 'Mein Blog' });
  await upsertView(space, personalIndexViewFields(prefix));
}
