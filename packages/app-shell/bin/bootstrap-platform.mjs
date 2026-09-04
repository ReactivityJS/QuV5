#!/usr/bin/env node
/**
 * PLATFORM BOOTSTRAP — `npm run bootstrap:platform`. Two independent jobs,
 * always run in this order but decoupled from HOW you deploy:
 *
 *   1. Generate (or load) a `relay-admin` identity and print the exact
 *      `environment:` block your deployment needs -
 *      `docker-compose.space-relay.yml`, a `docker stack deploy` stack
 *      file, a Kubernetes manifest, systemd env vars, whatever you
 *      actually use. This script NEVER writes that config for you and
 *      NEVER assumes anything about your deployment method (no `.env`
 *      file, no container filesystem, no `docker exec`/`docker compose`
 *      awareness at all) - `QU_RELAY_ADMINS` is read by the relay at BOOT
 *      time only (same static-list posture `QU_MEMBERS_JSON` already takes
 *      - see `relay-server.js`'s own doc comment on why), so YOU decide how
 *      that config reaches your relay and gets it (re)started with it -
 *      this script only ever talks to the relay over its public URL
 *      (`--relay`), exactly like `bin/install-admin-console.mjs` already
 *      does, so it works identically regardless of whether that relay lives
 *      in a Compose service, a Swarm/`docker stack` service, a Kubernetes
 *      Pod, or bare metal. `relay-admin` is the ONLY identity this script
 *      needs any static config for at all - see "WHY THERE IS NO
 *      SECOND/APP-ADMIN IDENTITY ANY MORE" below.
 *   2. Once the relay is actually reachable AND configured with that
 *      exact list (verified by attempting a real write and checking it
 *      gets acked - a relay still running the OLD config accepts the
 *      connection fine but silently drops the write), installs the admin
 *      console AND registers the built-in "cms" app as a `realm: 'global'`,
 *      `mode: 'multiuser'` app (kinds.js's own doc comment on the three
 *      administrable states) - replacing what used to be several separate
 *      manual steps with one, idempotent, safe-to-re-run command.
 *
 * WHY THERE IS NO SECOND/APP-ADMIN IDENTITY ANY MORE: earlier revisions of
 * this script also generated a `demo-app-admin` identity and seeded an
 * ordinary, SINGLE-OWNER "demo" shell-app under it - which meant anyone who
 * actually wanted to WRITE content there (not just read it, content here
 * was always public) had to somehow get hold of that one identity's private
 * key (`grant-app-access.mjs` softened this - a co-editor grant instead of
 * the raw key - but there was still exactly ONE owner to grant from). A
 * `mode: 'multiuser'` global app has no such bottleneck: EVERY visitor's own
 * regular, already-existing identity gets its own self-owned CMS space the
 * first time they reach it, with ZERO cooperation from this script, a
 * relay-admin, or anyone else (see `@qu/app-shell`'s `boot.js`'s own
 * `ensureSelfProvisioned()`/`renderMultiUserRoute()` doc comments and
 * `test/multiuser-app.test.js`). "cms" itself, as a `realm: 'global'` app,
 * still has ONE thing this script seeds as the relay-admin: its own GLOBAL
 * shell (a landing page plus its own `#/admin/cms/cms` editor) - but that
 * shell is relay-admin-COLLECTIVE property (any configured relay-admin can
 * edit it, kinds.js's own "GLOBAL APP CONTENT" doc comment), never a single
 * app-admin's private key to lose or share, so no second identity is needed
 * for it either.
 *
 * TWO RUNS ARE NORMAL ON A FRESH SETUP, NOT A BUG: run it once to get the
 * config block, paste it into your OWN deployment config, redeploy
 * however you redeploy, then run it again (same command, same `--dir`) to
 * actually install content - it reuses the SAME already-generated identity
 * the second time, never regenerating it. Every write here is idempotent or
 * dedup-checked (see inline comments), so a THIRD, later run (e.g. to
 * re-install a newer admin console) is a harmless no-op too - PROVIDED
 * `--dir`/`QU_BOOTSTRAP_DIR` points at storage that actually SURVIVES a
 * redeploy (see "PERSISTING THE IDENTITY DIRECTORY" below) - otherwise
 * every run looks like a totally fresh setup, forever.
 *
 * PERSISTING THE IDENTITY DIRECTORY - A REAL FOOTGUN, NOT HYPOTHETICAL:
 * this script's whole "run it, paste the printed config, redeploy, run it
 * again" flow only works if the SAME `relay-admin` keypair is found on the
 * SECOND run - `ensureIdentity()` below only generates a fresh keypair when
 * NOTHING is found at `<dir>/relay-admin.json`. The default `--dir` (next
 * to this script, inside the npm package/image) lives on the CONTAINER's
 * own ephemeral filesystem - fine for `docker exec`ing into an
 * ALREADY-RUNNING container repeatedly (the same container, same
 * filesystem), but GONE the instant that container is recreated (any
 * redeploy: `docker compose up` after a pull, `docker stack deploy`, a
 * Kubernetes rollout, ...), because nothing mounts that path as a volume.
 * The symptom is exactly "a brand-new relay-admin pubkey on every redeploy,
 * `QU_RELAY_ADMINS` printed again from scratch, the OLD relay-admin's
 * already-installed admin console/cms content becomes un-writable by the
 * NEW one" - not a bug in the ACL/live-resolver machinery itself
 * (architecture.md's own "A fifth ACL mode" section), a deployment footgun
 * in how this ONE script is invoked. Two ways to avoid it:
 *   1. Run this script from OUTSIDE the relay's own container lifecycle
 *      entirely (your own laptop, a CI runner, a separate small utility
 *      container) - `--dir` then naturally persists on THAT machine,
 *      untouched by the relay's own redeploys. This is the intended,
 *      documented flow (root README.md's "Deploying the App Shell").
 *   2. If you genuinely need to `docker exec` into the SAME container
 *      that gets redeployed (common with managed platforms like Rancher/
 *      Kubernetes where exposing an extra port or running a separate
 *      toolchain is inconvenient), point `--dir`/`QU_BOOTSTRAP_DIR` at a
 *      path backed by a volume that SURVIVES container recreation - see
 *      `docker-compose.space-relay.yml`'s own `qu-app-shell-relay-admin-
 *      identity` volume (mounted at `/admin-identity`, `QU_BOOTSTRAP_DIR`
 *      defaults to it there) for the reference setup. Whichever you pick,
 *      back up that directory like you would any other private key -
 *      losing it means generating a NEW relay-admin identity.
 *
 * MEMBERSHIP: `QU_RELAY_ADMINS` is the ONE static list this script needs
 * printed - it is the ONLY way to become a relay-admin (write-ACL for both
 * `qu-platform-apps` and the admin console's/"cms"'s own GLOBAL content,
 * see `@qu/app-core`'s kinds.js own doc comment on the `'relay-admins'`
 * mode). Ordinary `'members'`-ACL Kinds, by contrast, already support
 * self-join (`QU_ALLOW_JOIN`, default true) - this script uses exactly
 * that (a plain `POST /join`, the SAME mechanism a real browser visitor's
 * `shell.js` uses) for `relay-admin`, so it never needs `QU_MEMBERS_JSON`
 * printed or configured at all. Note that being a relay-admin is NOT tied
 * to any particular generated identity - ANY pubkey works the moment it is
 * listed, including a real operator's own already-existing browser
 * identity (visible on the relay's unconfigured setup page) instead of
 * the `relay-admin` identity this script generates for non-interactive
 * bootstrapping.
 *
 * Usage:
 *   node packages/app-shell/bin/bootstrap-platform.mjs \
 *     [--relay ws://localhost:8081] [--dir packages/app-shell/.platform-identities] \
 *     [--prefix cms]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { WsClientTransport } from '@qu/space-transport';
import { EventBus } from '@qu/events';
import { installGlobalAppBundle, registerApp, publishGlobalRoute, createGlobalApp, createGlobalPage, PlatformRuntime, ContentResolver, adminAppManifestKind, globalAppAnchor } from '@qu/app-core';
import { adminConsoleBundle } from '../admin-console-bundle.js';
import { cmsBundle, installGlobalCms } from '../cms-bundle.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = join(HERE, '..', '.platform-identities');

function parseArgs(argv) {
  // QU_BOOTSTRAP_DIR - optional env var default, so a docker-compose.space-relay.yml-style
  // deployment can point this at an actually-persistent volume (see this file's own top doc
  // comment, "PERSISTING THE IDENTITY DIRECTORY") without every invocation needing an explicit
  // --dir flag. --dir (if given) still wins over it.
  const opts = { relay: 'ws://localhost:8081', dir: process.env.QU_BOOTSTRAP_DIR || DEFAULT_DIR, prefix: 'cms' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--relay') opts.relay = argv[++i];
    else if (argv[i] === '--dir') opts.dir = argv[++i];
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

/**
 * Prints the ONE env var a PLATFORM-mode relay needs, ready to paste into
 * whatever `environment:`/env-var mechanism your deployment actually uses
 * (Compose, a `docker stack deploy` stack file, Kubernetes, systemd, ...) -
 * see this file's own top doc comment on why this script never tries to
 * write that config for you.
 */
