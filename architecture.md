# Qu V5 Architecture

**⚠️ Living document — keep it current.** Any change to this repo's
design, concept, structure, or public API (a new package, a renamed
method, a changed event topic, a new ACL mode, a new file replacing an
old one) MUST be reflected here in the same change/PR that makes it. A
stale architecture doc is worse than none — it actively misleads. If
you're not sure whether a change is "architectural" enough to need an
update here: if it would surprise someone who last read this document,
update it.

This document is the bird's-eye map. For the *why* behind any specific
mechanism, follow the pointers to the actual source doc comments — they
are intentionally the canonical, detailed explanation; this file
summarizes and indexes them, it doesn't replace them. For the *how* of
using the API day-to-day, see `docs/v5-space-core-guide.md`.

## 1. What Qu V5 is

Qu V5 is a Yjs-native framework for building distributed, real-time-synced
applications: peers hold **Nodes** (CRDT documents) locally, sync them
with other peers through a content-blind **Relay**, and every write is
signed and (usually) end-to-end encrypted. It is deliberately:

- **UI-agnostic core, optional UI layer on top** — `@qu/space-core`/
  `@qu/space-transport` themselves have no components, no rendering, no DOM
  dependency. `@qu/space-ui` (§4/§5) is a genuinely OPTIONAL, separate
  add-on package built entirely on the public `Field`/`SpaceNode` API —
  vanilla JS/DOM, no framework, no build step; `Space` has zero awareness
  it exists, same as `@qu/space-plugins` below.
- **Local-first** — a peer reads its own storage before ever touching the
  network, and only subscribes to (spends bandwidth on) data it's actually
  been asked for (`Space.useNode()`, see §5).
- **Event-driven throughout** — `@qu/events`' `EventBus` is the ONE
  hooks/listeners/slots mechanism used on both the client and the relay,
  in the spirit of Drupal/ProcessWire/WordPress hook systems: granular,
  dot-namespaced topics: with wildcard subscription, and delivery-channel
  decisions (toast vs. browser notification vs. push) left entirely to
  whatever subscribes to the bus — never baked into the emitting code.
- **Without backward-compatibility constraints during this build** — this
  is an active redesign; prefer the architecturally correct shape over
  preserving an old one.

## 2. Repository layout

```
QuV5/
├── packages/
│   ├── core/            @qu/core            - crypto primitives (Ed25519/X25519/AES-GCM), no framework logic
│   ├── events/          @qu/events          - EventBus: the one hooks/listeners/slots mechanism
│   ├── space-core/      @qu/space-core      - Space/Node/Field, envelopes, Kind-Schema, ACL, alias identities
│   ├── space-storage/   @qu/space-storage   - storage adapters (memory/durable/file) a Space or relay mounts
│   ├── space-transport/ @qu/space-transport - Transports (in-process/WebSocket), the Relay, federation
│   ├── space-plugins/   @qu/space-plugins   - OPTIONAL app helpers: delivery-status (write-ack + read receipts), upload outbox, auto-compact-on-join
│   ├── space-ui/        @qu/space-ui        - OPTIONAL vanilla-JS/DOM bindings: field bind, inline-edit, list-bind, upload-status
│   ├── space-components/@qu/space-components- OPTIONAL declarative Custom Elements over @qu/space-ui: <qu-view>/<qu-bind>/<qu-list> - a CMS-authored template writes these as plain markup, no JS glue
│   ├── app-core/        @qu/app-core        - App Runtime: Kind-Schemas for app content, content-addressed Node ids, ContentResolver, HashRouter, AppRuntime, Dev API
│   ├── app-renderer/    @qu/app-renderer    - sanitizer, <qu-slot> resolution, style injection, renderPage() - Template+Page -> DOM
│   └── app-shell/       @qu/app-shell       - the minimal, application-agnostic bootstrap kernel a Relay serves; also its OWN production relay-server.js/Dockerfile (separate from @qu/space-transport's)
├── demo/                 - runnable proofs: CLI chat, browser client, in-process auto-demo, app-shell-demo
├── docs/                 - docs/v5-space-core-guide.md (framework how-to), docs/app-shell-arbeitsauftrag.md (App Shell/Runtime design)
└── architecture.md       - this file
```

Each package is small and single-purpose on purpose — `@qu/core` has zero
knowledge of Yjs or Nodes; `@qu/events` has zero knowledge of Qu at all
(it's a generic pub/sub); `@qu/space-core` never touches a network socket
directly; `@qu/space-transport` never touches Yjs internals directly. A
change belongs in exactly one package; if it seems to need two, that's a
signal the abstraction boundary needs re-examining, not a reason to reach
across it.

## 3. Framework concept and design

### 3.1 The write path (client → relay → other clients)

1. App code mutates a `SpaceNode`'s field (`node.field('title').set(...)`,
   `.insert()`, `.push()`) — this is an ordinary Yjs mutation wrapped in a
   `doc.transact(fn, origin)` call that stamps `{notify?, visibility}`
   onto the transaction origin (`field.js`'s `withWriteContext()`).
2. `Space._handleLocalUpdate()` (`space.js`) receives the resulting Yjs
   update via `doc.on('update', ...)`, reads `visibility` off the origin,
   and seals it: `sealPublicUpdate()` (plaintext, signed) or
   `sealUpdate()` (AES-GCM, one wrapped key per recipient, signed) —
   see `envelope.js`. The sealed **envelope** — never the raw update — is
   what reaches storage and the transport.
3. The Relay (`relay.js`) verifies the envelope's signature against the
   Node's ACL (`buildWriteAcl()` — flat membership, or self-certifying
   `deriveOwnerNodeId()`/grant-derived, depending on `acl.write`), mirrors
   it (if it has a `storage` adapter — `append()`, or `replace()` for a
   compaction snapshot), and forwards it to exactly the Node's
   **subscribers** (`nodeId -> Set<peerId>`, populated only by verified
   `subscribe` requests — never a blind broadcast).
4. A receiving `Space._handleIncoming()` re-verifies the SAME signature
   independently (never trusts the relay), decrypts if it's a recipient
   (`openUpdate()`), and applies the update via `Y.applyUpdate(doc, bytes,
   REMOTE_ORIGIN)` — the `REMOTE_ORIGIN` marker is what stops step 1 from
   re-sealing and re-broadcasting a write this Space just received.

The relay is **content-blind by construction**, not by convention: it is
constructed with only public keys, so it never even holds an X25519
private key to attempt decryption with (`verifyEnvelope()` needs only a
public key; `openUpdate()` needs the private key and the relay never gets
one).

### 3.2 Kind-Schema: shape × visibility, and FIVE ACL modes

A field declares two INDEPENDENT properties (`kind-schema.js`):

- **`shape`** — the local CRDT structure (`'atomic'` | `'text'` |
  `'list'`). Matters only to whichever peer is reading/writing right now;
  never appears on the wire.
- **`visibility`** — which envelope mode a write seals with
  (`'encrypted'` default | `'public'`). Decided once by the writer,
  self-describing in the resulting envelope from then on.

`acl.write` names who may sign updates to a Node of this Kind:

- **`'members'`** — flat Space membership (the default) — genuinely
  SHARED write access, every member equally, no single owner.
- **`'owner'`** — self-certifying `nodeId` (`deriveOwnerNodeId(ownerPub,
  kind)`), zero relay state, ONE Node per owner per Kind.
- **`'named'`** — the owner (same self-certifying id as `'owner'`) plus
  anyone they've signed a `grant` for.
- **`'content'`** — `'named'`'s MANY-per-owner counterpart:
  self-certifying `nodeId` via `deriveContentNodeId(ownerPub, kind, path)`
  (a route, a template name, ...), real per-Node write-ACL (the owner —
  granted to themselves TRANSPARENTLY by `Space.createNode()` the instant
  they create it, no extra call needed — plus anyone else they've
  explicitly `grantWriter(id, kind, granteePub, {path})`ed). This is the
  primitive behind `@qu/app-core`'s `qu-page`/`qu-template`/`qu-style` (§7
  below) — genuine per-owner exclusivity for many-Nodes-per-owner content,
  not just flat `'members'`-mode sharing, and a GLOBAL Qu-level primitive
  any many-per-owner content Kind wants (a calendar event, a forum post, a
  chat room), not an app-core invention.
- **`'relay-admins'`** — a flat, symmetric list like `'members'`, but
  checked against a `Space`/relay's own `relayAdmins` constructor param
  INDEPENDENTLY of ordinary Space membership/`QU_ALLOW_JOIN` self-join —
  for content that must live in an OPEN-JOIN Space (world-readable with
  zero membership) yet be writable only by a small, boot-time-configured
  set with no single owner (`@qu/app-core`'s `qu-platform-apps`, the
  reference use — see §7's own "A fourth ACL mode" for the full "why" and
  `packages/space-transport/src/relay.js`'s `addRelayAdmin()`/
  `removeRelayAdmin()` for how that list is grown/shrunk without a relay
  restart, the same reactive shape `addMember()`/`removeMember()` already
  give `'members'`).

