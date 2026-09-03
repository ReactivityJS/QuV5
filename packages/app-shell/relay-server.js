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
 *   QU_RELAY_ADMINS   - JSON array of PLAIN base64 Ed25519 pubkeys, e.g.
 *                        `["<pub1>","<pub2>"]` - PLATFORM mode (takes
 *                        priority over `QU_APP_ADMIN_PUB`): the ONE static,
 *                        boot-time-configured list this whole deployment
 *                        needs (no `xPub`/encryption-recipient half any
 *                        more - see "ONE RELAY SPACE, NOT TWO" below for
 *                        why). Every listed identity, equally and
 *                        symmetrically (no single distinguished "owner"),
 *                        may write BOTH:
 *                          (a) `qu-platform-apps` - register/manage
 *                              path-prefix aliases for any already-
 *                              installed app (`registerApp()`), including
 *                              the built-in admin console's own alias
 *                              (conventionally `"admin"`) - see
 *                              `@qu/app-core`'s `kinds.js` own doc comment
 *                              on `platformAppsKind`'s `'relay-admins'`
 *                              ACL mode, and
 *                          (b) the admin console's own content
 *                              (`qu-admin-*` Kinds, also `'relay-admins'`-
 *                              ACL - see "ONE RELAY SPACE, NOT TWO" below).
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
 *                        `QU_MEMBERS_JSON` only. Irrelevant to
 *                        `qu-platform-apps`/the admin console below - both
 *                        `'relay-admins'`-ACL, readable by anyone regardless
 *                        of membership; WRITE to either is never a matter
 *                        of self-join at all, only of being listed in
 *                        `QU_RELAY_ADMINS`.
 *
 * ONE RELAY SPACE, NOT TWO (architecture.md §7, revised - a real
 * architecture simplification, not just a refactor): the built-in admin
 * console used to live in a wholly SEPARATE, genuinely confidential
 * relay-forwarder/Space (its own `members` list, its own `/admin-ws`
 * WebSocket path, `'encrypted'`-visibility content) - requiring whoever
 * wanted to administer the platform to generate a DEDICATED admin keypair
 * and import it into their browser, distinct from whatever identity that
 * same browser already uses for everything else. That design is GONE:
 * the admin console's own Kinds (`@qu/app-core`'s `qu-admin-*`, see
 * kinds.js's own "THE ADMIN APP" doc comment) are now `acl.write:
 * 'relay-admins'`-ACL content in this SAME ordinary MAIN Space, the exact
 * same primitive `qu-platform-apps` already uses - checked against the
 * SAME `QU_RELAY_ADMINS` list below, completely independent of ordinary
 * `'members'` Space membership. A relay-admin's OWN already-existing
 * browser identity (the one `loadOrCreateIdentity()` already generated and
 * persists) administers both the platform's app registry AND the admin
 * console's own content the moment its pubkey is listed here - no second
 * identity, no import step, no `/admin-ws`.
 *
 * The tradeoff, made explicit: the admin console's own MARKUP (a
 * "register an app" form, a list of already-`'public'`-visibility
 * `qu-platform-apps` entries) is now world-readable, like any other app's
 * content - there was never anything secret IN it. WRITE access is
 * unchanged: only identities listed in `QU_RELAY_ADMINS` can ever submit
 * to it, checked independently by every client's own `Space` (never just
 * trusting this relay's own say-so), same as before.
 *
 * `GET /relay-admins.json` (unauthenticated, like `/members.json`) serves
 * the SAME list, plain base64 pubkeys - `@qu/app-shell`'s `shell.js`
 * fetches it in PLATFORM mode to construct its own `Space` with a matching
 * `relayAdmins` list, so an ordinary visitor's client can independently
 * verify `qu-platform-apps`/admin-console writes itself, never just
 * trusting this relay's own say-so (see `Space`'s own `relayAdmins`
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
import { createAppResolveKindSchema } from '@qu/app-core';
import { createLiveAppResolveKindSchema } from './src/live-app-resolver.js';
import { buildAppShellBundle, renderIndexHtml } from './build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.QU_RELAY_PORT || 8081);
const DATA_DIR = process.env.QU_RELAY_DATA_DIR ?? '/data';
const ALLOW_JOIN = process.env.QU_ALLOW_JOIN !== 'false';
const APP_ADMIN_PUB_B64 = process.env.QU_APP_ADMIN_PUB || null;
const RELAY_ADMINS_JSON = process.env.QU_RELAY_ADMINS || null;
const WEB_DIR = join(HERE, 'dist-web');

function parseMembersJson(label, json) {
  try {
    return JSON.parse(json).map((m) => ({ pub: QuCrypto.fromBase64(m.pub), xPub: QuCrypto.fromBase64(m.xPub) }));
  } catch (err) {
    console.error(`[qu-app-shell-relay] ${label} is not valid JSON / valid base64 keys:`, err.message);
    process.exit(1);
  }
}

/** QU_RELAY_ADMINS is a PLAIN array of base64 signing pubkeys, e.g. `["<pub1>","<pub2>"]` - no `xPub` (this file's own top doc comment on "ONE RELAY SPACE, NOT TWO": the `'relay-admins'` ACL check only ever needs a signing pubkey, never an encryption recipient). */
function parseRelayAdminsJson(label, json) {
  try {
    return JSON.parse(json).map((pub) => QuCrypto.fromBase64(pub));
  } catch (err) {
    console.error(`[qu-app-shell-relay] ${label} is not a valid JSON array of base64 pubkeys:`, err.message);
    process.exit(1);
  }
}

let members = [];
if (process.env.QU_MEMBERS_JSON) members = parseMembersJson('QU_MEMBERS_JSON', process.env.QU_MEMBERS_JSON);

// The ONE static list this deployment needs beyond QU_MEMBERS_JSON/QU_APP_ADMIN_PUB - the main
// Space's `relay-admins` write-ACL list (signing pubkeys only - see this file's own top doc comment).
let relayAdminPubs = [];
if (RELAY_ADMINS_JSON) relayAdminPubs = parseRelayAdminsJson('QU_RELAY_ADMINS', RELAY_ADMINS_JSON);

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

  // ONE hub, ONE Space - the admin console's own content lives here too now (this file's own top
  // doc comment on "ONE RELAY SPACE, NOT TWO"), no second relay-forwarder/WS path.
  const mainWss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
  const mainHub = createWsServerHub(mainWss);

  // In PLATFORM mode, `qu-platform-apps` (a 'relay-admins'-ACL registry - kinds.js's own doc
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

  httpServer.on('upgrade', (req, socket, head) => {
    mainWss.handleUpgrade(req, socket, head, (ws) => mainWss.emit('connection', ws, req));
  });

  function handleRequest(req, res) {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.method === 'GET' && req.url === '/relay-admins.json') {
      // Plain base64 pubkeys - see this file's own top doc comment on why the MAIN Space's own
      // `relayAdmins` write-ACL check never needs an encryption recipient.
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
    ? `PLATFORM mode, ${relayAdminPubs.length} relay-admin(s)`
    : appAdminPub
      ? `serving app-admin ${APP_ADMIN_PUB_B64}`
      : 'NO app configured (QU_APP_ADMIN_PUB / QU_RELAY_ADMINS unset - see /)';
  console.log(`[qu-app-shell-relay] listening on :${PORT} - ${appNote}, ${mirrorNote}`);
  console.log(`[qu-app-shell-relay] open http://localhost:${PORT}/ in a browser - join is ${ALLOW_JOIN ? 'OPEN to anyone (QU_ALLOW_JOIN=false to lock it down)' : 'DISABLED (QU_ALLOW_JOIN=false)'}`);

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
