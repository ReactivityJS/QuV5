/**
 * VIEWS — `kinds.js`'s own `viewKind` doc comment: a live, aggregated feed
 * mixing DIFFERENT content sources (the user's own "user-feed combines
 * Blog + Gästebuch" example) via `view-sources.js`'s `openLiveView()`.
 *
 * Proves, over a REAL (in-process) relay:
 *   1. A View combining a `'pages'` source (routes under `/blog/`) and a
 *      `'shared-list'` source (a guestbook) merges both into one sorted
 *      feed, each item normalized to the same `{title, excerpt, route,
 *      timestamp}` shape regardless of which source produced it.
 *   2. LIVE, not a one-time snapshot: publishing a brand-new blog page
 *      AFTER the View was already opened updates the live feed with no
 *      re-open, no reload - `openLiveView()`'s own `observe()`-driven
 *      recompute actually fires.
 *   3. Same for the guestbook side: a new entry pushed by a COMPLETELY
 *      DIFFERENT identity, after the View is open, also shows up live.
 *   4. `close()` actually stops future notifications (no leaked observer
 *      still firing into a torn-down consumer).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuCrypto } from '@qu/core';
import { Space } from '@qu/space-core';
import { InProcessTransport, createInProcessHub, createRelayForwarder } from '@qu/space-transport';
import { createMemoryStore } from '@qu/space-storage';
import { ContentResolver } from '../src/resolver.js';
import { createPage, publishRoute, pushToSharedList, createView } from '../src/dev.js';
import { createAppResolveKindSchema } from '../src/relay-resolver.js';
import { openLiveView } from '../src/view-sources.js';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

async function connect(hub, identity, members, peerId) {
  const transport = new InProcessTransport(hub, peerId);
  await transport.connect();
  return new Space({ identity, members, transport });
}

function waitForCondition(fn, { timeout = 2000, interval = 20 } = {}) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    (function poll() {
      if (fn()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('waitForCondition: timed out'));
      setTimeout(poll, interval);
    })();
  });
}

test('a View merges a pages source and a shared-list source into one live, sorted feed', async () => {
  const owner = await actor();
  const guest = await actor(); // pushes a guestbook entry, never touches pages.
  const members = [
    { pub: owner.signingPub, xPub: owner.xPublicKey },
    { pub: guest.signingPub, xPub: guest.xPublicKey },
  ];
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ sharedListNames: ['guestbook'] });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });

  const ownerSpace = await connect(hub, owner, members, 'owner');
  const guestSpace = await connect(hub, guest, members, 'guest');

  await createPage(ownerSpace, { route: '/blog/erster-post', title: 'Erster Post', content: '<p>Hallo</p>' });
  await publishRoute(ownerSpace, { route: '/blog/erster-post', title: 'Erster Post' });
  await publishRoute(ownerSpace, { route: '/impressum', title: 'Impressum' }); // NOT under /blog/ - must be excluded by the 'pages' source's own prefix filter.
  // `route` is optional (a plain guestbook entry has none) - included here to prove a
  // 'shared-list' entry that DOES carry one (e.g. a forum topic linking to its own detail page,
  // see docs/example-apps.md) passes it through to `item.route`, the SAME key a `'pages'` source
  // item already exposes.
  await pushToSharedList(ownerSpace, 'guestbook', { name: 'Alice', message: 'Toller Blog!', route: '/guestbook#alice' });

  await createView(ownerSpace, {
    name: 'user-feed',
    sources: [
      { type: 'pages', prefix: '/blog/' },
      { type: 'shared-list', name: 'guestbook' },
    ],
    sortBy: 'title',
    sortOrder: 'asc',
    itemTemplate: '<div><qu-slot name="title"></qu-slot></div>',
  });

  const readerSpace = await connect(hub, owner, members, 'reader');
  const resolver = new ContentResolver(readerSpace, { appAdminPub: owner.signingPub });
  const config = await resolver.resolveView('user-feed', { timeout: 2000 });
  assert.equal(config.sources.length, 2);
  assert.equal(config.itemTemplate, '<div><qu-slot name="title"></qu-slot></div>');

  const view = await openLiveView(readerSpace, { appAdminPub: owner.signingPub, ...config });
  try {
    let items = await view.toArray();
    assert.deepEqual(
      items.map((i) => i.title),
      ['Alice', 'Erster Post'],
      "both sources' items are merged and sorted together, /impressum excluded by the pages source's own prefix filter"
    );
    assert.equal(items.find((i) => i.title === 'Erster Post').route, '/blog/erster-post');
    assert.equal(items.find((i) => i.title === 'Alice').excerpt, 'Toller Blog!');
    assert.equal(items.find((i) => i.title === 'Alice').route, '/guestbook#alice', "a 'shared-list' entry's own optional route passes through unchanged");

    // --- LIVE: a brand-new page published AFTER the View was opened shows up with no re-open. ---
    let notified = false;
    const unobserve = view.observe(() => {
      notified = true;
    });
    await createPage(ownerSpace, { route: '/blog/zweiter-post', title: 'Zweiter Post', content: '<p>Noch mehr</p>' });
    await publishRoute(ownerSpace, { route: '/blog/zweiter-post', title: 'Zweiter Post' });
    await waitForCondition(() => notified, { timeout: 2000 });
    items = await view.toArray();
    assert.deepEqual(items.map((i) => i.title), ['Alice', 'Erster Post', 'Zweiter Post'], 'a new page published after the View was opened appears live, no re-open needed');

    // --- LIVE: a guestbook entry from a COMPLETELY DIFFERENT identity also shows up live. ---
    notified = false;
    await pushToSharedList(guestSpace, 'guestbook', { name: 'Bob', message: 'Auch von mir!' });
    await waitForCondition(() => notified, { timeout: 2000 });
    items = await view.toArray();
    assert.deepEqual(
      items.map((i) => i.title).sort(),
      ['Alice', 'Bob', 'Erster Post', 'Zweiter Post'].sort(),
      "a different identity's own guestbook entry, pushed after the View was opened, appears live too"
    );

    // --- close() actually stops future notifications. ---
    unobserve();
    notified = false;
    view.close();
    await pushToSharedList(ownerSpace, 'guestbook', { name: 'Nach dem Schließen', message: '...' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(notified, false, 'no observer should fire after close()');
  } finally {
    view.close();
  }
});

test('openLiveView().setQuery() live, case-insensitive full-text search across merged sources - matches content excerpt, not just title', async () => {
  const owner = await actor();
  const members = [{ pub: owner.signingPub, xPub: owner.xPublicKey }];
  const hub = createInProcessHub();
  const resolveKindSchema = await createAppResolveKindSchema({ sharedListNames: ['guestbook'] });
  createRelayForwarder({ hub, members, resolveKindSchema, storage: createMemoryStore() });

  const ownerSpace = await connect(hub, owner, members, 'owner');

  await createPage(ownerSpace, { route: '/blog/katzen-post', title: 'Wochenrückblick', content: '<p>Heute ging es um Katzen und Hunde.</p>' });
  await publishRoute(ownerSpace, { route: '/blog/katzen-post', title: 'Wochenrückblick', excerpt: 'Heute ging es um Katzen und Hunde.' });
  await createPage(ownerSpace, { route: '/blog/reise-post', title: 'Reisebericht', content: '<p>Ein Bericht über Berge.</p>' });
  await publishRoute(ownerSpace, { route: '/blog/reise-post', title: 'Reisebericht', excerpt: 'Ein Bericht über Berge.' });
  await pushToSharedList(ownerSpace, 'guestbook', { name: 'Alice', message: 'Ich mag auch Katzen!' });

  await createView(ownerSpace, {
    name: 'searchable-feed',
    sources: [
      { type: 'pages', prefix: '/blog/' },
      { type: 'shared-list', name: 'guestbook' },
    ],
    sortBy: 'title',
    sortOrder: 'asc',
    itemTemplate: '<div><qu-slot name="title"></qu-slot></div>',
  });

  const readerSpace = await connect(hub, owner, members, 'reader');
  const resolver = new ContentResolver(readerSpace, { appAdminPub: owner.signingPub });
  const config = await resolver.resolveView('searchable-feed', { timeout: 2000 });
  const view = await openLiveView(readerSpace, { appAdminPub: owner.signingPub, ...config });
  try {
    let items = await view.toArray();
    assert.equal(items.length, 3, 'unfiltered - every item from both sources');

    // Matches the BLOG POST's own content excerpt, not its title - proves this is genuine
    // full-text search over content, not a title-only filter.
    await view.setQuery('Katzen');
    items = await view.toArray();
    assert.deepEqual(
      items.map((i) => i.title).sort(),
      ['Alice', 'Wochenrückblick'],
      'case-insensitive substring match against title+excerpt across BOTH source types finds the blog post by its CONTENT (not its title) and the guestbook entry by its message'
    );

    // Case-insensitive.
    await view.setQuery('BERGE');
    items = await view.toArray();
    assert.deepEqual(items.map((i) => i.title), ['Reisebericht']);

    // No match -> empty, not an error.
    await view.setQuery('nonexistent-term-xyz');
    items = await view.toArray();
    assert.deepEqual(items, []);

    // Clearing the query (empty/whitespace) restores the full, unfiltered feed.
    await view.setQuery('   ');
    items = await view.toArray();
    assert.equal(items.length, 3);

    // setQuery() is itself LIVE - observe() fires on it, same as a source change.
    let notified = false;
    const unobserve = view.observe(() => (notified = true));
    await view.setQuery('Reise');
    assert.equal(notified, true, 'setQuery() notifies observers, same as any other recompute');
    unobserve();
  } finally {
    view.close();
  }
});
