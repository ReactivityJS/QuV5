/**
 * THE THREE INSTALLABLE REFERENCE APPS, END TO END, THROUGH THE REAL
 * ADMIN-CONSOLE INSTALLER — Guestbook/Blog/Forum are `realm: 'global'`
 * apps now (`guestbook-bundle.js`'s own top doc comment on why: a `realm:
 * 'main'` app is owned by one identity, and installing several of these
 * reference apps from the SAME relay-admin session used to collide at the
 * exact same content-addressed id for every one of their own index pages -
 * a real, observed bug). This file goes through a REAL WebSocket relay
 * with `live-app-resolver.js` actually running (`live-app-resolver.test.js`'s
 * own "WHY A REAL SOCKET" doc comment - an in-process hub cannot serve it),
 * clicking the admin console's own rendered "Beispiel-App installieren"
 * buttons via `submit` dispatch - never calling `installGuestbook()`/etc.
 * directly - so a regression in the REGISTER-THEN-INSTALL ordering, the
 * `adminViewKind`/`globalViewNames` classification, or the rendered UI
 * itself would actually be caught here, not just in the Dev API.
 *
 * TWO bugs this file specifically guards against, both real and
 * previously shipped:
 *   1. Installing Gästebuch/Blog/Forum under DIFFERENT prefixes from the
 *      SAME admin session used to make all three resolve to whichever
 *      one's write won a shared content-addressed slot - the "collision"
 *      test below installs all three and asserts each shows ITS OWN
 *      content.
 *   2. Forum's "start a topic"/"reply" used to be `qu-page`-backed
 *      (`'content'`-ACL, self-certified) - reachable only for the exact
 *      identity that happened to install the app, silently broken for any
 *      OTHER Space member. `forum-bundle.js` now stores topics/replies
 *      entirely as `'members'`-ACL shared-list entries - the Forum test
 *      below deliberately uses a THIRD identity (neither the relay-admin
 *      nor the installer) to start a topic and reply, proving any member
 *      can actually participate.
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
import { installGlobalAppBundle, registerApp, publishGlobalRoute, setAppMode, setAppBundleVersion } from '@qu/app-core';
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

/**
 * Boots a real WS relay with the live app resolver running, and the
 * built-in admin console installed - the shared fixture every test below
 * starts from. `extraActors` (identities besides the relay-admin that will
 * need to write 'members'-ACL content, e.g. a Guestbook visitor or a Forum
 * topic-starter) MUST be known to the RELAY's own authoritative `members`
 * list from the moment `createRelayForwarder()` is constructed - unlike a
 * `Space`'s own LOCAL `members` list (which only affects what IT believes
 * is valid), the relay never re-reads its own member list later, so an
 * identity added only to a `connect()`ed Space's own list, after boot,
 * would have every one of its 'members'-ACL writes rejected regardless.
 */
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

  // ORDER MATTERS - see `bin/install-admin-console.mjs`'s own doc comment in full: registerApp()
  // FIRST (so the live resolver starts watching "admin"'s own route registry), a settle wait,
  // THEN publishGlobalRoute() (so the SAME resolver's own globalPageIds actually includes '/'
  // before any page write follows), another settle wait, THEN the content itself
  // (installGlobalAppBundle()) - reversing this (a real, once-shipped bug in this file's own
  // fixture) leaves the admin page's write permanently misclassified against the generic
  // `pageKind` fallback, silently rejected - `resolvePage('/')` then never finds it, for ANYONE,
  // not just a same-identity race.
  const adminSpace = await connect(relayAdmin);
  await registerApp(adminSpace, { prefix: 'admin', name: 'Relay-Admin', realm: 'global' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await publishGlobalRoute(adminSpace, 'admin', { route: '/', title: 'Relay-Admin' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await installGlobalAppBundle(adminSpace, 'admin', adminConsoleBundle);
  await new Promise((resolve) => setTimeout(resolve, 300)); // let the page write itself settle before anything navigates to it.

  async function close() {
    wss.clients.forEach((ws) => ws.terminate());
    await new Promise((resolve) => httpServer.close(resolve));
  }

  return { relayAdmin, members, url, connect, close };
}

/** Renders `#/admin` for `space` and returns the mounted DOM plus the running router (caller must `router.stop()`). */
function mountAdmin(space) {
  const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://platform.test/#/admin' });
  const mountEl = window.document.querySelector('qu-app-shell');
  const { router, platform } = startPlatform({ space, mountEl, window, resolveTimeout: 1500 });
  return { window, mountEl, router, platform };
}

/** Fills and submits one of the admin console's "Beispiel-App installieren" forms for `appType`, waiting for its own confirmation status. */
async function installViaForm(mountEl, appType, prefix) {
  await waitUntil(() => mountEl.querySelector(`form[data-qu-action="install-app"][data-app-type="${appType}"]`));
  const form = mountEl.querySelector(`form[data-qu-action="install-app"][data-app-type="${appType}"]`);
  form.querySelector('input[name="prefix"]').value = prefix;
  form.dispatchEvent(new mountEl.ownerDocument.defaultView.Event('submit', { bubbles: true, cancelable: true }));
  await waitUntil(() => /installiert/.test(form.querySelector('[data-qu-status]')?.textContent ?? ''), { timeout: 6000 });
}

test('installing Gästebuch, Blog, and Forum from the SAME admin session under different prefixes never collide - each shows its own content', async () => {
  const relay = await bootRelay();
  const adminSpace = await relay.connect(relay.relayAdmin);
  const { mountEl, router } = mountAdmin(adminSpace);

  await installViaForm(mountEl, 'guestbook', 'gaestebuch');
  await installViaForm(mountEl, 'blog', 'blog');
  await installViaForm(mountEl, 'forum', 'forum');

  // Waits for the actual FORM marker, never just matching text - the admin console's OWN page
  // (still showing right up until the navigate() below actually re-renders) already mentions every
  // installed app's own name in its "Installierte Apps" list, so a loose text match would pass
  // immediately regardless of whether the navigation actually happened yet.
  router.navigate('/gaestebuch/');
  await waitUntil(() => mountEl.querySelector('form[data-qu-action="guestbook-form"]'));
  assert.ok(mountEl.querySelector('form[data-qu-action="guestbook-form"]'), 'gaestebuch shows the Guestbook, not something else');

  router.navigate('/blog/');
  await waitUntil(() => mountEl.querySelector('form[data-qu-action="blog-post-form"]'));
  assert.ok(mountEl.querySelector('form[data-qu-action="blog-post-form"]'), 'blog shows the Blog, not the Guestbook (the collision bug this test guards against)');

  router.navigate('/forum/');
  await waitUntil(() => mountEl.querySelector('form[data-qu-action="forum-topic-form"]'));
  assert.ok(mountEl.querySelector('form[data-qu-action="forum-topic-form"]'), 'forum shows the Forum, not the Guestbook or Blog');

  router.stop();
  await relay.close();
});

test('the admin console lists a newly-installed app with its mode toggle and Besuchen/Verwalten links', async () => {
  const relay = await bootRelay();
  const adminSpace = await relay.connect(relay.relayAdmin);
  const { mountEl, router } = mountAdmin(adminSpace);

  await installViaForm(mountEl, 'guestbook', 'gaestebuch');
  await waitUntil(() => [...mountEl.querySelectorAll('[data-qu-bind="platform-apps-list"] li')].some((li) => li.textContent.includes('#/gaestebuch')));
  const row = [...mountEl.querySelectorAll('[data-qu-bind="platform-apps-list"] li')].find((li) => li.textContent.includes('#/gaestebuch'));

  assert.ok(row.querySelector('a[href="#/gaestebuch/"]'), 'a direct "Besuchen" link to the app itself is shown');
  assert.ok(row.querySelector('a[href="#/admin/gaestebuch/"]'), 'a "Verwalten" link to the global shell/editor is shown');
  const modeButtons = [...row.querySelectorAll('button')].map((b) => b.textContent);
  assert.ok(['Aus', 'Global', 'Multi-User'].every((label) => modeButtons.includes(label)), `mode toggle buttons are shown: ${modeButtons}`);

  router.stop();
  await relay.close();
});

test('Guestbook: a visitor signs it through the rendered form, and the entry appears live in the feed', async () => {
  const visitor = await actor();
  const relay = await bootRelay({ extraActors: [visitor] });
  const adminSpace = await relay.connect(relay.relayAdmin);
  const { mountEl: adminMountEl, router: adminRouter } = mountAdmin(adminSpace);
  await installViaForm(adminMountEl, 'guestbook', 'gaestebuch');
  adminRouter.stop();

  const visitorSpace = await relay.connect(visitor);
  const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://platform.test/#/gaestebuch' });
  const mountEl = window.document.querySelector('qu-app-shell');
  const { router } = startPlatform({ space: visitorSpace, mountEl, window, resolveTimeout: 1500 });

  await waitUntil(() => mountEl.querySelector('form[data-qu-action="guestbook-form"]'));
  const form = mountEl.querySelector('form[data-qu-action="guestbook-form"]');
  form.querySelector('[name="name"]').value = 'Alice';
  form.querySelector('[name="message"]').value = 'Hallo aus dem Gästebuch!';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  await waitUntil(() => /bestätigt/.test(form.querySelector('[data-qu-status]')?.textContent ?? ''));
  await waitUntil(() => mountEl.querySelector('[data-qu-view="gaestebuch-feed"]')?.textContent.includes('Hallo aus dem Gästebuch!'));
  assert.ok(mountEl.querySelector('[data-qu-view="gaestebuch-feed"]').textContent.includes('Alice'));

  router.stop();
  await relay.close();
});

test('Blog: a relay-admin publishes a post through the rendered form, it appears in the index, and its own page renders', async () => {
  const relay = await bootRelay();
  const installerSpace = await relay.connect(relay.relayAdmin);
  const { mountEl: adminMountEl, router: adminRouter } = mountAdmin(installerSpace);
  await installViaForm(adminMountEl, 'blog', 'blog');
  adminRouter.stop();

  // A FRESH connection (same relay-admin identity, but never having touched this content before)
  // browses and publishes - not `installerSpace` itself. Reusing the exact Space that JUST wrote
  // the page tears down its own local cache on the very first read-back (a documented, accepted
  // cost elsewhere in this codebase - `boot.js`'s `ensureSelfProvisioned()` own "REAL RACE" doc
  // comment) and needs a genuine relay round trip to resync - usually fast, but a real,
  // occasionally-slow cost under load, not something to paper over with an ever-larger timeout.
  // Guestbook's/Forum's own tests already avoid this by using a separate visitor identity/connection.
  const authorSpace = await relay.connect(relay.relayAdmin);
  const { window, mountEl, router } = mountAdmin(authorSpace);

  router.navigate('/blog/');
  await waitUntil(() => mountEl.querySelector('form[data-qu-action="blog-post-form"]'));
  const form = mountEl.querySelector('form[data-qu-action="blog-post-form"]');
  form.querySelector('[name="title"]').value = 'Erster Beitrag';
  form.querySelector('[name="slug"]').value = 'erster-beitrag';
  form.querySelector('[name="content"]').value = '<p>Mein erster Blog-Post.</p>';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  await waitUntil(() => /bestätigt/.test(form.querySelector('[data-qu-status]')?.textContent ?? ''), { timeout: 6000 });
  await waitUntil(() => mountEl.querySelector('[data-qu-view] a[data-qu-view-link]'));
  const link = mountEl.querySelector('[data-qu-view] a[data-qu-view-link]');
  assert.equal(link.textContent, 'Erster Beitrag');
  assert.equal(link.getAttribute('href'), '#/post/erster-beitrag');

  // Prefixed with the app's own "blog" - unlike routed-view.test.js's own startApp()-based test
  // (single app, no prefix stripping), startPlatform() treats the FIRST path segment as the
  // registered app prefix (PlatformRuntime.resolveForPath()) - navigating to the bare
  // "/post/erster-beitrag" would be interpreted as prefix "post", not routed within "blog" at all.
  router.navigate('/blog/post/erster-beitrag');
  await waitUntil(() => mountEl.textContent.includes('Mein erster Blog-Post.'), { timeout: 8000 });

  router.stop();
  await relay.close();
});

test('Forum: a topic is started by one Space member and replied to by a DIFFERENT one - neither the relay-admin nor the installer', async () => {
  const starter = await actor();
  const replier = await actor();
  const relay = await bootRelay({ extraActors: [starter, replier] });

  const adminSpace = await relay.connect(relay.relayAdmin);
  const { mountEl: adminMountEl, router: adminRouter } = mountAdmin(adminSpace);
  await installViaForm(adminMountEl, 'forum', 'forum');
  adminRouter.stop();

  // A visitor who is NEITHER the relay-admin NOR the identity that ran the installer starts a
  // topic - the exact scenario an earlier, `qu-page`-backed version of this bundle silently broke.
  const starterSpace = await relay.connect(starter);
  const { window: starterWindow } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://platform.test/#/forum' });
  const starterMountEl = starterWindow.document.querySelector('qu-app-shell');
  const { router: starterRouter } = startPlatform({ space: starterSpace, mountEl: starterMountEl, window: starterWindow, resolveTimeout: 1500 });

  await waitUntil(() => starterMountEl.querySelector('form[data-qu-action="forum-topic-form"]'));
  const topicForm = starterMountEl.querySelector('form[data-qu-action="forum-topic-form"]');
  topicForm.querySelector('[name="title"]').value = 'Erstes Thema';
  topicForm.querySelector('[name="author"]').value = 'Stella';
  topicForm.querySelector('[name="body"]').value = 'Worum geht es hier?';
  topicForm.dispatchEvent(new starterWindow.Event('submit', { bubbles: true, cancelable: true }));
  await waitUntil(() => /bestätigt/.test(topicForm.querySelector('[data-qu-status]')?.textContent ?? ''));
  starterRouter.stop();

  // A THIRD identity (never the relay-admin, never the topic starter) opens the topic and replies.
  const replierSpace = await relay.connect(replier);
  const { window: replierWindow } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://platform.test/#/forum' });
  const replierMountEl = replierWindow.document.querySelector('qu-app-shell');
  const { router: replierRouter } = startPlatform({ space: replierSpace, mountEl: replierMountEl, window: replierWindow, resolveTimeout: 1500 });

  await waitUntil(() => replierMountEl.querySelector(`[data-qu-view="forum-topics"] [data-qu-view-link]`)?.textContent.includes('Erstes Thema'));
  const topicLink = replierMountEl.querySelector('[data-qu-view="forum-topics"] [data-qu-view-link]');
  topicLink.dispatchEvent(new replierWindow.Event('click', { bubbles: true, cancelable: true }));

  await waitUntil(() => !replierMountEl.querySelector('[data-qu-forum-detail]').hidden);
  assert.equal(replierMountEl.querySelector('[data-qu-forum-title]').textContent, 'Erstes Thema');
  assert.ok(replierMountEl.querySelector('[data-qu-forum-body]').textContent.includes('Worum geht es hier?'));

  const replyForm = replierMountEl.querySelector('form[data-qu-action="forum-reply-form"]');
  replyForm.querySelector('[name="author"]').value = 'Carol';
  replyForm.querySelector('[name="message"]').value = 'Gute Frage!';
  replyForm.dispatchEvent(new replierWindow.Event('submit', { bubbles: true, cancelable: true }));

  await waitUntil(() => /bestätigt/.test(replyForm.querySelector('[data-qu-status]')?.textContent ?? ''));
  await waitUntil(() => replierMountEl.querySelector('[data-qu-forum-replies]')?.textContent.includes('Gute Frage!'));
  assert.ok(replierMountEl.querySelector('[data-qu-forum-replies]').textContent.includes('Carol'));

  replierRouter.stop();
  await relay.close();
});

test('Guestbook: a visitor\'s own personal guestbook (#/book/u/me/) is separate from the global one and self-provisions on first visit', async () => {
  const visitor = await actor();
  const relay = await bootRelay({ extraActors: [visitor] });
  try {
    const adminSpace = await relay.connect(relay.relayAdmin);
    const { mountEl: adminMountEl, router: adminRouter } = mountAdmin(adminSpace);
    await installViaForm(adminMountEl, 'guestbook', 'book');
    adminRouter.stop();

    const visitorSpace = await relay.connect(visitor);
    const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://platform.test/#/book/u/me/' });
    const mountEl = window.document.querySelector('qu-app-shell');
    const { router } = startPlatform({ space: visitorSpace, mountEl, window, resolveTimeout: 1500 });

    // Self-provisioned "Mein Gästebuch" - a DIFFERENT page than the global one, reached via the
    // ADDITIVE /u/me/ route (boot.js's own doc comment: never replaces what the bare #/book/ prefix
    // means - the assertion at the very end of this test proves that side by side).
    await waitUntil(() => mountEl.textContent.includes('Mein Gästebuch'));
    await waitUntil(() => mountEl.querySelector('form[data-qu-action="guestbook-form"]'));
    const personalForm = mountEl.querySelector('form[data-qu-action="guestbook-form"]');
    personalForm.querySelector('[name="name"]').value = 'Alice';
    personalForm.querySelector('[name="message"]').value = 'Das ist mein eigenes Gästebuch!';
    personalForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

    await waitUntil(() => /bestätigt/.test(personalForm.querySelector('[data-qu-status]')?.textContent ?? ''));
    await waitUntil(() => mountEl.querySelector('[data-qu-view="book-personal-feed"]')?.textContent.includes('Das ist mein eigenes Gästebuch!'));

    // The GLOBAL guestbook, at the bare prefix, is untouched by any of this - a different page, a
    // different (empty) feed. Waits for the GLOBAL feed specifically (`book-feed`, not
    // `book-personal-feed`) - both renders have a `form[data-qu-action="guestbook-form"]`, so
    // waiting on that alone would resolve against the STALE personal render still in the DOM the
    // instant navigate() is called, before the new page actually replaces it.
    router.navigate('/book/');
    await waitUntil(() => mountEl.querySelector('[data-qu-view="book-feed"]'));
    assert.ok(mountEl.textContent.includes('Gästebuch') && !mountEl.textContent.includes('Mein Gästebuch'), 'the bare prefix still shows the GLOBAL guestbook page');
    assert.ok(!mountEl.querySelector('[data-qu-view="book-feed"]').textContent.includes('Das ist mein eigenes Gästebuch!'), "the global feed never saw the personal guestbook's own entry");

    router.stop();
  } finally {
    await relay.close();
  }
});

test('Blog: a visitor\'s own personal blog (#/blog/u/me/) lets ANY Space member publish, separately from the relay-admin-only global blog', async () => {
  const author = await actor();
  const relay = await bootRelay({ extraActors: [author] });
  try {
    const adminSpace = await relay.connect(relay.relayAdmin);
    const { mountEl: adminMountEl, router: adminRouter } = mountAdmin(adminSpace);
    await installViaForm(adminMountEl, 'blog', 'blog');
    adminRouter.stop();

    // `author` is an ORDINARY Space member, never a relay-admin - the global blog's own form would
    // reject their post (blog-bundle.js's own doc comment: relay-admins only) - their PERSONAL blog
    // uses self-owned, self-certified writes instead, so this must succeed regardless.
    const authorSpace = await relay.connect(author);
    const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://platform.test/#/blog/u/me/' });
    const mountEl = window.document.querySelector('qu-app-shell');
    const { router } = startPlatform({ space: authorSpace, mountEl, window, resolveTimeout: 1500 });

    await waitUntil(() => mountEl.textContent.includes('Mein Blog'));
    await waitUntil(() => mountEl.querySelector('form[data-qu-action="blog-post-form"]'));
    const form = mountEl.querySelector('form[data-qu-action="blog-post-form"]');
    form.querySelector('[name="title"]').value = 'Mein erster eigener Post';
    form.querySelector('[name="slug"]').value = 'eigener-post';
    form.querySelector('[name="content"]').value = '<p>Ganz allein mein Blog.</p>';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

    await waitUntil(() => /bestätigt/.test(form.querySelector('[data-qu-status]')?.textContent ?? ''), { timeout: 6000 });
    await waitUntil(() => mountEl.querySelector('[data-qu-view] a[data-qu-view-link]'));
    const link = mountEl.querySelector('[data-qu-view] a[data-qu-view-link]');
    assert.equal(link.textContent, 'Mein erster eigener Post');
    assert.equal(link.getAttribute('href'), '#/blog/u/me/post/eigener-post', "a personal post's own link stays within the /u/me/ instance - the bare /blog/post/<slug> the global blog uses would land on the GLOBAL shell instead (boot.js's own renderGlobalShell(), a different owner anchor entirely)");

    // A fresh read-back through the SAME connection that just wrote it - see the earlier "Blog:
    // a relay-admin publishes..." test's own comment on why this specific step gets a more generous
    // timeout (a real, occasionally-slow relay round trip, not a logic bug).
    router.navigate('/blog/u/me/post/eigener-post');
    await waitUntil(() => mountEl.textContent.includes('Ganz allein mein Blog.'), { timeout: 8000 });

    router.stop();
  } finally {
    await relay.close();
  }
});

test('Guestbook: mode:"personal" replaces the bare prefix with a read-only aggregate feed merged across every visitor\'s own personal instance', async () => {
  const visitor = await actor();
  const relay = await bootRelay({ extraActors: [visitor] });
  try {
    const adminSpace = await relay.connect(relay.relayAdmin);
    const { mountEl: adminMountEl, router: adminRouter } = mountAdmin(adminSpace);
    await installViaForm(adminMountEl, 'guestbook', 'board');
    // A short settle wait BEFORE calling into the Dev API again on the SAME `adminSpace` -
    // `installViaForm()`'s own confirmation already proves the registerApp() write itself was
    // acked, but the admin console's own `renderList()` (called right after, inside the submit
    // handler) does its own `resolveApps()` read of that SAME registry Node - `useNode()`+
    // `release()`, tearing the local Y.Doc back down exactly the way `dev.js`'s own
    // `getOrSyncRegistryNode()` doc comment describes elsewhere - so a `setAppMode()` call fired
    // immediately after can otherwise race a resync still in flight.
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Flip to mode:"personal" via the real Dev API - the admin console's own mode-toggle UI (the
    // exact same `setAppMode()` call) is already covered end to end by `admin-mode-toggle.test.js`;
    // this test's own focus is the AGGREGATE FEED rendering behind it, not re-proving the button.
    await setAppMode(adminSpace, { prefix: 'board', mode: 'personal' });
    adminRouter.stop();

    const visitorSpace = await relay.connect(visitor);
    const { window } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://platform.test/#/board/u/me/' });
    const mountEl = window.document.querySelector('qu-app-shell');
    const { router } = startPlatform({ space: visitorSpace, mountEl, window, resolveTimeout: 1500 });

    await waitUntil(() => mountEl.querySelector('form[data-qu-action="guestbook-form"]'));
    const form = mountEl.querySelector('form[data-qu-action="guestbook-form"]');
    form.querySelector('[name="name"]').value = 'Dana';
    form.querySelector('[name="message"]').value = 'Ich trage mich in den Feed ein.';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await waitUntil(() => /bestätigt/.test(form.querySelector('[data-qu-status]')?.textContent ?? ''));

    // The bare prefix - no "/u/" segment at all - now shows the AGGREGATE feed, not a relay-admin-
    // authored page: no `guestbook-form` there any more (`mode: 'personal'` has no such page), just
    // the merged, read-only `<prefix>-aggregate-feed` View picking up Dana's own entry.
    router.navigate('/board/');
    await waitUntil(() => mountEl.querySelector('[data-qu-view="board-aggregate-feed"]')?.textContent.includes('Ich trage mich in den Feed ein.'), { timeout: 4000 });
    assert.ok(!mountEl.querySelector('form[data-qu-action="guestbook-form"]'), 'mode:"personal"\'s own bare prefix is read-only - no sign-form there');

    router.stop();
  } finally {
    await relay.close();
  }
});

test('Guestbook: the admin console\'s "Update verfügbar" button re-applies the bundle\'s current content and clears itself once done', async () => {
  const relay = await bootRelay();
  try {
    const adminSpace = await relay.connect(relay.relayAdmin);
    const { mountEl, router, platform } = mountAdmin(adminSpace);
    await installViaForm(mountEl, 'guestbook', 'diary');
    await new Promise((resolve) => setTimeout(resolve, 300)); // settle wait - see the "personal" test above's own doc comment on why.

    // Simulate an OLDER install - `setAppBundleVersion()` (the exact primitive a real prior
    // "Update" click would have bumped) rolled back to "never updated", the only state that
    // actually shows the button.
    await setAppBundleVersion(adminSpace, { prefix: 'diary', bundleVersion: 0 });
    // `wireAdminConsole()`'s own `renderList()` is pull-based, not reactively subscribed to the
    // registry (`admin-mode-toggle.test.js`'s own tests only ever see a refresh because THEIR OWN
    // click handlers explicitly call `renderList()` afterward) - this direct Dev-API write (mimicking
    // some other actor's own prior update, not a click in THIS session) needs an explicit re-render
    // to become visible at all; a bare re-navigate to the SAME hash is a no-op (`HashRouter.navigate()`'s
    // own doc comment - no `hashchange` fires for an unchanged `location.hash`), so this goes to
    // `/admin/` (a different hash string) and back, forcing `wireAdminConsole()` to re-wire and
    // re-render fresh.
    router.navigate('/admin/');
    await waitUntil(() => mountEl.querySelector('[data-qu-bind="platform-apps-list"] li'));

    function diaryListItem() {
      return [...mountEl.querySelectorAll('[data-qu-bind="platform-apps-list"] li')].find((li) => li.textContent.includes('#/diary'));
    }
    await waitUntil(() => [...(diaryListItem()?.querySelectorAll('button') ?? [])].some((b) => b.textContent === 'Update verfügbar'));
    let li = diaryListItem();
    const updateBtn = [...li.querySelectorAll('button')].find((b) => b.textContent === 'Update verfügbar');
    assert.ok(updateBtn, '"Update verfügbar" shows once the registered bundleVersion (0) is behind the bundle\'s own current version');
    updateBtn.dispatchEvent(new mountEl.ownerDocument.defaultView.Event('click', { bubbles: true, cancelable: true }));

    await waitUntil(() => ![...(diaryListItem()?.querySelectorAll('button') ?? [])].some((b) => b.textContent === 'Update verfügbar'), { timeout: 4000 });
    assert.ok(!diaryListItem()?.querySelector('[data-qu-status]')?.textContent, 'no error surfaced - the update actually succeeded');

    const apps = await platform.resolveApps({ timeout: 1000 });
    const diary = apps.find((a) => a.prefix === 'diary');
    assert.equal(diary.bundleVersion, 1, 'setAppBundleVersion() recorded the bundle\'s own current version after the update');

    router.stop();
  } finally {
    await relay.close();
  }
});

test('Guestbook: "Deinstallieren" retracts the registration and clears the global content, making the prefix unreachable again', async () => {
  const relay = await bootRelay();
  try {
    const adminSpace = await relay.connect(relay.relayAdmin);
    const { mountEl, router } = mountAdmin(adminSpace);
    await installViaForm(mountEl, 'guestbook', 'notes');

    function notesListItem() {
      return [...mountEl.querySelectorAll('[data-qu-bind="platform-apps-list"] li')].find((li) => li.textContent.includes('#/notes'));
    }
    await waitUntil(() => notesListItem());
    const uninstallBtn = [...notesListItem().querySelectorAll('button')].find((b) => b.textContent === 'Deinstallieren');
    assert.ok(uninstallBtn, '"Deinstallieren" is offered for every realm:"global" entry');
    uninstallBtn.dispatchEvent(new mountEl.ownerDocument.defaultView.Event('click', { bubbles: true, cancelable: true }));

    await waitUntil(() => !notesListItem(), { timeout: 4000 });

    // The bare prefix is now indistinguishable from never having been registered - the landing
    // page, not the app, not a broken/blank shell. Checked from a BRAND-NEW identity/connection,
    // not `adminSpace`'s own (already-torn-down-and-resynced-several-times-over) one, so this
    // genuinely proves the retraction is visible to anyone, not just an artifact of the admin
    // console's own already-open session.
    const outsider = await actor();
    const outsiderSpace = await relay.connect(outsider);
    const { window: outsiderWindow } = new JSDOM('<!doctype html><body><qu-app-shell></qu-app-shell></body>', { url: 'https://platform.test/#/notes/' });
    const outsiderMount = outsiderWindow.document.querySelector('qu-app-shell');
    const { router: outsiderRouter, platform: outsiderPlatform } = startPlatform({ space: outsiderSpace, mountEl: outsiderMount, window: outsiderWindow, resolveTimeout: 1500 });
    await waitUntil(() => outsiderMount.textContent.includes('Qu App Shell'), { timeout: 10000 });
    assert.ok(!outsiderMount.querySelector('form[data-qu-action="guestbook-form"]'), 'the uninstalled app\'s own content is gone, not just its registry entry');
    const apps = await outsiderPlatform.resolveApps({ timeout: 2000 });
    assert.ok(!apps.some((a) => a.prefix === 'notes'), 'resolveApps() no longer lists the retracted prefix at all, even from a completely fresh connection');
    outsiderRouter.stop();

    router.stop();
  } finally {
    await relay.close();
  }
});
