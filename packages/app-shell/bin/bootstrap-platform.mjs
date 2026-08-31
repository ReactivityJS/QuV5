#!/usr/bin/env node
/**
 * PLATFORM BOOTSTRAP — `npm run bootstrap:platform`. The ONE command that
 * takes an already-running (or freshly restarted) `relay-server.js` - via
 * Docker (`docker-compose.space-relay.yml`, now the DEFAULT service, no
 * `--profile` needed - see that file's own doc comment) or bare
 * (`node packages/app-shell/relay-server.js`) - all the way to "Admin-UI
 * at #/admin and a real, CMS-managed shell-app at #/demo," replacing what
 * used to be several separate manual steps (generate an identity, edit env
 * vars, restart, run `bin/install-admin-console.mjs`, write a separate
 * app-install script, register it) with one, idempotent, safe-to-re-run
 * command.
 *
 * TWO PASSES ARE SOMETIMES NEEDED, NOT A BUG: `QU_RELAY_ADMIN_PUB`/
 * `QU_APP_ADMIN_PUBS`/`QU_RELAY_ADMIN_MEMBERS_JSON` are read by the relay
 * at BOOT time only (same static-list posture `QU_MEMBERS_JSON` already
 * takes - see `relay-server.js`'s own doc comment on why: `resolveKindSchema`
 * is a plain synchronous function, never re-evaluated once the process is
 * up). The FIRST run here generates identities (if none exist yet, under
 * `--dir`) and writes/updates `--dotenv` (named to avoid colliding with
 * Node's OWN built-in `--env-file` flag) with their PUBLIC keys only -
 * this script runs on YOUR machine, the private keys it generates never
 * touch the relay, same posture every other bootstrap tool in this repo
 * already takes (`bin/install-admin-console.mjs`, `demo/install-app-shell-
 * demo.mjs`). If the relay hasn't picked that config up yet, the
 * installation phase below can't complete (its writes never get
 * write-acked - see `waitUntilAllWritesAcked()`) - this script detects
 * that and tells you to (re)start the relay, then re-run it. Every write
 * here is idempotent or dedup-checked (see inline comments), so re-running
 * after a successful pass is a harmless no-op, e.g. to re-install a newer
 * admin console.
 *
 * MEMBERSHIP: the confidential admin realm never self-registers (no
 * `/admin-ws`-equivalent open-join exists, on purpose - kinds.js's own
 * "THE ADMIN REALM" doc comment) - `QU_RELAY_ADMIN_MEMBERS_JSON` is the
 * only way in, hence the env-file step above. The ordinary MAIN space's
 * `'members'`-ACL Kinds, by contrast, already support self-join
 * (`QU_ALLOW_JOIN`, default true) - this script uses exactly that (a plain
 * `POST /join`, the SAME mechanism a real browser visitor's `shell.js`
 * uses) for both identities below rather than also managing
 * `QU_MEMBERS_JSON`, so it never clobbers a `.env` you've customized for
 * your OWN apps' own `'members'`-ACL content.
 *
 * Usage:
 *   node packages/app-shell/bin/bootstrap-platform.mjs \
 *     [--relay ws://localhost:8081] [--dir packages/app-shell/.platform-identities] \
 *     [--dotenv .env] [--prefix demo]
 */
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { WsClientTransport } from '@qu/space-transport';
import { EventBus } from '@qu/events';
import {
  installAdminAppBundle,
  registerApp,
  createApp,
  createTemplate,
  createStyle,
  createPage,
  publishRoute,
  PlatformRuntime,
  ContentResolver,
  adminAppManifestKind,
  ADMIN_REALM_ANCHOR,
} from '@qu/app-core';
import { adminConsoleBundle } from '../admin-console-bundle.js';
import { installCms } from '../cms-bundle.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

function parseArgs(argv) {
  const opts = { relay: 'ws://localhost:8081', dir: join(HERE, '..', '.platform-identities'), envFile: join(REPO_ROOT, '.env'), prefix: 'demo' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--relay') opts.relay = argv[++i];
    else if (argv[i] === '--dir') opts.dir = argv[++i];
    else if (argv[i] === '--dotenv') opts.envFile = argv[++i];
    else if (argv[i] === '--prefix') opts.prefix = argv[++i];
  }
  return opts;
}

