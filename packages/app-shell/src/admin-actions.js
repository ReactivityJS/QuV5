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
 *   - A "Besuchen" link (`#/<prefix>/`) on EVERY entry, main or global -
 *     visiting the bare prefix already works regardless of realm, this is
 *     just a discoverable shortcut instead of typing the URL by hand.
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
import { registerApp, setAppMode, platformAppsKind, PLATFORM_REGISTRY_ANCHOR } from '@qu/app-core';
import { deriveOwnerNodeId } from '@qu/space-core';
import { installGuestbook } from '../guestbook-bundle.js';
import { installBlog } from '../blog-bundle.js';
import { installForum } from '../forum-bundle.js';
import { verifyWritesAcked } from './verify-writes.js';

const MODE_LABELS = { off: 'Aus', global: 'Global', multiuser: 'Multi-User' };

/**
 * ONE-CLICK REFERENCE APP INSTALLERS — each entry pairs a bundle's own
 * `installX(space, {prefix})` (the same function an operator's install
 * script would otherwise call by hand) with the `sharedLists` a
 * `registerApp()` call for it must declare (`dev.js`'s own doc comment on
 * why: a `'members'`-ACL shared list's name has to be known to the relay
 * BEFORE any write to it can be classified, and these apps' shared lists
 * are only chosen here, at install time, under a relay-admin-picked
 * prefix). `label` doubles as the registered app's `name`.
 *
 * `realm: 'global'`, NOT the default `realm: 'main'` - the SAME identity
 * (whoever is currently signed in as a relay-admin, running this form) is
 * what would otherwise install EVERY one of these reference apps, and a
 * `realm: 'main'` app is content-addressed by (owner identity, kind, path)
 * alone - installing Gästebuch, Blog, AND Forum this way would derive the
 * EXACT SAME id for every one of their own index pages, each install
 * silently clobbering the last (a real, observed bug: all three prefixes
 * ending up showing whichever app's write happened to win). `realm:
 * 'global'` apps are anchored on their own PREFIX instead
 * (`globalAppAnchor()`, `guestbook-bundle.js`'s own top doc comment has the
 * full story) - collision-free by construction, no matter how many are
 * installed from the same session - and, as a bonus, they get the SAME
 * mode toggle (`MODE_LABELS` below) and "Verwalten"/"Besuchen" links every
 * other global app already has, for free.
 *
 * `personalBundle` (Gästebuch/Blog only, omitted for Forum - see
 * `installed-apps-actions.js`'s own `PERSONAL_INSTALLERS` doc comment on
 * why) tags this prefix so `boot.js`'s own ADDITIVE `/u/<ref>/` route
 * (alongside the global one, never instead of it) knows which reference
 * app's personal-instance installer to self-provision the first time a
 * visitor reaches `#/<prefix>/u/me/` - `dev.js`'s `registerApp()` own doc
 * comment on the field. Gästebuch's `sharedLists` here ALSO includes
 * `<prefix>:personal` upfront - `installPersonalGuestbook()`'s own doc
 * comment on why: unlike the global list (`prefix` itself), a per-visitor
 * personal guestbook's own list name can't be known until someone actually
 * self-provisions one, so ALL of them share this ONE, pre-registered list
 * instead, filtered per owner.
 */
const APP_INSTALLERS = {
  guestbook: {
    label: 'Gästebuch',
    install: installGuestbook,
    sharedLists: (prefix) => [prefix, `${prefix}:personal`],
    viewNames: (prefix) => [`${prefix}-feed`],
    personalBundle: 'guestbook',
  },
  blog: { label: 'Blog', install: installBlog, sharedLists: () => [], viewNames: (prefix) => [`${prefix}-index`], personalBundle: 'blog' },
  forum: {
    label: 'Forum',
    install: installForum,
    sharedLists: (prefix) => [`${prefix}:topics`, `${prefix}:replies`],
    viewNames: (prefix) => [`${prefix}-topics`],
  },
};

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

      // Direct link to the app itself, for EVERY entry, main or global - visiting the bare prefix
      // already works regardless of realm (`boot.js`'s own dispatch never special-cases either),
      // this was previously only ever reachable by typing the URL by hand.
      const visitLink = doc.createElement('a');
      visitLink.href = `#/${app.prefix}/`;
      visitLink.textContent = 'Besuchen';
      visitLink.style.marginRight = '0.5rem';
      li.appendChild(visitLink);

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

  for (const form of mountEl.querySelectorAll('form[data-qu-action="install-app"]')) {
    const appType = form.getAttribute('data-app-type');
    const installer = APP_INSTALLERS[appType];
    if (!installer) continue;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = form.querySelector('[data-qu-status]') ?? form.appendChild(doc.createElement('p'));
      status.setAttribute('data-qu-status', '');
      status.textContent = '';
      try {
        const prefix = form.querySelector('input[name="prefix"]').value.trim();
        // REGISTER FIRST, THEN INSTALL - never the other way round: the relay only classifies THIS
        // app's own `adminPage`/`adminView`/shared-list writes correctly (`'relay-admins'`/`'members'`
        // -ACL) once its live resolver has observed this `qu-platform-apps` entry
        // (`@qu/app-shell`'s `live-app-resolver.js`) - installing first would have every one of
        // `installer.install()`'s own writes silently misclassified against the generic
        // `pageKind`('content'-ACL, grant-only) fallback and rejected, exactly the same
        // "register/publish before seeding" ordering `bin/bootstrap-platform.mjs` already uses for
        // the built-in admin console/cms apps themselves.
        const platformId = await deriveOwnerNodeId(PLATFORM_REGISTRY_ANCHOR, platformAppsKind.kind);
        await verifyWritesAcked(mainSpace, platformId, () =>
          registerApp(mainSpace, {
            prefix,
            realm: 'global',
            name: installer.label,
            sharedLists: installer.sharedLists(prefix),
            globalViewNames: installer.viewNames(prefix),
            personalBundle: installer.personalBundle,
          })
        );
        await new Promise((resolve) => setTimeout(resolve, 400)); // let the relay's live resolver start watching this app's own route registry/shared lists/View names.
        await installer.install(mainSpace, { prefix });
        status.textContent = `${installer.label} installiert - erreichbar unter #/${prefix}/.`;
        form.reset();
        await renderList();
      } catch (err) {
        status.textContent = `Fehler: ${err.message}`;
      }
    });
  }

  renderList();
}
