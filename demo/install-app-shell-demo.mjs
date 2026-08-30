#!/usr/bin/env node
/**
 * APP SHELL INSTALLER — `npm run demo:app-shell-install`. The Dev/Admin
 * bootstrap from docs/app-shell-arbeitsauftrag.md §25 ("leere App Shell ->
 * Admin/Dev Console -> fertige Anwendung"), run as a real, separate
 * process over a REAL WebSocket connection to an already-running
 * `demo/app-shell-relay.mjs` - unlike `demo/app-shell-demo.mjs` (the
 * in-process proof of concept), this is the actual "installer command" the
 * App Shell needs: connect, seed content, disconnect, done. A browser
 * pointed at the relay afterward sees the exact same app render purely
 * from what THIS script wrote to the Space - proving real remote sync, not
 * just an in-process simulation.
 *
 * Writes AS the app-admin identity `demo/app-shell-relay.mjs` already
 * pre-seeded as a relay member on its own first run (same persisted
 * `demo/.app-shell-identities/app-admin.json` both processes share) - see
 * @qu/app-core's `dev.js` for what `createApp`/`createTemplate`/
 * `createStyle`/`createPage`/`publishRoute` actually do (thin wrappers
 * around `Space.createNode()`, nothing more).
 *
 * Usage: node demo/install-app-shell-demo.mjs [--relay ws://localhost:8082] [--dir demo/.app-shell-identities]
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { WsClientTransport } from '@qu/space-transport';
import { EventBus } from '@qu/events';
import { createApp, createTemplate, createStyle, createPage, publishRoute } from '@qu/app-core';
import { ensureIdentity, fingerprintOf } from './lib/identity.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const opts = { relay: 'ws://localhost:8082', dir: join(HERE, '.app-shell-identities') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--relay') opts.relay = argv[++i];
    else if (argv[i] === '--dir') opts.dir = argv[++i];
  }
  return opts;
}

/**
 * Tracks every LOCAL write this Space actually issues - `debug.space.
 * write.local` fires once per ACTUAL Yjs update sealed and sent (see
 * space.js's own doc comment), NOT once per Dev-API call: `createPage()`
 * alone produces a meta-stamp PLUS one write per field (5 underlying
 * envelopes, not 1). Attach this BEFORE issuing any writes.
 */
function trackWrites(bus) {
  const state = { expected: 0, acked: 0 };
  bus.on('debug.space.write.local', () => {
    state.expected++;
  });
  bus.on('space.node.*.write-ack', () => {
    state.acked++;
  });
  return state;
}

/**
 * Waits until every write `state` has seen so far has ALSO been write-
 * acked by the relay (see architecture.md §3.5's WRITE-ACK), or `timeout`
 * elapses - whichever first, so this installer never hangs indefinitely if
 * the relay has no durable storage mounted for some reason. Sealing a
 * write is itself async and not awaited by the Dev API's own `await
 * write()` calls (a real, previously-uncaught bug here: this installer
 * used to close its connection before every field's write had actually
 * left the socket, so a browser visiting right after sometimes saw a page
 * with its `content` field still missing) - the `settle` delay lets
 * `state.expected` finish growing to its true final count before this
 * starts waiting for `state.acked` to catch up to it.
 */
async function waitUntilAllWritesAcked(state, { timeout = 5000, settle = 300, interval = 20 } = {}) {
  await new Promise((resolve) => setTimeout(resolve, settle));
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (state.acked >= state.expected) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

async function main() {
  const { relay, dir } = parseArgs(process.argv.slice(2));

  const appAdmin = await ensureIdentity('app-admin', dir);
  console.log(`Qu V5 — App Shell installer: connecting as app-admin [${await fingerprintOf(appAdmin)}]`);

  const transport = new WsClientTransport(relay, { WebSocketImpl: WebSocket });
  await transport.connect();
  console.log(`Connected to ${relay}.`);

  const bus = new EventBus();
  const space = new Space({ identity: appAdmin, members: [{ pub: appAdmin.signingPub, xPub: appAdmin.xPublicKey }], transport, bus });
  const writeState = trackWrites(bus);

  console.log('Installing "Qu Demo App" (1 Manifest, 1 Route-Registry, 1 Template, 1 Style, 2 Pages)…');
  const writes = [
    () => createApp(space, { name: 'Qu Demo App', rootTemplate: 'layout/main', defaultRoute: '/', theme: 'global' }),
    () =>
      createTemplate(space, {
        name: 'layout/main',
        html: '<header><h1>Qu Demo App</h1></header><main><qu-slot name="content"></qu-slot></main><footer>gebaut aus Qu Content, nicht aus App-Shell-Code</footer>',
      }),
    () => createStyle(space, { name: 'global', css: 'body { font-family: sans-serif; margin: 2rem auto; max-width: 40rem; } header,footer{opacity:.7}' }),
    () => createPage(space, { route: '/', title: 'Start', template: 'layout/main', content: '<p>Willkommen! Diese Seite wurde per <code>npm run demo:app-shell-install</code> aus Qu-Content erzeugt.</p>' }),
    () => createPage(space, { route: '/hello', title: 'Hallo', template: 'layout/main', content: '<p>Hallo aus dem Space! Diese Route/Template/Content kommen komplett aus Qu, nicht aus der App Shell.</p>' }),
    () => publishRoute(space, { route: '/', title: 'Start' }),
    () => publishRoute(space, { route: '/hello', title: 'Hallo' }),
  ];
  for (const write of writes) await write();

  console.log('Waiting for the relay to durably mirror every write…');
  await waitUntilAllWritesAcked(writeState);
  console.log(`  ${writeState.acked}/${writeState.expected} writes acked.`);

  console.log(`\n✅ Installiert. App-Admin-Pubkey: ${QuCrypto.toBase64(appAdmin.signingPub)}`);
  console.log('Öffne die von "npm run demo:app-shell-relay" ausgegebene URL im Browser.');

  transport.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
