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
 *                        `@qu/app-core`'s `kinds.js`) - SINGLE-APP mode.
 *                        Ignored if `QU_RELAY_ADMIN_PUB` is also set (see
 *                        below). Without either, the relay still starts
 *                        (never a hard failure - an operator should be able
 *                        to stand up the relay FIRST, decide/generate the
 *                        admin identity SEPARATELY, same posture
 *                        `relay-server.js` takes with `QU_MEMBERS_JSON`) but
 *                        serves a plain setup page instead of booting any
 *                        app - see `build.mjs`'s `renderIndexHtml()`.
 *   QU_RELAY_ADMIN_PUB - Base64 Ed25519 pubkey of the identity that OWNS
 *                        the `qu-platform-apps` alias registry (docs
 *                        §19-21) - PLATFORM mode: takes priority over
 *                        `QU_APP_ADMIN_PUB`. This identity can register
 *                        path-prefix aliases for any already-installed app
 *                        (`registerApp()`), including the built-in admin
 *                        realm's own console under whatever prefix the
 *                        bootstrap installer chose (conventionally
 *                        `"admin"` - see "ADMIN REALM" below). Each
 *                        ORDINARY (non-admin-realm) app-admin's OWN pubkey
 *                        separately needs to be added to `QU_APP_ADMIN_PUBS`
 *                        below and the relay restarted - registering the
 *                        app-admin PUBKEY there is what grants their
 *                        write-ACL; a `qu-platform-apps` registration here
 *                        only maps a path prefix to a pubkey the relay is
 *                        already willing to trust.
 *   QU_APP_ADMIN_PUBS - OPTIONAL, PLATFORM mode only. JSON array of base64
 *                        Ed25519 pubkeys - every ORDINARY app-admin identity
 *                        this relay should accept `qu-app`/
 *                        `qu-route-registry`/content writes from (see
 *                        `@qu/app-core`'s `createAppResolveKindSchema()`
 *                        doc comment on why this has to be a STATIC,
 *                        boot-time list rather than live-discovered from
 *                        the relay-admin's own `qu-platform-apps`
 *                        registry). Irrelevant to the admin realm itself
 *                        (see `QU_RELAY_ADMIN_MEMBERS_JSON` below).
 *   QU_MEMBERS_JSON   - OPTIONAL. Same shape as `relay-server.js`'s own -
 *                        pre-authorize `'members'`-mode writers on the
 *                        MAIN, public Space. The app-admin identity itself
 *                        needs to be IN here (or have joined via
 *                        `QU_ALLOW_JOIN`) before it can write
 *                        `qu-page`/`qu-template`/`qu-style` content - see
 *                        `@qu/app-core`'s `kinds.js` on why those are
 *                        `'members'`-ACL, not self-certifying.
 *   QU_ALLOW_JOIN     - default `true`. Same as `relay-server.js`'s own -
 *                        lets a visiting browser self-register as a
 *                        MAIN-Space member, which `'members'`-ACL content
 *                        needs even just to be READ (see `@qu/app-core`'s
 *                        `kinds.js` own documented tradeoff). Set to the
 *                        exact string `"false"` to lock membership to
 *                        `QU_MEMBERS_JSON` only. NEVER applies to the
 *                        admin realm below - that one has no self-join at
 *                        all, on purpose.
 *
 * ADMIN REALM (architecture.md §7's "The Platform layer", revised - a
 * genuinely CONFIDENTIAL counterpart to the ordinary, `QU_ALLOW_JOIN`-
 * open MAIN Space above, not just a UI-gated view of it): a wholly SEPARATE
 * relay-forwarder instance, its own flat `members` list, multiplexed onto
 * this SAME HTTP server/port at a distinct WebSocket path (`/admin-ws`, via
 * `WebSocketServer({noServer:true})` + manual `httpServer.on('upgrade', …)`
 * routing by `req.url` - `@qu/space-transport`'s `createWsServerHub()`
 * itself needs no change, it only ever needed an already-constructed
 * `WebSocketServer`). `'encrypted'`-visibility content on THIS Space
 * (`@qu/app-core`'s `qu-admin-*` Kinds, kinds.js's own "THE ADMIN REALM"
 * doc comment) is sealed for exactly this flat member list - an ordinary
 * visitor of the MAIN Space is never a member here, so can never decrypt
 * anything here either, not even with this relay's own cooperation (the
 * relay never holds an X25519 private key - see `@qu/space-core`'s
 * envelope.js). No `QU_ALLOW_JOIN`-equivalent exists for it - admin
 * membership is ALWAYS a static, boot-time list, the same operational
 * posture `QU_MEMBERS_JSON`/`QU_APP_ADMIN_PUBS` above already take, just
 * with no opt-in self-registration path at all (an admin realm that let
 * anyone self-join would defeat its entire point).
 *
 *   QU_RELAY_ADMIN_MEMBERS_JSON - OPTIONAL. JSON array of
 *                        `{pub, xPub}` (base64) - every identity trusted as
 *                        an admin (able to read/write the admin realm's own
 *                        content - `acl.write: 'members'` there means ANY
 *                        member manages it, there is no single "owner",
 *                        see kinds.js's own doc comment). Empty/unset means
 *                        the admin realm still starts (so it CAN be
 *                        bootstrapped - see `bin/install-admin-console.mjs`)
 *                        but nobody can decrypt anything written to it yet;
 *                        add the bootstrapping identity's `{pub, xPub}`
 *                        here before running that installer.
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
import { createAppResolveKindSchema, createAdminResolveKindSchema } from '@qu/app-core';
import { buildAppShellBundle, renderIndexHtml } from './build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.QU_RELAY_PORT || 8081);
const DATA_DIR = process.env.QU_RELAY_DATA_DIR ?? '/data';
const ALLOW_JOIN = process.env.QU_ALLOW_JOIN !== 'false';
const APP_ADMIN_PUB_B64 = process.env.QU_APP_ADMIN_PUB || null;
const RELAY_ADMIN_PUB_B64 = process.env.QU_RELAY_ADMIN_PUB || null;
const APP_ADMIN_PUBS_JSON = process.env.QU_APP_ADMIN_PUBS || null;
const RELAY_ADMIN_MEMBERS_JSON = process.env.QU_RELAY_ADMIN_MEMBERS_JSON || null;
const WEB_DIR = join(HERE, 'dist-web');
const ADMIN_WS_PATH = '/admin-ws';

function parseMembersJson(label, json) {
  try {
    return JSON.parse(json).map((m) => ({ pub: QuCrypto.fromBase64(m.pub), xPub: QuCrypto.fromBase64(m.xPub) }));
  } catch (err) {
    console.error(`[qu-app-shell-relay] ${label} is not valid JSON / valid base64 keys:`, err.message);
    process.exit(1);
  }
}

let members = [];
if (process.env.QU_MEMBERS_JSON) members = parseMembersJson('QU_MEMBERS_JSON', process.env.QU_MEMBERS_JSON);

let adminMembers = [];
if (RELAY_ADMIN_MEMBERS_JSON) adminMembers = parseMembersJson('QU_RELAY_ADMIN_MEMBERS_JSON', RELAY_ADMIN_MEMBERS_JSON);

function parsePub(label, b64) {
  try {
    const pub = QuCrypto.fromBase64(b64);
    if (pub.length !== 32) throw new Error('expected 32 raw bytes');
    return pub;
  } catch (err) {
    console.error(`[qu-app-shell-relay] ${label} is not a valid base64 Ed25519 pubkey:`, err.message);
    process.exit(1);
  }
}

async function main() {
  const appAdminPub = APP_ADMIN_PUB_B64 ? parsePub('QU_APP_ADMIN_PUB', APP_ADMIN_PUB_B64) : null;
  const relayAdminPub = RELAY_ADMIN_PUB_B64 ? parsePub('QU_RELAY_ADMIN_PUB', RELAY_ADMIN_PUB_B64) : null;

  let appAdminPubs = [];
  if (APP_ADMIN_PUBS_JSON) {
    try {
      appAdminPubs = JSON.parse(APP_ADMIN_PUBS_JSON).map((b64) => parsePub('QU_APP_ADMIN_PUBS', b64));
    } catch (err) {
      console.error('[qu-app-shell-relay] QU_APP_ADMIN_PUBS is not valid JSON:', err.message);
      process.exit(1);
    }
  }

  console.log('[qu-app-shell-relay] bundling @qu/app-shell…');
  // createAppRequestHandler()'s STATIC_FILES map (@qu/space-transport's relay-app-server.js) always
  // serves /bundle.js from "<webDir>/dist/bundle.js" - the SAME convention demo/web/'s own build
  // uses - so the bundle goes under WEB_DIR/dist, not WEB_DIR itself.
  const { outfile } = await buildAppShellBundle({ outDir: join(WEB_DIR, 'dist') });
  await writeFile(join(WEB_DIR, 'index.html'), renderIndexHtml({ appAdminPub, relayAdminPub }), 'utf8');
  console.log(`[qu-app-shell-relay] bundled -> ${outfile}`);
  if (!appAdminPub && !relayAdminPub) {
    console.warn(
      '[qu-app-shell-relay] neither QU_APP_ADMIN_PUB nor QU_RELAY_ADMIN_PUB is set - serving a setup page instead of an app. See this file\'s own doc comment.'
    );
  }

  const storage = DATA_DIR ? createFileStore(DATA_DIR) : null;
  const bus = new EventBus();
  const resolveKindSchema =
    appAdminPub || relayAdminPub || appAdminPubs.length > 0
      ? await createAppResolveKindSchema({ appAdminPub, appAdminPubs, relayAdminPub })
      : () => true;

  const httpServer = createServer((req, res) => handleRequest(req, res));

  // MAIN hub - the ordinary, open-join Space (unchanged from before the admin realm existed).
  const mainWss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
  const mainHub = createWsServerHub(mainWss);
  const relay = createRelayForwarder({ hub: mainHub, members, resolveKindSchema, storage, bus });
  const handleAppRequest = createAppRequestHandler({ webDir: WEB_DIR, members, relay, allowJoin: ALLOW_JOIN, log: console.log });

  // ADMIN hub - a wholly separate Space/relay-forwarder, its OWN flat `adminMembers` list, never
  // open-join (no /admin-join endpoint - see this file's own "ADMIN REALM" doc comment), reached at
  // a distinct WS path on the SAME port via manual upgrade routing below.
  const adminWss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
  const adminHub = createWsServerHub(adminWss);
  const adminStorage = DATA_DIR ? createFileStore(join(DATA_DIR, 'admin-realm')) : null;
  const adminResolveKindSchema = await createAdminResolveKindSchema();
  createRelayForwarder({ hub: adminHub, members: adminMembers, resolveKindSchema: adminResolveKindSchema, storage: adminStorage, bus: new EventBus() });

  httpServer.on('upgrade', (req, socket, head) => {
    const wss = req.url === ADMIN_WS_PATH ? adminWss : mainWss;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  function handleRequest(req, res) {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.method === 'GET' && req.url === '/admin-members.json') {
      const list = adminMembers.map((m) => ({ pub: QuCrypto.toBase64(m.pub), xPub: QuCrypto.toBase64(m.xPub) }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(list));
      return;
    }
    if (handleAppRequest(req, res)) return;
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }

  httpServer.listen(PORT, () => {
    const mirrorNote = storage ? `mirroring to ${DATA_DIR}` : 'NO mirroring (live-only, QU_RELAY_DATA_DIR is empty)';
    const appNote = relayAdminPub
      ? `PLATFORM mode, relay-admin ${RELAY_ADMIN_PUB_B64}, ${appAdminPubs.length} known app-admin(s), ${adminMembers.length} admin-realm member(s)`
      : appAdminPub
        ? `serving app-admin ${APP_ADMIN_PUB_B64}`
        : 'NO app configured (QU_APP_ADMIN_PUB / QU_RELAY_ADMIN_PUB unset - see /)';
    console.log(`[qu-app-shell-relay] listening on :${PORT} - ${appNote}, ${mirrorNote}`);
    console.log(`[qu-app-shell-relay] open http://localhost:${PORT}/ in a browser - join is ${ALLOW_JOIN ? 'OPEN to anyone (QU_ALLOW_JOIN=false to lock it down)' : 'DISABLED (QU_ALLOW_JOIN=false)'}`);
    console.log(`[qu-app-shell-relay] admin realm WS at ${ADMIN_WS_PATH} - membership is static (QU_RELAY_ADMIN_MEMBERS_JSON), no self-join.`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
