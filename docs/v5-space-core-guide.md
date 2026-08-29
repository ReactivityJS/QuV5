# Qu V5: Space/Node/Field API + Relay Deployment Guide

This is the practical companion to the packages themselves (see
`packages/space-core/`, `packages/space-storage/`, `packages/space-transport/`
for the doc comments this guide points at). It covers three things:

1. How to use the `@qu/space-core` API to model and sync data.
2. How to run a relay that lets real, separate peer processes exchange data —
   including via Docker — with the relay acting as a mirror-storing peer so
   an offline sender's data still reaches a peer that connects later.
3. A small runnable demo — text exchange between two clients, identified by
   their Qu public-key fingerprint (see `demo/README.md`).

If you haven't read the packages' own source doc comments, do that first for
the *why*; this guide is the *how*.

## 1. Core concepts, in one paragraph each

- **Identity**: an Ed25519 (signing) + X25519 (encryption) keypair, from
  `QuCrypto.generateKeypair()` (`@qu/core`). Every peer has one.
- **Kind-Schema** (`defineKind()`): a static description of what fields a
  Node of this kind has, and their type — `'atomic-encrypted'` (a single
  value, encrypted, replaced wholesale on write), `'text'` (a real `Y.Text`,
  character-level CRDT merge, plaintext locally while being edited), or
  `'list'` (a `Y.Array` of small encrypted items, concurrent appends
  converge without any custom ordering code).
- **Space**: one peer's live view of a set of Nodes, wired to one Transport
  and (optionally) one Storage adapter. No `get(path)`/`put(path, val)` —
  you work with typed Node/Field handles directly.
- **Node**: one Y.Doc. `space.createNode(kind, fields)` makes one and
  returns it; `space.subscribeNode(id, kind)` registers interest in one
  another peer created.
- **Field**: `node.field(name)` — typed accessor, shape depends on the
  Kind-Schema (`.get()`/`.set()`/`.observe()` for atomic fields, `.ytext`/
  `.insert()`/`.delete()`/`.observe()` for text fields, `.push()`/
  `.toArray()`/`.observe()` for lists).
- **Transport**: how bytes move between peers. `InProcessTransport` (same
  process, for tests) or `WsClientTransport` (a real WebSocket connection to
  a relay).
- **Relay**: `createRelayForwarder()` — verifies write signatures, forwards
  live, and (given a storage adapter) mirrors everything it forwards. It is
  never given a decryption key, so it structurally cannot read content.

## 2. A minimal example

```js
import { QuCrypto } from '@qu/core';
import { defineKind, Space } from '@qu/space-core';
import { createInProcessHub, InProcessTransport, createRelayForwarder } from '@qu/space-transport';

// 1. Every peer needs a keypair. Generate once, store the private halves
//    somewhere safe (a file, an OS keychain, ...) - never reuse across peers.
async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}
const alice = await actor();
const bob = await actor();

// 2. Every peer that's allowed to read/write in this Space, by public key.
//    (This PoC's ACL is space-wide, not per-Kind - see kind-schema.js.)
const members = [
  { pub: alice.signingPub, xPub: alice.xPublicKey },
  { pub: bob.signingPub, xPub: bob.xPublicKey },
];

// 3. Define what a "note" looks like.
const noteKind = defineKind('note', {
  fields: { title: 'atomic-encrypted', body: 'text' },
});

// 4. Wire up a relay + two peer transports (in-process here; see §4 for real network).
const hub = createInProcessHub();
createRelayForwarder({ hub, members, resolveKindSchema: () => true });
const aliceTransport = new InProcessTransport(hub, 'alice');
const bobTransport = new InProcessTransport(hub, 'bob');
await aliceTransport.connect();
await bobTransport.connect();

const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport });
const bobSpace = new Space({ identity: bob, members, transport: bobTransport });

// 5. Alice creates a Node...
const note = await aliceSpace.createNode(noteKind, { title: 'Einkaufsliste' }, { id: 'note-1' });
note.field('body').insert(0, 'Milch, Brot');

// 6. ...Bob subscribes to it and (once sync catches up) reads the same content.
const bobNote = bobSpace.subscribeNode('note-1', noteKind);
// (real code awaits/observes; see packages/space-transport/test/poc-demo.test.js
//  for a full worked example, including waiting for delivery)
```

### Reading and writing fields

