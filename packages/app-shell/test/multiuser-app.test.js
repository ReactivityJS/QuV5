/**
 * MULTIUSER GLOBAL APPS — `kinds.js`'s own doc comment on
 * `platformAppsKind`'s three administrable states (`'off'`/`'global'`/
 * `'multiuser'`), `dev.js`'s `setAppMode()`, and `boot.js`'s
 * `parseMultiUserSubPath()`/`renderMultiUserRoute()`: a relay-admin
 * registers ONE global app ("cms") in `multiuser` mode, and TWO completely
 * independent, ordinary visitors each get their own, self-owned CMS-managed
 * page under it - `#/cms/u/me/...` - with ZERO relay-admin cooperation
 * beyond the app's OWN existence (no per-user registration, no grant, no
 * shared identity) - proving the actual point of this mode: self-owned
 * `'content'`-ACL Kinds need only an agreed-upon URL shape, never a
 * gatekeeper, to become usable by anyone. Also proves `mode: 'off'` makes
 * a REGISTERED app unreachable (falls to the landing page, indistinguishable
 * from never having existed), and that a later `setAppMode()` call is a
 * genuine state UPDATE (last entry for a prefix wins), not a second,
 * competing registration.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { registerApp, setAppMode, createAppResolveKindSchema, ContentResolver } from '@qu/app-core';
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

function submit(form, window) {
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

test('a relay-admin registers "cms" as a multiuser global app; two independent visitors each get their own self-provisioned, self-owned CMS page with zero cooperation, and mode:"off" makes it unreachable again', async () => {
  const relayAdmin = await actor();
  const alice = await actor();
  const bob = await actor();
  const members = [
    { pub: relayAdmin.signingPub, xPub: relayAdmin.xPublicKey },
    { pub: alice.signingPub, xPub: alice.xPublicKey },
    { pub: bob.signingPub, xPub: bob.xPublicKey },
  ];
  const relayAdmins = [relayAdmin.signingPub];
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema();
  createRelayForwarder({ hub, members, relayAdmins, resolveKindSchema, storage: createMemoryStore() });

  async function connect(identity, peerId) {
    const transport = new InProcessTransport(hub, peerId);
    await transport.connect();
    return new Space({ identity, members, relayAdmins, transport });
  }

  const relayAdminSpace = await connect(relayAdmin, 'relay-admin');
  await registerApp(relayAdminSpace, { prefix: 'cms', name: 'CMS', realm: 'global', mode: 'multiuser' });

  // --- Alice visits her OWN "/u/me/" for the very first time - self-provisioned on the spot. ---
  const aliceSpace = await connect(alice, 'alice-visit');
  const { window: aliceWindow } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://platform.test/#/cms/u/me/' });
  const aliceMount = aliceWindow.document.querySelector('qu-app-shell');
  const { router: aliceRouter } = startPlatform({ space: aliceSpace, mountEl: aliceMount, window: aliceWindow, resolveTimeout: 500 });

  // No page exists at "/" yet (installCms() only ever creates "/cms" - see its own doc comment),
  // so this first render is the ordinary NOT_FOUND fallback - just wait for ANY render cycle to
  // complete (proving the self-provisioning createApp()/installCms() calls ran) before navigating.
  await waitUntil(() => aliceMount.innerHTML.length > 0, { timeout: 5000 });

  // Navigate to her own CMS editor and create a page through the rendered form - never calling
  // the Dev API directly, proving the write path end to end.
  aliceRouter.navigate('/cms/u/me/cms');
  await waitUntil(() => aliceMount.querySelector('form[data-qu-action="cms-page-form"]'), { timeout: 4000 });

  const alicePageForm = aliceMount.querySelector('form[data-qu-action="cms-page-form"]');
  alicePageForm.querySelector('[name="route"]').value = '/';
  alicePageForm.querySelector('[name="title"]').value = "Alice's Seite";
  alicePageForm.querySelector('[name="content"]').value = '<p>Hallo von Alice</p>';
  submit(alicePageForm, aliceWindow);
  await waitUntil(() => /bestätigt/.test(alicePageForm.querySelector('[data-qu-status]')?.textContent ?? ''), { timeout: 4000 });

  aliceRouter.stop();

  // --- Bob, a COMPLETELY different, uninvolved identity, does the exact same at HIS OWN "/u/me/" -
  // no cooperation from Alice, the relay-admin, or anyone else beyond "cms" existing at all. ---
  const bobSpace = await connect(bob, 'bob-visit');
  const { window: bobWindow } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://platform.test/#/cms/u/me/' });
  const bobMount = bobWindow.document.querySelector('qu-app-shell');
  const { router: bobRouter } = startPlatform({ space: bobSpace, mountEl: bobMount, window: bobWindow, resolveTimeout: 500 });

  await waitUntil(() => bobMount.innerHTML.length > 0, { timeout: 5000 });
  bobRouter.navigate('/cms/u/me/cms');
  await waitUntil(() => bobMount.querySelector('form[data-qu-action="cms-page-form"]'), { timeout: 4000 });

  const bobPageForm = bobMount.querySelector('form[data-qu-action="cms-page-form"]');
  bobPageForm.querySelector('[name="route"]').value = '/';
  bobPageForm.querySelector('[name="title"]').value = "Bob's Seite";
  bobPageForm.querySelector('[name="content"]').value = '<p>Hallo von Bob</p>';
  submit(bobPageForm, bobWindow);
  await waitUntil(() => /bestätigt/.test(bobPageForm.querySelector('[data-qu-status]')?.textContent ?? ''), { timeout: 4000 });

  bobRouter.stop();

  // --- A totally uninvolved visitor confirms BOTH pages exist independently, correctly isolated
  // by owner pubkey, with no shared state between them. ---
  const visitor = await actor();
  const visitorSpace = await connect(visitor, 'visitor-check');
  const aliceResolver = new ContentResolver(visitorSpace, { appAdminPub: alice.signingPub });
  const alicePage = await aliceResolver.resolvePage('/', { timeout: 2000 });
  assert.equal(alicePage?.title, "Alice's Seite");
  const bobResolver = new ContentResolver(visitorSpace, { appAdminPub: bob.signingPub });
  const bobPage = await bobResolver.resolvePage('/', { timeout: 2000 });
  assert.equal(bobPage?.title, "Bob's Seite");
  assert.notEqual(alicePage.content, bobPage.content, "each user's own content is genuinely isolated, not shared global state");

  // --- The relay-admin now turns "cms" OFF - it must become unreachable, indistinguishable from
  // never having been registered at all, for a BRAND NEW visitor (not relying on anything cached). ---
  await setAppMode(relayAdminSpace, { prefix: 'cms', mode: 'off' });
  await new Promise((resolve) => setTimeout(resolve, 200)); // let the write settle.

  const carol = await actor();
  const carolSpace = await connect(carol, 'carol-visit');
  const { window: carolWindow } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://platform.test/#/cms/u/me/' });
  const carolMount = carolWindow.document.querySelector('qu-app-shell');
  const { router: carolRouter } = startPlatform({ space: carolSpace, mountEl: carolMount, window: carolWindow, resolveTimeout: 500 });

  await waitUntil(() => carolMount.textContent.includes('Qu App Shell'), { timeout: 4000 });
  assert.ok(!carolMount.querySelector('[data-qu-bind="cms-page-list"]'), '"cms" in mode:"off" must be unreachable - the landing page, not the app, must render');
  carolRouter.stop();
});
