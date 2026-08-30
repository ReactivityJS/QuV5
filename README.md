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

## Development

```sh
npm install
npm test        # every package's tests, via node --test
```

## Try it: runnable demos

```sh
npm run demo
```

Runs a self-contained, zero-setup demo: two identities exchange chat
messages through an in-process relay with presence-gated push routing,
then a third, unrelated identity discovers and reads a public,
self-certifying `'owner'`-ACL Node knowing only its owner's pubkey - no
Space membership needed. For the real thing - two separate terminals
talking over an actual WebSocket relay, or a browser client
(`npm run demo:relay` also serves one on that same port) - see
[`demo/README.md`](./demo/README.md).

## Deploying the relay

```sh
docker compose -f docker-compose.space-relay.yml up -d
```

See the guide's "Docker deployment" section for `QU_MEMBERS_JSON` (optional -
only needed for `'members'`-mode ACL Kinds) and how to generate it, and for
`QU_FEDERATE_UPSTREAM_URL` to federate with another relay.