```js
// atomic-encrypted
await note.field('title').set('Neuer Titel');
const title = await note.field('title').get(); // null = unset, undefined = you're not a recipient, string = decrypted value
note.field('title').observe(() => console.log('title changed'));

// text (collaborative)
note.field('body').insert(0, 'Hallo ');
note.field('body').delete(0, 1);
const text = note.field('body').get(); // current plain string
note.field('body').observe((delta) => {
  // Yjs' own insert/retain/delete delta - apply it directly to a UI
  // instead of re-rendering the whole field on every keystroke.
});
// note.field('body').ytext - the raw Y.Text, bind ProseMirror/Quill/y-quill straight to it

// list
await channel.field('messages').push('hi');
const messages = await channel.field('messages').toArray(); // decrypted, in convergent order
channel.field('messages').observe(() => console.log('list changed'));
```

### Persistence tiers

```js
import { createMemoryStore, createDurableStore, createFileStore } from '@qu/space-storage';

// no `storage` at all = purely ephemeral (nothing survives this process)
new Space({ identity, members, transport }); // no persistence

// durable, real disk (one file per Node under a directory)
new Space({ identity, members, transport, storage: createFileStore('./my-data') });
```

To reload a Node from storage after a restart:

```js
const reloaded = await space.loadNode('note-1', noteKind);
```

## 3. Signing, encryption, ACL — what's actually enforced

- **Every Yjs update is signed** before it ever reaches storage or a
  transport, and verified before being applied (`sealUpdate()`/
  `verifyEnvelope()`/`openUpdate()` in `envelope.js`).
- **`atomic-encrypted` fields** are ciphertext at the value level — even
  inside your own local Y.Doc, `contentMap.get('title')` is never plaintext.
  `field.get()` decrypts locally; a non-recipient's `get()` returns
  `undefined`.
- **`text` fields** are encrypted one layer out, at the envelope, because
  the CRDT merge algorithm needs the plaintext ops locally to work at all —
  plaintext exists only in the RAM of an actively-editing, authorized peer,
  exactly like every other end-to-end-encrypted collaborative editor. The
  relay and any storage never see it.
- **ACL in this PoC is space-wide, not per-Kind or per-field**: `members`
  is one flat list, and any member may write any Node any Kind-Schema
  declares (`kind-schema.js`'s `acl` field is defined but not yet
  consulted by the relay/write-path — see §6).

## 4. Real network: WebSocket transport + relay

Swap `InProcessTransport`/`createInProcessHub` for `WsClientTransport` on
the peer side and a real relay process on the server side — nothing else in
your code changes (`Space`, `Node`, `Field` are transport-agnostic).

```js
import WebSocket from 'ws'; // or omit WebSocketImpl entirely in a browser - it has a native WebSocket
import { WsClientTransport } from '@qu/space-transport';

const transport = new WsClientTransport('ws://your-relay-host:8081', { WebSocketImpl: WebSocket });
await transport.connect();
const space = new Space({ identity: alice, members, transport });
```

### Running the relay yourself

```sh
cd packages/space-transport
SPACE_MEMBERS_JSON='[{"pub":"<base64>","xPub":"<base64>"},{"pub":"<base64>","xPub":"<base64>"}]' \
SPACE_RELAY_PORT=8081 \
SPACE_RELAY_DATA_DIR=./relay-data \
node src/relay-server.js
```

Generate the base64 keys for `SPACE_MEMBERS_JSON` like this:

```js
import { QuCrypto } from '@qu/core';
const kp = await QuCrypto.generateKeypair();
console.log(JSON.stringify({ pub: QuCrypto.toBase64(kp.publicKey), xPub: QuCrypto.toBase64(kp.xPublicKey) }));
// SAVE kp.privateKey and kp.xPrivateKey somewhere safe for the peer that owns this identity - never send them anywhere.
```

`GET /healthz` returns `200 ok` once the relay is listening.

## 5. Docker deployment

```sh
# From the repo root:
docker build -f packages/space-transport/Dockerfile -t qu-space-relay .
docker run -d -p 8081:8081 \
  -e SPACE_MEMBERS_JSON='[{"pub":"...","xPub":"..."}, {"pub":"...","xPub":"..."}]' \
  -v qu-space-relay-data:/data \
  qu-space-relay
```

Or via the provided compose file:

```sh
export SPACE_MEMBERS_JSON='[{"pub":"...","xPub":"..."}, {"pub":"...","xPub":"..."}]'
docker compose -f docker-compose.space-relay.yml up -d
```

