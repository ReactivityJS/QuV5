#!/usr/bin/env node
/**
 * DEMO RELAY — `npm run demo:relay`. A real WebSocket relay for the
 * two-terminal text-exchange demo (see `demo/README.md`), wired the same
 * way `packages/space-transport/src/relay-server.js` is, just with its
 * `SPACE_MEMBERS_JSON` derived automatically from whatever identities
 * already exist under `demo/.identities/` (see `demo/lib/identity.mjs`)
 * instead of requiring it to be hand-assembled.
 *
 * Usage: node demo/relay.mjs [--port 8081] [--dir demo/.identities] [--data demo/.data]
 */
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { createFileStore } from '@qu/space-storage';
import { createWsServerHub, createRelayForwarder } from '@qu/space-transport';
import { ensureIdentity, loadMembers, fingerprintOf, DEFAULT_IDENTITY_DIR } from './lib/identity.mjs';

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
  createRelayForwarder({ hub, members, resolveKindSchema: () => true, storage });

  httpServer.listen(port, () => {
    console.log(`[demo-relay] listening on ws://localhost:${port} - mirroring to ${data}`);
    console.log('[demo-relay] blind relay: it verifies signatures but never sees plaintext.\n');
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
