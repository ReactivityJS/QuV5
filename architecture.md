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

### 3.2 Kind-Schema: shape × visibility, and FOUR ACL modes

A field declares two INDEPENDENT properties (`kind-schema.js`):

- **`shape`** — the local CRDT structure (`'atomic'` | `'text'` |
  `'list'`). Matters only to whichever peer is reading/writing right now;
  never appears on the wire.
- **`visibility`** — which envelope mode a write seals with
  (`'encrypted'` default | `'public'`). Decided once by the writer,
  self-describing in the resulting envelope from then on.

`acl.write` names who may sign updates to a Node of this Kind:

- **`'members'`** — flat Space membership (the default) — genuinely
  SHARED write access, every member equally, no single owner (e.g. the
  App Shell's built-in admin realm content, §7 below).
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
| `space.member.joined` | Space | `{pub, xPub, name}` |
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
| `debug.relay.member.joined` | Relay | `{pub, name}` |

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

**The Platform layer (docs §19-21, revised): several apps, one Relay, a
genuinely confidential relay-admin realm.** Everything above assumes a
Relay serves exactly one app, owned by one app-admin. `@qu/app-core`'s
`platformAppsKind`/admin-realm Kinds (`kinds.js`) + `PlatformRuntime`
(`platform.js`) + the Dev API (`dev.js`), and `@qu/app-shell`'s
`startPlatform()` (`boot.js`) add a second, separate way to boot the SAME
`@qu/app-shell` that instead serves however many independently-owned apps
are reachable on one Relay - each app self-certifyingly reachable at its
OWN owner id with zero relay-admin involvement, PLUS an opt-in, prettier
alias layer a **relay-admin** - a role distinct from any app's own
app-admin, deliberately NOT a superuser over app content - curates. "Kein
Sonderfall zu normalen Spaces" was the guiding constraint here (a real
question this design started from): the built-in admin console is not
special-cased framework UI at all, it is installed Qu content like any
other app, just living in its own genuinely confidential Space.

*Routing - two kinds of match, neither hardcoded to a path string:*

- **Registered alias** (opt-in, prettier): `qu-platform-apps` is a
  `'named'`-ACL Kind, one per relay-admin (`deriveOwnerNodeId(relayAdminPub,
  ...)`, self-certifying like `qu-app`/`qu-route-registry`), holding an
  additive-only `ListField` of `{prefix, appAdminPub, name, realm}` -
  `ListField` has no removal primitive, so there is no `unregisterApp()`.
  `registerApp(relayAdminSpace, {prefix, appAdminPub, name})` is the
  relay-admin-signed write that mounts an already-installed app under a
  path prefix - installing content and registering a route are two
  different identities' writes on purpose (an app-admin installs their own
  app; only the relay-admin decides it's reachable under a nice name). An
  alias's mere EXISTENCE is not confidential (`'public'` visibility,
  `qu-platform-apps`'s own field) - only a `realm: 'admin'` alias's actual
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

