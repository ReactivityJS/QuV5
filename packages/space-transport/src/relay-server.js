#!/usr/bin/env node
/**
 * QU RELAY SERVER — a standalone relay for @qu/space-core peers, over
 * real WebSocket connections. Run directly (`node relay-server.js`) or via
 * the provided Dockerfile (see docs/v5-space-core-guide.md for both).
 *
 * The relay is itself a Space member's peer, not just a pipe: with
 * `QU_RELAY_DATA_DIR` set (the default), it MIRRORS every envelope it
 * forwards to real disk (`@qu/space-storage`'s `createFileStore()`), and
 * answers a peer's `{type:'subscribe'}` request by replaying that mirror -
 * so Client B still gets Client A's data even if A is offline by the time
 * B connects (see `relay.js`'s own doc comment, and
 * `test/mirror-offline.test.js` for the proof). It never decrypts
 * anything it mirrors - see envelope.js's `verifyEnvelope()` vs
 * `openUpdate()` split; this file never even imports `openUpdate`.
 *
 * This is deliberately thin: `createWsServerHub()` (real sockets) +
 * `createFileStore()` (real disk) + `createRelayForwarder()` (the exact
 * same, already-tested logic the in-process demo proves) - no
 * relay-specific logic lives in this file itself.
 *
 * Configuration is via environment variables, no config file - same
 * posture as `@qu/relay`'s own `server.js`:
 *
 *   QU_RELAY_PORT           - default 8081.
 *   QU_MEMBERS_JSON         - OPTIONAL, default `[]`. A JSON array of every
 *                             `'members'`-mode ACL peer's public keys,
 *                             base64-encoded: '[{"pub":"<base64 Ed25519>",
 *                             "xPub":"<base64 X25519>"}, ...]'. This is a
 *                             genuine access-control DECISION - only a
 *                             human/operator can say who's authorized -
 *                             which is why it's the one setting this file
 *                             still asks for explicitly, unlike the relay's
 *                             OWN identity below. See "WHY MEMBERS ARE
 *                             OPTIONAL NOW" below for what an empty/unset
 *                             value actually means (not "nobody can write
 *                             anything" - see kind-schema.js's `'owner'`/
 *                             `'named'` ACL modes). See
 *                             docs/v5-space-core-guide.md for how to
 *                             generate entries with QuCrypto.generateKeypair().
 *   QU_RELAY_DATA_DIR       - default "/data" (see Dockerfile/compose -
 *                             mount a volume here to survive a container
 *                             restart). Set to "" (empty) to disable
 *                             mirroring entirely and run a pure live-only
 *                             relay - see mirror-offline.test.js's second
 *                             test for exactly what that trades away. Also
 *                             where this relay's OWN identity is persisted
 *                             (see "RELAY IDENTITY" below) - leaving this
 *                             empty makes that identity ephemeral too.
 *   QU_RELAY_IDENTITY_FILE  - default "<QU_RELAY_DATA_DIR>/relay-identity.json".
 *                             Override to persist the relay's own identity
 *                             somewhere other than the mirror data dir.
 *   QU_FEDERATE_UPSTREAM_URL - OPTIONAL. A `ws://`/`wss://` URL of another
 *                             relay to federate with (see federation.js) -
 *                             this relay becomes a subscribing PEER of it,
 *                             demand-driven, using its own identity below.
 *                             Omit entirely to run a standalone (non-
 *                             federating) relay, the default.
 *
 * WHY MEMBERS ARE OPTIONAL NOW: earlier versions of this framework had
 * exactly one ACL mode (flat `'members'`), so a relay with no members
 * configured could never authorize anything - hence the old, since-
 * removed hard requirement to set this before the container would even
 * start. That's no longer the whole story: `acl.write: 'owner'`/`'named'`
 * Kinds (see kind-schema.js) are SELF-CERTIFYING - their write-ACL is a
 * pure function of the Node's own id and (for `'named'`) signed `grant`
 * messages, needing ZERO relay-side membership configuration. An app
 * built entirely on `'owner'`/`'named'` Kinds can run this relay with
 * `QU_MEMBERS_JSON` unset from the very first boot. `'members'`-mode
 * Kinds still need SOME authorized set decided by a human before anyone
 * can write to them - that's an inherent property of what "flat
 * membership ACL" means, not a limitation of this relay - so leaving it
 * empty simply means no `'members'`-mode Kind has an authorized writer
 * yet, logged clearly below rather than failing to start.
 *
 * RELAY IDENTITY: see relay-identity.js's own doc comment for the full
 * "why" - auto-generated on first boot, persisted under
 * `QU_RELAY_IDENTITY_FILE`, reused on every later boot. Run
 * `node relay-server.js --print-identity` to print this relay's own
 * fingerprint/pubkeys (creating the identity file first if it doesn't
 * exist yet) WITHOUT starting the WebSocket server - the answer to "how
 * do I get this relay's pubkey to register it as a member/federation peer
 * elsewhere" without a manual keygen-then-paste step.
 *
 * Known, documented gap (see the guide's own "known gaps" section): this
 * relay doesn't maintain a Kind-Schema registry of its own
 * (`resolveKindSchema: () => true` below) - it forwards/mirrors any Node
 * id, gated only by the envelope's write signature being one of `members`,
 * not by a per-Kind ACL (the space-wide `members` list IS the write-ACL
 * for every Kind in this PoC - see kind-schema.js's own doc comment). A
 * direct consequence (see relay.js's own `buildWriteAcl()` doc comment):
 * an `acl.write: 'owner'`/`'named'` Kind's self-certifying/grant-based ACL
 * needs the REAL Kind-Schema (specifically its `kind` string, for
 * `deriveOwnerNodeId()`) to enforce - a relay stood up this way can only
 * ever fall back to flat `members` ACL, never `'owner'`/`'named'`. Run
 * `createRelayForwarder()` directly with a real `resolveKindSchema` (as
 * every test in `test/` does, and `demo/auto-demo.mjs` routes by nodeId
 * prefix) to get that enforcement. Also unbuilt: any mechanism for an
 * operator to ADD a `'members'`-mode member to an already-running
 * `relay-server.js` process (the in-process `relay.addMember()` exists
 * and works - see relay.js's own doc comment - but nothing here exposes
 * it over the network; `demo/relay.mjs`'s `/join` is a deliberately
 * insecure, demo-only example of what that would need to guard against).
 */
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { QuCrypto } from '@qu/core';
import { EventBus } from '@qu/events';
import { createFileStore } from '@qu/space-storage';
import { createWsServerHub } from './ws-server-hub.js';
import { WsClientTransport } from './ws-client-transport.js';
import { createRelayForwarder } from './relay.js';
import { federateRelay } from './federation.js';
import { loadOrCreateIdentity, describeIdentity } from './relay-identity.js';

