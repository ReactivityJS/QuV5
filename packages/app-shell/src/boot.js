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
import { AppRuntime, HashRouter, PlatformRuntime, ContentResolver, createApp, appManifestKind, adminAppManifestKind, adminPageKind, adminTemplateKind, adminStyleKind, globalAppAnchor } from '@qu/app-core';
import { QuCrypto } from '@qu/core';
import { deriveOwnerNodeId } from '@qu/space-core';
import { renderPage } from '@qu/app-renderer';
import { wireAdminConsole } from './admin-actions.js';
import { wireCms } from './cms-actions.js';
import { installCms } from '../cms-bundle.js';

/** Passed as `AppRuntime`'s `kinds` override for `realm: 'global'` routes - see `resolver.js`'s own doc comment on what this parametrizes. Shared by EVERY global app (they all use the SAME Kind set, told apart only by their anchor - see kinds.js's own "GLOBAL APP CONTENT" doc comment). No `routeRegistryKind` entry: `AppRuntime.resolveRoute()` (the only method `startPlatform()` calls) never touches it - see `runtime.js`. */
const GLOBAL_KINDS = { appManifestKind: adminAppManifestKind, pageKind: adminPageKind, templateKind: adminTemplateKind, styleKind: adminStyleKind };

/** @param {{mountEl: Element, doc: Document, platform: PlatformRuntime}} params - shown when no registered app's prefix (nor a well-formed owner id) matches the current route. The one piece of `startPlatform()` UI that ISN'T Qu content: by definition nothing here resolved, so there is no content to fetch it from - same "Framework Default" posture `@qu/app-renderer` already takes for a single app's own unresolved routes. */
async function renderLandingPage({ mountEl, doc, platform }) {
  // Filters out `mode: 'off'` global apps - kinds.js's own doc comment on the three states requires
  // an "off" app to be INDISTINGUISHABLE from one never registered at all; a landing-page link that
  // 404s the moment it's clicked would violate that for ordinary visitors (an admin still sees it,
  // deliberately, in the admin console's own apps list - that one needs to stay reachable to turn it
  // back on).
  const apps = (await platform.resolveApps({ timeout: 1500 })).filter((a) => !(a.realm === 'global' && a.mode === 'off'));
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
 * Shown at `#/admin` for anyone whose OWN identity isn't currently a
 * relay-admin (`space.isRelayAdmin()`), INSTEAD of the real admin console -
 * a real, requested UX gap this closes: the admin console's own CONTENT is
 * `'public'`-visibility by design (kinds.js's own "GLOBAL APP CONTENT" doc
 * comment - readable by anyone, WRITE is what the relay actually gates,
 * exactly like a rejected write elsewhere in this framework), but nothing
 * client-side previously reflected that distinction - an ordinary visitor
 * saw the exact same "register an app"/apps-list UI a relay-admin does,
 * with every write silently rejected the instant they tried one. Purely
 * cosmetic, purely client-side (this Space's OWN independent `relayAdmins`
 * view - never trusts the relay's own say-so, same posture as everywhere
 * else) - the relay's write-ACL is and remains the only REAL boundary,
 * unchanged by this function existing at all.
 */
function renderAdminUnauthorized({ mountEl, doc }) {
  const container = doc.createElement('div');
  container.style.cssText = 'font-family: sans-serif; max-width: 40rem; margin: 2rem auto; line-height: 1.5; padding: 0 1rem;';
  const h1 = doc.createElement('h1');
  h1.textContent = 'Kein Zugriff';
  container.appendChild(h1);
  const p = doc.createElement('p');
  p.textContent = 'Diese Seite ist nur für Relay-Admins sichtbar. Deine aktuelle Identität ist keine.';
  container.appendChild(p);
  const a = doc.createElement('a');
  a.href = '#/';
  a.textContent = 'Zur Startseite';
  container.appendChild(a);
  mountEl.replaceChildren(container);
}

/**
 * Recognizes a `realm: 'global'`, `mode: 'multiuser'` app's EXPLICIT
 * per-user sub-namespace (kinds.js's own doc comment on the three states) -
 * `/u/<ref>/<rest>` where `ref` is either the literal string `"me"` (the
 * CURRENTLY signed-in identity - the default anyway, see `startPlatform()`,
 * so this form is rarely typed by hand) or another identity's own
 * base64url-encoded pubkey (the SAME encoding `PlatformRuntime`'s own
 * top-level "unregistered prefix = literal owner id" fallback already
 * uses - reading it is always public, same as any other content here) -
 * the one case a bare prefix genuinely can't express: looking at someone
 * ELSE's own space on purpose. Returns `null` for anything else, which
 * `startPlatform()` then treats as an IMPLICIT `{ref: 'me', ...}` - see
 * that function's own doc comment on why the default flipped away from
 * the global shell (discoverability: a first-time visitor has no reason to
 * know or paste their own pubkey just to reach their OWN space).
 * @param {string} subPath
 * @returns {{ref: string, userSubPath: string}|null}
 */
function parseMultiUserSubPath(subPath) {
  const match = /^\/u\/([^/]+)(\/.*)?$/.exec(subPath ?? '');
  if (!match) return null;
  return { ref: match[1], userSubPath: match[2] || '/' };
}

/**
 * Recognizes `#/admin/<appPrefix>/<rest>` - the relay-admin-only route to
 * another registered `realm: 'global'` app's OWN global shell content
 * (`renderGlobalShell()`, right below) - `startPlatform()`'s `"admin"`
 * branch tries this BEFORE falling back to rendering the admin console's
 * own UI, so `#/admin/cms/` reaches the "cms" app's global landing page and
 * `#/admin/cms/cms` its global CMS editor, exactly the counterpart to how
 * `#/<prefix>/...` used to reach it directly before `mode: 'multiuser'`
 * claimed the bare prefix for each visitor's OWN space instead (see this
 * file's own top doc comment on `startPlatform()`). Returns `null` for a
 * bare `/` (the admin console's OWN root) - callers only ever consult this
 * from within the already-matched `"admin"` prefix, so an empty match here
 * correctly means "render the admin console itself," not "some app named
 * the empty string."
 * @param {string} subPath - `match.subPath` for `prefix === 'admin'`.
 * @returns {{appPrefix: string, appSubPath: string}|null}
 */
function parseAdminSubPath(subPath) {
  const match = /^\/([^/]+)(\/.*)?$/.exec(subPath ?? '');
  if (!match) return null;
  return { appPrefix: match[1], appSubPath: match[2] || '/' };
}

/** `parseMultiUserSubPath()`'s own `ref` resolved to a real pubkey, or `null` if it's neither `"me"` nor a well-formed base64url pubkey. */
function resolveUserRef(ref, space) {
  if (ref === 'me') return space.identity.signingPub;
  try {
    const pub = QuCrypto.fromBase64Url(ref);
    return pub.length === 32 ? pub : null;
  } catch {
    return null;
  }
}

/**
 * `renderMultiUserRoute()`'s own self-provisioning step - only calls
 * `createApp()`/`installCms()` if this identity genuinely has no manifest
 * yet (`ContentResolver.resolveManifest()`, the same check any ordinary
 * reader already uses, given a generous 1500ms timeout - real, deployment-
 * observed reasoning below, not an arbitrary number).
 *
 * A REAL RACE THIS ONCE HAD, caught before shipping: an earlier version
 * hand-rolled its OWN "does it exist" check via a raw `space.useNode()` +
 * bounded `node.meta` poll, released immediately after - which, for a
 * Node THIS SAME identity just created moments earlier (`createNode()`
 * never refcounts its own creation - the first `useNode()`/`release()`
 * pair ANY reader does afterward tears the local Y.Doc back down, exactly
 * the "torn down after every read, forces a full resync every time"
 * problem `dev.js`'s own `getOrSyncRegistryNode()` doc comment describes
 * for registries, just for an ordinary owner Node this time), needed a
 * REAL round-trip through the relay's own mirror to become visible again -
 * not instant even in-process, and the hand-rolled check's own bound
 * (400ms) occasionally lost that race, causing a second, spurious
 * `createApp()`/`installCms()` call for a manifest that already existed
 * (a real, observed bug, not hypothetical - reproduced via the exact
 * `#/cms/u/me/` -> `#/cms/u/me/cms` navigation this function exists for).
 * `resolveManifest()`'s own generous, already-established timeout absorbs
 * that same round-trip reliably, with no bespoke logic to get subtly
 * wrong. A genuinely CONCURRENT double-call (two tabs, same identity, same
 * exact instant) could still race here - an accepted, low-stakes residual
 * (a rare, cosmetic duplicate on someone's own first-ever visit, no
 * different from `createApp()`/`createTemplate()`/`createPage()` having no
 * built-in protection against being called twice concurrently either),
 * not something worth a heavier lock for.
 */
async function ensureSelfProvisioned(space, ownerPub) {
  const resolver = new ContentResolver(space, { appAdminPub: ownerPub });
  const manifest = await resolver.resolveManifest({ timeout: 1500 });
  if (!manifest) {
    await createApp(space, { name: 'Mein Bereich', rootTemplate: null, defaultRoute: '/' });
    await installCms(space);
  }
}

/**
 * Renders one user's own sub-namespace within a `mode: 'multiuser'` global
 * app - an ORDINARY `AppRuntime`/`wireCms()` pair, exactly like a single-
 * owner app (`startApp()`'s own posture), just addressed at `ownerPub`
 * instead of a `qu-platform-apps`-registered `appAdminPub` - the whole
 * point of this mode: self-owned `'content'`-ACL Kinds need no relay-admin
 * cooperation or per-app registration to work AT ALL, they only need an
 * agreed-upon URL SHAPE to be discoverable, which is all this function
 * provides.
 *
 * SELF-PROVISIONING, `ref === "me"` ONLY: a brand-new visitor's own
 * identity has no `qu-app` manifest yet the very first time they reach
 * their own `/u/me/` - rather than a 404 (technically correct, but a
 * dead end with no way to fix itself), this creates one, plus installs
 * the CMS editor, using nothing but THIS identity's own already-connected
 * `space` - the same `createApp()`/`installCms()` calls any install
 * script already makes, just triggered by a first visit instead of an
 * operator running one. Never done for someone else's `ref` (an ordinary
 * visitor reading Alice's still-empty page must never conjure content
 * into Alice's OWN name) - reading stays side-effect-free regardless of
 * what's actually there.
 */
async function renderMultiUserRoute({ space, mountEl, window, styleId, resolveTimeout, ref, userSubPath }) {
  const timeoutOpt = resolveTimeout ? { timeout: resolveTimeout } : undefined;
  const ownerPub = resolveUserRef(ref, space);
  if (!ownerPub) {
    renderPage({ mountEl, doc: window.document, templateHtml: null, page: null, css: '', styleId });
    return;
  }
  if (ref === 'me') await ensureSelfProvisioned(space, ownerPub);
  const runtime = new AppRuntime(space, { appAdminPub: ownerPub });
  const plan = await runtime.resolveRoute(userSubPath, timeoutOpt);
  mountEl.quSpace = space;
  renderPage({ mountEl, doc: window.document, templateHtml: plan.templateHtml, page: plan.page, css: plan.css, styleId });
  // Wired regardless of whose `ref` this is, same posture #/<prefix>/cms already has for an
  // ordinary app: write-ACL (self-owned, or an explicit grantContentWriter()) is what actually
  // gates a save, never this UI - a visitor viewing someone ELSE's page sees the same editor,
  // and their save simply fails cleanly (cms-actions.js's own verifyWritesAcked()) unless that
  // owner actually granted them access.
  await wireCms({ mountEl, doc: window.document, space, appAdminPub: ownerPub });
}

/**
 * Renders a `realm: 'global'` app's own GLOBAL shell content - the exact
 * same `AppRuntime`/`GLOBAL_KINDS`/`globalAppAnchor()`/`wireCms({global:
 * true})` combination `startPlatform()` always used for a global app's bare
 * prefix, factored out here since it now has TWO different call sites: an
 * ordinary `mode: 'global'` app's own bare `#/<prefix>/...` (unchanged),
 * and, for a `mode: 'multiuser'` app - whose bare prefix now resolves to
 * each visitor's OWN space instead (`renderMultiUserRoute()`, right above) -
 * `#/admin/<prefix>/...` instead (`parseAdminSubPath()`, this file's own
 * doc comment on it). Deliberately takes a plain `prefix` string, never a
 * whole `match` object - the admin-delegation call site has no
 * `PlatformRuntime` match for the DELEGATED app, only its prefix from the
 * URL and a lookup in `platform.resolveApps()` confirming it is actually a
 * currently-registered `realm: 'global'` app.
 */
async function renderGlobalShell({ space, mountEl, window, styleId, resolveTimeout, prefix, subPath }) {
  const timeoutOpt = resolveTimeout ? { timeout: resolveTimeout } : undefined;
  const runtime = new AppRuntime(space, { appAdminPub: await globalAppAnchor(prefix), kinds: GLOBAL_KINDS });
  const plan = await runtime.resolveRoute(subPath, timeoutOpt);
  mountEl.quSpace = space;
  renderPage({ mountEl, doc: window.document, templateHtml: plan.templateHtml, page: plan.page, css: plan.css, styleId });
  await wireCms({ mountEl, doc: window.document, space, appAdminPub: await globalAppAnchor(prefix), global: true, prefix });
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
 * `AppRuntime`, no differently for a `realm: 'global'` app than for any
 * other app: NEITHER is special-cased on the route STRING (architecture.md
 * §7 - "kein Sonderfall zu normalen Spaces"), only on the resolved match's
 * `realm`, which decides only WHICH Kind SET (`GLOBAL_KINDS` vs. the
 * default) and WHICH owner anchor (`globalAppAnchor(match.prefix)` vs.
 * `match.appAdminPub`) to resolve against - every app lives in the exact
 * SAME `space` (see "One relay Space, not two" in this document's own
 * history / kinds.js's own "GLOBAL APP CONTENT" doc comment: there is no
 * second, separately-membered `Space`/relay-forwarder any more). Only ONE
 * thing here is genuinely framework UI, never Qu content: a route matching
 * NO alias/owner id at all renders `renderLandingPage()` (see this file's
 * own doc comment on it, right above). The built-in admin console
 * (`prefix === 'admin'`) is the ONE `realm: 'global'` app with its own
 * dedicated framework interactivity, `wireAdminConsole()`
 * (`admin-actions.js`) - a bit of interactivity content-declared markup
 * attaches to afterward (its own doc comment explains why that's not a
 * `<script>`-execution loophole), since it is the one app every deployment
 * conventionally has and needs an app-registration form, not a generic
 * page/template/style editor. Every OTHER route (any other app, `realm:
 * 'main'` or `'global'` alike) gets `wireCms()` (`cms-actions.js`) instead,
 * on the exact same "content stays inert markup" terms - a correct no-op
 * unless the resolved page happens to be the built-in CMS editor
 * (`cms-bundle.js`'s `installCms()`).
 *
 * `#/admin` SPECIFICALLY also gets a visibility check
 * (`renderAdminUnauthorized()`, this file's own doc comment on it) BEFORE
 * any of the above - a real, requested UX gap: the console's own content is
 * `'public'`-visibility (readable by anyone - kinds.js's own doc comment),
 * so without this, an ordinary visitor saw the exact same UI a relay-admin
 * does, with every write silently rejected relay-side. Purely cosmetic
 * (`space.isRelayAdmin()`, this Space's own independent view, never the
 * relay's say-so) - the relay's write-ACL was always the only REAL
 * boundary and remains exactly as strict either way. Deliberately scoped
 * to `"admin"` only, not every `realm: 'global'` app - an ordinary global
 * app (a platform-wide chat/calendar/etc., relay-admin-ADMINISTERED but
 * meant for everyone to USE) has no reason to hide itself from non-admins
 * at all, only the admin console's own management UI does.
 *
 * `mode: 'multiuser'` (kinds.js's own doc comment on the three
 * administrable states) FLIPS the default at a bare `#/<prefix>/...`: it
 * now resolves/renders the CURRENTLY signed-in identity's own ordinary,
 * self-owned `'content'`-ACL Kinds (`renderMultiUserRoute()`, `ref: 'me'`)
 * instead of the app's global anchor - the whole point of this mode is
 * that a visitor needs ZERO relay-admin cooperation to get their own
 * space, so making them additionally discover and type `/u/me/` just to
 * reach it would defeat that. `parseMultiUserSubPath()`'s explicit
 * `/u/<ref>/...` form still works, for the one thing a bare prefix can't
 * express: addressing a DIFFERENT identity's space on purpose (`ref` =
 * that identity's own base64url pubkey). The app's own GLOBAL shell
 * content - what a bare prefix used to mean, before this flip - moves to
 * `#/admin/<prefix>/...` instead (`parseAdminSubPath()`/
 * `renderGlobalShell()`, this file's own doc comments on them), reachable
 * only by a relay-admin, same as the admin console's own root - a
 * `multiuser` app's global shell is exactly as relay-admin-administered as
 * a plain `mode: 'global'` app's, it is simply no longer reachable at the
 * BARE prefix once that prefix means "your own space" by default.
 * @param {{space: import('@qu/space-core').Space, mountEl: Element, window: object, styleId?: string, resolveTimeout?: number}} params
 *   `space` - MUST have been constructed with a `relayAdmins` list (see
 *   `Space`'s own constructor doc comment) matching the relay's own
 *   `QU_RELAY_ADMINS` config, or BOTH `qu-platform-apps` AND any global
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

      if (match.prefix === 'admin') {
        if (!space.isRelayAdmin()) {
          renderAdminUnauthorized({ mountEl, doc: window.document });
          return;
        }
        // #/admin/<appPrefix>/... - a DIFFERENT registered realm:'global' app's own global shell
        // (parseAdminSubPath()'s own doc comment) - tried BEFORE falling back to the admin console's
        // own UI, so this never shadows the console's own root ("/" never matches it, see that
        // function's own doc comment).
        const delegated = parseAdminSubPath(match.subPath);
        if (delegated) {
          const apps = await platform.resolveApps(timeoutOpt);
          const target = apps.find((a) => a.prefix === delegated.appPrefix && (a.realm ?? 'main') === 'global');
          if (target) {
            await renderGlobalShell({ space, mountEl, window, styleId, resolveTimeout, prefix: target.prefix, subPath: delegated.appSubPath });
            return;
          }
        }
        const runtime = new AppRuntime(space, { appAdminPub: await globalAppAnchor('admin'), kinds: GLOBAL_KINDS });
        const plan = await runtime.resolveRoute(match.subPath, timeoutOpt);
        mountEl.quSpace = space;
        renderPage({ mountEl, doc: window.document, templateHtml: plan.templateHtml, page: plan.page, css: plan.css, styleId });
        wireAdminConsole({ mountEl, doc: window.document, mainSpace: space, platform });
        return;
      }

      const isGlobal = match.realm === 'global';
      if (isGlobal && match.mode === 'multiuser') {
        // Bare prefix defaults to THIS visitor's own space now - see this function's own doc
        // comment on why the default flipped. `/u/<ref>/...` remains available to address "me"
        // explicitly or another identity's space on purpose.
        const userRoute = parseMultiUserSubPath(match.subPath) ?? { ref: 'me', userSubPath: match.subPath };
        await renderMultiUserRoute({ space, mountEl, window, styleId, resolveTimeout, ...userRoute });
        return;
      }

      if (isGlobal) {
        await renderGlobalShell({ space, mountEl, window, styleId, resolveTimeout, prefix: match.prefix, subPath: match.subPath });
        return;
      }

      const runtime = new AppRuntime(space, { appAdminPub: match.appAdminPub });
      const plan = await runtime.resolveRoute(match.subPath, timeoutOpt);
      mountEl.quSpace = space;
      renderPage({ mountEl, doc: window.document, templateHtml: plan.templateHtml, page: plan.page, css: plan.css, styleId });
      await wireCms({ mountEl, doc: window.document, space, appAdminPub: match.appAdminPub });
    },
  });
  router.start();
  return { platform, router };
}
