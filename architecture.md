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

- **UI-agnostic** — no components, no rendering. A declarative UI layer
  (`@qu/space-ui`) is planned as a later add-on, not part of this core.
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
│   └── space-transport/ @qu/space-transport - Transports (in-process/WebSocket), the Relay, federation
├── demo/                 - runnable proofs: CLI chat, browser client, in-process auto-demo
├── docs/                 - docs/v5-space-core-guide.md: the practical how-to companion to this file
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

### 3.2 Kind-Schema: shape × visibility, and three ACL modes

A field declares two INDEPENDENT properties (`kind-schema.js`):

- **`shape`** — the local CRDT structure (`'atomic'` | `'text'` |
  `'list'`). Matters only to whichever peer is reading/writing right now;
  never appears on the wire.
- **`visibility`** — which envelope mode a write seals with
  (`'encrypted'` default | `'public'`). Decided once by the writer,
  self-describing in the resulting envelope from then on.

`acl.write` names who may sign updates to a Node of this Kind:
`'members'` (flat Space membership — the default), `'owner'`
(self-certifying nodeId, zero relay state), `'named'` (owner + anyone
they've signed a `grant` for). See `docs/v5-space-core-guide.md` §3 for
the full behavioral contract, and `packages/space-core/src/grant.js`'s
doc comment for the real Yjs property ("write-before-grant is a trap")
that makes grant ORDERING matter.

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

### 3.4 Events: the one hooks/listeners/slots mechanism

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
| `src/kind-schema.js` | `defineKind()`, `KindRegistry`, `deriveOwnerNodeId()` (self-certifying nodeId derivation for `'owner'`/`'named'` ACL). |
| `src/grant.js` | `signGrant()`/`verifyGrant()` — the `'named'`-ACL delegated-authority mechanism. |
| `src/node.js` | `SpaceNode` (one Node = one Y.Doc, `meta` + `content` maps), `stampMeta()`. |
| `src/field.js` | `AtomicField`/`TextField`/`ListField`, `createField()`, `withWriteContext()` (the shared transact-with-origin wrapper every field mutation goes through). |
| `src/space.js` | `Space` — the main class. See §5 below for its full method surface. |
| `src/alias.js` | `deriveAliasIdentity()`, `aliasRegistryKind`/`aliasRegistryNodeId()`, `publishAlias()`, `AliasRegistry` — per-space pseudonymity. |
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
| `src/ws-client-transport.js` | `WsClientTransport` — real WebSocket client, browser-safe (separate `exports` subpath, no `node:crypto`). |
| `src/relay.js` | `createRelayForwarder()` — the Relay itself: signature verification, subscriber-tracking, mirroring, `'named'`-ACL grant handling, push-notify routing, federation's `ingestFederated()` integration point. |
| `src/federation.js` | `federateRelay()` — a relay as a subscribing peer of another relay. |
| `src/presence-tracker.js` | `PresenceTracker` — pubkey ↔ peerId online/offline state, built from signed `hello` messages. |
| `src/push-handler.js` | `registerPushHandler(bus, {sendPush})` — reference delivery-channel handler for `relay.notify.**`. |
| `src/relay-server.js` | Standalone, env-var-configured relay process (`node src/relay-server.js`) — what the Dockerfile runs. |
| `src/index.js` | Package's public export surface (main entry — excludes `ws-client-transport.js`'s browser-safe subpath, see that file's own doc comment on why). |

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
| `new Space({identity, members, transport, storage?, bus?})` | Construct one peer's live view. Sends a signed `hello` immediately. |
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
| `defineKind(kind, {fields, acl?, notifyTopics?})` | Declare a Kind-Schema. |
| `KindRegistry` | `.register()`/`.get()`/`.list()` static registry. |
| `deriveOwnerNodeId(ownerPub, kind)` | Self-certifying nodeId for `'owner'`/`'named'` Kinds. |
| `signGrant()` / `verifyGrant()` | `'named'`-ACL delegated-authority messages. |
| `deriveAliasIdentity(identity, spaceId)` | Deterministic per-space pseudonymous keypair. |
| `publishAlias(space, spaceId)` | Derive + publish this Space's alias to the registry. |
| `aliasRegistryKind` / `aliasRegistryNodeId(realPub)` | The registry Kind and its deterministic per-member nodeId. |
| `AliasRegistry` | Bus watcher maintaining an alias→real map. |
| `encodeForWire()` / `decodeFromWire()` | Uint8Array ↔ base64 for any JSON boundary. |

### Relay / transport / federation (`@qu/space-transport`)

| Export | Purpose |
|---|---|
| `createRelayForwarder({hub, members, resolveKindSchema, storage?, bus?, presence?})` | The Relay. Returns `{seen, presence, addMember, ingestFederated}`. |
| `federateRelay({relay, bus, transport, identity})` | Wire a relay as a subscribing peer of another relay. Returns `{isFederated}`. |
| `createInProcessHub()` / `InProcessTransport` | Same-process transport, for tests. |
| `createWsServerHub(wss)` | Server-side hub over a real `ws` `WebSocketServer`. |
| `WsClientTransport` (also `@qu/space-transport/ws-client-transport`) | Real WebSocket client, browser-safe subpath. |
| `PresenceTracker` | `.setOnline()`/`.disconnect()`/`.isOnline()`/`.pubFor()`. |
| `registerPushHandler(bus, {sendPush, pattern?})` | Reference push delivery-channel handler. |

### Storage (`@qu/space-storage`)

| Export | Purpose |
|---|---|
| `createMemoryStore()` | Ephemeral tier: `{append, load, replace}`. |
| `createDurableStore(backingStore?)` | Simulated-persistence tier (tests): same contract, plus `._backingStore`. |
| `createFileStore(dataDir)` | Real on-disk tier: same contract, one `.ndjson` file per Node. |

## 6. Event topic reference

| Topic | Emitted by | Payload |
|---|---|---|
| `space.node.<nodeId>.changed` | Space | `{nodeId, kind, origin}` |
| `notification.<kind>.<topic>` | Space | `{nodeId, kind, topic, to, authorPub, origin}` |
| `space.member.joined` | Space | `{pub, xPub, name}` |
| `debug.space.write.local` / `.remote.accepted` / `.remote.rejected` / `.remote.ignored` | Space | write lifecycle |
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
