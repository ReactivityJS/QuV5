/**
 * FORUM ACTIONS — the framework-provided interactivity `forum-bundle.js`'s
 * own inert "start a topic" form (plus its own, single "topic detail"
 * section, ALWAYS present but `hidden` until a topic is opened) attaches
 * to. Same "content stays inert markup, this file adds the behavior"
 * posture as `guestbook-actions.js`/`blog-actions.js`.
 *
 * NO SEPARATE ROUTE PER TOPIC — `forum-bundle.js`'s own top doc comment has
 * the full "why": a topic/reply is `'members'`-ACL shared-list data (any
 * Space member may write it), never a `qu-page`/`qu-admin-page` (owner- or
 * relay-admin-only). Opening a topic is therefore CLIENT-SIDE state, not
 * navigation: clicking a topic in the live `${prefix}-topics` View
 * (`@qu/app-shell`'s `view-actions.js` renders it, its `renderItem()` own
 * doc comment on why `[data-qu-view-link]` elements carry the RAW item's
 * own scalar fields - here, `topicId` - as `data-*` attributes even though
 * there is no real `route` to link to) fills in and un-hides
 * `forum-bundle.js`'s own `[data-qu-forum-detail]` section with that
 * topic's own title/author/body (read via a one-shot
 * `resolveSharedList()`) and opens a LIVE, filtered view over
 * `${prefix}:replies` (`openLiveView()`'s own `filter` param -
 * `view-sources.js`'s `'shared-list'` adapter doc comment: one shared
 * `${prefix}:replies` list serves every topic, distinguished per-topic
 * only by each entry's own `topicId`) bound into that section's own
 * `<ul>` via `@qu/space-ui`'s `bindList()`, the exact same primitive
 * `view-actions.js` itself uses. "Zurück" (or opening a DIFFERENT topic)
 * closes that live view before opening the next one/going back - the same
 * "never leak a subscription across a switch" posture `view-actions.js`'s
 * own `openViewsByMountEl` bookkeeping already established.
 *
 * The topic body is free-form text from a plain `<textarea>`, written by
 * ANY Space member (`'members'`-ACL, no different from a guestbook entry's
 * own message) - rendered through `sanitizeHtml()` before ever reaching
 * the DOM, same Stufe-1 posture `view-actions.js`'s own `renderItem()`
 * already applies to every OTHER View item's `title`/`excerpt`.
 */
import { pushToSharedList, ContentResolver, openLiveView, sharedListAnchor, sharedListKind } from '@qu/app-core';
import { deriveOwnerNodeId } from '@qu/space-core';
import { sanitizeHtml } from '@qu/app-renderer';
import { bindList } from '@qu/space-ui';
import { verifyWritesAcked } from './verify-writes.js';

/** @param {{mountEl: Element, doc: Document, space: import('@qu/space-core').Space}} params */
export function wireForum({ mountEl, doc, space }) {
  const topicForm = mountEl.querySelector('form[data-qu-action="forum-topic-form"]');
  const detail = mountEl.querySelector('[data-qu-forum-detail]');
  const list = mountEl.querySelector('[data-qu-forum-list]');
  if (!topicForm || !detail || !list) return;
  const prefix = topicForm.getAttribute('data-qu-prefix');
  const replyForm = detail.querySelector('form[data-qu-action="forum-reply-form"]');
  const backBtn = detail.querySelector('[data-qu-action="forum-back"]');
  const resolver = new ContentResolver(space, {});

  let closeReplies = null;
  let currentTopicId = null;

  function showList() {
    closeReplies?.();
    closeReplies = null;
    currentTopicId = null;
    detail.hidden = true;
    topicForm.hidden = false;
    list.hidden = false;
  }

  async function showTopic(topicId) {
    const topics = await resolver.resolveSharedList(`${prefix}:topics`, { timeout: 2000 });
    const topic = topics.find((t) => t?.topicId === topicId);
    if (!topic) return;

    closeReplies?.();
    currentTopicId = topicId;

    detail.querySelector('[data-qu-forum-title]').textContent = topic.name ?? '';
    detail.querySelector('[data-qu-forum-byline]').textContent = topic.message ?? '';
    detail.querySelector('[data-qu-forum-body]').innerHTML = sanitizeHtml(topic.body ?? '', doc);

    const repliesEl = detail.querySelector('[data-qu-forum-replies]');
    repliesEl.replaceChildren();
    const view = await openLiveView(space, {
      sources: [{ type: 'shared-list', name: `${prefix}:replies`, filter: { topicId } }],
      sortBy: 'timestamp',
      sortOrder: 'asc',
    });
    const stopBinding = bindList(repliesEl, view, {
      key: (item, i) => `${i}:${item.timestamp}`,
      render: (item) => {
        const li = doc.createElement('li');
        const strong = doc.createElement('strong');
        strong.textContent = `${item.title}: `;
        li.appendChild(strong);
        li.appendChild(doc.createTextNode(item.excerpt ?? ''));
        return li;
      },
    });
    closeReplies = () => {
      stopBinding();
      view.close();
    };

    topicForm.hidden = true;
    list.hidden = true;
    detail.hidden = false;
  }

  list.addEventListener('click', (event) => {
    const link = event.target.closest('[data-qu-view-link]');
    if (!link || !list.contains(link)) return;
    event.preventDefault();
    const topicId = link.dataset.topicId;
    if (topicId) showTopic(topicId);
  });

  backBtn?.addEventListener('click', showList);

  topicForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = topicForm.querySelector('[data-qu-status]') ?? topicForm.appendChild(doc.createElement('p'));
    status.setAttribute('data-qu-status', '');
    status.textContent = '';
    try {
      const title = topicForm.querySelector('[name="title"]').value.trim();
      const author = topicForm.querySelector('[name="author"]').value.trim();
      const body = topicForm.querySelector('[name="body"]').value;
      const topicId = crypto.randomUUID();
      const topicsId = await deriveOwnerNodeId(await sharedListAnchor(`${prefix}:topics`), sharedListKind.kind);
      await verifyWritesAcked(space, topicsId, () =>
        pushToSharedList(space, `${prefix}:topics`, { name: title, message: `von ${author}`, ts: Date.now(), topicId, body })
      );
      topicForm.reset();
      status.textContent = 'Thema erstellt und vom Relay bestätigt.';
    } catch (err) {
      status.textContent = `Fehler: ${err.message}`;
    }
  });

  if (replyForm) {
    replyForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = replyForm.querySelector('[data-qu-status]') ?? replyForm.appendChild(doc.createElement('p'));
      status.setAttribute('data-qu-status', '');
      status.textContent = '';
      try {
        const author = replyForm.querySelector('[name="author"]').value.trim();
        const message = replyForm.querySelector('[name="message"]').value.trim();
        const repliesId = await deriveOwnerNodeId(await sharedListAnchor(`${prefix}:replies`), sharedListKind.kind);
        await verifyWritesAcked(space, repliesId, () =>
          pushToSharedList(space, `${prefix}:replies`, { name: author, message, ts: Date.now(), topicId: currentTopicId })
        );
        replyForm.reset();
        status.textContent = 'Antwort gesendet und vom Relay bestätigt.';
      } catch (err) {
        status.textContent = `Fehler: ${err.message}`;
      }
    });
  }
}
