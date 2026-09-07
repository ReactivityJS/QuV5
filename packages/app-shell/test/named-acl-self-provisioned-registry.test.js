/**
 * SELF-PROVISIONED 'named'-ACL REGISTRIES — a REAL, previously-shipped bug
 * this file exists to catch a regression of: `qu-app`/`qu-route-registry`/
 * `qu-template-registry`/`qu-style-registry` are all `acl.write: 'named'`
 * (`@qu/app-core`'s kinds.js) - self-certifying by DESIGN (the relay's own
 * `buildWriteAcl()`, `@qu/space-transport`'s relay.js, needs no grant for
 * them, just `deriveOwnerNodeId(claimedSignerPub, kind) === nodeId`) - but
 * `createAppResolveKindSchema()` (relay-resolver.js) used to only be able
 * to CLASSIFY a nodeId as one of these Kinds for an owner already listed
 * in its own `appAdminPubs` parameter, falling back to the generic
 * `pageKind` ('content'-ACL, grant-only) otherwise - silently rejecting
 * every one of these registry writes for anyone NOT pre-registered.
 *
 * A `mode: 'multiuser'` app's own self-provisioned participant
 * (`@qu/app-shell`'s `boot.js` `ensureSelfProvisioned()`) is, BY DESIGN,
 * never `registerApp()`-registered anywhere - the whole point of the mode
 * is ZERO relay-admin cooperation. So EVERY personal registry write such a
 * participant makes used to be silently dropped by the relay - invisible
 * from their OWN already-connected Space (a local write always applies to
 * its own Y.Doc regardless of what the relay does with it), only
 * surfacing on a genuine RECONNECT (a fresh Space with nothing local to
 * fall back on) or when a DIFFERENT peer tries to enumerate their routes/
 * templates/styles - exactly what this test does, and exactly the
 * reported symptom ("mein CMS zeigt nach einem Reload keine Seiten mehr
 * an") this fix addresses.
 *
 * Fixed by teaching `createAppResolveKindSchema()`'s returned resolver a
 * DYNAMIC fallback: given the write/subscribe's own (still unverified at
 * that point) claimed signer pubkey, re-derive whether it happens to be
 * exactly this owner's manifest/route-registry/template-registry/style-
 * registry id - safe because the REAL authorization check independently
 * re-verifies the same derivation against the CRYPTOGRAPHICALLY VERIFIED
 * signer afterward (a forged claim never gets past signature verification
 * regardless of what it got classified as).
 *
 * This test ALSO doubles as the "personal space vs. global shell content
 * never leaks into each other" check for the exact scenario a real
 * relay-admin hits: the SAME identity is both a relay-admin (writing the
 * "cms" app's own GLOBAL shell at `#/admin/cms/cms`) AND an ordinary
 * multiuser participant (writing their OWN personal space at `#/cms/cms`)
 * - two completely different owner anchors, two completely different
 * Kind sets (`pageKind` vs `adminPageKind`), so a page created in one MUST
 * NOT appear in the other's own "Seiten" list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { registerApp, createAppResolveKindSchema, ContentResolver, pageKind, adminPageKind, publishGlobalRoute, createGlobalApp, globalAppAnchor } from '@qu/app-core';
import { cmsBundle, installGlobalCms } from '../cms-bundle.js';
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

test('a relay-admin who is ALSO a self-provisioned multiuser participant: their OWN page really lands in their OWN CMS "Seiten" list (not silently dropped), and stays genuinely separate from the app\'s global shell', async () => {
  const relayAdmin = await actor();
  const members = [{ pub: relayAdmin.signingPub, xPub: relayAdmin.xPublicKey }];
  const relayAdmins = [relayAdmin.signingPub];
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({
    globalApps: [
      { prefix: 'admin', templateNames: ['main'], pageRoutes: ['/'] },
      { prefix: 'cms', templateNames: ['__cms__'], pageRoutes: ['/', '/cms', '/cms/templates', '/cms/styles', '/cms/content'] },
    ],
    // Deliberately NO appAdminPubs - relayAdmin is never registerApp()-registered as an ordinary
    // app-admin, exactly the self-provisioned-participant scenario this test guards.
  });
  createRelayForwarder({ hub, members, relayAdmins, resolveKindSchema, storage: createMemoryStore() });

  async function connect(peerId) {
    const transport = new InProcessTransport(hub, peerId);
    await transport.connect();
    return new Space({ identity: relayAdmin, members, relayAdmins, transport });
  }

  const bootstrapSpace = await connect('bootstrap');
  await registerApp(bootstrapSpace, { prefix: 'admin', name: 'Relay-Admin', realm: 'global' });
  await registerApp(bootstrapSpace, { prefix: 'cms', name: 'CMS', realm: 'global', mode: 'multiuser' });
  await publishGlobalRoute(bootstrapSpace, 'cms', { route: '/', title: 'CMS' });
  await publishGlobalRoute(bootstrapSpace, 'cms', { route: cmsBundle.page.route, title: cmsBundle.page.title });
  await createGlobalApp(bootstrapSpace, 'cms', { name: 'CMS', rootTemplate: cmsBundle.template.name, defaultRoute: '/' });
  await installGlobalCms(bootstrapSpace, 'cms');

  // --- Personal space: relay-admin visits their OWN bare "#/cms/" and creates a page. ---
  const personalSpace = await connect('personal');
  const { window: pw } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://platform.test/#/cms/' });
  const pMount = pw.document.querySelector('qu-app-shell');
  const { router: pRouter } = startPlatform({ space: personalSpace, mountEl: pMount, window: pw, resolveTimeout: 500 });
  await waitUntil(() => pMount.innerHTML.length > 0, { timeout: 5000 });
  // Visit /cms/templates FIRST, purely as a READINESS signal: the self-provisioned "__cms__"
  // template (installCms()'s own doc comment) is registered via registerContentName(), so its
  // presence in the template list is tied to this Space's OWN self-provisioning writes having
  // actually landed - unlike the Content list (installCms()'s own pages are deliberately never
  // publishRoute()d - "/cms* are maintenance routes" - so it starts out genuinely empty and can't
  // serve as this same signal).
  pRouter.navigate('/cms/cms/templates');
  await waitUntil(() => [...pMount.querySelectorAll('[data-qu-bind="cms-template-list"] button')].some((b) => b.textContent === '__cms__'), { timeout: 4000 });
  pRouter.navigate('/cms/cms/content');
  await waitUntil(() => pMount.querySelector('form[data-qu-action="cms-content-form"]'), { timeout: 4000 });
  const pForm = pMount.querySelector('form[data-qu-action="cms-content-form"]');
  pForm.querySelector('[name="route"]').value = '/';
  pForm.querySelector('[name="title"]').value = 'PERSONAL PAGE';
  pForm.querySelector('[name="content"]').value = '<p>personal</p>';
  submit(pForm, pw);
  await waitUntil(() => /best.tigt/.test(pForm.querySelector('[data-qu-status]')?.textContent ?? ''), { timeout: 4000 });
  pRouter.stop();

  // --- Global space: same relay-admin visits "#/admin/cms/cms" (the GLOBAL shell's own editor). ---
  const globalSpace = await connect('global');
  const { window: gw } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://platform.test/#/admin/cms/cms/content' });
  const gMount = gw.document.querySelector('qu-app-shell');
  const { router: gRouter } = startPlatform({ space: globalSpace, mountEl: gMount, window: gw, resolveTimeout: 500 });
  // Wait for the page LIST to actually show the pre-existing "/cms" route, not just for the form
  // element to exist in the DOM - wirePages()'s own tail (which computes `anchor` and calls
  // holdRegistry()/refreshList()) runs AFTER renderPage() has already set innerHTML, so the form
  // can be present in the DOM slightly before wireCms() has actually finished wiring it up.
  await waitUntil(() => [...gMount.querySelectorAll('[data-qu-bind="cms-content-list"] li')].some((li) => li.textContent === '/cms'), { timeout: 5000 });
  const gForm = gMount.querySelector('form[data-qu-action="cms-content-form"]');
  gForm.querySelector('[name="route"]').value = '/';
  gForm.querySelector('[name="title"]').value = 'GLOBAL PAGE';
  gForm.querySelector('[name="content"]').value = '<p>global</p>';
  submit(gForm, gw);
  await waitUntil(() => /best.tigt/.test(gForm.querySelector('[data-qu-status]')?.textContent ?? ''), { timeout: 4000 });

  const gListItems = [...gMount.querySelectorAll('[data-qu-bind="cms-content-list"] li')].map((li) => li.textContent);
  assert.deepEqual(new Set(gListItems), new Set(['/', '/cms', '/cms/templates', '/cms/styles', '/cms/content']), 'the GLOBAL editor\'s own "Inhalt" list shows only global routes, never the personal page');
  gRouter.stop();

  // Re-open the PERSONAL editor as a genuinely FRESH connection (no local state to fall back on -
  // this is the exact condition that used to expose the bug) and check ITS list.
  const personalSpace2 = await connect('personal-2');
  const { window: pw2 } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://platform.test/#/cms/cms/content' });
  const pMount2 = pw2.document.querySelector('qu-app-shell');
  const { router: pRouter2 } = startPlatform({ space: personalSpace2, mountEl: pMount2, window: pw2, resolveTimeout: 500 });
  await waitUntil(() => {
    const items = [...pMount2.querySelectorAll('[data-qu-bind="cms-content-list"] li')];
    return items.length > 0 && items.some((li) => li.textContent === '/');
  }, { timeout: 5000 });
  const pListItems = [...pMount2.querySelectorAll('[data-qu-bind="cms-content-list"] li')].map((li) => li.textContent);
  assert.deepEqual(pListItems, ['/'], 'the PERSONAL editor\'s own "Seiten" list, read from a genuinely FRESH connection, actually shows the page that was just created - not silently empty');
  pRouter2.stop();

  // Independent verification via ContentResolver, bypassing the UI entirely.
  const checker = await connect('checker');
  const personalPage = await new ContentResolver(checker, { appAdminPub: relayAdmin.signingPub, kinds: { pageKind } }).resolvePage('/', { timeout: 2000 });
  const anchor = await globalAppAnchor('cms');
  const globalPage = await new ContentResolver(checker, { appAdminPub: anchor, kinds: { pageKind: adminPageKind } }).resolvePage('/', { timeout: 2000 });
  assert.equal(personalPage?.title, 'PERSONAL PAGE');
  assert.equal(globalPage?.title, 'GLOBAL PAGE');
});
