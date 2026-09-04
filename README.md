# Qu V5

A from-scratch, **Yjs-native**, UI-agnostic framework for building
distributed, real-time-synced apps: every Node is a real `Y.Doc`, every
field is typed via a Kind-Schema (independent `shape`/`visibility` per
field, three ACL modes), and every outgoing Yjs update is signed
(Ed25519) and — where declared — end-to-end encrypted (X25519 + AES-GCM)
before it ever reaches storage or a transport. A relay forwards live only
to a Node's actual subscribers and can mirror/compact these envelopes
without ever holding a decryption key — it verifies signatures, nothing
more — and relays can federate with each other the same way a client
subscribes to one.

This repository is the Yjs-native line of work carried over from Qu's V3
evaluation branch, kept to exactly what that redesign needs - no V3/V4
platform code, and no backward-compatibility constraints during this build.

**Start here:**
[`architecture.md`](./architecture.md) is the bird's-eye map (repo
layout, framework concept, file-by-file purpose, full API reference) —
kept up to date with every architectural change. For the practical
how-to, see [`docs/v5-space-core-guide.md`](./docs/v5-space-core-guide.md)
(the `Space`/`Node`/`Field` API, what's actually cryptographically
enforced, the local-first query API, alias identities, compaction,
federation, reconnect/resync, per-Kind persistence tiers, the optional
`@qu/space-plugins`/`@qu/space-ui` add-ons, and how to run a relay
standalone or via Docker).

## Packages

- [`packages/core`](./packages/core) - `@qu/core`: `QuCrypto`, the minimal
  crypto primitives (Ed25519 signing, X25519/AES-GCM encryption, key
  fingerprinting, deterministic key derivation) everything else builds on.
- [`packages/space-core`](./packages/space-core) - `@qu/space-core`: the
  `Space`/`Node`/`Field` API, envelope signing/encryption (public + encrypted
  modes, compaction snapshots), Kind-Schema (shape/visibility/ACL), signed
  grants, and space-scoped alias identities.
- [`packages/space-storage`](./packages/space-storage) - `@qu/space-storage`:
  memory / in-process-durable / real-on-disk persistence adapters, all
  storing the same sealed envelopes that go out over the wire, all
  supporting compaction (`replace()`).
- [`packages/space-transport`](./packages/space-transport) -
  `@qu/space-transport`: in-process transport (for tests), a real WebSocket
  transport + relay (subscriber-tracking, node-level ACL enforcement,
  relay-to-relay federation), presence tracking, a pluggable
  push-notification handler, and the relay's Docker deployment.
- [`packages/events`](./packages/events) - `@qu/events`: `EventBus`, a
  granular, dot-namespaced, wildcard-matching (`*`/`**`) pub/sub primitive -
  the ONE hooks/listeners/slots mechanism used for domain notifications,
  Space/Node change events, and relay-side routing/debugging alike,
  client-side and relay-side.
- [`packages/space-plugins`](./packages/space-plugins) - `@qu/space-plugins`
  (optional): delivery-status helpers (write-ack correlation, durable
  read receipts) and `UploadOutbox` (local-save-then-sync file upload
  queue with retry) - built entirely on `@qu/space-core`'s public API.
- [`packages/space-ui`](./packages/space-ui) - `@qu/space-ui` (optional):
  vanilla JS/DOM reactive bindings - one/two-way field binding,
  contenteditable inline-edit with save/cancel, keyed list diffing,
  file-selection + upload-status icons - no framework, no build step.
- [`packages/app-core`](./packages/app-core) - `@qu/app-core`: the App
  Runtime - Kind-Schemas for application content (manifest, route registry,
  pages, templates, styles), content-addressed Node ids, `ContentResolver`,
  `HashRouter`, `AppRuntime`, and a Dev/Admin API to bootstrap an empty
  Space into a working app.
- [`packages/app-renderer`](./packages/app-renderer) - `@qu/app-renderer`:
  turns a resolved Template + Page into DOM - HTML sanitizing, `<qu-slot>`
  resolution, style injection.
- [`packages/app-shell`](./packages/app-shell) - `@qu/app-shell`: the
  minimal, application-agnostic bootstrap kernel a Relay serves (a single
  `<qu-app-shell>` element - no concrete page/app hardcoded), plus its OWN
  production `relay-server.js`/`Dockerfile` (see "Deploying the App Shell"
  below) - see `architecture.md` §7 and
  [`docs/app-shell-arbeitsauftrag.md`](./docs/app-shell-arbeitsauftrag.md)
  for the full design.

