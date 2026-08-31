#!/usr/bin/env node
/**
 * QU APP SHELL RELAY SERVER — a standalone, PRODUCTION relay that serves
 * `@qu/app-shell` (docs/app-shell-arbeitsauftrag.md §3) instead of any
 * hardcoded app - the generic-app counterpart to
 * `@qu/space-transport`'s own `relay-server.js` (which still serves
 * `demo/web/`'s hardcoded chat demo, completely UNCHANGED by this file -
 * see "WHY A SEPARATE ENTRYPOINT" below). Run directly, or via this
 * package's own `Dockerfile`.
 *
 * Wired the same way `relay-server.js` is (`createWsServerHub` +
 * `createFileStore` + `createRelayForwarder` + `createAppRequestHandler`),
 * with two differences:
 *
 *   1. `resolveKindSchema` is `@qu/app-core`'s `createAppResolveKindSchema()`
 *      once `QU_APP_ADMIN_PUB` is configured - REAL per-Kind ACL
 *      (`qu-app`/`qu-route-registry` self-certifying, `qu-page`/
 *      `qu-template`/`qu-style` `'members'`-mode - see that function's own
 *      doc comment), not `relay-server.js`'s own `() => true` fallback
 *      (that file's own doc comment explains why IT can't do better - no
 *      real Kind-Schema to route by without knowing what app it serves;
 *      this file DOES know, because unlike a generic relay, serving
 *      `@qu/app-shell` is its entire purpose).
 *   2. The served app is a bundled `@qu/app-shell`, with `QU_APP_ADMIN_PUB`
 *      (a PUBLIC key only - see "ADMIN IDENTITY" below) rendered into its
 *      `index.html` at BOOT time via `build.mjs`'s `renderIndexHtml()` -
 *      unlike `relay-server.js`'s own `demo/web` build (a single static
 *      artifact, safe to bake into the image at DOCKER BUILD time), this
 *      HTML is inherently per-deployment (it embeds YOUR app-admin's
 *      pubkey), so it can't be pre-baked the same way - only the JS bundle
 *      (`buildAppShellBundle()`, pubkey-agnostic) is.
 *
 * WHY A SEPARATE ENTRYPOINT, NOT `relay-server.js` ITSELF: `@qu/space-transport`
 * is framework-level - "Relay bleibt Application-blind" is a hard
 * architecture rule (architecture.md §1/§7, docs/app-shell-arbeitsauftrag.md
 * §29) - it must never depend on an application-layer package like
 * `@qu/app-shell`/`@qu/app-core`. This file lives in `@qu/app-shell`
 * instead (the correct dependency direction: the App layer depends on the
 * framework, never the reverse) and simply COMPOSES `@qu/space-transport`'s
 * own public primitives the exact same way `relay-server.js` does - zero
 * framework code changed anywhere for this to exist. It runs as its OWN
 * separate process/container, alongside (not replacing) any existing
 * `relay-server.js` deployment - see this package's own `Dockerfile`.
 *
 * ADMIN IDENTITY (docs/app-shell-arbeitsauftrag.md §19): `QU_APP_ADMIN_PUB`
 * is a PUBLIC key ONLY - this relay never holds, generates, or needs the
 * app-admin's PRIVATE key, exactly like `relay-server.js`'s own
 * `QU_MEMBERS_JSON` never carries private material either. Seeding/editing
 * content is a separate, explicit operation run by whoever DOES hold that
 * key, from their own machine, against this relay's URL - see
 * `@qu/app-core`'s Dev API and `demo/install-app-shell-demo.mjs` (the
 * reference installer, works unmodified against a real deployment via its
 * own `--relay wss://...` flag).
 *
 * Configuration - env vars, no config file, same posture as `relay-server.js`:
 *
 *   QU_RELAY_PORT     - default 8081. Pick a DIFFERENT port than any
 *                        `relay-server.js` instance also running on this
 *                        host - these are two separate relays/Spaces.
 *   QU_RELAY_DATA_DIR - default "/data". Set "" to disable mirroring.
 *   QU_APP_ADMIN_PUB  - Base64 Ed25519 pubkey of the app-admin identity
 *                        whose `qu-app` Manifest this Shell loads (see
 *                        `@qu/app-core`'s `kinds.js`). Without this, the
 *                        relay still starts (never a hard failure - an
 *                        operator should be able to stand up the relay
 *                        FIRST, decide/generate the app-admin identity
 *                        SEPARATELY, same posture `relay-server.js` takes
 *                        with `QU_MEMBERS_JSON`) but serves a plain setup
 *                        page instead of booting any app - see
 *                        `build.mjs`'s `renderIndexHtml()`.
 *   QU_MEMBERS_JSON   - OPTIONAL. Same shape as `relay-server.js`'s own -
 *                        pre-authorize `'members'`-mode writers. The
 *                        app-admin identity itself needs to be IN here (or
 *                        have joined via `QU_ALLOW_JOIN`) before it can
 *                        write `qu-page`/`qu-template`/`qu-style` content -
 *                        see `@qu/app-core`'s `kinds.js` on why those are
 *                        `'members'`-ACL, not self-certifying.
 *   QU_ALLOW_JOIN     - default `true`. Same as `relay-server.js`'s own -
 *                        lets a visiting browser self-register as a
 *                        member, which `'members'`-ACL content needs even
 *                        just to be READ (see `@qu/app-core`'s `kinds.js`
 *                        own documented tradeoff). Set to the exact string
 *                        `"false"` to lock membership to `QU_MEMBERS_JSON` only.
 */
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { QuCrypto } from '@qu/core';
import { EventBus } from '@qu/events';
import { createFileStore } from '@qu/space-storage';
import { createWsServerHub, createRelayForwarder, createAppRequestHandler } from '@qu/space-transport';
import { createAppResolveKindSchema } from '@qu/app-core';
import { buildAppShellBundle, renderIndexHtml } from './build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.QU_RELAY_PORT || 8081);
const DATA_DIR = process.env.QU_RELAY_DATA_DIR ?? '/data';
const ALLOW_JOIN = process.env.QU_ALLOW_JOIN !== 'false';
const APP_ADMIN_PUB_B64 = process.env.QU_APP_ADMIN_PUB || null;
const WEB_DIR = join(HERE, 'dist-web');

