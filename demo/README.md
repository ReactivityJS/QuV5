# Demo: text exchange between Qu clients

A small, runnable proof that two independent processes can exchange
collaboratively-synced text through a Qu V5 relay, with every participant
identified by their **Qu public-key fingerprint** (`QuCrypto.fingerprint()`,
`packages/core/src/crypto.js`) instead of a self-reported name or a raw key.

## Fastest path: zero setup

```sh
npm install
npm run demo
```

Runs `auto-demo.mjs`: generates two identities, starts an in-process relay,
and runs two scenarios back to back - a short chat conversation with
presence-gated push routing, then an `acl.write: 'owner'` Node with public
fields that a completely unrelated third peer discovers and reads knowing
only its owner's pubkey (see `docs/v5-space-core-guide.md` §3/§14). All in
one process, so it also doubles as a smoke test that the build actually
works end to end (signing, encryption, CRDT sync, node-level ACL, and the
relay never seeing plaintext) - it exits non-zero if anything doesn't
converge as expected.

## App Shell: a whole app loaded from Qu content, not from code

```sh
npm run demo:app-shell
```

Runs `app-shell-demo.mjs`: an "app-admin" identity bootstraps an empty Space
into a working app (`@qu/app-core`'s Dev API - manifest, a template with a
`<qu-slot>`, a stylesheet, two pages, a route registry), then a completely
separate "visitor" identity - handed nothing but the app-admin's PUBKEY -
boots `@qu/app-shell`'s `startApp()` against a real (in-process) relay and
renders `#/`, `#/hello`, and an unpublished route (the framework's own "not
found" fallback), pulling template + content + stylesheet fresh from the
Space on every hash change. Also proves a `<script>` smuggled into a page's
content never reaches the DOM (`@qu/app-renderer`'s `sanitizeHtml()`). See
`architecture.md` §7 and `docs/app-shell-arbeitsauftrag.md` for the full
design - the Relay and the Shell itself never hardcode a single page,
template, or route here.

## App Shell over a REAL relay: relay + installer + a real browser

The above is in-process/jsdom only. This is the real thing - two separate
processes and a real browser tab, over a real WebSocket:

**Terminal 1 - the relay:**

```sh
npm run demo:app-shell-relay
```

Bundles `@qu/app-shell`'s `shell.js` (esbuild, same as `demo/web/build.mjs`
does for the chat demo), generates `demo/app-shell-web/index.html` with the
real app-admin pubkey baked into `<qu-app-shell app-admin-pub="...">`, and
starts a real WebSocket relay on `ws://localhost:8082` mirroring to
`demo/.app-shell-data/` - not yet seeded with any content.

**Terminal 2 - the installer** (a separate process, run once):

```sh
npm run demo:app-shell-install
```

Connects to the relay above as the SAME persisted `app-admin` identity
(`demo/.app-shell-identities/app-admin.json`, shared with the relay) over a
REAL WebSocket connection, and seeds "Qu Demo App" - a manifest, a route
registry, one template, one stylesheet, two pages - purely via
`@qu/app-core`'s Dev API (`createApp`/`createTemplate`/`createStyle`/
`createPage`/`publishRoute`), then disconnects. This is the actual
"installer command" docs §25 describes: connect, seed, done - a real,
separate process, not a simulation.

