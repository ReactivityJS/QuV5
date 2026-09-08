/**
 * CMS DELETE BUTTONS (Phase 4) — proves the rendered "Löschen" button next
 * to a Template/Style/Content row actually removes it: the entry
 * disappears from the (re-rendered) list, and the underlying content no
 * longer resolves for an unrelated visitor. Real relay, real DOM, same
 * rigor `cms-actions.test.js` already applies to create/edit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { createApp, createAppResolveKindSchema, ContentResolver } from '@qu/app-core';
import { startApp } from '../src/boot.js';
import { installCms } from '../cms-bundle.js';

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

test('deleting a Template through its rendered "Löschen" button removes it from the list and it no longer resolves', async () => {
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

  const bootstrapSpace = await connect(admin, 'admin-bootstrap');
  await createApp(bootstrapSpace, { name: 'Demo', rootTemplate: null, defaultRoute: '/' });
  await installCms(bootstrapSpace);

  const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://app.test/#/cms/templates' });
  const mountEl = window.document.querySelector('qu-app-shell');
  const adminSpace = await connect(admin, 'admin-visit');
  startApp({ space: adminSpace, appAdminPub: admin.signingPub, mountEl, window, resolveTimeout: 500 });

  // Create two templates through the rendered form.
  await waitUntil(() => mountEl.querySelector('form[data-qu-action="cms-template-form"]'));
  const form = mountEl.querySelector('form[data-qu-action="cms-template-form"]');
  for (const [name, html] of [['keep-me', '<p>keep</p>'], ['delete-me', '<p>delete</p>']]) {
    form.querySelector('[name="name"]').value = name;
    form.querySelector('[name="html"]').value = html;
    submit(form, window);
    await waitUntil(() => /Gespeichert/.test(form.querySelector('[data-qu-status]')?.textContent ?? ''));
    await waitUntil(() => [...mountEl.querySelectorAll('[data-qu-bind="cms-template-list"] button')].some((b) => b.textContent === name));
    form.querySelector('[data-qu-cms-reset="template"]')?.click();
  }

  const deleteBtn = [...mountEl.querySelectorAll('[data-qu-bind="cms-template-list"] li')]
    .find((li) => li.textContent.includes('delete-me'))
    .querySelector('button[data-qu-cms-delete="template"]');
  assert.ok(deleteBtn, 'a Löschen button should be rendered next to the template row');

  deleteBtn.click();
  await waitUntil(() => ![...mountEl.querySelectorAll('[data-qu-bind="cms-template-list"] button')].some((b) => b.textContent === 'delete-me'));
  assert.ok([...mountEl.querySelectorAll('[data-qu-bind="cms-template-list"] button')].some((b) => b.textContent === 'keep-me'), 'the OTHER template must survive untouched');

  const visitorSpace = await connect(visitor, 'visitor-check');
  const resolver = new ContentResolver(visitorSpace, { appAdminPub: admin.signingPub });
  assert.equal(await resolver.resolveTemplate('delete-me', { timeout: 1500 }), null);
  assert.equal(await resolver.resolveTemplate('keep-me', { timeout: 1500 }), '<p>keep</p>');
});

test('deleting a Content page through its rendered "Löschen" button removes it from the list and it no longer resolves', async () => {
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

  const bootstrapSpace = await connect(admin, 'admin-bootstrap-2');
  await createApp(bootstrapSpace, { name: 'Demo', rootTemplate: null, defaultRoute: '/' });
  await installCms(bootstrapSpace);

  const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://app.test/#/cms/content' });
  const mountEl = window.document.querySelector('qu-app-shell');
  const adminSpace = await connect(admin, 'admin-visit-2');
  startApp({ space: adminSpace, appAdminPub: admin.signingPub, mountEl, window, resolveTimeout: 500 });

  await waitUntil(() => mountEl.querySelector('form[data-qu-action="cms-content-form"]'));
  const form = mountEl.querySelector('form[data-qu-action="cms-content-form"]');
  form.querySelector('[name="sourceType"]').value = 'html';
  form.querySelector('[name="route"]').value = '/gone';
  form.querySelector('[name="title"]').value = 'Gone Soon';
  form.querySelector('[name="content"]').value = '<p>temporary</p>';
  submit(form, window);
  await waitUntil(() => /Gespeichert/.test(form.querySelector('[data-qu-status]')?.textContent ?? ''));
  await waitUntil(() => [...mountEl.querySelectorAll('[data-qu-bind="cms-content-list"] button')].some((b) => b.textContent === '/gone'));

  const deleteBtn = [...mountEl.querySelectorAll('[data-qu-bind="cms-content-list"] li')]
    .find((li) => li.textContent.includes('/gone'))
    .querySelector('button[data-qu-cms-delete="content"]');
  assert.ok(deleteBtn, 'a Löschen button should be rendered next to the content row');

  deleteBtn.click();
  await waitUntil(() => ![...mountEl.querySelectorAll('[data-qu-bind="cms-content-list"] button')].some((b) => b.textContent === '/gone'));

  const visitorSpace = await connect(visitor, 'visitor-check-2');
  const resolver = new ContentResolver(visitorSpace, { appAdminPub: admin.signingPub });
  assert.equal(await resolver.resolvePage('/gone', { timeout: 1500 }), null);
});