let members = [];
const membersJson = process.env.QU_MEMBERS_JSON;
if (membersJson) {
  try {
    members = JSON.parse(membersJson).map((m) => ({ pub: QuCrypto.fromBase64(m.pub), xPub: QuCrypto.fromBase64(m.xPub) }));
  } catch (err) {
    console.error('[qu-app-shell-relay] QU_MEMBERS_JSON is not valid JSON / valid base64 keys:', err.message);
    process.exit(1);
  }
}

async function main() {
  let appAdminPub = null;
  if (APP_ADMIN_PUB_B64) {
    try {
      appAdminPub = QuCrypto.fromBase64(APP_ADMIN_PUB_B64);
      if (appAdminPub.length !== 32) throw new Error('expected 32 raw bytes');
    } catch (err) {
      console.error('[qu-app-shell-relay] QU_APP_ADMIN_PUB is not a valid base64 Ed25519 pubkey:', err.message);
      process.exit(1);
    }
  }

  console.log('[qu-app-shell-relay] bundling @qu/app-shell…');
  // createAppRequestHandler()'s STATIC_FILES map (@qu/space-transport's relay-app-server.js) always
  // serves /bundle.js from "<webDir>/dist/bundle.js" - the SAME convention demo/web/'s own build
  // uses - so the bundle goes under WEB_DIR/dist, not WEB_DIR itself.
  const { outfile } = await buildAppShellBundle({ outDir: join(WEB_DIR, 'dist') });
  await writeFile(join(WEB_DIR, 'index.html'), renderIndexHtml({ appAdminPub }), 'utf8');
  console.log(`[qu-app-shell-relay] bundled -> ${outfile}`);
  if (!appAdminPub) {
    console.warn(
      '[qu-app-shell-relay] QU_APP_ADMIN_PUB is not set - serving a setup page instead of an app. See this file\'s own doc comment.'
    );
  }

  const storage = DATA_DIR ? createFileStore(DATA_DIR) : null;
  const bus = new EventBus();
  const resolveKindSchema = appAdminPub ? await createAppResolveKindSchema({ appAdminPub }) : () => true;

  const httpServer = createServer((req, res) => handleRequest(req, res));
  const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: true });
  const hub = createWsServerHub(wss);
  const relay = createRelayForwarder({ hub, members, resolveKindSchema, storage, bus });
  const handleAppRequest = createAppRequestHandler({ webDir: WEB_DIR, members, relay, allowJoin: ALLOW_JOIN, log: console.log });

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

  httpServer.listen(PORT, () => {
    const mirrorNote = storage ? `mirroring to ${DATA_DIR}` : 'NO mirroring (live-only, QU_RELAY_DATA_DIR is empty)';
    const appNote = appAdminPub ? `serving app-admin ${APP_ADMIN_PUB_B64}` : 'NO app configured (QU_APP_ADMIN_PUB unset - see /)';
    console.log(`[qu-app-shell-relay] listening on :${PORT} - ${appNote}, ${mirrorNote}`);
    console.log(`[qu-app-shell-relay] open http://localhost:${PORT}/ in a browser - join is ${ALLOW_JOIN ? 'OPEN to anyone (QU_ALLOW_JOIN=false to lock it down)' : 'DISABLED (QU_ALLOW_JOIN=false)'}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
