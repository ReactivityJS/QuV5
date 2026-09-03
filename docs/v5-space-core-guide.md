# Qu V5: Space/Node/Field API + Relay Deployment Guide

This is the practical companion to the packages themselves (see
`packages/space-core/`, `packages/space-storage/`, `packages/space-transport/`,
and the optional `packages/space-plugins/`/`packages/space-ui/` for the doc
comments this guide points at). It covers:

1. How to use the `@qu/space-core` API to model and sync data — including
   ACL modes, the local-first lazy query API, alias identities, and
   compaction.
2. How to run a relay that lets real, separate peer processes exchange
   data — including via Docker, and federated with other relays.
3. Reconnect/resync, per-Kind persistence tiers (what presence/typing are
   built on), and the optional `@qu/space-plugins`/`@qu/space-ui` add-ons
   (§15-17).
4. Two runnable demos — a CLI/browser chat, and an in-process script that
   exercises every mechanism below in one command (see `demo/README.md`).

If you haven't read the packages' own source doc comments, do that first for
the *why*; this guide is the *how*. See `architecture.md` at the repo root
for the bird's-eye map of files/concepts/API surface — **update that file
whenever this guide's own claims change**, and vice versa.

## 1. Core concepts, in one paragraph each

- **Identity**: an Ed25519 (signing) + X25519 (encryption) keypair, from
  `QuCrypto.generateKeypair()` (`@qu/core`). Every peer has one:
  `{signingKey, signingPub, xPrivateKey, xPublicKey}`.
- **Kind-Schema** (`defineKind()`): a static description of a Node's shape.
  Each field declares TWO independent properties — `shape` (`'atomic'` |
  `'text'` | `'list'`, the LOCAL CRDT structure) and `visibility`
  (`'encrypted'` default, or `'public'` — which envelope mode a write to
  that field seals with). `acl.write` names who may sign updates:
  `'members'` (any current Space member, the default), `'owner'`
  (self-certifying — only the pubkey the Node's own id cryptographically
  commits to), or `'named'` (the owner plus anyone they've explicitly
  authorized via a signed `grant`). See §3.
- **Space**: one peer's live view of a set of Nodes, wired to one Transport
  and (optionally) one Storage adapter. No `get(path)`/`put(path, val)` —
  you work with typed Node/Field handles directly.
- **Node**: one Y.Doc. `space.createNode(kind, fields)` makes one;
  `space.subscribeNode(id, kind)` registers interest in one another peer
  created; `space.useNode(id, kind)` (§5) is the recommended default —
  local-first, lazy, reference-counted.
- **Field**: `node.field(name)` — typed accessor
  (`.get()`/`.set()`/`.observe()` for atomic, `.ytext`/`.insert()`/
  `.delete()`/`.observe()` for text, `.push()`/`.toArray()`/`.observe()`
  for lists).
- **Transport**: how bytes move between peers. `InProcessTransport` (same
  process, for tests) or `WsClientTransport` (a real WebSocket connection to
  a relay, browser or Node).
- **Relay**: `createRelayForwarder()` — verifies write signatures, forwards
  live to a Node's actual SUBSCRIBERS (never a blind broadcast, see §6),
  and (given a storage adapter) mirrors everything it forwards. It is never
  given a decryption key, so it structurally cannot read content.
- **Reconnect** is automatic (`WsClientTransport`) and **resync** follows
  from it (`Space` re-subscribes on reconnect) — see §15. **Persistence is
  per-Kind**, not just per-Space (`persistence: 'durable'|'volatile'` in
  `defineKind()`) — see §16, which is also how presence/typing/read-status
  work with zero relay/transport special-casing.

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

// 2. Every peer allowed to read/write an 'acl.write: members' Kind, by public key.
const members = [
  { pub: alice.signingPub, xPub: alice.xPublicKey },
  { pub: bob.signingPub, xPub: bob.xPublicKey },
];

// 3. Define what a "note" looks like - shape (local CRDT structure) and
//    visibility (envelope mode) are independent per field.
const noteKind = defineKind('note', {
  fields: {
    title: { shape: 'atomic' }, // visibility defaults to 'encrypted'
    body: { shape: 'text' },
  },
});

// 4. Wire up a relay + two peer transports (in-process here; see §4 for real network).
const hub = createInProcessHub();
createRelayForwarder({ hub, members, resolveKindSchema: () => noteKind });
const aliceTransport = new InProcessTransport(hub, 'alice');
const bobTransport = new InProcessTransport(hub, 'bob');
await aliceTransport.connect();
await bobTransport.connect();

const aliceSpace = new Space({ identity: alice, members, transport: aliceTransport });
const bobSpace = new Space({ identity: bob, members, transport: bobTransport });

// 5. Bob subscribes BEFORE alice writes - a relay only forwards a write to
//    a Node's actual subscribers (see §6), so this ordering matters when
//    there's no storage adapter for catch-up.
const bobNote = bobSpace.subscribeNode('note-1', noteKind);

// 6. Alice creates the Node...
const note = await aliceSpace.createNode(noteKind, { title: 'Einkaufsliste' }, { id: 'note-1' });
note.field('body').insert(0, 'Milch, Brot');

// ...and bob converges once sync catches up.
// (real code awaits/observes; see packages/space-transport/test/poc-demo.test.js
//  for a full worked example, including waiting for delivery)
```

### Reading and writing fields

```js
// atomic
await note.field('title').set('Neuer Titel');
const title = await note.field('title').get(); // null = unset, undefined = you're not a recipient (encrypted only), string = value
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

To reload a Node from storage after a restart (no live sync, pure local read):

```js
const reloaded = await space.loadNode('note-1', noteKind);
```

Or, for the common case of "give me this Node, local-first, and keep it
live if I still need it" — see §5.

## 3. Signing, encryption, ACL — what's actually enforced

- **Every Yjs update is signed** before it ever reaches storage or a
  transport, and verified before being applied (`sealUpdate()`/
  `sealPublicUpdate()`/`verifyEnvelope()`/`openUpdate()` in `envelope.js`).
- **Envelope has two modes**, chosen per-field by `visibility`:
  `'encrypted'` (`sealUpdate()` — AES-GCM content key wrapped per
  recipient via X25519 ECDH) or `'public'` (`sealPublicUpdate()` — the
  raw update travels as plaintext, signed directly, no encryption at any
  layer). Signature covers exactly the transported bytes either way.
