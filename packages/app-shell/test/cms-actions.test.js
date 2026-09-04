/**
 * THE CMS EDITOR — `cms-bundle.js`'s `installCms()` + `cms-actions.js`'s
 * `wireCms()` (wired into `boot.js`'s `startApp()`), proven end to end
 * through a REAL (in-process) relay and REAL DOM form submissions (jsdom),
 * the same rigor `boot.test.js`/`platform-boot.test.js` already apply to
 * `startApp()`/`startPlatform()` themselves: an app-admin visits their own
 * `/cms` route, creates a template/style/page through the rendered forms
 * (never by calling `@qu/app-core`'s Dev API directly), then edits one of
 * them back through the SAME forms - a separate, unrelated visitor Space
 * confirms every change actually landed in the Space, not just in the DOM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { createApp, createAppResolveKindSchema, ContentResolver, grantContentWriter, pageKind, createPage, publishRoute } from '@qu/app-core';
import { startApp } from '../src/boot.js';
import { installCms } from '../cms-bundle.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function waitUntil(conditionFn, { timeout = 3000, interval = 10 } = {}) {
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

test('the CMS editor is genuine installed content - an app-admin creates AND edits templates/styles/pages through the rendered forms, visible to an unrelated visitor', async () => {
  const admin = await actor();
  const visitor = await actor();
  const members = [
    { pub: admin.signingPub, xPub: admin.xPublicKey },
    { pub: visitor.signingPub, xPub: visitor.xPublicKey },
  ];
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPub: admin.signingPub });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });

  async function connect(identity, peerId) {
    const transport = new InProcessTransport(hub, peerId);
    await transport.connect();
    return new Space({ identity, members, transport });
  }

  const adminBootstrapSpace = await connect(admin, 'admin-bootstrap');
  await createApp(adminBootstrapSpace, { name: 'Demo', rootTemplate: null, defaultRoute: '/' });
  await installCms(adminBootstrapSpace);

  // Starts directly on `#/cms` (rather than navigating there after boot) - same reason
  // `platform-boot.test.js` constructs its admin-console JSDOM with `url: '.../#/admin'`
  // instead of calling `router.navigate('/admin')`: `startApp()`'s `router.start()` already
  // fires ONE `onChange('/')` immediately, and nothing is published at `/` in this test, so
  // that resolution would sit unresolved for its full `resolveTimeout` before a LATER
  // `navigate('/cms')` call's own render even lands - two independent, unserialized async
  // `onChange` calls racing to be the last one to touch `mountEl.innerHTML` (an existing
  // `HashRouter`/`boot.js` property, not something this test or `wireCms()` needs to solve).
  const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://app.test/#/cms' });
  const mountEl = window.document.querySelector('qu-app-shell');
  const adminSpace = await connect(admin, 'admin-visit');
  const { router } = startApp({ space: adminSpace, appAdminPub: admin.signingPub, mountEl, window, resolveTimeout: 500 });

  await waitUntil(() => mountEl.querySelector('form[data-qu-action="cms-template-form"]'), { timeout: 4000 });
  assert.ok(mountEl.querySelector('form[data-qu-action="cms-style-form"]'), 'the CMS is rendered from installed content, not hardcoded DOM-building');
  assert.ok(mountEl.querySelector('form[data-qu-action="cms-page-form"]'));

  // --- CREATE a template through the rendered form. ---
  const templateForm = mountEl.querySelector('form[data-qu-action="cms-template-form"]');
  templateForm.querySelector('[name="name"]').value = 'layout/main';
  templateForm.querySelector('[name="html"]').value = '<header>Demo</header><qu-slot name="content"></qu-slot>';
  submit(templateForm, window);
  await waitUntil(() => /Gespeichert/.test(templateForm.querySelector('[data-qu-status]')?.textContent ?? ''));
  await waitUntil(() => [...mountEl.querySelectorAll('[data-qu-bind="cms-template-list"] button')].some((b) => b.textContent === 'layout/main'));

  // --- CREATE a style through the rendered form. ---
  const styleForm = mountEl.querySelector('form[data-qu-action="cms-style-form"]');
  styleForm.querySelector('[name="name"]').value = 'global';
  styleForm.querySelector('[name="css"]').value = 'body { color: navy; }';
  submit(styleForm, window);
  await waitUntil(() => /Gespeichert/.test(styleForm.querySelector('[data-qu-status]')?.textContent ?? ''));
  await waitUntil(() => [...mountEl.querySelectorAll('[data-qu-bind="cms-style-list"] button')].some((b) => b.textContent === 'global'));

  // --- CREATE a page through the rendered form (also registers the route). ---
  const pageForm = mountEl.querySelector('form[data-qu-action="cms-page-form"]');
  const templateSelect = pageForm.querySelector('[name="template"]');
  // The template just created above must actually be PICKABLE here without a reload - the page
  // form's own <select> is populated once at initial wiring (before "layout/main" existed) and
  // only refreshed as a side effect of a successful template save (cms-actions.js's own
  // refreshTemplateSelect()) - assert the option genuinely exists, not just that assigning `.value`
  // didn't throw (a nonexistent <option> silently no-ops the assignment instead of erroring).
  assert.ok([...templateSelect.options].some((o) => o.value === 'layout/main'), 'the newly created template is selectable without a page reload');
  pageForm.querySelector('[name="route"]').value = '/';
  pageForm.querySelector('[name="title"]').value = 'Start v1';
  templateSelect.value = 'layout/main';
  pageForm.querySelector('[name="content"]').value = '<p>v1 content</p>';
  pageForm.querySelector('[name="data"]').value = '{"author": "Alice"}';
  submit(pageForm, window);
  await waitUntil(() => /Gespeichert/.test(pageForm.querySelector('[data-qu-status]')?.textContent ?? ''));
  await waitUntil(() => [...mountEl.querySelectorAll('[data-qu-bind="cms-page-list"] button')].some((b) => b.textContent === '/'));

  // A separate visitor confirms the created content actually landed in the Space.
  {
    const visitorSpace = await connect(visitor, 'visitor-check-1');
    const resolver = new ContentResolver(visitorSpace, { appAdminPub: admin.signingPub });
    assert.equal(await resolver.resolveTemplate('layout/main', { timeout: 2000 }), '<header>Demo</header><qu-slot name="content"></qu-slot>');
    assert.equal(await resolver.resolveStyle('global', { timeout: 2000 }), 'body { color: navy; }');
    const page = await resolver.resolvePage('/', { timeout: 2000 });
    assert.equal(page.title, 'Start v1');
    assert.equal(page.content, '<p>v1 content</p>');
    assert.equal(page.template, 'layout/main');
    assert.deepEqual(page.data, { author: 'Alice' });
  }

  // --- EDIT the existing page by clicking it in the list, changing the content, and saving again. ---
  const pageListButton = [...mountEl.querySelectorAll('[data-qu-bind="cms-page-list"] button')].find((b) => b.textContent === '/');
  pageListButton.click();
  // The click handler itself resolves the page asynchronously before calling enterEditMode() -
  // waiting on "mode" (not "title", which already reads 'Start v1' from the earlier CREATE step
  // and would make this waitUntil resolve too early, before enterEditMode() actually ran).
  await waitUntil(() => pageForm.querySelector('input[name="mode"]').value === 'edit');
  assert.equal(pageForm.querySelector('[name="title"]').value, 'Start v1');
  assert.ok(pageForm.querySelector('[name="route"]').readOnly, 'the key field is locked while editing - saving must target the SAME Node');
  assert.equal(JSON.parse(pageForm.querySelector('[name="data"]').value).author, 'Alice', 'the existing structured data is loaded back into the form as JSON');

  pageForm.querySelector('[name="title"]').value = 'Start v2';
  pageForm.querySelector('[name="content"]').value = '<p>v2 content</p>';
  // "data" left untouched - editing other fields must not silently clear it.
  submit(pageForm, window);
  await waitUntil(() => /Gespeichert/.test(pageForm.querySelector('[data-qu-status]')?.textContent ?? ''));

  {
    const visitorSpace = await connect(visitor, 'visitor-check-2');
    const resolver = new ContentResolver(visitorSpace, { appAdminPub: admin.signingPub });
    const page = await resolver.resolvePage('/', { timeout: 2000 });
    assert.equal(page.title, 'Start v2');
    assert.equal(page.content, '<p>v2 content</p>');
    assert.deepEqual(page.data, { author: 'Alice' });
  }

  // --- "Neue Seite" resets the form back to create mode. ---
  mountEl.querySelector('[data-qu-cms-reset="page"]').click();
  assert.equal(pageForm.querySelector('input[name="mode"]').value, 'create');
  assert.equal(pageForm.querySelector('[name="route"]').readOnly, false);
  assert.equal(pageForm.querySelector('[name="title"]').value, '');

  router.stop();
});

test('a GRANTED CO-EDITOR - a different identity than the app-admin - can edit an existing page through the CMS forms, not just the app-admin themselves', async () => {
  // Real, deployment-observed regression this guards against: wireTemplates()/wireStyles()/
  // wirePages() used to omit `ownerPub` entirely on every holdEdit()/holdRegistry()/edit*() call,
  // silently defaulting to `space.identity.signingPub` (dev.js's own default) - the VISITING
  // identity, not the app's actual owner. Listing/reading (via ContentResolver, always correctly
  // configured with the real appAdminPub) was unaffected, so the list/form correctly SHOWED the
  // app-admin's existing page - but SAVING computed an entirely different, nonexistent Node id from
  // the co-editor's own pubkey, throwing "editPage: page ... does not exist" for a page that
  // plainly does. The previous test in this file never caught this because it always used the SAME
  // identity for both `space.identity` and `appAdminPub` - this test deliberately does not.
  const admin = await actor();
  const coEditor = await actor(); // a DIFFERENT identity - never the app-admin.
  const visitor = await actor();
  const members = [
    { pub: admin.signingPub, xPub: admin.xPublicKey },
    { pub: coEditor.signingPub, xPub: coEditor.xPublicKey },
    { pub: visitor.signingPub, xPub: visitor.xPublicKey },
  ];
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPub: admin.signingPub });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });

  async function connect(identity, peerId) {
    const transport = new InProcessTransport(hub, peerId);
    await transport.connect();
    return new Space({ identity, members, transport });
  }

  const adminBootstrapSpace = await connect(admin, 'admin-bootstrap');
  await createApp(adminBootstrapSpace, { name: 'Demo', rootTemplate: null, defaultRoute: '/' });
  await installCms(adminBootstrapSpace);
  await createPage(adminBootstrapSpace, { route: '/', title: 'Start v1', content: '<p>v1 content</p>' });
  await publishRoute(adminBootstrapSpace, { route: '/', title: 'Start' });
  // The actual mechanism this test proves works end to end - see grantContentWriter()'s own doc
  // comment ("let user X edit exactly this page").
  await grantContentWriter(adminBootstrapSpace, { kind: pageKind, path: '/', granteePub: coEditor.signingPub });
  await new Promise((resolve) => setTimeout(resolve, 100)); // let the grant actually reach the relay/other peers before the co-editor's own write follows.

  const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://app.test/#/cms' });
  const mountEl = window.document.querySelector('qu-app-shell');
  const coEditorSpace = await connect(coEditor, 'co-editor-visit');
  // The critical bit: `space` is the CO-EDITOR's own Space, `appAdminPub` is still the real owner -
  // exactly the "may or may not be appAdminPub itself or a granted co-editor" case wireCms()'s own
  // doc comment already described as intended, just never actually wired through until now.
  const { router } = startApp({ space: coEditorSpace, appAdminPub: admin.signingPub, mountEl, window, resolveTimeout: 500 });

  await waitUntil(() => mountEl.querySelector('form[data-qu-action="cms-page-form"]'), { timeout: 4000 });
  await waitUntil(() => [...mountEl.querySelectorAll('[data-qu-bind="cms-page-list"] button')].some((b) => b.textContent === '/'), { timeout: 4000 });

  const pageForm = mountEl.querySelector('form[data-qu-action="cms-page-form"]');
  const pageListButton = [...mountEl.querySelectorAll('[data-qu-bind="cms-page-list"] button')].find((b) => b.textContent === '/');
  pageListButton.click();
  await waitUntil(() => pageForm.querySelector('input[name="mode"]').value === 'edit');
  assert.equal(pageForm.querySelector('[name="title"]').value, 'Start v1', "the co-editor's own click-to-load correctly finds the app-admin's EXISTING page");

  pageForm.querySelector('[name="title"]').value = 'Start v2 (von Co-Editor)';
  pageForm.querySelector('[name="content"]').value = '<p>v2 content</p>';
  submit(pageForm, window);
  await waitUntil(() => (pageForm.querySelector('[data-qu-status]')?.textContent ?? '').length > 0, { timeout: 4000 });
  assert.match(pageForm.querySelector('[data-qu-status]').textContent, /Gespeichert/, `the co-editor's save must succeed, not throw "does not exist" - got: ${pageForm.querySelector('[data-qu-status]').textContent}`);

  const visitorSpace = await connect(visitor, 'visitor-check');
  const resolver = new ContentResolver(visitorSpace, { appAdminPub: admin.signingPub });
  const page = await resolver.resolvePage('/', { timeout: 2000 });
  assert.equal(page.title, 'Start v2 (von Co-Editor)', "the co-editor's edit actually landed on the app-admin's OWN page Node, not a new one owned by the co-editor");
  assert.equal(page.content, '<p>v2 content</p>');

  router.stop();
});
