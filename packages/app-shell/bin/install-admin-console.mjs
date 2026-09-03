#!/usr/bin/env node
/**
 * ADMIN CONSOLE INSTALLER — the bootstrap step architecture.md §7's
 * "Bedeutet dann, dass initial das Relay oder der Admin einen Weg ... zur
 * Installation braucht" describes: a real, separate process, run by
 * whoever holds the bootstrapping identity's PRIVATE key (never the
 * relay), that connects TWICE to an already-running
 * `packages/app-shell/relay-server.js` in PLATFORM mode -
 *
 *   1. to the ADMIN realm's own WS endpoint (`/admin-ws`) and writes the
 *      built-in console's content there (`installAdminAppBundle()`,
 *      `admin-console-bundle.js`) - succeeds only if this identity is
 *      already listed in that relay's `QU_RELAY_ADMINS` (see
 *      `relay-server.js`'s own "ADMIN REALM" doc comment - admin
 *      membership is never self-registered);
 *   2. to the MAIN Space and writes ONE `qu-platform-apps` alias
 *      (`registerApp()`) mapping the chosen prefix (`"admin"` by default)
 *      to `realm: 'admin'` - succeeds only if this identity is ALSO in
 *      that SAME `QU_RELAY_ADMINS` list (`qu-platform-apps` is now
 *      `acl.write: 'relay-admins'`, checked against that exact list - see
 *      `@qu/space-core`'s kind-schema.js own doc comment on the mode).
 *
 * Run once per deployment (re-running is harmless - every write here is
 * idempotent/overwriting, same as `installAppBundle()`'s own posture).
 * Usage:
 *   node packages/app-shell/bin/install-admin-console.mjs \
 *     --relay wss://your-host --prefix admin --dir ./admin-identity
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { WsClientTransport } from '@qu/space-transport';
import { installAdminAppBundle, registerApp } from '@qu/app-core';
import { adminConsoleBundle } from '../admin-console-bundle.js';

function parseArgs(argv) {
  const opts = { relay: 'ws://localhost:8081', prefix: 'admin', dir: './admin-identity', name: 'Relay-Admin' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--relay') opts.relay = argv[++i];
    else if (argv[i] === '--prefix') opts.prefix = argv[++i];
    else if (argv[i] === '--dir') opts.dir = argv[++i];
    else if (argv[i] === '--name') opts.name = argv[++i];
  }
  return opts;
}

/** Loads `<dir>/identity.json` if it exists, otherwise generates and persists a fresh keypair - same self-contained pattern `demo/lib/identity.mjs` uses, kept local here since this is a real package script, not demo code. */
async function ensureIdentity(dir) {
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'identity.json');
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    return {
      signingKey: QuCrypto.fromBase64(raw.signingKey),
      signingPub: QuCrypto.fromBase64(raw.signingPub),
      xPrivateKey: QuCrypto.fromBase64(raw.xPrivateKey),
      xPublicKey: QuCrypto.fromBase64(raw.xPublicKey),
    };
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const kp = await QuCrypto.generateKeypair();
  const identity = { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
  await writeFile(
    file,
    JSON.stringify(
      {
        signingKey: QuCrypto.toBase64(identity.signingKey),
        signingPub: QuCrypto.toBase64(identity.signingPub),
        xPrivateKey: QuCrypto.toBase64(identity.xPrivateKey),
        xPublicKey: QuCrypto.toBase64(identity.xPublicKey),
      },
      null,
      2
    ),
    'utf8'
  );
  return identity;
}

async function main() {
  const { relay, prefix, dir, name } = parseArgs(process.argv.slice(2));
  const identity = await ensureIdentity(dir);
  console.log(`Qu V5 — admin console installer: identity [${await QuCrypto.fingerprint(identity.signingPub)}]`);
  console.log(`Add this identity to QU_RELAY_ADMINS as {"pub":"${QuCrypto.toBase64(identity.signingPub)}","xPub":"${QuCrypto.toBase64(identity.xPublicKey)}"}`);

  console.log(`\nConnecting to the admin realm at ${relay}/admin-ws …`);
  const adminTransport = new WsClientTransport(`${relay.replace(/\/?$/, '')}/admin-ws`, { WebSocketImpl: WebSocket });
  await adminTransport.connect();
  const adminSpace = new Space({ identity, members: [{ pub: identity.signingPub, xPub: identity.xPublicKey }], transport: adminTransport });
  console.log('Installing the built-in admin console content…');
  await installAdminAppBundle(adminSpace, adminConsoleBundle);
  await new Promise((resolve) => setTimeout(resolve, 300)); // let the writes actually leave before closing.
  adminTransport.close();

  console.log(`\nConnecting to the main Space at ${relay} to register the "${prefix}" alias…`);
  const mainTransport = new WsClientTransport(relay, { WebSocketImpl: WebSocket });
  await mainTransport.connect();
  const mainSpace = new Space({ identity, members: [{ pub: identity.signingPub, xPub: identity.xPublicKey }], transport: mainTransport });
  await registerApp(mainSpace, { prefix, name, realm: 'admin' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  mainTransport.close();

  console.log(`\n✅ Installiert. Öffne #/${prefix} als diese Identity, um die Konsole zu sehen.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