function printConfigBlock({ relayAdmin }) {
  const relayAdmins = JSON.stringify([QuCrypto.toBase64(relayAdmin.signingPub)]);
  console.log('Paste this into your deployment\'s environment config (e.g. docker-compose.space-relay.yml\'s');
  console.log('qu-app-shell-relay service, or your own stack/Kubernetes/systemd config) - PUBLIC keys only,');
  console.log('nothing secret here:\n');
  console.log(`  QU_RELAY_ADMINS=${relayAdmins}\n`);
  console.log('  # docker-compose.space-relay.yml / a docker-compose-syntax stack file - environment: block:');
  console.log(`      QU_RELAY_ADMINS: '${relayAdmins}'\n`);
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

/** Tracks every LOCAL write a Space issues and whether the relay write-acked it - see `demo/install-app-shell-demo.mjs`'s own identical helper for the full "why" (sealing is async, `await write()` alone doesn't guarantee the envelope left the socket). Used here for a SECOND purpose too: if the relay is still running WITHOUT this identity in its config, the write is silently rejected and NEVER acked - `waitUntilAllWritesAcked()` timing out is this script's signal to say so, instead of falsely reporting success. */
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
  const { relay, dir, prefix } = parseArgs(process.argv.slice(2));
  const httpBase = relay.replace(/^ws/, 'http');

  console.log('Qu V5 — Platform bootstrap\n');

  // Neither --dir nor QU_BOOTSTRAP_DIR was given - the identity directory defaults to a path next
  // to this script, INSIDE the npm package/container image. That's fine run repeatedly against the
  // SAME already-running container, but is silently wiped by ANY redeploy (a fresh container has a
  // fresh filesystem) - see this file's own top doc comment, "PERSISTING THE IDENTITY DIRECTORY",
  // for the real, observed symptom (a brand-new relay-admin pubkey printed on every redeploy) and
  // the two ways to actually fix it.
  if (dir === DEFAULT_DIR) {
    console.warn(
      '⚠  --dir/QU_BOOTSTRAP_DIR not set - using the default, which does NOT survive a container\n' +
        '   redeploy/recreation. If you are running this via `docker exec` into a container that will\n' +
        '   later be redeployed, your relay-admin identity WILL change on the next redeploy unless you\n' +
        '   point --dir/QU_BOOTSTRAP_DIR at a volume that survives it - see this script\'s own top doc\n' +
        '   comment ("PERSISTING THE IDENTITY DIRECTORY") and docker-compose.space-relay.yml\'s\n' +
        '   qu-app-shell-relay-admin-identity volume for the reference setup.\n'
    );
  }

  const relayAdmin = await ensureIdentity('relay-admin', dir);
  console.log(`  relay-admin  pub: ${QuCrypto.toBase64(relayAdmin.signingPub)}`);
  console.log(`  (private key stays local, under ${dir})\n`);

  console.log(`Checking ${httpBase}/healthz ...`);
  const healthy = await waitForHealthy(httpBase, { attempts: 5, interval: 800 });
  if (!healthy) {
    console.log(`\n❌ Relay not reachable at ${relay}.\n`);
    printConfigBlock({ relayAdmin });
    console.log('Deploy your relay with that config (however you deploy - docker compose, docker stack');
    console.log('deploy, Kubernetes, bare metal, ...), then re-run this exact command to finish.');
    process.exitCode = 1;
    return;
  }
  console.log('  relay is up.\n');

  console.log('Connecting to the main space as relay-admin...');
  await joinMainSpace(httpBase, relayAdmin, 'relay-admin');
  const mainTransport = new WsClientTransport(relay, { WebSocketImpl: WebSocket });
  await mainTransport.connect();
  const mainBus = new EventBus();
  const relayAdmins = [relayAdmin.signingPub]; // qu-platform-apps AND every global app's own content are all 'relay-admins'-ACL - this Space needs the list to write/read either, see kinds.js's own doc comment.
  const mainSpace = new Space({ identity: relayAdmin, members: [{ pub: relayAdmin.signingPub, xPub: relayAdmin.xPublicKey }], relayAdmins, transport: mainTransport, bus: mainBus });
  const mainWrites = trackWrites(mainBus);

  // REGISTER, THEN PUBLISH ITS ROUTE, THEN SEED CONTENT - a real, fixed regression: this used to
  // install the admin console's own content BEFORE even registering "admin" as a global app at
  // all, let alone publishing its route. @qu/app-shell's own live-app-resolver.js only classifies a
  // global app's PAGE writes correctly (`adminPageKind`, 'relay-admins'-ACL) once it has observed
  // BOTH the registerApp() write (to start watching that app's own route registry) AND a
  // publishGlobalRoute() write for the specific route - out of that order, the write is silently
  // misclassified against the generic 'content'-ACL fallback and rejected outright. The admin
  // console's own "main" TEMPLATE has no such registry yet (kinds.js's own "GLOBAL APP CONTENT" doc
  // comment - templates/styles are a deliberate, separate scope cut for global apps) - it stays
  // correctly classified only because live-app-resolver.js hardcodes it for prefix "admin"
  // specifically (that file's own `KNOWN_GLOBAL_TEMPLATE_NAMES` doc comment).
  const platform = new PlatformRuntime(mainSpace);
  const existingApps = await platform.resolveApps({ timeout: 800 });
  if (!existingApps.some((a) => a.prefix === 'admin')) {
    console.log('  registering the "admin" alias...');
    await registerApp(mainSpace, { prefix: 'admin', name: 'Relay-Admin', realm: 'global' });
    await waitUntilAllWritesAcked(mainWrites);
    await new Promise((resolve) => setTimeout(resolve, 300)); // let the relay's live resolver start watching "admin"'s own route registry.
  } else {
    console.log('  "admin" alias already registered.');
  }

  // installGlobalAppBundle()/createNode() always build a FRESH Y.Doc for whatever id they target -
  // safe for a Node that doesn't exist yet, but calling it AGAIN for one that already does would
  // duplicate every Y.Text field's content (html/content), not overwrite it - the exact footgun
  // architecture.md's own edit*() functions exist to avoid, and there is no admin-app edit*()
  // counterpart yet (this file's own top doc comment). Check first, skip if already installed.
  const adminResolver = new ContentResolver(mainSpace, { appAdminPub: await globalAppAnchor('admin'), kinds: { appManifestKind: adminAppManifestKind } });
  const adminAlreadyInstalled = (await adminResolver.resolveManifest({ timeout: 800 })) !== null;
  if (adminAlreadyInstalled) {
    console.log('  admin console content already installed - skipping (edit it live at #/admin once bootstrapped, or re-run bin/install-admin-console.mjs to overwrite).');
  } else {
    console.log('  publishing its route...');
    await publishGlobalRoute(mainSpace, 'admin', { route: '/', title: 'Relay-Admin' });
    await waitUntilAllWritesAcked(mainWrites);
    await new Promise((resolve) => setTimeout(resolve, 300)); // let the relay observe the new route before the page content write follows.
    console.log('  installing the built-in admin console content...');
    await installGlobalAppBundle(mainSpace, 'admin', adminConsoleBundle);
  }

  // THE BUILT-IN "cms" APP - realm:'global', mode:'multiuser' (kinds.js's own doc comment on the
  // three administrable states): every visitor gets their OWN self-owned CMS space the moment they
  // reach #/<prefix>/ (no /u/me/ needed, boot.js's own default-flip doc comment) with zero
  // cooperation from this script or any relay-admin - "registering" the app is enough, nothing more
  // to seed per-user. What THIS script still seeds, as the relay-admin, is "cms"'s own GLOBAL shell
  // (a small landing page pointing visitors at their own space, plus its own #/admin/<prefix>/cms
  // editor for that landing page) - collectively relay-admin-owned content, same as the admin
  // console's own, never a single app-admin's private key to lose or share.
  const prefixRegistered = existingApps.some((a) => a.prefix === prefix);
  if (!prefixRegistered) {
    console.log(`  registering "#/${prefix}" (realm: 'global', mode: 'multiuser')...`);
    await registerApp(mainSpace, { prefix, name: 'CMS', realm: 'global', mode: 'multiuser' });
    await waitUntilAllWritesAcked(mainWrites);
    await new Promise((resolve) => setTimeout(resolve, 300)); // let the relay's live resolver start watching this app's own route registry.
  } else {
    console.log(`  "#/${prefix}" already registered - not touching its current mode (use bin/set-app-mode.mjs to change it).`);
  }

  const cmsResolver = new ContentResolver(mainSpace, { appAdminPub: await globalAppAnchor(prefix), kinds: { appManifestKind: adminAppManifestKind } });
  const cmsGlobalAlreadyInstalled = (await cmsResolver.resolveManifest({ timeout: 800 })) !== null;
  if (cmsGlobalAlreadyInstalled) {
    console.log(`  "#/${prefix}"'s global shell already installed - skipping (edit it live at #/admin/${prefix}/cms once bootstrapped).`);
  } else {
    console.log(`  publishing "#/${prefix}"'s global route(s)...`);
    await publishGlobalRoute(mainSpace, prefix, { route: '/', title: 'CMS' });
    await publishGlobalRoute(mainSpace, prefix, { route: cmsBundle.page.route, title: cmsBundle.page.title });
    await waitUntilAllWritesAcked(mainWrites);
    await new Promise((resolve) => setTimeout(resolve, 300)); // let the relay observe both new routes before the page content writes follow.
    console.log(`  installing "#/${prefix}"'s global landing page + CMS editor...`);
    await createGlobalApp(mainSpace, prefix, { name: 'CMS', rootTemplate: cmsBundle.template.name, defaultRoute: '/' });
    await installGlobalCms(mainSpace, prefix); // writes the __cms__ template + its own /cms editor page.
    await createGlobalPage(mainSpace, prefix, {
      route: '/',
      title: 'CMS',
      template: cmsBundle.template.name,
      content: `<h1>CMS</h1>
<p>Jeder angemeldete Besucher hat hier seinen EIGENEN CMS-Bereich - einfach besuchen, keine Registrierung, kein Freigabeschritt nötig: <a href="#/${prefix}/u/me/">#/${prefix}/u/me/</a> (oder einfach <a href="#/${prefix}/">#/${prefix}/</a>, sobald du angemeldet bist - das IST bereits dein eigener Bereich).</p>
<p>Diese Seite hier ist der GLOBALE, von allen Relay-Admins gemeinsam verwaltete Bereich dieser App - bearbeitbar unter <a href="#/admin/${prefix}/cms">#/admin/${prefix}/cms</a>.</p>`,
    });
  }

  const mainOk = await waitUntilAllWritesAcked(mainWrites);
  mainTransport.close();

  if (!mainOk) {
    console.log('\n⚠ Some writes were never write-acked by the relay - it is reachable, but NOT (yet) running');
    console.log('  with this identity\'s config (a relay ignores QU_RELAY_ADMINS changes until it is');
    console.log('  actually (re)started with it - a plain restart of an already-running process/container');
    console.log('  does NOT re-read it by itself either, the process/container needs to be RECREATED with');
    console.log('  the new config).\n');
    printConfigBlock({ relayAdmin });
    console.log('Update your deployment with that config and redeploy/recreate it (however you deploy),');
    console.log('then re-run this exact command - it reuses the same identity and finishes from here.');
    process.exitCode = 1;
    return;
  }

  console.log('\n✅ Platform bootstrapped.\n');
  console.log('Open in a browser:');
  console.log(`  Admin-UI:              ${httpBase}/#/admin`);
  console.log(`  Dein eigener CMS-Space: ${httpBase}/#/${prefix}/  (als deine eigene, ganz normale Browser-Identität - erstellt sich selbst beim ersten Besuch)`);
  console.log(`  CMS, global verwaltet:  ${httpBase}/#/admin/${prefix}/  (nur für Relay-Admins)\n`);
  console.log('Beide Konsolen gaten SCHREIBEN über echte, relay-durchgesetzte ACLs, nicht über die UI - jede');
  console.log('frisch generierte Browser-Identität sieht denselben Inhalt (alles hier ist öffentlich lesbar),');
  console.log('aber ein Speicherversuch wird lautlos abgelehnt, sofern die Identität nicht dazu berechtigt ist.');
  console.log('Für #/admin (und damit auch #/admin/' + prefix + '/) musst du NICHT die unten generierte relay-admin-');
  console.log('Identität importieren - JEDER Pubkey funktioniert dort, sobald er in QU_RELAY_ADMINS steht,');
  console.log('auch deine eigene, bereits existierende Browser-Identität (im devtools-Console `window.Qu.pub`).');
  console.log('Um stattdessen die unten generierte relay-admin-Identität in deinem Browser (selber Origin wie');
  console.log('das Relay) zu verwenden, füge sie in die devtools-Console ein:\n');
  console.log('  // relay-admin (für #/admin)');
  console.log(
    `  localStorage.setItem('qu-identity', JSON.stringify(${JSON.stringify({
      signingKey: QuCrypto.toBase64(relayAdmin.signingKey),
      signingPub: QuCrypto.toBase64(relayAdmin.signingPub),
      xPrivateKey: QuCrypto.toBase64(relayAdmin.xPrivateKey),
      xPublicKey: QuCrypto.toBase64(relayAdmin.xPublicKey),
    })})); location.reload();\n`
  );
  console.log('(Das kopiert einen echten privaten Schlüssel in den localStorage dieses Browser-Tabs - für ein');
  console.log('lokales Demo unbedenklich, niemals mit einer Produktions-Identität auf einer Maschine/einem');
  console.log('Browser-Profil tun, dem du nicht vollständig vertraust.)');

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
