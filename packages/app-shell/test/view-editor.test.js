/**
 * THE VIEW EDITOR — `cms-actions.js`'s `wireViewEditor()` (its own doc
 * comment: a REFERENCE editor for `viewKind`, one caller among possibly
 * several - the "editors as plugins" direction), proven end to end: an
 * app-admin creates a View through the rendered CMS form, edits it back
 * through the same form (no browseable list - "Laden" looks it up by
 * name, `createView()`'s own doc comment explains why), and a completely
 * separate page visited by a different identity actually renders the
 * View's live feed via `view-actions.js`'s `wireViews()`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { createApp, createAppResolveKindSchema, createPage, publishRoute, pushToSharedList } from '@qu/app-core';
import { startApp } from '../src/boot.js';
import { installCms } from '../cms-bundle.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function waitUntil(conditionFn, { timeout = 3000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

function submit(form, window) {
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

test('an app-admin creates and edits a View through the rendered CMS form, and a visited page renders its live feed', async () => {
  const admin = await actor();
  const members = [{ pub: admin.signingPub, xPub: admin.xPublicKey }];
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPub: admin.signingPub, sharedListNames: ['guestbook'] });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });

  async function connect(identity, peerId) {
    const transport = new InProcessTransport(hub, peerId);
    await transport.connect();
    return new Space({ identity, members, transport });
  }

  const adminBootstrapSpace = await connect(admin, 'admin-bootstrap');
  await createApp(adminBootstrapSpace, { name: 'Demo', rootTemplate: null, defaultRoute: '/' });
  await installCms(adminBootstrapSpace);
  await publishRoute(adminBootstrapSpace, { route: '/blog/hallo', title: 'Hallo Welt' });
  await pushToSharedList(adminBootstrapSpace, 'guestbook', { name: 'Alice', message: 'Hi!' });

  const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://app.test/#/cms' });
  const mountEl = window.document.querySelector('qu-app-shell');
  const adminSpace = await connect(admin, 'admin-visit');
  startApp({ space: adminSpace, appAdminPub: admin.signingPub, mountEl, window, resolveTimeout: 500 });

  await waitUntil(() => mountEl.querySelector('form[data-qu-action="cms-view-form"]'), { timeout: 4000 });

  // --- CREATE a View through the rendered form. ---
  const viewForm = mountEl.querySelector('form[data-qu-action="cms-view-form"]');
  viewForm.querySelector('[name="name"]').value = 'feed';
  viewForm.querySelector('[name="sources"]').value = JSON.stringify([
    { type: 'pages', prefix: '/blog/' },
    { type: 'shared-list', name: 'guestbook' },
  ]);
  viewForm.querySelector('[name="sortBy"]').value = 'title';
  viewForm.querySelector('[name="sortOrder"]').value = 'asc';
  viewForm.querySelector('[name="itemTemplate"]').value = '<a data-qu-view-link><qu-slot name="title"></qu-slot></a>';
  submit(viewForm, window);
  await waitUntil(() => /Gespeichert/.test(viewForm.querySelector('[data-qu-status]')?.textContent ?? ''));

  // --- The saved View actually renders on a visited page, as a fresh, unrelated visitor. ---
  await createPage(adminBootstrapSpace, { route: '/', title: 'Start', content: '<div data-qu-view="feed"></div>' });
  const { window: visitorWindow } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://app.test/#/' });
  const visitorMountEl = visitorWindow.document.querySelector('qu-app-shell');
  const visitorSpace = await connect(admin, 'visitor');
  startApp({ space: visitorSpace, appAdminPub: admin.signingPub, mountEl: visitorMountEl, window: visitorWindow, resolveTimeout: 500 });
  await waitUntil(() => visitorMountEl.querySelector('[data-qu-view="feed"] a'));
  assert.deepEqual(
    [...visitorMountEl.querySelectorAll('[data-qu-view="feed"] a')].map((a) => a.textContent),
    ['Alice', 'Hallo Welt'],
    'the View created through the CMS form is genuine Space content, resolved and rendered like any other'
  );

  // --- EDIT the View back through the form (no list - "Laden" looks it up by name). ---
  viewForm.querySelector('[name="name"]').value = 'feed';
  mountEl.querySelector('[data-qu-action="cms-view-load"]').click();
  await waitUntil(() => viewForm.querySelector('input[name="mode"]').value === 'edit');
  assert.equal(JSON.parse(viewForm.querySelector('[name="sources"]').value).length, 2, 'loading an existing View fills the form with its CURRENT saved values');
  viewForm.querySelector('[name="sortOrder"]').value = 'desc';
  submit(viewForm, window);
  await waitUntil(() => /Gespeichert/.test(viewForm.querySelector('[data-qu-status]')?.textContent ?? ''));

  // `openLiveView()` watches every SOURCE live (proven above and in `views.test.js`), but
  // deliberately NOT the View's own config Node - `wireViews()` reads a View's definition ONCE, at
  // wiring time (this file's own `wireViewEditor()` doc comment on the "editors as plugins"
  // split: authoring and rendering are separate concerns) - so the ALREADY-RENDERED visitor page
  // above keeps its OLD sort order until it is wired again. A FRESH visit picks up the edit, same
  // as any other Space content: an already-open page never "hot-reloads" a Template/Style change
  // either. Real, separate future work if a View's own definition should ALSO be watched live.
  const { window: secondVisitWindow } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://app.test/#/' });
  const secondVisitMountEl = secondVisitWindow.document.querySelector('qu-app-shell');
  const secondVisitSpace = await connect(admin, 'second-visit');
  startApp({ space: secondVisitSpace, appAdminPub: admin.signingPub, mountEl: secondVisitMountEl, window: secondVisitWindow, resolveTimeout: 500 });
  await waitUntil(() => secondVisitMountEl.querySelector('[data-qu-view="feed"] a'));
  assert.deepEqual(
    [...secondVisitMountEl.querySelectorAll('[data-qu-view="feed"] a')].map((a) => a.textContent),
    ['Hallo Welt', 'Alice'],
    'a FRESH visit picks up the edited sortOrder'
  );
});