- **`'atomic'`+`'encrypted'` fields** are ciphertext at the value level —
  even inside your own local Y.Doc, `contentMap.get('title')` is never
  plaintext. `field.get()` decrypts locally; a non-recipient's `get()`
  returns `undefined`.
- **`'text'`+`'encrypted'` fields** are encrypted one layer out, at the
  envelope, because the CRDT merge algorithm needs the plaintext ops
  locally to work at all — plaintext exists only in the RAM of an
  actively-editing, authorized peer, exactly like every other
  end-to-end-encrypted collaborative editor.
- **`visibility: 'public'`** exists for content that must be discoverable
  by someone with no prior relationship to the writer — a `'owner'`-ACL
  identity Node's `pub`/`epub` fields being the canonical case (§7). No
  encryption at any layer; anyone, relay included, can read and verify it.
- **`acl.write` has FOUR modes**, all enforced by BOTH the relay and every
  receiving `Space` (same check, `_isAuthorizedWriter()`/`buildWriteAcl()`):
  - `'members'` (default) — any current Space member.
  - `'owner'` — self-certifying: `nodeId = "~" + base64url(sha256(kind +
    ":" + base64(ownerPub)))` (`deriveOwnerNodeId()`, kind-schema.js).
    Verifying a write is a PURE FUNCTION of `(nodeId, envelope.pub)` — zero
    relay/Space bootstrap state, and the owner never needs to be
    registered as a flat "member" anywhere. `createNode()` auto-derives
    this id; any explicit `{id}` you pass is ignored for this mode.
    ONE Node per owner per Kind.
  - `'named'` — the owner plus anyone they've authorized via a signed
    `grant` message: `await space.grantWriter(nodeId, kind, granteePub)`.
    State is 100% derived from verified grants, never invented. **Grant
    BEFORE the grantee's first write attempt, not in response to one** —
    see `grant.js`'s own doc comment on why a premature, rejected write
    permanently poisons that writer's local Y.Doc for any peer who
    rejected it (a real Yjs property: per-author updates integrate in
    strict order, so a peer that ever rejects one can never integrate a
    LATER one from the same doc either).
  - `'content'` — `'named'`'s MANY-per-owner counterpart: `nodeId =
    "~content:" + base64url(sha256(kind + ":" + base64(ownerPub) + ":" +
    path))` (`deriveContentNodeId()`, kind-schema.js) — a route, a
    template name, an event id, anything stable identifies `path`. Pass
    `{path}` (not `{id}`) to `createNode()` for this mode — it derives the
    id AND issues the creating identity a TRANSPARENT self-grant itself,
    before attaching/writing anything, so ordinary content-creation code
    never has to call `grantWriter()` for its own writes (only to extend
    access to someone ELSE: `space.grantWriter(nodeId, kind, granteePub,
    {path})` — same call as `'named'`, just with `path`). No owner-pubkey
    shortcut in the write-ACL check exists (an id alone can't be inverted
    back to `path`), so EVERY reader — including one reading the
    ORIGINAL owner's own writes — needs to have actually seen a `grant`;
    a relay durably replays past grants to a newly-subscribing peer for
    exactly this reason (`relay.js`'s `grantStorageKey()`, a separate
    storage key from the Node's own envelope log so compaction never
    wipes it). This is `@qu/app-core`'s `qu-page`/`qu-template`/`qu-style`
    - genuine per-owner content on a Relay hosting several independently-
    owned apps, not "any Space member may write any page."

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

Wire efficiency: every message is base64-encoded for its binary fields
(never a JSON array of per-byte integers — `@qu/space-core`'s
`encodeForWire()`/`decodeFromWire()`), and a real relay should be built
with `perMessageDeflate: true` (see below) — the client side already
offers WebSocket compression by default.

### Running the relay yourself

```sh
cd packages/space-transport
QU_RELAY_PORT=8081 \
QU_RELAY_DATA_DIR=./relay-data \
node src/relay-server.js
```

That's it — **`QU_MEMBERS_JSON` is optional**, not required. It only
gates `'members'`-mode ACL Kinds (a genuine access-control decision only
an operator can make — the relay has no way to invent an answer to "who's
authorized" on its own); `'owner'`/`'named'`-ACL Kinds (§3) are
self-certifying and work from the very first boot with zero membership
configuration. If/when you do have `'members'`-mode Kinds, set it to a
JSON array:

```sh
QU_MEMBERS_JSON='[{"pub":"<base64>","xPub":"<base64>"},{"pub":"<base64>","xPub":"<base64>"}]' \
node src/relay-server.js
```

Generate the base64 keys for `QU_MEMBERS_JSON` like this:

```js
import { QuCrypto } from '@qu/core';
const kp = await QuCrypto.generateKeypair();
console.log(JSON.stringify({ pub: QuCrypto.toBase64(kp.publicKey), xPub: QuCrypto.toBase64(kp.xPublicKey) }));
// SAVE kp.privateKey and kp.xPrivateKey somewhere safe for the peer that owns this identity - never send them anywhere.
```

**The relay's own identity** (only needed to federate with another relay,
see §9) is a completely separate thing from `QU_MEMBERS_JSON` above — it's
not a decision anyone has to make, just a keypair that needs to exist and
stay stable. `relay-server.js` auto-generates one on first boot and
persists it under `QU_RELAY_DATA_DIR/relay-identity.json` (override with
`QU_RELAY_IDENTITY_FILE`) — there is no manual keygen-then-paste step, and
no chicken-and-egg problem to solve yourself. To read it (creating it
first if it doesn't exist yet) without starting the WebSocket server —
e.g. to hand this relay's pubkey to another relay/app that needs to
recognize it:

```sh
node src/relay-server.js --print-identity
```

```json
{ "fingerprint": "7d15-5e40-5510-35a5", "pub": "...", "xPub": "..." }
```

To federate with an upstream relay (§9), set `QU_FEDERATE_UPSTREAM_URL` to
its `ws://`/`wss://` address — the relay becomes a subscribing peer of it
automatically, using this same identity.

`GET /healthz` returns `200 ok` once the relay is listening. `relay-server.js`
constructs its `WebSocketServer` with `perMessageDeflate: true` already —
if you build your own relay process, do the same (`ws`'s client side offers
the extension by default, but a server must also opt in for it to
negotiate). `relay-server.js` itself has NO Kind-Schema registry
(`resolveKindSchema: () => true`) — it forwards/mirrors any Node id gated
only by flat `members` ACL, which means it can only ever enforce
`'members'`-mode write-ACL, never `'owner'`/`'named'` (those need the real
Kind-Schema — specifically its `kind` string — to verify at all). Run
`createRelayForwarder()` directly with a real `resolveKindSchema` (routing
by nodeId, e.g. by the `~` prefix — see `demo/auto-demo.mjs`) to get
`'owner'`/`'named'` enforcement.

