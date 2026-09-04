#!/usr/bin/env node
/**
 * ADMIN CONSOLE INSTALLER — the bootstrap step architecture.md §7's
 * "Bedeutet dann, dass initial das Relay oder der Admin einen Weg ... zur
 * Installation braucht" describes: a real, separate process, run by
 * whoever holds the bootstrapping identity's PRIVATE key (never the
 * relay), that connects ONCE to an already-running
 * `packages/app-shell/relay-server.js` in PLATFORM mode and writes, into
 * that SAME main Space (see relay-server.js's own "ONE RELAY SPACE, NOT
 * TWO" doc comment - there is no more separate admin realm/`/admin-ws`) -
 *
 *   1. the built-in admin console's own content (`installGlobalAppBundle()`,
 *      `admin-console-bundle.js`, `acl.write: 'relay-admins'` - see
 *      `@qu/app-core`'s kinds.js own "GLOBAL APP CONTENT" doc comment) -
 *      succeeds only if this identity is already listed in that relay's
 *      `QU_RELAY_ADMINS`. The admin console is simply the ONE global app
 *      every deployment conventionally installs at `prefix: 'admin'` - not
 *      a framework special case; the exact same call installs any OTHER
 *      global app too, given a different bundle/prefix.
 *   2. ONE `qu-platform-apps` alias (`registerApp()`) mapping the chosen
 *      prefix (`"admin"` by default) to `realm: 'global'` - succeeds under
 *      the exact SAME condition (`qu-platform-apps` is also `acl.write:
 *      'relay-admins'`, checked against that exact list - see
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
import { installGlobalAppBundle, registerApp } from '@qu/app-core';
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
  console.log(`Add this identity to QU_RELAY_ADMINS as "${QuCrypto.toBase64(identity.signingPub)}"`);

  console.log(`\nConnecting to the main Space at ${relay} …`);
  const transport = new WsClientTransport(relay, { WebSocketImpl: WebSocket });
  await transport.connect();
  const space = new Space({ identity, members: [{ pub: identity.signingPub, xPub: identity.xPublicKey }], relayAdmins: [identity.signingPub], transport });
  console.log('Installing the built-in admin console content…');
  await installGlobalAppBundle(space, prefix, adminConsoleBundle);
  console.log(`Registering the "${prefix}" alias…`);
  await registerApp(space, { prefix, name, realm: 'global' });
  await new Promise((resolve) => setTimeout(resolve, 300)); // let the writes actually leave before closing.
  transport.close();

  console.log(`\n✅ Installiert. Öffne #/${prefix} als diese Identity, um die Konsole zu sehen.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