/** Same local, single-file-per-identity persistence `bin/install-admin-console.mjs` already uses - see that file's own doc comment. */
async function ensureIdentity(name, dir) {
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${name}.json`);
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

const MANAGED_ENV_KEYS = ['QU_RELAY_ADMIN_PUB', 'QU_APP_ADMIN_PUBS', 'QU_RELAY_ADMIN_MEMBERS_JSON'];

function readEnvValue(content, key) {
  const line = content.split('\n').find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1) : undefined;
}

/**
 * Merges `relayAdminPubB64`/`appAdminPubB64`/`relayAdminMember` into
 * `envFile`, replacing only the keys THIS script owns (`MANAGED_ENV_KEYS`) -
 * every other line (your own `QU_MEMBERS_JSON`, `QU_FEDERATE_UPSTREAM_URL`,
 * ...) survives untouched. `QU_APP_ADMIN_PUBS`/`QU_RELAY_ADMIN_MEMBERS_JSON`
 * are JSON ARRAYS a real deployment likely already curated by hand (other
 * app-admins, other trusted admin-realm members) - this APPENDS this
 * script's own entries if missing rather than overwriting the array
 * wholesale, so re-running never silently drops someone else's entry.
 * `QU_RELAY_ADMIN_PUB` is a single scalar (there is only ever ONE
 * relay-admin identity by design) - replaced outright if different.
 * Creates the file if it doesn't exist yet.
 */
async function mergeEnvFile(envFile, { relayAdminPubB64, appAdminPubB64, relayAdminMember }) {
  let existing = '';
  try {
    existing = await readFile(envFile, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const existingAppAdminPubs = JSON.parse(readEnvValue(existing, 'QU_APP_ADMIN_PUBS') || '[]');
  const appAdminPubs = existingAppAdminPubs.includes(appAdminPubB64) ? existingAppAdminPubs : [...existingAppAdminPubs, appAdminPubB64];

  const existingAdminMembers = JSON.parse(readEnvValue(existing, 'QU_RELAY_ADMIN_MEMBERS_JSON') || '[]');
  const adminMembers = existingAdminMembers.some((m) => m.pub === relayAdminMember.pub) ? existingAdminMembers : [...existingAdminMembers, relayAdminMember];

  const values = {
    QU_RELAY_ADMIN_PUB: relayAdminPubB64,
    QU_APP_ADMIN_PUBS: JSON.stringify(appAdminPubs),
    QU_RELAY_ADMIN_MEMBERS_JSON: JSON.stringify(adminMembers),
  };

  const kept = existing.split('\n').filter((line) => !MANAGED_ENV_KEYS.some((key) => line.startsWith(`${key}=`)) && !line.startsWith('# --- written by bootstrap-platform.mjs'));
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  const block = ['# --- written by bootstrap-platform.mjs - safe to regenerate, do not hand-edit these lines ---', ...Object.entries(values).map(([key, value]) => `${key}=${value}`)];
  const next = [...kept, '', ...block, ''].join('\n');
  await writeFile(envFile, next, 'utf8');
}

/**
 * Detects `docker exec`-into-a-running-container execution - `/.dockerenv`
 * is created by the Docker runtime itself inside every container it starts
 * (an established, widely-relied-on convention, not something this repo
 * invents). MATTERS A LOT here specifically: `mergeEnvFile()` above writes
 * `--dotenv` (default `.env` at the repo root) on WHATEVER filesystem this
 * process is running on - if that's the CONTAINER's own (ephemeral, not
 * volume-mounted - only `/data` is), the result is a `.env` file `docker
 * compose` on the HOST never sees, since Compose's `${VAR}` substitution
 * reads the HOST's own `.env` at `docker compose up` time, not anything
 * inside an already-running container. Worse, "restart the relay" (this
 * script's own generic advice when writes never get acked) is not
 * ACTIONABLE from inside a `docker exec` shell at all - a process has no
 * way to restart its own container from within. See `printDockerRecoveryHint()`
 * for what to say instead.
 */
async function isInContainer() {
  try {
    await access('/.dockerenv');
    return true;
  } catch {
    return false;
  }
}

function printDockerRecoveryHint(envFile) {
  console.log('  You appear to be running INSIDE the container (docker exec) - a .env written here');
  console.log(`  (${envFile}) lives on the CONTAINER's own filesystem, not your host's, so \`docker`);
  console.log('  compose\' never sees it, and this container cannot restart itself from within. Run');
  console.log('  these from your HOST shell instead (NOT inside this container):');
  console.log('');
  console.log('    docker compose -f docker-compose.space-relay.yml cp qu-app-shell-relay:/app/.env ./.env');
  console.log('    docker compose -f docker-compose.space-relay.yml up -d   # recreates the container with it');
  console.log('');
  console.log('  Then run this exact `docker exec ... npm run bootstrap:platform` command again to finish.');
}