## 5. The local-first, lazy query API

`Space.useNode(id, kindSchema)` is the recommended default entrypoint for
app/UI code that just wants "give me this Node" — matching the framework's
own design commitment: keep what you need locally, subscribe/sync remotely
only for what's actually asked for, and only once it's asked for.

```js
const { node, release } = await space.useNode('note-1', noteKind);
// node is usable immediately - hydrated from LOCAL storage first (if any
// is mounted, zero network), then a live `subscribe` request is sent
// regardless (a synced Node is presumed still-changing).

release(); // reference-counted: the Node stays subscribed until every
           // useNode() caller for this id has released it. The LAST
           // release() drops the local handle entirely and tells the
           // relay to stop forwarding - a later useNode() call for the
           // same id starts completely fresh.
```

Calling `useNode()` twice for the same id is a plain, instant lookup (no
duplicate subscribe). This sits alongside the three lower-level
entrypoints — `createNode()` (originate a new Node), `subscribeNode()`
(known id, live sync, not reference-counted), `loadNode()` (local storage
only, zero network) — which `useNode()` itself is built from; use them
directly only when you have a specific reason to (e.g. `Space`'s own
internals, or a caller that deliberately wants non-refcounted semantics).

## 6. Subscriber-tracking: a relay forwards ONLY to who asked

A relay tracks exactly which connections have sent a signed `subscribe`
request for each Node id (`nodeId -> Set<peerId>`) and forwards a write
ONLY to that set — never to "every connected peer" or "every space
member," regardless of ACL mode. Being a fully authorized member/owner of
a Node is not enough to receive live updates about it; only an actual
`subscribe` request (sent automatically by `subscribeNode()`/`useNode()`,
and by `createNode()` on the creator's own behalf so they remain a live
target for others' later authorized writes) is. This is the actual
traffic-shaping mechanism behind "subscriptions restrict data and
traffic" — the same rule a relay already applies to its own clients
applies one hop further to relay-to-relay federation (§9).

A relay with a `storage` adapter additionally answers a NEW subscriber's
request by replaying its full mirrored history for that Node — this is
what makes offline-sender catch-up work even when the original author has
long since disconnected:

```
Client A  --write-->  Relay (mirrors to disk)  --live-->  (nobody, B isn't online yet)
                              |
                       A goes offline
                              |
Client B  --subscribe('note-1')-->  Relay  --replay from mirror-->  Client B
```

Proven end-to-end (real WebSocket, real disk, relay process actually
restarted between the two halves) in
`packages/space-transport/test/mirror-offline.test.js`. Without a storage
adapter, a relay is pure live-only: a subscriber that wasn't connected at
write time gets nothing for that write, ever (`mirror-offline.test.js`'s
second test documents exactly this tradeoff).

`Space.unsubscribeNode(id)` is the exact inverse — tells the relay to stop
forwarding and drops the local Node handle (a later `subscribeNode()`/
`useNode()` call starts completely fresh).

## 7. Space-scoped alias identities (per-space pseudonymity)

`deriveAliasIdentity(identity, spaceId)` (`@qu/space-core`'s `alias.js`)
deterministically derives a completely independent Ed25519+X25519
keypair from a real identity's own private key and a `spaceId` string —
same inputs always yield the same alias; a different `spaceId` yields a
computationally unrelated one.

An alias is a REAL, fully independent identity for every purpose the
framework already has — in particular, it can own `acl.write: 'owner'`
Nodes with zero relay-side awareness that anything alias-shaped is
happening (self-certifying, see §3). This is deliberately why aliases are
scoped to `'owner'`/`'named'` Kinds, not `'members'`-mode ones, which
would need new relay-side plumbing to extend a flat membership list
per-alias.

Resolving alias → real identity is published as an ordinary ENCRYPTED
Node write (`aliasRegistryKind`, `'members'`-mode ACL, both fields
`visibility: 'encrypted'`) — the exact same envelope encryption every
other confidential field already uses, sealed for the Space's current
members:

```js
import { publishAlias, aliasRegistryNodeId, AliasRegistry } from '@qu/space-core';

const alias = await publishAlias(aliceSpace, 'my-space-id'); // writes the registry entry, returns the alias identity
const aliasSpace = new Space({ identity: alias, members: [], transport: aliasTransport });
const post = await aliasSpace.createNode(postKind, {}); // acl.write:'owner' - pseudonymous, self-certifying

// A space member who subscribes to alice's registry Node can resolve it:
const registry = new AliasRegistry(bobSpace, bobBus); // watches bobSpace's bus, no changes to Space itself
bobSpace.subscribeNode(aliasRegistryNodeId(alice.signingPub), aliasRegistryKind);
registry.resolve(aliasPubB64); // -> alice's real pubkey, once resolved; undefined until then
```

An outsider (never subscribed to that registry entry, or not a
decryption recipient — the relay always) sees only sealed ciphertext,
structurally unable to open it — not being able to resolve an alias is
indistinguishable from "not a Space member," by design.

## 8. Snapshot/compaction: real storage GC purge

Yjs already garbage-collects a deleted item's content from a live
`Y.Doc`'s own memory automatically (`gc: true` is the default for every
`Y.Doc` in this codebase) — but every sealed envelope that ever carried
that content remained sitting in storage/a relay's mirror forever, since
nothing pruned or re-derived that log from the current state. That was
the real, previously-documented gap in this framework's deletion story.

`Space.compactNode(id)` closes it:

```js
await space.compactNode('note-1');
```

This replaces the Node's ENTIRE stored envelope history — this Space's
own storage, and (once the resulting envelope propagates) every other
subscriber's storage and the relay's own mirror — with ONE envelope
holding the Node's current, garbage-collected state. It is NOT a new
envelope shape: a snapshot is sealed with the exact same `sealUpdate()`/
`sealPublicUpdate()` as any other write (a Yjs full-state encoding
instead of one incremental update, plus one extra signed `snapshot: true`
bit) — `Y.applyUpdate()` neither knows nor cares whether an update is
incremental or full-state, so receivers integrate it exactly as before.
A storage adapter's new `replace(nodeId, envelopes)` method (all three
`@qu/space-storage` adapters have it) is what actually discards the old
log.

