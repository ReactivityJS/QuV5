/**
 * FORUM ACTIONS — the framework-provided interactivity `forum-bundle.js`'s
 * own inert "start a topic" form attaches to, PLUS the per-topic "reply"
 * form each topic page gets (created live, not by the bundle - see
 * `startTopic()` below). Same "content stays inert markup, this file adds
 * the behavior" posture as `guestbook-actions.js`/`blog-actions.js`.
 *
 * A topic is TWO things happening together, both under the SAME
 * `verifyWritesAcked()` guarantee `cms-actions.js`/`guestbook-actions.js`
 * already use elsewhere:
 *   1. an entry pushed onto the `${prefix}:topics` shared list (for the
 *      forum's own index View to pick up), and
 *   2. an ordinary `qu-page` at `/topic/<topicId>` (the topic's own body +
 *      a per-topic reply View + a reply form) - `createPage()`/`createView()`,
 *      exactly like any other page/View, no new mechanism.
 *
 * A reply is a SINGLE push onto the forum's other shared list,
 * `${prefix}:replies` - every topic's replies live in this ONE list,
 * distinguished only by the `topicId` field each entry carries. The
 * per-topic reply View `startTopic()` creates uses `view-sources.js`'s
 * `'shared-list'` adapter own `filter` param to narrow that one list down
 * to just this topic's own entries - see that adapter's doc comment for
 * why this beats a brand-new list name per topic (a `'members'`-ACL shared
 * list's name must be known to the relay ahead of any write - see
 * `dev.js`'s `registerApp()` own `sharedLists` doc comment - and topics are
 * created live, long after install time, so a per-topic list name could
 * never be pre-registered).
 */
import { pushToSharedList, createPage, createView, sharedListAnchor, sharedListKind } from '@qu/app-core';
import { deriveOwnerNodeId } from '@qu/space-core';
import { verifyWritesAcked } from './verify-writes.js';

async function startTopic(space, prefix, { title, author, body }) {
  const topicId = crypto.randomUUID();
  const route = `/topic/${topicId}`;
  const topicsId = await deriveOwnerNodeId(await sharedListAnchor(`${prefix}:topics`), sharedListKind.kind);
  await verifyWritesAcked(space, topicsId, () =>
    pushToSharedList(space, `${prefix}:topics`, { name: title, message: `von ${author}`, ts: Date.now(), route, topicId })
  );
  await createPage(space, {
    route,
    title,
    content: `<p><em>von ${author}</em></p>
<div>${body}</div>
<h2>Antworten</h2>
<div data-qu-view="topic-${topicId}-replies"></div>
<form data-qu-action="forum-reply-form" data-qu-prefix="${prefix}" data-qu-topic="${topicId}">
  <label>Dein Name: <input name="author" required></label><br>
  <label>Antwort:<br><textarea name="message" rows="3" cols="50" required></textarea></label><br>
  <button type="submit">Antworten</button>
  <p data-qu-status></p>
</form>`,
  });
  await createView(space, {
    name: `topic-${topicId}-replies`,
    sources: [{ type: 'shared-list', name: `${prefix}:replies`, filter: { topicId } }],
    sortBy: 'timestamp',
    sortOrder: 'asc',
    itemTemplate: '<p><strong><qu-slot name="title"></qu-slot>:</strong> <qu-slot name="excerpt"></qu-slot></p>',
  });
  return route;
}

async function reply(space, prefix, topicId, { author, message }) {
  const repliesId = await deriveOwnerNodeId(await sharedListAnchor(`${prefix}:replies`), sharedListKind.kind);
  await verifyWritesAcked(space, repliesId, () => pushToSharedList(space, `${prefix}:replies`, { name: author, message, ts: Date.now(), topicId }));
}

/** @param {{mountEl: Element, doc: Document, space: import('@qu/space-core').Space}} params */
export async function wireForum({ mountEl, doc, space }) {
  const topicForm = mountEl.querySelector('form[data-qu-action="forum-topic-form"]');
  if (topicForm) {
    const prefix = topicForm.getAttribute('data-qu-prefix');
    topicForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = topicForm.querySelector('[data-qu-status]') ?? topicForm.appendChild(doc.createElement('p'));
      status.setAttribute('data-qu-status', '');
      status.textContent = '';
      try {
        const title = topicForm.querySelector('[name="title"]').value.trim();
        const author = topicForm.querySelector('[name="author"]').value.trim();
        const body = topicForm.querySelector('[name="body"]').value;
        const route = await startTopic(space, prefix, { title, author, body });
        topicForm.reset();
        const win = doc.defaultView;
        if (win) {
          const currentHash = win.location.hash || '#/';
          win.location.hash = currentHash.replace(/\/$/, '') + route;
        }
      } catch (err) {
        status.textContent = `Fehler: ${err.message}`;
      }
    });
  }

  const replyForm = mountEl.querySelector('form[data-qu-action="forum-reply-form"]');
  if (replyForm) {
    const prefix = replyForm.getAttribute('data-qu-prefix');
    const topicId = replyForm.getAttribute('data-qu-topic');
    replyForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = replyForm.querySelector('[data-qu-status]') ?? replyForm.appendChild(doc.createElement('p'));
      status.setAttribute('data-qu-status', '');
      status.textContent = '';
      try {
        const author = replyForm.querySelector('[name="author"]').value.trim();
        const message = replyForm.querySelector('[name="message"]').value.trim();
        await reply(space, prefix, topicId, { author, message });
        replyForm.reset();
        status.textContent = 'Antwort gesendet und vom Relay bestätigt.';
      } catch (err) {
        status.textContent = `Fehler: ${err.message}`;
      }
    });
  }
}
