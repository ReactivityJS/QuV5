/**
 * THE CHAT APP, AS A PLAIN BUNDLE — v2, the real Messenger (Signal/
 * WhatsApp/Telegram-style: 1:1 + group chats, delivery/read ticks, typing,
 * online status, a real conversation list). v1 (kept in git history) was a
 * deliberately throwaway, fully PUBLIC, unencrypted, single-channel demo
 * proving the `/apps/*` discovery mechanism alone - this is a structural
 * replacement, not an incremental update (hence `CHAT_VERSION` resets the
 * "Update verfügbar" story: an already-installed v1 instance upgrades to
 * this exact same way any other bundle version bump works, see
 * `updateChat()` below).
 *
 * UNLIKE Gästebuch/Blog/Forum, this app's own actual content is NEVER a CMS
 * Page: every real conversation is a private, per-identity `qu-chat` Node
 * (`@qu/app-core`'s `messenger.js`), addressed by `{groupOwnerPub,
 * groupName}`, never by a route this relay-admin's own global Page registry
 * could ever enumerate (`apps/README.md`'s own dividing line: this is
 * exactly the "needs real behavior, not a Template + data source" case).
 * What THIS bundle installs is purely the static CHROME every visitor sees
 * regardless of which conversation (if any) they have open - a sidebar +
 * main-area shell, as this app's own global root TEMPLATE (`chat-shell`),
 * not a Page. A Template, unlike a Page, is NEVER route-specific
 * (`AppRuntime.resolveRoute()`'s own doc comment: a Page's `template` falls
 * back to the Manifest's `rootTemplate` whenever no Page matches the
 * current route at all) - so this SAME chrome renders for every one of this
 * app's own code-driven `subPath`s (`#/<prefix>/`, `#/<prefix>/room/<id>`,
 * ...), none of which this bundle ever registers as a Page. `actions.js`'s
 * own `wireChat()` is what actually fills `[data-qu-chat-main]` per
 * `subPath`, reactively, no reload. See `apps/README.md`'s own
 * `templateNames` doc comment on why a `/apps/*` app needs to declare this
 * upfront at all (a real, previously-missing gap this app is the first to
 * need closed).
 */
import { createGlobalApp, publishGlobalRoute, ContentResolver, globalAppAnchor, adminAppManifestKind, adminPageKind, adminTemplateKind, adminStyleKind, adminRouteRegistryKind, adminViewKind } from '@qu/app-core';
import { upsertGlobalTemplate } from '@qu/app-shell/bundle-upsert';

export const CHAT_VERSION = 2;

export const CHAT_TEMPLATE_NAME = 'chat-shell';

const GLOBAL_KINDS = {
  appManifestKind: adminAppManifestKind,
  pageKind: adminPageKind,
  templateKind: adminTemplateKind,
  styleKind: adminStyleKind,
  routeRegistryKind: adminRouteRegistryKind,
  viewKind: adminViewKind,
};

const SHELL_HTML = `<div data-qu-chat-app>
  <aside data-qu-chat-sidebar>
    <div data-qu-chat-sidebar-header>
      <strong>Chats</strong>
      <button type="button" data-qu-chat-new-toggle>+ Neu</button>
    </div>
    <div data-qu-chat-new-panel hidden>
      <p><strong>Kontakt hinzufügen</strong></p>
      <input type="text" data-qu-chat-contact-pub placeholder="Pubkey (base64)">
      <input type="text" data-qu-chat-contact-alias placeholder="Name (optional)">
      <button type="button" data-qu-chat-contact-add>Hinzufügen</button>
      <p><strong>Kontakte</strong></p>
      <ul data-qu-chat-contacts></ul>
      <p><strong>Neue Gruppe</strong></p>
      <input type="text" data-qu-chat-group-name placeholder="Gruppenname">
      <div data-qu-chat-group-members></div>
      <button type="button" data-qu-chat-group-create>Gruppe erstellen</button>
      <p data-qu-chat-new-status></p>
    </div>
    <ul data-qu-chat-conversations></ul>
  </aside>
  <main data-qu-chat-main>
    <p data-qu-chat-empty>Wähle links eine Unterhaltung oder starte eine neue.</p>
  </main>
</div>`;

/**
 * Creates this app's own global Manifest (`rootTemplate: CHAT_TEMPLATE_NAME`)
 * only if it doesn't already exist - `createGlobalApp()` must never be
 * called twice for the same id (`bundle-upsert.js`'s own top doc comment:
 * a second `createNode()` silently clobbers the first's local Y.Doc), and
 * there is nothing here worth EDITING once created (the Manifest's own
 * fields never change across `CHAT_VERSION` bumps, only the Template's
 * CONTENT does - `updateChat()` below upserts that separately).
 */
async function ensureGlobalApp(space, prefix) {
  const resolver = new ContentResolver(space, { appAdminPub: await globalAppAnchor(prefix), kinds: GLOBAL_KINDS });
  const existing = await resolver.resolveManifest({ timeout: 800 });
  if (existing) return;
  await createGlobalApp(space, prefix, { name: 'Chat', rootTemplate: CHAT_TEMPLATE_NAME });
}

/** @param {import('@qu/space-core').Space} space @param {{prefix: string}} params */
export async function installChat(space, { prefix }) {
  await publishGlobalRoute(space, prefix, { route: '/', title: 'Chat' });
  await new Promise((resolve) => setTimeout(resolve, 400));
  await ensureGlobalApp(space, prefix);
  await upsertGlobalTemplate(space, prefix, { name: CHAT_TEMPLATE_NAME, html: SHELL_HTML });
}

/** Re-applies this bundle's own shipped CHROME in place - see `bundle-upsert.js`'s own doc comment. Never touches any real conversation (those are private `qu-chat` Nodes this app's registration never had write access to at all). */
export async function updateChat(space, { prefix }) {
  await publishGlobalRoute(space, prefix, { route: '/', title: 'Chat' });
  await ensureGlobalApp(space, prefix);
  await upsertGlobalTemplate(space, prefix, { name: CHAT_TEMPLATE_NAME, html: SHELL_HTML });
}