## Development

```sh
npm install
npm test        # every package's tests, via node --test
```

## Try it: runnable demos

```sh
npm run demo
```

Runs a self-contained, zero-setup demo of the CORE framework (`@qu/core`/
`@qu/space-core`, no App layer involved yet): two identities exchange chat
messages through an in-process relay with presence-gated push routing,
then a third, unrelated identity discovers and reads a public,
self-certifying `'owner'`-ACL Node knowing only its owner's pubkey - no
Space membership needed.

**For the App layer** - a real relay, an Admin-UI, and a CMS-managed
shell-app, all genuinely installed Qu content rather than hardcoded pages -
see "Deploying the App Shell" right below; that's now also the featured
"real, multi-process, real-browser" demo (`demo/README.md`'s own opening
section points there first). The old hardcoded CLI/browser chat demo (two
separate terminals over a real WebSocket relay) still exists, unchanged,
under `npm run demo:legacy-chat-relay` - see `demo/README.md`'s "Real
thing" section.

## Deploying the App Shell (the default)

```sh
docker compose -f docker-compose.space-relay.yml up -d
```

Serves `@qu/app-shell` in PLATFORM mode (a Relay-Admin-owned `#/admin`
console + as many CMS-managed shell-apps as you register) - a SEPARATE
image from the core `@qu/space-transport` relay, so the framework layer
never depends on an application-layer package (see
`packages/space-transport/src/relay-server.js`'s own doc comment). This is
now the DEFAULT service - no `--profile` needed. Works the same under
`docker stack deploy` (Swarm) - see "Docker Swarm / `docker stack`" below
for the one thing that's different there (pre-built images).

Starts fine with zero configuration (a setup page instead of a platform).
Getting to an actually-configured platform is always the SAME two steps,
regardless of how you deploy - Compose, `docker stack`, Kubernetes, bare
metal:

```sh
npm run bootstrap:platform
```

**Run this from ANYWHERE with network access to your relay's URL - your
own laptop, a CI runner, wherever is easiest** (never touches your
deployment config either way): it generates a single `relay-admin`
identity locally, then either

**A REAL FOOTGUN if you run it via `docker exec` into the SAME container
you'll later redeploy** (common on managed platforms like Rancher/
Kubernetes where a separate machine/toolchain is inconvenient): the
identity it generates defaults to a path INSIDE the container's own
filesystem, which does NOT survive a redeploy - the symptom is a
brand-new `relay-admin` pubkey printed every time you run it, and the OLD
relay-admin loses write access to everything it previously administered
once its identity is gone. If you must run it this way, set
`QU_BOOTSTRAP_DIR` (or pass `--dir`) to a path backed by a volume that
actually survives redeploys - `docker-compose.space-relay.yml`'s own
`qu-app-shell-relay-admin-identity` volume (mounted at `/admin-identity`,
`QU_BOOTSTRAP_DIR` already defaults to it there) is the reference setup;
back that volume up like you would any other private key. The script
itself warns loudly when `--dir`/`QU_BOOTSTRAP_DIR` isn't set, for exactly
this reason.

- the relay isn't configured yet → **prints the exact `QU_RELAY_ADMINS`
  value** (a plain JSON array of base64 pubkeys, public keys only - the ONE
  static list a platform deployment needs) for YOU to paste into however
  you manage your deployment's environment - `docker-compose.space-relay.yml`
  directly, your own `docker stack` file, a Kubernetes manifest, systemd,
  whatever - then redeploy however you already do (`docker compose up -d`,
  `docker stack deploy`, ...) and run the SAME command again; or
- the relay already has them (this second run, or any later one) →
  installs the admin console AND registers the built-in **"cms"** app as
  `realm: 'global'`, `mode: 'multiuser'` (see "Three administrable states"
  below) under `#/admin` and `#/cms` respectively, and prints the exact
  URLs plus a ready-to-paste browser devtools snippet for the relay-admin
  identity. There is no second "app-admin" identity any more - see
  "WHY THERE IS NO SECOND/APP-ADMIN IDENTITY ANY MORE" in
  `bin/bootstrap-platform.mjs`'s own doc comment for the full reasoning:
  every visitor gets their own self-owned CMS space at `#/cms/` the moment
  they visit it, with zero cooperation from this script or any relay-admin.

