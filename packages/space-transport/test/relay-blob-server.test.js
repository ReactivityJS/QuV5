/**
 * RELAY BLOB SERVER — see relay-blob-server.js's own doc comment. Proves
 * the upload/download round trip over a REAL HTTP server/port (same
 * posture mirror-offline.test.js already takes for the WebSocket side),
 * the self-certifying upload authorization, and the size limit/disabled-
 * mirroring degradations.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { QuCrypto } from '@qu/core';
import { signBlobUpload, deriveBlobId } from '@qu/space-core';
import { createMemoryBlobStore } from '@qu/space-storage';
import { createBlobRequestHandler } from '../src/relay-blob-server.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey };
}

async function startServer(handler) {
  const httpServer = createServer((req, res) => {
    if (handler(req, res)) return;
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const url = `http://127.0.0.1:${httpServer.address().port}`;
  // fetch() keeps its underlying TCP connection alive by default - httpServer.close() alone waits
  // for every open connection to close first and would hang forever, so force them shut too.
  return {
    httpServer,
    url,
    close: () =>
      new Promise((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(resolve);
      }),
  };
}

function uploadUrl(baseUrl, { blobId, pub, localId, sig }) {
  const params = new URLSearchParams({ pub: QuCrypto.toBase64(pub), localId, sig: QuCrypto.toBase64(sig) });
  return `${baseUrl}/blob/${blobId}?${params}`;
}

test('PUT then GET a blob round-trips the exact bytes, over a real HTTP server', async () => {
  const alice = await actor();
  const blobStore = createMemoryBlobStore();
  const handler = createBlobRequestHandler({ blobStore, log: () => {} });
  const { url, close } = await startServer(handler);

  const proof = await signBlobUpload('file-1', alice);
  const bytes = Buffer.from('hello, this is real file content');
  const putRes = await fetch(uploadUrl(url, proof), { method: 'PUT', body: bytes });
  assert.equal(putRes.status, 200);
  const putBody = await putRes.json();
  assert.equal(putBody.ok, true);
  assert.equal(putBody.blobId, proof.blobId);
  assert.equal(putBody.size, bytes.length);

  const getRes = await fetch(`${url}/blob/${proof.blobId}`);
  assert.equal(getRes.status, 200);
  assert.equal(getRes.headers.get('content-type'), 'application/octet-stream');
  const downloaded = Buffer.from(await getRes.arrayBuffer());
  assert.deepEqual(downloaded, bytes);

  await close();
});

test('GET rejects (404) an unknown blobId, and download needs no authentication at all', async () => {
  const blobStore = createMemoryBlobStore();
  const handler = createBlobRequestHandler({ blobStore, log: () => {} });
  const { url, close } = await startServer(handler);

  const res = await fetch(`${url}/blob/blob-never-uploaded`);
  assert.equal(res.status, 404);

  await close();
});

test('PUT rejects (403) a blobId that does not derive from the claimed (pub, localId)', async () => {
  const alice = await actor();
  const bob = await actor();
  const blobStore = createMemoryBlobStore();
  const handler = createBlobRequestHandler({ blobStore, log: () => {} });
  const { url, close } = await startServer(handler);

  const aliceProof = await signBlobUpload('file-1', alice);
  const bobProof = await signBlobUpload('file-1', bob); // bob's OWN valid proof, for a DIFFERENT blobId.
  // Attempt: claim alice's blobId in the URL, but supply bob's (pub, localId, sig).
  const res = await fetch(uploadUrl(url, { ...bobProof, blobId: aliceProof.blobId }), { method: 'PUT', body: 'x' });
  assert.equal(res.status, 403);
  assert.equal(await blobStore.load(aliceProof.blobId), null); // nothing was ever saved under alice's id.

  await close();
});

test('PUT rejects (403) a forged signature', async () => {
  const alice = await actor();
  const mallory = await actor();
  const blobStore = createMemoryBlobStore();
  const handler = createBlobRequestHandler({ blobStore, log: () => {} });
  const { url, close } = await startServer(handler);

  const aliceProof = await signBlobUpload('file-1', alice);
  const malloryProof = await signBlobUpload('file-1', mallory); // a DIFFERENT, but well-formed, sig.
  const res = await fetch(uploadUrl(url, { ...aliceProof, sig: malloryProof.sig }), { method: 'PUT', body: 'x' });
  assert.equal(res.status, 403);

  await close();
});

test('PUT rejects (400) a request missing auth query params', async () => {
  const alice = await actor();
  const blobStore = createMemoryBlobStore();
  const handler = createBlobRequestHandler({ blobStore, log: () => {} });
  const { url, close } = await startServer(handler);

  const blobId = await deriveBlobId(alice.signingPub, 'file-1');
  const res = await fetch(`${url}/blob/${blobId}`, { method: 'PUT', body: 'x' });
  assert.equal(res.status, 400);

  await close();
});

test('PUT rejects (413) a body larger than maxBlobSize, and saves nothing', async () => {
  const alice = await actor();
  const blobStore = createMemoryBlobStore();
  const handler = createBlobRequestHandler({ blobStore, maxBlobSize: 8, log: () => {} });
  const { url, close } = await startServer(handler);

  const proof = await signBlobUpload('file-1', alice);
  const res = await fetch(uploadUrl(url, proof), { method: 'PUT', body: 'this is way more than 8 bytes' });
  assert.equal(res.status, 413);
  assert.equal(await blobStore.load(proof.blobId), null);

  await close();
});

test('with blobStore: null, both PUT and GET answer 503 - "mirroring disabled" degrades gracefully', async () => {
  const alice = await actor();
  const handler = createBlobRequestHandler({ blobStore: null, log: () => {} });
  const { url, close } = await startServer(handler);

  const proof = await signBlobUpload('file-1', alice);
  const putRes = await fetch(uploadUrl(url, proof), { method: 'PUT', body: 'x' });
  assert.equal(putRes.status, 503);
  const getRes = await fetch(`${url}/blob/${proof.blobId}`);
  assert.equal(getRes.status, 503);

  await close();
});

test('a non-/blob/ request falls through (handler returns false) so a caller can route it elsewhere', async () => {
  const blobStore = createMemoryBlobStore();
  const handler = createBlobRequestHandler({ blobStore, log: () => {} });
  const { url, close } = await startServer(handler);

  const res = await fetch(`${url}/members.json`); // not this handler's concern - falls through to the test server's own 404.
  assert.equal(res.status, 404);
  assert.equal(await res.text(), 'not found');

  await close();
});
