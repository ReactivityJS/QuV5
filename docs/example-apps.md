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
lives in `@qu/app-shell` rather than baked into the CMS). Chat (§4) remains a
sketch only - no installable bundle exists for it yet.

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

## Where the four examples actually differ

| | New Kind needed? | Who may post | Structure |
|---|---|---|---|
| Guestbook | No (`sharedListKind`) | any Space member | one flat list |
| Blog | No (`pageKind` + `routeRegistryKind`) | the page owner (or a `grantContentWriter()`ed co-editor) | one page per post |
| Forum | No (`sharedListKind`, twice) | any Space member | one list of topics, one list of replies PER topic |
| Chat | No (`sharedListKind`) | any Space member | one flat list, no per-item substructure |

None of the four needed a new Kind-Schema, a filesystem-based "app
module," or any change to `@qu/space-core`/`@qu/space-transport` - the
generic primitives (self-owned content, member-writable shared lists,
live merging Views) already cover this whole class of app. See
architecture.md's own still-open "app modules" question for what
WOULD eventually need more than content: genuine custom EXECUTION logic
(e.g. game rules for a "Geo Chase," a Live-Ticker's own event-scoring),
not just a different shape of content.
