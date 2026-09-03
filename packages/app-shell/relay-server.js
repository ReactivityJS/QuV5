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
 *                        Ignored if `QU_RELAY_ADMINS` is also set (see
 *                        below). Without either, the relay still starts
 *                        (never a hard failure - an operator should be able
 *                        to stand up the relay FIRST, decide/generate the
 *                        admin identity SEPARATELY, same posture
 *                        `relay-server.js` takes with `QU_MEMBERS_JSON`) but
 *                        serves a plain setup page instead of booting any
 *                        app - see `build.mjs`'s `renderIndexHtml()`.
 *   QU_RELAY_ADMINS   - JSON array of `{pub, xPub}` (base64) - PLATFORM
 *                        mode (takes priority over `QU_APP_ADMIN_PUB`): the
 *                        ONE static, boot-time-configured list this whole
 *                        deployment needs. Every listed identity, equally
 *                        and symmetrically (no single distinguished
 *                        "owner"), may:
 *                          (a) write `qu-platform-apps` - register/manage
 *                              path-prefix aliases for any already-
 *                              installed app (`registerApp()`), including
 *                              the built-in admin realm's own console
 *                              under whatever prefix the bootstrap
 *                              installer chose (conventionally `"admin"` -
 *                              see "ADMIN REALM" below) - see
 *                              `@qu/app-core`'s `kinds.js` own doc comment
 *                              on `platformAppsKind`'s `'relay-admins'`
 *                              ACL mode, and
 *                          (b) read/write the confidential admin realm's
 *                              own content (`acl.write: 'members'` there,
 *                              checked against exactly this SAME list -
 *                              see "ADMIN REALM" below) - `xPub` matters
 *                              for THIS half only (encryption recipients),
 *                              (a) only ever needs the signing `pub`.
 *                        Registering an ORDINARY (non-relay-admin)
 *                        app-admin needs NO separate static list and NO
 *                        relay restart any more: any configured relay-admin
 *                        simply calls `registerApp()` (e.g. through the
 *                        built-in admin console) with that app-admin's
 *                        pubkey - this relay watches `qu-platform-apps`
 *                        itself (`@qu/app-shell`'s own
 *                        `live-app-resolver.js`) and reclassifies their
 *                        `qu-app`/registry Nodes automatically, typically
 *                        within the time one ordinary write takes to sync.
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
 * relay-forwarder instance, its own flat `members` list (the SAME
 * `QU_RELAY_ADMINS` list above), multiplexed onto this SAME HTTP
 * server/port at a distinct WebSocket path (`/admin-ws`, via
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
 * posture `QU_MEMBERS_JSON` above already takes, just with no opt-in
 * self-registration path at all (an admin realm that let anyone self-join
 * would defeat its entire point). Empty/unset `QU_RELAY_ADMINS` means the
 * admin realm still starts (so it CAN be bootstrapped - see
 * `bin/install-admin-console.mjs`) but nobody can decrypt anything written
 * to it yet, and nobody can write `qu-platform-apps` either.
 *
 * `GET /relay-admins.json` (unauthenticated, like `/members.json`) serves
 * the SAME list's `pub`s only (never `xPub` - the MAIN Space's own content
 * here is `'public'`-visibility, so no encryption recipient is needed) -
 * `@qu/app-shell`'s `shell.js` fetches it in PLATFORM mode to construct its
 * own `Space` with a matching `relayAdmins` list, so an ordinary visitor's
 * client can independently verify `qu-platform-apps` writes itself, never
 * just trusting this relay's own say-so (see `Space`'s own `relayAdmins`
 * constructor doc comment - the same "never trust the relay" posture
 * `members`/`/members.json` already establish).
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
import { createLiveAppResolveKindSchema } from './src/live-app-resolver.js';
import { buildAppShellBundle, renderIndexHtml } from './build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.QU_RELAY_PORT || 8081);
const DATA_DIR = process.env.QU_RELAY_DATA_DIR ?? '/data';
const ALLOW_JOIN = process.env.QU_ALLOW_JOIN !== 'false';
const APP_ADMIN_PUB_B64 = process.env.QU_APP_ADMIN_PUB || null;
const RELAY_ADMINS_JSON = process.env.QU_RELAY_ADMINS || null;
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

