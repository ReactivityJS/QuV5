#!/usr/bin/env node
/**
 * PLATFORM BOOTSTRAP — `npm run bootstrap:platform`. Two independent jobs,
 * always run in this order but decoupled from HOW you deploy:
 *
 *   1. Generate (or load) a `relay-admin` + `demo-app-admin` identity and
 *      print the exact `environment:` block your deployment needs -
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
 *      (`--relay`), exactly like `bin/install-admin-console.mjs`/
 *      `demo/install-app-shell-demo.mjs` already do, so it works
 *      identically regardless of whether that relay lives in a Compose
 *      service, a Swarm/`docker stack` service, a Kubernetes Pod, or bare
 *      metal. Unlike an app-admin (`demo-app-admin` below), which needs NO
 *      static config at all any more - `registerApp()` alone (this script's
 *      own step 2) is enough, the relay discovers it live (see
 *      `@qu/app-shell`'s own `live-app-resolver.js`) - `QU_RELAY_ADMINS` is
 *      genuinely the ONLY static list this whole deployment needs.
 *   2. Once the relay is actually reachable AND configured with that
 *      exact list (verified by attempting a real write and checking it
 *      gets acked - a relay still running the OLD config accepts the
 *      connection fine but silently drops the write), installs the admin
 *      console, creates a demo shell-app with its own CMS editor
 *      installed, and registers both `#/admin` and `#/demo` - replacing
 *      what used to be several separate manual steps with one, idempotent,
 *      safe-to-re-run command.
 *
 * TWO RUNS ARE NORMAL ON A FRESH SETUP, NOT A BUG: run it once to get the
 * config block, paste it into your OWN deployment config, redeploy
 * however you redeploy, then run it again (same command, same `--dir`) to
 * actually install content - it reuses the SAME already-generated
 * identities the second time, never regenerating them. Every write here
 * is idempotent or dedup-checked (see inline comments), so a THIRD, later
 * run (e.g. to re-install a newer admin console) is a harmless no-op too -
 * PROVIDED `--dir`/`QU_BOOTSTRAP_DIR` points at storage that actually
 * SURVIVES a redeploy (see "PERSISTING THE IDENTITY DIRECTORY" below) -
 * otherwise every run looks like a totally fresh setup, forever.
 *
 * PERSISTING THE IDENTITY DIRECTORY - A REAL FOOTGUN, NOT HYPOTHETICAL:
 * this script's whole "run it, paste the printed config, redeploy, run it
 * again" flow only works if the SAME `relay-admin`/`demo-app-admin`
 * keypairs are found on the SECOND run - `ensureIdentity()` below only
 * generates a fresh keypair when NOTHING is found at `<dir>/<name>.json`.
 * The default `--dir` (next to this script, inside the npm package/image)
 * lives on the CONTAINER's own ephemeral filesystem - fine for `docker
 * exec`ing into an ALREADY-RUNNING container repeatedly (the same
 * container, same filesystem), but GONE the instant that container is
 * recreated (any redeploy: `docker compose up` after a pull, `docker
 * stack deploy`, a Kubernetes rollout, ...), because nothing mounts that
 * path as a volume. The symptom is exactly "a brand-new relay-admin/
 * demo-app-admin pubkey on every redeploy, `QU_RELAY_ADMINS` printed
 * again from scratch, the OLD relay-admin's already-installed admin
 * console content becomes un-writable by the NEW one" - not a bug in the
 * ACL/live-resolver machinery itself (architecture.md's own "A fifth ACL
 * mode" section), a deployment footgun in how this ONE script is invoked.
 * Two ways to avoid it:
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
 * `qu-platform-apps` and the admin console's own content, see
 * `@qu/app-core`'s kinds.js own doc comment on the `'relay-admins'` mode).
 * Ordinary `'members'`-ACL Kinds, by contrast, already support self-join
 * (`QU_ALLOW_JOIN`, default true) - this script uses exactly that (a plain
 * `POST /join`, the SAME mechanism a real browser visitor's `shell.js`
 * uses) for both identities, so it never needs `QU_MEMBERS_JSON` printed
 * or configured at all. Note that being a relay-admin is NOT tied to any
 * particular generated identity - ANY pubkey works the moment it is
 * listed, including a real operator's own already-existing browser
 * identity (visible on the relay's unconfigured setup page) instead of
 * the `relay-admin` identity this script generates for non-interactive
 * bootstrapping.
 *
 * Usage:
 *   node packages/app-shell/bin/bootstrap-platform.mjs \
 *     [--relay ws://localhost:8081] [--dir packages/app-shell/.platform-identities] \
 *     [--prefix demo]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { WsClientTransport } from '@qu/space-transport';
import { EventBus } from '@qu/events';
import {
  installGlobalAppBundle,
  registerApp,
  createApp,
  createTemplate,
  createStyle,
  createPage,
  publishRoute,
  PlatformRuntime,
  ContentResolver,
  adminAppManifestKind,
  globalAppAnchor,
} from '@qu/app-core';
import { adminConsoleBundle } from '../admin-console-bundle.js';
import { installCms } from '../cms-bundle.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = join(HERE, '..', '.platform-identities');

function parseArgs(argv) {
  // QU_BOOTSTRAP_DIR - optional env var default, so a docker-compose.space-relay.yml-style
  // deployment can point this at an actually-persistent volume (see this file's own top doc
  // comment, "PERSISTING THE IDENTITY DIRECTORY") without every invocation needing an explicit
  // --dir flag. --dir (if given) still wins over it.
  const opts = { relay: 'ws://localhost:8081', dir: process.env.QU_BOOTSTRAP_DIR || DEFAULT_DIR, prefix: 'demo' };
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
 * write that config for you. `demo-app-admin` needs NO entry here at all -
 * it becomes reachable purely through `registerApp()` (this script's own
 * step 2), discovered live by the relay itself.
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
  const demoAppAdmin = await ensureIdentity('demo-app-admin', dir);
  console.log(`  relay-admin     pub: ${QuCrypto.toBase64(relayAdmin.signingPub)}`);
  console.log(`  demo-app-admin  pub: ${QuCrypto.toBase64(demoAppAdmin.signingPub)}`);
  console.log(`  (private keys stay local, under ${dir})\n`);

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
  const relayAdmins = [relayAdmin.signingPub]; // qu-platform-apps AND the admin console's own content are both 'relay-admins'-ACL - this Space needs the list to write/read either, see kinds.js's own doc comment.
  const mainSpace = new Space({ identity: relayAdmin, members: [{ pub: relayAdmin.signingPub, xPub: relayAdmin.xPublicKey }], relayAdmins, transport: mainTransport, bus: mainBus });
  const mainWrites = trackWrites(mainBus);

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
    console.log('  installing the built-in admin console content...');
    await installGlobalAppBundle(mainSpace, 'admin', adminConsoleBundle);
  }

  const platform = new PlatformRuntime(mainSpace);
  const existingApps = await platform.resolveApps({ timeout: 800 });
  if (!existingApps.some((a) => a.prefix === 'admin')) {
    console.log('  registering the "admin" alias...');
    await registerApp(mainSpace, { prefix: 'admin', name: 'Relay-Admin', realm: 'global' });
  } else {
    console.log('  "admin" alias already registered.');
  }

  // REGISTER FIRST, THEN SEED CONTENT - order matters now, unlike under the old static
  // QU_APP_ADMIN_PUBS model: a relay in PLATFORM mode discovers a brand-new app-admin's pubkey
  // LIVE, purely from THIS registerApp() write to qu-platform-apps (@qu/app-shell's own
  // live-app-resolver.js - no restart, no separate static list). Until that write has actually
  // reached the relay and its live resolver has rebuilt its classification, demo-app-admin's OWN
  // Nodes (qu-app, qu-route-registry, ...) are still 'named'-ACL client-side but get misclassified
  // relay-side as the ordinary 'content'-ACL fallback (kinds.js's own doc comment) - which needs a
  // grant nothing here ever sends, so the write would be silently rejected. Doing this BEFORE
  // connecting demo-app-admin at all (not just before its first write) removes the race entirely.
  const demoRegistered = existingApps.some((a) => a.prefix === prefix);
  if (!demoRegistered) {
    console.log(`  registering "#/${prefix}" (before seeding its content, so the relay's live resolver already knows this app-admin)...`);
    await registerApp(mainSpace, { prefix, appAdminPub: demoAppAdmin.signingPub, name: 'Demo Shell-App' });
    // mainWrites tracks EVERY write this Space makes (both aliases above); wait for all of them to
    // be relay-acked, THEN a short settle for the relay's own internal live-resolver Space (a
    // SEPARATE connection, watching the same registry) to receive the forwarded update and finish
    // rebuilding - see live-app-resolver.js's own doc comment on why this is a real, if brief, race.
    await waitUntilAllWritesAcked(mainWrites);
    await new Promise((resolve) => setTimeout(resolve, 300));
  } else {
    console.log(`  "#/${prefix}" already registered.`);
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

  const mainOk = await waitUntilAllWritesAcked(mainWrites);
  const demoOk = await waitUntilAllWritesAcked(demoWrites);
  mainTransport.close();
  demoTransport.close();

  if (!mainOk || !demoOk) {
    console.log('\n⚠ Some writes were never write-acked by the relay - it is reachable, but NOT (yet) running');
    console.log('  with this identity\'s config (a relay ignores QU_RELAY_ADMINS changes until it is');
    console.log('  actually (re)started with it - a plain restart of an already-running process/container');
    console.log('  does NOT re-read it by itself either, the process/container needs to be RECREATED with');
    console.log('  the new config).\n');
    printConfigBlock({ relayAdmin });
    console.log('Update your deployment with that config and redeploy/recreate it (however you deploy),');
    console.log('then re-run this exact command - it reuses the same identities and finishes from here.');
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
  console.log('save attempt is silently rejected unless you are actually signed in as the right identity.');
  console.log('For #/admin specifically, you do NOT have to import the generated relay-admin identity below -');
  console.log('ANY pubkey works there the moment it is listed in QU_RELAY_ADMINS, including your own browser\'s');
  console.log('already-existing identity (visit this relay once unconfigured to see its pubkey, or `window.Qu.pub`');
  console.log('in any already-configured page\'s devtools console) - just add IT to QU_RELAY_ADMINS instead/as well.');
  console.log('To act as one of the two identities below in your browser\'s devtools console (same origin as the');
  console.log('relay) instead, paste:\n');
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
