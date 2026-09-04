/**
 * ADMIN CONSOLE MODE TOGGLE — `admin-actions.js`'s per-`realm: 'global'`-app
 * mode buttons (`'off'`/`'global'`/`'multiuser'`, calling `@qu/app-core`'s
 * `setAppMode()`) and its "Verwalten"/"Eigener Bereich" links
 * (`#/admin/<prefix>/` / `#/<prefix>/u/me/`) - the admin console's own UI
 * for the three administrable states (kinds.js's own doc comment), not just
 * app REGISTRATION. Also exercises `registerApp()`/`setAppMode()`'s own
 * `getOrSyncRegistryNode()` fix: clicking a mode button right after the
 * list's own `resolveApps()` refresh is exactly the sequence that used to
 * make `setAppMode()` see an empty/torn-down local registry and throw
 * "not a registered app" (a real, observed regression `dev.js`'s own
 * `registerApp()` doc comment now explains).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { registerApp, installGlobalAppBundle, createAppResolveKindSchema } from '@qu/app-core';
import { startPlatform } from '../src/boot.js';
import { adminConsoleBundle } from '../admin-console-bundle.js';

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

test('the admin console\'s per-app mode buttons flip a registered global app\'s mode live, and its "Verwalten"/"Eigener Bereich" links point at the right routes', async () => {
  const relayAdmin = await actor();
  const members = [{ pub: relayAdmin.signingPub, xPub: relayAdmin.xPublicKey }];
  const relayAdmins = [relayAdmin.signingPub];
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema();
  createRelayForwarder({ hub, members, relayAdmins, resolveKindSchema, storage: createMemoryStore() });

  async function connect(identity, peerId) {
    const transport = new InProcessTransport(hub, peerId);
    await transport.connect();
    return new Space({ identity, members, relayAdmins, transport });
  }

  const bootstrapSpace = await connect(relayAdmin, 'relay-admin-bootstrap');
  await installGlobalAppBundle(bootstrapSpace, 'admin', adminConsoleBundle);
  await registerApp(bootstrapSpace, { prefix: 'admin', name: 'Relay-Admin', realm: 'global' });
  // Registered as "global" (not multiuser yet) - the very first mode-button click below flips it.
  await registerApp(bootstrapSpace, { prefix: 'cms', name: 'CMS', realm: 'global', mode: 'global' });

  const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://platform.test/#/admin' });
  const mountEl = window.document.querySelector('qu-app-shell');
  const space = await connect(relayAdmin, 'relay-admin-visit');
  const { router } = startPlatform({ space, mountEl, window, resolveTimeout: 500 });

  await waitUntil(() => mountEl.querySelector('[data-qu-bind="platform-apps-list"] li'));

  function cmsListItem() {
    return [...mountEl.querySelectorAll('[data-qu-bind="platform-apps-list"] li')].find((li) => li.textContent.includes('#/cms'));
  }

  await waitUntil(() => cmsListItem());
  let li = cmsListItem();
  assert.ok(li.querySelector('a[href="#/admin/cms/"]'), '"cms" (a realm:\'global\' app) gets a "Verwalten" link into its own global shell');
  assert.ok(!li.querySelector('a[href="#/cms/u/me/"]'), 'not yet mode:"multiuser" - no "Eigener Bereich" shortcut yet');

  const buttons = [...li.querySelectorAll('button')];
  const multiuserBtn = buttons.find((b) => b.textContent === 'Multi-User');
  assert.ok(multiuserBtn && !multiuserBtn.disabled, 'the "Multi-User" button is present and clickable (not the currently-active mode)');
  multiuserBtn.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));

  await waitUntil(() => cmsListItem()?.querySelector('a[href="#/cms/u/me/"]'), { timeout: 4000 });
  li = cmsListItem();
  assert.ok(li.textContent.includes('Multi-User'), 'the list re-rendered to reflect the new mode');
  assert.ok(li.querySelector('a[href="#/cms/u/me/"]'), 'now mode:"multiuser" - the "Eigener Bereich" shortcut appears');
  assert.ok(!li.querySelector('[data-qu-status]')?.textContent, 'no error surfaced - the click actually succeeded (setAppMode() found the registry, thanks to getOrSyncRegistryNode())');

  router.stop();
});
