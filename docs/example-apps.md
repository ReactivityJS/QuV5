# Example apps: Guestbook, Blog, Forum, Chat

A practical companion to `architecture.md`'s own "Shared lists ... and
Views" section: four worked examples showing how far the EXISTING content
primitives (`pageKind`, `groupKind`, `privatePageKind`, `sharedListKind`,
`viewKind`, `defineCollectionKind()`) already get you, with real Dev-API
code, before you'd ever need a new Kind-Schema or a filesystem-based "app
module" (the still-open question `architecture.md` deliberately leaves
undecided). All four examples below are content-addressed Qu data, no
custom execution logic - the same "an app is Qu content, not code the
relay runs" posture every other app in this repo already follows (see
README.md's own "Writing and installing your own app").

Two recurring findings drove this document, both from real back-and-forth
about what these four apps actually need:

- **A Guestbook and a Blog need NO new Kind at all.** A blog post is just
  an ordinary page; a guestbook entry needs `acl.write: 'members'`
  (`sharedListKind`), which already existed once identified as the actual
  gap. Neither is a distinct "app" in any structural sense - see §1/§2.
- **A Forum and a simple Chat need no new Kind EITHER** - both are built
  entirely out of `sharedListKind` (many different authors posting to one
  shared list) plus `viewKind` (rendering that list live) - see §3/§4.
  Nothing here is Forum/Chat-specific: the exact same primitives, called
  through the exact same `@qu/app-core` Dev API, work for any future app
  in this shape (a Live-Ticker's own event log, a simple polls feature, a
  reaction/upvote counter, ...).

All code below is the Dev API (`import { ... } from '@qu/app-core'`) - the
same layer `packages/app-core/src/dev.js` exposes and every test in
`packages/app-core/test/` exercises directly, no CMS UI needed to follow
along. Wiring any of this into rendered pages (`<div data-qu-view="...">`,
`wireViews()`) works exactly as already documented in README.md's own
"Guestbooks and live Views" section - not repeated here.

**Guestbook, Blog, and Forum (§1-§3) are no longer just sketches - they are
real, ready-to-use apps** in `packages/app-shell/` (`guestbook-bundle.js`/
`blog-bundle.js`/`forum-bundle.js` for the content, `src/guestbook-actions.js`/
`src/blog-actions.js`/`src/forum-actions.js` for the interactivity), each
installable in one click from the built-in admin console's own "Beispiel-App
installieren" form (`#/admin`, `admin-console-bundle.js`/`admin-actions.js`'s
`APP_INSTALLERS`) - pick a path prefix, and the app is live at `#/<prefix>/`
immediately, no Dev API calls of your own needed. The code below still shows
the UNDERLYING primitives these bundles are built from (useful for a NEW app
in this shape, e.g. a Live-Ticker or Geo Chase wanting the same "content
features as reusable building blocks" - the reason the View-rendering code
lives in `@qu/app-shell` rather than baked into the CMS).

**Chat (§4) is also real now** - `apps/chat/` (`bundle.js`/`actions.js`/
`index.js`), installed the exact same one-click way. It lives under `/apps/`
rather than next to Guestbook/Blog/Forum in `packages/app-shell/` for a
structural reason, not a maturity one: see `apps/README.md`'s own "Template +
Data vs. genuine code" dividing line, and §5 below.

