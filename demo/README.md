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
and simulates a short conversation between them - all in one process, so it
also doubles as a smoke test that the build actually works end to end
(signing, encryption, CRDT sync, and the relay never seeing plaintext).

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

Stop with Ctrl+C. Restart `demo:relay` any time you add a third identity
(`node demo/chat.mjs carol`) so it picks up the new member.

## How it works

- `demo/lib/identity.mjs` - persists one Ed25519+X25519 keypair per name
  under `demo/.identities/<name>.json` (created on first use), and exposes
  `loadMembers()` (every identity's *public* halves, for a Space's
  `members` list) and `fingerprintOf()`.
- `demo/relay.mjs` - a real relay (`@qu/space-transport`'s
  `createWsServerHub`/`createRelayForwarder` + `@qu/space-storage`'s
  `createFileStore`), same code path as
  `packages/space-transport/src/relay-server.js`.
- `demo/chat.mjs` - a CLI peer: connects via `WsClientTransport`, joins a
  shared `demo-chat` Node (`{ messages: 'list' }` Kind-Schema, see
  `packages/space-core/src/kind-schema.js`), and reads/writes it from
  stdin/stdout.
- `demo/auto-demo.mjs` - the same mechanism, in-process, no relay/terminal
  needed - see `npm run demo` above.

Every message is signed with the sender's Ed25519 key and end-to-end
encrypted for every member's X25519 key before it ever reaches the relay or
disk (see `docs/v5-space-core-guide.md` §3) - the relay only ever forwards
and mirrors ciphertext it cannot decrypt.

## Caveats (it's a demo)

- All identities live in one shared local directory - fine for "two
  terminals on the same machine," not a real key-distribution mechanism.
- The member list is whatever identity files exist in `demo/.identities/`
  when `demo:relay` starts; adding a new participant means restarting it.
- No auth beyond Qu's own signature/ACL check - anyone who can reach the
  relay port and already has (or is given) an authorized identity file can
  join the room.
