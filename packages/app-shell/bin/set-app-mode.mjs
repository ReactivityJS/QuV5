#!/usr/bin/env node
/**
 * SET APP MODE — the exact, scriptable way to flip a `realm: 'global'`
 * app's administrable state (kinds.js's own doc comment on `'off'`/
 * `'global'`/`'multiuser'`) from the command line, instead of clicking the
 * admin console's own mode buttons (`admin-actions.js`) by hand. Two jobs,
 * either usable alone:
 *
 *   1. NO `--prefix`/`--mode` given: just LISTS every currently registered
 *      app - prefix, realm, mode, owner - so you can actually find the
 *      right PREFIX before touching anything ("wie komme ich auf den
 *      richtigen Prefix?" - there is no separate "space" to look up: this
 *      whole platform lives in ONE relay Space, and `qu-platform-apps` -
 *      what this prints - is the ONE registry naming every app in it).
 *   2. BOTH given: calls `@qu/app-core`'s `setAppMode()` to change that
 *      app's mode, using the SAME relay-admin identity directory
 *      `bootstrap-platform.mjs` already created (`--dir`, `--identity`,
 *      defaulting to exactly what that script uses) - no separate identity
 *      to generate, no separate "app space" to connect to.
 *
 * EXACT EXAMPLE - deploying the built-in "cms" app as `multiuser` (it
 * already registers this way by default via `bootstrap-platform.mjs`, so
 * this is what you'd run to flip it BACK if an operator had turned it
 * `'global'`-only, or to do the same for a DIFFERENT app you registered
 * yourself under a different prefix):
 *
 *   # 1. Find the right prefix - lists every registered app in this relay's ONE Space:
 *   node packages/app-shell/bin/set-app-mode.mjs \
 *     --relay wss://your-host --dir ./bootstrap-identity
 *   #   -> #/cms       realm=global   mode=multiuser   (CMS)
 *   #   -> #/admin     realm=global   mode=global       (Relay-Admin)
 *
 *   # 2. Flip "cms" to multiuser (a no-op if it already is - setAppMode() is idempotent,
 *   #    it just pushes a newer state entry - see dev.js's own doc comment):
 *   node packages/app-shell/bin/set-app-mode.mjs \
 *     --relay wss://your-host --dir ./bootstrap-identity --prefix cms --mode multiuser
 *
 * `--dir` MUST already contain a relay-admin identity - this script, like
 * `grant-app-access.mjs`, NEVER generates one (see `loadIdentity()` below);
 * run `bootstrap-platform.mjs` first if you haven't.
 *
 * Usage:
 *   node packages/app-shell/bin/set-app-mode.mjs \
 *     --relay wss://your-host --dir ./bootstrap-identity \
 *     [--identity relay-admin] [--prefix <prefix> --mode off|global|multiuser]
 */
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { EventBus } from '@qu/events';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { WsClientTransport } from '@qu/space-transport';
import { PlatformRuntime, setAppMode } from '@qu/app-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = join(HERE, '..', '.platform-identities'); // the SAME default bootstrap-platform.mjs uses.

function parseArgs(argv) {
  const opts = { relay: 'ws://localhost:8081', dir: DEFAULT_DIR, identity: 'relay-admin', prefix: null, mode: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--relay') opts.relay = argv[++i];
    else if (argv[i] === '--dir') opts.dir = argv[++i];
    else if (argv[i] === '--identity') opts.identity = argv[++i];
    else if (argv[i] === '--prefix') opts.prefix = argv[++i];
    else if (argv[i] === '--mode') opts.mode = argv[++i];
  }
  return opts;
}

/** Same "never generate, only load" posture as `grant-app-access.mjs`'s own `loadIdentity()` - see that file's own doc comment on why. */
async function loadIdentity(dir, name) {
  const file = join(dir, `${name}.json`);
  let raw;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`No identity found at ${file} - this script only changes an app's mode as an EXISTING relay-admin identity (run bootstrap-platform.mjs first, or pass --dir/--identity pointing at yours).`);
    }
    throw err;
  }
  return {
    signingKey: QuCrypto.fromBase64(raw.signingKey),
    signingPub: QuCrypto.fromBase64(raw.signingPub),
    xPrivateKey: QuCrypto.fromBase64(raw.xPrivateKey),
    xPublicKey: QuCrypto.fromBase64(raw.xPublicKey),
  };
}

