/**
 * THE THREE INSTALLABLE REFERENCE APPS, END TO END — Guestbook
 * (`guestbook-bundle.js`/`guestbook-actions.js`), Blog
 * (`blog-bundle.js`/`blog-actions.js`), and Forum
 * (`forum-bundle.js`/`forum-actions.js`), each proven the way an actual
 * visitor would use them: install, render, interact through the real DOM
 * (form fill + `submit` dispatch, exactly like `cms-actions.test.js`'s own
 * pattern), and observe the live result - never calling the Dev API a
 * second time to fake the "and it shows up" half.
 *
 * A 4th test proves the admin console's own "Beispiel-App installieren"
 * form (`admin-console-bundle.js`/`admin-actions.js`'s `APP_INSTALLERS`)
 * actually seeds a working app under an admin-chosen prefix - the
 * `docs`-requested `#/admin/...` installer, exercised through its own
 * rendered UI, not by calling `installGuestbook()` directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { createAppResolveKindSchema, installGlobalAppBundle, registerApp } from '@qu/app-core';
import { startApp, startPlatform } from '../src/boot.js';
import { installGuestbook } from '../guestbook-bundle.js';
import { installBlog } from '../blog-bundle.js';
import { installForum } from '../forum-bundle.js';
import { adminConsoleBundle } from '../admin-console-bundle.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function waitUntil(conditionFn, { timeout = 4000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

test('Guestbook: installed via installGuestbook(), a visitor signs it through the rendered form, and the entry appears live in the feed', async () => {
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

  const adminSpace = await connect(admin, 'admin');
  await installGuestbook(adminSpace, { prefix: 'guestbook' });

  const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://app.test/#/' });
  const mountEl = window.document.querySelector('qu-app-shell');
  const visitorSpace = await connect(admin, 'visitor');
  startApp({ space: visitorSpace, appAdminPub: admin.signingPub, mountEl, window, resolveTimeout: 500 });

  await waitUntil(() => mountEl.querySelector('form[data-qu-action="guestbook-form"]'));
  const form = mountEl.querySelector('form[data-qu-action="guestbook-form"]');
  form.querySelector('[name="name"]').value = 'Alice';
  form.querySelector('[name="message"]').value = 'Hallo aus dem Gästebuch!';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  await waitUntil(() => /bestätigt/.test(form.querySelector('[data-qu-status]')?.textContent ?? ''));
  await waitUntil(() => mountEl.querySelector('[data-qu-view="guestbook-feed"]')?.textContent.includes('Hallo aus dem Gästebuch!'));
  assert.ok(mountEl.querySelector('[data-qu-view="guestbook-feed"]').textContent.includes('Alice'), 'the entry is attributed to its author');
});

test('Blog: installed via installBlog(), a post is published through the rendered form, appears in the index, and its own page renders', async () => {
  const admin = await actor();
  const members = [{ pub: admin.signingPub, xPub: admin.xPublicKey }];
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ appAdminPub: admin.signingPub });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });

  async function connect(identity, peerId) {
    const transport = new InProcessTransport(hub, peerId);
    await transport.connect();
    return new Space({ identity, members, transport });
  }

  const adminSpace = await connect(admin, 'admin');
  await installBlog(adminSpace, { prefix: 'blog' });

  const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://app.test/#/' });
  const mountEl = window.document.querySelector('qu-app-shell');
  const visitorSpace = await connect(admin, 'visitor');
  const { router } = startApp({ space: visitorSpace, appAdminPub: admin.signingPub, mountEl, window, resolveTimeout: 500 });

  await waitUntil(() => mountEl.querySelector('form[data-qu-action="blog-post-form"]'));
  const form = mountEl.querySelector('form[data-qu-action="blog-post-form"]');
  form.querySelector('[name="title"]').value = 'Erster Beitrag';
  form.querySelector('[name="slug"]').value = 'erster-beitrag';
  form.querySelector('[name="content"]').value = '<p>Mein erster Blog-Post.</p>';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  await waitUntil(() => /bestätigt/.test(form.querySelector('[data-qu-status]')?.textContent ?? ''));
  await waitUntil(() => mountEl.querySelector('[data-qu-view] a[data-qu-view-link]'));
  const link = mountEl.querySelector('[data-qu-view] a[data-qu-view-link]');
  assert.equal(link.textContent, 'Erster Beitrag');
  assert.equal(link.getAttribute('href'), '#/post/erster-beitrag');

  router.navigate('/post/erster-beitrag');
  await waitUntil(() => mountEl.textContent.includes('Mein erster Blog-Post.'));
});

test('Forum: installed via installForum(), a topic is started and replied to through the rendered forms, both visible live', async () => {
  const admin = await actor();
  const members = [{ pub: admin.signingPub, xPub: admin.xPublicKey }];
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({
    appAdminPub: admin.signingPub,
    sharedListNames: ['forum:topics', 'forum:replies'],
  });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });

  async function connect(identity, peerId) {
    const transport = new InProcessTransport(hub, peerId);
    await transport.connect();
    return new Space({ identity, members, transport });
  }

  const adminSpace = await connect(admin, 'admin');
  await installForum(adminSpace, { prefix: 'forum' });

  const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://app.test/#/' });
  const mountEl = window.document.querySelector('qu-app-shell');
  const visitorSpace = await connect(admin, 'visitor');
  startApp({ space: visitorSpace, appAdminPub: admin.signingPub, mountEl, window, resolveTimeout: 500 });

  await waitUntil(() => mountEl.querySelector('form[data-qu-action="forum-topic-form"]'));
  const topicForm = mountEl.querySelector('form[data-qu-action="forum-topic-form"]');
  topicForm.querySelector('[name="title"]').value = 'Erstes Thema';
  topicForm.querySelector('[name="author"]').value = 'Bob';
  topicForm.querySelector('[name="body"]').value = 'Worum geht es hier?';
  topicForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  // startTopic() navigates the hash straight to the new topic's own route on success.
  await waitUntil(() => mountEl.textContent.includes('Worum geht es hier?'));
  assert.ok(mountEl.textContent.includes('von Bob'), 'the topic body page shows its author');
  assert.ok(mountEl.querySelector('form[data-qu-action="forum-reply-form"]'), 'the topic page carries its own reply form');

  const replyForm = mountEl.querySelector('form[data-qu-action="forum-reply-form"]');
  replyForm.querySelector('[name="author"]').value = 'Carol';
  replyForm.querySelector('[name="message"]').value = 'Gute Frage!';
  replyForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  await waitUntil(() => /bestätigt/.test(replyForm.querySelector('[data-qu-status]')?.textContent ?? ''));
  await waitUntil(() => mountEl.querySelector('[data-qu-view^="topic-"]')?.textContent.includes('Gute Frage!'));
  assert.ok(mountEl.querySelector('[data-qu-view^="topic-"]').textContent.includes('Carol'), 'the reply is attributed to its author');
});

test('Admin console: the "Beispiel-App installieren" form seeds a working Guestbook under an admin-chosen prefix', async () => {
  const relayAdmin = await actor();
  const members = [{ pub: relayAdmin.signingPub, xPub: relayAdmin.xPublicKey }];
  const relayAdmins = [relayAdmin.signingPub];
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ sharedListNames: ['gaestebuch'] });
  createRelayForwarder({ hub, members, relayAdmins, resolveKindSchema, storage: createMemoryStore() });

  async function connect(identity, peerId) {
    const transport = new InProcessTransport(hub, peerId);
    await transport.connect();
    return new Space({ identity, members, relayAdmins, transport });
  }

  const mainSpace = await connect(relayAdmin, 'relay-admin');
  await installGlobalAppBundle(mainSpace, 'admin', adminConsoleBundle);
  await registerApp(mainSpace, { prefix: 'admin', name: 'Relay-Admin', realm: 'global' });

  const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://platform.test/#/admin' });
  const mountEl = window.document.querySelector('qu-app-shell');
  const { router } = startPlatform({ space: mainSpace, mountEl, window, resolveTimeout: 500 });

  await waitUntil(() => mountEl.querySelector('form[data-qu-action="install-app"][data-app-type="guestbook"]'));
  const installForm = mountEl.querySelector('form[data-qu-action="install-app"][data-app-type="guestbook"]');
  installForm.querySelector('input[name="prefix"]').value = 'gaestebuch';
  installForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  await waitUntil(() => /installiert/.test(installForm.querySelector('[data-qu-status]')?.textContent ?? ''));
  await waitUntil(() => [...mountEl.querySelectorAll('[data-qu-bind="platform-apps-list"] li')].some((li) => li.textContent.includes('#/gaestebuch')));

  router.navigate('/gaestebuch/');
  await waitUntil(() => mountEl.querySelector('form[data-qu-action="guestbook-form"]'));
  assert.ok(mountEl.textContent.includes('Gästebuch'), 'the installed app actually renders under its chosen prefix');
});