Authorization needs no new mechanism — a snapshot is verified through the
exact same ACL check as any other write, so whoever may already write to
a Node may also compact it. Only supported for a Kind whose meta AND
every field share the SAME `visibility` (a single envelope can't
represent a Node whose fields disagree) — note a `'members'`-mode Kind's
meta is ALWAYS `'encrypted'` regardless of any field's own visibility, so
such a Kind can only be compacted whole if every field is too.

## 9. Relay federation: relay-as-subscribing-peer

A relay federates with another (upstream) relay by being an ordinary
SUBSCRIBING PEER to it — the same `hello`/`subscribe` control messages any
`Space` client already sends, over an ordinary Transport connection. No
new relay-to-relay wire protocol.

```js
import { federateRelay } from '@qu/space-transport';

const downstreamRelay = createRelayForwarder({ hub: hubB, members, resolveKindSchema, storage, bus });
const linkToUpstream = new InProcessTransport(hubA, 'relay-b-link'); // or WsClientTransport for a real network
await linkToUpstream.connect();
federateRelay({ relay: downstreamRelay, bus, transport: linkToUpstream, identity: relayIdentity });
```

Demand-driven, matching §6's own rule applied one hop further: nothing
crosses the link until a REAL local peer on the downstream relay actually
subscribes to a Node the downstream relay doesn't already have — that
event automatically triggers exactly one upstream subscribe for that
nodeId. Bidirectional once federated: a local write to a federated Node is
also forwarded upstream, so peers on either side see each other's writes.
An upstream relay is trusted no more than a single ordinary local peer —
every envelope it sends down is independently re-verified against the
real write-ACL before anything happens with it.

## 10. Docker deployment

This section covers `@qu/space-transport`'s own hardcoded chat-demo relay -
via Compose, now the opt-in `legacy-chat` profile (add `--profile
legacy-chat` to every `docker compose` command below). **For the DEFAULT
relay** - `@qu/app-shell` in PLATFORM mode, an Admin-UI, and CMS-managed
shell-apps - see this section's own "App Shell deployment" subsection
right after it; `docker compose up` alone now starts THAT one.

```sh
# From the repo root:
docker build -f packages/space-transport/Dockerfile -t qu-space-relay .

# Or directly from GitHub, no local clone needed - context is the WHOLE
# repo at that ref, -f just points at the Dockerfile within it:
docker build -f packages/space-transport/Dockerfile -t qu-space-relay \
  https://github.com/ReactivityJS/QuV5.git#main

docker run -d -p 8083:8081 \
  -v qu-space-relay-data:/data \
  qu-space-relay
```

**Do NOT** use Docker's git `#ref:subdir` context shortcut here (e.g.
`...QuV5.git#main:packages/space-transport/`) — that makes
`packages/space-transport/` itself the entire build context, so every
repo-root-relative path in the Dockerfile breaks, AND npm workspaces can
no longer resolve `@qu/core`/`@qu/space-core`/`@qu/space-storage` as local
sibling packages (they aren't published to the npm registry). This is
inherent to building a workspace-dependent package out of a monorepo, not
a path bug fixable in the Dockerfile — the repo root must always be the
build context; `-f` is what selects this particular Dockerfile within it.

That's a complete, runnable relay — no `QU_MEMBERS_JSON` required (see §4
on why: it's optional, only gates `'members'`-mode Kinds, and the relay's
own identity for federation is auto-generated/persisted under `/data`, not
something you provide). Open `http://localhost:8083/` and you'll see a
browser app: `relay-server.js` also serves one on this same port (today,
the same `demo/web/` chat client `npm run demo:legacy-chat-relay` serves -
bundled at Docker BUILD TIME, not on every boot - see the Dockerfile).
`POST /join` lets anyone reaching the port join as a new `'members'`-mode
member with no authentication beyond well-formed keys - a deliberate
current default ("this image should be immediately usable"), turned off
with `QU_ALLOW_JOIN=false` once you want membership fixed to
`QU_MEMBERS_JSON` only. Add `QU_MEMBERS_JSON` when you also have your own
`'members'`-mode Kinds beyond the demo:

```sh
docker run -d -p 8083:8081 \
  -e QU_MEMBERS_JSON='[{"pub":"...","xPub":"..."}, {"pub":"...","xPub":"..."}]' \
  -v qu-space-relay-data:/data \
  qu-space-relay
```

To read this relay's own identity (e.g. to register it as a member/
federation peer elsewhere) without starting the WebSocket server:

```sh
docker run --rm -v qu-space-relay-data:/data qu-space-relay \
  node packages/space-transport/src/relay-server.js --print-identity
```

Or via the provided compose file:

```sh
docker compose -f docker-compose.space-relay.yml --profile legacy-chat up -d
# with members, federation, and/or locking down joining:
export QU_LEGACY_CHAT_MEMBERS_JSON='[{"pub":"...","xPub":"..."}, {"pub":"...","xPub":"..."}]'
export QU_FEDERATE_UPSTREAM_URL='ws://another-relay-host:8081'
export QU_LEGACY_CHAT_ALLOW_JOIN=false
docker compose -f docker-compose.space-relay.yml --profile legacy-chat up -d
```

`QU_RELAY_DATA_DIR` (default `/data`, backed by the `qu-space-relay-data`
volume in the compose file) is where the relay mirrors every envelope it
forwards — this is what makes offline-sender catch-up work (§6) — AND
where its own identity file persists across restarts/redeploys. Set it
to an empty string to run a pure live-only relay instead (its identity
then becomes ephemeral too — a new one every restart, logged loudly).

### App Shell deployment (the DEFAULT relay/image)

`@qu/app-shell` — a generic app (or, in PLATFORM mode, several) defined
entirely by Qu content, see `architecture.md` §7 and
`docs/app-shell-arbeitsauftrag.md` — is now the DEFAULT service
`docker compose -f docker-compose.space-relay.yml up -d` starts, built from
`packages/app-shell/Dockerfile` — a SEPARATE image/Space from the hardcoded
chat demo further up in this section (which moved to an opt-in
`legacy-chat` profile, `--profile legacy-chat`, so add that flag to every
`docker compose` command above if you want IT instead/as well — same
"Relay bleibt Application-blind" reasoning, `relay-server.js`'s own doc
comment, keeps the framework layer from ever depending on an
application-layer package).

**Fastest path to something actually running** — the built-in admin
console AND one CMS-managed demo shell-app, both real content, the same
two steps regardless of how you deploy (Compose, `docker stack`,
Kubernetes, bare metal):

