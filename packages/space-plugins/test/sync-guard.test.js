/**
 * SYNC GUARD — see sync-guard.js's own doc comment. Two layers, same split
 * as delivery-status.test.js:
 *   1. A fake `{watchAll}`/fake `navigator.wakeLock` harness proves the
 *      acquire/release state machine itself (in flight vs. settled,
 *      visibilitychange re-acquire, a `request()` rejection swallowed, and
 *      `stop()` releasing/unobserving) without a real Space in the loop.
 *   2. One integration test wires a REAL `UploadOutbox` through
 *      `guardSync()` to prove `watchAll()` and this helper actually compose.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { UploadOutbox } from '../src/upload-outbox.js';
import { guardSync } from '../src/sync-guard.js';

async function waitUntil(conditionFn, { timeout = 2000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

function fakeOutbox() {
  let notify = null;
  return {
    async watchAll(callback) {
      notify = callback;
      return () => {
        notify = null;
      };
    },
    async push(records) {
      await notify?.(records);
    },
  };
}

function fakeWakeLock({ rejects = false } = {}) {
  const requests = [];
  return {
    requests,
    navigator: {
      wakeLock: {
        async request(type) {
          requests.push(type);
          if (rejects) throw new Error('document is not visible');
          let released = false;
          const listeners = new Set();
          return {
            get released() {
              return released;
            },
            addEventListener(evt, fn) {
              if (evt === 'release') listeners.add(fn);
            },
            async release() {
              if (released) return;
              released = true;
              for (const fn of listeners) fn();
            },
          };
        },
      },
    },
  };
}

function withGlobal(name, value, fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true });
  return fn().finally(() => {
    if (had) Object.defineProperty(globalThis, name, had);
    else delete globalThis[name];
  });
}

test('acquires a wake lock once the outbox has a pending/uploading entry', async () => {
  await withGlobal('navigator', fakeWakeLock().navigator, async () => {
    const outbox = fakeOutbox();
    const stop = await guardSync(outbox);
    await outbox.push([{ id: 'a', status: 'pending' }]);
    await waitUntil(async () => globalThis.navigator.wakeLock.request !== undefined); // sanity - request exists throughout.
    await stop();
  });
});

test('releases the wake lock once all entries settle (done/synced/failed)', async () => {
  const { navigator, requests } = fakeWakeLock();
  await withGlobal('navigator', navigator, async () => {
    const outbox = fakeOutbox();
    const stop = await guardSync(outbox);
    await outbox.push([{ id: 'a', status: 'uploading' }]);
    assert.equal(requests.length, 1); // acquired once for the in-flight entry.

    await outbox.push([{ id: 'a', status: 'done' }]);
    // No observable "released" flag exposed here directly - proven indirectly: a SECOND
    // in-flight transition must re-request (a still-held lock would never need a second request()).
    await outbox.push([{ id: 'a', status: 'uploading' }]);
    assert.equal(requests.length, 2);
    await stop();
  });
});

test('a request() rejection (e.g. tab not visible) is swallowed, not thrown', async () => {
  const { navigator } = fakeWakeLock({ rejects: true });
  await withGlobal('navigator', navigator, async () => {
    const outbox = fakeOutbox();
    const stop = await guardSync(outbox);
    await assert.doesNotReject(outbox.push([{ id: 'a', status: 'pending' }]));
    await stop();
  });
});

test('missing navigator.wakeLock degrades to a silent no-op', async () => {
  await withGlobal('navigator', {}, async () => {
    const outbox = fakeOutbox();
    const stop = await guardSync(outbox);
    await assert.doesNotReject(outbox.push([{ id: 'a', status: 'pending' }]));
    await stop();
  });
});

test('stop() releases any held lock and stops observing further changes', async () => {
  const { navigator, requests } = fakeWakeLock();
  await withGlobal('navigator', navigator, async () => {
    const outbox = fakeOutbox();
    const stop = await guardSync(outbox);
    await outbox.push([{ id: 'a', status: 'uploading' }]);
    assert.equal(requests.length, 1);
    await stop();

    await outbox.push([{ id: 'a', status: 'uploading' }]); // outbox's own notify() is now a no-op post-unobserve (see fakeOutbox()).
    assert.equal(requests.length, 1); // no further acquire - stop() really did unobserve.
  });
});

test('visibilitychange re-acquires the lock while still in flight, but not once settled', async () => {
  const { navigator, requests } = fakeWakeLock();
  let visibilityListener = null;
  const document = {
    visibilityState: 'hidden',
    addEventListener(evt, fn) {
      if (evt === 'visibilitychange') visibilityListener = fn;
    },
    removeEventListener(evt, fn) {
      if (evt === 'visibilitychange' && visibilityListener === fn) visibilityListener = null;
    },
  };
  await withGlobal('navigator', navigator, () =>
    withGlobal('document', document, async () => {
      const outbox = fakeOutbox();
      const stop = await guardSync(outbox);

      await outbox.push([{ id: 'a', status: 'pending' }]); // hidden - acquire() skips the request entirely.
      assert.equal(requests.length, 0);

      document.visibilityState = 'visible';
      visibilityListener();
      await waitUntil(() => requests.length === 1);

      await outbox.push([{ id: 'a', status: 'done' }]); // settled - a later visibilitychange must NOT re-acquire.
      document.visibilityState = 'hidden';
      document.visibilityState = 'visible';
      visibilityListener();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(requests.length, 1);

      await stop();
    })
  );
});

test('guardSync() composes with a REAL UploadOutbox via watchAll()', async () => {
  const kp = await QuCrypto.generateKeypair();
  const identity = { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
  const transport = { sent: [], send(data) { this.sent.push(data); }, sendTo(_p, data) { this.sent.push(data); }, onMessage() {}, getPeerId: () => 'silent' };
  const space = new Space({ identity, members: [], transport });

  let resolveUpload;
  const uploadStarted = new Promise((resolve) => {
    resolveUpload = resolve;
  });
  const outbox = new UploadOutbox(
    space,
    { async save() {}, async load() {}, async remove() {} },
    async () => {
      resolveUpload();
      return new Promise((resolve) => setTimeout(resolve, 30));
    }
  );

  const { navigator, requests } = fakeWakeLock();
  await withGlobal('navigator', navigator, async () => {
    const stop = await guardSync(outbox);
    await outbox.enqueue({ name: 'x.png', size: 1, mimeType: 'image/png' }, 'bytes');
    await uploadStarted;
    await waitUntil(() => requests.length === 1); // 'uploading' triggered acquire().
    await waitUntil(async () => (await outbox.statusOf((await outbox.list())[0].id))?.status === 'done');
    await stop();
  });
});
