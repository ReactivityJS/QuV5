/**
 * THE FORUM APP, AS A PLAIN BUNDLE — `docs/example-apps.md`'s own "§3
 * Forum" doc comment: no new Kind-Schema, built entirely out of
 * `sharedListKind` (twice) + `pageKind` (one page per topic) + `viewKind`
 * (a topics feed, plus one PER-TOPIC reply feed). `installForum()` seeds
 * only the FORUM'S OWN INDEX (topic list + "start a topic" form) -
 * individual topics/replies are created live by `forum-actions.js`'s
 * `wireForum()` as visitors actually use the forum, not by this bundle.
 *
 * TWO shared lists, BOTH known at install time (this matters - see
 * `dev.js`'s `registerApp()` own `sharedLists` doc comment on why a
 * shared list's name must be told to the relay ahead of any write):
 *   - `${prefix}:topics` - one entry per topic (title/author/route/own id).
 *   - `${prefix}:replies` - EVERY reply, across EVERY topic, each entry
 *     carrying its own `topicId` - a per-topic reply View
 *     (`forum-actions.js`'s `startTopic()`) FILTERS this ONE list down to
 *     one topic's own entries (`view-sources.js`'s `'shared-list'` source
 *     adapter own `filter` param) rather than needing a brand-new,
 *     unregistered list name PER TOPIC (which topics themselves don't
 *     have this problem for - `pageKind`/`viewKind` are `'content'`-ACL,
 *     self-certifying, no relay pre-registration needed at any point,
 *     unlike `'members'`-ACL shared lists).
 */
import { createPage, publishRoute, createView } from '@qu/app-core';

/** @param {import('@qu/space-core').Space} space @param {{prefix: string}} params */
export async function installForum(space, { prefix }) {
  await createPage(space, {
    route: '/',
    title: 'Forum',
    content: `<h1>Forum</h1>
<form data-qu-action="forum-topic-form" data-qu-prefix="${prefix}">
  <label>Titel: <input name="title" required></label><br>
  <label>Dein Name: <input name="author" required></label><br>
  <label>Beitrag:<br><textarea name="body" rows="5" cols="60" required></textarea></label><br>
  <button type="submit">Thema erstellen</button>
  <p data-qu-status></p>
</form>
<h2>Themen</h2>
<div data-qu-view="${prefix}-topics"></div>`,
  });
  await publishRoute(space, { route: '/', title: 'Forum' });
  await createView(space, {
    name: `${prefix}-topics`,
    sources: [{ type: 'shared-list', name: `${prefix}:topics` }],
    sortBy: 'timestamp',
    sortOrder: 'desc',
    itemTemplate: '<p><a data-qu-view-link><qu-slot name="title"></qu-slot></a> — <qu-slot name="excerpt"></qu-slot></p>',
  });
}