**Two corrections the SHIPPED bundles make that the sketches below still
predate:**
- **All three are `realm: 'global'` apps, anchored on their own prefix
  (`globalAppAnchor()`, `kinds.js`'s own `adminViewKind` doc comment), NOT
  self-owned `realm: 'main'` ones.** Installing several of these reference
  apps from the SAME admin session (the relay-admin's own identity) as
  `realm: 'main'` apps used to derive the exact SAME content-addressed id
  for every one of their own index pages - a real, observed bug (every
  prefix silently showing whichever app's write won that shared slot).
  Anchoring on the prefix instead gives each install its own, collision-free
  namespace, and comes with the admin console's existing mode toggle
  (Aus/Global/Multi-User) and "Verwalten"/"Besuchen" links for free.
- **Forum's topics/replies (§3) are `'members'`-ACL shared-list entries
  ONLY - never a separate `qu-page` per topic**, unlike the sketch below.
  A `qu-page` (self-owned or `'relay-admins'`-owned) can only ever be
  written by its own owner or a relay-admin - "any Space member can start a
  topic," a forum's whole point, is impossible to build on it. The shipped
  `forum-bundle.js`/`forum-actions.js` store a topic's full title/author/body
  directly in its own `${prefix}:topics` entry and render "open topic X" as
  in-page client state (no separate route) - see `forum-bundle.js`'s own top
  doc comment for the full reasoning and the resulting trade-off (no
  bookmarkable per-topic URL).

## 1. Guestbook

The reference case `sharedListKind` was built for - see architecture.md's
own "Shared lists ... and Views" section for the full "why `'members'`-ACL,
not a Collection" reasoning.

```js
import { pushToSharedList, createPage, createView } from '@qu/app-core';

// Any CURRENT Space member may call this, for any name, any time - no
// "create the guestbook first" step (pushToSharedList()'s own doc comment).
await pushToSharedList(space, 'guestbook', { name: 'Alice', message: 'Schöne Seite!' });

// A page that simply declares where the feed goes:
await createPage(space, {
  route: '/gaestebuch',
  title: 'Gästebuch',
  content: '<h1>Gästebuch</h1><div data-qu-view="guestbook-feed"></div>',
});

// The View that turns the raw list into a rendered feed:
await createView(space, {
  name: 'guestbook-feed',
  sources: [{ type: 'shared-list', name: 'guestbook' }],
  sortBy: 'timestamp',
  sortOrder: 'desc',
  itemTemplate: '<p><strong><qu-slot name="title"></qu-slot>:</strong> <qu-slot name="excerpt"></qu-slot></p>',
});
```

That's the entire app. `packages/app-core/test/shared-list.test.js` proves
the concurrent-writer property (two different identities each posting
their own entry, a non-member's write rejected); `packages/app-shell/test/
view-actions.test.js` proves the live rendering.

## 2. Blog

No new Kind - a blog post is an ordinary `qu-page`, and "the blog index"
is just `resolveRoutes()` (or a View's `'pages'` source) filtered to a
route prefix. The "Blog app" is entirely the glue below, nothing more -
this is the concrete answer to "wäre ein Blog überhaupt eine eigene App,
oder nur Pages mit Templates?".

```js
import { createPage, publishRoute, createView } from '@qu/app-core';

// Each post is just a page, published like any other:
await createPage(space, { route: '/blog/erster-post', title: 'Erster Post', content: '<p>Hallo Welt!</p>' });
await publishRoute(space, { route: '/blog/erster-post', title: 'Erster Post' });

// The index page:
await createPage(space, {
  route: '/blog',
  title: 'Blog',
  content: '<h1>Blog</h1><div data-qu-view="blog-index"></div>',
});
await createView(space, {
  name: 'blog-index',
  sources: [{ type: 'pages', prefix: '/blog/' }],
  sortBy: 'title',
  sortOrder: 'asc',
  itemTemplate: '<a data-qu-view-link><qu-slot name="title"></qu-slot></a>',
});
```

A NEW post is just another `createPage()` + `publishRoute()` call - the
index View picks it up live, no re-publish of the index itself needed
(`view-sources.js`'s `'pages'` adapter observes the route registry's own
`routes` list field). Publishing through the CMS editor instead of the Dev
API works identically - `cms-actions.js`'s `wirePages()` already calls
`publishRoute()` on every save.

**A "user-feed" combining a blog AND a guestbook** (the motivating example
for Views existing at all) is simply a View with both source types at
once:

```js
await createView(space, {
  name: 'user-feed',
  sources: [
    { type: 'pages', prefix: '/blog/' },
    { type: 'shared-list', name: 'guestbook' },
  ],
  sortBy: 'title',
  sortOrder: 'asc',
  itemTemplate: '<a data-qu-view-link><qu-slot name="title"></qu-slot></a>',
});
```

See `packages/app-core/test/views.test.js` for this exact combination,
proven live (a new post AND a new guestbook entry each update the merged
feed with no reload).

## 3. Forum

A forum needs two things a guestbook doesn't: (a) many different authors
starting NEW, independently-addressable threads (not just flat entries),
and (b) replies nested under each thread. Both map onto `sharedListKind` -
one NAMED list for the topic index, and one MORE named list PER TOPIC for
that topic's own replies (`sharedListAnchor(name)`'s own doc comment: "a
deployment can run as many named lists as it wants" - nothing stops a name
from being computed per-topic at runtime).

```js
import { pushToSharedList, resolveSharedList, createPage, publishRoute, createView } from '@qu/app-core';

// --- Starting a new topic ---
async function startTopic(space, { title, authorName }) {
  const topicId = crypto.randomUUID();
  // The topic index: title + a short byline, linking to the topic's own page.
  await pushToSharedList(space, 'forum-topics', {
    name: title,
    message: `von ${authorName}`,
    ts: Date.now(),
    route: `/forum/topic/${topicId}`,
  });
  // The topic's own page holds the ORIGINAL POST plus its reply feed:
  await createPage(space, {
    route: `/forum/topic/${topicId}`,
    title,
    content: `<p>${authorName} schreibt:</p><div data-qu-view="topic-${topicId}-replies"></div>
      <form data-qu-action="forum-reply-form" data-topic="${topicId}"><textarea name="message"></textarea><button>Antworten</button></form>`,
  });
  await createView(space, {
    name: `topic-${topicId}-replies`,
    sources: [{ type: 'shared-list', name: `forum-topic-${topicId}` }],
    sortBy: 'timestamp',
    sortOrder: 'asc',
    itemTemplate: '<p><strong><qu-slot name="title"></qu-slot>:</strong> <qu-slot name="excerpt"></qu-slot></p>',
  });
  return topicId;
}

// --- Replying (any Space member, not just the topic's own author) ---
async function reply(space, topicId, { authorName, text }) {
  await pushToSharedList(space, `forum-topic-${topicId}`, { name: authorName, message: text, ts: Date.now() });
}

// --- The forum's own front page: every topic, newest first ---
await createPage(space, { route: '/forum', title: 'Forum', content: '<h1>Forum</h1><div data-qu-view="forum-topics-feed"></div>' });
await createView(space, {
  name: 'forum-topics-feed',
  sources: [{ type: 'shared-list', name: 'forum-topics' }],
  sortBy: 'timestamp',
  sortOrder: 'desc',
  itemTemplate: '<p><a data-qu-view-link><qu-slot name="title"></qu-slot></a> <qu-slot name="excerpt"></qu-slot></p>',
});
```

Every write above (`startTopic()`, `reply()`) works for ANY current Space
member, not just whoever registered the app - exactly the "everyone may
post, nobody's post can silently disappear behind an ACL they don't have"
property a forum needs. The `<form data-qu-action="forum-reply-form">` in
`startTopic()`'s page content is INERT markup (Stufe 1 - content is never
executable) until a bit of framework-provided interactivity wires it up,
the exact same "content stays inert, framework code attaches by attribute
convention" posture `cms-actions.js`'s own forms already use - see that
file's own top doc comment for the pattern to follow if you build this
form's own submit handler (it would call `reply()` above).

**Left out on purpose, real future work, not attempted here:**
- Editing/deleting a reply once posted (`sharedListKind`'s own "ONLY
  ADDITIVE" doc comment - no removal primitive by design; moderation is
  explicitly out of scope for now).
- A reply COUNT on the topic index without opening every topic's own
  reply list (would need the topic index entry to be updated whenever a
  reply lands - not automatic today).
- Private/moderated forums (combine with `groupKind` + a `'members'`-ACL
  check before allowing `startTopic()`/`reply()` at the APPLICATION layer;
  `sharedListKind` itself always allows every Space member, `architecture.md`'s
  "A fourth ACL mode" section explains why there's no narrower built-in
  option here).

## 4. Chat (simple, public form)

The simplest possible case - ONE shared list, ONE View, nothing per-topic:

```js
import { pushToSharedList, createPage, createView } from '@qu/app-core';

async function sendMessage(space, { senderName, text }) {
  await pushToSharedList(space, 'general-chat', { name: senderName, message: text, ts: Date.now() });
}

await createPage(space, {
  route: '/chat',
  title: 'Chat',
  content: '<h1>Chat</h1><div data-qu-view="general-chat-feed"></div>',
});
await createView(space, {
  name: 'general-chat-feed',
  sources: [{ type: 'shared-list', name: 'general-chat' }],
  sortBy: 'timestamp',
  sortOrder: 'asc',
  itemTemplate: '<p><strong><qu-slot name="title"></qu-slot>:</strong> <qu-slot name="excerpt"></qu-slot></p>',
});
```

Every member sends into the SAME list, and `openLiveView()`'s own
subscription means every connected visitor sees a new message the moment
it lands - no polling, no page reload. This is genuinely a working,
public, single-channel chat with the primitives that already exist.

**What this is NOT (by design, not oversight) - real, separate future
work for anything beyond "a simple form":**
- **Multiple/private channels**: combine with `groupKind` (a channel's
  membership) + `privatePageKind`-shaped encrypted fields instead of a
  plain `sharedListKind` (whose fields are always `visibility: 'public'`)
  - but see architecture.md's own "not retroactive" section first: a
  member added to a channel's group LATER never retroactively decrypts
  messages sent before they joined, by design (the same guarantee real
  E2E group messaging gives). A plain, public `sharedListKind` channel
  (this section) sidesteps that entirely by not being encrypted at all -
  a real, explicit tradeoff to be aware of, not a limitation to work around.
- **Read receipts, typing indicators, presence**: `@qu/space-core`'s own
  `presenceKind`/typing primitives (see `docs/v5-space-core-guide.md`)
  are the right building block for these, not `sharedListKind` - a
  separate integration, not attempted here.
- **Editing/deleting a sent message**: same "ONLY ADDITIVE" constraint as
  the Forum's replies above.

## 5. Building an app entirely through the admin console - no bundle.js, no script

Every primitive §1-§4 use by hand (a `sharedListKind`-backed feed, a
route-bound `viewKind`) is ALSO reachable purely through the admin
console's own rendered UI, with zero Dev API calls of your own - the exact
mechanism `guestbook-bundle.js`/etc. are themselves built on, just driven
by forms instead of a script. Concretely, for a brand-new
"Notizbrett"-style board (a public, many-author feed - structurally
identical to §1's Guestbook):

1. **Register a blank `realm: 'global'` app** - `#/admin`'s "App
   registrieren" form, or (for now) a direct `registerApp(space, {prefix,
   name, realm: 'global'})` call - no installer, no `bundle.js`.
2. In the resulting app's row, type a **new shared-list name** (e.g.
   `notesboard-entries`) into the field next to **"Views/Seiten (CMS)"**
   and click it. This does two things, in order: `addSharedLists()`
   (`@qu/app-core`'s `dev.js` - the relay has to be told a `'members'`-ACL
   list's NAME before anything can write to it, same reasoning `sharedLists`
   already documents for a bundle's own install step) registers the list,
   then `installGlobalCms()` self-provisions this app's own Templates/
   Styles/Pages/**Views** editor (`cms-bundle.js`) and navigates to
   `#/admin/<prefix>/cms`.
3. In the rendered **"Views (live Feeds)"** section, create a View: a
   name, `sources: [{"type":"shared-list","name":"notesboard-entries"}]`,
   `sortBy: "timestamp"`, an `itemTemplate`, and - the part that connects a
   PATH to this generated View - a **route** (e.g. `/`). Submitting
   self-registers the View's own name too (`addGlobalViewNames()`,
   automatic, the same "tell the relay the name before writing it" step,
   no separate button for this one - the form already knows the name the
   moment it's typed) and auto-creates a wrapper page at that route
   containing just `<div data-qu-view="...">`.
4. **Header/footer, e.g. a sign-form above or below the list** (the
   concrete case that started this whole section: a Gästebuch-style page
   needs BOTH a feed AND a way to add to it): there is no separate
   "header"/"footer" field - the auto-created wrapper page from step 3 is
   itself ordinary, freely editable content. Go to the **"Seiten"** section
   of the SAME editor, load that page (its route matches what you typed in
   step 3), and edit its `content` to wrap the existing
   `<div data-qu-view="...">` in a GENERIC, fully declarative write form -
   `generic-write-actions.js`'s own `data-qu-action="qu-write"` convention,
   wired unconditionally alongside every other reference app
   (`installed-apps-actions.js`'s `wireInstalledApps()`), so it needs no
   registration step of its own:
   ```html
   <h1>Notizbrett</h1>
   <div data-qu-view="notesboard-feed"></div>
   <form data-qu-action="qu-write" data-qu-target="shared-list" data-qu-list="notesboard-entries">
     <input name="name" placeholder="Name">
     <input name="message" placeholder="Nachricht">
     <button type="submit">Eintragen</button>
     <p data-qu-status></p>
   </form>
   ```
   Every NAMED field (`name`/`message` here) becomes one key of the pushed
   entry, plus an automatic `ts: Date.now()` - the SAME `{name, message,
   ts}` shape the `'shared-list'` View source adapter already expects
   (`view-sources.js`'s own doc comment), so the feed above picks up a
   submission immediately, live, no reload. The View itself never needs to
   change for this - only the page around it. `data-qu-target="page"`
   (`data-qu-route="/post/{yyyy}/{mm}/{dd}/{slug}"`, say) is the SAME
   convention's other shape - publishing a brand-new PAGE instead of a
   shared-list entry, `data-qu-scope="global"` + `data-qu-prefix="..."` for
   a relay-admin-only write, self-owned by default - see
   `generic-write-actions.js`'s own top doc comment for the full attribute
   reference, and the "Date-based archive routing" section below for why a
   route template like that one is worth building at all.

This is genuinely how far you can get with ZERO files today for an app
that fits "Template + `qu-list`/`qu-bind`/`qu-view` data source" - see
`apps/README.md`'s own dividing line for what does and doesn't qualify,
and §6 below for the file-based side of that line.

## 6. `/apps/*` - when a Template genuinely isn't enough

`apps/README.md` has the full convention (`apps/<name>/index.js`,
discovered at build time, administered identically to §1-§4 through the
SAME admin console). Chat (§4) is the first resident, kept deliberately
simple for now (one shared list, one View - it could, today, have been
built via §5's own UI-only workflow instead). The reason it lives here
regardless: the planned direction for it - sharing a live location,
message reactions, a Slots-style extension point other apps register
actions/UI into (the QuV3 precedent this project is drawing on: a shared
menu/toolbar that apps contribute entries to without the host needing to
know about them in advance) - is genuine per-message CODE, not a
different shape of content a Template could express. `architecture.md`'s
own still-open "app modules" question is answered for exactly this shape
of app now; genuine custom EXECUTION logic beyond "a real relay write" per
interaction (a Geo Chase's own game rules, a Live-Ticker's event-scoring)
remains real, separate future work.

## Personal-instance routing: the additive `/u/<ref>/` scheme

Guestbook and Blog (§1-§2) also support a PERSONAL instance per visitor,
additive to the app's own global one (never replacing what the bare prefix
means - `boot.js`'s `renderMultiUserRoute()` own top doc comment has the
full reasoning): `#/<prefix>/u/<ref>/`, where `ref` is `"me"` (the
default) or another identity's own base64url pubkey.

**The same address also works WITHOUT the literal `"u/"` marker** - a bare
pubkey segment is unambiguous enough on its own (the exact same "does this
look like a pubkey" test `PlatformRuntime`'s own top-level prefix fallback
already uses, `boot.js`'s `parseMultiUserSubPath()` own doc comment): `#/
blog/<pub>/` reaches that identity's own feed, `#/blog/<pub>/post/<slug>`
one of their own posts - not just the longer `#/blog/u/<pub>/post/<slug>`
form. `"me"` is not a valid pubkey and only ever works with the explicit
`/u/me/` spelling - self-provisioning stays gated on that literal string,
never inferred from "this happens to be my own pubkey" (reading someone
ELSE's still-empty page must never conjure content into THEIR name).

Concretely, for Blog:

| Route | Resolves to |
|---|---|
| `#/blog/` | the relay-admin-curated GLOBAL feed |
| `#/blog/<pub>/` | that identity's own personal blog's index |
| `#/blog/<pub>/post/<slug>` | one of their own posts |

Posts stay nested under the owner's own address (`/post/<slug>`, not a
flat `/blog/<slug>` sitting directly next to the index) rather than at some
independent, owner-agnostic path - this is a real constraint, not a
stylistic choice: a personal post is self-owned content, addressed as
`(ownerPub, kind, route)` (`kinds.js`'s own doc comment) - the router needs
to already know BOTH pieces to resolve anything at all, and the URL itself
is the only place both are available without a separate slug→owner lookup
registry (a real, buildable primitive, just not one that exists today, and
arguably not worth building only to shave one path segment off a URL that
already reads perfectly clearly with it).

## Date-based archive routing for Blog: `routeScheme`

A QuV3 requirement raised again here: a blog post's own route segmented by
date (`yyyy/mm/dd`, or just `yyyy/mm`, or `yyyy`) so a year/month/day
ARCHIVE view is possible at all. The short answer for the Yjs-based V5
storage layer: **yes, still worth having, and it costs no new resolver
code** - `view-sources.js`'s `'pages'` View source already filters by a
plain STRING PREFIX on the route (`§2`'s own `prefix: '/blog/'` for the
whole-blog index); once a post's own route is itself hierarchical
(`/post/2026/09/07/erster-post` rather than the flat `/post/erster-post`
default), that SAME `prefix` param already gives a year (`/post/2026/`), a
month (`/post/2026/09/`), or a day (`/post/2026/09/07/`) archive for free -
one MORE `viewKind` per granularity wanted, nothing else.

Blog's own admin-console install form (`admin-console-bundle.js`) offers a
**"Datums-Schema für Beiträge"** `<select>` - `flat` (the pre-existing,
unprefixed default), `yyyy`, `yyyy/mm`, or `yyyy/mm/dd`
(`qu-placeholders.js`'s own `ROUTE_SCHEMES` map). The choice is persisted
into the app's own `qu-platform-apps` `config` (`kinds.js`'s own doc
comment, `dev.js`'s `setAppConfig()`) so a LATER "Update verfügbar" click,
or a visitor's own personal-blog self-provisioning, picks the SAME scheme
back up automatically. Concretely, choosing `yyyy/mm/dd` bakes a
`data-qu-route-template="/post/{yyyy}/{mm}/{dd}/{slug}"` attribute onto the
Blog's own post form (`blog-bundle.js`); `blog-actions.js`'s `wireBlog()`
resolves it at SUBMIT time via `qu-placeholders.js`'s `resolvePlaceholders()`
- `{yyyy}`/`{mm}`/`{dd}` from TODAY's date, `{slug}` from the form's own
field - so a post published today always lands under today's own archive
segment, permanently (never recomputed later; the route is fixed the
moment the page is created, same as any other content-addressed Node).

Building an actual archive View is then just ANOTHER `createGlobalView()`
call (or the SAME "Views/Seiten (CMS)" editor §5 describes), narrower than
Blog's own unfiltered index:

```js
import { createGlobalView } from '@qu/app-core';

await createGlobalView(space, 'blog', {
  name: 'blog-2026-09',
  sources: [{ type: 'pages', prefix: '/post/2026/09/' }],
  sortBy: 'title',
  sortOrder: 'asc',
  route: '/2026/09',
  itemTemplate: '<p><a data-qu-view-link><qu-slot name="title"></qu-slot></a></p>',
});
```

**Not attempted here**: a SINGLE archive View that reads the currently
VISITED month straight off the URL (`#/blog/2026/09` rendering that
month's own posts without a separate View per month) - today's Views are
static, pre-configured records (`view-sources.js`'s own top doc comment:
"`config` is read ONCE... editing a View's `sources`... only takes effect
the NEXT time"), so this would need the router itself to extract date
segments and pass them into View resolution as a dynamic parameter, the
same class of extension `boot.js`'s own personal-instance `{ref}` capture
already does for identity - real, separate, buildable future work, not
needed for the "one archive View per month a relay-admin explicitly wants"
case above.

**Beyond dates**: `qu-placeholders.js`'s `AMBIENT_PLACEHOLDERS` is a small,
explicitly extensible map (currently `{yyyy}`/`{mm}`/`{dd}`/`{pub}`) - a
future `{alias}` (once a human-readable alias registry exists), or any
other ambient value a route/list-name template might want, is a ONE-LINE
addition there, usable immediately from every declaratively-configured
template in the app shell (a `routeScheme`, a `data-qu-route`/`data-qu-list`
on a generic write form, §5's own `notesboard-entries` example) with no
change anywhere else.

## Where the four examples actually differ

| | New Kind needed? | Who may post | Structure |
|---|---|---|---|
| Guestbook | No (`sharedListKind`) | any Space member | one flat list |
| Blog | No (`pageKind` + `routeRegistryKind`) | the page owner (or a `grantContentWriter()`ed co-editor) | one page per post |
| Forum | No (`sharedListKind`, twice) | any Space member | one list of topics, one list of replies PER topic |
| Chat | No (`sharedListKind`) | any Space member | one flat list, no per-item substructure |

None of the four needed a new Kind-Schema, and building one at all (§5)
turned out to be optional even for a brand-new app, never mind a change to
`@qu/space-core`/`@qu/space-transport` - the generic primitives (self-owned
content, member-writable shared lists, live merging Views) already cover
this whole class of app. §6/`apps/README.md` covers what genuinely needs
more: custom EXECUTION logic (e.g. game rules for a "Geo Chase," a
Live-Ticker's own event-scoring, Chat's own planned location/reactions/
Slots work), not just a different shape of content.
