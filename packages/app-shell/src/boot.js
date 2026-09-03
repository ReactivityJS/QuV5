/**
 * BOOT — the back half of the boot sequence (docs/app-shell-arbeitsauftrag.md
 * §4, from "App Manifest laden" onward): wires an already-constructed
 * `Space` to `@qu/app-core`'s `AppRuntime`/`HashRouter` and
 * `@qu/app-renderer`'s `renderPage()`, so every hash-route change re-resolves
 * and re-renders. The FRONT half of the boot sequence (Identity -> Space ->
 * Storage -> Transport/Relay - docs' own diagram) is deliberately NOT this
 * function's job: it needs real network/`localStorage` glue (see
 * `identity.js`/`shell.js`), which would make this untestable without a
 * live relay. Callers (a real browser via `shell.js`, or a test/demo via an
 * in-process `Space`) construct the `Space` however is appropriate for
 * them and hand it here - this function knows nothing about HOW it was
 * built, only that it behaves like one.
 */
import { AppRuntime, HashRouter, PlatformRuntime, adminAppManifestKind, adminPageKind, adminTemplateKind, adminStyleKind, ADMIN_REALM_ANCHOR } from '@qu/app-core';
import { renderPage } from '@qu/app-renderer';
import { wireAdminConsole } from './admin-actions.js';
import { wireCms } from './cms-actions.js';

/** Passed as `AppRuntime`'s `kinds` override for `realm: 'admin'` routes - see `resolver.js`'s own doc comment on what this parametrizes. No `routeRegistryKind` entry: `AppRuntime.resolveRoute()` (the only method `startPlatform()` calls) never touches it - see `runtime.js`. */
const ADMIN_KINDS = { appManifestKind: adminAppManifestKind, pageKind: adminPageKind, templateKind: adminTemplateKind, styleKind: adminStyleKind };

/** @param {{mountEl: Element, doc: Document, platform: PlatformRuntime}} params - shown when no registered app's prefix (nor a well-formed owner id) matches the current route. The one piece of `startPlatform()` UI that ISN'T Qu content: by definition nothing here resolved, so there is no content to fetch it from - same "Framework Default" posture `@qu/app-renderer` already takes for a single app's own unresolved routes. */
async function renderLandingPage({ mountEl, doc, platform }) {
  const apps = await platform.resolveApps({ timeout: 1500 });
  const container = doc.createElement('div');
  container.style.cssText = 'font-family: sans-serif; max-width: 40rem; margin: 2rem auto; line-height: 1.5; padding: 0 1rem;';
  const h1 = doc.createElement('h1');
  h1.textContent = 'Qu App Shell';
  container.appendChild(h1);
  const p = doc.createElement('p');
  p.textContent = apps.length > 0 ? 'Verfügbare Anwendungen:' : 'Noch keine Anwendung auf dieser Plattform installiert.';
  container.appendChild(p);
  if (apps.length === 0) {
    // The one thing this page CAN say without any Qu content to resolve (this IS the fallback for
    // when there's genuinely nothing yet, including at #/admin BEFORE the "admin" alias has ever
    // been registered - a plain relay restart alone never gets you here, an install step is always
    // required first, same "framework never silently assumes a Package is installed" posture the
    // rest of this file already takes for a single unresolved route).
    const hint = doc.createElement('p');
    hint.innerHTML = 'Am schnellsten: <code>npm run bootstrap:platform</code> (siehe root <code>README.md</code>s "Deploying the App Shell") - installiert die Admin-Konsole (dann erreichbar unter <code>#/admin</code>) und eine CMS-verwaltete Demo-App in einem Schritt.';
    container.appendChild(hint);
  }
  const list = doc.createElement('ul');
  for (const app of apps) {
    const li = doc.createElement('li');
    const a = doc.createElement('a');
    a.href = `#/${app.prefix}/`;
    a.textContent = app.name ?? app.prefix;
    li.appendChild(a);
    list.appendChild(li);
  }
  container.appendChild(list);
  mountEl.replaceChildren(container);
}

/**
 * @param {{space: import('@qu/space-core').Space, appAdminPub: Uint8Array, mountEl: Element, window: {location: object, document: Document, addEventListener: Function, removeEventListener: Function}, styleId?: string, resolveTimeout?: number}} params
 *   `resolveTimeout` - how long to wait for a route's content to sync before giving up and rendering the "not found" fallback (see @qu/app-core's `ContentResolver`'s own `timeout` param); defaults to that resolver's own default.
 * @returns {{runtime: AppRuntime, router: HashRouter}} - `router.stop()` tears down the hashchange listener; nothing else here needs explicit cleanup.
 */