**You don't have to use the generated `relay-admin` identity at all** -
`#/admin` is ordinary content in the SAME main Space, gated only by
`acl.write: 'relay-admins'` (checked against `QU_RELAY_ADMINS`, nothing
else). Any pubkey works there the instant it's listed, including an
operator's own already-existing browser identity (visible on the relay's
unconfigured setup page, or via `window.Qu.pub` in devtools on any already
configured page) - just add IT to `QU_RELAY_ADMINS` too, no separate
identity to generate or import into the browser.

**"Does the relay itself need an entry in `QU_RELAY_ADMINS`?" - no.** Every
entry is a HUMAN/OPERATOR identity - an Ed25519 keypair someone actually
holds the private half of and signs writes with (a browser's `localStorage`
identity, `relay-admin`'s files under `--dir`, or any other client
identity) - never the relay PROCESS's own. `packages/app-shell/
relay-server.js` has no identity of its own at all; it only ever CHECKS
signatures against the pubkeys you list, it never signs anything itself.
(`@qu/space-transport`'s plain `relay-server.js` - the legacy chat relay,
a different binary - DOES persist its own identity, but that one is used
exclusively for relay-to-relay FEDERATION trust, unrelated to
`QU_RELAY_ADMINS`/app content entirely - see that file's own doc comment.)
So the only identities that ever belong in `QU_RELAY_ADMINS` are whichever
people (or CI/automation identities acting on their behalf) you want to be
able to administer this platform's global apps.

**"How do I know if the admin/cms content actually deployed?" - it needs
`QU_RELAY_ADMINS` set BEFORE either exists.** `#/admin` and `#/cms` are
both `realm: 'global'` content, `acl.write: 'relay-admins'` - the very
FIRST `bootstrap:platform` run (before you've pasted `QU_RELAY_ADMINS`
anywhere) can connect to an unconfigured relay fine, but every one of its
writes is silently rejected, so nothing is actually installed yet. That's
what the "two runs" flow above is for: run once to get the relay-admin
pubkey, configure+redeploy your relay with it, THEN run again to actually
install content - the script itself tells you which state you're in.

Two runs on a totally fresh setup is normal, not a bug - see
`packages/app-shell/bin/bootstrap-platform.mjs`'s own doc comment for the
full "why" (in short: env vars are read once at relay boot, so it can't
verify your paste took effect without actually trying a write and seeing
if the relay acks it). Safe to re-run any time afterward too - every step
checks first, never re-creates content that already exists.

For a single, fixed app instead of a platform, set `QU_APP_ADMIN_PUB`
directly (ignored once `QU_RELAY_ADMINS` - platform mode - is also
set) - see the guide's own walkthrough.

**Docker Swarm / `docker stack`:** `docker stack deploy` doesn't build
images the way `docker compose` does - build and tag the image yourself
first (on every node that needs it, or push to a registry all nodes can
pull from), THEN deploy:

```sh
docker build -f packages/app-shell/Dockerfile -t qu-app-shell-relay:latest .
docker stack deploy -c docker-compose.space-relay.yml <your-stack-name>
```

