/**
 * BLOG: KLARE PFADE — `blog-bundle.js`/`blog-actions.js`'s own "Global
 * Feed"/"User Feed"/"Post anlegen"/"Post editieren" UPDATE (see both files'
 * own top doc comments), plus `admin-actions.js`'s mode-button gating that
 * prevents switching a `personalBundle`-having app (or one whose installer
 * builds no aggregate feed) into a mode that would silently break it - the
 * real, reported bug this whole change addresses ("Beim Umschalten des Blog
 * auf multiuser kommt der globale Blog auf 404").
 *
 * Same fixture shape as `installed-apps.test.js` (real WS relay, the live
 * app resolver actually running, the admin console's own rendered install
 * form) - reused here rather than duplicated, see that file's own doc
 * comment on why a real socket is needed at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { JSDOM } from 'jsdom';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { createWsServerHub, WsClientTransport, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { installGlobalAppBundle, registerApp, publishGlobalRoute } from '@qu/app-core';
import { createLiveAppResolveKindSchema } from '../src/live-app-resolver.js';
import { startPlatform } from '../src/boot.js';
import { adminConsoleBundle } from '../admin-console-bundle.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function waitUntil(conditionFn, { timeout = 5000, interval = 20 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

/** See `installed-apps.test.js`'s own identically-named helper - same fixture, not duplicated logic, just a separate copy (this file's own package-relative imports differ enough that sharing a literal module felt like more machinery than the ~40 lines it saves). */
async function bootRelay({ extraActors = [] } = {}) {
  const relayAdmin = await actor();
  const relayAdmins = [relayAdmin.signingPub];
  const members = [relayAdmin, ...extraActors].map((a) => ({ pub: a.signingPub, xPub: a.xPublicKey }));

  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: true });
  const hub = createWsServerHub(wss);
  const { resolveKindSchema, start } = createLiveAppResolveKindSchema();
  createRelayForwarder({ hub, members, relayAdmins, resolveKindSchema, storage: createMemoryStore() });

  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;
  const url = `ws://127.0.0.1:${port}`;
  await start({ url, relayAdmins });

  async function connect(identity) {
    const transport = new WsClientTransport(url, { WebSocketImpl: WebSocket });
    await transport.connect();
    return new Space({ identity, members, relayAdmins, transport });
  }

  const adminSpace = await connect(relayAdmin);
  await registerApp(adminSpace, { prefix: 'admin', name: 'Relay-Admin', realm: 'global' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await publishGlobalRoute(adminSpace, 'admin', { route: '/', title: 'Relay-Admin' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await installGlobalAppBundle(adminSpace, 'admin', adminConsoleBundle);
  await new Promise((resolve) => setTimeout(resolve, 300));

  async function close() {
    wss.clients.forEach((ws) => ws.terminate());
    await new Promise((resolve) => httpServer.close(resolve));
  }

  return { relayAdmin, members, url, connect, close };
}

function mountAdmin(space) {
  const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://platform.test/#/admin' });
  const mountEl = window.document.querySelector('qu-app-shell');
  const { router, platform } = startPlatform({ space, mountEl, window, resolveTimeout: 1500 });
  return { window, mountEl, router, platform };
}

/** Mounts `#/<hash>` for `space`, without going through the admin console at all - an ordinary visitor's own entry point. */
function mountAt(space, hash) {
  const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: `https://platform.test/#${hash}` });
  const mountEl = window.document.querySelector('qu-app-shell');
  const { router } = startPlatform({ space, mountEl, window, resolveTimeout: 1500 });
  return { window, mountEl, router };
}

async function installViaForm(mountEl, appType, prefix, fields = {}) {
  await waitUntil(() => mountEl.querySelector(`form[data-qu-action="install-app"][data-app-type="${appType}"]`));
  const form = mountEl.querySelector(`form[data-qu-action="install-app"][data-app-type="${appType}"]`);
  form.querySelector('input[name="prefix"]').value = prefix;
  for (const [name, value] of Object.entries(fields)) form.querySelector(`[name="${name}"]`).value = value;
  form.dispatchEvent(new mountEl.ownerDocument.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitUntil(() => /installiert/.test(form.querySelector('[data-qu-status]')?.textContent ?? ''), { timeout: 6000 });
}

test('Blog: Global Feed and User Feed cross-link each other, and the global post form/Views-link are relay-admin-only', async () => {
  const visitor = await actor();
  const relay = await bootRelay({ extraActors: [visitor] });
  try {
    const adminSpace = await relay.connect(relay.relayAdmin);
    const { mountEl: adminMountEl, router: adminRouter } = mountAdmin(adminSpace);
    await installViaForm(adminMountEl, 'blog', 'blog');
    adminRouter.stop();

    // The relay-admin, freshly browsing (not the install session's own Space - see
    // `installed-apps.test.js`'s own "A FRESH connection" doc comment for why).
    const adminVisit = await relay.connect(relay.relayAdmin);
    const { mountEl: adminBlogEl, router: adminBlogRouter } = mountAt(adminVisit, '/blog/');
    await waitUntil(() => adminBlogEl.querySelector('form[data-qu-action="blog-post-form"]'));
    assert.ok(adminBlogEl.querySelector('a[href="#/blog/u/me/"]'), 'Global Feed links to the User Feed');
    assert.equal(adminBlogEl.querySelector('form[data-qu-action="blog-post-form"]').closest('[data-qu-admin-only]').hidden, false, 'relay-admin sees the post form');
    assert.equal(adminBlogEl.querySelector('a[href="#/admin/blog/cms"]').hidden, false, 'relay-admin sees the Views-editor link');
    adminBlogRouter.stop();

    const visitorSpace = await relay.connect(visitor);
    const { mountEl: visitorBlogEl, router: visitorBlogRouter } = mountAt(visitorSpace, '/blog/');
    await waitUntil(() => visitorBlogEl.querySelector('a[href="#/blog/u/me/"]'));
    assert.equal(visitorBlogEl.querySelector('form[data-qu-action="blog-post-form"]').closest('[data-qu-admin-only]').hidden, true, 'non-admin does NOT see the post form (it would be rejected anyway)');
    assert.equal(visitorBlogEl.querySelector('a[href="#/admin/blog/cms"]').hidden, true, 'non-admin does NOT see the Views-editor link');

    visitorBlogRouter.stop();

    const visitorPersonal = await relay.connect(visitor);
    const { mountEl: personalEl, router: personalRouter } = mountAt(visitorPersonal, '/blog/u/me/');
    await waitUntil(() => personalEl.querySelector('form[data-qu-action="blog-post-form"]'));
    assert.ok(personalEl.querySelector('a[href="#/blog/"]'), 'User Feed links back to the Global Feed');
    personalRouter.stop();
  } finally {
    await relay.close();
  }
});

test('Blog: a relay-admin\'s own post can optionally publish to BOTH feeds at once via the User Feed form\'s admin-only checkbox', async () => {
  const relay = await bootRelay();
  try {
    const adminSpace = await relay.connect(relay.relayAdmin);
    const { mountEl: adminMountEl, router: adminRouter } = mountAdmin(adminSpace);
    await installViaForm(adminMountEl, 'blog', 'blog');
    adminRouter.stop();

    const authorSpace = await relay.connect(relay.relayAdmin);
    const { window, mountEl, router } = mountAt(authorSpace, '/blog/u/me/');
    await waitUntil(() => mountEl.querySelector('form[data-qu-action="blog-post-form"]'));
    const checkbox = mountEl.querySelector('[name="alsoGlobal"]');
    await waitUntil(() => checkbox.hidden === false);

    const form = mountEl.querySelector('form[data-qu-action="blog-post-form"]');
    form.querySelector('[name="title"]').value = 'Doppelt veröffentlicht';
    form.querySelector('[name="slug"]').value = 'doppelt';
    form.querySelector('[name="content"]').value = '<p>Steht in beiden Feeds.</p>';
    checkbox.checked = true;
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await waitUntil(() => /bestätigt/.test(form.querySelector('[data-qu-status]')?.textContent ?? ''), { timeout: 6000 });

    await waitUntil(() => mountEl.querySelector('[data-qu-view="blog-personal-index"]')?.textContent.includes('Doppelt veröffentlicht'));

    router.navigate('/blog/');
    await waitUntil(() => mountEl.querySelector('[data-qu-view="blog-index"]')?.textContent.includes('Doppelt veröffentlicht'), { timeout: 6000 });

    router.stop();
  } finally {
    await relay.close();
  }
});

test('Blog: a relay-admin edits an already-published GLOBAL post inline via the "Bearbeiten" link', async () => {
  const relay = await bootRelay();
  try {
    const adminSpace = await relay.connect(relay.relayAdmin);
    const { mountEl: adminMountEl, router: adminRouter } = mountAdmin(adminSpace);
    await installViaForm(adminMountEl, 'blog', 'blog');
    adminRouter.stop();

    const authorSpace = await relay.connect(relay.relayAdmin);
    const { window, mountEl, router } = mountAt(authorSpace, '/blog/');
    await waitUntil(() => mountEl.querySelector('form[data-qu-action="blog-post-form"]'));
    const form = mountEl.querySelector('form[data-qu-action="blog-post-form"]');
    form.querySelector('[name="title"]').value = 'Alter Titel';
    form.querySelector('[name="slug"]').value = 'mein-post';
    form.querySelector('[name="content"]').value = '<p>Alter Inhalt.</p>';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await waitUntil(() => /bestätigt/.test(form.querySelector('[data-qu-status]')?.textContent ?? ''), { timeout: 6000 });

    const editLink = await (async () => {
      await waitUntil(() => mountEl.querySelector('[data-qu-blog-edit-link]'), { timeout: 6000 });
      const link = mountEl.querySelector('[data-qu-blog-edit-link]');
      await waitUntil(() => link.hidden === false, { timeout: 2000 });
      return link;
    })();
    editLink.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));

    await waitUntil(() => form.querySelector('[name="title"]').value === 'Alter Titel');
    assert.equal(form.querySelector('button[type="submit"]').textContent, 'Aktualisieren');
    assert.equal(form.querySelector('[name="slug"]').readOnly, true);

    form.querySelector('[name="title"]').value = 'Neuer Titel';
    form.querySelector('[name="content"]').value = '<p>Neuer Inhalt.</p>';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await waitUntil(() => /bestätigt/.test(form.querySelector('[data-qu-status]')?.textContent ?? ''), { timeout: 6000 });
    assert.equal(form.querySelector('button[type="submit"]').textContent, 'Veröffentlichen', 'back to create mode after a successful update');

    router.navigate('/blog/post/mein-post');
    await waitUntil(() => mountEl.textContent.includes('Neuer Inhalt.'), { timeout: 8000 });
    assert.ok(!mountEl.textContent.includes('Alter Inhalt.'));

    router.navigate('/blog/');
    await waitUntil(() => mountEl.querySelectorAll('[data-qu-view-link]').length > 0, { timeout: 6000 });
    assert.equal(mountEl.querySelectorAll('[data-qu-view-link]').length, 1, 'editing never creates a second entry');

    router.stop();
  } finally {
    await relay.close();
  }
});