/** Plain `POST /join`, the SAME self-registration mechanism a real browser's `shell.js`/`identity.js` uses - see this file's own top doc comment on why this is used instead of also managing `QU_MEMBERS_JSON`. */
async function joinMainSpace(httpBase, identity, name) {
  const res = await fetch(`${httpBase}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, pub: QuCrypto.toBase64(identity.signingPub), xPub: QuCrypto.toBase64(identity.xPublicKey) }),
  });
  if (!res.ok) throw new Error(`POST /join failed: ${res.status} ${await res.text()}`);
}

async function waitForHealthy(httpBase, { attempts = 15, interval = 1000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${httpBase}/healthz`);
      if (res.ok) return true;
    } catch {
      // not up yet - retry.
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

/** Tracks every LOCAL write a Space issues and whether the relay write-acked it - see `demo/install-app-shell-demo.mjs`'s own identical helper for the full "why" (sealing is async, `await write()` alone doesn't guarantee the envelope left the socket). Used here for a SECOND purpose too: if the relay's config doesn't actually include this identity yet (stale `.env`, not yet restarted), the write is silently rejected and NEVER acked - `waitUntilAllWritesAcked()` timing out is this script's signal to say so, instead of falsely reporting success. */
function trackWrites(bus) {
  const state = { expected: 0, acked: 0 };
  bus.on('debug.space.write.local', () => state.expected++);
  bus.on('space.node.*.write-ack', () => state.acked++);
  return state;
}

async function waitUntilAllWritesAcked(state, { timeout = 5000, settle = 300, interval = 20 } = {}) {
  await new Promise((r) => setTimeout(r, settle));
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (state.acked >= state.expected) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

async function main() {
  const { relay, dir, envFile, prefix } = parseArgs(process.argv.slice(2));
  const httpBase = relay.replace(/^ws/, 'http');

  console.log('Qu V5 — Platform bootstrap\n');

  const relayAdmin = await ensureIdentity('relay-admin', dir);
  const demoAppAdmin = await ensureIdentity('demo-app-admin', dir);
  console.log(`  relay-admin     pub: ${QuCrypto.toBase64(relayAdmin.signingPub)}`);
  console.log(`  demo-app-admin  pub: ${QuCrypto.toBase64(demoAppAdmin.signingPub)}`);
  console.log(`  (private keys stay local, under ${dir})\n`);

  await mergeEnvFile(envFile, {
    relayAdminPubB64: QuCrypto.toBase64(relayAdmin.signingPub),
    appAdminPubB64: QuCrypto.toBase64(demoAppAdmin.signingPub),
    relayAdminMember: { pub: QuCrypto.toBase64(relayAdmin.signingPub), xPub: QuCrypto.toBase64(relayAdmin.xPublicKey) },
  });
  console.log(`  wrote platform config -> ${envFile}\n`);

  const inContainer = await isInContainer();
  if (inContainer) {
    console.log('⚠ Running inside a container (docker exec) - this .env write alone will NOT reach');
    console.log('  `docker compose` on your host. Read on: this run may still finish (if the relay was');
    console.log('  already configured by a PREVIOUS bootstrap run), but if it ends with the same warning');
    console.log('  as below, that\'s why.\n');
  }

  console.log(`Checking ${httpBase}/healthz ...`);
  const healthy = await waitForHealthy(httpBase, { attempts: 5, interval: 800 });
  if (!healthy) {
    console.log(`\n❌ Relay not reachable at ${relay}.`);
    console.log('   Start it, THEN re-run this script:');
    console.log('     docker compose -f docker-compose.space-relay.yml up -d --build   # Docker, now the default service');
    console.log('   or:');
    console.log('     node packages/app-shell/relay-server.js                          # bare, same defaults');
    process.exitCode = 1;
    return;
  }
  console.log('  relay is up.\n');

  console.log('Connecting to the admin realm (/admin-ws) as relay-admin...');
  const adminTransport = new WsClientTransport(`${relay.replace(/\/?$/, '')}/admin-ws`, { WebSocketImpl: WebSocket });
  await adminTransport.connect();
  const adminBus = new EventBus();
  const adminSpace = new Space({ identity: relayAdmin, members: [{ pub: relayAdmin.signingPub, xPub: relayAdmin.xPublicKey }], transport: adminTransport, bus: adminBus });
  const adminWrites = trackWrites(adminBus);
  // installAdminAppBundle()/createNode() always build a FRESH Y.Doc for whatever id they target -
  // safe for a Node that doesn't exist yet, but calling it AGAIN for one that already does would
  // duplicate every Y.Text field's content (html/content), not overwrite it - the exact footgun
  // architecture.md's own edit*() functions exist to avoid, and there is no admin-realm edit*()
  // counterpart yet (this file's own top doc comment). Check first, skip if already installed.
  const adminResolver = new ContentResolver(adminSpace, { appAdminPub: ADMIN_REALM_ANCHOR, kinds: { appManifestKind: adminAppManifestKind } });
  const adminAlreadyInstalled = (await adminResolver.resolveManifest({ timeout: 800 })) !== null;
  let adminOk = true;
  if (adminAlreadyInstalled) {
    console.log('  admin console content already installed - skipping (edit it live at #/admin once bootstrapped, or re-run bin/install-admin-console.mjs to overwrite).');
  } else {
    console.log('  installing the built-in admin console content...');
    await installAdminAppBundle(adminSpace, adminConsoleBundle);
    adminOk = await waitUntilAllWritesAcked(adminWrites);
  }
  adminTransport.close();

  console.log('Connecting to the main space as relay-admin (to register aliases)...');
  await joinMainSpace(httpBase, relayAdmin, 'relay-admin');
  const mainTransport = new WsClientTransport(relay, { WebSocketImpl: WebSocket });
  await mainTransport.connect();
  const mainBus = new EventBus();
  const mainSpace = new Space({ identity: relayAdmin, members: [{ pub: relayAdmin.signingPub, xPub: relayAdmin.xPublicKey }], transport: mainTransport, bus: mainBus });
  const mainWrites = trackWrites(mainBus);

  const platform = new PlatformRuntime(mainSpace, { relayAdminPub: relayAdmin.signingPub });
  const existingApps = await platform.resolveApps({ timeout: 800 });
  if (!existingApps.some((a) => a.prefix === 'admin')) {
    console.log('  registering the "admin" alias...');
    await registerApp(mainSpace, { prefix: 'admin', name: 'Relay-Admin', realm: 'admin' });
  } else {
    console.log('  "admin" alias already registered.');
  }

  console.log(`Connecting to the main space as demo-app-admin (to seed the "${prefix}" shell-app)...`);
  await joinMainSpace(httpBase, demoAppAdmin, 'demo-app-admin');
  const demoTransport = new WsClientTransport(relay, { WebSocketImpl: WebSocket });
  await demoTransport.connect();
  const demoBus = new EventBus();
  const demoSpace = new Space({ identity: demoAppAdmin, members: [{ pub: demoAppAdmin.signingPub, xPub: demoAppAdmin.xPublicKey }], transport: demoTransport, bus: demoBus });
  const demoWrites = trackWrites(demoBus);

  // Same "check first, never re-createNode() over existing content" reasoning as the admin console
  // above - createTemplate()/createPage()/installCms() are exactly right for a Node that doesn't
  // exist yet, but calling them again for one that DOES would duplicate its Y.Text fields, not
  // update them. Once seeded, the demo app's own #/<prefix>/cms editor (just installed) is the
  // right tool for further changes - not re-running this script.
  const demoResolver = new ContentResolver(demoSpace, { appAdminPub: demoAppAdmin.signingPub });
  const demoAlreadySeeded = (await demoResolver.resolveManifest({ timeout: 800 })) !== null;
  if (demoAlreadySeeded) {
    console.log(`  demo shell-app already seeded - skipping (edit it live at #/${prefix}/cms once bootstrapped).`);
  } else {
    console.log('  creating the demo shell-app (manifest, template, style, page) + installing its CMS editor...');
    await createApp(demoSpace, { name: 'Demo Shell-App', rootTemplate: 'main', defaultRoute: '/', theme: 'global' });
    await createTemplate(demoSpace, {
      name: 'main',
      html: '<header><h1>Demo Shell-App</h1><p>Gebaut aus Qu-Content, gepflegt über die eingebaute CMS-Konsole - siehe <a href="#/' + prefix + '/cms">#/' + prefix + '/cms</a>.</p></header><main><qu-slot name="content"></qu-slot></main>',
    });
    await createStyle(demoSpace, { name: 'global', css: 'body { font-family: sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; } header{opacity:.85; margin-bottom:2rem}' });
    await createPage(demoSpace, {
      route: '/',
      title: 'Demo Shell-App',
      template: 'main',
      content: '<p>Willkommen! Diese Seite kommt komplett aus Qu-Content - bearbeite sie live unter <a href="#/' + prefix + '/cms">#/' + prefix + '/cms</a> (als die demo-app-admin Identity, siehe unten).</p>',
    });
    // createPage() deliberately does NOT auto-register into the route registry (dev.js's own doc
    // comment - backward-compat with pre-CMS callers) - without this, the page above would render
    // fine when visited directly, but never show up in the CMS's OWN "Seiten" list (wirePages()'s
    // refreshList() enumerates via resolveRoutes(), not by guessing at Nodes that might exist).
    await publishRoute(demoSpace, { route: '/', title: 'Demo Shell-App' });
    await installCms(demoSpace);
  }

  if (!existingApps.some((a) => a.prefix === prefix)) {
    console.log(`  registering "#/${prefix}"...`);
    await registerApp(mainSpace, { prefix, appAdminPub: demoAppAdmin.signingPub, name: 'Demo Shell-App' });
  } else {
    console.log(`  "#/${prefix}" already registered.`);
  }

  const mainOk = await waitUntilAllWritesAcked(mainWrites);
  const demoOk = await waitUntilAllWritesAcked(demoWrites);
  mainTransport.close();
  demoTransport.close();

  if (!adminOk || !mainOk || !demoOk) {
    console.log('\n⚠ Some writes were never write-acked by the relay - this usually means it is still running with an');
    console.log('  OLDER config (the .env change above needs a restart to take effect).');
    if (inContainer) {
      printDockerRecoveryHint(envFile);
    } else {
      console.log('  (Re)start the relay, then re-run this exact command - every step here is safe to repeat.');
    }
    process.exitCode = 1;
    return;
  }

  console.log('\n✅ Platform bootstrapped.\n');
  console.log('Open in a browser:');
  console.log(`  Admin-UI:        ${httpBase}/#/admin`);
  console.log(`  Demo shell-app:  ${httpBase}/#/${prefix}/`);
  console.log(`  Its CMS editor:  ${httpBase}/#/${prefix}/cms\n`);
  console.log('Both consoles gate WRITES by real relay-enforced ACL, not by the UI - visiting as an ordinary,');
  console.log('freshly-generated browser identity renders everything fine (all content here is public), but a');
  console.log('save attempt is silently rejected unless you are actually signed in as the right identity. To');
  console.log('act as one of the two identities above in your browser\'s devtools console (same origin as the');
  console.log('relay), paste:\n');
  for (const [label, identity] of [
    ['relay-admin (for #/admin)', relayAdmin],
    ['demo-app-admin (for #/' + prefix + '/cms)', demoAppAdmin],
  ]) {
    console.log(`  // ${label}`);
    console.log(
      `  localStorage.setItem('qu-identity', JSON.stringify(${JSON.stringify({
        signingKey: QuCrypto.toBase64(identity.signingKey),
        signingPub: QuCrypto.toBase64(identity.signingPub),
        xPrivateKey: QuCrypto.toBase64(identity.xPrivateKey),
        xPublicKey: QuCrypto.toBase64(identity.xPublicKey),
      })})); location.reload();\n`
    );
  }
  console.log('(This copies a real private key into that browser tab\'s localStorage - fine for a local demo,');
  console.log('never do this with a production identity on a machine/browser profile you don\'t fully trust.)');

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
