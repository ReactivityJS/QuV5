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
own laptop, a CI runner, wherever - never inside the relay's own
container**, and it never touches your deployment config at all: it
generates a `relay-admin` and a `demo-app-admin` identity locally, then
either

- the relay isn't configured with them yet → **prints the exact
  `QU_RELAY_ADMIN_PUB`/`QU_APP_ADMIN_PUBS`/`QU_RELAY_ADMIN_MEMBERS_JSON`
  values** (public keys only) for YOU to paste into however you manage
  your deployment's environment - `docker-compose.space-relay.yml`
  directly, your own `docker stack` file, a Kubernetes manifest, systemd,
  whatever - then redeploy however you already do (`docker compose up -d`,
  `docker stack deploy`, ...) and run the SAME command again; or
- the relay already has them (this second run, or any later one) →
  installs the admin console, creates a demo shell-app with its own CMS
  editor installed, registers both under `#/admin` and `#/demo`, and
  prints the exact URLs plus ready-to-paste browser devtools snippets so
  you can actually act as either identity.

Two runs on a totally fresh setup is normal, not a bug - see
`packages/app-shell/bin/bootstrap-platform.mjs`'s own doc comment for the
full "why" (in short: env vars are read once at relay boot, so it can't
verify your paste took effect without actually trying a write and seeing
if the relay acks it). Safe to re-run any time afterward too - every step
checks first, never re-creates content that already exists.

For a single, fixed app instead of a platform, set `QU_APP_ADMIN_PUB`
directly (ignored once `QU_RELAY_ADMIN_PUB` - platform mode - is also
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
- **`#/admin`** (platform/relay-admin level, ONE per platform) only
  registers apps under path prefixes (`registerApp()`) - it has no
  content editor of its own. `bootstrap:platform` installs it for you;
  by hand, see `packages/app-shell/bin/install-admin-console.mjs`.
- **`#/<prefix>/cms`** (per-app, one per REGISTERED app, `#/demo/cms` for
  `bootstrap:platform`'s own demo app) is where that app's OWN
  templates/styles/pages are actually created and edited - see
  architecture.md §7's "The built-in CMS editor." Every app-admin installs
  this into their OWN app's Space (`installCms(space)`,
  `@qu/app-shell`'s `cms-bundle.js`) - `bootstrap:platform` does this for
  its demo app automatically; for your OWN app, call `installCms()` from
  your own install script (see `demo/install-app-shell-demo.mjs` for the
  connect-as-app-admin pattern) or add it to your own bundle install flow.

There is currently no SINGLE, platform-wide CMS shared across every app,
and no CMS for `#/admin`'s own content either (its `qu-admin-*` Kinds have
no `edit*()` counterparts yet - `bin/install-admin-console.mjs` remains
the only way to update it) - each ordinary app gets its OWN independent
CMS editor, installed once per app.

## Deploying the legacy chat relay

The OLD, hardcoded chat demo relay (`@qu/space-transport`'s own
`relay-server.js`) - kept as an explicit opt-in, not the default anymore:

```sh
docker compose -f docker-compose.space-relay.yml --profile legacy-chat up -d
```

See the guide's "Docker deployment" section for `QU_MEMBERS_JSON` (optional -
only needed for `'members'`-mode ACL Kinds) and how to generate it, and for
`QU_FEDERATE_UPSTREAM_URL` to federate with another relay.
