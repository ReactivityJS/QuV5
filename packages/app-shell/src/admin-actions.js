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
 *     its own effect without a full page reload) - via `@qu/space-ui`'s
 *     `bindList()`, this file's own "EAT YOUR OWN DOG FOOD" doc comment
 *     below on why.
 *   - A "Besuchen" link (`#/<prefix>/`) on EVERY entry, main or global -
 *     visiting the bare prefix already works regardless of realm, this is
 *     just a discoverable shortcut instead of typing the URL by hand.
 *   - PER-APP CONTROLS, `realm: 'global'` entries only (kinds.js's own doc
 *     comment on the four administrable states - `mode` has no meaning for
 *     a `realm: 'main'` app, single-owner apps were never relay-toggleable
 *     at all): one button per state (`'off'`/`'global'`/`'multiuser'`/
 *     `'personal'`, calling `setAppMode()`, the currently-active one shown
 *     disabled), a "Verwalten" link to that app's own GLOBAL shell
 *     (`#/admin/<prefix>/` - `boot.js`'s `parseAdminSubPath()`/
 *     `renderGlobalShell()` - this doubles as the generic "app's settings
 *     page" link the built-in console offers for ANY global app, not a
 *     bespoke per-app affordance: whatever that app's own global content
 *     happens to contain, incl. a `/cms`-style editor if it installed one,
 *     lives right there), and, for `mode: 'multiuser'`/`'personal'`, an
 *     "Eigener Bereich" shortcut to THIS relay-admin's own per-user space
 *     (`#/<prefix>/u/me/`) - a convenience only, not a different write path.
 *     Also an "Update verfügbar" button (only for a prefix installed from
 *     this console's own `APP_INSTALLERS`, and only once its bundle's
 *     current version has actually moved past what's installed) and a
 *     "Deinstallieren" button (`unregisterApp()` + best-effort
 *     `nullGlobalAppContent()` - `dev.js`'s own doc comments on both, and on
 *     why a visitor's own personal instance is never reachable by either).
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
import { registerApp, setAppMode, setAppBundleVersion, setAppConfig, addSharedLists, addGlobalTemplateNames, unregisterApp, nullGlobalAppContent, platformAppsKind, PLATFORM_REGISTRY_ANCHOR } from '@qu/app-core';
import { deriveOwnerNodeId } from '@qu/space-core';
import { installGuestbook, updateGuestbook, GUESTBOOK_VERSION } from '../guestbook-bundle.js';
import { installBlog, updateBlog, BLOG_VERSION } from '../blog-bundle.js';
import { installForum } from '../forum-bundle.js';
import { installGlobalCms, cmsBundle } from '../cms-bundle.js';
import { verifyWritesAcked } from './verify-writes.js';
import { discoveredApps } from '../apps-registry.generated.js';
import { setFormStatus } from './form-status.js';
import { bindList } from '@qu/space-ui';

// `'personal'` (kinds.js's own `platformAppsKind` doc comment) - a read-only, aggregated feed at
// the bare prefix instead of a relay-admin-authored page, for an app whose personal instances
// already ARE the point (Gästebuch, Blog) rather than a per-visitor SITE (`'multiuser'`, unchanged).
const MODE_LABELS = { off: 'Aus', global: 'Global', multiuser: 'Multi-User', personal: 'Nur Persönlich' };

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
 * instead, filtered per owner. Gästebuch's `viewNames` ALSO includes
 * `<prefix>-aggregate-feed` - `guestbook-bundle.js`'s `updateGuestbook()`'s
 * own doc comment on why `mode: 'personal'` needs it - a View the relay
 * must be told about upfront exactly like any other (`globalViewNames`'s
 * own doc comment in `dev.js`).
 *
 * `key` (this map's own key, e.g. `'guestbook'`) is ALSO stored as this
 * prefix's `appType` at registration time - the admin console's own way of
 * later finding this SAME entry again for an already-registered app (the
 * "Update verfügbar" button below), without the registry itself needing to
 * know anything about specific reference apps.
 *
 * `version`/`update` - this bundle's own CURRENT version constant and its
 * idempotent re-apply function (`guestbook-bundle.js`/`blog-bundle.js`'s
 * own `updateX()` doc comments - upsert-based, safe to call on an already-
 * installed prefix). Compared against a registered entry's own stored
 * `bundleVersion` to decide whether "Update verfügbar" shows at all.
 */
const APP_INSTALLERS = {
  guestbook: {
    label: 'Gästebuch',
    install: installGuestbook,
    update: updateGuestbook,
    version: GUESTBOOK_VERSION,
    sharedLists: (prefix) => [prefix, `${prefix}:personal`],
    viewNames: (prefix) => [`${prefix}-feed`, `${prefix}-aggregate-feed`],
    personalBundle: 'guestbook',
  },
  blog: {
    label: 'Blog',
    install: installBlog,
    update: updateBlog,
    version: BLOG_VERSION,
    sharedLists: (prefix) => [`${prefix}:personal`],
    viewNames: (prefix) => [`${prefix}-index`, `${prefix}-aggregate-feed`],
    personalBundle: 'blog',
  },
  forum: {
    label: 'Forum',
    install: installForum,
    sharedLists: (prefix) => [`${prefix}:topics`, `${prefix}:replies`],
    viewNames: (prefix) => [`${prefix}-topics`],
  },
};

/**
 * `APP_INSTALLERS[appType]` above, extended with every FILE-BASED `/apps/*`
 * app `apps-registry.generated.js` discovered at build time (repo root's
 * own `apps/README.md` - the SAME descriptor shape, `key` standing in for
 * this map's own property name). A discovered app with a `key` that
 * collides with a hardcoded one above loses - `/apps/*` is for apps that
 * genuinely need files, never a way to override one of the three reference
 * apps that don't.
 */
function resolveInstaller(appType) {
  if (APP_INSTALLERS[appType]) return APP_INSTALLERS[appType];
  return discoveredApps.find((app) => app.key === appType) ?? null;
}

/**
 * `mode`s a currently-registered `realm: 'global'` app CANNOT usefully
 * switch to, so the mode-toggle button below can be disabled instead of
 * leading to a silently broken state (a real, reported case: Blog switched
 * to `'multiuser'` 404s its own previously-reachable content) - both checks
 * are DATA-DRIVEN off information already known, never a hardcoded
 * per-prefix list, so they apply to any app shaped the same way, not just
 * the one that was reported:
 *   - `'multiuser'` - disabled whenever `app.personalBundle` is set (stored
 *     on the registry entry itself by `registerApp()`, `dev.js`'s own doc
 *     comment). `mode: 'multiuser'` (`boot.js`'s own dispatch doc comment)
 *     flips the bare prefix to mean "my own space" but NEVER provisions
 *     this app's own `personalBundle` there - only the generic "Mein
 *     Bereich" CMS starter, silently ignoring whatever app-specific
 *     personal content this app's own installer actually builds
 *     (`installPersonalBlog()`/`installPersonalGuestbook()`) - this used to
 *     be reachable and simply wrong, not a framework bug (the CMS starter
 *     IS what `'multiuser'` is documented to mean, kinds.js's own
 *     `platformAppsKind` doc comment - just never the right choice for an
 *     app that already has its own personal content shape).
 *   - `'personal'` - disabled when this app's OWN installer (`app.appType`
 *     -> `resolveInstaller()`) is KNOWN and its `viewNames()` do NOT
 *     include an aggregate/personal-feed-named View (`APP_INSTALLERS`' own
 *     entries above - both Guestbook's `${prefix}-aggregate-feed` and
 *     Blog's now build one) - `mode: 'personal'` renders a read-only feed
 *     at exactly that well-known name (`boot.js`'s `renderAggregateShell()`),
 *     so an app that never creates it gets a permanently empty feed. An app
 *     with NO known installer (a bare `registerApp()`, no `appType` match)
 *     is left unrestricted here - nothing to check it against, same
 *     "anything goes" behavior as before this function existed.
 * @param {{personalBundle?: string, appType?: string, prefix: string}} app
 * @returns {Set<'multiuser'|'personal'>}
 */
function unsupportedModes(app) {
  const unsupported = new Set();
  if (app.personalBundle) unsupported.add('multiuser');
  const viewNames = resolveInstaller(app.appType)?.viewNames?.(app.prefix);
  if (viewNames && !viewNames.some((name) => name.endsWith('-aggregate-feed') || name.endsWith('-personal-feed'))) {
    unsupported.add('personal');
  }
  return unsupported;
}

/** @param {{mountEl: Element, doc: Document, mainSpace: import('@qu/space-core').Space, platform: import('@qu/app-core').PlatformRuntime}} params */
export function wireAdminConsole({ mountEl, doc, mainSpace, platform }) {
  const list = mountEl.querySelector('[data-qu-bind="platform-apps-list"]');
  const emptyState = mountEl.querySelector('[data-qu-empty-apps]');

  /**
   * Builds ONE app row's DOM - `bindList()`'s own `render(item)` callback
   * (below), called once per NEW or CHANGED app, never on every recompute
   * for every row the way the old hand-rolled "wipe the whole `<ul>` and
   * rebuild it" version of this function used to (see this file's own
   * "EAT YOUR OWN DOG FOOD" note below) - same content/behavior as before,
   * just no longer torn down and rebuilt for rows that didn't change.
   */
  function renderAppRow(app) {
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

      // `'multiuser'` - the bare prefix ITSELF already means "my own space" (this link is then
      // purely a convenience, identical to just clicking "Besuchen" above). `'personal'` - the
      // bare prefix shows the read-only aggregate feed instead, so THIS is the only link that
      // reaches this identity's own write-side instance at all.
      if (app.mode === 'multiuser' || app.mode === 'personal') {
        const ownLink = doc.createElement('a');
        ownLink.href = `#/${app.prefix}/u/me/`;
        ownLink.textContent = 'Eigener Bereich';
        ownLink.style.marginRight = '0.5rem';
        li.appendChild(ownLink);
      }

      const status = doc.createElement('span');
      status.setAttribute('data-qu-status', '');

      // "Views/Seiten (CMS)" - self-provisions (idempotent, `cms-bundle.js`'s own
      // `installGlobalCms()` doc comment: "re-running is harmless") this app's OWN
      // Templates/Styles/Pages/VIEWS editor at `#/admin/<prefix>/cms`
      // (`parseAdminSubPath()`/`renderGlobalShell()`'s existing delegation - already wired,
      // nothing new there) if it doesn't exist yet, then navigates there. THE POINT: any
      // `realm: 'global'` app - including one with no bundle.js at all, just a bare
      // `registerApp()` - gets a full Page+View authoring UI this way, `createGlobalView()`'s
      // own `route`/`template` params already connecting a path to a live, generated feed
      // (`docs/example-apps.md`'s own "Gästebuch nachbauen, nur per UI" walkthrough has the
      // full worked example, including the "form above/below the list" case: create the View
      // WITH a route first, THEN edit the auto-created wrapper page's own content afterward to
      // wrap the `<div data-qu-view>` in whatever surrounding markup is wanted - there is no
      // separate "header/footer" field, the wrapper page IS ordinary, freely editable content).
      // Optional - a shared-list name to ADD to this app's own registration before opening the
      // CMS editor (`dev.js`'s `addSharedLists()` own doc comment on why this exists at all: a
      // Gästebuch-style "many visitors contribute" View, built ENTIRELY through that editor's own
      // View form, needs its list's name registered SOMEWHERE first - there is no `bundle.js`
      // install step to have done that for an app created this way). Leave blank for a Page-
      // sourced View (single-author content) - those need no shared list at all.
      const sharedListInput = doc.createElement('input');
      sharedListInput.placeholder = 'neue shared-list (optional)';
      sharedListInput.style.marginRight = '0.25rem';
      li.appendChild(sharedListInput);

      const cmsBtn = doc.createElement('button');
      cmsBtn.type = 'button';
      cmsBtn.textContent = 'Views/Seiten (CMS)';
      cmsBtn.style.marginRight = '0.25rem';
      cmsBtn.addEventListener('click', async () => {
        status.textContent = '';
        try {
          const newList = sharedListInput.value.trim();
          if (newList) {
            await addSharedLists(mainSpace, { prefix: app.prefix, sharedLists: [newList] });
            await new Promise((resolve) => setTimeout(resolve, 400)); // settle - the live resolver needs a moment to start watching this new name before anything writes to it.
            sharedListInput.value = '';
          }
          // ALWAYS declare "__cms__" (cmsBundle.template.name) here, unconditionally - a REAL,
          // previously-shipped bug this fixes: unlike the built-in admin console's own hardcoded
          // "main" template, installGlobalCms()'s own template write below was silently REJECTED
          // for any OTHER prefix (kinds.js's own platformAppsKind doc comment on why) until the
          // relay was told to expect this exact name for THIS prefix - addGlobalTemplateNames()
          // dedupes, so re-clicking this button for an app that already declared it is a no-op.
          await addGlobalTemplateNames(mainSpace, { prefix: app.prefix, globalTemplateNames: [cmsBundle.template.name] });
          await new Promise((resolve) => setTimeout(resolve, 400)); // settle - same reasoning as addSharedLists() above.
          // installGlobalCms() itself now publishes EVERY one of its own pages' routes (the /cms
          // index AND one per registered section) before writing each - no separate publishGlobalRoute()
          // call needed here any more (cms-bundle.js's own installGlobalCms() doc comment).
          await installGlobalCms(mainSpace, app.prefix);
          doc.defaultView.location.hash = `/admin/${app.prefix}/cms`;
        } catch (err) {
          status.textContent = `Fehler: ${err.message}`;
        }
      });
      li.appendChild(cmsBtn);

      const unsupported = unsupportedModes(app);
      for (const mode of ['off', 'global', 'multiuser', 'personal']) {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.textContent = MODE_LABELS[mode];
        const isCurrent = (app.mode ?? 'global') === mode;
        if (!isCurrent && unsupported.has(mode)) {
          btn.disabled = true;
          btn.title =
            mode === 'multiuser'
              ? 'Ignoriert das eigene Personal-Bundle dieser App - "Eigener Bereich" bliebe unerreichbar.'
              : 'Diese App baut noch keinen Aggregat-Feed - der Feed bliebe dauerhaft leer.';
        } else {
          btn.disabled = isCurrent;
        }
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

      // "Update verfügbar" - only for a prefix installed FROM this console's own `APP_INSTALLERS`
      // (`app.appType` set at registration time) whose bundle's CURRENT `version` is newer than
      // what's actually installed (`app.bundleVersion`, absent entirely on an app registered
      // before this versioning existed - treated as "0", i.e. always outdated, same posture a
      // personal instance's own missing `data.bundleVersion` already gets - `installed-apps-
      // actions.js`'s own `provisionPersonalInstance()` doc comment). A manually `registerApp()`ed
      // app (no `appType`) never shows this - there is no known bundle to compare against.
      const installer = app.appType ? resolveInstaller(app.appType) : null;
      if (installer?.update && (app.bundleVersion ?? 0) < installer.version) {
        const updateBtn = doc.createElement('button');
        updateBtn.type = 'button';
        updateBtn.textContent = 'Update verfügbar';
        updateBtn.style.marginRight = '0.25rem';
        updateBtn.addEventListener('click', async () => {
          status.textContent = '';
          try {
            // `...(app.config ?? {})` - whatever install-time OPTIONS this prefix was last
            // configured with (Blog's own `routeScheme`, kinds.js's `platformAppsKind` `config`
            // doc comment) - re-applying an update must never silently drop back to that
            // installer's own DEFAULTS just because this button doesn't otherwise know them.
            await installer.update(mainSpace, { prefix: app.prefix, ...(app.config ?? {}) });
            await setAppBundleVersion(mainSpace, { prefix: app.prefix, bundleVersion: installer.version });
            await renderList();
          } catch (err) {
            status.textContent = `Fehler: ${err.message}`;
          }
        });
        li.appendChild(updateBtn);
      }

      // "Deinstallieren" - retracts the registration (`unregisterApp()`) AND best-effort clears
      // this app's own GLOBAL content (`nullGlobalAppContent()`, `dev.js`'s own doc comment on
      // both the "not a genuine deletion" caveat and why a visitor's own personal instance, if
      // any, is never touched by this - self-owned content this app's registration never had
      // write access to in the first place).
      const uninstallBtn = doc.createElement('button');
      uninstallBtn.type = 'button';
      uninstallBtn.textContent = 'Deinstallieren';
      uninstallBtn.addEventListener('click', async () => {
        status.textContent = '';
        try {
          await unregisterApp(mainSpace, { prefix: app.prefix });
          await nullGlobalAppContent(mainSpace, app.prefix);
          await renderList();
        } catch (err) {
          status.textContent = `Fehler: ${err.message}`;
        }
      });
      li.appendChild(uninstallBtn);
      li.appendChild(status);
    }
    return li;
  }

  /**
   * EAT YOUR OWN DOG FOOD (this roadmap item's own stated goal): the app
   * list used to be its own bespoke "clear the whole `<ul>`, rebuild every
   * row" loop, duplicating the exact reconciliation `@qu/space-ui`'s
   * `bindList()` already provides for `openLiveView()` (`view-actions.js`)
   * and any list Field. `platform.resolveApps()` returns a plain,
   * ALREADY-REDUCED array (last write per prefix wins - `platformAppsKind`'s
   * own "ONLY ADDITIVE" doc comment), not a live `{toArray, observe}`
   * source on its own, so `appsSource` below wraps it in the minimal such
   * source `bindList()` needs. `key: app => app.prefix` is stable across a
   * mode change/update (the SAME prefix, different fields) - only a row
   * whose OWN content actually changed gets replaced, everything else
   * stays untouched (no more losing scroll position/focus on every single
   * button click the way a full rebuild used to).
   */
  let currentApps = [];
  const appsListeners = new Set();
  const appsSource = {
    toArray: async () => currentApps,
    observe(cb) {
      appsListeners.add(cb);
      return () => appsListeners.delete(cb);
    },
  };
  /** Re-reads `platform.resolveApps()` and notifies `appsSource`'s own observer(s) - every mutation handler below calls this after a successful write, in place of the OLD "tear the whole list down and rebuild it" `renderList()`. */
  async function renderList() {
    if (!list) return;
    currentApps = await platform.resolveApps({ timeout: 500 });
    if (emptyState) emptyState.hidden = currentApps.length !== 0;
    for (const cb of appsListeners) cb();
  }
  if (list) bindList(list, appsSource, { key: (app) => app.prefix, render: renderAppRow });

  const form = mountEl.querySelector('form[data-qu-action="register-app"]');
  if (form) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      setFormStatus(form, '');
      try {
        const prefix = form.querySelector('input[name="prefix"]').value.trim();
        const rawPub = form.querySelector('input[name="appAdminPub"]').value.trim();
        const name = form.querySelector('input[name="name"]').value.trim();
        const appAdminPub = QuCrypto.fromBase64(rawPub);
        await registerApp(mainSpace, { prefix, appAdminPub, name });
        setFormStatus(form, 'Gesendet. Falls du der Relay-Admin bist, ist die App jetzt registriert.');
        await renderList();
      } catch (err) {
        setFormStatus(form, `Fehler: ${err.message}`);
      }
    });
  }

  // Fills in `<div data-qu-bind="file-app-installers">` (`admin-console-bundle.js`'s own doc
  // comment) with one MORE install form per discovered `/apps/*` app that doesn't already have a
  // static one above - dynamically created, but otherwise identical markup/wiring, so the loop
  // right below treats every install-app form uniformly regardless of where it came from.
  const fileAppContainer = mountEl.querySelector('[data-qu-bind="file-app-installers"]');
  if (fileAppContainer) {
    fileAppContainer.replaceChildren();
    for (const app of discoveredApps) {
      if (mountEl.querySelector(`form[data-qu-action="install-app"][data-app-type="${app.key}"]`)) continue;
      const form = doc.createElement('form');
      form.setAttribute('data-qu-action', 'install-app');
      form.setAttribute('data-app-type', app.key);
      const label = doc.createElement('label');
      label.textContent = `Pfad-Präfix (z.B. "${app.key}"): `;
      const input = doc.createElement('input');
      input.name = 'prefix';
      input.required = true;
      input.pattern = '[a-z0-9\\-]+';
      label.appendChild(input);
      form.appendChild(label);
      const button = doc.createElement('button');
      button.type = 'submit';
      button.textContent = `${app.label} installieren`;
      form.appendChild(button);
      const status = doc.createElement('p');
      status.setAttribute('data-qu-status', '');
      form.appendChild(status);
      fileAppContainer.appendChild(form);
    }
  }

  for (const form of mountEl.querySelectorAll('form[data-qu-action="install-app"]')) {
    const appType = form.getAttribute('data-app-type');
    const installer = resolveInstaller(appType);
    if (!installer) continue;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      setFormStatus(form, '');
      try {
        const prefix = form.querySelector('input[name="prefix"]').value.trim();
        // Every OTHER named field on this form (Blog's own `routeScheme` `<select>`,
        // `admin-console-bundle.js`'s own doc comment) - passed straight through to
        // `installer.install()` as an extra option AND persisted into this prefix's own `config`
        // (`setAppConfig()`, below) so a LATER "Update verfügbar" click or personal-instance
        // provisioning call can read the SAME choice back without this form needing to remember it.
        const options = {};
        for (const el of form.elements) {
          if (!el.name || el.name === 'prefix' || el.type === 'submit' || el.type === 'button') continue;
          options[el.name] = el.value;
        }
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
            sharedLists: installer.sharedLists?.(prefix) ?? [],
            globalViewNames: installer.viewNames?.(prefix) ?? [],
            personalBundle: installer.personalBundle,
            appType,
            bundleVersion: installer.version,
          })
        );
        await new Promise((resolve) => setTimeout(resolve, 400)); // let the relay's live resolver start watching this app's own route registry/shared lists/View names.
        await installer.install(mainSpace, { prefix, ...options });
        if (Object.keys(options).length) await setAppConfig(mainSpace, { prefix, config: options });
        setFormStatus(form, `${installer.label} installiert - erreichbar unter #/${prefix}/.`);
        form.reset();
        await renderList();
      } catch (err) {
        setFormStatus(form, `Fehler: ${err.message}`);
      }
    });
  }

  renderList();
}
