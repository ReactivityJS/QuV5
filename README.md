# Qu V5

A from-scratch, **Yjs-native** core for Qu: every Node is a real `Y.Doc`,
every field is typed via a Kind-Schema (`atomic-encrypted` | `text` | `list`),
and every outgoing Yjs update is signed (Ed25519) and end-to-end encrypted
(X25519 + AES-GCM) before it ever reaches storage or a transport. A relay
forwards and can mirror these envelopes without ever holding a decryption
key - it verifies signatures, nothing more.

This repository is the Yjs-native line of work carried over from Qu's V3
evaluation branch, kept to exactly what that redesign needs - no V3/V4
platform code.

**Start here:** [`docs/v5-space-core-guide.md`](./docs/v5-space-core-guide.md)
covers the API (`Space`/`Node`/`Field`), what's actually cryptographically
enforced, and how to run a relay (standalone or via Docker).

## Packages

- [`packages/core`](./packages/core) - `@qu/core`: `QuCrypto`, the minimal
  crypto primitives (Ed25519 signing, X25519/AES-GCM encryption, key
  fingerprinting) everything else builds on.
- [`packages/space-core`](./packages/space-core) - `@qu/space-core`: the
  `Space`/`Node`/`Field` API, envelope signing/encryption, Kind-Schema.
- [`packages/space-storage`](./packages/space-storage) - `@qu/space-storage`:
  memory / in-process-durable / real-on-disk persistence adapters, all
  storing the same sealed envelopes that go out over the wire.
- [`packages/space-transport`](./packages/space-transport) -
  `@qu/space-transport`: in-process transport (for tests), a real WebSocket
  transport + relay, and the relay's Docker deployment.

## Development

```sh
npm install
npm test        # every package's tests, via node --test
```

## Try it: a live text-exchange demo

```sh
npm run demo
```

Runs a self-contained, zero-setup demo: two identities exchange chat
messages through an in-process relay, each identified by their Qu
public-key fingerprint. For the real thing - two separate terminals talking
over an actual WebSocket relay - see [`demo/README.md`](./demo/README.md).

## Deploying the relay

```sh
docker compose -f docker-compose.space-relay.yml up -d
```

See the guide's "Docker deployment" section for the required
`SPACE_MEMBERS_JSON` environment variable and how to generate it.