*The admin realm - genuinely CONFIDENTIAL, not just UI-gated:* a
`realm: 'admin'` alias (conventionally named `"admin"`, but that is a
NAMING convention the bootstrap installer picks, not a router special
case) resolves into a wholly SEPARATE `Space`/relay-forwarder instance -
its own flat `members` list (every trusted admin identity, boot-time
configured via `QU_RELAY_ADMIN_MEMBERS_JSON`), reached at a distinct
WebSocket path (`/admin-ws`, multiplexed onto the SAME HTTP server/port via
manual `httpServer.on('upgrade', …)` routing - `@qu/space-transport`'s
`createWsServerHub()` itself needs no change, see `relay-server.js`'s own
"ADMIN REALM" doc comment). Its content Kinds (`qu-admin-app`/
`qu-admin-page`/`qu-admin-template`/`qu-admin-style`, `kinds.js`'s own "THE
ADMIN REALM" doc comment) keep `defineKind()`'s DEFAULT `visibility:
'encrypted'` (unlike the public `qu-page`/etc. above) - sealed for exactly
that small member list, so an ordinary visitor of the main Space can never
decrypt anything here, not even with the relay's own cooperation (the relay
never holds an X25519 private key). `acl.write: 'members'` there (not
`'named'`) means ANY configured admin manages it - "wir berechtigen in dem
Space alle Admins des Relays" - there is no single "admin realm owner."
Node ids need no real owner pubkey (there is exactly one admin realm per
relay): `ADMIN_REALM_ANCHOR`, a fixed 32-byte constant fed through the
SAME `deriveOwnerNodeId()`/`deriveContentNodeId()` every other Kind here
uses, purely as a stable hash input. `resolver.js`'s `ContentResolver`
(and `runtime.js`'s `AppRuntime`) take an optional `kinds` override for
exactly this - `boot.js`'s `startPlatform()` passes the `qu-admin-*` set
and `ADMIN_REALM_ANCHOR` for a `realm: 'admin'` match, otherwise the
ordinary public set and the matched app's own `appAdminPub` - the SAME
`AppRuntime`/`ContentResolver` code path either way, only WHICH Kinds/
which `Space` differ. A visitor who is NOT an admin realm member gets
`@qu/app-renderer`'s ordinary "404 not found" fallback when navigating to
the admin alias - the relay's own subscribe-gate rejects their subscribe
outright (`'members'`-ACL Kinds require membership to even subscribe), so
resolution just times out - never a leak, never a special "you're not an
admin" page that would itself require knowing the admin list client-side.
Because this content IS genuinely `'encrypted'`, a late-added admin hits
the SAME Yjs gapless-ordering gap `@qu/space-plugins`' `autoCompactOnJoin()`
already exists to close (docs §32's own regression-tested fix, applied
here too - see `shell.js`'s own wiring, currently scoped to the built-in
console's own well-known ids only).

**The built-in admin console is itself installed Qu content, not
hardcoded framework DOM-building** - `packages/app-shell/admin-console-
bundle.js` (a `{manifest, templates, pages}` bundle, the exact shape
`installAdminAppBundle()` consumes) ships as this package's own reference
"Package," installed once via `packages/app-shell/bin/install-admin-
console.mjs` (a real, separate process holding the bootstrapping
identity's private key - connects to `/admin-ws` to install the content,
then to the main Space to register the `"admin"` alias - see that script's
own doc comment). From then on the console renders through the EXACT SAME
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
any other unauthorized write if the submitter isn't the `qu-platform-apps`
owner.

`shell.js` picks `startPlatform()` over `startApp()` when its
`<qu-app-shell>` element carries a `relay-admin-pub` attribute instead of
`app-admin-pub` (priority order documented in `shell.js`'s own doc
comment) - one Shell, one JS bundle, either mode, decided per-deployment by
which attribute `index.html` sets. In platform mode, `shell.js` also lazily
connects a second `Space` to the admin realm (`connectAdminSpace`, only
actually invoked the first time a route resolves into `realm: 'admin'` -
most visitors never trigger it) - `packages/app-shell/relay-server.js`
wires the server side via `QU_RELAY_ADMIN_PUB` (the alias registry's
owner - takes priority over the single-app `QU_APP_ADMIN_PUB` when both
are set), `QU_APP_ADMIN_PUBS` (a JSON array - every ORDINARY app-admin
this relay accepts writes from, same static-list posture
`QU_MEMBERS_JSON` already takes, and for the SAME reason:
`resolveKindSchema` is a plain synchronous function, `relay.js` never
awaits it, so live-discovering a brand-new app-admin from
`qu-platform-apps` at runtime would need this relay to itself run a live,
subscribed `Space` watching that registry - real, separate work, not
attempted here), and `QU_RELAY_ADMIN_MEMBERS_JSON` (the admin realm's own,
separate member list) - see that file's own doc comment for the full
env-var reference, and `docker-compose.space-relay.yml`'s
`qu-app-shell-relay` service for the same variables wired through Compose.

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
`startPlatform()` (main-realm apps only, not yet the admin realm itself -
see `cms-bundle.js`'s own doc comment on why) - a cheap, correct no-op
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

**The relay's own unconfigured setup page is itself a working Qu identity
tool, not just static instructions** (`build.mjs`'s `renderIndexHtml()`,
the "neither QU_APP_ADMIN_PUB nor QU_RELAY_ADMIN_PUB is set" branch): it
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
identity's exact `QU_APP_ADMIN_PUB`/`QU_RELAY_ADMIN_PUB` value on the page
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
3), publish/draft states (§26), editing the ADMIN REALM's own console
content through this same CMS UI (its `qu-admin-*` Kinds have no
registries/`edit*()` counterparts yet - `bin/install-admin-console.mjs`
remains the only way to update it), and live/dynamic app-admin discovery
(the "static list, relay restart" tradeoff above) remain explicitly future
work — see docs/app-shell-arbeitsauftrag.md's own "Nicht-Ziele".

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
admin-realm-specific in principle: `installAppBundle()`/
`installAdminAppBundle()` are already the SAME shape, `ContentResolver`'s
`kinds` override already makes "which Kind-Schema set (and therefore which
confidentiality tier) a piece of content resolves against" a parameter,
not a hardcoded choice. What is genuinely NOT built yet, for this to be a
fully general CMS: editing the admin realm's own content through this same
UI (see above), and a generalized "any sufficiently-trusted identity can
install a NEW kind of app" story beyond the two built-in shapes (an
ordinary `qu-app` and the admin realm) - both real, separate work, not
attempted in this pass.
