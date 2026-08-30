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

Every message is signed with the sender's Ed25519 key and end-to-end
encrypted for every member's X25519 key before it ever reaches the relay or
disk (see `docs/v5-space-core-guide.md` §3) - the relay only ever forwards
and mirrors ciphertext it cannot decrypt.

## Caveats (it's a demo)

- CLI identities live in one shared local directory - fine for "two
  terminals on the same machine," not a real key-distribution mechanism.
- `POST /join` (what lets a browser tab join live) has NO AUTHENTICATION
  beyond "well-formed base64 keys" - anyone who can reach the relay port
  can join the room as a fully-authorized member. Fine for "two people
  testing," not for anything actually private - see `relay.mjs`'s own doc
  comment on `/join` for what a real deployment would add in front of it.
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
  at the moment it's sealed, so a message sent in the same instant as a
  join could in principle race it - by design, not a polling artifact.
