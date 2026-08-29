#!/usr/bin/env node
/**
 * DEMO RELAY — `npm run demo:relay`. A real WebSocket relay for the
 * two-terminal text-exchange demo (see `demo/README.md`), wired the same
 * way `packages/space-transport/src/relay-server.js` is, just with its
 * `SPACE_MEMBERS_JSON` derived automatically from whatever identities
 * already exist under `demo/.identities/` (see `demo/lib/identity.mjs`)
 * instead of requiring it to be hand-assembled.
 *
 * Also wires an `@qu/events` bus + `registerPushHandler()`: any chat
 * message carrying a `notify` hint (see `chat.mjs`) is routed here based
 * on the `PresenceTracker`'s own view of who's currently connected - a
 * recipient who's online gets nothing extra (their live connection above
 * already delivers it); an offline one gets a logged "would send Web
 * Push" line, proving the routing without this demo needing real VAPID
 * keys/a push subscription store (see push-handler.js's own doc comment).
 *
 * Usage: node demo/relay.mjs [--port 8081] [--dir demo/.identities] [--data demo/.data]
 */
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { defineKind } from '@qu/space-core';
import { createFileStore } from '@qu/space-storage';
import { createWsServerHub, createRelayForwarder, registerPushHandler } from '@qu/space-transport';
import { EventBus } from '@qu/events';
import { ensureIdentity, loadMembers, fingerprintOf, DEFAULT_IDENTITY_DIR } from './lib/identity.mjs';

// MUST match chat.mjs's own defineKind() call - both processes need the identical Kind-Schema shape.
const chatKind = defineKind('demo-chat', { fields: { messages: 'list' }, notifyTopics: ['message', 'mention'] });

function parseArgs(argv) {
  const opts = { port: 8081, dir: DEFAULT_IDENTITY_DIR, data: new URL('.data/', import.meta.url).pathname };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') opts.port = Number(argv[++i]);
    else if (argv[i] === '--dir') opts.dir = argv[++i];
    else if (argv[i] === '--data') opts.data = argv[++i];
  }
  return opts;
}

async function main() {
  const { port, dir, data } = parseArgs(process.argv.slice(2));

  // Bootstrap the demo's two default identities if this is a first run - a
  // relay needs to know every authorized member's public key up front, so
  // it should not have to wait for "alice"/"bob" to connect once each first.
  await ensureIdentity('alice', dir);
  await ensureIdentity('bob', dir);

  const members = await loadMembers(dir);
  if (members.length === 0) {
    console.error(`[demo-relay] no identities found under ${dir} - run "npm run demo:alice"/"npm run demo:bob" first, or pass --dir.`);
    process.exit(1);
  }

  console.log('Qu V5 — demo relay (real WebSocket, real disk mirror)\n');
  for (const m of members) console.log(`  authorized member: ${m.name.padEnd(10)} ${await fingerprintOf(m.pub)}`);
  console.log();

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
  const storage = createFileStore(data);
  const bus = new EventBus();
  createRelayForwarder({ hub, members, resolveKindSchema: () => chatKind, storage, bus });
  registerPushHandler(bus, {
    sendPush: (p) => console.log(`  📮 ~${p.to.slice(0, 12)}… is offline -> sending Web Push: "${p.kind}.${p.topic}" (from ~${p.authorPub.slice(0, 12)}…)`),
  });

  httpServer.listen(port, () => {
    console.log(`[demo-relay] listening on ws://localhost:${port} - mirroring to ${data}`);
    console.log('[demo-relay] blind relay: it verifies signatures but never sees plaintext.');
    console.log('[demo-relay] presence-gated push routing active - watch this terminal when the OTHER client is not running.\n');
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