test('Blog: an ordinary visitor edits their OWN personal post inline via the "Bearbeiten" link', async () => {
  const visitor = await actor();
  const relay = await bootRelay({ extraActors: [visitor] });
  try {
    const adminSpace = await relay.connect(relay.relayAdmin);
    const { mountEl: adminMountEl, router: adminRouter } = mountAdmin(adminSpace);
    await installViaForm(adminMountEl, 'blog', 'blog');
    adminRouter.stop();

    const visitorSpace = await relay.connect(visitor);
    const { window, mountEl, router } = mountAt(visitorSpace, '/blog/u/me/');
    await waitUntil(() => mountEl.querySelector('form[data-qu-action="blog-post-form"]'));
    const form = mountEl.querySelector('form[data-qu-action="blog-post-form"]');
    form.querySelector('[name="title"]').value = 'Mein Post';
    form.querySelector('[name="slug"]').value = 'mein-post';
    form.querySelector('[name="content"]').value = '<p>Erste Fassung.</p>';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await waitUntil(() => /bestätigt/.test(form.querySelector('[data-qu-status]')?.textContent ?? ''), { timeout: 6000 });

    await waitUntil(() => mountEl.querySelector('[data-qu-blog-edit-link]'), { timeout: 6000 });
    const editLink = mountEl.querySelector('[data-qu-blog-edit-link]');
    assert.equal(editLink.hidden, false, 'a personal post\'s own edit link is never admin-gated');
    editLink.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));

    await waitUntil(() => form.querySelector('[name="content"]').value === '<p>Erste Fassung.</p>');
    form.querySelector('[name="content"]').value = '<p>Überarbeitete Fassung.</p>';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await waitUntil(() => /bestätigt/.test(form.querySelector('[data-qu-status]')?.textContent ?? ''), { timeout: 6000 });

    // The PERSONAL post's own reachable route is prefixed with `/u/me/` (`boot.js`'s additive
    // route, `renderMultiUserRoute()`) - unlike test 3's GLOBAL post, the bare `/blog/post/...`
    // would resolve against the GLOBAL blog's own page registry instead (no such page there).
    router.navigate('/blog/u/me/post/mein-post');
    await waitUntil(() => mountEl.textContent.includes('Überarbeitete Fassung.'), { timeout: 8000 });

    router.stop();
  } finally {
    await relay.close();
  }
});

