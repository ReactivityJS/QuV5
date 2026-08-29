#!/usr/bin/env node
/**
 * SPACE RELAY SERVER — a standalone relay for @qu/space-core peers, over
 * real WebSocket connections. Run directly (`node relay-server.js`) or via
 * the provided Dockerfile (see docs/v5-space-core-guide.md for both).
 *
 * The relay is itself a Space member's peer, not just a pipe: with
 * `SPACE_RELAY_DATA_DIR` set (the default), it MIRRORS every envelope it
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
 *   SPACE_RELAY_PORT       - default 8081 (deliberately different from
 *                             @qu/relay's 8080, so both can run side by
 *                             side during evaluation).
 *   SPACE_MEMBERS_JSON      - REQUIRED. A JSON array of every Space
 *                             member's public keys, base64-encoded:
 *                             '[{"pub":"<base64 Ed25519>","xPub":"<base64 X25519>"}, ...]'
 *                             See docs/v5-space-core-guide.md for how to
 *                             generate these with QuCrypto.generateKeypair().
 *   SPACE_RELAY_DATA_DIR    - default "/data" (see Dockerfile/compose -
 *                             mount a volume here to survive a container
 *                             restart). Set to "" (empty) to disable
 *                             mirroring entirely and run a pure live-only
 *                             relay - see mirror-offline.test.js's second
 *                             test for exactly what that trades away.
 *
 * Known, documented gap (see the guide's own "known gaps" section): this
 * relay doesn't maintain a Kind-Schema registry of its own
 * (`resolveKindSchema: () => true` below) - it forwards/mirrors any Node
 * id, gated only by the envelope's write signature being one of `members`,
 * not by a per-Kind ACL (the space-wide `members` list IS the write-ACL
 * for every Kind in this PoC - see kind-schema.js's own doc comment).
 */
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { QuCrypto } from '@qu/core';
import { createFileStore } from '@qu/space-storage';
import { createWsServerHub } from './ws-server-hub.js';
import { createRelayForwarder } from './relay.js';

const PORT = Number(process.env.SPACE_RELAY_PORT || 8081);
const DATA_DIR = process.env.SPACE_RELAY_DATA_DIR ?? '/data';

const membersJson = process.env.SPACE_MEMBERS_JSON;
if (!membersJson) {
  console.error('[space-relay] SPACE_MEMBERS_JSON is required - a JSON array of {"pub","xPub"} (base64) for every authorized Space member. See docs/v5-space-core-guide.md.');
  process.exit(1);
}

let members;
try {
  members = JSON.parse(membersJson).map((m) => ({
    pub: QuCrypto.fromBase64(m.pub),
    xPub: QuCrypto.fromBase64(m.xPub),
  }));
} catch (err) {
  console.error('[space-relay] SPACE_MEMBERS_JSON is not valid JSON / valid base64 keys:', err.message);
  process.exit(1);
}

const httpServer = createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer });
const hub = createWsServerHub(wss);
const storage = DATA_DIR ? createFileStore(DATA_DIR) : null;
createRelayForwarder({
  hub,
  members,
  resolveKindSchema: () => true,
  storage,
});

httpServer.listen(PORT, () => {
  const mirrorNote = storage ? `mirroring to ${DATA_DIR}` : 'NO mirroring (live-only, SPACE_RELAY_DATA_DIR is empty)';
  console.log(`[space-relay] listening on :${PORT} - ${members.length} authorized member(s), blind relay (no plaintext ever decrypted), ${mirrorNote}`);
});