```sh
docker compose -f docker-compose.space-relay.yml up -d   # starts the (now default) app-shell relay
npm run bootstrap:platform                                # run from ANYWHERE with network access to it
```

`bootstrap:platform` (`packages/app-shell/bin/bootstrap-platform.mjs`)
never writes your deployment's config for you and makes no assumption
about how you deploy — no `.env` file, no container filesystem, no
`docker exec`/`docker compose` awareness at all, on purpose (env vars are
read once at relay BOOT time — see `relay-server.js`'s own doc comment —
so however that config reaches your relay and gets it recreated with it
is entirely up to you). It generates a `relay-admin` and a
`demo-app-admin` identity locally (once, reused on every later run), then:

- relay not yet configured → **prints the exact `QU_RELAY_ADMINS` value**
  (the ONE static list a platform deployment needs — `demo-app-admin`
  needs no separate config at all, `registerApp()` alone makes it
  discoverable live) — paste it into `docker-compose.space-relay.yml` (or
  your own `docker stack`/Kubernetes/systemd config) yourself, redeploy,
  then run the exact same command again;
- relay already configured with them (this second run, or any later one)
  → installs the admin console, creates a demo shell-app with its own CMS
  editor installed, registers both `#/admin` and `#/demo`, and prints the
  exact URLs plus ready-to-paste browser devtools snippets so you can
  actually act as either identity.

Two runs on a first-ever setup is expected, not a bug — see the script's
own top doc comment for the full "why" (in short: it can only tell your
paste took effect by attempting a real write and seeing whether the relay
acks it, since there's no other way to observe another process's env
vars). Safe to re-run any time afterward too — every step checks first,
never re-creates content that already exists (see its own doc comment on
why that matters for `Y.Text` fields specifically).

**Docker Swarm / `docker stack deploy`:** Swarm doesn't build images —
build and tag the image yourself first, then deploy with the SAME compose
file:

```sh
docker build -f packages/app-shell/Dockerfile -t qu-app-shell-relay:latest .
docker stack deploy -c docker-compose.space-relay.yml <your-stack-name>
```

