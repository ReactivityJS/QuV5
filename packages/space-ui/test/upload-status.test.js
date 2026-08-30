/**
 * UPLOAD STATUS UI — the one test file in this package that goes end to
 * end through a real `@qu/space-core` `Space` and `@qu/space-plugins`
 * `UploadOutbox`, rather than a fake Field - the thing genuinely worth
 * proving here is the DOM<->UploadOutbox wiring itself, not the CRDT/crypto
 * underneath it (already covered by @qu/space-plugins' own tests).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { UploadOutbox } from '@qu/space-plugins';
import { bindFileInput, bindUploadStatusIcon } from '../src/upload-status.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

function silentTransport() {
  return { send() {}, sendTo() {}, onMessage() {}, getPeerId: () => 'silent' };
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

async function waitUntil(conditionFn, { timeout = 2000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

test('bindFileInput() enqueues every selected file into the outbox', async () => {
  const { window } = new JSDOM('<!doctype html><body><input type="file" multiple></body>');
  const { document, File } = window;
  const identity = await actor();
  const space = new Space({ identity, members: [], transport: silentTransport() });
  const outbox = new UploadOutbox(space, memoryLocalStore(), async () => {});

  const inputEl = document.querySelector('input');
  const enqueued = [];
  bindFileInput(inputEl, outbox, { onEnqueue: (id, file) => enqueued.push({ id, file }) });

  const file = new File(['hello world'], 'greeting.txt', { type: 'text/plain' });
  Object.defineProperty(inputEl, 'files', { value: [file], configurable: true });
  inputEl.dispatchEvent(new window.Event('change'));

  await waitUntil(() => enqueued.length === 1);
  assert.equal(enqueued[0].file.name, 'greeting.txt');

  const record = await outbox.statusOf(enqueued[0].id);
  assert.equal(record.name, 'greeting.txt');
  assert.equal(record.mimeType, 'text/plain');
});

test('bindUploadStatusIcon() keeps the icon\'s class in sync with the file\'s live status, and never hides it', async () => {
  const { window } = new JSDOM('<!doctype html><body><span id="icon"></span></body>');
  const { document } = window;
  const identity = await actor();
  const space = new Space({ identity, members: [], transport: silentTransport() });
  const localStore = memoryLocalStore();

  let resolveUpload;
  const outbox = new UploadOutbox(space, localStore, () => new Promise((resolve) => (resolveUpload = resolve)));
  const id = await outbox.enqueue({ name: 'slow.bin', size: 1, mimeType: 'application/octet-stream' }, 'bytes');

  const iconEl = document.getElementById('icon');
  await bindUploadStatusIcon(iconEl, outbox, id);

  assert.equal(iconEl.classList.contains('qu-upload-uploading'), true);
  assert.equal(iconEl.hidden, false); // never set - see upload-status.js's own doc comment.

  resolveUpload();
  await waitUntil(() => iconEl.classList.contains('qu-upload-done'));
  assert.equal(iconEl.hidden, false); // STILL not hidden on done - caller's stylesheet decides, this helper never removes/hides it.
});

test('bindUploadStatusIcon() reports "failed" with the error message in title', async () => {
  const { window } = new JSDOM('<!doctype html><body><span id="icon"></span></body>');
  const { document } = window;
  const identity = await actor();
  const space = new Space({ identity, members: [], transport: silentTransport() });
  const outbox = new UploadOutbox(space, memoryLocalStore(), async () => {
    throw new Error('server rejected the file');
  });
  const id = await outbox.enqueue({ name: 'bad.bin', size: 1, mimeType: 'application/octet-stream' }, 'bytes');

  const iconEl = document.getElementById('icon');
  await bindUploadStatusIcon(iconEl, outbox, id);
  await waitUntil(() => iconEl.classList.contains('qu-upload-failed'));
  assert.equal(iconEl.title, 'server rejected the file');
});
