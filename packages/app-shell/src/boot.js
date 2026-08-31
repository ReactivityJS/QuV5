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
import { AppRuntime, HashRouter, PlatformRuntime } from '@qu/app-core';
import { renderPage } from '@qu/app-renderer';
import { renderAdminPage, renderLandingPage } from './platform-ui.js';

const ADMIN_ROUTE_PREFIX = '/admin/relay';

/**
 * @param {{space: import('@qu/space-core').Space, appAdminPub: Uint8Array, mountEl: Element, window: {location: object, document: Document, addEventListener: Function, removeEventListener: Function}, styleId?: string, resolveTimeout?: number}} params
 *   `resolveTimeout` - how long to wait for a route's content to sync before giving up and rendering the "not found" fallback (see @qu/app-core's `ContentResolver`'s own `timeout` param); defaults to that resolver's own default.
 * @returns {{runtime: AppRuntime, router: HashRouter}} - `router.stop()` tears down the hashchange listener; nothing else here needs explicit cleanup.
 */
export function startApp({ space, appAdminPub, mountEl, window, styleId, resolveTimeout }) {
  const runtime = new AppRuntime(space, { appAdminPub });
  const router = new HashRouter({
    window,
    onChange: async (route) => {
      const plan = await runtime.resolveRoute(route, resolveTimeout ? { timeout: resolveTimeout } : undefined);
      renderPage({ mountEl, doc: window.document, templateHtml: plan.templateHtml, page: plan.page, css: plan.css, styleId });
    },
  });
  router.start();
  return { runtime, router };
}

/**
 * THE MULTI-APP / PLATFORM VARIANT (docs §19-21): instead of one fixed
 * `appAdminPub`, resolves the CURRENT route against the relay-admin's
 * `qu-platform-apps` registry (`@qu/app-core`'s `PlatformRuntime`) to
 * decide WHICH installed app owns it, then delegates to an ordinary
 * `AppRuntime` for that app's own `appAdminPub` - each app stays exactly
 * as unaware it's mounted under a prefix as it would be as the only app on
 * the relay. Two routes are intercepted BEFORE that delegation, never
 * forwarded to any app:
 *   - `#/admin/relay` (`ADMIN_ROUTE_PREFIX`) - the built-in relay-admin
 *     console (`platform-ui.js`'s `renderAdminPage()`) - not Space
 *     content, framework UI.
 *   - anything matching NO registered prefix - a plain landing page
 *     listing installed apps (`renderLandingPage()`), instead of an
 *     app-shaped 404 for a route that was never an app's to 404 on.
 * @param {{space: import('@qu/space-core').Space, relayAdminPub: Uint8Array, mountEl: Element, window: object, styleId?: string, resolveTimeout?: number}} params
 * @returns {{platform: PlatformRuntime, router: HashRouter}}
 */
export function startPlatform({ space, relayAdminPub, mountEl, window, styleId, resolveTimeout }) {
  const platform = new PlatformRuntime(space, { relayAdminPub });
  const timeoutOpt = resolveTimeout ? { timeout: resolveTimeout } : undefined;
  const router = new HashRouter({
    window,
    onChange: async (route) => {
      if (route === ADMIN_ROUTE_PREFIX || route.startsWith(`${ADMIN_ROUTE_PREFIX}/`)) {
        await renderAdminPage({ mountEl, doc: window.document, space, relayAdminPub, platform });
        return;
      }
      const match = await platform.resolveForPath(route, timeoutOpt);
      if (!match) {
        await renderLandingPage({ mountEl, doc: window.document, platform });
        return;
      }
      const runtime = new AppRuntime(space, { appAdminPub: match.appAdminPub });
      const plan = await runtime.resolveRoute(match.subPath, timeoutOpt);
      renderPage({ mountEl, doc: window.document, templateHtml: plan.templateHtml, page: plan.page, css: plan.css, styleId });
    },
  });
  router.start();
  return { platform, router };
}