export function startApp({ space, appAdminPub, mountEl, window, styleId, resolveTimeout }) {
  const runtime = new AppRuntime(space, { appAdminPub });
  // Exposed for @qu/space-components' <qu-view>/<qu-bind>/<qu-list> - see that package's
  // context.js's own doc comment: any Component rendered inside `mountEl` (every page/template's
  // content ends up there via renderPage()'s `mountEl.innerHTML = ...`) resolves its Space by
  // walking up the DOM for the nearest ancestor's `.quSpace` - `mountEl` itself always qualifies.
  mountEl.quSpace = space;
  const router = new HashRouter({
    window,
    onChange: async (route) => {
      const plan = await runtime.resolveRoute(route, resolveTimeout ? { timeout: resolveTimeout } : undefined);
      renderPage({ mountEl, doc: window.document, templateHtml: plan.templateHtml, page: plan.page, css: plan.css, styleId });
      await wireCms({ mountEl, doc: window.document, space, appAdminPub });
    },
  });
  router.start();
  return { runtime, router };
}

/**
 * THE MULTI-APP / PLATFORM VARIANT (architecture.md §7, revised): resolves
 * the CURRENT route against `PlatformRuntime.resolveForPath()` - a
 * registered alias (`qu-platform-apps`), or failing that, the path's first
 * segment tried as a literal owner id - and delegates to an ordinary
 * `AppRuntime`, no differently for the built-in admin app than for any
 * other app: NEITHER is special-cased on the route STRING (architecture.md
 * §7 - "kein Sonderfall zu normalen Spaces"), only on the resolved match's
 * `realm`, which decides only WHICH Kind SET (`ADMIN_KINDS` vs. the
 * default) and WHICH fixed owner (`ADMIN_REALM_ANCHOR` vs. `match.appAdminPub`)
 * to resolve against - both realms live in the exact SAME `space` (see
 * "One relay Space, not two" in this document's own history / kinds.js's
 * own "THE ADMIN APP" doc comment: there is no second, separately-
 * membered `Space`/relay-forwarder any more). Only ONE thing here is
 * genuinely framework UI, never Qu content: a route matching NO
 * alias/owner id at all renders `renderLandingPage()` (see this file's own
 * doc comment on it, right above) - the admin console's own markup, by
 * contrast, is ordinary installed content (`bin/install-admin-console.mjs`),
 * rendered through the EXACT SAME `renderPage()` call as any other app;
 * `wireAdminConsole()` (`admin-actions.js`) is the one bit of framework
 * interactivity that content-declared markup attaches to afterward (its
 * own doc comment explains why that's not a `<script>`-execution loophole).
 * `wireCms()` (`cms-actions.js`) runs unconditionally for every OTHER
 * (non-admin) route, on the exact same "content stays inert markup" terms
 * - a correct no-op unless the resolved page happens to be the built-in
 * CMS editor (`cms-bundle.js`'s `installCms()`), which any app-admin can
 * install into their OWN app's Space, same as `startApp()` does below.
 * @param {{space: import('@qu/space-core').Space, mountEl: Element, window: object, styleId?: string, resolveTimeout?: number}} params
 *   `space` - MUST have been constructed with a `relayAdmins` list (see
 *   `Space`'s own constructor doc comment) matching the relay's own
 *   `QU_RELAY_ADMINS` config, or BOTH `qu-platform-apps` AND the admin
 *   app's own `qu-admin-*` Kinds fail this Space's own independent ACL
 *   check regardless of what the relay allows (`kinds.js`'s own
 *   `'relay-admins'` doc comments) - `shell.js`'s own boot sequence fetches
 *   that list and passes it through, same as it already does for
 *   `members`. Any visitor's own regular, already-existing identity works
 *   here the moment its pubkey is listed - no separate admin identity to
 *   generate or import.
 * @returns {{platform: PlatformRuntime, router: HashRouter}}
 */
export function startPlatform({ space, mountEl, window, styleId, resolveTimeout }) {
  const platform = new PlatformRuntime(space);
  const timeoutOpt = resolveTimeout ? { timeout: resolveTimeout } : undefined;

  const router = new HashRouter({
    window,
    onChange: async (route) => {
      const match = await platform.resolveForPath(route, timeoutOpt);
      if (!match) {
        await renderLandingPage({ mountEl, doc: window.document, platform });
        return;
      }
      const runtime = match.realm === 'admin' ? new AppRuntime(space, { appAdminPub: ADMIN_REALM_ANCHOR, kinds: ADMIN_KINDS }) : new AppRuntime(space, { appAdminPub: match.appAdminPub });
      const plan = await runtime.resolveRoute(match.subPath, timeoutOpt);
      mountEl.quSpace = space;
      renderPage({ mountEl, doc: window.document, templateHtml: plan.templateHtml, page: plan.page, css: plan.css, styleId });
      if (match.realm === 'admin') wireAdminConsole({ mountEl, doc: window.document, mainSpace: space, platform });
      else await wireCms({ mountEl, doc: window.document, space, appAdminPub: match.appAdminPub });
    },
  });
  router.start();
  return { platform, router };
}