`profiles:` (gating the legacy chat relay behind `legacy-chat`) is a
Compose-only concept Swarm ignores — that service deploys too under
`docker stack deploy`, unconditionally (harmless, just an idle service on
a different port — remove its block from your own copy of the file if you
don't want it running at all).

**Before running it, `/` and `#/admin` both show "Noch keine Anwendung
auf dieser Plattform installiert"** — expected, not broken: `docker
compose up` alone only starts an EMPTY platform. `#/admin` is an ORDINARY
registered alias (architecture.md §7 — nothing about the route string is
special-cased), not a route the Shell hardcodes — until something has
registered it AND installed the console's own content, it resolves to
nothing and falls through to the same generic landing page as any other
unmatched route. `bootstrap:platform` above is exactly that "something."

**The Admin-UI (`#/admin`) and a CMS editor (`#/<prefix>/cms`) are
different things at different levels, and there is no single global one
covering everything** — `#/admin` (one per platform, the relay-admin's
own realm) only registers apps under path prefixes, it has no content
editor of its own; a CMS editor (architecture.md §7's "The built-in CMS
editor") is installed PER APP, into that app's OWN Space
(`installCms(space)`, `@qu/app-shell`'s `cms-bundle.js`) — `bootstrap:
platform` installs one for its own demo app (`#/demo/cms`) automatically;
for your own app, call `installCms()` the same way from your own install
script. Editing `#/admin`'s own content still needs
`bin/install-admin-console.mjs` — no CMS editor for it yet (its Kinds
have no `edit*()` counterparts, see architecture.md §7's own note on
this gap).

The rest of this subsection is the equivalent BY-HAND walkthrough — useful
for a real deployment where you want full control over each identity/step
rather than the one-shot script above.

It starts fine with no configuration — `http://localhost:8081/` (or
whatever port you mapped) serves a plain setup page instead of an app/
platform until you configure `QU_APP_ADMIN_PUB` (a base64 Ed25519 PUBLIC
key only — see `relay-server.js`'s own "ADMIN IDENTITY" doc comment; this
relay never holds, needs, or is sent the app-admin's private key) for a
SINGLE fixed app:

```sh
docker run -d -p 8081:8081 \
  -e QU_APP_ADMIN_PUB='<base64 pubkey>' \
  -e QU_MEMBERS_JSON='[{"pub":"<same as QU_APP_ADMIN_PUB>","xPub":"<its X25519 pubkey>"}]' \
  -v qu-app-shell-relay-data:/data \
  qu-app-shell-relay
```

Once running, seed (or edit) its content from a SEPARATE process that holds
the app-admin's actual private key — `demo/install-app-shell-demo.mjs` is
the reference implementation, and works unmodified against a real
deployment:

```sh
node demo/install-app-shell-demo.mjs --relay wss://your-host --dir /path/to/your/app-admin-identity
```

For everyday content maintenance AFTER that initial seed — adding/editing
templates, styles, and pages — an app-admin doesn't need to re-run an
installer script at all: `@qu/app-core`'s `installCms()`
(`packages/app-shell/cms-bundle.js`) writes a small in-browser CMS editor
into the app's OWN Space once (`installCms(space)`, same identity as
above), then `https://your-host/#/cms` (open as that SAME identity) lists
existing templates/styles/pages and lets you create or edit them straight
from the browser — see architecture.md §7's "The built-in CMS editor" for
how it's wired.

**PLATFORM mode (several apps, one relay, a confidential admin realm,
NOW THE DEFAULT)** — `bootstrap:platform` above already does everything
below in one command; read on if you want to do it by hand or understand
what it's actually doing. Instead of one fixed `QU_APP_ADMIN_PUB`, set
`QU_RELAY_ADMINS` (takes priority when both are set) — see
architecture.md §7's "The Platform layer" for the full model, and
`@qu/space-core`'s kind-schema.js own doc comment for the `'relay-admins'`
ACL mode this rests on. `QU_RELAY_ADMINS` is a JSON array of `{pub, xPub}`
(base64) — every relay-admin identity, all equally and symmetrically (no
single "owner"), authorized to (a) write `qu-platform-apps` (register/
manage apps under path prefixes) and (b) read/write the confidential admin
realm's own content. This is the ONE static list PLATFORM mode needs — an
ORDINARY app-admin needs NO separate static entry any more: any configured
relay-admin simply `registerApp()`s their pubkey, and this relay discovers
them live (`@qu/app-shell`'s own `live-app-resolver.js`), no restart:

```sh
docker run -d -p 8081:8081 \
  -e QU_RELAY_ADMINS='[{"pub":"<base64 relay-admin pubkey>","xPub":"<base64 relay-admin xPub>"}]' \
  -v qu-app-shell-relay-data:/data \
  qu-app-shell-relay
```

Bootstrap the built-in admin console ONCE (a real, separate process, run by
whoever holds an identity listed in `QU_RELAY_ADMINS` above —
its private key never touches the relay):

```sh
node packages/app-shell/bin/install-admin-console.mjs \
  --relay wss://your-host --prefix admin --dir ./admin-identity
```

This installs the console's own content (a `qu-admin-app` manifest, a
template, one page with a "register an app" form) into the admin realm,
then registers the `"admin"` alias in the MAIN space — a completely
ordinary registry entry, not a special path the router hardcodes. From a
browser signed in as that SAME identity, open `https://your-host/#/admin`:
the console renders from installed content (not framework-built DOM), lists
already-registered apps, and lets that identity register a new one — the
app's own content still needs to be installed separately by whoever holds
that app-admin's private key, e.g. via `installAppBundle()` (`@qu/app-core`'s
Dev API) from your own script, the same way `demo/install-app-shell-demo.mjs`
seeds a single app today. A visitor who is NOT in
`QU_RELAY_ADMINS` sees only a plain "not found" at `#/admin` —
the admin realm's content is genuinely `'encrypted'`-visibility, sealed for
that member list alone, not merely hidden by the console's own UI.

## 11. Granular events: notifications, presence, push, and debugging

`@qu/events`'s `EventBus` is one dot-namespaced, wildcard-matching
(`*`/`**`) pub/sub primitive used on BOTH sides of a Space, fed different
information appropriate to what each side can see:

- **Client-side** (`new Space({..., bus})`): every applied update - local
  or remote - fires `space.node.<nodeId>.changed` (generic change feed,
  `{nodeId, kind, origin}`). A write that also carried a `notify` hint
  additionally fires `notification.<kind>.<topic>`. `space.member.joined`
  fires reactively when a relay's `addMember()` broadcast arrives (no
  polling). `space.status.changed` (`{status}`) mirrors the transport's own
  reconnect lifecycle (§15); `space.node.<nodeId>.write-ack` (`{nodeId,
  seq}`) fires when the relay confirms it durably mirrored a write (§16 -
  `@qu/space-plugins`' `awaitRelayAck()` is the usual way to consume this).
  A full `debug.space.*` family (write/subscribe/unsubscribe/
  hello/grant/load/compact lifecycle) is available for optional,
  zero-cost-when-unused logging — see `space.js`'s own doc comment for the
  complete list.
- **Relay-side** (`createRelayForwarder({..., bus})`): content-blind by
  construction (§3) - it can never compute "this is a mention" from
  ciphertext. So a WRITER who wants the relay to route a push notification
  attaches a small `notify: {topic, to?}` hint to the write itself
  (`field.set(value, {notify})` / `field.push(value, {notify})`), which
  travels UNENCRYPTED alongside the envelope - signed (tamper-evident
  against a third party), but not verifiable against real content.
  `notify.topic` must be declared in the Kind-Schema's `notifyTopics`. The
  relay emits one `relay.notify.<kind>.<topic>` event per recipient,
  carrying `online` (from its own `PresenceTracker`). A full
  `debug.relay.*` family covers write/subscribe/unsubscribe/hello/grant/
  presence lifecycle, and `relay.write.local` is the (non-debug) event
  `federateRelay()` (§9) listens on to decide what to forward upstream.

**Delivery channel is a handler's decision, not the bus's:**
`packages/space-transport/src/push-handler.js`'s `registerPushHandler(bus,
{sendPush})` is the reference example: it subscribes to `relay.notify.**`
and sends a push ONLY when `online` is false. A browser-notification or
in-app toast handler on the CLIENT side works the same way - subscribe to
`notification.**`, decide locally whether to actually show one. None of
that logic lives in `EventBus`, `Space`, or the relay themselves - see
`demo/auto-demo.mjs` for both sides wired up together in one runnable
script, and `demo/chat.mjs`/`demo/relay.mjs` for the same thing over a
real WebSocket relay.

## 12. Known gaps (honest, not hidden)

- **Reconnect is automatic, but liveness detection for a peer that just
  crashed/lost network is still best-effort** — `WsClientTransport`
  reconnects and `Space` resyncs (§15) fine for a peer's OWN connection,
  but ANOTHER peer's `presenceKind.online` (§16) can only ever be
  self-reported; nothing signs "I went offline" after the fact. A reader
  wanting to treat a long-silent `online: true` as effectively offline has
  to apply its own staleness threshold against `updatedAt` - not something
  this framework hardcodes a policy for.
- **`'members'`-mode ACL is still space-wide, not per-field/per-role** —
  any member may write any `'members'`-mode Node of any Kind. `'owner'`/
  `'named'` (§3) cover the self-certifying/delegated-authority cases; a
  full per-field/per-role ACL within `'members'` mode is real, separate
  work.
- **A not-otherwise-a-member `'owner'`/`'named'` identity's `hello` still
  gates on flat membership** (it carries no `nodeId`, so there's no
  per-Kind ACL mode to consult the way `subscribe` does) — presence/push
  don't yet extend to such an identity. Revisit alongside federation's own
  membership model.
- **Grant revocation is out of scope** — a `'named'`-mode grantee stays
  granted for the life of the process that learned about the grant; no
  message revokes one.
- **Member REMOVAL/rotation is not built** — `addMember()` (relay and
  Space) lets a new member join live; nothing revokes a departed member's
  standing ability to decrypt future writes or forge signed ones. Also
  inherent, not a gap: a newly added member can never retroactively
  decrypt a write sealed before they joined.
- **Federation has no membership-provisioning protocol** — a federating
  relay authenticates to its upstream with its own keypair (`--print-identity`
  solves RETRIEVING that pubkey, see §4), but if the upstream Kind requires
  flat `'members'` ACL, that relay still has to be added as a member
  out-of-band, same as any other member - no automated handshake for it.
- **No relay clustering/HA within one relay** — federation (§9) composes
  independent relay processes, but there's no hot-standby/failover for a
  single relay's own process.
- **`@qu/space-ui` is vanilla JS/DOM function bindings, not a component
  framework** — `bindField()`/`makeInlineEditable()`/`bindList()`/upload
  status icons (§17) work with plain elements, not custom elements/JSX/a
  virtual DOM. A `<qu-view>`/`<qu-bind>`-style custom-element wrapper on
  top is real, separate work if a project wants that authoring style.
- **No app beyond the demo** — `demo/` is a minimal CLI AND a minimal
  browser page (`demo/web/`, served by `demo/relay.mjs` at `/`) proving the
  sync mechanism (see `demo/README.md`); nothing production-app-shaped is
  built on top of `@qu/space-ui`/`@qu/space-plugins` yet.
- **`UploadOutbox` (§17) has no binary transfer protocol of its own** — a
  relay only ever forwards/mirrors signed CRDT envelopes, a poor fit for
  file bytes, so the actual upload mechanism (HTTP, object storage,
  whatever) is always supplied by the app; this class only owns the local
  queue/retry/status state machine.
- **`/join`'s dynamic membership has no authentication** — see
  `demo/relay.mjs`'s own doc comment on that endpoint; it's a deliberate,
  loud demo-only tradeoff (anyone reaching the port can join), not
  something to copy into a production relay unmodified.

## 13. Where to look for more

Every claim above is backed by a runnable test, not just a comment. See
`architecture.md` at the repo root for the full file-by-file map; the
highlights:

- `packages/space-core/test/` — envelope signing/verification (both
  modes, including `snapshot`), field encryption/visibility behavior, CRDT
  convergence, node-level ACL (`acl.test.js`), alias identities
  (`alias.test.js`), compaction (`compact-node.test.js`), the local-first
  query API (`use-node.test.js`).
- `packages/space-transport/test/poc-demo.test.js` — the original
  end-to-end proof (in-process transport).
- `packages/space-transport/test/ws-relay.test.js` — the same, over a real
  WebSocket port.
- `packages/space-transport/test/mirror-offline.test.js` — the
  offline-sender/mirror-storage scenario, including a real relay-process
  restart against real disk.
- `packages/space-transport/test/subscriber-tracking.test.js` — a
  connected, authorized member who never subscribed gets nothing;
  `unsubscribeNode()` reliably turns delivery back off.
- `packages/space-transport/test/named-acl.test.js` — `'owner'`/`'named'`
  ACL enforcement through a real relay.
- `packages/space-transport/test/federation.test.js` — two independent
  relay processes, demand-driven, bidirectional.
- `packages/space-transport/test/wire-efficiency.test.js` — base64 sizing
  and real `permessage-deflate` negotiation.
- `packages/space-storage/test/file-store.test.js` — real on-disk
  persistence, including the "fresh instance sees what a prior instance
  wrote" restart simulation.
- `packages/space-transport/test/ws-reconnect.test.js` — a client
  reconnecting after the relay is killed and restarted on the same port,
  and resyncing a Node it missed while offline (§15).
- `packages/space-core/test/persistence-tiers.test.js` /
  `packages/space-transport/test/persistence-tiers.test.js` — a
  `persistence: 'volatile'` Kind routes to a separate storage adapter on
  both the client and the relay (§16).
- `packages/space-core/test/presence.test.js` /
  `packages/space-transport/test/presence-through-relay.test.js` —
  presence/typing round-tripping peer-to-peer and through a real relay.
- `packages/space-plugins/test/` — write-ack correlation, read receipts,
  and the upload outbox's full lifecycle/retry.
- `packages/space-ui/test/` — the DOM-binding behaviors themselves (via
  `jsdom`): two-way binding without fighting its own echo, inline-edit
  never clobbering an in-progress edit, keyed list diffing, upload status
  icons.

Run any of them with `node --test <path>` from the relevant package
directory, or `npm test` from the repo root to run everything.

## 14. Try it yourself: the demos

The FEATURED, real-relay-and-browser demo is now the App Shell platform
one - see §10's own "App Shell deployment" subsection right above:
`docker compose -f docker-compose.space-relay.yml up -d` (the default
service) + `npm run bootstrap:platform` gets you a real Admin-UI and a
CMS-managed shell-app in one command. `demo/` itself still has two
zero/small-setup proofs of the CORE framework, unrelated to the App layer
(see `demo/README.md` for full detail):

```sh
npm run demo                    # zero-setup: one process, simulates chat AND owner-node identity discovery
npm run demo:legacy-chat-relay  # real relay, terminal 1 - also serves a browser client at http://localhost:8081/
npm run demo:legacy-chat-alice  # real client "alice", terminal 2
npm run demo:legacy-chat-bob    # real client "bob", terminal 3 - type in either, watch it appear in the other
```

`npm run demo` (`demo/auto-demo.mjs`) runs two scenarios in one process: a
chat exchange with presence-gated push routing (part 1), and an
`acl.write: 'owner'` Node with public fields that a completely unrelated
peer — never a Space member, never previously connected — discovers and
reads knowing only the owner's pubkey (part 2, §7/§3's `'owner'` mode in
action). Exits non-zero if anything doesn't converge as expected.

`demo:legacy-chat-relay` serves a small browser page on that SAME port
(`demo/web/`, esbuild-bundled at startup) - open it in two tabs, pick a
name, and chat live with each other or with a CLI
`demo:legacy-chat-alice`/`demo:legacy-chat-bob` in the same room. Point a
reverse proxy at this one port for HTTPS/TLS-offloading - it never needs a
second port, the WebSocket upgrade rides the same HTTP server as the
page/API.

The SAME app is also served by `@qu/space-transport`'s own
`relay-server.js`/its Docker image, now behind the `legacy-chat` Compose
profile (§10) - `demo:legacy-chat-relay` bundles at startup for a fast
local edit-reload loop, the Docker build bundles once at build time. This
stays a fixed, hardcoded demo app on purpose - see that file's own "SERVES
AN APP" doc comment for why (`@qu/space-transport` never depends on an
application-layer package). For a generic app (or, in PLATFORM mode,
several, each with its own CMS editor) defined entirely by Qu content
instead, see §10's own "App Shell deployment" subsection - now the
DEFAULT relay - and architecture.md §7.

## 15. Reconnect and resync

`WsClientTransport` reconnects on its own — a dropped socket (relay
restart, laptop sleep, a network handoff) is retried with exponential
backoff + jitter, and (in a browser) a backgrounded tab regaining focus or
the network coming back also forces an immediate reconnect check, since a
`close` event isn't guaranteed to fire promptly in either case. Opt out
with `{ reconnect: false }`.

```js
const transport = new WsClientTransport(url, { WebSocketImpl: WebSocket });
transport.onStatusChange(({ status }) => console.log('transport:', status));
// 'connected' -> ... -> 'disconnected' -> 'reconnecting' (x N, backoff) -> 'reconnected'
```

`Space` claims that callback itself (constructing a `Space` with a
transport that has `onStatusChange` wires this up automatically - nothing
else to call): on `'connected'`/`'reconnected'` it re-sends `hello` and
re-subscribes every Node it currently has attached. A relay answers each
`subscribe` by replaying its full mirror for that Node (§6), so whatever
this peer missed while offline — including another peer's writes made in
the meantime — arrives the same way ordinary catch-up already does; no
separate "diff" protocol exists or is needed, since re-applying already-
known Yjs updates is a no-op, not an error. This peer's OWN writes made
while offline are never lost either: `WsClientTransport.send()` queues
them and flushes the queue the moment the socket reopens.

To observe the SAME lifecycle from app/UI code (a "reconnecting…" banner,
say), read it off the bus instead of trying to also call
`onStatusChange()` yourself — `Space` already owns that single slot:

```js
const bus = new EventBus();
const space = new Space({ identity, members, transport, bus });
bus.on('space.status.changed', ({ status }) => updateConnectionBanner(status));
```

## 16. Per-Kind persistence tiers: presence, typing, and other ephemeral data

`defineKind()` takes an optional `persistence: 'durable' | 'volatile'`
(default `'durable'`, i.e. unchanged from before this existed). A Node of a
`'volatile'` Kind hydrates/mirrors through a SEPARATE storage adapter —
`Space`'s own `volatileStorage` constructor option, and the relay's own
`volatileStorage` option to `createRelayForwarder()` — instead of the
Space/relay's configured durable `storage`. Both default to a private,
zero-config in-memory store if you don't supply one, so declaring a
volatile Kind needs no extra wiring to just work:

```js
const typingSignalKind = defineKind('room-typing', {
  fields: { by: { shape: 'atomic', visibility: 'public' } },
  persistence: 'volatile', // never touches disk, gone on process exit - a relay restart loses it, same as `hello`/subscriber state already does.
});
```

This is the SAME swappable-adapter idea `@qu/space-storage`'s memory/
durable/file tiers already gave you at the whole-Space/whole-relay level —
now selectable per Kind. A concrete, real reason to want it: a browser app
could pass a `sessionStorage`-backed adapter as `volatileStorage` so
ephemeral Kinds vanish when the tab closes, while its durable Kinds keep
using `indexedDB`/`localStorage` as before — same `Space`, two adapters,
each Kind picks one via this one flag.

**Presence and typing are built on exactly this**, deliberately NOT as a
transport-level concept (an earlier draft added bespoke `'typing'`/
`'presence'` wire messages with their own relay code paths — reverted:
this generalization is strictly more reusable, and keeps the relay's wire
vocabulary exactly as small as before). `@qu/space-core`'s `presence.js`:

```js
import { setStatus, setTyping, watchPresence, PresenceWatcher, presenceKind } from '@qu/space-core';

await setStatus(mySpace, 'in a meeting');     // writes MY OWN presenceKind Node
await setTyping(mySpace, 'room-1', true);     // same Node, different field

const snapshot = await watchPresence(otherSpace, alicePub); // one-shot: {online, status, updatedAt, typingIn, typingAt}

const watcher = new PresenceWatcher(otherSpace, bus); // reactive, multi-member
await watcher.watch(alicePub);
watcher.of(aliceB64Pub); // -> latest snapshot - kept live off the ORDINARY space.node.<presenceNodeId>.changed event, no dedicated "presence" topic exists.
```

Online/offline LIVENESS itself is the one piece that deliberately stays
outside this mechanism — it's connection-lifecycle, not data (nothing can
sign "I went offline" after the fact) — see the pre-existing `hello`/
`PresenceTracker` machinery (§11) for that, unchanged by any of this.
`presenceKind`'s own `online` field is a best-effort self-reported flag
instead; combine it with `updatedAt` staleness if you need to guess at a
silently-dropped peer (§12's own honest note on this).

## 17. Optional plugins and UI layer (`@qu/space-plugins`, `@qu/space-ui`)

Both packages are built ENTIRELY on the public `Space`/`Field` API — no
`Space`/relay-side changes, no special casing, same "opt-in watcher/
helper, core stays unaware" shape as `alias.js`'s `AliasRegistry`.

**`@qu/space-plugins`** — small, reusable app helpers many apps would
otherwise reinvent:

```js
import { awaitRelayAck, markRead, watchReadReceipts, UploadOutbox } from '@qu/space-plugins';

// Delivery status: local -> relay-synced -> read.
await node.field('messages').push(message);
const { seq } = await awaitRelayAck(bus, node.id); // resolves once the relay durably mirrors THIS write (ordering-correlated - see its own doc comment)
await markRead(mySpace, node.id, message.id);      // durable, self-certifying-per-reader receipt
const receipts = await watchReadReceipts(otherSpace, myPub);

// (Multiple) file uploads: local save -> outbox queue -> mark done after sync.
const outbox = new UploadOutbox(space, myLocalBlobStore, async (record, blob) => {
  await uploadToMyServer(record, blob); // YOUR transport for bytes - a relay only ever forwards signed CRDT envelopes.
});
const fileId = await outbox.enqueue({ name: file.name, size: file.size, mimeType: file.type }, file);
await outbox.watch(fileId, (record) => console.log(record.status)); // 'pending' -> 'uploading' -> 'done'/'failed'
```

**`@qu/space-ui`** — vanilla JS/DOM bindings, no framework, no build step:

```js
import { bindField, makeInlineEditable, bindList, bindFileInput, bindUploadStatusIcon } from '@qu/space-ui';

bindField(titleInputEl, node.field('title'), { twoWay: true }); // live two-way text binding
makeInlineEditable(titleDivEl, node.field('title'));            // [contenteditable], Enter/blur = save, Escape = cancel

bindList(messageListEl, node.field('messages'), {
  key: (msg) => msg.id,
  render: (msg) => { const li = document.createElement('li'); li.textContent = msg.text; return li; },
}); // keyed diff - inserts/removes/moves the minimum, never re-renders an untouched sibling

bindFileInput(fileInputEl, outbox);
await bindUploadStatusIcon(statusIconEl, outbox, fileId); // never auto-hidden on 'done' - your stylesheet decides what that looks like
```

See each package's own `src/*.js` doc comments (and `architecture.md`'s
own API reference tables) for the complete surface — this section is a
taste, not the full reference.