`profiles:` (used to gate the legacy chat relay behind an opt-in flag) is
a Compose-only concept Swarm doesn't understand - under `docker stack
deploy` that service deploys too, unconditionally (harmless - an idle
service on a different port - remove its block from your own copy of the
file if you'd rather it not run at all).

**"Noch keine Anwendung auf dieser Plattform installiert" / `#/admin`
shows the same thing, not the console** - this is the expected state
right after deploying alone, not a bug: starting the relay gives you an
EMPTY platform (a running Space, nothing written to it yet). `#/admin` is
an ORDINARY registered alias like any other (`architecture.md` §7 - "kein
Sonderfall zu normalen Spaces") - until something has actually registered
it AND installed the console's own content, it resolves to nothing, so it
falls through to this SAME generic landing page. `npm run bootstrap:
platform` (above) fixes both at once.

**The Admin-UI (`#/admin`) and a CMS editor (`#/<prefix>/cms`) are TWO
DIFFERENT things, at two different levels** - a common point of confusion:
- **`#/admin`** (platform/relay-admin level, ONE per platform) registers
  apps under path prefixes (`registerApp()`), flips a `realm: 'global'`
  app's mode (`setAppMode()` - the buttons next to each app in its own
  "Installierte Apps" list), and links to each `realm: 'global'` app's own
  "Verwalten" page (`#/admin/<prefix>/`, see the next bullet and "Three
  administrable states" below) - it has no generic content editor of its
  own. `bootstrap:platform` installs it for you; by hand, see
  `packages/app-shell/bin/install-admin-console.mjs`.
- **`#/<prefix>/cms`** (per-app) is where that app's OWN templates/styles/
  pages are actually created and edited - see architecture.md §7's "The
  built-in CMS editor." For an ordinary (`realm: 'main'`) app this is the
  app-admin's own `#/<prefix>/cms`, installed via `installCms(space)`
  (`@qu/app-shell`'s `cms-bundle.js`) into their OWN app's Space. For the
  built-in **"cms"** app itself (`realm: 'global'`, `mode: 'multiuser'`) it
  works differently - see the next section.

There is no CMS for `#/admin`'s own content specifically (its `qu-admin-*`
Kinds have no `edit*()` counterparts wired into that console's UI -
`bin/install-admin-console.mjs` remains the only way to update it).

**Any OTHER `realm: 'global'` app DOES get a page editor for free, though**
- relay-admins collectively administer every global app's content, not
just register it (see architecture.md §7's "Global apps, not just one
admin console"), via the exact same CMS editor UI wired against
`createGlobalPage()`/`editGlobalPage()`/`publishGlobalRoute()` instead of
an independently-owned app's own `create*()`/`edit*()` - ANY currently-
configured relay-admin can then edit ANY page there, not just whoever
created it first. Templates/styles are a deliberate, separate scope cut for
global apps (no dynamic registry for them yet - see the same
architecture.md section) - only the pages section of the CMS editor is
wired in global mode.

**Where that editor actually LIVES depends on the app's `mode`** (see
"Three administrable states" below):
- `mode: 'global'` (the default) - it's at the bare `#/<prefix>/cms`,
  exactly like an ordinary app's.
- `mode: 'multiuser'` - the bare `#/<prefix>/...` now means EACH VISITOR's
  own space instead (see below), so the app's own GLOBAL shell (and its
  editor) moves to `#/admin/<prefix>/...` - e.g. the built-in "cms" app's
  own global landing page's editor is at `#/admin/cms/cms`. The admin
  console's own "Installierte Apps" list links straight there
  ("Verwalten"), so you never have to remember or type this path by hand.

See "Writing and installing your own app" below for the two shapes an app
can take (ordinary vs. global) and which one this is right for.

## Writing and installing your own app

