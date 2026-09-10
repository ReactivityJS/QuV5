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
  pub/sub mechanism used on both the client and the relay, in the spirit
  of Drupal/ProcessWire/WordPress hook systems: granular, dot-namespaced
  topics with wildcard subscription, and delivery-channel decisions (toast
  vs. browser notification vs. push) left entirely to whatever subscribes
  to the bus — never baked into the emitting code. The COMPOSABILITY half
  of that same spirit — a plugin registering a menu entry, a context-menu
  action, an admin section, without the framework importing it — is a
  DIFFERENT, complementary primitive, `@qu/extensions`' `ExtensionPointHost`
  (§3.6, §4, §7) — an ordered, id-addressable registry, not a topic bus.
- **Without backward-compatibility constraints during this build** — this
  is an active redesign; prefer the architecturally correct shape over
  preserving an old one.

## 2. Repository layout

```
QuV5/
├── packages/
│   ├── core/            @qu/core            - crypto primitives (Ed25519/X25519/AES-GCM), no framework logic
│   ├── events/          @qu/events          - EventBus: the one dot-namespaced pub/sub mechanism for domain/change/UI events
│   ├── extensions/      @qu/extensions      - ExtensionPointHost: the plugin/composability registry (slots, actions, admin sections) apps contribute into and framework/UI code renders from
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

**UPDATE - the browser CLIENT's own persistent tier.** `@qu/space-storage`'s
`indexeddb-store.js` is the missing counterpart to the relay's own
`file-store.js`, using the exact same `{append, load, replace}` adapter
contract `Space` already supported (no change to `Space`/`Node`/`Field`
needed) - `@qu/app-shell`'s `shell.js` now constructs `Space` with it
(`isIndexedDbAvailable()`-guarded, falling back to memory-only where
unavailable), so a returning visitor's already-seen content renders
instantly from local storage while whatever's new resyncs in the
background, instead of every reload re-fetching everything from scratch.
Exposed via a dedicated `@qu/space-storage/indexeddb-store` subpath export,
not the package's own barrel (`.`) - the barrel also re-exports
`file-store.js` (real `node:fs/promises` I/O, relay-only), which broke the
esbuild browser bundle outright, the same "browser code imports a
dedicated subpath, never the barrel" idiom `@qu/space-transport`'s own
`./ws-client-transport` export already established for its identical
Node-vs-browser split (`ws-server-hub.js`/`ws`).

**UPDATE - opt-in compaction.** `Space.compactNode()` (below) always
existed but nothing ever called it automatically - genuinely CAN'T,
structurally: the relay never holds a signing/encryption key (this
section's own top framing), so producing a compacted snapshot (a new,
validly-signed envelope) can only ever happen client-side, in an
authorized writer's own Space. `@qu/space-core`'s new `compaction.js`
(`compactIfNeeded(space, id, {threshold})`, built on a new `Space.
envelopeCount(id)` reading the local storage-backed count) is therefore a
small, OPT-IN helper a write-path Dev API call can invoke right after its
own write - `@qu/app-core`'s `pushToSharedList()` (a Guestbook/Forum entry,
the highest-churn content this framework has) is the first real caller, via
an optional `compactThreshold` param; every EXISTING call site that never
passes it keeps behaving exactly as before, zero added cost. Deliberately
NOT a background scheduler - see `compaction.js`'s own doc comment for the
full "why automatic can only ever mean opt-in here" reasoning, and its own
"COST NOTE" on `envelopeCount()`'s O(n) check.

**UPDATE - `ListField.slice(start, end)` - windowed reads.** `toArray()`
always decrypted (for an `'encrypted'`-visibility list) EVERY item just to
render, say, the first 20 of a large Guestbook. `slice()` (`Array.prototype
.slice()` semantics, negative indices included - `Y.Array.slice()`'s own
native support) decrypts only the requested window. IMPORTANT SCOPE: this
reduces LOCAL read/decrypt cost only, never SYNC cost - `Y.Array` (every
Yjs shared type) has no partial/windowed sync at all, the full CRDT
structure is already resident in memory once a Node has synced, regardless
of whether/how `slice()` is later called. The "replay every envelope on a
fresh subscribe" network cost is `compaction.js`'s own concern above,
entirely separate. NOT yet wired into `openLiveView()`'s own multi-source
merge-then-sort-then-limit pipeline (`@qu/app-core`'s `view-sources.js`) -
correctly combining a windowed READ with that pipeline's own "true top-N
by sort key across possibly-several sources" guarantee needs its own
design (a raw insertion-order window is not generally the same set as the
top-N by `sortBy`, e.g. a late-arriving update from a peer that was
offline) - real, separate follow-up work, not attempted here. Available
today as a foundational primitive for any caller that already knows it
wants "the most recent N pushes" directly.

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

**"Slots" in this section's own title means EventBus's wildcard fan-out**
(any number of anonymous listeners reacting to one topic) — a DIFFERENT,
complementary concept from `@qu/extensions`' `ExtensionPointHost` (§4, §7),
which is an ORDERED, id-addressable REGISTRY one specific piece of UI/
framework code reads a known, bounded set of named contributions FROM
(a menu entry, a context-menu action, an admin section). `EventBus` answers
"who wants to know when X happens"; `ExtensionPointHost` answers "what has
app Y registered at point Z, and in what order" — `@qu/app-shell`'s own
CMS/admin-console composability (§7) is built on the latter, not the
former, precisely because it needs ordering and per-contribution identity
(so a specific contribution can be replaced/removed), which a fire-and-
forget pub/sub topic does not give you.

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

### `packages/extensions/` — `@qu/extensions`

| File | Purpose |
|---|---|
| `src/extension-points.js` | `ExtensionPointHost` — an ordered, id-addressable contribution registry (`contribute()`/`uncontribute()`/`listContributions()`), read via three shapes: `renderSlot()` (each contributor mounts DOM into its own child container), `collect()` (gather return values, e.g. context-menu entries), `renderFrom()` (call exactly one named contributor). A contribution with no `handler` is a pure data entry; `resolveActionHref()` fills a `{param}`-style href template for that shape. Ported from Qu V3's `@qu/foundation` (`actions[]` + `contributes[]`/`ExtensionPointHost`), unified into one registry and stripped of V3's dynamic-`import()` loader (unneeded — V5's apps/bundles already run in-process together, see this file's own top doc comment). |
| `src/index.js` | Re-exports both. |

`@qu/app-shell`'s `src/extension-points.js` is the ONE shared, process-wide
`ExtensionPointHost` instance every framework wiring and bundle contributes
into/reads from (§7). `src/admin-sections.js`'s registry — `Templates`/
`Styles`/`Content` as separately-routed CMS sections, a `/apps/*` app
registering its own panel — now sits on top of a PRIVATE instance of this
same class (its exact original public API unchanged; see §7's own
"registered admin sections" paragraph), proof that a registry this package
generalizes was already load-bearing, in production, before this package
existed.

### `packages/space-core/` — `@qu/space-core`

| File | Purpose |
|---|---|
| `src/envelope.js` | `sealUpdate()`/`sealPublicUpdate()`/`verifyEnvelope()`/`openUpdate()` — the ONE place a Yjs update is ever sealed/opened. Envelope v2 (`mode: 'encrypted'\|'public'`) and the `snapshot` flag (compaction) live here. |
| `src/kind-schema.js` | `defineKind()` (now also `persistence: 'durable'\|'volatile'`, §3.4), `KindRegistry`, `deriveOwnerNodeId()` (self-certifying nodeId derivation for `'owner'`/`'named'` ACL). |
| `src/grant.js` | `signGrant()`/`verifyGrant()` — the `'named'`-ACL delegated-authority mechanism. |
| `src/node.js` | `SpaceNode` (one Node = one Y.Doc, `meta` + `content` maps), `stampMeta()`. |
| `src/field.js` | `AtomicField`/`TextField`/`ListField` (now also `ListField.slice()` — windowed reads, §3.4 UPDATE), `createField()`, `withWriteContext()` (the shared transact-with-origin wrapper every field mutation goes through), `setFieldValue()` (shape-agnostic "replace the whole value" helper — see `@qu/space-ui` note below). |
| `src/space.js` | `Space` — the main class, now also reconnect/resync (`onStatusChange` wiring, §3.4) and per-Kind storage routing (`_storageFor()`). See §5 below for its full method surface. |
| `src/alias.js` | `deriveAliasIdentity()`, `aliasRegistryKind`/`aliasRegistryNodeId()`, `publishAlias()`, `AliasRegistry` — per-space pseudonymity. |
| `src/presence.js` | `presenceKind`, `publishPresence()`/`setStatus()`/`setTyping()`, `watchPresence()`/`PresenceWatcher` — presence/typing as ordinary volatile-persistence Node writes (§3.5). |
| `src/wire-codec.js` | `encodeForWire()`/`decodeFromWire()` — Uint8Array ↔ base64 for any JSON serialization boundary (WebSocket, on-disk file). |
| `src/compaction.js` | `compactIfNeeded(space, id, {threshold})` — opt-in compaction policy on top of `Space.compactNode()`/`envelopeCount()` (§3.4 UPDATE). |
| `src/index.js` | Package's public export surface — the authoritative list of what's public API vs. internal. |

### `packages/space-storage/` — `@qu/space-storage`

| File | Purpose |
|---|---|
| `src/memory-store.js` | `createMemoryStore()` — ephemeral, in-process-only tier. |
| `src/durable-store.js` | `createDurableStore()` — simulated persistence (in-memory backing object) for tests; same contract as real disk. |
| `src/file-store.js` | `createFileStore(dataDir)` — real on-disk persistence, one newline-delimited JSON file per Node. Relay-only (`node:fs/promises`) — never import this into browser-bundled code. |
| `src/indexeddb-store.js` | `createIndexedDbStore()`/`isIndexedDbAvailable()` — the browser CLIENT's own persistent tier (§3.4 UPDATE). Exposed via its own `@qu/space-storage/indexeddb-store` subpath export, not the barrel — see that UPDATE note for why. |

All four implement the same contract: `append(nodeId, envelope)`,
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

**UPDATE - CONFIRMED FILE SYNC + PEER RECEIPTS.** `UploadOutbox` closes
the three gaps a real file exchange needs, without inventing anything new:

1. Local save + outbox entry were already both awaited before `enqueue()`
   returns (see that method's own doc comment) - confirmed by construction,
   nothing to add there.
2. **Confirmed relay sync of the metadata** (not just "my own `upload()`
   call resolved"): the constructor now takes an optional 4th `bus` param
   (the SAME bus given to `space`'s own constructor). With it, a record
   that reaches `'done'` advances to a new `'synced'` status once the
   relay has actually ack'd the metadata write - `delivery-status.js`'s
   existing `awaitRelayAck()`, no new mechanism. `uploadOutboxKind`'s Node
   holds MANY files' records in one atomic field, so concurrent
   `enqueue()`s race writes to the SAME Node - `awaitRelayAck()`'s "next
   ack, not a per-write id" correlation still holds because a Space
   flushes its own writes to one Node in order, so any ack landing after
   our `set()` call proves ours already arrived. Omitting `bus` keeps the
   old behavior (`'done'` stays terminal).
3. **"Received, confirmed by the recipient peer"**: no bespoke file
   mechanism - `delivery-status.js`'s `readReceiptKind` was already a
   generic "reader confirms receipt of contentId" primitive (its
   `contentNodeId` key is caller-defined, not required to be an actual
   Node). `markFileReceived(space, fileId)`/`watchFileReceipts(space, pub)`
   are one-line aliases of `markRead()`/`watchReadReceipts()` - a file id
   works exactly like a chat message id. No new Kind, no duplicated state.

Why the blob itself still can't just ride the same "default" CRDT sync
that the metadata uses: a relay only forwards/mirrors signed envelopes,
and Yjs's update history has no notion of discarding old bytes - fine for
small structured state, unbounded growth for a large binary appended over
and over. Files also don't need CRDT MERGE semantics (nobody wants two
peers' concurrent writes to the SAME file's bytes to "merge") - so the
split (`localStore`/`upload()` move the bytes out-of-band; `records`
metadata rides the ordinary Node/Field sync) is deliberate, not a
shortcut. `space-ui`'s `upload-status.js` gained a matching 5th
`'synced'` status class (see below) - `@qu/app-shell` wiring this into an
actual upload form (Blog image, profile picture, ...) remains open.

### `packages/space-ui/` — `@qu/space-ui` (OPTIONAL)

| File | Purpose |
|---|---|
| `src/bind.js` | `bindField()`/`bindCheckbox()` — one/two-way reactive binding between a DOM element and a `Field`. |
| `src/inline-edit.js` | `makeInlineEditable()` — `[contenteditable]` bound to a `Field` with explicit save (Enter/blur)/cancel (Escape) semantics; never applies a remote change while the element has focus. Now works on a `'text'`-shape field too (`@qu/space-core`'s `setFieldValue()`, see §3.4-adjacent note below), not just `'atomic'`. |
| `src/list-bind.js` | `bindList()` — keyed reconciliation of a list `Field` into a DOM container; skips re-rendering items whose value hasn't changed even without a caller-supplied `update()`. |
| `src/upload-status.js` | `bindFileInput()`/`bindUploadStatusIcon()` — wires `<input type="file">` and status icons to `@qu/space-plugins`' `UploadOutbox`; a status icon is never auto-hidden on `'done'`. |
| `src/index.js` | Package's public export surface. |

Vanilla JS/DOM, no framework dependency, no build step — `Space` has zero
awareness this package exists either.

**UPDATE - `setFieldValue()` closes a real gap.** `@qu/space-core`'s new
`setFieldValue(field, value)` (`field.js`'s own doc comment) writes a
COMPLETE new value regardless of a field's shape - `'atomic'` via its own
`set()`, `'text'` via delete-then-insert (`TextField` has no `set()` at
all). `makeInlineEditable()` now uses it instead of a bare `field.set()`,
which would have thrown outright for any `'text'`-shape field (a Blog
post's own `content`, e.g.) - so `<qu-bind editable="inline">` now works on
either shape. Deliberately a discrete "commit on save," not live
character-level merging - the wrong tool for two people typing in the SAME
field at once (point a real editor at `field.ytext` for that); `bindField()`'s
own per-keystroke two-way binding stays `'atomic'`-only, unchanged, for the
identical reason. `@qu/app-core`'s `dev.js` keeps its own, separate,
already-working `replaceText()` private helper (13 call sites) rather than
being migrated onto this - not worth the churn for zero behavior change.

### `packages/space-components/` — `@qu/space-components` (OPTIONAL)

| File | Purpose |
|---|---|
| `src/context.js` | `findQuSpace()`/`findQuKind()` — ancestor-DOM resolution (a Component reaches its `Space`/Kind-Schema by walking up for a `.quSpace`/`.quKinds` property on some ancestor, never a global — the same pattern QuV3's own `packages/ui/src/components.js` established, `findQu()`). `findQuSelf()` (Phase 5) — same pattern for `.quSelfNodeId`/`.quSelfKind`, the "which page is currently being rendered here" pair `@qu/app-shell`'s `boot.js` sets on every render. `resolveTarget()` — binds to a sole child element (e.g. a wrapped `<input>`) instead of the Component itself, when there is one. `assertSafeAttrMode()`/`getPath()` — shared guards/helpers. |
| `src/resolve.js` | `resolveNodeRef()`/`resolveField()` — turns a Component's `kind`/`node-id`/`field` attributes (or `.kindSchema`/`.nodeId` JS properties, for a computed id/an app-owned Kind-Schema object, or the `self` attribute — Phase 5, resolves both together via `findQuSelf()`, the only way to address "this page's own hash-derived node id" without a content author having to type it) into a subscribed `{field, release}`, retrying once on the next microtask for the "ancestor context set after append" ordering hazard. |
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
| `markFileReceived(space, fileId)` / `watchFileReceipts(space, pub)` | File-scoped aliases of `markRead()`/`watchReadReceipts()` — a file id works exactly like a `contentNodeId`. |
| `uploadOutboxKind` | Self-certifying `'owner'`-ACL Kind, `records: {shape:'atomic', visibility:'public'}` map. |
| `UploadOutbox` | `.enqueue(meta, blob)` (fire-and-forget upload, resolves once locally saved+queued) / `.retry(id)` / `.statusOf(id)` / `.list()` / `.watch(id, cb)` (reactive). Constructor takes an optional 4th `bus` param — with it, `'done'` records advance to `'synced'` once the relay ack's the metadata write. |

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

**UPDATE - registered admin sections, separate routes, a unified Content
editor:** the paragraph above describes the ORIGINAL shape (one `/cms`
page, three sections crammed together) - since superseded by a small
registry (`src/admin-sections.js`'s own `registerAdminSection()`/
`listAdminSections()`) that `cms-bundle.js` iterates to install ONE PAGE
PER SECTION (`/cms/templates`, `/cms/styles`, `/cms/content`) plus a
generated `/cms` nav index, and `cms-actions.js`'s `wireCms()` iterates the
SAME registry instead of calling three hardcoded `wire*()` functions - a
fourth section (a `/apps/*` app's own admin panel) needs no edit to either
function, only its own `registerAdminSection()` call. "Content" also
REPLACES the old separate "Seiten"/"Pages" and "Views" sections with ONE
form (`wireContent()`) - a content-SOURCE picker (Text/HTML | Geteilte
Liste | Seiten-Filter) dispatches to `createPage()`/`editPage()` or
`createView()`/`editView()` under the hood; combining multiple, mixed-type
sources in one View (the "Blog + Guestbook" example a few sections below)
still needs the raw-JSON `sourcesOverride` escape hatch, the simple picker
only ever builds one source at a time. `view-sources.js`'s own `'pages'`
source adapter also gained an `ownerPrefix` param (cross-app sourcing - a
View defined under one app can filter ANOTHER app's own Pages); a
`'shared-list'` source already worked cross-app with no such param, its id
being a hash of its own name, never scoped to any one app. Neither the
underlying `pageKind`/`viewKind` Kinds nor their write-ACL semantics
changed - only the AUTHORING UI unified, so no already-published Page or
View needed migrating. See `docs/example-apps.md`'s own §5 and "Deploying
Guestbook, Blog, and Forum via the Views UI" section for the user-facing
walkthrough.

**UPDATE - `admin-sections.js` now sits on `@qu/extensions`' `ExtensionPointHost`,
and a first real plugin slot exists in the CMS itself.** `registerAdminSection()`/
`listAdminSections()` kept their exact original signature and behavior -
this was a pure internal refactor, proof that the registry `admin-sections.js`
already was (ordered, id-keyed, "re-registering an id replaces it in place")
generalizes cleanly onto `@qu/extensions`' new, reusable primitive (§4). On
top of that, `cms-actions.js`'s `wireContent()` now calls
`extensionPoints.collect('cms.pageActions', {route, space, resolver, anchor,
global})` for every listed Page/View row, appending each returned
`{id, label, onClick}` as an extra button next to the built-in "open in
editor" one - a plugin (a future `blog-actions.js` "Duplizieren", say) adds
a per-page action without `cms-actions.js` importing it or knowing it
exists. `@qu/app-shell`'s `src/extension-points.js` is the ONE shared,
process-wide `ExtensionPointHost` instance this and every future slot use;
`_clearExtensionPointForTest(point)` is its test-only escape hatch (same
reasoning as `admin-sections.js`'s own `_clearAdminSectionsForTest()`).
This is the first, deliberately small step of porting Qu V3's Slots/
Actions/ExtensionPoints principle (its own `@qu/foundation`, used there for
the main-menu/header, per-message and per-topic context menus, composer
actions, and cross-app search) into V5 - further points (a page/view
"context menu," template-registration-as-a-contribution, admin-console
chrome) are real, deliberately incremental follow-up work, not built
speculatively ahead of a concrete second consumer.

**A real, deployment-observed bug: `editPage()`/`editTemplate()`/
`editStyle()` throwing "does not exist (or has not synced)" for content
that plainly DOES exist.** `Space.useNode()` is ref-counted, and
`ContentResolver`'s own `resolveTemplate()`/`resolveStyle()`/`resolvePage()`
(what each CMS section's click-to-load handler calls, purely to populate
the form), called bare (no `hold`, see UPDATE below), each `useNode()` THEN
`release()` internally - dropping the refcount straight back to zero, which
`Space.unsubscribeNode()` treats as "nobody needs this Node locally any
more" and DISCARDS the local Y.Doc entirely (`space.js`'s own
`_nodes.delete(id)`), not merely stops live-pushing to it. Submitting the
form moments later called `edit*()` (`dev.js`), which does its OWN fresh
`useNode()` - if the previous one had been fully torn down, this had to
re-subscribe and wait for the relay to replay the Node's entire history
again, a real network round-trip a fixed ~2-3s timeout can genuinely lose
to over an actual (non-localhost) connection - the false "does not exist"
error was really "did not RE-sync in time," for content the user had just
viewed successfully. Never reproduced by this project's own tests (an
in-process/localhost hub has no meaningful round-trip time to lose the race
against), only by an operator actually using a real deployment.

**UPDATE - fixed at the framework level now, eliminating the teardown
itself, not just working around it:** `resolvePage()`/`resolveTemplate()`/
`resolveStyle()`/`resolveView()` (`@qu/app-core`'s `resolver.js`) gained an
opt-in `{hold: true}` option - skips the internal `release()` and returns
`{page/value/view, release}` instead of the bare value, so the SAME
already-synced `useNode()` subscription stays open past the resolve call
itself, for as long as the CALLER decides. `cms-actions.js`'s own former
`holdEdit()` - a hand-rolled, app-level SECOND `useNode()` call working
around the resolver's release-immediately posture from the outside - is
gone; each section's click-to-load handler now resolves with `{hold:
true}` directly and keeps the returned `release` on `activeEdit` until a
different item loads or the form resets, the exact same lifecycle
`holdEdit()` used to manage, just without a redundant extra subscription
and available to ANY caller of `ContentResolver`, not only this one file.
The eventual `edit*()` call's own `useNode()` finds the Node already
attached (never torn down in the first place) and reuses it instantly - no
network round-trip, no timeout race, and no reliance on `isNodeSynced()`'s
own fast-path at all for this specific scenario (that fast-path, from the
"Subscribe statt Polling" work further down this section, remains what
protects every OTHER re-subscribe - a fresh visitor, a reload, a second
browser tab - that never went through a held resolve to begin with).
`ContentResolver`'s bare (no `hold`) calls keep releasing immediately,
unchanged - correct for ordinary rendering, where holding every resolved
Node open for a whole visit would leak subscriptions.

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
   operation" posture the resolve-with-`hold` calls above use for the
   edited content Node itself) for the CMS session's whole lifetime, so
   `refreshList()`/`registerContentName()`/`publishRoute()`
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

**UPDATE - a third bug in this SAME family, again deployment-observed:
`setAppMode()` throwing `"blog" is not a registered app - registerApp() it
first` for a prefix that plainly WAS just registered.** `getOrSyncRegistryNode()`
(above) checks `meta.get('kind')` to decide "does this registry already
exist" - correct for THAT question, but `setAppMode()`/`registerApp()`/
`setAppBundleVersion()`/`setAppConfig()`/`addSharedLists()`/
`addGlobalViewNames()`/etc. (every one of them funnels through this same
helper for `platformAppsKind`, the global `qu-platform-apps` registry) then
go straight on to read the registry's `apps` list field - and the meta
stamp being present only proves the Node was created at SOME point in the
past, not that every LATER entry pushed to it (another relay-admin's
`registerApp()` call, possibly still in flight) has actually finished
replaying to THIS fresh subscription. `PlatformRuntime.resolveApps()`
(`platform.js`, the admin console's own app-list source) had the identical
weak gate one level up - waiting only for `apps.length > 0`, i.e. "at least
one entry has arrived," not "every entry has." Fixed the same way as the
`resolvePage()`/etc. fix earlier in this section: `getOrSyncRegistryNode()`
now additionally waits on `space.isNodeSynced(id)` (via the existing
event-driven `waitForSync()`) in its "registry already existed" branch
before returning the Node, and `resolveApps()`'s own wait gates on
`isNodeSynced()` instead of `apps.length`. Fixes every caller through this
one shared helper at once, the same "one funnel, one fix" shape the
registry helper itself was originally built for. Like the bug this section
opens with, this exact race is inherently a real-network-latency
phenomenon this project's in-process test hub cannot reliably force (its
relay-to-subscriber delivery has no meaningful round-trip to lose against) -
covered instead by a regression test (`platform.test.js`) that proves the
fixed, `isNodeSynced()`-gated code path behaves correctly for the exact
reported shape (several apps registered, then `setAppMode()` immediately
against a brand-new Space connection, no held subscription to fall back on).

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

**UPDATE - DRAFT/PUBLISH WORKFLOW.** `pageKind`/`adminPageKind` gained a
`status` field (`'draft'` | `'published'` | `null`/unset, treated as
published - every pre-existing page keeps working unchanged, no
migration). `resolver.js`'s `resolvePage()` treats a `'draft'` page as
NOT FOUND (`null`, the exact same signal an unpublished route already
produces) unless the caller passes `includeDrafts: true` - the app's own
ordinary navigation/View rendering never does, only an editor's own
"load this draft back into the form" call site does. This is
DELIBERATELY NOT a confidentiality mechanism: the field, like every
other on this Kind, is `visibility: 'public'` - content-addressed id
derivation still works for anyone who already knows/guesses the route
(this Kind's own doc comment already makes the identical point about
`routeRegistryKind` being enumeration-only, never access control); only
the app's OWN resolver path honors `status`. A draft is a REAL Node,
simply never registered into the route registry until actually
published - invisible to every View/feed for the same reason an
unregistered route already was, `openLiveView()`'s `'pages'` source
included. `createPage()`/`editPage()`/`createGlobalPage()`/
`editGlobalPage()` all thread an optional `status` through (only written
when actually passed - `editPage()`'s pre-existing "only touch what you
pass" semantics, unchanged for every caller that doesn't). Wired into
ONE example, Blog: both post forms gained a second submit button
(`[data-qu-draft-btn]`, "Als Entwurf speichern") - `blog-actions.js`'s
`wireBlog()` tracks which button was clicked via `form.dataset.intent`
(set on 'click', read once and cleared on 'submit' - works for a real
click AND a synthetic `dispatchEvent('submit')` a test issues after its
own synthetic button click, unlike relying on `SubmitEvent.submitter`).
Saving a draft does NOT reset the form - it stays open, primed
(`editingRoute`/`loadedStatus` set directly, no `ContentResolver`
round-trip needed) so the SAME author can continue and click
"Veröffentlichen" later in the SAME session, which THEN calls
`publishRoute()`/`publishGlobalRoute()` for the first time (tracked via
`loadedStatus === 'draft'`, so an ordinary edit of an already-published
post never re-registers the route a second time - `blog-draft.test.js`
proves both this and the create→draft→publish round trip end to end).
No drafts-LIST UI exists yet (there is no way to reach an OLDER, already
-saved draft from a fresh page load) - it would need its own View
source, since `'pages'`/`'shared-list'` both only ever read
PUBLISHED/registered content; deliberately left for later, `resolvePage(
{includeDrafts: true})` already being ready for it to build on directly.
`resolver.test.js` proves the underlying mechanism directly (draft →
not found → `includeDrafts` sees it → `editPage({status:'published'})` +
one `publishRoute()` call → found, exactly once registered; and the
reverse, editing an already-published page back to `'draft'` hides it
again without touching the registry) - a lower-level, faster, and more
robust test surface than driving the same transitions through a
browser-simulated relay-admin click sequence.

**UPDATE - A REAL, YJS-BACKED WYSIWYG EDITOR (replaces the OLD hand-rolled
`bindRichText()`).** User feedback on the first rich-text pass: the
`Range`/`Selection`-based editor was unpleasant to use, and the shared
base stylesheet didn't exist yet, so its own surface (and a plain
`<textarea>`) had no visible border/min-height at all - "Body-Feld gar
nicht sichtbar." Two changes address this:

1. **`@qu/space-core` gains a new field shape, `'richtext'`** (`kind-schema.js`'s
   `SHAPES`, `node.js`'s `stampMeta()`, `field.js`'s new `RichTextField`) -
   backed by a real `Y.XmlFragment`, ProseMirror's structured document
   model (nested block/inline nodes), unlike `'text'`'s flat `Y.Text`
   (fine for plain character-stream editing, too flat for headings/lists
   as real nodes). `field.yxml` is the direct handle - "bind ProseMirror/
   y-prosemirror straight to it," the SAME pattern `TextField.ytext`
   already established for Quill/ProseMirror-on-Y.Text. Purely additive:
   `pageKind`/`content` stays `'text'` - Blog's draft/publish model
   (`resolvePage()`'s `includeDrafts` gate, `blog-actions.js`'s own submit
   flow) is completely unaffected; `'richtext'` is a genuinely independent
   choice for a field that wants LIVE Yjs collaboration instead.
2. **A new, OPTIONAL package, `@qu/space-editor-prosemirror`** - never a
   dependency of `@qu/app-shell`/`@qu/space-ui` (an app opts in by
   installing and importing it directly, `@qu/app-shell`'s own
   `package.json` only lists it as a DEV dependency, for its own
   integration test). Two editors, sharing one schema
   (`prosemirror-schema-basic` + `prosemirror-schema-list`'s list nodes -
   the same well-exercised combination most ProseMirror apps start from)
   and one toolbar (`toolbar.js` - Bold/Italic/Link/H2/bullet-list,
   feature parity with the old editor, built on `prosemirror-commands`
   instead of hand-rolled `Range` manipulation, so formatting always
   produces a schema-valid document):
   - `bindLocalRichText(textareaEl)` - a DROP-IN replacement for `@qu/space-ui`'s
     old `bindRichText()` (identical `{refresh, stop}` contract, mirrors
     into `.value`, zero networking - `prosemirror-history`'s own local
     undo only). This is what Blog uses - "Draft/Save," the user's own
     explicit choice for that field.
   - `bindCollabRichText(container, field)` - binds `y-prosemirror`'s
     `ySyncPlugin` DIRECTLY to a `'richtext'`-shape field's `field.yxml` -
     REAL multi-peer live editing over the actual Space/relay sync, no
     bespoke sync code at all. A real, deliberate consequence: content
     exists on the relay the moment it's typed, not gated behind a
     "Save"/"Veröffentlichen" action - the opposite tradeoff from the
     local editor, which is why they're two separate functions rather
     than one with a mode flag. Scope cut: no remote cursor/presence
     highlighting (`y-prosemirror`'s `yCursorPlugin` needs a Yjs
     `Awareness` instance with its own transport - this framework's own
     presence mechanism is `@qu/space-core`'s `presence.js`, not Yjs
     Awareness - wiring the two together is separate, real future work).

   TESTABILITY, verified by hand before committing to this design:
   `EditorView` mounts and `y-prosemirror`'s Yjs binding both work
   correctly under jsdom (this project's own test runtime) - confirmed by
   a throwaway spike before writing any package code. Two REAL bugs
   caught BY those tests, not assumed away: (a) calling `editor.focus()`
   before reading the selection collapses it in jsdom (removed - a real
   browser doesn't need that call either, for the identical reason); (b)
   `EditorView`'s own default `scrollToSelection()` calls
   `Range.getClientRects()`, which jsdom does not implement, throwing on
   every SECOND selection-changing command and silently dropping that
   edit - fixed with the `handleScrollToSelection: () => true` prop
   (skips PM's own scroll-into-view; a minor, deliberate UX trade-off for
   a typically-already-visible small editor) AND reordering
   `dispatchTransaction` to mirror into `textareaEl.value` BEFORE calling
   `view.updateState()`, so the textarea mirror never depends on the
   view's own redraw succeeding. Neither bug is jsdom-only noise dismissed
   without checking - (b) specifically was caught by a test asserting a
   SECOND toggle actually reverted a heading to a paragraph, which failed
   outright before the fix.
3. **`boot.js`'s `startApp()`/`startPlatform()` gain an optional
   `richTextBind` param**, threaded down through every one of their own
   `wireRichText()` call sites (`renderMultiUserRoute()`/
   `renderGlobalShell()`/`renderAggregateShell()`/both inline
   `startPlatform()` branches) - `rich-text-actions.js`'s own doc comment
   on why this exists as an injection point rather than a hardcoded
   import. An explicit value here (tests, or an embedder wanting ONE
   editor regardless of admin config) always wins; omitted, it's decided
   dynamically - see point 5 below. `rich-text-prosemirror-integration.test.js`
   proves the explicit-override path end to end: `startPlatform({...,
   richTextBind: bindLocalRichText})` against a REAL relay mounts the REAL
   ProseMirror editor in Blog's own post form, and a post written through
   it publishes and renders correctly.
4. **A shared BASE STYLESHEET** (`@qu/app-shell`'s new `base-style.js`,
   inlined ONCE into `build.mjs`'s `renderIndexHtml()` page `<head>` -
   cascades to every app/form/rich-text surface rendered inside
   `<qu-app-shell>`, no per-bundle wiring needed) - closes the "wild und
   unübersichtlich" / invisible-body-field feedback directly: a border/
   background/min-height on `.qu-richtext-editor` (both editors share
   this class), consistent form/label/input/button spacing and borders,
   status-message spacing. Deliberately minimal - spacing and visibility,
   no color theme/branding decisions - and loads BEFORE an app's own
   `theme` CSS in the cascade, so a Kind-Schema style can still override
   anything here on equal specificity.
5. **A relay-admin toggles the ProseMirror editor ON PLATFORM-WIDE, live,
   from the admin console UI - no redeploy, no `richTextBind` param
   anywhere in `shell.js`.** Follow-up to point 3 above once the user
   confirmed this is what "vom Admin aktiviert, dem User angezeigt/
   angeboten" actually means. Required closing a real gap: `shell.js` (the
   ACTUAL browser entrypoint) never threaded `richTextBind` to
   `startApp()`/`startPlatform()` at all, and `@qu/space-editor-prosemirror`
   was only a `devDependency` of `@qu/app-shell` - the ProseMirror code
   flat-out wasn't IN the shipped `bundle.js`. Fixed:
   - `@qu/space-editor-prosemirror` moved to a real `dependency` of
     `@qu/app-shell` (the user's own call: ship it in the main bundle now,
     revisit lazy-loading/code-splitting later if bundle size becomes a
     real concern - esbuild's `buildAppShellBundle()` has no code-splitting
     set up today, and there's no dynamic-`import()` precedent anywhere in
     this codebase to build on, see `extensions/src/extension-points.js`'s
     own doc comment on why V5 deliberately dropped V3's version of that).
   - New `platformAppsKind.platformConfig` field (`kinds.js`) - an
     `'atomic'`-shape, platform-WIDE (not per-app, unlike `apps[].config`)
     small settings bag on the SAME singleton registry Node `apps` already
     lives on - no new Kind needed. First key: `richTextEditor: boolean`.
     `dev.js`'s `setPlatformConfig()` merges by key (`setAppConfig()`'s own
     pattern, one level up); `PlatformRuntime.resolvePlatformConfig()`
     reads it back FRESH every call (same `isNodeSynced()`-gated `waitFor()`
     `resolveApps()` already uses - a real regression test caught the
     first version reading a just-created, not-yet-replayed local Y.Doc as
     empty instead of actually waiting for the relay's reply).
   - `boot.js`'s `startPlatform()` now resolves `platformConfig` FRESH
     inside its router's `onChange` handler, on EVERY navigation (never
     cached from `startPlatform()`'s own call time) - `effectiveRichTextBind
     = richTextBind ?? (platformConfig.richTextEditor ? bindLocalRichText :
     undefined)`. A relay-admin's toggle therefore reaches an ALREADY-
     CONNECTED visitor's very next route render, not just a fresh page
     load - proven by `rich-text-platform-toggle.test.js` toggling the
     admin checkbox and then re-navigating the SAME already-open author
     Space/router (no reconnect) to see the editor swap live.
   - Admin console UI: `admin-console-bundle.js`'s new "Editor-
     Einstellungen" `<form data-qu-action="set-platform-config">` (one
     checkbox, `name="richTextEditor"`), wired by `admin-actions.js` -
     reflects the CURRENT live value on load (so reloading `#/admin` never
     shows a falsely-unchecked box) and calls `setPlatformConfig()` on
     submit, same "inert markup + convention-based wiring" posture every
     other admin console form already has.
   - Deliberately scoped to `startPlatform()` only, not `startApp()` -
     single-app deployments have no admin console/platform registry
     concept to toggle this from in the first place; `startApp()` keeps
     `richTextBind` as a pure explicit-override param for an embedder.
   - What does NOT change: WHICH fields show a rich-text editor at all
     stays a template-author decision (`data-qu-richtext` on that one
     `<textarea>`) - this flag only decides which BINDING an already-
     marked field gets, never adds the capability to a field that never
     asked for it ("nicht jedes Eingabefeld braucht einen WYSIWYG-Editor").

**UPDATE - ADMIN CONSOLE EATS ITS OWN DOG FOOD (`admin-actions.js`'s
installed-apps list).** The app list used to be its own bespoke "clear
the whole `<ul>`, rebuild every `<li>` by hand with `doc.createElement()`"
loop on every single mutation (a mode click, an install, an uninstall) -
duplicating, by hand, the exact keyed reconciliation `@qu/space-ui`'s
`bindList()` already provides and `view-actions.js`'s `wireViews()`
already uses for every OTHER live list in this framework. Refactored to
use that same shared primitive: `platform.resolveApps()` (already a
plain, REDUCED array - last write per prefix wins, `platformAppsKind`'s
own "ONLY ADDITIVE" doc comment) is wrapped in the minimal `{toArray,
observe}` source `bindList()` needs; the old per-row DOM-building code
became `renderAppRow(app)`, `bindList()`'s own `render` callback, now
invoked once per NEW or CHANGED row (keyed by `app.prefix`, stable across
a mode change) instead of unconditionally for every row on every
recompute - a real behavior improvement, not just less code: an
unrelated row's own DOM (and any in-progress interaction with it) is no
longer torn down every time a DIFFERENT app's mode button is clicked.
`renderList()` keeps its name and external call sites unchanged (every
mutation handler still just calls it) - internally it now only
re-fetches `resolveApps()` and notifies `bindList()`'s observer, never
rebuilds anything itself. The empty-state message moved from a
placeholder `<li>` `bindList()` would have had to specially ignore into
an ordinary sibling `<p data-qu-empty-apps hidden>` (`admin-console-
bundle.js`), toggled the same way any other `[data-qu-admin-only]`-style
element in this codebase already is.

**UPDATE - RICH TEXT (`@qu/space-ui`'s new `src/rich-text.js` +
`@qu/app-shell`'s new `src/rich-text-actions.js`).** A minimal,
dependency-free WYSIWYG surface for a plain `<textarea>` a form already
reads raw HTML from - `bindRichText(textareaEl)` hides the textarea,
inserts a small Bold/Italic/Link/H2/bullet-list toolbar over a
`contenteditable` `<div>` right after it, seeds the div from the
textarea's current `.value`, and mirrors every edit back into
`textareaEl.value` on the div's own `'input'` event - so whatever ALREADY
reads `.value` at submit time keeps working completely unmodified, zero
awareness this exists. Deliberately NOT built on `document.execCommand()`
(deprecated, inconsistent, and unimplemented by jsdom - this project's
own test runtime) - every command is a direct `Range`/`Selection`
manipulation instead (wrap the selection in an inline tag for bold/
italic/link; replace the closest block ancestor for the heading/list
buttons), fully exercisable under jsdom. Two real, hand-caught bugs while
building this: (1) calling `editor.focus()` before reading the selection
collapses it in jsdom (a real browser doesn't need that call either, for
the same reason - removed entirely); (2) a toolbar button's default
`mousedown` behavior moves focus (and would collapse the editor's
selection) BEFORE its own `'click'` handler ever runs in a real
browser - fixed with `event.preventDefault()` on `mousedown`, a case
jsdom itself doesn't reproduce (verified by hand instead, noted honestly
in the code rather than claimed as test-covered). ONE-WAY MIRRORING is
deliberate: setting `textareaEl.value` PROGRAMMATICALLY (an editor
loading an existing post back into the form) does not reach the visible
div on its own (no DOM event exists for that) - the returned `refresh()`
pulls it back in, which is exactly what `@qu/app-shell`'s
`rich-text-actions.js` exports as `refreshRichText()` for callers to use.
`wireRichText({mountEl})` (called unconditionally by `boot.js` after
EVERY `renderPage()`, the SAME "correct no-op" posture `wireViews()`
already has) is the attribute-driven half: any `<textarea data-qu-richtext>`
gets bound automatically, no JS per app. No explicit teardown needed
(unlike `wireViews()`'s own tracked View subscriptions) - a rich-text
binding holds no live Space subscription, only DOM listeners on elements
this same render created, discarded with the rest of the old DOM subtree
on the next render. Wired into ONE example: Blog's post-content
`<textarea>` (both forms) - `blog-actions.js`'s `loadForEdit()` and a
completed publish's own `form.reset()` each call `refreshRichText()`
right after setting that field's `.value`, so the visible surface never
goes stale; a dedicated test in `blog-feeds.test.js` types/formats
through the ACTUAL rich-text surface (not a raw `.value =` assignment)
and confirms the resulting HTML is what gets published and rendered.

**UPDATE - SEARCH BOXES (`view-actions.js`'s `wireViews()`).** An
`<input data-qu-search-for="<view-name>">` anywhere on a page is wired,
on every `'input'` event, to that named View's own `setQuery()`
(`view-sources.js`'s own "UPDATE - CLIENT-SIDE FULL-TEXT SEARCH" doc
comment) - matched by NAME against the View's `[data-qu-view="name"]`
element, not DOM position, so a search box doesn't have to be a literal
sibling of the feed it filters. The SAME "framework code wires an inert,
content-authored element by attribute convention" posture `[data-qu-view]`
itself already uses - a template author writes one `<input>` tag, no JS.
Deliberately NOT debounced: `setQuery()` filters data already synced
locally, no relay round-trip per keystroke, so there's no real cost to
avoid. A `data-qu-search-for` naming a View this page never opens (typo,
or a box meant for a different page) is a correct no-op - `wireViews()`
only looks for a matching search input INSIDE the loop that already
successfully opened that View. Wired into ONE example: Blog's Global Feed
gained `<input data-qu-search-for="${prefix}-index">` right above its
`blog-index` View - `blog-search.test.js` proves the RENDERED box filters
the visible feed by a post's own content, live, no reload; `view-actions.test.js`
proves the underlying wiring generically (including the no-op case) with
a bare `viewKind`, no Blog involved.

**UPDATE - `setFormStatus()` (`@qu/app-shell`'s new `src/form-status.js`).**
The "find or create this form's own `[data-qu-status]` paragraph, then
set its text" three-liner was duplicated verbatim across every form-
wiring file in this package (`blog-actions.js`, `guestbook-actions.js`,
`forum-actions.js` ×2, `admin-actions.js` ×2, `generic-write-actions.js`)
- `cms-actions.js` already had its own private copy (`setStatus()`) of
exactly this function, unnoticed by the others. Extracted into ONE
shared `setFormStatus(form, text)`, imported everywhere the old 3-line
block used to live (`cms-actions.js` keeps calling it `setStatus` via an
aliased import - `import {setFormStatus as setStatus}` - so its own
existing call sites needed zero changes). Deliberately a plain function,
not a `<qu-form-status>` Web Component - no reactive Space data is
involved, just "set some text on an element," so a Component's
registration/shadow-DOM machinery would be pure overhead here. The OTHER
`[data-qu-status]` usages in this package (`admin-actions.js`'s
per-list-item mode/uninstall buttons, `installed-apps-actions.js`'s
update banner) are a genuinely different shape - a plain element created
ONCE and held via closure across several button handlers, not a `<form>`
re-queried on every submit - so they were deliberately left as they were,
not force-fit onto this helper.

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
- **`demo-app-admin` no longer exists (a later revision):** everything
  above describing it is history, not current behavior -
  `bootstrap-platform.mjs` dropped the single-owner "demo" shell-app and
  its separate app-admin identity entirely once `mode: 'multiuser'`
  shipped (see "Three administrable states" below), registering the
  built-in `"cms"` app as `realm: 'global', mode: 'multiuser'` instead.
  `relay-admin` is now the ONLY identity that script generates - every
  visitor gets their own self-owned CMS space at `#/cms/` on first visit,
  with zero cooperation from this script or any relay-admin, closing the
  exact bottleneck a single app-admin identity always was.

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

**The `/u/me/` discoverability problem, and flipping the default (a later
revision):** shipping `mode: 'multiuser'` surfaced a real UX gap -
`#/cms/u/me/` requires a visitor to already know the `/u/me/` convention
exists at all; there was no obvious link pointing them at it, and the
BARE `#/cms/` still meant the (relay-admin-only-writable) global shell,
the least useful thing for an ordinary visitor to land on. Fixed by
flipping the default: for a `mode: 'multiuser'` app, a subPath NOT
matching `/u/<ref>/...` (`boot.js`'s `parseMultiUserSubPath()`) is now
treated as an IMPLICIT `{ref: 'me', ...}` rather than falling through to
the global shell - `#/cms/` and `#/cms/cms` now mean "my own space" and
"my own CMS editor," no URL convention to discover at all. `/u/<ref>/...`
remains, explicitly, for the one thing a bare prefix genuinely cannot
express - addressing "me" explicitly, or someone else's space on purpose.

This left the app's own GLOBAL shell - what the bare prefix used to mean -
without a home, since it obviously couldn't keep the bare prefix once that
now means "your own space." Given it back one level up:
`#/admin/<appPrefix>/...` (`parseAdminSubPath()`/`renderGlobalShell()`,
`boot.js`) - `startPlatform()`'s `"admin"` branch tries this BEFORE
falling back to the admin console's own UI, delegating to
`renderGlobalShell()` (the SAME `AppRuntime`/`GLOBAL_KINDS`/
`globalAppAnchor()`/`wireCms({global: true})` combination every
`mode: 'global'` app's bare prefix already used, just factored out for
this second call site) whenever the next path segment names another
CURRENTLY-registered `realm: 'global'` app. Gated by the exact same
`space.isRelayAdmin()` check the console's own root already had - a
`mode: 'multiuser'` app's global shell is exactly as relay-admin-only as a
plain `mode: 'global'` app's always was, only its ADDRESS moved.

**`registerApp()`/`setAppMode()`'s own version of the self-provisioning
race, caught by the admin console's new mode buttons:** giving the admin
console UI actual mode-toggle buttons (instead of registration only)
surfaced a second instance of the exact bug class `ensureSelfProvisioned()`
already fixed once (`Space.createNode()` never refcounts its own
creation - the first `useNode()`/`release()` pair ANY reader does
afterward tears the local Y.Doc back down). `registerApp()`/`setAppMode()`
used to do a bare `space.getNode(id) ?? (await space.createNode(...))`
against `qu-platform-apps`'s own registry Node - harmless the FIRST time
any given `Space` instance ever touches it, but the admin console's own
apps-list refresh (`platform.resolveApps()`, an ordinary `useNode()`+
`release()` pair) now runs BETWEEN a relay-admin's page load and their
next mode-button click, tearing that registry back down locally; the next
`setAppMode()` call's own `getNode(id)` then found nothing, fell into
`createNode()`, and built a brand-new, EMPTY local Y.Doc for an id that
already held every other relay-admin's registrations - `setAppMode()`
promptly failed to find the very entry it was just asked to change
(`"cms" is not a registered app"`, reproduced via exactly this
click-right-after-a-list-refresh sequence, not a contrived one). Fixed by
routing both functions through `getOrSyncRegistryNode()` - the SAME
"never blindly re-`createNode()`, check whether it merely needs a moment
to resync first" helper `publishRoute()`/`createTemplate()`/`createStyle()`
already used for their own per-owner registries - instead of hand-rolling
the same check again, incorrectly, for this one global registry.

**Self-provisioning at your own bare pubkey, not just inside a `multiuser`
app (a later revision):** a real question followed the routing flip above -
could a personal space live at `#/<pubkey>/` directly, independent of any
app's prefix at all, rather than mandatorily nested under `#/cms/...`? The
platform ALREADY had a fully generic, always-on mechanism for exactly this
- `PlatformRuntime.resolveForPath()`'s "unregistered prefix tried as a
literal owner id" fallback (`realm: 'main', appAdminPub`, this file's own
`platform.js` doc comment) - any identity's own space was already reachable
there for READING, zero app/prefix involved. The only gap: nothing
SELF-PROVISIONED there, so a brand-new identity's own `#/<their-pubkey>/`
was a dead 404 rather than a working starting point. Closed by calling the
EXACT SAME `ensureSelfProvisioned()` a `mode: 'multiuser'` app's own
`ref: 'me'` already uses, from `startPlatform()`'s ordinary (non-global)
branch too, gated on `match.name === null` (the fallback's own signal,
`resolveForPath()`) AND `match.appAdminPub === space.identity.signingPub` -
deliberately NOT extended to a REGISTERED `realm: 'main'` alias pointing at
the same identity, since an app-admin who bothered to register a prefix
presumably has their own install story already, and auto-seeding a generic
starter there would surprise, not help. Same underlying storage either way
(`deriveOwnerNodeId`/`deriveContentNodeId` derive identically regardless of
which URL reached it) - `#/cms/`, `#/cms/u/me/`, and `#/<your-pubkey>/` are
three doors into the exact same room, never three different rooms. Making
the "cms" app's own GLOBAL registration occupy the platform's literal root
(`prefix: ''`) was considered and set aside instead - technically already
possible (`registerApp()` never validates `prefix` shape beyond the admin
console's own form pattern), but it would permanently hide the "nothing
installed yet" landing page the moment any app claims it, and makes
`#/admin/<prefix>/...`'s own delegation path (`parseAdminSubPath()`) reduce
to an awkward double slash - the bare-pubkey fallback above solves the
actual "can I reach my own space without an app prefix" need without either
cost.

**Faster reads: a relay `sync-ack` and its `settle`-margin (a later
revision):** every `@qu/app-core` `ContentResolver`/`PlatformRuntime` read
used to poll a Node's own fields for up to its FULL configured timeout
(1500-4000ms, several calls often chained per page load) even when the
relay could have said "nothing here" almost immediately - `handleSubscribe()`
(`@qu/space-transport`'s relay.js) previously replied with silence for a
genuinely nonexistent Node, making "still in flight" and "confirmed absent"
indistinguishable client-side. Fixed with an explicit `sync-ack` message
(nodeId + replayed envelope count, possibly 0) sent at the END of every
subscribe response - `Space.isNodeSynced(id)` (space.js) tracks having
received one, and `resolver.js`/`platform.js`/`dev.js`'s own `waitFor()`/
`waitForSync()` helpers now return as soon as that flips true AND `checkFn`
is still empty, instead of always burning the rest of `timeout`. Measured
effect: a first-time visitor's self-provisioning + first render dropped
from ~5.5s of pure dead-wait (against an instantly-responding relay) to
near-instant; the full `packages/app-shell` test suite's wall-clock time
dropped by roughly a third.

A REAL RACE THIS CAUGHT BEFORE SHIPPING, the reason `settle` (default
150ms, the SAME margin `cms-actions.js`'s `verifyWritesAcked()` already
uses) exists at all: `isNodeSynced()` only describes what the relay's OWN
mirror held at the exact moment it computed the ack - it says NOTHING about
a write from a COMPLETELY DIFFERENT peer that was already in flight to the
relay at that same moment. `subscribers.get(nodeId).add(fromPeerId)`
happens BEFORE that snapshot is read, so such a write is still guaranteed
to reach the subscriber as an ordinary live forward - just with NO relative
ordering guarantee against the (separately, asynchronously computed)
`sync-ack` itself, since relay.js's own per-peer `peerQueues` run fully
concurrently with each other. Returning the INSTANT `isNodeSynced()` flipped
true, with no settle margin at all, was caught immediately by
`test/live-app-resolver.test.js`'s own genuine cross-peer scenario (a
different identity's brand-new page, read by a totally uninvolved visitor
moments later) - it started resolving to `null` for content that
plainly existed, purely because the relay's OWN empty-ack (correct, AT THE
INSTANT it was computed) arrived before the concurrently-in-flight write's
live-forwarded update had been locally applied yet. `ensureSelfProvisioned()`'s
own self-check never raced this way (nothing else can concurrently write a
not-yet-created identity's own Nodes), which is exactly why a cross-peer
test was necessary to catch it - a same-identity check alone would have
shipped it clean. `settle` narrows, rather than eliminates, the remaining
window (an update taking upward of `settle` to physically arrive after
being sent is astronomically rarer than "arrived in some arbitrary order
relative to an unrelated ack" was) - accepted as the same class of
pragmatic tradeoff `verifyWritesAcked()`'s own settle margin already makes.

Also parallelized two independent-but-previously-sequential `await` pairs
found while investigating the same "why is this slow" report:
`AppRuntime.resolveRoute()`'s manifest+page resolution (`runtime.js`,
neither depends on the other's RESULT), and `shell.js`'s own
`joinSpace()`/`fetchRelayAdmins()` boot-sequence calls (a completely
independent, unauthenticated read, needlessly held until AFTER `joinSpace()`'s
own two-step POST-then-GET finished).

**"Subscribe statt Polling" (a later revision): the `sync-ack` fast-path
above was still a POLL LOOP that merely gave up early - `waitFor()`/
`waitForSync()` re-checked `checkFn` on a fixed `interval` (20ms) timer
regardless of whether anything had actually changed. Both are now
EVENT-DRIVEN when `space.bus` exists (real in production - `shell.js`
always constructs one): they subscribe to `space.node.<id>.changed`/
`.sync-ack` (already emitted by `Space` for every write/ack, whether or not
anything was listening) and only re-run `checkFn` when one of those
actually fires - resolving the instant the real signal arrives instead of
up to `interval` later, and burning zero cycles in between. Falls back to
the identical old poll loop only for a `space` with no `bus` (some
lower-level test setups) - `isNodeSynced()`'s own STATE is correct either
way, only the EVENT announcing a change to it is unavailable without one.
`verifyWritesAcked()` (`@qu/app-shell`) got the same treatment: its own
trailing "poll until acked>=expected" loop is now a single event listener
racing a deadline timer.

While adding tests for this, a SEPARATE, previously-undetected bug
surfaced: `resolvePage()`/`resolveTemplate()`/`resolveStyle()`/
`resolveView()` (`resolver.js`) resolved as soon as their checked field(s)
were non-empty, WITHOUT first gating on `isNodeSynced()` the way
`resolveGroup()`/`resolvePrivatePage()`/`resolveSharedList()` already did.
On a fresh re-subscribe (e.g. right after `Space.useNode()`'s own
ref-counted teardown - see the "does not exist (or has not synced)" bug
just above, worked around for the CMS's own edit flow by resolve-with-
`hold`, see the follow-up entry below, but `useNode()`'s teardown-on-
release mechanism itself is unchanged for every OTHER caller), a relay
replays a Node's envelopes OLDEST FIRST - a STALE,
pre-edit value can already be non-empty and get returned before the
Node's own LATEST edit envelope has even been applied. Caught by a new
regression test (`wait-for-sync-events.test.js`: edit a page on a fresh
connection, immediately resolve it back) that failed with the OLD content
even though the edit had already been relay-acked. Fixed the same way the
three methods above already were: gate every `checkFn` on
`isNodeSynced(id)` first. Also wired `space`/`nodeId` through to
`waitForSync()` at every `edit*()`/`editGlobal*()` call site in `dev.js`
that had been omitting them (all but `getOrSyncRegistryNode()` and
`editGroup()`/`editPrivatePage()`) - the exact functions behind the
"does not exist (or has not synced)" production bug never actually had the
`isNodeSynced()` fast-path wired in at all before this.

**"Bootstrap-Vereinfachung" (a further later revision): `holdEdit()`
removed, replaced by a resolver-level `{hold: true}` option, not just
another app-level workaround for the same gap.** The "does not exist (or
has not synced)" bug's ROOT CAUSE (`Space.useNode()`'s ref-counted
teardown-on-release discarding a Node the instant nothing holds it, even
for a heartbeat) was never itself eliminated by either fix above - only
worked around, first by `cms-actions.js`'s own hand-rolled extra
`useNode()` call (`holdEdit()`), one file reinventing the same fix any
OTHER app wanting it would have had to reinvent too. Genuinely removing
`useNode()`'s teardown-on-release semantics outright was deliberately
rejected (`packages/space-core/test/use-node.test.js`'s own "after a full
release, calling `useNode()` again for the same id starts completely
fresh" is asserted, real behavior other callers depend on, and a
time-based "grace period before tearing down" would still not cover a
user who takes minutes to fill out a form, only a fast click-through).
Instead, `resolvePage()`/`resolveTemplate()`/`resolveStyle()`/
`resolveView()` (`@qu/app-core`'s `resolver.js`) gained an opt-in `hold`
option: skips the method's own internal `release()`, returns
`{page/value/view, release}` instead of the bare value, so the CALLER
decides how long to keep the exact same subscription open - unbounded, the
same "for as long as the form stays open" duration `holdEdit()` already
correctly provided, just as a first-class, reusable resolver capability
instead of a private per-file trick. `cms-actions.js`'s three former
`holdEdit()` call sites (Templates/Styles' shared `wireSimpleContentSection()`,
Content's page-row click handler, Content's "View laden" button) now
resolve with `{hold: true}` directly and keep the returned `release` on
`activeEdit`, the exact same lifecycle as before, one fewer redundant
`useNode()` call each. `holdRegistry()` (a different, already-correct
pattern - a whole CMS session's own registry, never released during normal
operation, not tied to any one resolve call) is unaffected. See
`packages/app-core/test/resolver-hold.test.js` for the end-to-end proof: a
held `resolvePage()` on one `Space` instance, followed by `editPage()` on
that SAME instance, needs neither the `isNodeSynced()` fast-path nor any
wait at all to succeed, because the Node was never torn down to begin
with.

**"Views/Pages/Templates-UX" (Phase 4): delete finally exists, and a
complex View can be imported as one JSON blob.** Two real, previously
missing CMS capabilities, both closing a gap the framework's own data
model (not just the UI) had never actually supported:

1. **`@qu/space-core`'s `field.js` `ListField` gained `remove(index,
   length)`** - before this, `ListField` only ever had `push()` (this
   document's own `platformAppsKind` doc comment already flagged the
   symptom: "`ListField` has no removal primitive... no `unregisterApp()`")
   - the STRUCTURAL reason Pages/Templates/Styles/Views had no delete
     story at all: their registries (`routeRegistryKind`/
   `templateRegistryKind`/`styleRegistryKind`) are `shape: 'list'` fields,
   and nothing could ever un-register an entry once pushed. `remove()`
   wraps Yjs' own `Y.Array.delete()` - CRDT-merged against a concurrent
   insert/remove exactly like `TextField.delete()` already is for
   `Y.Text`, proven in `packages/space-core/test/field.test.js` with a
   genuine two-peer concurrent remove-vs-push scenario (both survive,
   never one clobbering the other).
2. **`dev.js` gained `deleteTemplate()`/`deleteStyle()`/`deletePage()`/
   `deleteView()`** (plus `unregisterContentName()`/`unpublishRoute()`,
   the registry-side removal helpers, symmetric with the existing
   `registerContentName()`/`publishRoute()`) - each removes the item from
   its own registry (so `resolveTemplateNames()`/`resolveStyleNames()`/
   `resolveRoutes()` stop enumerating it) and best-effort clears its own
   content (`editTemplate()`/`editStyle()`/`editPage()`/`editView()` under
   the hood, writing empty values) - still NOT a genuine Node deletion (no
   such primitive exists anywhere in this architecture, the same "cleared
   and unreachable via the registry, not erased" caveat
   `nullGlobalAppContent()` already established for whole-app uninstalls,
   generalized here to one item at a time). Self-owned only, deliberately
   no `ownerPub` override (matching `createTemplate()`/`createStyle()`/
   `createPage()`'s own scope) - a granted co-editor can fully edit
   someone else's content through the exact same form already, but cannot
   delete it: `unregisterContentName()`/`unpublishRoute()` only ever look
   at the CALLING identity's own registry, so a co-editor's attempt fails
   with a clear "is not registered" error rather than silently doing
   nothing or touching the wrong registry. `deleteGlobalPage()` and
   friends (the `realm: 'global'` counterparts) don't exist yet - real,
   deliberate follow-up work, not attempted here.
   `cms-actions.js` wires a "Löschen" button next to every Templates/
   Styles/Content row (non-global only, same "no native `confirm()`"
   posture `admin-actions.js`'s own "Deinstallieren" already established -
   fires immediately, framework-provided interactivity stays a plain DOM
   element) - `data-qu-cms-delete="template"\|"style"\|"content"` for a
   test/CSS hook. Every listed Content route gets ONE delete button
   regardless of whether it was authored via the "Text/HTML" picker or the
   "Geteilte Liste"/"Seiten-Filter" (View) picker - `createView({route})`'s
   own "auto-creates a wrapper page" behavior (§7 above) means every routed
   item has a REAL wrapper page underneath it either way, so `deletePage()`
   alone is correct and sufficient for the row - a View's own SEPARATE Node
   (`sources`/`sortBy`/...) is untouched by it; deleting THAT specifically
   has a Dev API (`deleteView()`) but no dedicated UI button yet.
3. **A complete View definition can now be imported as one JSON blob** -
   the user's own explicit ask, closing the gap the existing `sourcesOverride`
   textarea (a raw-JSON escape hatch for the `sources` array alone,
   `wireContent()`'s own doc comment) only partially addressed: a new
   "View aus JSON übernehmen" `<details>` block above the Content list
   accepts `{name, route, sources, sortBy, sortOrder, limit, itemTemplate,
   template, style}` (every field optional except `name` or `route`) and
   populates the form's own fields on click - `sourcesOverride` specifically
   (never the simple single-source picker fields), so ANY `sources` shape
   round-trips correctly, simple or multi-source alike, with no
   special-casing. Deliberately does NOT auto-submit - "Speichern" still has
   to be clicked, same review-before-save posture loading an existing item
   into the form already has.
See `packages/app-core/test/dev-delete.test.js`, `packages/space-core/test/field.test.js`'s
new `ListField.remove()` cases, and `packages/app-shell/test/cms-delete.test.js`/
`cms-view-import.test.js` for the end-to-end proofs.

**Phase 5: `self` - a symbolic node-id reference, closing the actual reason
Qu-Components in hand-authored Template HTML were impractical.** Views and
Qu-Components (`<qu-view>`/`<qu-bind>`/`<qu-list>`) are NOT overlapping
mechanisms - Views aggregate many Nodes into one filtered/sorted feed (§7
above), Qu-Components live-bind exactly ONE known Node's field - but the
Qu-Component side had a real, structural blocker no amount of UI could have
papered over: `resolveNodeRef()` (`@qu/space-components`'s `resolve.js`)
needed a literal `node-id` attribute, and a self-owned Page/Template/
Style's own id is `deriveContentNodeId(ownerPub, kind, path)`'s OUTPUT - a
hash, not something a content author can type. So `<qu-bind kind="qu-page"
node-id="???" field="title">` - "bind to THIS SAME page's own title," the
single most common case - had no practical way to be written by hand at
all before this.

Fixed with a THIRD, symbolic way to supply both `kindSchema` and `nodeId`
together - the `self` attribute (`<qu-bind self field="title">`) - resolved
against a new ancestor-context pair, `.quSelfNodeId`/`.quSelfKind`
(`context.js`'s new `findQuSelf()`, the same ancestor-walk pattern
`findQuSpace()`/`findQuKind()` already use), which `@qu/app-shell`'s
`boot.js` now sets on `mountEl` after EVERY `renderPage()` call (six call
sites - `startApp()`'s own `onChange`, `renderMultiUserRoute()`,
`renderGlobalShell()`, `renderAggregateShell()` [explicitly cleared to
`null` - its own `page` is a synthetic shell object, never a real
`resolvePage()` result], and `startPlatform()`'s two route-matched
branches) - UNLIKE `.quSpace` (set once, the Space itself never changes
mid-session), `.quSelfNodeId`/`.quSelfKind` are reassigned on every single
render, because WHICH page is "self" changes every time. The one and only
data-side change this needed: `ContentResolver.resolvePage()` now also
returns `nodeId`/`kindSchema` alongside the plain fields (additive, already
computed internally, no new resolver call) - `AppRuntime.resolveRoute()`
passes it through unchanged since `plan.page` already IS whatever
`resolvePage()` returned.

`self` takes priority over `kind`/`node-id` if a tag somehow has both (a
self-contradictory case with no reason to prefer the less specific pair),
and resolves to a correct "not yet resolvable" `null` - never a throw -
when nothing at the current render came from `resolvePage()` (the
aggregate-shell/"not found" cases above). Deliberately did NOT build:
symbolic references to OTHER well-known anchors (the App's own Manifest,
the current visitor's own identity) - same idea, real, separate follow-up
work once `self` itself has seen real use; nor a visual "insert binding"
UI in the Template editor - trivial to add on top now that the underlying
addressing problem is solved, but not attempted here (a content author
still hand-types `<qu-view self field="...">`, exactly like they already
hand-type `<qu-slot>`/`data-qu-view`).

See `packages/space-components/test/resolve.test.js` (unit-level:
`findQuSelf()`/`resolveNodeRef()`'s `self` path, priority over `kind`/
`node-id`, the `null`-not-throw cases) and `packages/app-shell/test/
self-node-context.test.js` for the full end-to-end proof: a Page's own
content declares `<qu-view self field="title">`, renders correctly with NO
node id anywhere in the authored HTML, and updates LIVE across an
`editPage()` call with no navigation/re-render involved - the actual
"reactive Template, no app-specific JS" promise, now genuinely reachable
by a content author instead of only by framework/app code holding a real
`kindSchema` object in scope.

**A self-provisioned multiuser participant's OWN registries were silently
dropped by the relay (a real, shipped bug, found and fixed in the same
pass):** `qu-app`/`qu-route-registry`/`qu-template-registry`/
`qu-style-registry` are all `acl.write: 'named'` (kinds.js) - genuinely
self-certifying at the AUTHORIZATION layer (`buildWriteAcl()`, relay.js,
needs no grant, only `deriveOwnerNodeId(claimedSignerPub, kind) === nodeId`)
- but `createAppResolveKindSchema()` (relay-resolver.js) could only
CLASSIFY a nodeId as one of these Kinds for an owner already listed in its
own `appAdminPubs` parameter, silently misclassifying anyone else's as the
generic `pageKind` ('content'-ACL, grant-only) fallback - a write with no
grant, for a Kind the writer's own client never thought it needed one for,
rejected outright. A `mode: 'multiuser'` participant is, BY DESIGN, never
`registerApp()`-registered anywhere (the whole point of the mode is ZERO
relay-admin cooperation) - so EVERY personal registry write such a visitor
made was silently dropped. Invisible from the CREATING identity's own
already-connected Space the whole time (a local write always applies to
its own Y.Doc regardless of what the relay does with it) - only surfaced
on a genuine RECONNECT (a fresh Space, nothing local to fall back on) or a
DIFFERENT peer trying to enumerate that identity's own routes/templates/
styles, exactly why the earlier CMS-as-multiuser-example verification never
caught it (same-tab, same-session testing throughout) and exactly the
reported symptom ("mein CMS zeigt nach einem Reload keine Seiten mehr an").

Fixed by teaching `resolveKindSchema` a genuinely optional second
parameter, `claimedPub` - the write/subscribe message's own claimed signer
pubkey, straight off the (not yet cryptographically verified at that point)
envelope/request (`relay.js`'s `handleWrite()`/`handleSubscribe()`/
`ingestFederated()` all now pass it; `createLiveAppResolveKindSchema()`
threads it straight through). `createAppResolveKindSchema()`'s own resolver
uses it as a DYNAMIC fallback: since these four Kinds' ids never involve a
`path` (`deriveOwnerNodeId(ownerPub, kind)` alone), it can re-derive
whether `claimedPub` happens to be exactly this owner's manifest/route-
registry/template-registry/style-registry id, for ANY owner, not just ones
in `appAdminPubs` - genuinely no pre-registration needed any more. Safe
specifically because CLASSIFICATION and AUTHORIZATION are cryptographically
bound together: a forged claim never gets past `verifyEnvelope()`'s actual
signature check regardless of what it got classified as, so using an
UNVERIFIED claim purely to pick which Kind-Schema/ACL-check applies never
grants anything a genuine signature check wouldn't also grant on its own.
Every `resolveKindSchema` implementation may now be `async` (existing
synchronous ones keep working - `await`ing a non-Promise value resolves
immediately) - all four relay.js call sites `await` it.

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

**Groups and private/shared content ("CMS heißt nicht automatisch, dass
alle Seiten alle sehen können" - the user's own framing):** every `qu-page`
so far is readable by the WHOLE Space (`'content'`-ACL governs who may
WRITE, never who may READ - kind-schema.js's own doc comment). A page
someone wants visible to only themselves, or to a named subset of the
Space, needed two new, deliberately GENERIC (not CMS-specific - Chat/
Calendar will reuse both) primitives, both in `@qu/app-core`:

- **`groupKind`** (`kinds.js`) - a `'content'`-ACL, many-per-owner, named
  Kind (`deriveContentNodeId(ownerPub, 'qu-group', name)`) with two PUBLIC
  atomic fields: `name` and `members` (`Array<{pub, xPub}>`, base64
  strings). `members` is public by design, a deliberate, accepted
  tradeoff: encrypting the membership LIST itself would need to already
  know who's allowed to read it - the exact chicken-and-egg problem this
  Kind exists to solve for everything else. `editGroup()`
  (`dev.js`) replaces the whole list wholesale (last-write-wins, no add/
  remove primitive) - `ContentResolver.resolveGroup(name)` reads it back
  as `{name, members}` with `members` already decoded to raw bytes, the
  exact shape `createPrivatePage()`'s own `recipients` expects.
- **`privatePageKind`** - `pageKind`'s sibling: same fields (`route`/
  `title`/`template`/`content`/`data`), but only `route` stays `public`;
  `title`/`template`/`content`/`data` are `visibility: 'encrypted'`, and
  the Kind is deliberately NOT wrapped in `publicMeta()` (unlike
  `pageKind`) so the Node's own meta-stamp - its existence, owner, and
  timestamp - is hidden from non-recipients too, not just its content.
  `createPrivatePage()`'s `recipients` (raw X25519 pubkeys - a group's own
  `members.map(m => m.xPub)`, or an ad-hoc list) narrows the encryption
  audience below "every Space member"; omitting it entirely means
  "nobody but me" (`recipients` defaults to `[]` here specifically, NOT
  `undefined` - see below). `ContentResolver.resolvePrivatePage(route)`
  mirrors `resolvePage()` exactly; `null` covers BOTH "no such route" and
  "you're not an authorized reader" - genuinely indistinguishable on
  purpose, the same privacy-preserving non-answer a truly unpublished
  route already gives.

**The mechanism underneath both is generic, not new**: `@qu/space-core`'s
envelope encryption (`QuCrypto.encrypt()`) was ALREADY multi-recipient
(`{iv, ct, to: [{pub, key}]}`, one wrapped content-key per recipient) -
what was missing was a way to narrow the recipient list below "every
Space member" at all. `Space._effectiveRecipients(recipients)` does that:
`undefined`/omitted still means the old, unchanged "every Space member"
default (so every EXISTING Kind's behavior is untouched); an explicit
list is used as-is, with the caller's OWN key defensively appended if
missing (so narrowing recipients can never accidentally lock the writer
out of their own data). `Space.createNode()`/`stampMeta()`/`field.js`'s
`AtomicField`/`TextField`/`ListField` all now accept and thread through
this same `recipients` option. One easy-to-make mistake this surfaced
and fixed directly in `field.js`: the defensive self-inclusion above is
ENVELOPE-level only - `'atomic'`/`'list'` shape fields ALSO have their own
separate FIELD-level ciphertext layer (`encryptForRecipients()`, on top
of the envelope, kind-schema.js's own doc comment on why), which needed
the identical defensive self-inclusion (`includingSelf()`) or a narrowed
`recipients` list would leave the page's own OWNER unable to decrypt
their own just-written field.

**Not retroactive, by design - the same guarantee real E2E group
messaging relies on:** growing a group's membership and re-saving an
EXISTING `privatePageKind`'s fields reaches every reader who could
ALREADY decrypt that page, live - proven by `createPrivatePage()`'s own
test re-saving `content` and a pre-existing group member seeing the
update immediately. It does NOT retroactively unlock that same page for a
BRAND NEW member, even once their key is added to `recipients` on a later
write: `stampMeta()`'s meta envelope is sealed exactly ONCE, at creation,
for whoever was a recipient then, and is never re-sealed by a later edit
- and Yjs itself refuses to integrate ANY later envelope from that Node's
original author while an EARLIER one in that same author's sequence (the
meta stamp) stays undecryptable to a given reader (the identical
gapless-per-author mechanism `grant.js`'s own "WRITE-BEFORE-GRANT IS A
TRAP" doc comment describes for a different write-ACL scenario). A new
member gets full, immediate access to any page `createPrivatePage()`d
AFTER they joined instead, since every one of THAT page's envelopes -
meta included - is sealed for the group's CURRENT membership from the
very first write. See `packages/app-core/test/group-private-content.test.js`
for all of the above proven end-to-end over a real in-process relay
(genuine ACL/encryption enforcement, not a local simulation), and
`dev.js`'s own `editPrivatePage()` doc comment for the full "why" inline.

**Shared lists (a guestbook) and Views (a Drupal-Views-style live feed
combining several content sources) - both deliberately REUSABLE by ANY
app, not CMS-specific:** two more content primitives, prompted by "wäre
ein Gästebuch/Blog überhaupt eine eigene App, oder nur Pages mit
Templates?" (the user's own question) and "CMS-Infrastruktur und Views
sollen auch in Apps wiederverwendbar sein - später auch ein Forum, ein
Live-Ticker, GeoChase" (the user's own stated direction). Both answers
turned out to be "no new app-execution mechanism needed at all" - the
missing pieces were two small, generic Kind-Schemas plus a way to merge
several of them, not a bigger "app modules" architecture (see this
document's own still-open question on that below).

- **A genuine guestbook needs `acl.write: 'members'`, not `'content'`**:
  `defineCollectionKind()` (this document's own "Structured page data and
  Collections" section, above) is `acl.write: 'content'` - ONE identity
  curating MANY items it each individually owns (right for "an app-admin's
  own blog posts," the user's own insight that "Blog wäre ggf. nur der
  Klebstoff" over ordinary Pages + a route-registry-filtered `<qu-list>`,
  no new Kind needed at all). A guestbook is the opposite shape: MANY
  DIFFERENT visitors each contributing their OWN entry to ONE shared list.
  `@qu/app-core`'s new `sharedListKind` (`kinds.js`) is `acl.write:
  'members'` with a single append-only `entries` list field of
  caller-defined plain objects (the SAME "no separate per-item Kind-Schema"
  shape `groupKind.members`/`platformAppsKind.apps` already use) - Yjs
  arrays merge concurrent inserts from DIFFERENT authors natively, so many
  strangers `.push()`ing at once needs no relay-side coordination at all.
  ONE Kind, MANY independent lists: `sharedListAnchor(name)` derives a
  fixed, per-NAME, non-cryptographic anchor (the same idea
  `globalAppAnchor(prefix)` already uses one section up) so a deployment
  can run as many named lists as it wants (a guestbook, a feedback box, ...)
  without colliding. `dev.js`'s `pushToSharedList(space, name, entry)` is
  the whole write-side API; `ContentResolver.resolveSharedList(name)` reads
  it back, `[]` both for "genuinely empty" and "never used" (unlike every
  OTHER resolver here, an empty list is a valid final answer, not a "not
  synced yet" signal - see its own doc comment on why it gates on
  `isNodeSynced()` instead of "wait for a non-empty value"). A relay must
  be told every shared-list NAME it should recognize up front
  (`createAppResolveKindSchema({sharedListNames: ['guestbook']})`) - unlike
  every other Kind here, a shared list's id is anchored on a HASH OF THE
  NAME, not a real signer's own pubkey, so there is no `claimedPub`-based
  dynamic classification fallback possible for it (see `relay-resolver.js`'s
  own doc comment).
- **Views (`viewKind`, `view-sources.js`) - "user-feed combines Blog +
  Gästebuch" (the user's own example), a Drupal-Views-style live,
  aggregated feed**: a View Node (`acl.write: 'content'`, the SAME
  self-owned shape templates/styles already use) holds a small RECIPE -
  `sources` (`Array<{type, ...params}>`, PLAIN data), `sortBy`/`sortOrder`/
  `limit`, and an `itemTemplate` (ordinary `<qu-slot>`-based HTML, the
  EXACT SAME mechanism `@qu/app-renderer`'s `slots.js` already fills for a
  Page's own template, stamped once PER RESOLVED ITEM). `view-sources.js`'s
  `VIEW_SOURCE_ADAPTERS` maps a source `type` string to the actual
  `@qu/space-core` calls needed to read + observe it, normalizing EVERY
  source to the same `{title, excerpt, route, timestamp, raw}` shape so
  totally different Kinds (a `qu-route-registry` entry, a `sharedListKind`
  entry) can be merged into one feed. Two adapters ship for now - `'pages'`
  (routes under an optional `prefix` - "a blog is just pages under
  `/blog/`") and `'shared-list'` (any named `sharedListKind`); a
  `'collection'` adapter is real, natural, NOT-YET-BUILT future work - a
  Collection's `itemKind`/`registryKind` are actual Kind-Schema OBJECTS a
  View's own plain-data `sources` field cannot reference by name alone,
  needing a caller-supplied lookup table, a separate piece of plumbing.
  `view-sources.js`'s `openLiveView(space, config)` is what makes this
  LIVE, not a one-time snapshot (the user's own explicit choice for v1,
  over a simpler snapshot-on-load alternative): it opens every source's
  own `Space.useNode()`+field subscription and keeps them ALL open,
  recomputing the merged/sorted/limited result whenever ANY ONE fires,
  returning `{toArray, observe, close}` - deliberately the EXACT interface
  `@qu/space-core`'s own `ListField` already exposes, so `@qu/space-ui`'s
  existing `bindList()` (unmodified) can bind straight to it with zero
  adapter code, as if it were one ordinary list Field. NOT watched live: the
  View's OWN definition Node - editing a View's `sources`/`itemTemplate`
  only takes effect on the NEXT resolve, same as any other Space content
  edit never hot-reloading an already-rendered page (`openLiveView()`'s own
  doc comment).

  **UPDATE - CLIENT-SIDE FULL-TEXT SEARCH (`setQuery()`).** The returned
  object gained `setQuery(text)`: a live, case-insensitive substring filter
  over `searchFields` (default `['title', 'excerpt']`), applied BEFORE
  `sortBy`/`limit` and re-notifying observers, same as any other source
  change. Deliberately client-side over whatever a View's sources have
  ALREADY synced - no relay-side search index/query exists (a relay only
  forwards signed envelopes) - the same honest "only as good as what a
  client has locally" limitation `ListField.slice()` already accepts. The
  real gap this closes: a `'pages'` source previously only ever exposed
  `item.title` (`routeRegistryKind`'s `routes` entries had no content at
  all), so searching a Blog/CMS feed could only ever match a PAGE TITLE,
  never its actual content. `routeRegistryKind` gained an optional
  `excerpt` per route (`dev.js`'s `publishRoute()`/`publishGlobalRoute()`,
  a new `excerptFromHtml()` helper - strip tags, collapse whitespace,
  truncate) - captured ONCE, at publish time (never kept in sync on a
  later edit, the same accepted scope cut as the aggregate index's own
  cached title) - which the `'pages'` adapter now also normalizes into
  `item.excerpt`. Wired into ONE example, Blog (`blog-actions.js`'s
  `publishGlobalPost()`/personal-create branch both pass `excerpt:
  excerptFromHtml(content)`) - `blog-search.test.js` proves a post
  published through the real form is findable by its own body text via
  the SAME `blog-index` View `blog-bundle.js` already builds, no new
  View/UI wiring needed for the underlying mechanism. A `<qu-search-box>`
  UI Component (a plain `<input>` calling `setQuery()`) remains open -
  UI-Feinheiten deliberately come last, per this whole roadmap's own
  stated ordering.
- **Rendering lives in `@qu/app-shell`, deliberately NOT `@qu/app-renderer`**:
  `@qu/app-renderer` is a pure "already-resolved plan -> DOM" renderer with
  ZERO dependency on `@qu/space-core`/`@qu/app-core` (turns plain
  `{templateHtml, page}` data into markup, nothing more) - giving it its
  own live Space subscriptions would invert that layering. `@qu/app-shell`'s
  new `view-actions.js` (`wireViews()`) is the SAME "framework interactivity
  attaches to inert markup by attribute convention" posture
  `cms-actions.js`/`admin-actions.js` already use, just for a READ-side
  concern (`[data-qu-view="name"]` -> a live feed) instead of a write-side
  one (an editor form) - `boot.js` calls it unconditionally after EVERY
  `renderPage()`, for every app/realm (a `realm: 'global'` app's `GLOBAL_KINDS`
  gained a `routeRegistryKind: adminRouteRegistryKind` entry specifically
  so its OWN Views resolve routes against the right registry) - a correct
  no-op whenever the rendered page has no `[data-qu-view]` element,
  regardless of which app produced it. Unlike `wireCms()`'s forms (inert
  DOM listeners only), `openLiveView()` holds REAL `Space` subscriptions
  open - `wireViews()` tracks what it opened per `mountEl` and closes that
  batch FIRST on every re-wiring (a route change), so navigating around
  never accumulates one leaked subscription set per page visited.
- **Authoring is a SEPARATE, swappable concern from rendering - "editors
  as plugins," the user's own stated future direction, not built as a full
  plugin mechanism yet, but left room for**: `cms-actions.js`'s
  `wireContent()` (superseding the original, now-removed `wireViewEditor()`
  - see the "UPDATE" note above) is explicitly documented as ONE REFERENCE
  editor for `viewKind`, calling the exact same app-agnostic `createView()`/
  `editView()` Dev API any OTHER app (a future Forum, Live-Ticker,
  GeoChase) could call from its own UI without touching `cms-actions.js`
  at all - the same point `kinds.js`'s own `viewKind` doc comment makes
  from the data side. No browseable list (unlike templates/styles/pages) -
  a View has no "list every View this owner has" registry yet (real,
  separate future work), so editing an existing one means typing its exact
  name and clicking "Laden" rather than picking it off a list. Skipped
  entirely for `realm: 'global'` apps, the SAME deliberate cut
  `wireTemplates()`/`wireStyles()` already make for the identical reason:
  `viewKind` is `acl.write: 'content'`, self-certifying to the CREATING
  identity - there is no `qu-admin-view` counterpart yet for a global app's
  `'relay-admins'`-owned content.

**See `docs/example-apps.md`** for four full worked examples built on
exactly `sharedListKind`/`viewKind`/ordinary pages - a Guestbook, a Blog,
a Forum (topics + one more named shared list per topic for its replies),
and a simple public Chat - proving none of the four need a new Kind-Schema
or any app-specific execution logic at all, the concrete evidence behind
this document's own still-open "app modules" question just below: that
question is about apps that DO need real execution logic (game rules, a
Live-Ticker's own scoring), a genuinely different class from these four.

**UPDATE - Blog: klare Pfade (Global Feed / User Feed / Post anlegen /
Post editieren), and a second real, deployment-observed bug in the SAME
family as the `setAppMode()` one above.** A relay-admin reported switching
Blog to `mode: 'multiuser'` made the previously-reachable global blog 404,
and that it wasn't clear where a visitor's OWN blog even was or how to post
to it. Root cause, NOT a framework bug: `mode: 'multiuser'` is documented
(this section's own `platformAppsKind` doc comment) as "a whole personal
SITE per visitor," not a feed shape - `boot.js`'s own `mode:'multiuser'`
dispatch (`renderMultiUserRoute()`, no `routeNamespace`/`personalBundle`)
never provisions an app's OWN `personalBundle` there, only the generic
"Mein Bereich" CMS starter, while the app's real global content moves to
relay-admin-only `#/admin/<prefix>/...` - exactly wrong for Blog (or
Guestbook), which already has its OWN, working, blog-shaped personal
instance via the ADDITIVE `/u/<ref>/` route under `mode: 'global'` (the
mode Blog was actually registered with, `personalBundle: 'blog'` already
wired since before this pass) - it was simply never linked to, and
`mode: 'multiuser'` was never actually the right choice, just never
prevented.

Two-part fix, `blog-bundle.js`/`blog-actions.js`/`admin-actions.js` only,
no framework (`boot.js`/`platform.js`/`dev.js`) change:

1. **Klare Pfade, within the already-correct `mode: 'global'`:** the Global
   Feed (`#/<prefix>/`) and User Feed (`#/<prefix>/u/me/`) pages now
   cross-link each other and label themselves as such; the global page's
   own post form (`acl.write: 'relay-admins'` - previously shown to EVERY
   visitor, silently rejected for anyone else) and a "⚙ Views verwalten"
   link into the existing generic CMS/Views editor (`#/admin/<prefix>/cms`)
   are now only ever SHOWN to a relay-admin (`space.isRelayAdmin()`,
   `blog-actions.js`'s `applyAdminVisibility()` toggling every
   `[data-qu-admin-only]` element - the SAME per-element `hidden` idiom
   `cms-actions.js`'s own form-visibility toggling already uses elsewhere),
   not merely rejected after the fact. The User Feed form's own admin-only
   "auch im globalen Feed veröffentlichen" checkbox lets a relay-admin's
   OWN post default to their personal feed and OPTIONALLY also publish to
   the global one in the SAME submit (`publishGlobalPost()`, the exact
   global-write sequence the bare global form already used, factored out
   so both call sites share it) - "default: User Feed, optional
   Relay-Admin: Global Feed," the user's own framing. Each post in either
   feed's list now shows an inline "Bearbeiten" link (event-delegated on
   `mountEl`, `forum-actions.js`'s own `event.target.closest()` idiom,
   WeakMap-tracked and removed/re-added on every `wireBlog()` call the same
   "SELF-CLEANING ACROSS ROUTE CHANGES" way `view-actions.js`'s own
   `openViewsByMountEl` already is, since `mountEl` itself persists across
   renders unlike the form) that loads the post back into the SAME create
   form via `resolver.resolvePage(route, {hold: true})` (`cms-actions.js`'s
   own "KEEPING THE EDITED NODE'S SUBSCRIPTION ALIVE" pattern, reused
   verbatim) and switches the submit handler to `editPage()`/
   `editGlobalPage()`. A REAL bug caught while building this: the edit
   link's route must be read off its sibling `[data-qu-view-link]`'s own
   `dataset.route` (the raw, unprefixed stored route `view-actions.js`'s
   `renderItem()` also exposes as a data attribute), NOT its `href` - for a
   post reached through the additive `/u/<ref>/` route, `renderItem()`
   deliberately REWRITES `href` to a navigation-shaped
   `/<prefix>/u/<ref>/post/<slug>` path (that file's own doc comment on
   why), which is NOT the id `deriveContentNodeId()` was actually derived
   from - using it silently resolved nothing.
2. **The admin console's mode-toggle buttons now refuse to offer a mode
   that would silently break a given app**, rather than allowing the click
   and leaving a confusing/broken result to discover afterward -
   `admin-actions.js`'s new `unsupportedModes()`, purely DATA-DRIVEN (never
   a hardcoded per-app-prefix list, so it applies to any app shaped the
   same way, not just the one reported): `'multiuser'` is disabled whenever
   a registered app's own `personalBundle` is set (Guestbook and Blog both,
   today) - the exact mismatch above, generalized. `'personal'` is disabled
   when the app's own installer (`APP_INSTALLERS`, resolved via its stored
   `appType`) is known and its `viewNames()` build no `-aggregate-feed`/
   `-personal-feed`-named View - Blog specifically (its own aggregate feed
   is a real, still-deliberately-deferred gap, this section's earlier
   "`mode: 'personal'`'s own aggregate feed... DELIBERATELY NOT built here
   yet" note), Guestbook is unaffected (its `${prefix}-aggregate-feed`
   already exists). An app with no known installer (a bare `registerApp()`)
   is left unrestricted - nothing to check it against.

Verified against the exact reported shape (`packages/app-shell/test/
blog-feeds.test.js`): admin-vs-non-admin visibility on both feed pages,
the dual-publish checkbox actually landing a post in both feeds, an inline
edit round-trip for both a global post (relay-admin) and a personal one
(an ordinary visitor editing their own), and the mode-button gating for
Blog/Guestbook/Forum side by side (Forum has no `personalBundle` at all -
its own "Multi-User" button stays exactly as before, the control case
proving the gate doesn't over-restrict).

**UPDATE - Blog's `mode: 'personal'` aggregate feed, closing the gap the
mode-button gating above documented.** Unlike Guestbook, a Blog post is a
self-owned PAGE, not a shared-list entry, so there was no single
cross-identity-readable source an aggregate View could merge for free.
`blog-actions.js`'s personal-post CREATE path (never an EDIT - see below)
now ALSO pushes a lightweight index entry (`{name: title, route, ts,
ownerPub}`) into a shared list, `<prefix>:personal` (registered upfront,
`admin-actions.js`'s `APP_INSTALLERS.blog.sharedLists` - the exact same
"one physical list, many logical feeds" pattern Guestbook's own
`<prefix>:personal` and `forum-bundle.js`'s topics/replies already
establish); `blog-bundle.js`'s new `aggregateFeedViewFields()` reads it,
installed unconditionally (harmless when `mode` never uses it, same
posture as Guestbook's identically-named function). `admin-actions.js`'s
`unsupportedModes()` (above) needed NO code change to re-enable the
"Personal" button for Blog - it's entirely data-driven off `viewNames()`,
which now includes `${prefix}-aggregate-feed` for Blog too.

The pushed entry's own `route` is stored ABSOLUTE, with the `/u/<ownerRef>/`
segment already baked in (`QuCrypto.toBase64Url()`, matching what `boot.js`'s
`resolveUserRef()` decodes) - the aggregate feed renders OUTSIDE any one
visitor's own `/u/<ref>/` context (`renderAggregateShell()` calls
`wireViews()` with no `routeNamespace`/`userRef` at all), so `view-actions.js`'s
`renderItem()` never rewrites this item's own link the way it would for a
View rendered INSIDE that context - the route has to already be
click-through-correct as stored. A REAL bug caught while writing this
feature's own test: a genuinely anonymous, never-`joinSpace()`d reader
cannot subscribe to a `'members'`-ACL shared list AT ALL (`relay.js`'s own
subscribe-handler doc comment - membership gates reading it, not just
writing), which at first looked like a broken aggregate feed; in a REAL
deployment every visitor is already a member by the time they read
anything (`shell.js`'s own boot sequence calls `joinSpace()` unconditionally
before touching any Kind) - there is no genuinely anonymous, un-joined
reader in this framework's actual model, only visitors who never happen to
write. Scope cut, matching every other `editX()` in this codebase: editing
an EXISTING personal post's title does NOT update its aggregate index
entry's own cached title (`ListField` has no per-index update, only
`push()`/`remove()`) - the entry's `route` always still resolves to the
CURRENT content when followed, only the aggregate list's displayed title
text could go stale after a title edit.

**Still an open question, deliberately not decided in this pass**: apps
whose EXECUTION LOGIC (not just content) lives in the filesystem/repo
itself (`/packages/app-modules/<Name>/`, administratively enabled via
`#/admin/*`, like QuV3) - raised by the user alongside the two primitives
above, then set aside once Blog/Guestbook/a combined feed turned out to
need no new execution mechanism at all. Structurally this is closer to a
NEW, "deployment-trusted" tier alongside the docs' existing three-tier
model (§17-18's Stufe 1 Content / Stufe 2 Trusted Components / Stufe 3
signed Executable Modules, none of which fit: the code would arrive via
the relay operator's OWN deployment, never fetched from Space content at
all, so Stufe 3's whole "Space-writable `qu-security-policy` trust policy"
premise doesn't apply) than a variant of any of the three - real, open
design work, not started.
