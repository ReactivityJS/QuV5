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
 *   1. ONE `qu-platform-apps` alias (`registerApp()`) mapping the chosen
 *      prefix (`"admin"` by default) to `realm: 'global'` - succeeds only
 *      if this identity is already listed in that relay's `QU_RELAY_ADMINS`
 *      (`qu-platform-apps` is `acl.write: 'relay-admins'` - see
 *      `@qu/space-core`'s kind-schema.js own doc comment on the mode);
 *   2. its own route(s) (`publishGlobalRoute()`, `adminRouteRegistryKind`) -
 *      REQUIRED, not cosmetic: `@qu/app-shell`'s own `live-app-resolver.js`
 *      only classifies a global app's PAGE writes correctly once it has
 *      observed the route here (the exact same requirement any OTHER
 *      global app's pages now have - this file used to skip it, a real,
 *      fixed regression, see that file's own doc comment);
 *   3. the built-in admin console's own content (`installGlobalAppBundle()`,
 *      `admin-console-bundle.js`, `acl.write: 'relay-admins'` - see
 *      `@qu/app-core`'s kinds.js own "GLOBAL APP CONTENT" doc comment) -
 *      succeeds under the exact SAME condition. The admin console is
 *      simply the ONE global app every deployment conventionally installs
 *      at `prefix: 'admin'` - not a framework special case; the exact same
 *      call installs any OTHER global app too, given a different
 *      bundle/prefix.
 *
 * ORDER MATTERS - each step needs the RELAY to have already observed the
 * previous one before the next write lands, or it gets silently
 * misclassified against the generic `'content'`-ACL fallback and rejected
 * (the exact same "register/publish before seeding" reasoning
 * `bootstrap-platform.mjs`'s own doc comment documents for a brand-new
 * app-admin) - hence the settle delays between steps below.
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
import { EventBus } from '@qu/events';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { WsClientTransport } from '@qu/space-transport';
import { installGlobalAppBundle, registerApp, publishGlobalRoute } from '@qu/app-core';
import { adminConsoleBundle } from '../admin-console-bundle.js';

/**
 * Tracks every LOCAL write this Space issues and whether the relay actually
 * write-acked it - the EXACT same helper `bootstrap-platform.mjs` uses (see
 * that file's own doc comment on why this matters: sealing is async, `await
 * write()` alone only proves the LOCAL Y.Doc mutation happened, never that
 * the relay accepted it). A real, observed failure mode this exists to
 * catch: if this identity isn't (yet) actually listed in the RUNNING
 * relay's `QU_RELAY_ADMINS` (redeployed with a config that doesn't match
 * this `--dir`'s identity, or not redeployed with the new config at all -
 * a plain process restart does NOT re-read env vars), every `relay-admins`-
 * ACL write here is silently REJECTED - this script used to just print
 * "✅ Installiert." regardless, the exact "stillschweigend... die Seite ist
 * anschließend nicht verfügbar" failure mode this whole engagement started
 * from, just one level up (this SCRIPT silently lying about success,
 * instead of the relay silently dropping a write the script correctly
 * reported).
 */
function trackWrites(bus) {
  const state = { expected: 0, acked: 0 };
  bus.on('debug.space.write.local', () => state.expected++);
  bus.on('space.node.*.write-ack', () => state.acked++);
  return state;
}

async function waitUntilAllWritesAcked(state, { timeout = 5000, settle = 300, interval = 20 } = {}) {
  await new Promise((resolve) => setTimeout(resolve, settle));
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (state.acked >= state.expected) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return false;
}

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
  const bus = new EventBus();
  const space = new Space({ identity, members: [{ pub: identity.signingPub, xPub: identity.xPublicKey }], relayAdmins: [identity.signingPub], transport, bus });
  const writes = trackWrites(bus);

  console.log(`Registering the "${prefix}" alias…`);
  await registerApp(space, { prefix, name, realm: 'global' });
  await new Promise((resolve) => setTimeout(resolve, 1000)); // let the relay's live resolver observe the new prefix and start watching its route registry.

  console.log('Publishing its route(s)…');
  await publishGlobalRoute(space, prefix, { route: '/', title: name });
  await new Promise((resolve) => setTimeout(resolve, 1000)); // let the relay observe the new route before the page content write follows.

  console.log('Installing the built-in admin console content…');
  await installGlobalAppBundle(space, prefix, adminConsoleBundle);

  const ok = await waitUntilAllWritesAcked(writes);
  transport.close();

  if (!ok) {
    console.log('\n⚠ Some writes were never write-acked by the relay - it is reachable, but this identity is NOT');
    console.log('  (yet) actually configured as a relay-admin there (a relay ignores QU_RELAY_ADMINS changes');
    console.log('  until it is actually (re)started with it - a plain restart of an already-running process/');
    console.log('  container does NOT re-read it by itself, the process/container needs to be RECREATED with');
    console.log('  the new config). The console will look "installed" above but #/' + prefix + ' will 404 or show');
    console.log('  stale/partial content, since some or all of its writes above never actually reached the relay.');
    console.log(`\nAdd this identity to QU_RELAY_ADMINS as "${QuCrypto.toBase64(identity.signingPub)}", redeploy the`);
    console.log('relay with that config, then re-run this exact command - it reuses this same identity and finishes.');
    process.exitCode = 1;
    return;
  }

  console.log(`\n✅ Installiert. Öffne #/${prefix} als diese Identity, um die Konsole zu sehen.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