See `docs/v5-space-core-guide.md` §3 for the full behavioral contract, and
`packages/space-core/src/grant.js`'s doc comment for the real Yjs property
("write-before-grant is a trap") that makes grant ORDERING matter —
`'content'` mode has NO owner-pubkey shortcut in its write-ACL check
(unlike `'owner'`/`'named'`: a `nodeId` alone cannot be inverted back to
the `path` a verifier would need to recompute it), so EVERY reader,
including one reading the ORIGINAL owner's own writes, needs to have
actually seen a `grant` message — `@qu/space-transport`'s `relay.js`
durably stores and REPLAYS grants to a newly-subscribing peer for exactly
this reason (a separate storage key from the Node's own envelope log, so
`Space.compactNode()` never wipes it — see `grantStorageKey()`'s own doc
comment). `Space`'s own incoming-message handling, and the relay's,
additionally SERIALIZE processing per peer (never overlapping two
messages from the same sender) — necessary because `'content'`'s
grant-then-write dependency is only safe if "arrived first" also means
"finished processing first," which async crypto verification alone does
not guarantee (see `Space._handleIncoming()`'s own doc comment).

### 3.3 Local-first sync and subscriber-tracking

Two rules work together to keep traffic proportional to actual demand,
not to Space size:

- A peer never subscribes to a Node until something actually asks for it
  (`Space.useNode()`/`subscribeNode()`) — and checks its OWN storage
  first, spending network only on top of that.
- A relay never forwards a write to a connection that hasn't sent a
  signed `subscribe` request for that specific Node id — being an
  authorized member/owner is necessary but not sufficient.

Relay federation (`federation.js`) applies the second rule one hop
further: a downstream relay only subscribes upstream when one of ITS OWN
local peers has proven real demand for a Node it doesn't already have.

### 3.4 Reconnect, resync, and per-Kind persistence tiers

`WsClientTransport` auto-reconnects (exponential backoff + jitter, plus a
backgrounded-browser-tab recovery check on `visibilitychange`/`online`) and
reports its lifecycle through `onStatusChange({status})` —
`'connected'`/`'disconnected'`/`'reconnecting'`/`'reconnected'`. `Space`
claims that single callback slot and, on `'connected'`/`'reconnected'`,
re-sends `hello` and re-subscribes every currently attached Node — a relay
answers each `subscribe` by replaying its full mirror (§3.1 step 3), so
whatever changed while offline (including this peer's OWN writes, queued
by the transport's send-queue rather than dropped) arrives the same way
ordinary catch-up already does. No separate "diff" wire message: Yjs
updates are idempotent to re-apply. `Space` also emits `space.status.
changed` on its `bus` for every transition, so a UI's own "reconnecting…"
banner needs no separate connectivity API.

`defineKind()` also takes `persistence: 'durable' | 'volatile'` (default
`'durable'`). A `'volatile'` Kind's writes hydrate/append/replace through a
SEPARATE storage adapter (`Space`'s own `volatileStorage` constructor
param / the relay's own `volatileStorage` param, both defaulting to a
private in-memory store if omitted) instead of the configured durable one
— the same swappable-adapter idea `@qu/space-storage`'s memory/durable/
file tiers already embody, now selectable PER KIND rather than only for
the whole Space/relay. This is what `presence.js`'s `presenceKind` (§3.5)
is built on, and what a Kind like it needs instead of any relay/transport-
level special-casing: presence/typing are ordinary Node writes on a
volatile-persistence Kind, nothing more.

### 3.5 Presence, typing, and delivery status — ordinary data, not protocol

Online/offline liveness stays exactly the pre-existing `hello`/
`PresenceTracker` mechanism (relay-internal, push-routing only — see
§3.6's event list). Everything else that might look like a "presence
feature" is deliberately just Node writes:

- `@qu/space-core`'s `presence.js` — `presenceKind` (self-certifying
  `acl.write: 'owner'`, `persistence: 'volatile'`) holds `online`/`status`/
  `updatedAt`/`typingIn`/`typingAt`. `publishPresence()`/`setStatus()`/
  `setTyping()` write it; `watchPresence()`/`PresenceWatcher` read it
  (one-shot snapshot vs. a reactive multi-member cache, same split
  `alias.js`'s functions vs. `AliasRegistry` already established).
  `online` is a best-effort, SELF-REPORTED flag (nothing can sign "went
  offline" after its own connection already dropped) — a reader wanting to
  treat long-silent `online: true` as effectively offline compares
  `updatedAt` against its own staleness threshold; that policy is
  deliberately left to the app, not hardcoded here.
- `@qu/space-plugins`'s `delivery-status.js` — `awaitRelayAck(bus, nodeId)`
  correlates the relay's write-ack (below) to one write by ordering;
  `readReceiptKind` (durable, unlike `presenceKind`) is the same self-
  certifying-per-reader shape for a "read up to here" marker.

WRITE-ACK: once a relay mirrors a LOCALLY-originated write, it sends
`{type: 'write-ack', nodeId, seq}` back to that write's own author — `seq`
is simply the mirror's current size for that Node, a cheap way to tell
"reached the relay's durable mirror" apart from "a live peer applied it"
(the latter is just an ordinary remote `space.node.<id>.changed`, observed
on the RECIPIENT's own Space, not the author's).

### 3.6 Events: the one hooks/listeners/slots mechanism

`@qu/events`' `EventBus` (dot-namespaced topics, `*` = one segment, `**` =
prefix + everything under it, must be the last segment) is used
identically on the client (`new Space({..., bus})`) and the relay
(`createRelayForwarder({..., bus})`). Two families exist everywhere:

- **Real events** — describe something that actually happened and that
  other code is expected to react to: `space.node.<id>.changed`,
  `notification.<kind>.<topic>`, `space.member.joined`,
  `relay.notify.<kind>.<topic>`, `relay.write.local`.
- **`debug.*` events** — purely optional observability (every write/
  subscribe/hello/grant/presence lifecycle step), zero cost when nothing
  listens, safe to wire a `createDebugLogger()` onto in development and
  never in a hot path that cares about allocation.

Delivery-channel decisions (toast vs. browser Notification vs. Web Push)
are never baked into the bus or into `Space`/the relay — they live in
whatever subscribes (`push-handler.js`'s `registerPushHandler()` is the
reference example: it decides purely from the `online` flag on
`relay.notify.**`). `alias.js`'s `AliasRegistry` is the same pattern
applied to identity resolution: a bus watcher, not a `Space`-internal
mechanism — `Space` itself has zero awareness that "alias" is a concept.

## 4. File-by-file map

### `packages/core/` — `@qu/core`

| File | Purpose |
|---|---|
| `src/crypto.js` | `QuCrypto` — Ed25519 sign/verify, X25519 ECDH + AES-256-GCM envelope encryption, `keypairFromSeed()` (deterministic derivation, used by `alias.js`), base64/hex helpers, `fingerprint()`. |
| `src/index.js` | Re-exports `QuCrypto`. |

### `packages/events/` — `@qu/events`

| File | Purpose |
|---|---|
| `src/event-bus.js` | `EventBus` class — `on`/`once`/`off`, and three emit modes: `emit`/`notify` (fire-and-forget), `collect` (gather return values), `run` (sequential transform). Trie-based wildcard dispatch. |
| `src/debug-logger.js` | `createDebugLogger(bus, {pattern, log, label})` — logs every event matching `pattern` (default `'**'`). |
| `src/index.js` | Re-exports both. |

### `packages/space-core/` — `@qu/space-core`

| File | Purpose |
|---|---|
| `src/envelope.js` | `sealUpdate()`/`sealPublicUpdate()`/`verifyEnvelope()`/`openUpdate()` — the ONE place a Yjs update is ever sealed/opened. Envelope v2 (`mode: 'encrypted'\|'public'`) and the `snapshot` flag (compaction) live here. |
| `src/kind-schema.js` | `defineKind()` (now also `persistence: 'durable'\|'volatile'`, §3.4), `KindRegistry`, `deriveOwnerNodeId()` (self-certifying nodeId derivation for `'owner'`/`'named'` ACL). |
| `src/grant.js` | `signGrant()`/`verifyGrant()` — the `'named'`-ACL delegated-authority mechanism. |
| `src/node.js` | `SpaceNode` (one Node = one Y.Doc, `meta` + `content` maps), `stampMeta()`. |
| `src/field.js` | `AtomicField`/`TextField`/`ListField`, `createField()`, `withWriteContext()` (the shared transact-with-origin wrapper every field mutation goes through). |
| `src/space.js` | `Space` — the main class, now also reconnect/resync (`onStatusChange` wiring, §3.4) and per-Kind storage routing (`_storageFor()`). See §5 below for its full method surface. |
| `src/alias.js` | `deriveAliasIdentity()`, `aliasRegistryKind`/`aliasRegistryNodeId()`, `publishAlias()`, `AliasRegistry` — per-space pseudonymity. |
| `src/presence.js` | `presenceKind`, `publishPresence()`/`setStatus()`/`setTyping()`, `watchPresence()`/`PresenceWatcher` — presence/typing as ordinary volatile-persistence Node writes (§3.5). |
| `src/wire-codec.js` | `encodeForWire()`/`decodeFromWire()` — Uint8Array ↔ base64 for any JSON serialization boundary (WebSocket, on-disk file). |
| `src/index.js` | Package's public export surface — the authoritative list of what's public API vs. internal. |

### `packages/space-storage/` — `@qu/space-storage`

| File | Purpose |
|---|---|
| `src/memory-store.js` | `createMemoryStore()` — ephemeral, in-process-only tier. |
| `src/durable-store.js` | `createDurableStore()` — simulated persistence (in-memory backing object) for tests; same contract as real disk. |
| `src/file-store.js` | `createFileStore(dataDir)` — real on-disk persistence, one newline-delimited JSON file per Node. |

All three implement the same contract: `append(nodeId, envelope)`,
`load(nodeId)`, `replace(nodeId, envelopes)` (compaction — discards prior
history in favor of the given envelopes, typically one `snapshot: true`
envelope).

### `packages/space-transport/` — `@qu/space-transport`

| File | Purpose |
|---|---|
| `src/in-process-transport.js` | `createInProcessHub()`, `InProcessTransport` — same-process transport for tests, star-shaped through a relay. |
| `src/ws-server-hub.js` | `createWsServerHub(wss)` — the server-side hub over a real `ws` `WebSocketServer`. |
| `src/ws-client-transport.js` | `WsClientTransport` — real WebSocket client, browser-safe (separate `exports` subpath, no `node:crypto`); now also auto-reconnect + `onStatusChange()` (§3.4). |
| `src/relay.js` | `createRelayForwarder()` — the Relay itself: signature verification, subscriber-tracking, per-Kind durable/volatile mirroring (§3.4), `'named'`-ACL grant handling, push-notify routing, write-ack (§3.5), federation's `ingestFederated()` integration point. |
| `src/federation.js` | `federateRelay()` — a relay as a subscribing peer of another relay. |
| `src/presence-tracker.js` | `PresenceTracker` — pubkey ↔ peerId online/offline state, built from signed `hello` messages. |
| `src/push-handler.js` | `registerPushHandler(bus, {sendPush})` — reference delivery-channel handler for `relay.notify.**`. |
| `src/relay-identity.js` | `loadOrCreateIdentity(filePath)`/`describeIdentity()` — a relay's own keypair, auto-generated on first boot and persisted (only needed for federation). |
| `src/relay-app-server.js` | `createAppRequestHandler()` — the shared HTTP layer (static browser app, `GET /members.json`, `POST /join`) both `relay-server.js` and `demo/relay.mjs` serve alongside their WebSocket endpoint. |
| `src/relay-server.js` | Standalone, env-var-configured relay process (`QU_*`, see its own doc comment; `--print-identity` CLI flag) — what the Dockerfile runs. Also serves an app (today, `demo/web/`) via `relay-app-server.js` — see its own "SERVES AN APP" doc comment. |
| `src/index.js` | Package's public export surface (main entry — excludes `ws-client-transport.js`'s browser-safe subpath, see that file's own doc comment on why). |

### `packages/space-plugins/` — `@qu/space-plugins` (OPTIONAL)

| File | Purpose |
|---|---|
| `src/delivery-status.js` | `awaitRelayAck()`, `readReceiptKind`, `markRead()`/`watchReadReceipts()`/`ReadReceiptWatcher` — local/relay-synced/read lifecycle helpers (§3.5). |
| `src/upload-outbox.js` | `uploadOutboxKind`, `UploadOutbox` — local-save-then-sync queue for (multiple) file uploads: caller supplies a local blob store + an `upload()` function; this class owns the pending→uploading→done/failed state machine, retry, and a reactive `watch()`. |
| `src/index.js` | Package's public export surface. |

Built entirely on `@qu/space-core`'s public API — `Space` has zero
awareness either of these exist, same as `alias.js`.

### `packages/space-ui/` — `@qu/space-ui` (OPTIONAL)

| File | Purpose |
|---|---|
| `src/bind.js` | `bindField()`/`bindCheckbox()` — one/two-way reactive binding between a DOM element and a `Field`. |
| `src/inline-edit.js` | `makeInlineEditable()` — `[contenteditable]` bound to a `Field` with explicit save (Enter/blur)/cancel (Escape) semantics; never applies a remote change while the element has focus. |
| `src/list-bind.js` | `bindList()` — keyed reconciliation of a list `Field` into a DOM container; skips re-rendering items whose value hasn't changed even without a caller-supplied `update()`. |
| `src/upload-status.js` | `bindFileInput()`/`bindUploadStatusIcon()` — wires `<input type="file">` and status icons to `@qu/space-plugins`' `UploadOutbox`; a status icon is never auto-hidden on `'done'`. |
| `src/index.js` | Package's public export surface. |

Vanilla JS/DOM, no framework dependency, no build step — `Space` has zero
awareness this package exists either.

### `packages/space-components/` — `@qu/space-components` (OPTIONAL)

| File | Purpose |
|---|---|
| `src/context.js` | `findQuSpace()`/`findQuKind()` — ancestor-DOM resolution (a Component reaches its `Space`/Kind-Schema by walking up for a `.quSpace`/`.quKinds` property on some ancestor, never a global — the same pattern QuV3's own `packages/ui/src/components.js` established, `findQu()`). `resolveTarget()` — binds to a sole child element (e.g. a wrapped `<input>`) instead of the Component itself, when there is one. `assertSafeAttrMode()`/`getPath()` — shared guards/helpers. |
| `src/resolve.js` | `resolveNodeRef()`/`resolveField()` — turns a Component's `kind`/`node-id`/`field` attributes (or `.kindSchema`/`.nodeId` JS properties, for a computed id/an app-owned Kind-Schema object) into a subscribed `{field, release}`, retrying once on the next microtask for the "ancestor context set after append" ordering hazard. |
| `src/qu-view.js` | `<qu-view>` — read-only, live-updating binding of one field into a DOM element, built on `@qu/space-ui`'s `bindField()`. |
| `src/qu-bind.js` | `<qu-bind>` (extends `<qu-view>`) — two-way: live per-keystroke by default, or `editable="inline"` for explicit save/cancel editing (`@qu/space-ui`'s `makeInlineEditable()`) with a pencil/save/cancel icon UI this Component owns. |
| `src/qu-list.js` | `<qu-list>` — stamps a `<template>` child once per item of a list Field, built on `@qu/space-ui`'s `bindList()` — atomic per-item updates (only a changed item re-renders), CURATED lists only (the list Field's own array IS the data; QuV3's DERIVED case — many sibling Nodes — is a documented future extension, not built speculatively). |
| `src/elements.js` | The ONLY entry that registers the three tags with `customElements` — browser/jsdom-only (a bare `class extends HTMLElement` throws under plain Node), so excluded from `src/index.js` exactly the way `@qu/app-shell`'s `shell.js` is excluded from ITS package's own index — see `src/index.js`'s own doc comment. |
| `src/index.js` | Plain-Node-importable surface: `context.js`/`resolve.js`'s helpers only, no `HTMLElement` anywhere. |

This is the declarative Component layer §7's corrected "Phase 2" section
describes — `@qu/app-shell`'s `boot.js` sets `mountEl.quSpace` on every
navigation (the ADMIN realm's own separate `Space` included), and
`shell.js` imports `@qu/space-components/elements` once at boot to
register the tags; a rendered page's own `<qu-view>`/`<qu-bind>`/
`<qu-list>` markup (author-typed CMS content, or framework/app-authored
template HTML) then just works, no per-page wiring code.

### `demo/`

| File | Purpose |
|---|---|
| `auto-demo.mjs` | `npm run demo` — zero-setup, one process: chat + presence-gated push (part 1), then an `acl.write:'owner'` public-field Node discovered by an unrelated peer (part 2). Exits non-zero on any mismatch — this is the project's own smoke test. |
| `chat.mjs` | `npm run demo:alice`/`demo:bob` — real CLI client over a real WebSocket relay. |
| `relay.mjs` | `npm run demo:relay` — real relay process; also serves the browser client and a `/join` (demo-only, unauthenticated) endpoint. |
| `web/main.js`, `web/index.html`, `web/build.mjs` | Minimal browser client, esbuild-bundled by `relay.mjs` at startup, served at `/`. |

## 5. API reference

Only the public surface (each package's `src/index.js`, plus
`@qu/space-transport/ws-client-transport` for the browser subpath) is
listed; anything not here is internal to its file and may change without
notice.

### `Space` (`@qu/space-core`)

| Member | Purpose |
|---|---|
| `new Space({identity, members, transport, storage?, volatileStorage?, bus?})` | Construct one peer's live view. Sends a signed `hello` immediately; claims the transport's `onStatusChange()` slot if it has one (§3.4). `volatileStorage` backs any `persistence: 'volatile'` Kind (§3.4) — defaults to a private in-memory store. |
| `.identity` | Read-only getter — this Space's own identity object. |
| `.addMember(member)` | Grows this Space's own view of `'members'`-mode ACL/encryption recipients (idempotent). |
| `.createNode(kindSchema, initialFields?, {id?})` | Originate a new Node. `id` is IGNORED (self-derived) for `'owner'`/`'named'` Kinds. |
| `.subscribeNode(id, kindSchema)` | Register interest in a known Node id; sends a signed `subscribe`, not reference-counted. |
| `.unsubscribeNode(id)` | Inverse of the above — drops the local handle, tells the relay to stop forwarding. |
| `.useNode(id, kindSchema)` | **Recommended default.** Local-first, lazy, reference-counted — see `-> {node, release}`. |
| `.loadNode(id, kindSchema)` | Local storage only, zero network — the "durable, no live sync" tier. |
| `.compactNode(id)` | Replace a Node's entire stored history with one GC'd snapshot envelope. |
| `.grantWriter(nodeId, kind, granteePub)` | `'named'`-ACL: authorize one more pubkey to write this Node. |
| `.getNode(id)` | Synchronous lookup of an already-attached Node, or `undefined`. |

### `SpaceNode` / fields (`@qu/space-core`)

| Member | Purpose |
|---|---|
| `node.id`, `.kind`, `.kindSchema`, `.doc`, `.meta` | Identity/metadata; `.meta` is the raw `Y.Map`. |
| `node.field(name)` | Typed accessor — shape depends on the Kind-Schema declaration. |
| `node.fieldNames()` | Every atomic/text field name (excludes list fields). |
| Atomic: `.get()`/`.set(value, {notify?})`/`.isSet()`/`.observe(cb)` | |
| Text: `.get()`/`.insert(i, str, {notify?})`/`.delete(i, len, {notify?})`/`.observe(cb)`/`.ytext` | |
| List: `.push(value, {notify?})`/`.toArray()`/`.length`/`.observe(cb)` | |

### Envelope / Kind-Schema / grant / alias (`@qu/space-core`)

| Export | Purpose |
|---|---|
| `sealUpdate()` / `sealPublicUpdate()` | Seal a raw Yjs update into a signed (+ encrypted, for the first) envelope. |
| `verifyEnvelope(envelope, isAuthorizedWriter)` | Signature + ACL check, either mode. |
| `openUpdate(envelope, recipient?)` | Decrypt (encrypted mode) or pass through (public mode). |
| `defineKind(kind, {fields, acl?, notifyTopics?, persistence?})` | Declare a Kind-Schema. `persistence: 'durable'\|'volatile'` (default `'durable'`) — see §3.4. |
| `KindRegistry` | `.register()`/`.get()`/`.list()` static registry. |
| `deriveOwnerNodeId(ownerPub, kind)` | Self-certifying nodeId for `'owner'`/`'named'` Kinds. |
| `signGrant()` / `verifyGrant()` | `'named'`-ACL delegated-authority messages. |
| `deriveAliasIdentity(identity, spaceId)` | Deterministic per-space pseudonymous keypair. |
| `publishAlias(space, spaceId)` | Derive + publish this Space's alias to the registry. |
| `aliasRegistryKind` / `aliasRegistryNodeId(realPub)` | The registry Kind and its deterministic per-member nodeId. |
| `AliasRegistry` | Bus watcher maintaining an alias→real map. |
| `presenceKind` | Self-certifying `'owner'`-ACL, `persistence: 'volatile'` Kind — `online`/`status`/`updatedAt`/`typingIn`/`typingAt` (§3.5). |
| `presenceNodeId(pub)` | Deterministic presence Node id for `pub`. |
| `publishPresence(space, fields)` / `setStatus(space, status)` / `setTyping(space, nodeId, typing)` | Write this Space's own presence Node. |
| `watchPresence(space, pub)` | One-shot presence snapshot of another identity (subscribes if needed). |
| `PresenceWatcher` | Reactive multi-member presence cache off the bus — `.watch(pub)` / `.of(pubB64)`. |
| `encodeForWire()` / `decodeFromWire()` | Uint8Array ↔ base64 for any JSON boundary. |

### Relay / transport / federation (`@qu/space-transport`)

| Export | Purpose |
|---|---|
| `createRelayForwarder({hub, members, resolveKindSchema, storage?, volatileStorage?, bus?, presence?})` | The Relay. `volatileStorage` mirrors any `persistence: 'volatile'` Kind (§3.4), defaulting to a private `createMemoryStore()`. Returns `{seen, presence, addMember, ingestFederated}`. |
| `federateRelay({relay, bus, transport, identity})` | Wire a relay as a subscribing peer of another relay. Returns `{isFederated}`. |
| `createInProcessHub()` / `InProcessTransport` | Same-process transport, for tests. |
| `createWsServerHub(wss)` | Server-side hub over a real `ws` `WebSocketServer`. |
| `WsClientTransport` (also `@qu/space-transport/ws-client-transport`) | Real WebSocket client, browser-safe subpath. Auto-reconnects (backoff + jitter, backgrounded-tab recovery) by default (`{reconnect: false}` to opt out); `.onStatusChange(cb)` reports the lifecycle (§3.4). |
| `PresenceTracker` | `.setOnline()`/`.disconnect()`/`.isOnline()`/`.pubFor()`. |
| `registerPushHandler(bus, {sendPush, pattern?})` | Reference push delivery-channel handler. |
| `loadOrCreateIdentity(filePath)` / `describeIdentity(identity)` | A relay's own keypair — auto-generate-and-persist, and a printable public summary. |
| `createAppRequestHandler({webDir, members, relay, allowJoin?, onJoin?, log?})` | Shared HTTP handler: static browser app, `GET /members.json`, `POST /join`. |

### Storage (`@qu/space-storage`)

| Export | Purpose |
|---|---|
| `createMemoryStore()` | Ephemeral tier: `{append, load, replace}`. |
| `createDurableStore(backingStore?)` | Simulated-persistence tier (tests): same contract, plus `._backingStore`. |
| `createFileStore(dataDir)` | Real on-disk tier: same contract, one `.ndjson` file per Node. |

### Delivery status / upload outbox (`@qu/space-plugins`, OPTIONAL)

| Export | Purpose |
|---|---|
| `awaitRelayAck(bus, nodeId)` | Resolves on the next write-ack for `nodeId` (§3.5) — correlated by ordering. |
| `readReceiptKind` / `readReceiptNodeId(pub)` | Durable, self-certifying per-reader `'owner'`-ACL Kind holding an encrypted `{contentNodeId: {upTo, at}}` map. |
| `markRead(space, contentNodeId, upTo)` | Writes this Space's own read marker. |
| `watchReadReceipts(space, pub)` | One-shot snapshot of another identity's read receipts. |
| `ReadReceiptWatcher` | Reactive multi-reader cache — `.watch(pub)` / `.upToFor(pubB64, contentNodeId)`. |
| `uploadOutboxKind` | Self-certifying `'owner'`-ACL Kind, `records: {shape:'atomic', visibility:'public'}` map. |
| `UploadOutbox` | `.enqueue(meta, blob)` (fire-and-forget upload, resolves once locally saved+queued) / `.retry(id)` / `.statusOf(id)` / `.list()` / `.watch(id, cb)` (reactive). |

### UI bindings (`@qu/space-ui`, OPTIONAL)

| Export | Purpose |
|---|---|
| `bindField(el, field, {twoWay?, event?, prop?})` / `bindCheckbox(el, field)` | One/two-way reactive DOM↔Field binding. |
| `makeInlineEditable(el, field, {onSave?, onCancel?})` | `[contenteditable]` with Enter/blur = save, Escape = cancel. |
| `bindList(container, field, {key, render, update?})` | Keyed diff rendering of a list Field into a DOM container. |
| `bindFileInput(inputEl, outbox, {onEnqueue?})` / `bindUploadStatusIcon(iconEl, outbox, fileId, {classes?})` | Wires `<input type="file">` / a status icon to an `UploadOutbox`. |

### Declarative Components (`@qu/space-components`, OPTIONAL)

| Export/Element | Purpose |
|---|---|
| `<qu-view kind|.kindSchema node-id|.nodeId field attr?>` | Read-only, live-updating one-field binding. |
| `<qu-bind ... editable? edit-icon? event?>` | Two-way: live (default) or `editable="inline"` (explicit save/cancel with pencil/save/cancel icons). |
| `<qu-list kind|.kindSchema node-id|.nodeId field key? item-tag?>` (needs a `<template>` child) | Keyed, atomic-per-item list rendering. |
| `findQuSpace(el)` / `findQuKind(el, name)` / `resolveTarget(el)` | The ancestor-DOM resolution helpers the three Elements above are built on - `index.js`, plain-Node-importable. |
| import `"@qu/space-components/elements"` | Registers the three tags with `customElements` (browser/jsdom only - see §4's own doc comment on this package). |

## 6. Event topic reference

| Topic | Emitted by | Payload |
|---|---|---|
| `space.node.<nodeId>.changed` | Space | `{nodeId, kind, origin}` |
| `notification.<kind>.<topic>` | Space | `{nodeId, kind, topic, to, authorPub, origin}` |
| `space.member.joined` / `.left` | Space | `{pub, xPub, name}` / `{pub}` |
| `space.relay-admin.added` / `.removed` | Space | `{pub}` — see §7's "A fourth ACL mode" |
| `space.status.changed` | Space | `{status}` — from the transport's own `onStatusChange()`, §3.4 |
| `space.node.<nodeId>.write-ack` | Space | `{nodeId, seq}` — see §3.5's WRITE-ACK |
| `debug.space.write.local` / `.remote.accepted` / `.remote.rejected` / `.remote.ignored` / `.remote.undecryptable` | Space | write lifecycle — `.undecryptable`: authentic + ACL-ok, but this identity isn't a decryption recipient (e.g. history from before it joined) |
| `debug.space.subscribe.sent` / `.unsubscribe.sent` / `.hello.sent` | Space | `{nodeId}` / `{nodeId}` / `{}` |
| `debug.space.grant.received` / `.rejected` | Space | `{nodeId}` |
| `debug.space.compact.sent` | Space | `{nodeId, bytes}` |
| `relay.notify.<kind>.<topic>` | Relay | `{nodeId, kind, topic, to, authorPub, online}` |
| `relay.write.local` | Relay | `{nodeId, envelope}` — federation's own integration point |
| `debug.relay.write.received` / `.rejected` / `.forwarded` / `.mirrored` | Relay | write lifecycle |
| `debug.relay.subscribe.received` / `.rejected` / `.replayed` | Relay | subscribe lifecycle |
| `debug.relay.unsubscribe.received` / `.rejected` | Relay | unsubscribe lifecycle |
| `debug.relay.hello.received` / `.rejected` | Relay | presence handshake |
| `debug.relay.presence.online` / `.offline` | Relay | `{pub}` |
| `debug.relay.grant.received` / `.rejected` | Relay | `{nodeId, granteePub}` / `{nodeId}` |
| `debug.relay.member.joined` / `.left` | Relay | `{pub, name}` / `{pub}` |
| `debug.relay.relay-admin.added` / `.removed` | Relay | `{pub}` |

See each source file's own doc comment (§4's table) for the exhaustive,
authoritative version of this list — this table is a summary, not the
source of truth.

## 7. The App layer: Shell, Runtime, Content (Phase 1)

Full design rationale, alternatives considered, and how each piece maps to
the pre-existing framework primitives: **`docs/app-shell-arbeitsauftrag.md`**.
This section is the short version.

Above the framework (§1-6, unchanged, still UI/application-agnostic) sits a
generic App layer that lets the SAME `@qu/app-shell` boot different
applications (a CMS, a messenger, a forum, ...) purely from Qu content — the
Relay never learns what it's transporting is "a page" or "a template," and
`@qu/space-core` gained zero new concepts for this.

- **`@qu/app-core`** (`kinds.js`, `content-id.js`, `resolver.js`,
  `router.js`, `runtime.js`, `dev.js`, `relay-resolver.js`) — declares the
  application-content Kind-Schemas (`qu-app` manifest, `qu-route-registry`,
  `qu-page`, `qu-template`, `qu-style`, all ordinary `defineKind()` calls)
  and interprets them. `qu-page`/`qu-template`/`qu-style` are
  `acl.write: 'content'` (§3.2 above) — `deriveContentNodeId(ownerPub, kind,
  path)` (re-exported from `@qu/space-core`, its canonical home, via
  `content-id.js`) lets many pages/templates/styles exist per owner, each
  with GENUINE per-owner write-ACL (the owner, or anyone they've explicitly
  `grantWriter()`ed a specific route/name to) - not "any Space member," a
  real gap on a Relay hosting several independently-owned apps (§7's own
  "The Platform layer") that `'content'` mode closes. Subscribing to one
  needs no relay-side membership either (self-certifying, like
  `'owner'`/`'named'`) - the app's manifest and route registry stay
  `'owner'`/`'named'` (one per app) so an app is discoverable
  pre-membership the same way. `ContentResolver` wraps `Space.useNode()`
  with a bounded wait for sync; `AppRuntime` combines it with `HashRouter`
  (`#/<page>/...`) into one `resolveRoute()` call; `dev.js` is the
  Dev/Admin API that bootstraps an empty Space into a working app (its
  `createPage()`/`createTemplate()`/`createStyle()` only ever pass `path` -
  `Space.createNode()` derives the id AND self-grants for `'content'`-ACL
  Kinds itself, see space.js's own doc comment); `relay-resolver.js`'s
  `createAppResolveKindSchema()` builds the `resolveKindSchema(nodeId)` a
  relay needs to actually enforce this ACL (see relay.js's own doc comment
  on why an unresolvable nodeId can only ever fall back to flat
  `'members'` ACL). Zero DOM dependency.
- **`@qu/app-renderer`** (`sanitizer.js`, `slots.js`, `styles.js`,
  `render.js`) — turns an `AppRuntime.resolveRoute()` plan into DOM:
  `sanitizeHtml()` strips `<script>`/`on*`/`javascript:` from any
  Space-sourced HTML BEFORE it reaches `innerHTML` (the structural
  enforcement that arbitrary JavaScript is never auto-executed as content —
  Stufe 1 of docs' three-tier trust model; Stufe 3, signed Executable
  Modules, is intentionally not built yet — nothing in the renderer calls
  `import()` on anything Space-sourced), `resolveSlots()` fills
  `<qu-slot name="...">` placeholders, `renderPage()` composes both plus a
  Framework Default "not found" fallback for an unresolved route. No
  framework, no build step — same posture `@qu/space-ui` already commits to,
  and `@qu/app-shell` uses `@qu/space-ui`'s own bindings for anything
  reactive rather than duplicating them.
- **`@qu/app-shell`** (`identity.js`, `boot.js`, `shell.js`) — the ONE
  fixed piece of application JavaScript a Relay would serve (`shell.js`'s
  `<qu-app-shell>` custom element, a DOM mount marker, not a component
  system). `identity.js` generates/persists a browser identity and joins a
  relay's Space via its already-existing `POST /join`/`GET /members.json`
  (`@qu/space-transport`'s `relay-app-server.js`) — reused, not a new "public
  content" mechanism. `boot.js`'s `startApp()` is the DOM-aware half that
  wires an already-constructed `Space` to `@qu/app-core`/`@qu/app-renderer`;
  kept separate from `shell.js`'s network/`localStorage` glue specifically so
  it stays testable with an in-process `Space` + jsdom, no live relay needed
  (see `packages/app-shell/test/boot.test.js`, and `demo/app-shell-demo.mjs`
  for the same proof as a runnable script — `npm run demo:app-shell`).

**Wired to a real relay, including production**: `demo/app-shell-relay.mjs`
bundles `shell.js` (esbuild, the same way `demo/web/build.mjs` bundles
`demo/web/main.js`) and serves it via the same `relay-app-server.js` any
relay already uses — `npm run demo:app-shell-relay` (starts it) +
`npm run demo:app-shell-install` (a SEPARATE process, over a real
WebSocket, seeding a small demo app via `@qu/app-core`'s Dev API — the
actual "installer command") prove this against a real network, real disk
mirror (`createFileStore`), and a real browser tab, not just jsdom/
in-process. For production, `packages/app-shell/relay-server.js` (its own
`Dockerfile`, its own `docker compose --profile app-shell up`, see
`docs/v5-space-core-guide.md` §10's own "App Shell deployment" subsection)
composes the exact same `@qu/space-transport` primitives
`packages/space-transport/src/relay-server.js` does, configured via
`QU_APP_ADMIN_PUB` (a PUBLIC key only — the private key never touches this
relay, docs §19's Admin Identity model). It is a genuinely SEPARATE
entrypoint/image, not a change to `relay-server.js` itself: `@qu/space-transport`
must never depend on an application-layer package like `@qu/app-shell`/
`@qu/app-core` — "Relay bleibt Application-blind" (§1) has to stay true of
that file unconditionally, so `relay-server.js` keeps serving `demo/web/`
exactly as before, completely unaware `@qu/app-shell` exists; run the two
relays side by side (different ports/Spaces) to get both. `@qu/app-shell`'s
own `identity.js`/`shell.js` deliberately use ONE fixed `localStorage` key
(`IDENTITY_STORAGE_KEY`, `'qu-identity'`) for a browser's visitor
identity, not one derived per `app-admin-pub` — so a platform serving
several different `qu-app` apps from the same origin shares one identity
across all of them by design (see `identity.js`'s own doc comment for the
exact scope — per-origin, not cross-origin).

**Two real bugs the real-relay demo caught (both fixed, both regression-
tested)** that the earlier in-process/jsdom-only tests could not, because
they either shared one Space's own local state or ran fast enough to never
hit the race:

1. `kinds.js`'s `publicMeta()` — `defineKind()` always derives a
   `'members'`/`'content'`-mode Kind's META-STAMP visibility as
   `'encrypted'` (kind-schema.js), independent of what its FIELDS declare
   (true when `qu-page`/`qu-template`/`qu-style` were still `'members'`-ACL,
   and remains true now that they're `'content'`-ACL - the rule applies to
   both modes identically, see §3.2 above). A Node's meta-stamp is its
   Y.Doc's very first update, sealed only for whoever was a valid recipient
   AT CREATION TIME — and because Yjs integrates one author's updates as a
   strictly ordered, gapless sequence (grant.js's own "WRITE-BEFORE-GRANT
   IS A TRAP"), a visitor who joins LATER (the App Shell's core use case)
   could never decrypt that first update and could then never integrate
   ANY later update to that Node either, even though every field on
   `qu-page`/`qu-template`/`qu-style` is `visibility: 'public'`. Content
   would silently, permanently never render for that visitor. Fixed
   entirely in `@qu/app-core` (`metaVisibility` overridden to `'public'` on
   an otherwise-unchanged Kind-Schema) — no `@qu/space-core` change needed
   for THIS particular fix (the LATER move to `'content'`-ACL for real
   per-owner write-ACL did need one, see §3.2's own doc comment).
2. `resolver.js`'s `resolvePage()` used to gate readiness on the `title`
   field alone, then read `content` (a SEPARATE envelope) unconditionally —
   fine in-process (near-zero latency hides the race) but over a real
   network a page could be "found" and rendered before its own body text had
   actually synced. Fixed to wait for both fields, matching the pattern
   `resolveTemplate()`/`resolveStyle()` already used for their own single
   field.

Separately, `@qu/space-core`'s `Space._handleIncoming()`/
`_hydrateFromStorage()` no longer let `openUpdate()` throwing for a
legitimate "not a recipient of this envelope" case (e.g. `'encrypted'`-
visibility history from before a peer joined — the OLD chat demo's own
`demo-chat` Kind can hit this) escape as an uncaught exception — Node
terminates a process on an unhandled rejection by default (>=15), so this
used to be able to crash a real CLI client outright. See
`debug.space.write.remote.undecryptable` (§6) and
`packages/space-core/test/undecryptable-history.test.js`. This does NOT
retroactively fix the underlying Yjs gap for `'encrypted'`-visibility
content (a real, reported bug: a browser tab's identity is keyed by the
typed display name, so RENAMING is a brand-new identity joining late,
which used to mean that peer would never again see a message from anyone
who was already chatting — not just the messages predating the rename) —
`@qu/space-plugins`' new `autoCompactOnJoin(space, bus, nodeIds)` is the
actual fix: it watches `space.member.joined` and calls the pre-existing
`Space.compactNode()` on every registered Node, so an existing member's
copy recompacts (re-encrypted for whoever is a member NOW) the instant
someone new joins — closing the gap for everything written from that point
on. Wired into both `demo/chat.mjs` and `demo/web/main.js`; see
`packages/space-plugins/test/auto-compact.test.js` for the regression
proof and `demo/README.md`'s Caveats section for the full mechanics.

**The Platform layer (docs §19-21, revised): several apps, one Relay, ONE
relay Space.** Everything above assumes a Relay serves exactly one app,
owned by one app-admin. `@qu/app-core`'s `platformAppsKind`/admin-app
Kinds (`kinds.js`) + `PlatformRuntime` (`platform.js`) + the Dev API
(`dev.js`), and `@qu/app-shell`'s `startPlatform()` (`boot.js`) add a
second, separate way to boot the SAME `@qu/app-shell` that instead serves
however many independently-owned apps are reachable on one Relay - each
app self-certifyingly reachable at its OWN owner id with zero relay-admin
involvement, PLUS an opt-in, prettier alias layer a **relay-admin** - a
role distinct from any app's own app-admin - curates. For an ORDINARY
(`realm: 'main'`) app this role is deliberately NOT a superuser over that
app's content (registering an alias is not the same as being granted write
access to it); for a `realm: 'global'` app it deliberately IS - see
"Global apps, not just one admin console" further down for the full
"why" (in short: relay-admins collectively own global apps' content by
design, the same way they collectively own `qu-platform-apps` itself).
"Kein Sonderfall zu normalen Spaces" was the
guiding constraint here (a real question this design started from): the
built-in admin console is not special-cased framework UI at all, it is
installed Qu content like any other app, living in the exact SAME main
Space every other app's content does.

*Routing - two kinds of match, neither hardcoded to a path string:*

- **Registered alias** (opt-in, prettier): `qu-platform-apps` is now an
  `acl.write: 'relay-admins'` Kind (`@qu/space-core`'s kind-schema.js own
  doc comment on the mode - a flat, symmetric list, like `'members'`, but
  checked independently of ordinary Space membership), ONE GLOBAL registry
  per relay anchored on the fixed `PLATFORM_REGISTRY_ANCHOR` (`kinds.js`,
  the same idea `globalAppAnchor(prefix)` below uses, one anchor per app)
  rather than one Node per relay-admin's own pubkey - see this document's
  own "A fourth
  ACL mode" subsection further down for the full "why" and what changed.
  Holds an additive-only `ListField` of `{prefix, appAdminPub, name, realm}`
  - `ListField` has no removal primitive, so there is no `unregisterApp()`.
  `registerApp(relayAdminSpace, {prefix, appAdminPub, name})` is the
  relay-admin-signed write that mounts an already-installed app under a
  path prefix - installing content and registering a route are two
  different identities' writes on purpose (an app-admin installs their own
  app; only a relay-admin decides it's reachable under a nice name). An
  alias's mere EXISTENCE is not confidential (`'public'` visibility,
  `qu-platform-apps`'s own field) - only a `realm: 'global'` alias's actual
  CONTENT is (see below).
- **Default, registration-free**: `PlatformRuntime.resolveForPath(route)`
  falls back to trying the route's first path segment as a literal
  base64url-encoded owner pubkey (`QuCrypto.toBase64Url`/`fromBase64Url`)
  when no alias matches - any app-admin is reachable this way with ZERO
  relay-admin cooperation; `registerApp()` only ever adds a nicer name on
  top. This is what makes `installAppBundle(space, {manifest, templates,
  pages, ...})` (a plain-object Dev API bundle, no packaging format, no
  build step - `createApp()`/`createTemplate()`/`createPage()` under one
  call) sufficient on its own for an app to go live.

*One relay Space, not two (a real, deliberate simplification from an
earlier revision of this design):* a `realm: 'global'` alias
(conventionally named `"admin"`, but that is a NAMING convention the
bootstrap installer picks, not a router special case) resolves into the
built-in admin app's own content, living in the exact SAME main `Space`
every other app's content lives in - no second `Space`, no second
relay-forwarder, no `/admin-ws`. An EARLIER revision of this design put
that content in a wholly separate, genuinely confidential `Space`/
relay-forwarder (its own flat `members` list, its own WebSocket path,
`'encrypted'`-visibility content) - real, working, and regression-tested,
but it had a real operational cost: administering the platform required
generating a SECOND, dedicated identity and importing its private key
into the browser's `localStorage`, distinct from whatever identity that
same browser already uses for everything else (`loadOrCreateIdentity()`'s
own "remember me" identity). A real deployment surfaced exactly this as a
point of confusion - "why can't my browser's own identity, once listed as
relay-admin, just administer the relay?" (the same "one identity,
multiple owner-relationships" model QuV3 already used, and the same model
this whole document's Kind/ACL system is built around everywhere else).
The fix: fold the admin app's Kinds (`qu-admin-app`/`qu-admin-page`/
`qu-admin-template`/`qu-admin-style`, `kinds.js`'s own "GLOBAL APP CONTENT"
doc comment) into `acl.write: 'relay-admins'` - the EXACT SAME primitive
`qu-platform-apps` already uses (this document's own "A fourth ACL mode"
subsection) - anchored on `globalAppAnchor('admin')` instead of a separate
confidential transport (a later revision, see "Global apps, not just one
admin console" further down, generalizes this SAME anchor to any number of
apps, not only the built-in console). `resolver.js`'s `ContentResolver`
(and `runtime.js`'s `AppRuntime`) still take an optional `kinds` override
for exactly this - `boot.js`'s `startPlatform()` passes the `qu-admin-*`
set and that app's own `globalAppAnchor(prefix)` for a `realm: 'global'`
match, otherwise the ordinary public set and the matched app's own
`appAdminPub` - the SAME `AppRuntime`/`ContentResolver` code path, the SAME
`Space`, either way,
only WHICH Kinds differ.

The tradeoff, made explicit: the admin console's own MARKUP (a "register
an app" form, a list of already-`'public'`-visibility `qu-platform-apps`
entries) is now world-readable, like any other app's content - `publicMeta()`-
wrapped the same way `pageKind`/etc. are. There was never anything secret
IN it. WRITE access is unchanged and just as strict: only identities
listed in `QU_RELAY_ADMINS` can ever write it, checked independently by
every client's own `Space` (never just trusting the relay's own say-so) -
a non-admin's submit attempt through the exact same rendered form is
silently rejected by the relay, exactly like any other unauthorized write
in this framework, with no client-side way to tell the two cases apart (by
design - see `admin-actions.js`'s own doc comment).

**The built-in admin console is itself installed Qu content, not
hardcoded framework DOM-building** - `packages/app-shell/admin-console-
bundle.js` (a `{manifest, templates, pages}` bundle, the exact shape
`installGlobalAppBundle()` consumes) ships as this package's own reference
"Package," installed once via `packages/app-shell/bin/install-admin-
console.mjs` (a real, separate process holding the bootstrapping
identity's private key - connects ONCE to the main Space to both install
the content and register the `"admin"` alias - see that script's own doc
comment). From then on the console renders through the EXACT SAME
`AppRuntime`/`renderPage()` pipeline as any other app - `@qu/app-renderer`'s
`sanitizeHtml()` (Stufe 1 of the security model, docs §17-18) strips any
`<script>` from it same as anywhere else, so its one interactive bit (a
"register an app" form) is inert markup wired up by ONE piece of
framework-provided interactivity, `@qu/app-shell`'s `admin-actions.js`'s
`wireAdminConsole()` - a `<form data-qu-action="register-app">`/
`<ul data-qu-bind="platform-apps-list">` CONVENTION content declares by
attribute, exactly the same "framework wires ordinary DOM elements, content
stays inert markup" pattern `@qu/space-ui`'s `bindField()`/`bindCheckbox()`
already establish, never a loophole around Stufe 1. Its write-ACL is
enforced by the Relay, not this convention: submitting the form calls the
SAME `registerApp()` any script could, rejected by the relay exactly like
any other unauthorized write if the submitter isn't a configured
relay-admin.

`shell.js` picks `startPlatform()` over `startApp()` when its
`<qu-app-shell>` element carries a `relay-admin-pub` attribute instead of
`app-admin-pub` (priority order documented in `shell.js`'s own doc
comment) - one Shell, one JS bundle, either mode, decided per-deployment by
which attribute `index.html` sets; `relay-admin-pub`'s own VALUE carries no
meaning any more (see this document's own "A fourth ACL mode" subsection) -
only its PRESENCE does. In platform mode, `shell.js` constructs exactly
ONE `Space` (no second connection, no second identity) and eagerly fetches
`GET /relay-admins.json` to construct it with a matching `relayAdmins`
list (needed to independently verify `qu-platform-apps`/admin-app writes
at all - see "A fourth ACL mode" below). `packages/app-shell/relay-server.js`
wires the server side via `QU_RELAY_ADMINS` (a JSON array of PLAIN base64
signing pubkeys, e.g. `["<pub1>","<pub2>"]` - no `xPub`/encryption
recipient any more, since nothing here needs to decrypt anything - see
that subsection for the full reasoning) and `QU_APP_ADMIN_PUB` (the
single-app fallback, ignored once `QU_RELAY_ADMINS` is set) - see that
file's own doc comment for the full env-var reference, and
`docker-compose.space-relay.yml`'s `qu-app-shell-relay` service for the
same variables wired through Compose.

**The built-in CMS editor** (`packages/app-shell/cms-bundle.js` +
`src/cms-actions.js`) closes the "in-browser page/template editor" gap the
paragraphs above used to leave open: the SAME "installed content, not
hardcoded framework DOM-building" pattern as the admin console, applied to
an ORDINARY app's own templates/styles/pages instead of the platform's
alias registry. `installCms(space)` writes one template (`__cms__`) + one
page (`/cms`) into an app-admin's OWN Space via the ordinary
`createTemplate()`/`createPage()` - `/cms` isn't a reserved route
anywhere, it 404s like any unpublished route until installed, and is
deliberately left OUT of `publishRoute()`'s registry so it never appears
on a visitor-facing sitemap, the same way `#/admin` never appears in
ordinary app navigation. `boot.js` calls `cms-actions.js`'s `wireCms()`
unconditionally after every `renderPage()` in both `startApp()` and
`startPlatform()` (ordinary `realm: 'main'` apps only, not yet the
built-in admin app itself - see `cms-bundle.js`'s own doc comment on why) -
a cheap, correct no-op
unless the rendered page happens to be the CMS editor, exactly
`wireAdminConsole()`'s own posture, never a `<script>`-execution loophole
(Stufe 1 still strips those regardless). Three sections (templates,
styles, pages), each a list (one entry per name/route, click to load its
CURRENT content into a form and lock that key field) plus a create/edit
form - saving calls `@qu/app-core`'s Dev API `create*()`/`edit*()`
functions directly, so write-ACL is enforced by the relay exactly like any
other write, never by this UI. `edit*()` (`dev.js`) is the genuinely new
primitive underneath this: unlike `create*()`, it never calls
`Space.createNode()` again (which would derive a brand-new, disconnected
local Y.Doc and silently orphan the Node's existing remote history) -
`Space.useNode()` plus a direct field write instead, waiting for the
Node's own founding grant to have synced first. `grantContentWriter()`
extends this to "let a SPECIFIC other identity maintain exactly this
page" (the `ownerPub` parameter on every `edit*()` call is what makes a
grantee's write actually target the OWNER's Node id, not their own).

**A real, deployment-observed bug: `editPage()`/`editTemplate()`/
`editStyle()` throwing "does not exist (or has not synced)" for content
that plainly DOES exist.** `Space.useNode()` is ref-counted, and
`ContentResolver`'s own `resolveTemplate()`/`resolveStyle()`/`resolvePage()`
(what each CMS section's click-to-load handler calls, purely to populate
the form) each `useNode()` THEN `release()` internally - dropping the
refcount straight back to zero, which `Space.unsubscribeNode()` treats as
"nobody needs this Node locally any more" and DISCARDS the local Y.Doc
entirely (`space.js`'s own `_nodes.delete(id)`), not merely stops
live-pushing to it. Submitting the form moments later called `edit*()`
(`dev.js`), which does its OWN fresh `useNode()` - since the previous one
had been fully torn down, this had to re-subscribe and wait for the relay
to replay the Node's entire history again, a real network round-trip a
fixed ~2-3s timeout can genuinely lose to over an actual (non-localhost)
connection - the false "does not exist" error was really "did not
RE-sync in time," for content the user had just viewed successfully.
Never reproduced by this project's own tests (an in-process/localhost hub
has no meaningful round-trip time to lose the race against), only by an
operator actually using a real deployment. Fixed in `cms-actions.js`: each
section's click-to-load handler now calls `space.useNode()` itself, ONE
EXTRA TIME (`holdEdit()`), and keeps that reference alive until a
DIFFERENT item is loaded or the form is reset - long enough to keep the
refcount above zero for the entire "loaded into the form, being edited"
window, so the eventual `edit*()` call's own `useNode()` finds the Node
already fully synced and skips the network round-trip (and its timeout
race) entirely. `ContentResolver`'s own release-immediately posture is
otherwise unchanged (correct for ordinary rendering, where holding every
resolved Node open for a whole visit would leak subscriptions).

**A second, deeper real bug in the SAME family, also deployment-observed:
a route/template/style that had just been created or edited would appear
to VANISH from the CMS list right after a LATER, unrelated save - "/"
disappearing from the page list the moment a NEW page was created, for
example.** Two compounding causes, both fixed together:

1. `refreshList()`'s own `resolver.resolveTemplateNames()`/
   `resolveStyleNames()`/`resolveRoutes()` calls suffer the EXACT SAME
   release-to-zero problem as the bug above, just for the REGISTRY Node
   (`routeRegistryKind`/`templateRegistryKind`/`styleRegistryKind`)
   instead of one content Node - discarded and re-fetched from scratch on
   EVERY list refresh (i.e. after every single save), each refetch racing
   its own tight timeout.
2. Worse, `dev.js`'s `registerContentName()`/`publishRoute()` (what
   `createTemplate()`/`createStyle()`/a page's `publishRoute()` call use to
   add ONE entry to that SAME registry) used `space.getNode(id) ??
   space.createNode(...)` - treating "not currently attached in THIS Space
   instance" (true after every release above, regardless of whether the
   registry already has entries from an EARLIER call) as "doesn't exist
   yet," and `createNode()` would then fork a brand-new, causally-unrelated
   Y.Doc and `stampMeta()` it as if this were a first-ever creation -
   exactly the trap this document's own "`stampMeta()`... a competing doc
   for the same Node id" reasoning already warns against elsewhere, just
   never applied to registries before now.
   Fixed at the framework level, in `dev.js` itself: a new
   `getOrSyncRegistryNode()` helper `registerContentName()`/`publishRoute()`
   now share - `useNode()`+bounded-wait (500ms, matching
   `resolver.js`'s own already-accepted "does this registry exist yet"
   timeout) to discover an EXISTING registry before ever considering
   `createNode()`, checked via the Node's own `meta.get('kind')` (whether
   it has EVER been stamped) rather than the list field's length (an
   empty-but-real registry, the instant between its own creation and its
   first entry, must not be mistaken for "never existed"). Only a registry
   that genuinely has never been created pays the full 500ms before
   `createNode()` runs; any caller (like the CMS fix below) that keeps the
   registry Node held open across a session never pays it again.
   Also fixed in `cms-actions.js`, on top of the `dev.js` fix: each
   section now holds its OWN registry Node open (`holdRegistry()`, opened
   once per section at wiring time, same "never release during normal
   operation" posture as `holdEdit()` above) for the CMS session's whole
   lifetime, so `refreshList()`/`registerContentName()`/`publishRoute()`
   all find it already attached after the first call - not just
   eventually-correct (the `dev.js` fix alone already guarantees that) but
   actually FAST, with zero further network round-trips for the rest of
   the visit.
   Verified end-to-end against a real relay + real headless-browser
   session: editing the root page, then creating THREE further pages in
   sequence (`/blog/post1`, `/blog/post2`, `/blog/post3`, `/about`), each
   one immediately visible in the CMS list alongside every earlier one -
   and every single page (the edited root page included) renders correctly
   for a completely independent, anonymous visitor session afterward.

**The relay's own unconfigured setup page is itself a working Qu identity
tool, not just static instructions** (`build.mjs`'s `renderIndexHtml()`,
the "neither QU_APP_ADMIN_PUB nor QU_RELAY_ADMINS is set" branch): it
now loads the SAME `/bundle.js` a configured deployment serves, which
`shell.js` runs unconditionally regardless of whether a `<qu-app-shell>`
element exists on the page (`dev-console.js`'s `initDevConsole()`,
called at the bottom of `shell.js`). This assigns `window.Qu` - the
identity `loadOrCreateIdentity()` already creates-once-and-persists under
`IDENTITY_STORAGE_KEY` (`identity.js`, the SAME "remember me" mechanism
an ordinary visitor's boot already uses, not a second one invented for
this) - and renders its base64 signing/X25519 pubkeys into any
`[data-qu-pub]`/`[data-qu-xpub]` element the page declares, which the
setup page's own markup does: an operator sees their bootstrapping
identity's exact `QU_APP_ADMIN_PUB`/`QU_RELAY_ADMINS` value (a single
base64 signing pubkey either way) on the page
itself, no devtools or separate script required just to GENERATE and
copy it (a `Qu.regenerate()` console call is still there for anyone who
wants a fresh one). Two identity-bootstrapping code paths on ONE page
(this dev console AND, once configured, `<qu-app-shell>`'s own boot) can
now legitimately race for the SAME storage key on the SAME page load -
`identity.js`'s `loadOrCreateIdentity()` de-duplicates concurrent callers
per key (an in-flight promise cache) specifically because of this, not
just as defensive programming: without it, two callers racing a
never-yet-created key would each generate their OWN keypair (Web Crypto
key generation is genuinely async, unlike the synchronous `storage.getItem()`
check that precedes it), with the second write silently orphaning the
first.

**Structured page data and Collections** (the user's own framing: "eine
komplexere Datenstruktur in einem passenden Schema," "Slots im Template
... zu einem Datenpfad ... füllen," "nicht nur Titel und Inhalt, sondern
auch Daten wie current User Alias oder Blog-Post") — Phase 1 of a larger,
explicitly layered roadmap toward reactive-component templates and a
real headless-CMS-style content model, not the whole vision at once:

- **`pageKind`'s new `data` field** (`kinds.js`) — an arbitrary JSON
  object alongside the existing `content` blob; each top-level key
  resolves into the SAME-NAMED `<qu-slot>` in the page's template
  (`@qu/app-renderer`'s `render.js`), so a template author defines
  however many named slots a page actually needs (an author byline, a
  view count, ...), not just one hardcoded `"content"` - `slots.js`'s own
  `resolveSlots()` already supported arbitrary slot names from the start,
  this only generalizes what DATA gets handed to it. Fully additive/
  backward compatible: `data: null` (the default) contributes no extra
  slots. `cms-actions.js`'s page form gained a matching JSON textarea.
- **Collections** (`kinds.js`'s `defineCollectionKind()`) — many
  STRUCTURED items of one caller-defined shape under one owner (a blog's
  posts, a contact list, a forum's threads, a chat's messages), the exact
  same `acl.write: 'content'`-item + `acl.write: 'named'`-registry
  pattern `qu-page`/`qu-template`/`qu-style` already establish,
  generalized into ONE reusable call instead of a bespoke Kind-Schema
  pair per use case - `dev.js`'s `createCollectionItem()`/
  `editCollectionItem()` and `resolver.js`'s `resolveCollectionItems()`/
  `resolveCollectionItem()` are the generic counterparts to
  `createTemplate()`/`editTemplate()`/`resolveTemplateNames()`/
  `resolveTemplate()`. `relay-resolver.js`'s `createAppResolveKindSchema()`
  gained a matching `collectionRegistryKinds` parameter - a Collection's
  REGISTRY Kind needs telling apart from the `pageKind` fallback for the
  exact same reason `qu-template-registry`/`qu-style-registry` already
  do (misclassifying it silently breaks `createCollectionItem()`'s own
  enumeration write - proven by a dedicated regression test, not just
  asserted).

**Phase 2, reactive/live component bindings — DELIVERED**
(`packages/space-components/`, `@qu/space-components`): the user's own
stated goal was "Daten aus dem Storage reactive genutzt... wenn irgendwie
möglich/sinnvoll/hilfreich" (Space data used reactively wherever
possible/sensible) and templates that "einfach auf ... reaktiven
Components bestehen." `pageKind.data` (Phase 1, above) is STATIC,
author-entered structured content - this phase is the actual live
binding.

A prior draft of this section treated "the current visitor's identity" as
needing its own separate design (what it resolves to, how a template
would declare it specially). That was wrong, and QuV5's own prior-art
sibling project (`ReactivityJS/QuV3`, `packages/ui/src/components.js` +
`packages/services/src/profile-service.js`) showed why: a visitor's own
identity is not a distinct binding *kind* at all, just an ordinary Space
reference computed from a pubkey the runtime already has - QuV3's
`ProfileService.getOwnProfile()` builds it as
`actorPath(QuCrypto.toBase64Url((await identityEngine.getMainKey())
.publicKey), 'profile')`, a plain helper call, not a framework special
case, then hands the resulting STRING straight to the same binding
primitive every other path uses. QuV3's reactive Components (`<qu-view>`,
`<qu-bind>`, `<qu-list>`, `<qu-if>`) have no "current user" concept
anywhere: each takes a `path` attribute (a plain string, since Custom
Element attributes are always strings), resolved by `resolvePath()`, and
reach their target Qu instance by walking up the DOM for a `.qu` property
(`findQu()`) rather than a global singleton.

`@qu/space-components` (`packages/space-components/`, §4/§5) ports that
design onto QuV5's own primitive (`@qu/space-ui`'s `bindField()`/
`bindList()` - QuV5's equivalent of QuV3's `watch()`/`watchChildren()`,
which already existed but was purely imperative): `<qu-view>` (read-only),
`<qu-bind>` (two-way - live by default, or `editable="inline"` for
explicit save/cancel editing with a pencil/save/cancel icon UI, built on
`@qu/space-ui`'s `makeInlineEditable()`), and `<qu-list>` (keyed, ATOMIC
per-item rendering off a list Field, via `bindList()` - only a changed
item re-renders, never the whole list). A visitor's own profile alias is
bound exactly the same way as any other field - `<qu-view kind="profile"
node-id="..." field="alias">`, the id supplied as a computed JS property
(`el.nodeId = ...`) rather than a typed attribute only because it's
computed, never because it's special (resolve.js's own doc comment).
`@qu/app-shell`'s `boot.js` sets `mountEl.quSpace` on every navigation
(the ADMIN realm's separate `Space` included) so any Component rendered
inside a page finds it via DOM ancestry, the same `findQu()`-style pattern
QuV3 uses; an app's own Kind-Schemas (e.g. a Collection item Kind) become
bindable by `kind="name"` attribute the same way, by that app setting its
own `.quKinds = {name: kindSchema}` on `<qu-app-shell>` or any wrapping
element - `@qu/space-components` itself ships no built-in registry (it
has no idea what Kinds any given app defines).

Two things deliberately scoped OUT of this delivery, left as documented
extensions rather than built speculatively: QuV3's DERIVED lists (many
sibling Nodes, e.g. this framework's own Collections - `<qu-list>` here
only handles the CURATED case, one Node's own list Field IS the data) and
`sanitizeHtml()` interaction beyond what already holds - a live-binding
Custom Element tag is framework-wired markup like `cms-actions.js`'s own
forms, never inline `<script>`, and `attr="innerHTML"` is refused outright
(qu-view.js's own doc comment) rather than reopening the injection risk
`sanitizeHtml()` exists to close.

**Still deliberately NOT done** (named explicitly, not hidden as an
afterthought):
- **Phase 3, Collections wired into routing/CMS authoring**: a
  Collection's items aren't hooked into `HashRouter`/`AppRuntime.
  resolveRoute()` yet (a blog's individual posts don't get their own
  `#/...` sub-routes the way `qu-page` does automatically), and the CMS
  editor (`cms-actions.js`) has no UI yet for AUTHORING a brand-new
  Collection type (defining its own field schema from the browser) or
  managing its items - today a Collection is a Dev-API/test-proven
  primitive a developer wires up in code (see `defineCollectionKind()`'s
  own doc comment), not yet something an app-admin can create from
  `#/<prefix>/cms` the way a template/style/page already can.

Field-level/namespace ACL (docs §21), signed Executable Modules (§17 Stufe
3), and publish/draft states (§26) remain explicitly future work. Editing
the built-in admin app's own console content through this same CMS UI also
remains future work (its `qu-admin-*` Kinds have no registries/`edit*()`
counterparts yet - `bin/install-admin-console.mjs` remains the only way to
update it) - see docs/app-shell-arbeitsauftrag.md's own "Nicht-Ziele".

**A fourth ACL mode, `'relay-admins'`, and the end of "one static list per
concern":** the paragraphs above used to document a real, accepted gap -
registering a genuinely NEW app-admin needed a STATIC, boot-time
`QU_APP_ADMIN_PUBS` entry and a relay restart, because `resolveKindSchema`
is a plain synchronous function `relay.js` never awaits (relay-resolver.js's
own doc comment). Two changes close this:

- **`acl.write: 'relay-admins'`** (`@qu/space-core`'s kind-schema.js) - a
  flat, symmetric write-ACL list, like `'members'`, but checked against a
  list a `Space`/relay is constructed with SEPARATELY from ordinary Space
  membership (`Space`'s and `createRelayForwarder()`'s own new
  `relayAdmins` param, both independently enforcing the SAME check - never
  trusting the relay's say-so, the same posture every other ACL mode
  already takes). This is what `@qu/app-core`'s `platformAppsKind` (the
  `qu-platform-apps` registry) needed all along and never had a mode for:
  content that must (a) live in the OPEN-JOIN main Space (so ordinary
  visitors can read it with zero membership - `'members'`-ACL there would
  let ANY self-joined visitor write it too) and (b) be writable by SEVERAL
  co-equal, boot-time-configured admins with no single "owner" and no
  manual per-admin `grantWriter()` dance (unlike `'named'`, which needs one
  real keypair as the self-certifying owner and THAT owner's own private
  key to sign a grant for every other admin - something a relay operator's
  config alone can never do, since the relay never holds anyone's private
  key).
- **`qu-platform-apps` is now ONE GLOBAL registry**, anchored on a fixed,
  non-cryptographic `PLATFORM_REGISTRY_ANCHOR` (`kinds.js`, the same idea
  `globalAppAnchor(prefix)` uses one section up, just a single anchor
  instead of one per app) instead of one Node per relay-admin's own pubkey
  - a real, deliberate change from the
  earlier `'named'`-ACL shape, which only ever let ONE relay-admin's own
  registry be consulted at all (`PlatformRuntime` took a single
  `relayAdminPub`); this shape genuinely lets several relay-admins share
  one registry, symmetrically.
- **`QU_RELAY_ADMINS`** (`packages/app-shell/relay-server.js`) replaces the
  THREE previously separate `QU_RELAY_ADMIN_PUB`/`QU_APP_ADMIN_PUBS`/
  `QU_RELAY_ADMIN_MEMBERS_JSON` env vars with ONE JSON array of PLAIN
  base64 signing pubkeys, e.g. `["<pub1>","<pub2>"]` - the ONE static list
  a platform deployment needs at all. No `xPub`/encryption-recipient half
  - `'relay-admins'`-ACL never needs one (nothing it gates is encrypted any
  more, see "One relay Space, not two" above), unlike the ill-fitting
  `{pub, xPub}` shape an earlier revision carried over from `'members'`-ACL
  purely because it also doubled as a confidential Space's own member list
  back then. `GET /relay-admins.json` (unauthenticated, same posture as
  `/members.json`) publishes exactly this list so any visitor's own
  `Space` (`@qu/app-shell`'s `shell.js`, in platform mode only) can
  independently verify `qu-platform-apps`/admin-app writes itself, never
  just trusting the relay.
- **Live app-admin discovery** (`packages/app-shell/src/
  live-app-resolver.js`'s `createLiveAppResolveKindSchema()`) is the actual
  fix for "new app-admin needs a restart": the relay connects an INTERNAL,
  read-only `Space` to ITSELF, over a REAL WebSocket loopback connection
  (`WsClientTransport`, exactly what any ordinary peer/browser uses - NOT
  `InProcessTransport`: that primitive only works against a hub built by
  `createInProcessHub()`, which also plays the peer-registration role;
  `createWsServerHub()` - what a real relay actually uses - deliberately
  has no such API, only real socket connections, so `relay-server.js`'s
  `main()` calls `start({url: ws://127.0.0.1:<port>, ...})` only AFTER
  `httpServer.listen()` has actually resolved) and watches
  `qu-platform-apps` - now writable by any configured relay-admin -
  rebuilding its `resolveKindSchema`'s app-admin classification every time
  that registry changes. A relay-admin calling `registerApp()` (e.g.
  through the built-in admin console) is therefore enough on its own -
  "app installieren" and "App-Admin autorisieren" collapse into the ONE
  step they conceptually always were. `resolveKindSchema` itself stays a
  small, synchronous, pure function either way (`relay.js` unchanged) -
  only WHICH sets it classifies against gets swapped reactively, via a
  stable delegating closure. This is deliberately layered in `@qu/app-shell`,
  not `@qu/app-core` - `@qu/app-core`'s own `src/` has no real dependency
  on `@qu/space-transport` (only a devDependency, used by its tests), so it
  stays transport-agnostic; `@qu/app-shell` already composes both.
- **ORDERING MATTERS NOW for provisioning a brand-new app** - a real,
  end-to-end-tested consequence of the above: a relay-admin's
  `registerApp({prefix, appAdminPub, name})` write must actually reach the
  relay (and its internal live-resolver Space must have rebuilt from it)
  BEFORE that app-admin's own FIRST write (their `qu-app` manifest, a
  `'named'`-ACL, self-certifying Kind) - otherwise the relay still
  misclassifies their manifest Node against the ordinary `'content'`-ACL
  fallback (kinds.js's own doc comment), which needs a grant nothing ever
  sends, so the write is silently rejected. Under the OLD static
  `QU_APP_ADMIN_PUBS` model this never mattered (every app-admin was known
  from boot); `packages/app-shell/bin/bootstrap-platform.mjs` had to be
  reordered for this reason - it now registers the demo app's prefix and
  waits for that write to be acked (plus a short settle for the relay's own
  live-resolver to catch up) BEFORE connecting as `demo-app-admin` and
  writing any of its content, not after.
- **`GET /relay-admins.json` returns bare base64 STRINGS, not `{pub,
  xPub}` pairs** (unlike `/members.json`) - a real
  bug this design caught: `shell.js` originally reused `fetchMembers()`
  (built for the `{pub, xPub}` shape) against this endpoint, silently
  misparsing every entry (`m.pub` on a bare string is `undefined`), which
  left every visitor's own `Space` unable to verify ANY `qu-platform-apps`
  write it received - the platform silently looked empty to every browser
  even though the CLI-driven bootstrap had installed everything correctly.
  Fixed with a dedicated `fetchRelayAdmins()` (`identity.js`) that decodes
  the plain pubkey array directly.
- **`bootstrap-platform.mjs`'s identity directory must actually PERSIST,
  or the relay-admin identity is silently ephemeral** - a real deployment
  footgun this design caught in practice, not a theoretical one: the
  script's default `--dir` lives next to the script itself, inside the npm
  package/container image. Running it repeatedly against the SAME
  already-running container works fine (same filesystem), but `docker
  exec`ing into a container that later gets REDEPLOYED (a very natural
  pattern on managed platforms like Rancher/Kubernetes, where exposing an
  extra port or a separate toolchain just to bootstrap once is
  inconvenient) silently generates a BRAND-NEW relay-admin/demo-app-admin
  keypair on every redeploy - nothing mounts that path as a volume, so a
  fresh container has a fresh filesystem. The observed symptom: a
  different `QU_RELAY_ADMINS` value printed every time, and the OLD
  relay-admin loses write access to everything it previously administered
  (the admin app's own content included) the instant that identity is gone
  from the list - this is a deployment-invocation bug, not a flaw in the
  `'relay-admins'` ACL mechanism itself. Fixed three ways: (1)
  `QU_BOOTSTRAP_DIR` env var lets
  an operator point the identity directory at durable storage without an
  explicit `--dir` every time; (2) the script now warns LOUDLY whenever
  neither is set, rather than silently doing the ephemeral thing; (3)
  `docker-compose.space-relay.yml` ships a dedicated
  `qu-app-shell-relay-admin-identity` volume (mounted at `/admin-identity`,
  `QU_BOOTSTRAP_DIR` defaults to it there) as the reference setup for
  anyone who does need the `docker exec` flow - kept as a SEPARATE volume
  from the relay's own `/data`, not merged into it, to keep "the relay's
  own mirror" and "an administrator's local private key material"
  conceptually distinct trust domains even when they happen to live on the
  same host.
- **Revocation remains open** for `qu-platform-apps`'s CONTENT: its `apps`
  field is a `ListField` with no removal primitive, so there is still no
  `unregisterApp()` - real, separate work if "revoke a registered app's
  alias" is ever needed. This is UNRELATED to admin/member revocation
  (below), which the underlying identity list already supports fine.

**`addMember()`/`removeMember()` and `addRelayAdmin()`/`removeRelayAdmin()`
- ONE shared mechanism for both lists, not two:** removing a relay-admin
(or an ordinary `'members'`-mode member) from `QU_RELAY_ADMINS`/
`QU_MEMBERS_JSON` and RESTARTING the relay process already revokes their
rights completely and correctly - a fresh process builds `memberPubs`/
`relayAdminPubs` directly from the CURRENT config, so a removed identity is
simply absent, with no stale state to reconcile. This does NOT affect
already-installed apps/pages/templates at all (those are separate,
self-certifying `'content'`-ACL Nodes an app-admin owns independently -
revoking a RELAY-admin never touches them) - only future `qu-platform-apps`
writes and admin-app writes by the removed identity stop working.

What a plain restart canNOT do is update an ALREADY-CONNECTED client
mid-session (its own `Space` object keeps whatever `members`/`relayAdmins`
it was constructed with until it reconnects) - `@qu/space-transport`'s
relay.js now has the genuinely missing, symmetric primitive for this:
`removeMember(pub)` (the exact inverse of the pre-existing `addMember()`)
and, for the SAME reason, `addRelayAdmin(pub)`/`removeRelayAdmin(pub)` for
the separate `relayAdminPubs` list - deliberately the SAME shape (a Set
mutation + a reactive `{type: '...'}` broadcast to every connected peer) for
BOTH lists, so "relay-admins and ordinary members are handled with one
concept" is true of the MECHANISM, not just the vocabulary; they stay two
named lists only because their trust boundaries differ (`'members'` lives
inside a Kind's own visibility/Space; `'relay-admins'` is checked
independently of Space membership entirely - see this document's own
opening paragraph on the mode for why that split can't collapse into one
list without re-opening `qu-platform-apps` to any self-joined visitor).
`@qu/space-core`'s `Space` gained the exact mirror-image client methods
(`removeMember()`/`addRelayAdmin()`/`removeRelayAdmin()`) plus incoming-
message handling for `'member-left'`/`'relay-admin-added'`/
`'relay-admin-removed'`, so an already-open browser tab's own view updates
reactively the instant the relay calls these - no reconnect needed.

**Not yet wired to `QU_RELAY_ADMINS`/`QU_MEMBERS_JSON` changing without a
restart** - `relay-server.js`'s `main()` still only ever reads these env
vars ONCE, at process start, and calls neither `addMember`/`removeMember`
nor `addRelayAdmin`/`removeRelayAdmin` itself. The primitives above make a
FUTURE "reconfigure a running relay without dropping connections" trigger
(a diff of old vs. new config calling `add*`/`remove*` for exactly the
identities that changed, from e.g. a SIGHUP handler or an admin-UI action)
straightforward to build - deliberately not built in this pass, since it
needs its own trigger-mechanism decision first.

**Global apps, not just one admin console - relay-admins administer ALL
of them, not only register them:** a real gap surfaced by an operator
actually using this: relay-admins could register a third-party app under a
prefix (`registerApp()`), but that app's own PAGES stayed `'content'`-ACL,
owned by whichever ONE identity created them - a relay-admin, even one
listed as such from boot, had no automatic write access to it. The
built-in admin console's own `'relay-admins'`-ACL content was the ONE
exception, hardcoded as a SINGLE app anchored on one fixed constant
(`ADMIN_REALM_ANCHOR`, an earlier revision of this section). Matching the
user's own original framing from the very start of this design - "Admins
verwalten auch erstmal die globalen Apps und CMS-Inhalte" (admins ALSO
administer the global apps and CMS content, for now) - this is generalized
from "the one admin console" to ANY number of relay-admin-administered
"global" apps:

- `kinds.js`'s `globalAppAnchor(prefix)` replaces the single fixed
  `ADMIN_REALM_ANCHOR` with one anchor PER PREFIX (`sha256("qu-global-app:"
  + prefix)`) - the built-in admin console is simply `globalAppAnchor('admin')`,
  no longer a framework special case. The SAME `qu-admin-*` Kinds (kept
  their name for continuity) now serve EVERY global app, told apart only by
  which anchor their ids are derived from.
- `platformAppsKind`'s `realm` field is `'main'|'global'` now (renamed
  from `'admin'`, which was really always "this alias has no single
  owner," not "this is THE admin console specifically") - `registerApp(...,
  {realm: 'global'})` works for any prefix, not just `"admin"`.
- `dev.js` gained a full parallel Dev API - `createGlobalApp()`/
  `createGlobalTemplate()`/`createGlobalStyle()`/`createGlobalPage()`/
  `installGlobalAppBundle()`/`editGlobalTemplate()`/`editGlobalStyle()`/
  `editGlobalPage()`/`publishGlobalRoute()` - each taking `prefix` where
  the ordinary `create*()`/`edit*()` take `ownerPub` (or default to
  `space.identity.signingPub`). ANY configured relay-admin can call these
  for ANY global app - not just whoever created it - which is the actual
  point: no per-admin `grantContentWriter()` bootstrapping, and a relay-
  admin added LATER automatically gets full write access too, the same
  "checked independently of who created it" property `'relay-admins'`-ACL
  already gives `qu-platform-apps` and the admin console itself.
- **A brand-new global page needs its OWN dynamic discovery, the same way
  a brand-new app-admin already did** - `kinds.js` gained
  `adminRouteRegistryKind` (`'relay-admins'`-ACL counterpart to
  `routeRegistryKind`, one Node per global app, anchored the same way);
  `publishGlobalRoute()` writes to it, and `@qu/app-shell`'s
  `live-app-resolver.js` now watches EVERY currently-known global app's OWN
  route registry (discovered reactively from `qu-platform-apps` itself,
  the same `realm: 'global'` entries), rebuilding the live
  `resolveKindSchema` whenever any of them changes - a relay-admin
  publishing a brand-new route under an EXISTING global app needs no relay
  restart, mirroring `qu-platform-apps`'s own live-discovery story one
  level down. **Ordering matters here too, the exact same reason
  `bootstrap-platform.mjs`'s own "REGISTER FIRST, THEN SEED CONTENT" doc
  comment already documents for a brand-new app-admin**: `publishGlobalRoute()`
  must land (and the relay's own watcher must have rebuilt) BEFORE
  `createGlobalPage()`'s own write for that SAME route, or the relay still
  classifies the page against the generic `'content'`-ACL fallback and
  silently rejects it - `cms-actions.js`'s own submit handler publishes the
  route, waits a short settle, THEN creates the page, in that order,
  exactly for this reason.
- **Deliberately NOT yet built**: templates/styles have no equivalent
  registry - `createGlobalTemplate()`/`createGlobalStyle()` only work for
  names a relay was STATICALLY configured to expect (true for the built-in
  console's own `"main"` template, its own default; NOT true for any other
  global app's non-default template/style names, which the relay silently
  rejects until this gap is closed) - matching the priority the user
  themselves set ("Das eine sind pages im Storage abzulegen. Und Templates
  und Styles optional") - pages first, templates/styles a deliberate,
  separate scope cut, not an oversight.
- `cms-actions.js`'s `wireCms({..., global, prefix})` gained a genuine
  "global mode": the SAME CMS editor UI now works against a global app's
  content (via `createGlobalPage()`/`editGlobalPage()`/
  `publishGlobalRoute()` and the matching `kinds`/`appAdminPub` override on
  its `ContentResolver`) instead of only an independently-owned app's own
  Space - `boot.js`'s `startPlatform()` wires it this way for any `realm:
  'global'` route OTHER than the built-in admin console itself (which
  keeps its own dedicated `wireAdminConsole()`). The templates/styles
  sections of the CMS editor are a deliberate no-op in global mode (no
  registry to enumerate against yet, see above) - only the pages section is
  wired.

Verified end-to-end against a real relay with TWO independent relay-admin
identities and no restart between steps: relay-admin A registers a
brand-new global app ("blog") and creates its home page; relay-admin B - a
completely different identity, never involved in creating anything above -
edits that SAME page and creates a brand-new one under the SAME app,
BOTH through the real browser CMS UI (`#/blog/cms`), not just the Dev API
directly; every result is independently readable by a fresh, uninvolved
visitor identity afterward.

**Three real bugs this generalization itself introduced, all deployment-
observed on a genuinely fresh (wiped-data) setup, not caught by the tests
written alongside the original change:**

1. `live-app-resolver.js`'s reactive `rebuild()` always passes an explicit
   `globalApps` array to `createAppResolveKindSchema()` - silently
   bypassing that function's own STATIC default (`templateNames: ['main']`
   for prefix `"admin"`, matching what `admin-console-bundle.js` ships)
   the moment PLATFORM mode's live resolver takes over, even for the
   built-in console itself. Since global apps have no template registry
   yet (see above), the console's own `"main"` template had no other way
   to stay classified - its write got silently rejected, and the console
   rendered through `@qu/app-renderer`'s template-not-found fallback (or,
   combined with bug 2 below, a literal "404"). Fixed with a hardcoded
   `KNOWN_GLOBAL_TEMPLATE_NAMES = {admin: ['main']}` map in
   `live-app-resolver.js` - the same "small, fixed, known set" posture the
   admin console's content has always had, just made explicit now that the
   STATIC default alone is no longer reachable in platform mode.
2. `bin/install-admin-console.mjs` and `bin/bootstrap-platform.mjs` never
   called `publishGlobalRoute()` for the admin console's own `"/"` page at
   all (a requirement `adminRouteRegistryKind`/`live-app-resolver.js`
   introduced for every global app, this document's own bullet above) -
   `bootstrap-platform.mjs` additionally installed the console's CONTENT
   before even registering `"admin"` as an alias, the exact inverse of the
   "register/publish before seeding" ordering this section already
   requires one level down for a global app's pages. Both scripts now
   strictly: register the alias -> wait for the write to be acked and
   settle -> publish its route -> wait/settle again -> install content.
3. `bin/install-admin-console.mjs` printed "✅ Installiert." unconditionally,
   even when every write above was silently rejected (the identity running
   it not yet actually configured as a relay-admin on the RUNNING relay -
   a very easy state to be in right after a fresh deploy, since the
   identity is only generated on a script's first run and has to be pasted
   into `QU_RELAY_ADMINS` and redeployed before a SECOND run can actually
   write anything - see the root `README.md`'s "Deploying the App Shell"
   section). `bootstrap-platform.mjs` already guarded against this
   (`trackWrites()`/`waitUntilAllWritesAcked()`); `install-admin-console.mjs`
   now does too, and reports failure with the same "add this pubkey to
   QU_RELAY_ADMINS and redeploy" guidance instead of lying about success.

All three verified against a real `relay-server.js` process: bug 1+2 via a
regression test that exercises the REAL, reactive `live-app-resolver.js`
(not just the static resolver a plain unit test would use) for a
dynamically-registered `"admin"` global app, checked from a DIFFERENT
relay-admin identity than the one that wrote the content
(`packages/app-shell/test/live-app-resolver.test.js`); bug 3 via a real
relay process in both the misconfigured and correctly-configured state,
plus a real headless-Chromium check that `#/admin` genuinely renders (no
404) once fixed.

**Three administrable states, not a feature-gate (a later revision):** once
relay-admins could administer global apps, a real, sharp design question
followed - should a relay-admin also be able to enable/disable a global
app for ALL users, or just some, with a black-/whitelist for exceptions? A
per-Kind, per-app "feature gate" the relay enforces (a registry saying
`{mode: 'allow-all'|'deny-all', exceptions: [...]}`, consulted by
`buildWriteAcl()` IN ADDITION to a Kind's own `acl.write`) was designed in
detail and then DELIBERATELY REJECTED, for a reason worth keeping: it
would need to be repeated per app (Calendar, Forum, CMS, ...), reintroducing
exactly the app-specific-relay-logic problem `'relay-admins'`-ACL itself
was built to avoid, and it draws an inconsistent line - if a Gästebuch/
Blog/Kalender legitimately lets any user write into their OWN
`'content'`-ACL namespace with no gatekeeper (the whole point of
self-certifying ownership, see "GLOBAL APP CONTENT" above), a CMS wanting
a DIFFERENT rule ("nobody may, except...") is solving the wrong problem:
self-owned content is, by design, never meant to be gate-able - nobody
needs anyone's permission to write their OWN Node, full stop. Landed on
instead - three states per `realm: 'global'` app
(`platformAppsKind.apps[].mode`, `kinds.js`'s own doc comment on the
field, `dev.js`'s `setAppMode()`), ALL of them free consequences of
primitives that already existed, no relay change needed at all:

- `'off'` - not routable (`PlatformRuntime.resolveForPath()` returns
  `null`, indistinguishable from never having been registered) - a
  registration/routing decision, not an ACL one.
- `'global'` (the pre-existing, only-ever behavior before `mode` existed) -
  only relay-admins may write, `qu-admin-*` Kinds exactly as before.
- `'multiuser'` - the global shell stays exactly as in `'global'` mode,
  PLUS every visiting identity (relay-admins included, with no special
  role) may ALSO maintain their own content under `#/<prefix>/u/<ref>/...`
  (`ref` = `"me"` or another identity's own base64url pubkey -
  `boot.js`'s `parseMultiUserSubPath()`/`renderMultiUserRoute()`), an
  ORDINARY `AppRuntime`/`wireCms()` pair addressed at that identity's own
  pubkey instead of the global anchor - no relay-admin cooperation, no
  registration, no grant, just the ordinary `'content'`-ACL self-grant any
  `createPage()` already has. A brand-new visitor's first-ever `/u/me/`
  self-provisions a minimal manifest + CMS editor on the spot
  (`ensureSelfProvisioned()`) - checked via `ContentResolver.resolveManifest()`
  with a generous timeout, NOT a hand-rolled existence check: an earlier
  version of this function used its own `space.useNode()`/`node.meta`
  bounded poll instead, and a REAL bug followed - `Space.createNode()`
  never refcounts its own creation, so the very first `useNode()`/
  `release()` pair ANY reader does afterward (including that hand-rolled
  check's own `release()`) tears the local Y.Doc back down (the exact
  "torn down after every read" trap `dev.js`'s `getOrSyncRegistryNode()`
  doc comment already describes for registries, here for an ordinary
  owner Node), needing a genuine round-trip through the relay's own
  mirror to become visible again - not instant even in-process, and the
  hand-rolled check's own 400ms bound occasionally lost that race,
  causing a spurious SECOND `createApp()`/`installCms()` call for a
  manifest that already existed. `resolveManifest()`'s own established,
  generous timeout absorbs the same round-trip reliably; a genuinely
  concurrent double-call (two tabs, same identity, same instant) remains
  an accepted, low-stakes residual, no different from `createPage()`
  itself having no built-in protection against being called twice at
  once either.

**CMS as the first `mode: 'multiuser'` example, not a special case:**
proves the pattern end to end - a relay-admin registers `"cms"` ONCE
(`realm: 'global', mode: 'multiuser'`), and any number of completely
independent visitors each get their own, self-owned, CMS-managed page
under it with ZERO further relay-admin involvement per user - verified
with two totally uninvolved identities each creating their own page
through the real rendered CMS form, an uninvolved THIRD identity
confirming both exist independently with genuinely isolated content, and
`setAppMode(..., {mode: 'off'})` making the whole app unreachable again
for a brand-new visitor (`packages/app-shell/test/multiuser-app.test.js`).
A REAL, separately-caught bug surfaced along the way: `wirePages()` (`cms-
actions.js`) computed its `anchor`/called `refreshTemplateSelect()`
(`await`s) BEFORE attaching its own form's submit listener - violating
that file's own documented invariant ("each `wire*()` attaches its
listener SYNCHRONOUSLY, before its first `await`"), invisible until a
genuinely-empty template registry (a self-provisioned first-time visitor,
exactly this scenario) made `refreshTemplateSelect()`'s own 500ms
registry-wait long enough to submit into: no listener yet, no error, no
status - just silence. Fixed by moving every listener attachment back
before the first `await`, matching `wireTemplates()`/`wireStyles()`'s own
(always-correct) ordering.

**Moderation - documented as future work, deliberately not built now:**
if the actual concern behind "gate CMS specifically" was misuse/spam
rather than "who may write at all," the right tool is moderation AFTER
the fact, not an access gate before it - a relay-admin hiding one
specific, already-written Node from RESOLUTION/RENDERING (a blocklist the
render/resolve path consults, e.g. `ContentResolver`/`AppRuntime` refusing
to serve a listed nodeId) without touching that Kind's write-ACL at all.
Strictly smaller in scope than a feature-gate: no relay-side enforcement
change, no new ACL mode, purely a "what do I choose to show" decision -
closer to `renderAdminUnauthorized()`'s own "purely cosmetic front-end
decision, the real boundary is elsewhere" posture than to anything
`buildWriteAcl()` needs to know about. Not implemented in this pass -
real, separate work if a concrete need for it ever materializes.

**Reading this as a CMS, not just a router:** the admin console proves the
general shape - "UI legt sich selbst innerhalb des Storage an und hat
zuständige Admins" (the user's own framing) - a piece of UI is installed
Qu content, owned by an identity with write-ACL over it, resolved and
rendered through the same `AppRuntime`/`renderPage()` pipeline regardless
of whether that content is a single page (Template + Style + Page data) or
a more elaborate app (a forum, a chat). The CMS editor above is that
framing carried all the way through for an ORDINARY app: templates and
styles are now genuinely stored and edited THROUGH the UI, and page data
filling those templates is saved through the same editor, no CLI/Dev-API
script required for day-to-day content work. Nothing here is
admin-app-specific in principle: `installAppBundle()`/
`installGlobalAppBundle()` are already the SAME shape, `ContentResolver`'s
`kinds` override already makes "which Kind-Schema set a piece of content
resolves against" a parameter, not a hardcoded choice. What is genuinely
NOT built yet, for this to be a fully general CMS: editing the built-in
admin app's own content through this same UI (see above), and a
generalized "any sufficiently-trusted identity can install a NEW kind of
app" story beyond the two built-in shapes (an ordinary `qu-app` and the
admin app) - both real, separate work, not attempted in this pass.