/** See `bootstrap-platform.mjs`'s own identical helper's doc comment - same "sealing is async, don't trust a resolved write alone" reasoning. */
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

async function main() {
  const { relay, dir, identity: identityName, prefix, mode } = parseArgs(process.argv.slice(2));

  if ((prefix && !mode) || (!prefix && mode)) {
    console.error('Usage: pass BOTH --prefix and --mode to change one app, or NEITHER to just list every registered app.');
    process.exitCode = 1;
    return;
  }
  if (mode && !['off', 'global', 'multiuser'].includes(mode)) {
    console.error(`Invalid --mode "${mode}" - must be one of: off, global, multiuser.`);
    process.exitCode = 1;
    return;
  }

  const identity = await loadIdentity(dir, identityName);
  console.log(`Qu V5 — set app mode: "${identityName}" [${await QuCrypto.fingerprint(identity.signingPub)}]`);

  console.log(`\nConnecting to the main Space at ${relay} …`);
  const transport = new WsClientTransport(relay, { WebSocketImpl: WebSocket });
  await transport.connect();
  const bus = new EventBus();
  const relayAdmins = [identity.signingPub];
  const space = new Space({ identity, members: [{ pub: identity.signingPub, xPub: identity.xPublicKey }], relayAdmins, transport, bus });
  const writes = trackWrites(bus);

  const platform = new PlatformRuntime(space);
  const apps = await platform.resolveApps({ timeout: 2000 });

  if (!prefix) {
    // JOB 1: just list what's there - this IS "wie komme ich auf den richtigen Prefix" answered:
    // there is no separate per-app "space" to look up, `qu-platform-apps` (what this reads) is the
    // one registry naming every app in this relay's one and only Space.
    console.log(`\n${apps.length} app(s) registered:\n`);
    for (const app of apps) {
      const realm = app.realm ?? 'main';
      const modeCol = realm === 'global' ? `mode=${app.mode ?? 'global'}` : '(single-owner, no mode)';
      const owner = realm === 'global' ? '' : `  owner=${app.appAdminPub ? QuCrypto.toBase64(app.appAdminPub) : '?'}`;
      console.log(`  #/${app.prefix.padEnd(12)} realm=${realm.padEnd(7)} ${modeCol.padEnd(24)} (${app.name ?? '(unbenannt)'})${owner}`);
    }
    if (apps.length === 0) console.log('  (none - run bootstrap-platform.mjs first)');
    console.log('\nRe-run with --prefix <one of the above> --mode off|global|multiuser to change one.');
    transport.close();
    process.exit(0);
    return;
  }

  // JOB 2: change one.
  const current = apps.find((a) => a.prefix === prefix);
  if (!current) {
    console.error(`\n❌ "#/${prefix}" is not a registered app on this relay - see the list above (re-run without --prefix/--mode) for what IS.`);
    transport.close();
    process.exitCode = 1;
    return;
  }
  if ((current.realm ?? 'main') !== 'global') {
    console.error(`\n❌ "#/${prefix}" is realm "${current.realm ?? 'main'}" - mode only applies to realm:'global' apps (kinds.js's own doc comment). A single-owner app has no relay-wide on/off/multiuser switch - it is administered entirely by its own app-admin identity.`);
    transport.close();
    process.exitCode = 1;
    return;
  }

  console.log(`\n"#/${prefix}" is currently mode="${current.mode ?? 'global'}" - setting it to mode="${mode}"…`);
  await setAppMode(space, { prefix, mode });

  const ok = await waitUntilAllWritesAcked(writes);
  transport.close();

  if (!ok) {
    console.log(`\n⚠ The write was never write-acked by the relay - it is reachable, but "${identityName}" may not actually be a configured relay-admin there (QU_RELAY_ADMINS). Nothing here was necessarily changed - verify before relying on it.`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n✅ "#/${prefix}" is now mode="${mode}".`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