An "app" here is never code the relay runs - it is Qu content (a manifest +
templates + styles + pages, `@qu/app-core`'s Dev API, `kinds.js`) an
identity WRITES into the platform's one main Space, resolved and rendered
by the SAME `@qu/app-shell` bundle every other app uses. There is no
separate deploy/build step per app and no app registry beyond
`qu-platform-apps`'s optional alias. Two shapes to choose from:

**Ordinary app (`realm: 'main'`, the common case)** - owned by exactly ONE
app-admin identity, reachable at its own owner pubkey with zero relay-admin
involvement, `registerApp()` only ever adding a prettier `#/<prefix>` alias
on top. `packages/app-shell/bin/grant-app-access.mjs`'s own doc comment
walks through connecting as such an identity; the shape is:

1. Generate/persist an app-admin identity (`ensureIdentity()`-style: load
   from disk if it exists, generate + save a fresh Ed25519+X25519 keypair
   otherwise - same pattern `demo/lib/identity.mjs` and
   `bin/install-admin-console.mjs` both already use).
2. As a **relay-admin**, `registerApp(relayAdminSpace, {prefix, appAdminPub,
   name})` - wait for it to be relay-acked (`waitUntilAllWritesAcked()` in
   both bootstrap scripts) and let the relay's live resolver settle
   (~300ms) BEFORE step 3. This step is optional for reachability (an
   app-admin's content is always self-certifyingly reachable at their own
   owner id, `PlatformRuntime.resolveForPath()`'s registration-free
   fallback) but required for the nicer `#/<prefix>` URL, and for the
   relay to correctly classify this app-admin's registry Nodes as
   `'named'`-ACL instead of the generic `'content'`-ACL fallback (see
   architecture.md §7's "REGISTER FIRST, THEN SEED CONTENT").
3. Connect AS the app-admin identity (join the main Space - `POST /join`,
   or list it in `QU_MEMBERS_JSON` - needed for ordinary presence/`'members'`-
   ACL features, not for the content writes below, but every reference
   installer does it anyway) and write the app's content with `@qu/app-core`'s
   Dev API: `createApp()` (the manifest), `createTemplate()`, `createStyle()`,
   `createPage()` + `publishRoute()` for each page, or all of it in one call
   via `installAppBundle(space, {manifest, templates, styles, pages, routes})`.
4. Optionally `installCms(space)` (`@qu/app-shell`'s `cms-bundle.js`) so the
   app-admin (or anyone they `grantContentWriter()` to) can maintain pages/
   templates/styles live at `#/<prefix>/cms` afterward, instead of re-running
   a script for every change.

**Global app (`realm: 'global'`)** - no single owner; every currently-
configured relay-admin can install/edit its content, and a relay-admin
added LATER automatically gets the same access (`kinds.js`'s
`adminAppManifestKind`/`adminPageKind`/`adminTemplateKind`/`adminStyleKind`,
all `acl.write: 'relay-admins'`). Pick this when the content is genuinely
platform-owned rather than any one person's (the built-in admin console
itself is simply `registerApp({prefix: 'admin', realm: 'global'})` - not a
framework special case). As a relay-admin: `registerApp(space, {prefix,
realm: 'global'})` -> wait/settle -> `publishGlobalRoute(space, prefix,
{route, title})` for each page -> wait/settle -> `createGlobalApp()`/
`createGlobalTemplate()`/`createGlobalPage()` (or `installGlobalAppBundle()`
for all of it at once) - see `bin/install-admin-console.mjs` for the
reference installer and its own doc comment on why the ORDER of these steps
matters (`publishGlobalRoute()` before the matching `createGlobalPage()`,
every time). `#/<prefix>/cms` then works out of the box for any OTHER
relay-admin to maintain pages afterward (see the CMS section above) -
templates/styles still need a script (`createGlobalTemplate()`/
`editGlobalTemplate()`), the same scope cut mentioned above.

**Three administrable states for a global app, not a per-app relay
feature-gate** (`mode`, `registerApp()`/`setAppMode()`,
architecture.md §7's own "Three administrable states" section for the
full design reasoning) - `'off'` (unreachable, same as never registered),
`'global'` (the default - only relay-admins may write, exactly the
paragraph above), or `'multiuser'`.

**`mode: 'multiuser'` flips what the BARE `#/<prefix>/...` prefix means**:
instead of the app's global shell, it now resolves to the CURRENTLY
signed-in identity's own space by default - no `/u/me/` to type, no pubkey
to know or paste (that was the actual, reported UX problem this flip
fixes: a first-time visitor has no reason to know their own pubkey just to
reach their own content). A brand-new visitor's first-ever visit
self-provisions a minimal personal app + CMS editor on the spot, entirely
in their own, self-owned `'content'`-ACL namespace - zero registration,
zero grant, zero relay-admin cooperation beyond the app existing at all.
`#/<prefix>/u/<ref>/...` still works, explicitly, for the one thing a bare
prefix can't express - addressing "me" explicitly or another identity's
space on purpose (`ref` = `"me"`, or that identity's own base64url pubkey,
read-only unless they've granted you write access). The app's own GLOBAL
shell - what the bare prefix meant before this flip - moves to
`#/admin/<prefix>/...` instead, reachable only by a relay-admin (see
"Where that editor actually LIVES" above).

`setAppMode(space, {prefix, mode})` changes an ALREADY-registered app's
mode later (a relay-admin call, same as `registerApp()` itself) - see
`packages/app-shell/test/multiuser-app.test.js` for the reference example
(registers `"cms"` this way, two independent visitors each maintain their
own page with zero further cooperation, then a relay-admin turns it off).

**Exact example - deploying/re-registering an app as `multiuser`:**
`bin/set-app-mode.mjs` is the scriptable version of the admin console's own
mode buttons - and answers "how do I find the right prefix?" directly,
since there is no separate per-app "space" to look up (this whole platform
lives in ONE relay Space; `qu-platform-apps` is the one registry naming
every app in it):

```sh
# 1. List every registered app in this relay's ONE Space - this IS "finding the right prefix":
node packages/app-shell/bin/set-app-mode.mjs \
  --relay wss://your-host --dir ./bootstrap-identity
#   -> #/cms       realm=global  mode=multiuser  (CMS)
#   -> #/admin     realm=global  mode=global     (Relay-Admin)

# 2. Flip (or re-confirm) "cms" as multiuser - same relay-admin identity bootstrap-platform.mjs
#    already created under --dir, no separate identity to generate:
node packages/app-shell/bin/set-app-mode.mjs \
  --relay wss://your-host --dir ./bootstrap-identity --prefix cms --mode multiuser
```

Works identically for any OTHER `realm: 'global'` app you've registered
yourself under a different prefix - swap `cms` for that prefix.

**Verifying an install actually worked, not just that it ran**: a script
that only `await`s each write and prints "done" can be lying - a write to
`'relay-admins'`-ACL content is silently rejected if this identity isn't
(yet) actually configured as a relay-admin on the RUNNING relay (see
"Deploying the App Shell" above on why that's an easy state to be in right
after a fresh deploy). Track `debug.space.write.local` vs.
`space.node.*.write-ack` on the `Space`'s own `bus` and wait for every
expected write to be acked before reporting success - `bootstrap-
platform.mjs`'s `trackWrites()`/`waitUntilAllWritesAcked()` (also now used
by `install-admin-console.mjs`) is the reference implementation; copy it
into your own install script rather than reinventing it.

**"Why do I have to import an app-admin's private key into my browser just
to edit its content - can't I just list MY OWN identity as admin
somewhere instead?"** - no, and this isn't a bug: ownership of an ordinary
(`realm: 'main'`) app's `qu-page`/`qu-template`/`qu-style` content is
CRYPTOGRAPHIC and permanent, fixed forever at the moment each one was
created (`deriveContentNodeId(ownerPub, kind, path)`) - no config change,
`registerApp()` re-alias, or `QU_RELAY_ADMINS` entry can retroactively
change who owns EXISTING content (relay-admin status is a completely
separate, unrelated permission - see "Does the relay itself need an entry
in QU_RELAY_ADMINS?" above for the same "these are different lists"
confusion one level up). There genuinely is no way around touching the
owner's private key at least ONCE - either by importing it directly
(`bootstrap-platform.mjs`'s own printed devtools snippet, fine for a quick
test, a real anti-pattern to keep doing for ongoing work - sharing a
private key at all is a smell), or, the actual self-service fix:

```sh
node packages/app-shell/bin/grant-app-access.mjs \
  --relay wss://your-host --dir ./bootstrap-identity \
  --identity <your-app-admin-identity-name> --to <base64 pubkey of YOUR OWN identity>
```

Connects ONCE as the app-admin (`--dir`/`--identity`, the SAME identity
directory `bootstrap-platform.mjs` already created - never generates a new
one) and calls `grantContentWriter()` (`@qu/app-core`) for every currently
published page/template/style, extending write access to `--to`'s pubkey
- find your own browser identity's pubkey via `window.Qu.pub` in devtools,
or the relay's unconfigured setup page. After this runs once, that
identity can use `#/<prefix>/cms` with its OWN key, forever (grants don't
expire) - never needing the app-admin's private key again. Only covers
EXISTING content - re-run it after publishing new pages/templates/styles
if the same grantee should maintain those too (or just keep using it as
the app-admin for anything genuinely new). The built-in admin console and
any OTHER `realm: 'global'` app don't have this problem at all - every
relay-admin already has full access, by design (see the CMS section
above).

## Deploying the legacy chat relay

The OLD, hardcoded chat demo relay (`@qu/space-transport`'s own
`relay-server.js`) - kept as an explicit opt-in, not the default anymore:

```sh
docker compose -f docker-compose.space-relay.yml --profile legacy-chat up -d
```

See the guide's "Docker deployment" section for `QU_MEMBERS_JSON` (optional -
only needed for `'members'`-mode ACL Kinds) and how to generate it, and for
`QU_FEDERATE_UPSTREAM_URL` to federate with another relay.
