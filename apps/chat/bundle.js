/**
 * THE CHAT APP, AS A PLAIN BUNDLE — the FIRST genuinely file-based app
 * (repo root's own `apps/README.md` doc comment on the dividing line: this
 * one can't yet be reduced to a Template + `qu-list`/`qu-view` data source
 * alone, not because ITS OWN v1 content here is complex - it deliberately
 * isn't - but because the planned direction (location-sharing, reactions,
 * an "Action-Slots" extension point other apps register into - see the
 * project's own architecture notes) needs real per-message behavior no
 * generic CMS module offers yet).
 *
 * v1 IS, on purpose, structurally almost identical to `packages/app-shell`'s
 * own `guestbook-bundle.js` (`realm: 'global'`, one shared list, one live
 * View) - proving the `/apps/*` discovery mechanism end-to-end with a real,
 * useful app came first; the message-list/View plumbing underneath is
 * exactly the same "just Kinds + a shared list" story either way. What's
 * DIFFERENT, and the reason this lives here instead of next to Gästebuch:
 * a chat message is the thing everything else (reactions, a shared
 * location, a read receipt, ...) will eventually need to attach BEHAVIOR
 * to per-message, in-page, without a page reload - real code, not a
 * bigger CMS Template.
 */
import { createGlobalPage, publishGlobalRoute, createGlobalView } from '@qu/app-core';
import { upsertGlobalPage, upsertGlobalView } from '@qu/app-shell/bundle-upsert';

export const CHAT_VERSION = 1;

const ITEM_TEMPLATE = '<p><strong><qu-slot name="title"></qu-slot>:</strong> <qu-slot name="excerpt"></qu-slot></p>';

function pageFields(prefix) {
  return {
    route: '/',
    title: 'Chat',
    content: `<h1>Chat</h1>
<div data-qu-view="${prefix}-feed" data-qu-chat-feed></div>
<form data-qu-action="chat-form" data-qu-list="${prefix}">
  <!-- Field names "name"/"message" (not "author"/"text") are the 'shared-list' View source
       adapter's own fixed convention (@qu/app-core's view-sources.js: normalize()'s "name ->
       title, message -> excerpt" mapping is a hardcoded field-name contract, not app-specific -
       a chat message's "sender"/"text" is exactly what that adapter's own doc comment names as
       one of the shapes "name"/"message" are meant to stand in for). actions.js pushes under
       these SAME keys. -->
  <label>Name: <input name="name" required></label><br>
  <label>Nachricht: <input name="message" required></label>
  <button type="submit">Senden</button>
  <p data-qu-status></p>
</form>`,
  };
}

function viewFields(prefix) {
  return {
    name: `${prefix}-feed`,
    sources: [{ type: 'shared-list', name: prefix }],
    sortBy: 'timestamp',
    sortOrder: 'asc', // oldest first - a chat log reads top-to-bottom, unlike Gästebuch's "newest first" feed.
    itemTemplate: ITEM_TEMPLATE,
  };
}

/** @param {import('@qu/space-core').Space} space @param {{prefix: string}} params */
export async function installChat(space, { prefix }) {
  await publishGlobalRoute(space, prefix, { route: '/', title: 'Chat' });
  await new Promise((resolve) => setTimeout(resolve, 400));
  await createGlobalPage(space, prefix, pageFields(prefix));
  await createGlobalView(space, prefix, viewFields(prefix));
}

/**
 * Re-applies this bundle's own content in place - see `guestbook-bundle.js`'s
 * `updateGuestbook()` own doc comment for the full "why upsert, why never
 * routed through installX()" reasoning, identical here. Never touches any
 * already-sent message (those live in the shared list, untouched by this -
 * only the page/View DEFINITIONS this bundle itself owns).
 */
export async function updateChat(space, { prefix }) {
  await publishGlobalRoute(space, prefix, { route: '/', title: 'Chat' });
  await upsertGlobalPage(space, prefix, pageFields(prefix));
  await upsertGlobalView(space, prefix, viewFields(prefix));
}
