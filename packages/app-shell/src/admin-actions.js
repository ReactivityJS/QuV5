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
 * Three conventions, all scoped to whatever `mountEl` currently holds after
 * `@qu/app-renderer`'s `renderPage()` ran for the built-in admin console's
 * own route (`prefix === 'admin'` - `boot.js`'s `startPlatform()` calls
 * `wireAdminConsole()` right after):
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
 *     re-rendered after every mode change (`renderList()` below, not just
 *     once at wiring time any more - a mode toggle needs to visibly reflect
 *     its own effect without a full page reload).
 *   - PER-APP CONTROLS, `realm: 'global'` entries only (kinds.js's own doc
 *     comment on the three administrable states - `mode` has no meaning for
 *     a `realm: 'main'` app, single-owner apps were never relay-toggleable
 *     at all): one button per state (`'off'`/`'global'`/`'multiuser'`,
 *     calling `setAppMode()`, the currently-active one shown disabled), a
 *     "Verwalten" link to that app's own GLOBAL shell
 *     (`#/admin/<prefix>/` - `boot.js`'s `parseAdminSubPath()`/
 *     `renderGlobalShell()` - this doubles as the generic "app's settings
 *     page" link the built-in console offers for ANY global app, not a
 *     bespoke per-app affordance: whatever that app's own global content
 *     happens to contain, incl. a `/cms`-style editor if it installed one,
 *     lives right there), and, for `mode: 'multiuser'` specifically, an
 *     "Eigener Bereich" shortcut to THIS relay-admin's own per-user space
 *     (`#/<prefix>/u/me/`) - a convenience only, not a different write path.
 *
 * WRITE-ACL, not this file, is what actually gates every write here:
 * `registerApp()`/`setAppMode()` both write `qu-platform-apps`, a
 * `'relay-admins'`-ACL Kind only an identity listed in the relay's own
 * `QU_RELAY_ADMINS` can sign for - a non-admin's attempt is silently
 * rejected by the relay exactly like any other unauthorized write in this
 * framework (see kinds.js's own doc comment) - though in practice a
 * non-admin never even sees this markup, `boot.js`'s own `renderAdminUnauthorized()`
 * gate keeps `#/admin/...` from rendering for them at all.
 */
import { QuCrypto } from '@qu/core';
import { registerApp, setAppMode } from '@qu/app-core';

const MODE_LABELS = { off: 'Aus', global: 'Global', multiuser: 'Multi-User' };

/** @param {{mountEl: Element, doc: Document, mainSpace: import('@qu/space-core').Space, platform: import('@qu/app-core').PlatformRuntime}} params */
export function wireAdminConsole({ mountEl, doc, mainSpace, platform }) {
  const list = mountEl.querySelector('[data-qu-bind="platform-apps-list"]');

  async function renderList() {
    if (!list) return;
    const apps = await platform.resolveApps({ timeout: 500 });
    list.replaceChildren();
    if (apps.length === 0) {
      const li = doc.createElement('li');
      li.textContent = '(noch keine App registriert)';
      list.appendChild(li);
      return;
    }
    for (const app of apps) {
      const isGlobal = (app.realm ?? 'main') === 'global';
      const li = doc.createElement('li');
      const info = doc.createElement('span');
      const owner = isGlobal ? `Global (${MODE_LABELS[app.mode ?? 'global']})` : `${QuCrypto.toBase64(app.appAdminPub).slice(0, 20)}…`;
      info.textContent = `#/${app.prefix} — ${app.name ?? '(unbenannt)'} (${owner}) `;
      li.appendChild(info);

      if (isGlobal) {
        const manageLink = doc.createElement('a');
        manageLink.href = `#/admin/${app.prefix}/`;
        manageLink.textContent = 'Verwalten';
        manageLink.style.marginRight = '0.5rem';
        li.appendChild(manageLink);

        if (app.mode === 'multiuser') {
          const ownLink = doc.createElement('a');
          ownLink.href = `#/${app.prefix}/u/me/`;
          ownLink.textContent = 'Eigener Bereich';
          ownLink.style.marginRight = '0.5rem';
          li.appendChild(ownLink);
        }

        const status = doc.createElement('span');
        status.setAttribute('data-qu-status', '');

        for (const mode of ['off', 'global', 'multiuser']) {
          const btn = doc.createElement('button');
          btn.type = 'button';
          btn.textContent = MODE_LABELS[mode];
          btn.disabled = (app.mode ?? 'global') === mode;
          btn.style.marginRight = '0.25rem';
          btn.addEventListener('click', async () => {
            status.textContent = '';
            try {
              await setAppMode(mainSpace, { prefix: app.prefix, mode });
              await renderList();
            } catch (err) {
              status.textContent = `Fehler: ${err.message}`;
            }
          });
          li.appendChild(btn);
        }
        li.appendChild(status);
      }
      list.appendChild(li);
    }
  }

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
        status.textContent = 'Gesendet. Falls du der Relay-Admin bist, ist die App jetzt registriert.';
        await renderList();
      } catch (err) {
        status.textContent = `Fehler: ${err.message}`;
      }
    });
  }

  renderList();
}
