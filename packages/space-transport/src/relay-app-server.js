/**
 * RELAY APP SERVER — the shared HTTP layer served alongside a relay's
 * WebSocket endpoint: the browser client's static files, `GET
 * /members.json`, and `POST /join`. Factored out here (rather than
 * duplicated between `relay-server.js` and `demo/relay.mjs`) because the
 * intent is for this to grow into "the app the relay serves on start" -
 * see `relay-server.js`'s own doc comment for how it's wired in there
 * today, and the repo's own roadmap for what replaces the current
 * `demo/web/` client with a real one later.
 *
 * JOIN — lets any connecting client register a self-generated identity's
 * PUBLIC halves as a new `'members'`-mode Space member, without
 * restarting the relay (`relay.addMember()`, see relay.js's own doc
 * comment). Gated by the CALLER-supplied `allowJoin` (default `true`) -
 * `NO AUTHENTICATION beyond well-formed base64 keys` when enabled is a
 * deliberate, current default ("anyone should be able to connect," a
 * product decision made explicitly, not an oversight - see
 * `relay-server.js`'s own doc comment on `QU_ALLOW_JOIN`), and `allowJoin`
 * existing as a parameter at all is exactly what makes turning it off
 * later - per-deployment, or eventually per-request/role - a config
 * change here rather than new code.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { QuCrypto } from '@qu/core';

const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/bundle.js': { file: 'dist/bundle.js', type: 'application/javascript; charset=utf-8' },
  '/bundle.js.map': { file: 'dist/bundle.js.map', type: 'application/json; charset=utf-8' },
};

/** Bounded read of a request body - no endpoint here needs more than a small JSON object. */
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

/**
 * @param {{
 *   webDir: string,
 *   members: Array<{name?: string, pub: Uint8Array, xPub: Uint8Array}>,
 *   relay: {addMember: (member: object) => void},
 *   allowJoin?: boolean,
 *   onJoin?: (member: {name: string, pub: Uint8Array, xPub: Uint8Array, fingerprint: string}) => void,
 *   log?: (msg: string) => void,
 * }} params
 *   `members` is mutated in place (pushed to) on a successful join - pass
 *   the SAME array also given to `createRelayForwarder({members})` so
 *   `/members.json` and this relay's own encryption-recipient list both
 *   reflect a join, not just one of them.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => boolean}
 *   `true` if this request was handled (a response was already sent);
 *   `false` if not (the caller should fall through to its own routes/404).
 */
export function createAppRequestHandler({ webDir, members, relay, allowJoin = true, onJoin = () => {}, log = console.log }) {
  async function handleJoin(req, res) {
    if (!allowJoin) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('joining is disabled on this relay (QU_ALLOW_JOIN=false)');
      return;
    }
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
    // Also update THIS array (relay.addMember() only updates relay.js's own, independent copy -
    // see that file's own doc comment) so /members.json reflects the join too, otherwise other
    // clients would never learn this member's xPub and could never encrypt-for them.
    if (!members.some((m) => QuCrypto.toBase64(m.pub) === pub)) members.push({ name, pub: pubBytes, xPub: xPubBytes });
    const fingerprint = await QuCrypto.fingerprint(pubBytes);
    log(`  🌐 ${name} joined  [${fingerprint}]`);
    onJoin({ name, pub: pubBytes, xPub: xPubBytes, fingerprint });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, fingerprint }));
  }

  function handleMembersJson(req, res) {
    const list = members.map((m) => ({ name: m.name ?? null, pub: QuCrypto.toBase64(m.pub), xPub: QuCrypto.toBase64(m.xPub) }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(list));
  }

  return function handleAppRequest(req, res) {
    if (req.method === 'POST' && req.url === '/join') {
      handleJoin(req, res).catch((err) => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`internal error: ${err.message}`);
      });
      return true;
    }
    if (req.method === 'GET' && req.url === '/members.json') {
      handleMembersJson(req, res);
      return true;
    }
    const staticEntry = req.method === 'GET' ? STATIC_FILES[req.url] : null;
    if (staticEntry) {
      readFile(join(webDir, staticEntry.file))
        .then((content) => {
          res.writeHead(200, { 'content-type': staticEntry.type });
          res.end(content);
        })
        .catch(() => {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('not found');
        });
      return true;
    }
    return false;
  };
}
