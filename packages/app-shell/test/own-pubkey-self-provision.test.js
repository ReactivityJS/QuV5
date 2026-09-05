/**
 * SELF-PROVISIONING AT YOUR OWN BARE PUBKEY — `boot.js`'s `startPlatform()`
 * own doc comment on why `ensureSelfProvisioned()` also fires at
 * `PlatformRuntime`'s pre-existing, always-on "unregistered prefix = a
 * literal owner id" fallback, not just inside a `mode: 'multiuser'` app's
 * own `/u/me/` route: `#/<your-own-base64url-pubkey>/` becomes a real,
 * working personal CMS-managed space on first visit - zero app
 * registration, zero relay-admin cooperation, not even a "cms" app needed
 * on this platform at all. Also proves this is scoped to your OWN
 * identity only - visiting a DIFFERENT (real but uninvolved) identity's
 * own pubkey route stays a plain, side-effect-free 404, never conjuring
 * content into someone else's name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { createAppResolveKindSchema, ContentResolver } from '@qu/app-core';
import { startPlatform } from '../src/boot.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function waitUntil(conditionFn, { timeout = 4000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

test('a fresh visitor\'s own bare "#/<pubkey>/" route self-provisions a personal CMS space with no app registered at all; a DIFFERENT identity\'s own pubkey route never does', async () => {
  const alice = await actor();
  const bob = await actor(); // never writes anything - proves visiting BOB's own pubkey never self-provisions on Alice's behalf.
  const members = [
    { pub: alice.signingPub, xPub: alice.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
  ];
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema();
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });

  async function connect(identity, peerId) {
    const transport = new InProcessTransport(hub, peerId);
    await transport.connect();
    return new Space({ identity, members, transport });
  }

  const aliceId = QuCrypto.toBase64Url(alice.signingPub);
  const bobId = QuCrypto.toBase64Url(bob.signingPub);

  // Alice visits HER OWN bare pubkey route - no "cms" app, no registration, nothing installed on
  // this platform at all beyond the relay itself.
  const aliceSpace = await connect(alice, 'alice');
  const { window: aliceWindow } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: `https://platform.test/#/${aliceId}/` });
  const aliceMount = aliceWindow.document.querySelector('qu-app-shell');
  const { router: aliceRouter } = startPlatform({ space: aliceSpace, mountEl: aliceMount, window: aliceWindow, resolveTimeout: 500 });

  await waitUntil(() => aliceMount.innerHTML.length > 0, { timeout: 5000 });
  aliceRouter.navigate(`/${aliceId}/cms`);
  await waitUntil(() => aliceMount.querySelector('form[data-qu-action="cms-page-form"]'), { timeout: 4000 });

  const form = aliceMount.querySelector('form[data-qu-action="cms-page-form"]');
  form.querySelector('[name="route"]').value = '/';
  form.querySelector('[name="title"]').value = "Alice's eigener Bereich";
  form.querySelector('[name="content"]').value = '<p>Kein Prefix noetig</p>';
  form.dispatchEvent(new aliceWindow.Event('submit', { bubbles: true, cancelable: true }));
  await waitUntil(() => /best.tigt/.test(form.querySelector('[data-qu-status]')?.textContent ?? ''), { timeout: 4000 });
  aliceRouter.stop();

  // An uninvolved visitor confirms Alice's page really landed at HER OWN derived id.
  const checkerSpace = await connect(await actor(), 'checker');
  const resolver = new ContentResolver(checkerSpace, { appAdminPub: alice.signingPub });
  const page = await resolver.resolvePage('/', { timeout: 2000 });
  assert.equal(page?.title, "Alice's eigener Bereich");

  // Bob's own bare pubkey route, visited by a DIFFERENT, uninvolved reader - Bob never wrote
  // anything, so this must stay a plain 404, never self-provisioning on a non-owning visitor's behalf.
  const readerSpace = await connect(await actor(), 'reader');
  const { window: readerWindow } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: `https://platform.test/#/${bobId}/` });
  const readerMount = readerWindow.document.querySelector('qu-app-shell');
  const { router: readerRouter } = startPlatform({ space: readerSpace, mountEl: readerMount, window: readerWindow, resolveTimeout: 500 });
  await waitUntil(() => readerMount.innerHTML.length > 0, { timeout: 4000 });
  assert.ok(readerMount.textContent.includes('404'), 'visiting a DIFFERENT identity\'s own pubkey route never self-provisions - stays a plain not-found');
  readerRouter.stop();

  const bobManifest = await new ContentResolver(checkerSpace, { appAdminPub: bob.signingPub }).resolveManifest({ timeout: 800 });
  assert.equal(bobManifest, null, 'Bob\'s own space was never conjured into existence by someone else visiting it');
});