`SPACE_RELAY_DATA_DIR` (default `/data`, backed by the `qu-space-relay-data`
volume in the compose file) is where the relay mirrors every envelope it
forwards — this is what makes offline-sender catch-up work (see §6). Set it
to an empty string to run a pure live-only relay instead (no mirroring, no
catch-up for peers that weren't connected at write time — see
`packages/space-transport/test/mirror-offline.test.js`'s second test for
exactly what that trades away).

**Not build-tested in this environment** (no Docker daemon available while
writing this) — the Dockerfile mirrors the repo-root Dockerfile's
already-working multi-stage/entrypoint/healthcheck pattern closely, and
`relay-server.js` itself is proven end-to-end against a real socket + real
on-disk file store (`mirror-offline.test.js`'s third test literally
restarts a relay process against the same data directory), but building the
actual image is worth doing once before relying on it in production.

## 6. Why the relay matters: offline-sender catch-up

The relay isn't just a pipe — it's a Space member's peer with its own
mirror. Concretely: Client A writes while B isn't connected. A goes fully
offline. B connects later and calls `subscribeNode()`. B still gets A's
data, because the relay mirrored every envelope it forwarded and answers
B's (signed) subscribe request by replaying that mirror.

```
Client A  --write-->  Relay (mirrors to disk)  --live-->  (nobody, B isn't online yet)
                              |
                       A goes offline
                              |
Client B  --subscribe('note-1')-->  Relay  --replay from mirror-->  Client B
```

Proven end-to-end (real WebSocket, real disk, relay process actually
restarted between the two halves) in
`packages/space-transport/test/mirror-offline.test.js`.

## 7. Known gaps (honest, not hidden)

- **No auto-reconnect** in `WsClientTransport` — a dropped connection stays
  dropped; reconnect logic (with backoff) is real, separate work.
- **ACL is space-wide, not per-Kind/per-field** — every member can write
  every Node of every Kind. `kind-schema.js`'s `acl` field exists but the
  relay/write-path doesn't consult it yet.
- **No file compaction** — `createFileStore()` is a pure append-only log per
  Node; a very long-lived, heavily-edited Node's file only grows. Yjs
  itself garbage-collects deleted content from an in-memory `Y.Doc`, but
  that doesn't shrink an already-written append log — periodic
  snapshotting/compaction is real, separate work.
- **No relay clustering/HA** — one relay process, one data directory. A
  multi-relay federation (or even just a hot standby) is not built.
- **No member/key rotation** — `SPACE_MEMBERS_JSON` is fixed at relay
  startup; adding/removing a member means restarting the relay with a new
  list. Live membership changes are real, separate work.
- **`@qu/space-ui`** (declarative `<qu-view>`/`<qu-bind>`/`<qu-list>`/
  `<qu-text>`-style components) is not built yet — core sync/signing/
  encryption was sequenced first, UI bindings are real, separate work.
- **No app/UI beyond the demo** — `demo/` is a minimal CLI proving the
  sync mechanism (see `demo/README.md`); nothing app-shaped is built yet.

## 8. Where to look for more

Every claim above is backed by a runnable test, not just a comment:

- `packages/space-core/test/` — envelope signing/verification, field
  encryption behavior, CRDT convergence for text and list fields.
- `packages/space-transport/test/poc-demo.test.js` — the original
  end-to-end proof (in-process transport).
- `packages/space-transport/test/ws-relay.test.js` — the same, over a real
  WebSocket port.
- `packages/space-transport/test/mirror-offline.test.js` — the
  offline-sender/mirror-storage scenario, including a real relay-process
  restart against real disk.
- `packages/space-storage/test/file-store.test.js` — real on-disk
  persistence, including the "fresh instance sees what a prior instance
  wrote" restart simulation.

Run any of them with `node --test <path>` from the relevant package
directory, or `npm test` from the repo root to run everything.

## 9. Try it yourself: the text-exchange demo

`demo/` is a small, runnable proof that two independent processes can
exchange collaboratively-edited text over a real relay, each side
identified by its Qu public-key fingerprint (`QuCrypto.fingerprint()`,
see `packages/core/src/crypto.js`) rather than a raw key or a username:

```sh
npm run demo            # zero-setup: one process, two simulated peers
npm run demo:relay      # real relay, terminal 1
npm run demo:alice      # real client "alice", terminal 2
npm run demo:bob        # real client "bob", terminal 3 - type in either, watch it appear in the other
```

See `demo/README.md` for what each command does and how identity/
membership works for the demo.
