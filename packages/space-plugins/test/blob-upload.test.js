/**
 * BLOB UPLOAD (client side) — see blob-upload.js's own doc comment.
 * Proves `uploadToRelayBlob()` against a REAL relay-blob-server.js HTTP
 * endpoint (same "real port, no mocking the wire" posture other
 * space-transport tests already take), and that it composes with
 * `UploadOutbox` exactly as designed: passed as the `upload()` callback,
 * its resolved `{url}` ends up merged into the outbox record on `'done'`
 * (`upload-outbox.js`'s own "UPDATE - UPLOAD RESULT" mechanism, task #45 -
 * this file proves the REAL relay-blob use case that feature was built for).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { createBlobRequestHandler } from '@qu/space-transport';
import { createMemoryBlobStore } from '@qu/space-storage';
import { uploadToRelayBlob } from '../src/blob-upload.js';
import { UploadOutbox } from '../src/upload-outbox.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function waitUntil(conditionFn, { timeout = 2000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

async function startBlobRelay() {
  const blobStore = createMemoryBlobStore();
  const handler = createBlobRequestHandler({ blobStore, log: () => {} });
  const httpServer = createServer((req, res) => {
    if (handler(req, res)) return;
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const url = `http://127.0.0.1:${httpServer.address().port}`;
  return {
    url,
    blobStore,
    close: () =>
      new Promise((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(resolve);
      }),
  };
}

function memoryLocalStore() {
  const blobs = new Map();
  return {
    async save(id, blob) {
      blobs.set(id, blob);
    },
    async load(id) {
      return blobs.get(id);
    },
    async remove(id) {
      blobs.delete(id);
    },
  };
}

test('uploadToRelayBlob() PUTs to a real relay-blob-server.js endpoint and the download round-trips the bytes', async () => {
  const alice = await actor();
  const relay = await startBlobRelay();
  const space = new Space({ identity: alice, members: [], transport: { async connect() {}, send() {}, onMessage() {} } });

  const bytes = Buffer.from('real file bytes');
  const { url, blobId } = await uploadToRelayBlob(space, relay.url, 'my-file-1', bytes);
  assert.equal(url, `${relay.url}/blob/${blobId}`);

  const downloaded = await relay.blobStore.load(blobId);
  assert.deepEqual(Buffer.from(downloaded), bytes);

  const fetched = await fetch(url);
  assert.equal(fetched.status, 200);
  assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), bytes);

  await relay.close();
});

test('uploadToRelayBlob() throws on a rejected upload (e.g. relay unreachable auth), never silently drops it', async () => {
  const alice = await actor();
  const relay = await startBlobRelay();
  const space = new Space({ identity: alice, members: [], transport: { async connect() {}, send() {}, onMessage() {} } });

  // A relay with blob mirroring disabled (blobStore: null) rejects every upload with 503.
  const disabledHandler = createBlobRequestHandler({ blobStore: null, log: () => {} });
  const httpServer = createServer((req, res) => {
    if (disabledHandler(req, res)) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const disabledUrl = `http://127.0.0.1:${httpServer.address().port}`;

  await assert.rejects(() => uploadToRelayBlob(space, disabledUrl, 'my-file-1', Buffer.from('x')), /relay rejected the upload/);

  await new Promise((resolve) => {
    httpServer.closeAllConnections();
    httpServer.close(resolve);
  });
  await relay.close();
});

test('UploadOutbox with uploadToRelayBlob() as its upload() callback: the resolved {url} is merged into the record on "done"', async () => {
  const alice = await actor();
  const relay = await startBlobRelay();
  const space = new Space({ identity: alice, members: [], transport: { async connect() {}, send() {}, onMessage() {} } });

  const outbox = new UploadOutbox(space, memoryLocalStore(), (record, blob) => uploadToRelayBlob(space, relay.url, record.id, blob));

  const bytes = Buffer.from('a real uploaded file, end to end');
  const id = await outbox.enqueue({ name: 'photo.png', size: bytes.length, mimeType: 'image/png' }, bytes);
  await waitUntil(async () => (await outbox.statusOf(id))?.status === 'done');

  const record = await outbox.statusOf(id);
  assert.ok(record.blobId);
  assert.equal(record.url, `${relay.url}/blob/${record.blobId}`);

  const downloaded = await relay.blobStore.load(record.blobId);
  assert.deepEqual(Buffer.from(downloaded), bytes);

  await relay.close();
});