test('Admin console: mode buttons are disabled for a mode that would silently break the app - "Multi-User" for Blog/Guestbook, "Personal" only for Blog', async () => {
  const relay = await bootRelay();
  try {
    const adminSpace = await relay.connect(relay.relayAdmin);
    const { mountEl, router } = mountAdmin(adminSpace);
    await installViaForm(mountEl, 'guestbook', 'book');
    await installViaForm(mountEl, 'blog', 'blog');
    await installViaForm(mountEl, 'forum', 'forum');

    function rowFor(prefix) {
      return [...mountEl.querySelectorAll('[data-qu-bind="platform-apps-list"] li')].find((li) => li.textContent.includes(`#/${prefix}`));
    }
    function modeBtn(prefix, label) {
      return [...rowFor(prefix).querySelectorAll('button')].find((b) => b.textContent === label);
    }

    await waitUntil(() => rowFor('book') && rowFor('blog') && rowFor('forum'));

    assert.equal(modeBtn('book', 'Multi-User').disabled, true, 'Guestbook has its own personalBundle - Multi-User would ignore it');
    assert.equal(modeBtn('book', 'Nur Persönlich').disabled, false, 'Guestbook already builds an aggregate feed - Personal works');

    assert.equal(modeBtn('blog', 'Multi-User').disabled, true, 'Blog has its own personalBundle - Multi-User would ignore it');
    assert.equal(modeBtn('blog', 'Nur Persönlich').disabled, true, 'Blog builds no aggregate feed yet - Personal would render permanently empty');

    assert.equal(modeBtn('forum', 'Multi-User').disabled, false, 'Forum has no personalBundle at all - Multi-User behaves exactly as documented');

    router.stop();
  } finally {
    await relay.close();
  }
});
