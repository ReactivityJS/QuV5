#!/usr/bin/env node
/**
 * GRANT APP ACCESS — the actual, self-service fix for "why do I have to
 * import the app-admin's private key into my browser just to edit its
 * content?" (a real question this script exists to answer, not dodge):
 * Node ownership for `'content'`-ACL Kinds (`qu-page`/`qu-template`/
 * `qu-style`) is CRYPTOGRAPHIC and permanent - the owner is whichever
 * identity's pubkey the content's own Node id was derived from at
 * CREATION time (`deriveContentNodeId(ownerPub, kind, path)`,
 * `@qu/app-core`'s `dev.js`), never something a config change or a
 * `registerApp()` re-alias can retroactively transfer. Listing a DIFFERENT
 * identity as a relay-admin, or even as that app's own `appAdminPub` in
 * `qu-platform-apps`, changes nothing about who the RELAY's write-ACL
 * check (`grants.get(nodeId)?.has(signerPub)`, `@qu/space-transport`'s
 * relay.js) actually authorizes - only the ORIGINAL owner (or someone that
 * owner has explicitly `grantContentWriter()`ed) can ever write to an
 * ALREADY-EXISTING page/template/style. There is no way around this that
 * doesn't involve the owner's private key at least ONCE - either by
 * importing it directly into a browser (fine for a quick test, a real
 * anti-pattern for ongoing use - sharing a private key at all is a smell),
 * or by running THIS script once, connecting AS that identity (`--dir`,
 * wherever your own install script persisted it - the SAME single-
 * file-per-identity directory convention `bootstrap-platform.mjs`/
 * `install-admin-console.mjs` use for THEIR identities, never generates a
 * new one, see `loadIdentity()` below), to grant a DIFFERENT identity
 * (`--to`, that identity's OWN pubkey - they
 * never need to touch the app-admin's private key at all) write access to
 * every currently-published page/template/style. After this runs once,
 * `--to`'s own identity can use `#/<prefix>/cms` with its OWN key, forever
 * (grants don't expire) - `cms-actions.js`'s own `ownerPub` threading
 * (a separate, earlier fix) is what actually makes a grantee's save target
 * the right Node once granted; this script is the missing "grant it in the
 * first place" half, previously only reachable by writing a Dev API script
 * by hand.
 *
 * Grants only EXISTING content - `grantContentWriter()`, like the write-ACL
 * it configures, is per-Node, not "make X a second app-admin." A page
 * created LATER by anyone other than the app-admin (or `--to`, once
 * granted) is a NEW page owned by whoever created it, not this app's
 * existing content - re-run this script after adding new pages/templates/
 * styles if the same grantee should also maintain those.
 *
 * Only applies to an ORDINARY (`realm: 'main'`) app - a `realm: 'global'`
 * app has no single owner to grant FROM at all, every relay-admin already
 * has full write access by design (see README's "Writing and installing
 * your own app").
 *
 * Usage (both `--dir` and the app-admin's identity inside it must already
 * exist - run whatever installed this app first, e.g. your own install
 * script following README's "Ordinary app" recipe):
 *   node packages/app-shell/bin/grant-app-access.mjs \
 *     --relay wss://your-host --dir ./bootstrap-identity \
 *     --identity app-admin --to <base64 pubkey to grant>
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import { EventBus } from '@qu/events';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { WsClientTransport } from '@qu/space-transport';
import { ContentResolver, grantContentWriter, pageKind, templateKind, styleKind } from '@qu/app-core';

function parseArgs(argv) {
  const opts = { relay: 'ws://localhost:8081', dir: './bootstrap-identity', identity: 'app-admin', to: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--relay') opts.relay = argv[++i];
    else if (argv[i] === '--dir') opts.dir = argv[++i];
    else if (argv[i] === '--identity') opts.identity = argv[++i];
    else if (argv[i] === '--to') opts.to = argv[++i];
  }
  return opts;
}

/** UNLIKE `bootstrap-platform.mjs`/`install-admin-console.mjs`'s own `ensureIdentity()`, this NEVER generates a new keypair - granting access only makes sense for an app-admin identity that already exists and already owns content; silently creating a fresh one here would grant access from an empty, unrelated identity instead of failing loudly. */
async function loadIdentity(dir, name) {
  const file = join(dir, `${name}.json`);
  let raw;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`No identity found at ${file} - this script only grants access for an app-admin identity that already exists (run whatever installed this app first, e.g. bootstrap-platform.mjs).`);
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
  const { relay, dir, identity: identityName, to } = parseArgs(process.argv.slice(2));
  if (!to) {
    console.error('Usage: node grant-app-access.mjs --relay wss://your-host --dir ./bootstrap-identity --identity app-admin --to <base64 pubkey>');
    process.exitCode = 1;
    return;
  }

  const identity = await loadIdentity(dir, identityName);
  const granteePub = QuCrypto.fromBase64(to);
  console.log(`Qu V5 — grant app access: "${identityName}" [${await QuCrypto.fingerprint(identity.signingPub)}] grants "${await QuCrypto.fingerprint(granteePub)}"`);

  console.log(`\nConnecting to the main Space at ${relay} …`);
  const transport = new WsClientTransport(relay, { WebSocketImpl: WebSocket });
  await transport.connect();
  const bus = new EventBus();
  const space = new Space({ identity, members: [{ pub: identity.signingPub, xPub: identity.xPublicKey }], transport, bus });
  const writes = trackWrites(bus);

  const resolver = new ContentResolver(space, { appAdminPub: identity.signingPub });
  const [routes, templates, styles] = await Promise.all([
    resolver.resolveRoutes({ timeout: 2000 }),
    resolver.resolveTemplateNames({ timeout: 2000 }),
    resolver.resolveStyleNames({ timeout: 2000 }),
  ]);

  if (routes.length === 0 && templates.length === 0 && styles.length === 0) {
    console.log(`\n⚠ "${identityName}" has no published routes/templates/styles to grant access to - nothing to do (an unpublished page still exists, just not enumerable this way - grant it directly with @qu/app-core's grantContentWriter() if needed).`);
  }

  for (const { route } of routes) {
    console.log(`  granting page "${route}"…`);
    await grantContentWriter(space, { kind: pageKind, path: route, granteePub });
  }
  for (const { name } of templates) {
    console.log(`  granting template "${name}"…`);
    await grantContentWriter(space, { kind: templateKind, path: name, granteePub });
  }
  for (const { name } of styles) {
    console.log(`  granting style "${name}"…`);
    await grantContentWriter(space, { kind: styleKind, path: name, granteePub });
  }

  const ok = await waitUntilAllWritesAcked(writes);
  transport.close();

  if (!ok) {
    console.log('\n⚠ Some grants were never write-acked by the relay - it is reachable, but this identity may not actually be recognized there (or the relay is unreachable for this Kind). Nothing here was necessarily granted - verify before relying on it.');
    process.exitCode = 1;
    return;
  }

  console.log(`\n✅ Granted. "${to}" can now use #/<prefix>/cms with its OWN identity - no need to ever import "${identityName}"'s private key.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
