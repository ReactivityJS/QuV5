/**
 * CHAT ACTIONS — the framework-provided interactivity `bundle.js`'s own
 * inert send-form attaches to, by CONVENTION - the SAME "content stays
 * inert markup" posture `@qu/app-shell`'s `guestbook-actions.js`/
 * `blog-actions.js`/`forum-actions.js` already use (see that package's own
 * `installed-apps-actions.js` doc comment on why a discovered `/apps/*`
 * app's `wire` function gets called exactly like those, every render,
 * everywhere - a correct, cheap no-op on any page that isn't its own).
 *
 * The target list's NAME comes off the form's own `data-qu-list` attribute
 * (baked in by `installChat()` at install time) rather than being
 * hardcoded here - this file has no idea which prefix it's running under,
 * by design, same as every other reference app's own actions file.
 */
import { pushToSharedList, sharedListAnchor, sharedListKind } from '@qu/app-core';
import { deriveOwnerNodeId } from '@qu/space-core';
// A NARROW subpath, deliberately NEVER `from '@qu/app-shell'` (the package root) - this file is
// itself part of the BROWSER bundle graph (reached via `wireInstalledApps()` -> `apps-registry.
// generated.js` -> here), and that root re-exports server/test-only code too (`boot.js`/
// `identity.js`/`live-app-resolver.js`, transitively pulling in Node-only `node:fs`/`node:path` -
// a REAL, observed esbuild failure: "Could not resolve 'node:fs/promises'" against a
// `platform: 'browser'` build). `shell.js` itself already follows this same rule for its own
// imports (narrow subpaths only, e.g. `@qu/space-transport/ws-client-transport`, never that
// package's own root either) - see `apps/README.md`'s own doc comment on this trap for any
// FUTURE `/apps/*` app's own code.
import { verifyWritesAcked } from '@qu/app-shell/verify-writes';

/** @param {{mountEl: Element, doc: Document, space: import('@qu/space-core').Space}} params */
export async function wireChat({ mountEl, doc, space }) {
  const form = mountEl.querySelector('form[data-qu-action="chat-form"]');
  if (!form) return;
  const listName = form.getAttribute('data-qu-list');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = form.querySelector('[data-qu-status]') ?? form.appendChild(doc.createElement('p'));
    status.setAttribute('data-qu-status', '');
    status.textContent = '';
    try {
      // "name"/"message" (not "author"/"text") - see bundle.js's own doc comment on why: the
      // 'shared-list' View source adapter's field-name convention, not this app's own choice.
      const name = form.querySelector('[name="name"]').value.trim();
      const message = form.querySelector('[name="message"]').value.trim();
      const id = await deriveOwnerNodeId(await sharedListAnchor(listName), sharedListKind.kind);
      await verifyWritesAcked(space, id, () => pushToSharedList(space, listName, { name, message, ts: Date.now() }));
      form.querySelector('[name="message"]').value = '';
      status.textContent = 'Gesendet und vom Relay bestätigt.';
    } catch (err) {
      status.textContent = `Fehler: ${err.message}`;
    }
  });
}