// The ONE static list this deployment needs beyond QU_MEMBERS_JSON/QU_APP_ADMIN_PUB - doubles as the
// admin realm's own `members` (encryption + 'members'-ACL) AND the main Space's `relay-admins`
// write-ACL list (signing pubkeys only - see this file's own top doc comment).
let relayAdmins = [];
if (RELAY_ADMINS_JSON) relayAdmins = parseMembersJson('QU_RELAY_ADMINS', RELAY_ADMINS_JSON);
const relayAdminPubs = relayAdmins.map((m) => m.pub);

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
  const platformMode = relayAdminPubs.length > 0; // priority over QU_APP_ADMIN_PUB - see build.mjs's own doc comment.

  console.log('[qu-app-shell-relay] bundling @qu/app-shell…');
  // createAppRequestHandler()'s STATIC_FILES map (@qu/space-transport's relay-app-server.js) always
  // serves /bundle.js from "<webDir>/dist/bundle.js" - the SAME convention demo/web/'s own build
  // uses - so the bundle goes under WEB_DIR/dist, not WEB_DIR itself.
  const { outfile } = await buildAppShellBundle({ outDir: join(WEB_DIR, 'dist') });
  await writeFile(join(WEB_DIR, 'index.html'), renderIndexHtml({ appAdminPub, platformMode }), 'utf8');
  console.log(`[qu-app-shell-relay] bundled -> ${outfile}`);
  if (!appAdminPub && !platformMode) {
    console.warn(
      '[qu-app-shell-relay] neither QU_APP_ADMIN_PUB nor QU_RELAY_ADMINS is set - serving a setup page instead of an app. See this file\'s own doc comment.'
    );
  }

  const storage = DATA_DIR ? createFileStore(DATA_DIR) : null;
  const bus = new EventBus();

  const httpServer = createServer((req, res) => handleRequest(req, res));

  // MAIN hub - the ordinary, open-join Space (unchanged from before the admin realm existed).
  const mainWss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
  const mainHub = createWsServerHub(mainWss);

  // In PLATFORM mode, `qu-platform-apps` (now a 'relay-admins'-ACL registry - kinds.js's own doc
  // comment) is watched LIVE by this relay itself (@qu/app-shell's own live-app-resolver.js) - a
  // relay-admin registering a brand-new app-admin (registerApp()) is enough, no separate STATIC
  // app-admin list, no restart. In single-app mode, the ordinary static resolver is enough - there
  // is exactly one app-admin, known from boot, nothing to watch.
  const liveResolver = platformMode ? createLiveAppResolveKindSchema() : null;
  const resolveKindSchema = platformMode
    ? liveResolver.resolveKindSchema
    : appAdminPub
      ? await createAppResolveKindSchema({ appAdminPub })
      : () => true;

  const relay = createRelayForwarder({ hub: mainHub, members, relayAdmins: relayAdminPubs, resolveKindSchema, storage, bus });
  const handleAppRequest = createAppRequestHandler({ webDir: WEB_DIR, members, relay, allowJoin: ALLOW_JOIN, log: console.log });

  // ADMIN hub - a wholly separate Space/relay-forwarder, its OWN flat `relayAdmins` list (the SAME
  // QU_RELAY_ADMINS list above), never open-join (no /admin-join endpoint - see this file's own
  // "ADMIN REALM" doc comment), reached at a distinct WS path on the SAME port via manual upgrade
  // routing below.
  const adminWss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
  const adminHub = createWsServerHub(adminWss);
  const adminStorage = DATA_DIR ? createFileStore(join(DATA_DIR, 'admin-realm')) : null;
  const adminResolveKindSchema = await createAdminResolveKindSchema();
  createRelayForwarder({ hub: adminHub, members: relayAdmins, resolveKindSchema: adminResolveKindSchema, storage: adminStorage, bus: new EventBus() });

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
      const list = relayAdmins.map((m) => ({ pub: QuCrypto.toBase64(m.pub), xPub: QuCrypto.toBase64(m.xPub) }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(list));
      return;
    }
    if (req.method === 'GET' && req.url === '/relay-admins.json') {
      // Signing pubkeys only, never xPub - see this file's own top doc comment on why the MAIN
      // Space's own `relayAdmins` write-ACL check never needs an encryption recipient.
      const list = relayAdminPubs.map((pub) => QuCrypto.toBase64(pub));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(list));
      return;
    }
    if (handleAppRequest(req, res)) return;
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }

  await new Promise((resolve) => httpServer.listen(PORT, resolve));
  const mirrorNote = storage ? `mirroring to ${DATA_DIR}` : 'NO mirroring (live-only, QU_RELAY_DATA_DIR is empty)';
  const appNote = platformMode
    ? `PLATFORM mode, ${relayAdmins.length} relay-admin(s)`
    : appAdminPub
      ? `serving app-admin ${APP_ADMIN_PUB_B64}`
      : 'NO app configured (QU_APP_ADMIN_PUB / QU_RELAY_ADMINS unset - see /)';
  console.log(`[qu-app-shell-relay] listening on :${PORT} - ${appNote}, ${mirrorNote}`);
  console.log(`[qu-app-shell-relay] open http://localhost:${PORT}/ in a browser - join is ${ALLOW_JOIN ? 'OPEN to anyone (QU_ALLOW_JOIN=false to lock it down)' : 'DISABLED (QU_ALLOW_JOIN=false)'}`);
  console.log(`[qu-app-shell-relay] admin realm WS at ${ADMIN_WS_PATH} - membership is static (QU_RELAY_ADMINS), no self-join.`);

  // MUST run AFTER the server is actually listening (this connects to itself, over a real
  // WebSocket, exactly like any other peer - see live-app-resolver.js's own "ORDERING" doc comment
  // on why an ordinary client connection, not a fabricated in-process peer, is what this needs:
  // createWsServerHub() - unlike the in-process test hub - has no local-peer registration API at
  // all, only real socket connections).
  if (liveResolver) await liveResolver.start({ url: `ws://127.0.0.1:${PORT}`, relayAdmins: relayAdminPubs });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
