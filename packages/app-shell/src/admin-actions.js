/**
 * ADMIN ACTIONS — the one piece of FRAMEWORK-provided interactivity the
 * built-in admin console's own Qu content (the `qu-admin-*` bundle
 * installed by `bin/install-admin-console.mjs`, see this package's own
 * README) attaches to, by CONVENTION, never by embedding a `<script>`
 * (Stufe 1 of the security model, docs §17-18 - `@qu/app-renderer`'s
 * `sanitizeHtml()` strips those unconditionally, and rightly so - signed
 * Executable Modules, Stufe 3, remain future work). This mirrors
 * `@qu/space-ui`'s own `bindField()`/`bindCheckbox()` pattern exactly:
 * framework code wires ordinary DOM elements a content author declared by
 * ATTRIBUTE, the content itself stays inert markup.
 *
 * Two conventions, both scoped to whatever `mountEl` currently holds after
 * `@qu/app-renderer`'s `renderPage()` ran for a `realm: 'admin'` route
 * (`boot.js`'s `startPlatform()` calls `wireAdminConsole()` right after):
 *
 *   - `<form data-qu-action="register-app">` with `name="prefix"`/
 *     `name="appAdminPub"`/`name="name"` inputs - submitting it calls
 *     `registerApp()` (`@qu/app-core`'s Dev API) against the (one and only)
 *     main Space, which is also where this console's own content lives now
 *     (see `kinds.js`'s own `platformAppsKind`/"THE ADMIN APP" doc
 *     comments - neither an alias's mere EXISTENCE nor this console's own
 *     markup was ever confidential, only WRITE-access is restricted).
 *   - `[data-qu-bind="platform-apps-list"]` - populated with one `<li>`
 *     per currently registered app/alias (via `PlatformRuntime.resolveApps()`),
 *     refreshed once, at wiring time - not live-reactive yet (a real nav
 *     Reload gets you an up-to-date list; live-binding this the way
 *     `@qu/space-ui`'s `bindList()` does is a reasonable future upgrade,
 *     not attempted here to keep this file's one job small).
 *
 * WRITE-ACL, not this file, is what actually gates the registration
 * write: `registerApp()` writes `qu-platform-apps`, a `'relay-admins'`-ACL
 * Kind only an identity listed in the relay's own `QU_RELAY_ADMINS` can
 * sign for - a non-admin's submit attempt is silently rejected by the
 * relay exactly like any other unauthorized write in this framework (see
 * kinds.js's own doc comment).
 */
import { QuCrypto } from '@qu/core';
import { registerApp } from '@qu/app-core';

/** @param {{mountEl: Element, doc: Document, mainSpace: import('@qu/space-core').Space, platform: import('@qu/app-core').PlatformRuntime}} params */
export function wireAdminConsole({ mountEl, doc, mainSpace, platform }) {
  const form = mountEl.querySelector('form[data-qu-action="register-app"]');
  if (form) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = form.querySelector('[data-qu-status]') ?? form.appendChild(doc.createElement('p'));
      status.setAttribute('data-qu-status', '');
      status.textContent = '';
      try {
        const prefix = form.querySelector('input[name="prefix"]').value.trim();
        const rawPub = form.querySelector('input[name="appAdminPub"]').value.trim();
        const name = form.querySelector('input[name="name"]').value.trim();
        const appAdminPub = QuCrypto.fromBase64(rawPub);
        await registerApp(mainSpace, { prefix, appAdminPub, name });
        status.textContent = 'Gesendet. Falls du der Relay-Admin bist, ist die App jetzt registriert - Seite neu laden, um die Liste zu aktualisieren.';
      } catch (err) {
        status.textContent = `Fehler: ${err.message}`;
      }
    });
  }

  const list = mountEl.querySelector('[data-qu-bind="platform-apps-list"]');
  if (list) {
    platform.resolveApps({ timeout: 500 }).then((apps) => {
      list.replaceChildren();
      if (apps.length === 0) {
        const li = doc.createElement('li');
        li.textContent = '(noch keine App registriert)';
        list.appendChild(li);
        return;
      }
      for (const app of apps) {
        const li = doc.createElement('li');
        const owner = app.realm === 'admin' ? 'Admin' : `${QuCrypto.toBase64(app.appAdminPub).slice(0, 20)}…`;
        li.textContent = `#/${app.prefix} — ${app.name ?? '(unbenannt)'} (${owner})`;
        list.appendChild(li);
      }
    });
  }
}
