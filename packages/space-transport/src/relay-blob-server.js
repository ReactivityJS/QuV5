/**
 * RELAY BLOB SERVER — the HTTP endpoint that lets a relay hold a
 * DURABLE mirror of raw file bytes (an `UploadOutbox` upload - see
 * `@qu/space-plugins`'s `upload-outbox.js`'s own top doc comment on why a
 * relay's ordinary envelope-mirroring path is a poor fit for large binary
 * data), same shared-HTTP-layer factoring `relay-app-server.js` already
 * uses (`(req, res) => boolean` - `true` if handled, `false` to fall
 * through to the caller's own routes/404).
 *
 * ONCE the relay holds this copy, EVERY Space member downloads the file
 * FROM the relay (`GET`, below), never directly from the uploader's own
 * device - the same reason mirroring structured CRDT data at all exists
 * (see relay.js's own top doc comment): the original uploader might be
 * offline by the time someone else wants the file. `@qu/space-plugins`'s
 * `upload-outbox.js` "UPDATE - 'synced' status" doc comment covers the
 * OTHER half of this: a metadata record only reaches `'synced'` once the
 * relay has ack'd it, which in practice never happens before this
 * endpoint's own `PUT` already succeeded (an `upload()` callback - e.g.
 * `@qu/space-plugins`'s `blob-upload.js`'s `uploadToRelayBlob()` - talks to
 * THIS endpoint first, then the metadata write follows with the resulting
 * `{url}` already merged in - see that file's own doc comment).
 *
 * AUTHORIZATION: self-certifying, zero relay-side registry needed -
 * `@qu/space-core`'s `blob-auth.js`'s own top doc comment has the full
 * "why" (the same `deriveXNodeId()`-then-verify shape every other
 * self-certifying primitive in this framework already uses). `PUT` carries
 * `{pub, localId, sig}` (query string - see `handleUpload()` below);
 * `verifyBlobUpload()` recomputes the expected `blobId` from `(pub,
 * localId)` and rejects if it doesn't match the URL path, THEN checks the
 * signature - so only whoever holds the signing key for `pub` can ever
 * write to a `blobId` derived from it, no prior "who owns this id" state
 * needed anywhere.
 *
 * DOWNLOAD (`GET`) is deliberately UNAUTHENTICATED, same posture
 * `relay.js`'s `handleWatchPresence()` takes for a `'public'`
 * `onlineVisibility` (that function's own doc comment) - `blobId` is an
 * opaque SHA-256 digest (see `blob-auth.js`), unguessable in practice, so
 * "whoever holds the id/url" is itself the access control, the same
 * capability-URL posture ordinary blob storage services already use. An
 * app with stricter confidentiality needs should encrypt the bytes
 * client-side before ever calling `PUT`, exactly like `upload-outbox.js`'s
 * own doc comment already says for sensitive metadata fields.
 */
import { QuCrypto } from '@qu/core';
import { verifyBlobUpload } from '@qu/space-core';

const BLOB_PATH = /^\/blob\/([^/]+)$/;

/**
 * Reads `req`'s body into one Buffer, rejecting once `limit` bytes have arrived - unlike
 * `relay-app-server.js`'s own `readBody()` (small JSON only), this is the actual file payload, so
 * the limit is a real, caller-configurable ceiling, not an incidental one. Deliberately does NOT
 * `req.destroy()` itself on overflow - killing the socket before a response has been WRITTEN to it
 * leaves the client's own `fetch()` hanging forever waiting for a reply that can now never arrive
 * (the response and the request share one connection). The caller (`handleUpload()` below) writes
 * its error response first, THEN may close the connection.
 */
function readBinaryBody(req, { limit }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflowed = false;
    req.on('data', (chunk) => {
      if (overflowed) return; // still draining whatever the client keeps sending until it notices the response below - never buffered, never re-rejected.
      size += chunk.length;
      if (size > limit) {
        overflowed = true;
        reject(new Error(`request body exceeds the ${limit}-byte limit`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!overflowed) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function parseUploadAuth(url) {
  const pubB64 = url.searchParams.get('pub');
  const localId = url.searchParams.get('localId');
  const sigB64 = url.searchParams.get('sig');
  if (!pubB64 || !localId || !sigB64) return null;
  try {
    return { pub: QuCrypto.fromBase64(pubB64), localId, sig: QuCrypto.fromBase64(sigB64) };
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   blobStore: {save(blobId: string, bytes: Buffer): Promise<void>, load(blobId: string): Promise<Buffer|Uint8Array|null>}|null,
 *   maxBlobSize?: number,
 *   log?: (msg: string) => void,
 * }} params
 *   `blobStore` - e.g. `@qu/space-storage`'s `createBlobFileStore()`/`createMemoryBlobStore()`.
 *     `null` disables this endpoint entirely (every `/blob/*` request answers 503) - same "mirroring
 *     disabled" posture `relay-server.js`'s own `QU_RELAY_DATA_DIR=""` already gives the envelope
 *     mirror, applied here for whatever configures blob mirroring specifically.
 *   `maxBlobSize` - default 25 MiB. A relay operator's own ceiling on ONE file - deliberately not
 *     unbounded, unlike `relay-app-server.js`'s tiny JSON bodies this is real user-supplied binary
 *     data.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => boolean}
 */
export function createBlobRequestHandler({ blobStore, maxBlobSize = 25 * 1024 * 1024, log = console.log }) {
  async function handleUpload(req, res, blobId) {
    if (!blobStore) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('blob mirroring is disabled on this relay');
      return;
    }
    const auth = parseUploadAuth(new URL(req.url, 'http://blob-server'));
    if (!auth) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request: expected ?pub=<base64>&localId=<string>&sig=<base64>');
      return;
    }
    if (!(await verifyBlobUpload({ blobId, ...auth }))) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('unauthorized: signature does not authorize this blob id');
      return;
    }
    let bytes;
    try {
      bytes = await readBinaryBody(req, { limit: maxBlobSize });
    } catch (err) {
      res.writeHead(413, { 'content-type': 'text/plain' });
      res.end(`request entity too large: ${err.message}`);
      return;
    }
    await blobStore.save(blobId, bytes);
    log(`  📎 blob ${blobId} received (${bytes.length} bytes)`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, blobId, size: bytes.length }));
  }

  async function handleDownload(req, res, blobId) {
    if (!blobStore) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('blob mirroring is disabled on this relay');
      return;
    }
    const bytes = await blobStore.load(blobId);
    if (!bytes) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    // 'application/octet-stream', never a caller-supplied mimeType - see this file's own doc
    // comment: the relay never interprets blob content, only mirrors it. A consumer already knows
    // the real mimeType from the UploadOutbox metadata record this blob's `url` was merged into.
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) });
    res.end(bytes);
  }

  return function handleBlobRequest(req, res) {
    const path = req.url.split('?')[0];
    const match = BLOB_PATH.exec(path);
    if (!match) return false;
    const blobId = decodeURIComponent(match[1]);
    if (req.method === 'PUT') {
      handleUpload(req, res, blobId).catch((err) => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`internal error: ${err.message}`);
      });
      return true;
    }
    if (req.method === 'GET') {
      handleDownload(req, res, blobId).catch((err) => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`internal error: ${err.message}`);
      });
      return true;
    }
    return false;
  };
}
