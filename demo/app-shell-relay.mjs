#!/usr/bin/env node
/**
 * APP SHELL RELAY — `npm run demo:app-shell-relay`. A real WebSocket relay
 * serving `@qu/app-shell` instead of the chat demo's `demo/web/` - wired
 * the same way `demo/relay.mjs` is (`createWsServerHub`/
 * `createRelayForwarder` + `@qu/space-storage`'s `createFileStore` +
 * `@qu/space-transport`'s `createAppRequestHandler`), just with
 * `resolveKindSchema` built by `@qu/app-core`'s `createAppResolveKindSchema()`
 * instead of a single fixed chat Kind, and the served app being
 * `demo/app-shell-web/`'s generated bundle instead of `demo/web/`'s.
 *
 * This relay itself still knows NOTHING about pages/templates/styles - see
 * `@qu/app-core`'s `relay-resolver.js` for what `resolveKindSchema` here
 * actually does (distinguish the app-admin's Manifest/Route-Registry
 * singletons from any other content-addressed Node) and
 * architecture.md §7/docs/app-shell-arbeitsauftrag.md §29 for why that's a
 * hard architectural line, not an oversight.
 *
 * Run this, THEN seed it with `npm run demo:app-shell-install` (a separate
 * process, over a REAL WebSocket connection - not in-process like
 * `demo/app-shell-demo.mjs`), then open the printed URL in a browser.
 *
 * Usage: node demo/app-shell-relay.mjs [--port 8082] [--dir demo/.app-shell-identities] [--data demo/.app-shell-data]
 */
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { QuCrypto } from '@qu/core';
import { createFileStore } from '@qu/space-storage';
import { createWsServerHub, createRelayForwarder, createAppRequestHandler } from '@qu/space-transport';
import { createAppResolveKindSchema } from '@qu/app-core';
import { EventBus } from '@qu/events';
import { ensureIdentity, loadMembers, fingerprintOf } from './lib/identity.mjs';
import { buildAppShellWebBundle } from './app-shell-web/build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(HERE, 'app-shell-web');

function parseArgs(argv) {
  const opts = { port: 8082, dir: join(HERE, '.app-shell-identities'), data: join(HERE, '.app-shell-data') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') opts.port = Number(argv[++i]);
    else if (argv[i] === '--dir') opts.dir = argv[++i];
    else if (argv[i] === '--data') opts.data = argv[++i];
  }
  return opts;
}

async function main() {
  const { port, dir, data } = parseArgs(process.argv.slice(2));

  // The app-admin is a persisted, ORDINARY Qu identity (docs/app-shell-arbeitsauftrag.md §19) -
  // not a relay-internal superuser. Its private key lives in this identity file, same as any
  // other demo identity (see lib/identity.mjs's own doc comment on why that's fine for a local
  // demo and NOT how a real deployment would hold an admin key).
  const appAdmin = await ensureIdentity('app-admin', dir);
  const members = await loadMembers(dir); // grows via POST /join, same mechanism the chat demo already uses.

  console.log('[app-shell-relay] bundling @qu/app-shell…');
  const { outfile } = await buildAppShellWebBundle({ appAdminPub: appAdmin.signingPub });

  console.log('Qu V5 — App Shell relay (real WebSocket, real disk mirror)\n');
  console.log(`  app-admin  ${await fingerprintOf(appAdmin)}  (pub: ${QuCrypto.toBase64(appAdmin.signingPub)})`);
  console.log(`  bundled -> ${outfile}\n`);

  const storage = createFileStore(data);
  const bus = new EventBus();
  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPub: appAdmin.signingPub });

  const httpServer = createServer((req, res) => handleRequest(req, res));
  const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: true });
  const hub = createWsServerHub(wss);
  const relay = createRelayForwarder({ hub, members, resolveKindSchema, storage, bus });

  const handleAppRequest = createAppRequestHandler({ webDir: WEB_DIR, members, relay, allowJoin: true, log: console.log });

  function handleRequest(req, res) {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (handleAppRequest(req, res)) return;
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }

  httpServer.listen(port, () => {
    console.log(`[app-shell-relay] listening on http://localhost:${port} (WebSocket on the same port) - mirroring to ${data}`);
    console.log(`[app-shell-relay] not yet seeded with any content - run "npm run demo:app-shell-install" now.`);
    console.log(`[app-shell-relay] then open http://localhost:${port}/ in a browser.\n`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