**Then open `http://localhost:8082/` in a browser.** A brand-new visitor
identity (generated on the spot, `POST /join`s the relay - see
`@qu/app-shell`'s `identity.js`) renders the exact same app the installer
just seeded, having authored none of it - hash-navigate to `#/hello` and
watch it pull a different page/content live from the Space.

Building this against a real network (not just in-process) is what actually
caught two real bugs, now fixed and regression-tested (see `architecture.md`
§7 for the full writeup): a `'members'`-mode Kind's meta-stamp used to seal
`'encrypted'`-only-for-the-writer regardless of its fields' own
`visibility: 'public'` (permanently breaking any LATER-joining visitor, via
Yjs's own gapless per-author update ordering), and `resolvePage()` used to
consider a page "ready" before its own `content` field had actually synced.

## Real thing: two clients, one relay, three terminals

**Terminal 1 - the relay:**

```sh
npm run demo:relay
```

First run auto-creates `alice`/`bob` identities under `demo/.identities/`
(gitignored - each file holds that identity's private keys, so this is
local-only, not something you'd commit or share) and starts a real
WebSocket relay on `ws://localhost:8081`, mirroring everything it forwards
to `demo/.data/` on disk.

**Terminal 2:**

```sh
npm run demo:alice
```

**Terminal 3:**

```sh
npm run demo:bob
```

Each prints its own fingerprint on connect. Type a line in either terminal
and press Enter - it appears in the other terminal tagged with the sender's
name and fingerprint, e.g.:

```
14:02:11  alice [a1b2-c3d4-e5f6-0102]:  Hallo Bob!
```

Stop with Ctrl+C. Restart `demo:relay` any time you add a third CLI identity
(`node demo/chat.mjs carol`) so it picks up the new member.

## In the browser

`demo:relay` also serves a browser client on the SAME port:

```sh
npm run demo:relay
# then open http://localhost:8081/ in two browser tabs/profiles
```

Each tab: type a name, click "Beitreten" (Join). Unlike the CLI, a browser
tab generates its OWN keypair on the spot (Web Crypto, kept in
`localStorage` - this browser/profile only) and registers its public halves
with the running relay via `POST /join` - no restart, no pre-existing
identity file needed, and no private key ever leaves the browser. A browser
tab and a CLI `demo:alice`/`demo:bob` can chat in the same room live, since
both are just members of the same relay-managed Space.

The page also has a "Debug-Log" checkbox (`@qu/events`' `createDebugLogger()`
watching everything on that tab's own bus - the granular event system this
demo has been building toward the whole time, see
`docs/v5-space-core-guide.md` §11) and a "Browser-Notifications erlauben"
button - grant it, switch to another tab/app, and a message that mentions
you shows a real OS-level notification instead of an in-page toast (the
handler decides the channel purely from `document.visibilityState` +
`Notification.permission`, exactly the "toast vs. browser-notification vs.
push is the handler's call based on state" design this repo settled on -
nothing about that decision lives in `Space`, the bus, or the relay).

**Reverse proxy / HTTPS**: `demo/relay.mjs` is plain HTTP + WebSocket on one
port - point a reverse proxy at it for TLS offloading on the standard HTTPS
port. Nothing relay-specific to configure beyond forwarding WebSocket
upgrades (the `Upgrade`/`Connection` headers) the way you would for any
other WebSocket backend; the page derives `ws://`/`wss://` from its own
`location.protocol`, so it automatically uses `wss://` once served over
HTTPS.

### Push routing: stop one client and watch the relay terminal

Every message attaches a granular `notify` hint (`@qu/events`' `EventBus`
topics, see `docs/v5-space-core-guide.md` §11): a plain line is
`notify.topic: 'message'`, a line starting with `@bob` (a known member) is
`notify.topic: 'mention'` addressed just to bob. Stop `demo:bob` (Ctrl+C)
but leave `demo:relay` and `demo:alice` running, then type a message (or
`@bob ...`) in alice's terminal - the RELAY's own terminal logs a line
like:

```
📮 ~146cc634b870… is offline -> sending Web Push: "demo-chat.mention" (from ~db145406dd7c…)
```

That line is the `push-handler.js` plugin reacting to the relay's
presence-gated `relay.notify.**` events (`online: false`, since bob's
`Space` never sent its connect-time "hello") - restart `demo:bob` and send
another message: the same code path now sees `online: true` and stays
silent, since bob's live connection already got it.

## How it works

- `demo/lib/identity.mjs` - persists one Ed25519+X25519 keypair per name
  under `demo/.identities/<name>.json` (created on first use), and exposes
  `loadMembers()` (every identity's *public* halves, for a Space's
  `members` list) and `fingerprintOf()`.
- `demo/relay.mjs` - a real relay (`@qu/space-transport`'s
  `createWsServerHub`/`createRelayForwarder` + `@qu/space-storage`'s
  `createFileStore`), same code path as
  `packages/space-transport/src/relay-server.js` - plus an `@qu/events`
  `EventBus` and `registerPushHandler()` for the push-routing log above.
- `demo/chat.mjs` - a CLI peer: connects via `WsClientTransport`, joins a
  shared `demo-chat` Node (`{ messages: { shape: 'list' } }` Kind-Schema,
  see `packages/space-core/src/kind-schema.js`), reads/writes it from
  stdin/stdout, and attaches a `notify` hint to every push.
- `demo/auto-demo.mjs` - the same mechanism, in-process, no relay/terminal
  needed - see `npm run demo` above.
- `demo/web/` - the browser client (`index.html` + `main.js`), esbuild-
  bundled into `dist/bundle.js` automatically on `demo:relay` startup (see
  `demo/web/build.mjs`; `npm run build:web` to bundle standalone). Imports
  `@qu/space-transport`'s dedicated `./ws-client-transport` subpath, not
  its main entry, specifically to stay browser-safe (see that file's own
  doc comment on why the main entry can't be bundled for a browser).
- `demo/app-shell-demo.mjs` - the in-process App Shell PoC, `npm run
  demo:app-shell` (see the section above).
- `demo/app-shell-relay.mjs` / `demo/app-shell-web/build.mjs` /
  `demo/install-app-shell-demo.mjs` - the real-relay App Shell demo (see its
  own section above): a relay serving a bundled `@qu/app-shell`, and a
  separate installer process seeding it over a real WebSocket via
  `@qu/app-core`'s Dev API.

Every message is signed with the sender's Ed25519 key and end-to-end
encrypted for every member's X25519 key before it ever reaches the relay or
disk (see `docs/v5-space-core-guide.md` §3) - the relay only ever forwards
and mirrors ciphertext it cannot decrypt.

## Caveats (it's a demo)

- CLI identities live in one shared local directory - fine for "two
  terminals on the same machine," not a real key-distribution mechanism.
- `POST /join` (what lets a browser tab join live) has NO AUTHENTICATION
  beyond "well-formed base64 keys" - anyone who can reach the relay port
  can join the room as a fully-authorized member. This is the SAME shared
  handler (`@qu/space-transport`'s `relay-app-server.js`) the production
  `relay-server.js`/Docker image now also serves - there, it defaults to
  the same "anyone may join" behavior (`QU_ALLOW_JOIN=false` to disable
  it, see `docs/v5-space-core-guide.md` §10), not something unique to this
  local demo.
- A member added after another client's `Space` was already constructed
  (via `demo:relay` restart for the CLI, or `/join` for the browser) is
  invisible to that client until it learns about them - the CLI demo
  requires a restart; the browser demo learns REACTIVELY, not by polling:
  `relay.mjs`'s `/join` calls `relay.addMember()`, which broadcasts
  `{type:'member-joined', ...}` to every already-connected peer over the
  SAME open WebSocket connection, and each `Space` handles it by calling
  its own `addMember()` (see that method's own doc comment in
  `packages/space-core/src/space.js`) - the instant the broadcast arrives,
  no timer involved. A write IS still encrypted only for the members known
  at the moment it's sealed, so a message written before someone joins is
  PERMANENTLY undecryptable for them (no later event can retroactively add
  a recipient to an already-sealed envelope) - **and, because Yjs applies
  one author's updates as a strictly ordered, gapless sequence, this isn't
  just "that one old message stays invisible": once ONE of an author's
  updates is skipped for a given reader, that reader can never integrate
  ANY LATER update from that same author on that same Node either**, until
  they get a fresh local Yjs doc for it (re-`subscribeNode()`) - see
  `grant.js`'s own "WRITE-BEFORE-GRANT IS A TRAP" doc comment for the exact
  same Yjs property applied to `'named'`-ACL grants. In practice this shows
  up as "I stopped receiving messages from one specific person" after a
  relay restart replays old `demo/.data/` history to a member who joined
  after some of it was written, or after re-running the demo against a
  stale `demo/.data/` from an earlier session with a different member set.
  `Space` no longer CRASHES on this (an unhandled promise rejection used to
  terminate the whole CLI process the instant it happened - a real,
  now-fixed bug, see `debug.space.write.remote.undecryptable` in
  `architecture.md` §6) but it also can't undo it: **if messages from one
  person silently stop appearing, delete `demo/.data/` and restart
  `demo:relay`** (a real app would instead call `Space.compactNode()` after
  a membership change - see envelope.js's own "SNAPSHOT/COMPACTION" doc
  comment - so every current member's copy reseals as one envelope encrypted
  for the CURRENT member list, closing the gap for anyone who joins after).
- **The typed display name is NOT an account** - a browser tab's identity
  is a keypair generated once per browser/profile and kept in
  `localStorage` (see `web/main.js`'s own `loadOrCreateIdentity()`); the
  name you type is a self-reported label attached to it, nothing more. Two
  different devices/browsers typing the SAME name join as two
  cryptographically UNRELATED members - they never shared a keypair, so
  neither can decrypt anything sealed for the other, and each is
  independently "online." `POST /join`'s response now flags
  `sameNameOtherIdentity: true` when this happens (`web/main.js` shows a
  toast) precisely because it's easy to mistake for a sync bug otherwise -
  "why does my phone and desktop, same name, not see each other's history"
  is answered by "they were never the same identity," not by anything
  broken in delivery.
- **One failed message render used to silently kill ALL later ones** - a
  SEPARATE bug from the permanent-per-author gap above, easy to confuse
  with it (same "messages just stop appearing" symptom) but with a
  different fix: both `chat.mjs` and `web/main.js` print incoming messages
  via a `printing = printing.then(...)` chain; without a `.catch()`, one
  throw (a transient render glitch, a malformed message - NOT specific to
  one author) left `printing` permanently REJECTED, and every later
  `schedulePrint()` call silently did nothing for the rest of the session -
  while sync itself, the debug log, and notification toasts kept working
  fine (unrelated code paths), making it look like delivery had gone
  one-directional. Fixed: the chain now recovers, and a per-message
  `try/catch` means one bad message is skipped, not a wall past which
  nothing after it ever prints again. If messages stop rendering: this
  fix (already applied) covers "everything, from that point on, regardless
  of sender"; the gap above covers "everything from one specific person,"
  which is not a code fix so much as a call to `compactNode()`/deleting
  `demo/.data/`, as described above.
