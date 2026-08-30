#!/usr/bin/env node
/**
 * DEMO RELAY — `npm run demo:relay`. A real WebSocket relay for the
 * text-exchange demo (see `demo/README.md`), wired the same way
 * `packages/space-transport/src/relay-server.js` is, just with its
 * `SPACE_MEMBERS_JSON` derived automatically from whatever identities
 * already exist under `demo/.identities/` (see `demo/lib/identity.mjs`)
 * instead of requiring it to be hand-assembled.
 *
 * Also wires an `@qu/events` bus + `registerPushHandler()`: any chat
 * message carrying a `notify` hint (see `chat.mjs`) is routed here based
 * on the `PresenceTracker`'s own view of who's currently connected - a
 * recipient who's online gets nothing extra (their live connection above
 * already delivers it); an offline one gets a logged "would send Web
 * Push" line, proving the routing without this demo needing real VAPID
 * keys/a push subscription store (see push-handler.js's own doc comment).
 *
 * SERVES THE BROWSER DEMO on this SAME HTTP server/port, alongside the
 * WebSocket upgrade endpoint - `GET /` and `/index.html` (the page),
 * `GET /bundle.js`/`.map` (esbuild-bundled from `demo/web/main.js` at
 * startup - see `demo/web/build.mjs`), `GET /members.json` (every current
 * member's PUBLIC halves + name, so a browser tab can build its own
 * `Space`'s `members` list), and `POST /join` (see that handler's own doc
 * comment below). One port, one process - exactly what lets you put a
 * single reverse proxy in front for HTTPS/TLS-offloading (WebSocket
 * upgrades pass through a reverse proxy the same way plain HTTP requests
 * do, as long as it's configured to forward the `Upgrade`/`Connection`
 * headers - any standard proxy config for WebSocket backends works here
 * unmodified, nothing relay-specific to configure beyond that).
 *
 * Usage: node demo/relay.mjs [--port 8081] [--dir demo/.identities] [--data demo/.data]
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { QuCrypto } from '@qu/core';
import { defineKind } from '@qu/space-core';
import { createFileStore } from '@qu/space-storage';
import { createWsServerHub, createRelayForwarder, registerPushHandler } from '@qu/space-transport';
import { EventBus } from '@qu/events';
import { ensureIdentity, loadMembers, fingerprintOf, DEFAULT_IDENTITY_DIR } from './lib/identity.mjs';
import { buildWebBundle } from './web/build.mjs';

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), 'web');

// MUST match chat.mjs's and web/main.js's own defineKind() call - all three processes need the identical Kind-Schema shape.
const chatKind = defineKind('demo-chat', { fields: { messages: { shape: 'list' } }, notifyTopics: ['message', 'mention'] });

function parseArgs(argv) {
  const opts = { port: 8081, dir: DEFAULT_IDENTITY_DIR, data: new URL('.data/', import.meta.url).pathname };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') opts.port = Number(argv[++i]);
    else if (argv[i] === '--dir') opts.dir = argv[++i];
    else if (argv[i] === '--data') opts.data = argv[++i];
  }
  return opts;
}

const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/bundle.js': { file: 'dist/bundle.js', type: 'application/javascript; charset=utf-8' },
  '/bundle.js.map': { file: 'dist/bundle.js.map', type: 'application/json; charset=utf-8' },
};

/** @param {string} body - Bounded read of a request body, for the one small JSON endpoint (/join) this server has - no request body elsewhere. */
function readBody(req, { limit = 8192 } = {}) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function main() {
  const { port, dir, data } = parseArgs(process.argv.slice(2));

  console.log('[demo-relay] bundling browser client…');
  await buildWebBundle();

  // Bootstrap the demo's two default identities if this is a first run - a
  // relay needs to know every authorized member's public key up front, so
  // it should not have to wait for "alice"/"bob" to connect once each first.
  await ensureIdentity('alice', dir);
  await ensureIdentity('bob', dir);

  const members = await loadMembers(dir);
  if (members.length === 0) {
    console.error(`[demo-relay] no identities found under ${dir} - run "npm run demo:alice"/"npm run demo:bob" first, or pass --dir.`);
    process.exit(1);
  }

  console.log('Qu V5 — demo relay (real WebSocket, real disk mirror, browser demo)\n');
  for (const m of members) console.log(`  authorized member: ${m.name.padEnd(10)} ${await fingerprintOf(m.pub)}`);
  console.log();

  const storage = createFileStore(data);
  const bus = new EventBus();

  // The WebSocket hub must exist before createRelayForwarder() (it calls
  // hub.registerRelay() synchronously) - built here from a plain node:http
  // server that also serves the browser demo's static files/API below.
  const httpServer = createServer((req, res) => handleRequest(req, res));
  const wss = new WebSocketServer({ server: httpServer });
  const hub = createWsServerHub(wss);
  const relay = createRelayForwarder({ hub, members, resolveKindSchema: () => chatKind, storage, bus });
  registerPushHandler(bus, {
    sendPush: (p) => console.log(`  📮 ~${p.to.slice(0, 12)}… is offline -> sending Web Push: "${p.kind}.${p.topic}" (from ~${p.authorPub.slice(0, 12)}…)`),
  });

  /**
   * JOIN — lets a browser tab (see `demo/web/main.js`) register a
   * self-generated identity's PUBLIC halves as a new Space member, without
   * restarting this relay (`relay.addMember()`, see relay.js's own doc
   * comment on it). Body: `{name, pub, xPub}`, `pub`/`xPub` base64.
   *
   * NO AUTHENTICATION beyond "the JSON is well-formed base64" - this is a
   * demo-only, loud, deliberate tradeoff: anyone who can reach this port
   * can join the room as a new, fully-authorized member. Acceptable for
   * "two people testing on a LAN/tunnel," not for anything actually
   * private - a real deployment behind your reverse proxy would gate this
   * behind its own auth (an invite token, a session cookie, ...) before
   * ever calling `relay.addMember()`, which this demo intentionally
   * doesn't build (see `docs/v5-space-core-guide.md`'s "known gaps").
   */
  async function handleJoin(req, res) {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (err) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end(`bad request: ${err.message}`);
      return;
    }
    const { name, pub, xPub } = payload ?? {};
    if (typeof name !== 'string' || !name || typeof pub !== 'string' || typeof xPub !== 'string') {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request: expected {name, pub, xPub} (pub/xPub base64)');
      return;
    }
    let pubBytes;
    let xPubBytes;
    try {
      pubBytes = QuCrypto.fromBase64(pub);
      xPubBytes = QuCrypto.fromBase64(xPub);
      if (pubBytes.length !== 32 || xPubBytes.length !== 32) throw new Error('key must be 32 raw bytes');
    } catch (err) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end(`bad request: ${err.message}`);
      return;
    }
    relay.addMember({ pub: pubBytes, xPub: xPubBytes, name });
    // Also update THIS file's own member list (relay.addMember() only updates relay.js's internal,
    // independent copy - see that file's own doc comment) so /members.json reflects the join too,
    // otherwise other clients would never learn this member's xPub and could never encrypt-for them.
    if (!members.some((m) => QuCrypto.toBase64(m.pub) === pub)) members.push({ name, pub: pubBytes, xPub: xPubBytes });
    const fingerprint = await QuCrypto.fingerprint(pubBytes);
    console.log(`  🌐 ${name} joined via browser  [${fingerprint}]`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, fingerprint }));
  }

  async function handleMembersJson(req, res) {
    const list = await Promise.all(
      members.map(async (m) => ({ name: m.name, pub: QuCrypto.toBase64(m.pub), xPub: QuCrypto.toBase64(m.xPub) }))
    );
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(list));
  }

  function handleRequest(req, res) {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (req.method === 'POST' && req.url === '/join') {
      handleJoin(req, res).catch((err) => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`internal error: ${err.message}`);
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/members.json') {
      handleMembersJson(req, res).catch((err) => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`internal error: ${err.message}`);
      });
      return;
    }
    const staticEntry = req.method === 'GET' ? STATIC_FILES[req.url] : null;
    if (staticEntry) {
      readFile(join(WEB_DIR, staticEntry.file))
        .then((content) => {
          res.writeHead(200, { 'content-type': staticEntry.type });
          res.end(content);
        })
        .catch(() => {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('not found');
        });
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }

  httpServer.listen(port, () => {
    console.log(`[demo-relay] listening on http://localhost:${port} (WebSocket on the same port) - mirroring to ${data}`);
    console.log(`[demo-relay] browser demo: open http://localhost:${port}/ in a browser.`);
    console.log('[demo-relay] blind relay: it verifies signatures but never sees plaintext.');
    console.log('[demo-relay] presence-gated push routing active - watch this terminal when a client is not running.\n');
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