const PORT = Number(process.env.QU_RELAY_PORT || 8081);
const DATA_DIR = process.env.QU_RELAY_DATA_DIR ?? '/data';
const IDENTITY_FILE = process.env.QU_RELAY_IDENTITY_FILE || (DATA_DIR ? `${DATA_DIR}/relay-identity.json` : null);
const FEDERATE_UPSTREAM_URL = process.env.QU_FEDERATE_UPSTREAM_URL || null;

let members = [];
const membersJson = process.env.QU_MEMBERS_JSON;
if (membersJson) {
  try {
    members = JSON.parse(membersJson).map((m) => ({
      pub: QuCrypto.fromBase64(m.pub),
      xPub: QuCrypto.fromBase64(m.xPub),
    }));
  } catch (err) {
    console.error('[qu-relay] QU_MEMBERS_JSON is not valid JSON / valid base64 keys:', err.message);
    process.exit(1);
  }
}

async function resolveIdentity() {
  if (!IDENTITY_FILE) {
    console.warn('[qu-relay] QU_RELAY_DATA_DIR is empty and QU_RELAY_IDENTITY_FILE is unset - this relay\'s own identity is EPHEMERAL (a new one every restart). Set QU_RELAY_DATA_DIR or QU_RELAY_IDENTITY_FILE to persist it, needed for stable federation trust across restarts.');
    const kp = await QuCrypto.generateKeypair();
    return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
  }
  const { identity, created } = await loadOrCreateIdentity(IDENTITY_FILE);
  if (created) {
    const { fingerprint } = await describeIdentity(identity);
    console.log(`[qu-relay] generated a new relay identity at ${IDENTITY_FILE} (fingerprint ${fingerprint})`);
  }
  return identity;
}

async function main() {
  if (process.argv.includes('--print-identity')) {
    if (!IDENTITY_FILE) {
      console.error('[qu-relay] --print-identity needs somewhere to persist to - set QU_RELAY_DATA_DIR or QU_RELAY_IDENTITY_FILE.');
      process.exit(1);
    }
    const { identity } = await loadOrCreateIdentity(IDENTITY_FILE);
    const { fingerprint, pub, xPub } = await describeIdentity(identity);
    console.log(JSON.stringify({ fingerprint, pub, xPub }, null, 2));
    return;
  }

  const relayIdentity = await resolveIdentity();

  const httpServer = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  // perMessageDeflate: 'ws' already offers this from the CLIENT side by default (WsClientTransport/
  // a browser's native WebSocket) - the server has to opt in too, or the extension never actually
  // negotiates. See ws-server-hub.js's own doc comment on why wire efficiency lives here (at
  // WebSocketServer construction) rather than inside the hub itself.
  const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: true });
  const hub = createWsServerHub(wss);
  const storage = DATA_DIR ? createFileStore(DATA_DIR) : null;
  // Always given a bus: cheap, and it's what makes QU_FEDERATE_UPSTREAM_URL below actually work
  // (federateRelay() listens on debug.relay.subscribe.received/relay.write.local - see
  // federation.js's own doc comment) - not exposed for push-notification/debug-logging wiring
  // here, that's real, separate work (see this file's own doc comment on unbuilt admin surface).
  const bus = new EventBus();
  const relay = createRelayForwarder({
    hub,
    members,
    resolveKindSchema: () => true,
    storage,
    bus,
  });

  if (FEDERATE_UPSTREAM_URL) {
    const upstreamTransport = new WsClientTransport(FEDERATE_UPSTREAM_URL, { WebSocketImpl: WebSocket });
    await upstreamTransport.connect();
    federateRelay({ relay, bus, transport: upstreamTransport, identity: relayIdentity });
    const { fingerprint } = await describeIdentity(relayIdentity);
    console.log(`[qu-relay] federating with ${FEDERATE_UPSTREAM_URL} as ${fingerprint} - demand-driven, nothing fetched until a local peer subscribes to something new`);
  }

  httpServer.listen(PORT, () => {
    const mirrorNote = storage ? `mirroring to ${DATA_DIR}` : 'NO mirroring (live-only, QU_RELAY_DATA_DIR is empty)';
    const membersNote =
      members.length > 0
        ? `${members.length} authorized 'members'-mode member(s)`
        : `no 'members'-mode members configured (owner/named-ACL Kinds work regardless - see this file's own doc comment)`;
    console.log(`[qu-relay] listening on :${PORT} - ${membersNote}, blind relay (no plaintext ever decrypted), ${mirrorNote}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
