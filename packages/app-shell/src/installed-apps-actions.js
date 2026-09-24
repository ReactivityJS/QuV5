/**
 * INSTALLED-APPS ACTIONS — a single aggregating call for every REFERENCE
 * app's own wiring (`guestbook-actions.js`/`blog-actions.js`/
 * `forum-actions.js`, all found in `packages/app-shell/`), so `boot.js`'s
 * own dispatch tree adds exactly ONE call per render site instead of one
 * per app - a 4th reference app later only touches THIS file, not every
 * one of `boot.js`'s five render call sites again. Each wired function is
 * already a correct, cheap no-op on any page that isn't its own
 * (`guestbook-actions.js`'s own doc comment) - this file adds no NEW
 * behavior, purely fewer places to remember to call from.
 *
 * ALSO exports `provisionPersonalInstance()`/`wirePersonalUpdateBanner()`
 * (below) - the SAME "one file for every reference app" posture, one level
 * over: `boot.js`'s own `renderMultiUserRoute()` calls the former to self-
 * provision a visitor's own PERSONAL Guestbook/Blog the first time they
 * reach `#/<prefix>/u/me/`, an ADDITIVE route alongside an ordinary `mode:
 * 'global'`/`'personal'` app's own shared content (never replacing what the
 * bare prefix means - see that function's own top doc comment for the full
 * routing story), and the latter when that same call reports a pending
 * update for an ALREADY-provisioned instance.
 *
 * `wireInstalledApps()` ALSO calls every discovered `/apps/*` app's own
 * `wire` function (repo root's own `apps/README.md` doc comment on the
 * descriptor shape) - the SAME "correct, cheap no-op on any page that
 * isn't its own" contract the three hardcoded reference apps' own
 * `wireX()` functions already promise, just discovered instead of
 * hardcoded, so a file-based app's OWN interactivity needs no change here
 * ever again either.
 *
 * ALSO calls `generic-write-actions.js`'s `wireGenericWrite()` - unlike
 * every other wiring here, that one is not "one more app," it is the fully
 * DECLARATIVE, attribute-driven write path any hand-authored (or purely
 * CMS-built) page can opt into with no app-specific JS at all - see that
 * file's own top doc comment.
 */
import { wireGuestbook } from './guestbook-actions.js';
import { wireBlog } from './blog-actions.js';
import { wireForum } from './forum-actions.js';
import { wireGenericWrite } from './generic-write-actions.js';
import { REFERENCE_APP_BUNDLES_BY_KEY } from '../reference-apps.js';
import { ContentResolver } from '@qu/app-core';
import { discoveredApps } from '../apps-registry.generated.js';

/** @param {{mountEl: Element, doc: Document, space: import('@qu/space-core').Space}} params */
export async function wireInstalledApps({ mountEl, doc, space }) {
  wireGenericWrite({ mountEl, doc, space });
  await Promise.all([
    wireGuestbook({ mountEl, doc, space }),
    wireBlog({ mountEl, doc, space }),
    wireForum({ mountEl, doc, space }),
    ...discoveredApps.filter((app) => app.wire).map((app) => app.wire({ mountEl, doc, space })),
  ]);
}

/**
 * `REFERENCE_APP_BUNDLES_BY_KEY` (`../reference-apps.js`) IS the personal-
 * instance registry now too - every `defineAppBundle()` descriptor already
 * carries its own `personal.install`/`personal.update`/`version` (when it
 * declares a `personal` block at all), so a 4th reference app that wants a
 * personal-instance story of its own touches ONLY `reference-apps.js`, not
 * a second, independently-maintained map here (previously THREE:
 * `PERSONAL_INSTALLERS`/`PERSONAL_UPDATERS`/`PERSONAL_VERSIONS`, all three
 * required to stay in sync by hand). Forum deliberately has no `personal`
 * block at all (`forum-bundle.js`'s own top doc comment: "my own one-person
 * forum" doesn't map onto anything a visitor would actually want), so
 * `REFERENCE_APP_BUNDLES_BY_KEY.forum.personal` is simply `undefined` -
 * `provisionPersonalInstance()`/`wirePersonalUpdateBanner()` below treat
 * that the same "nothing to do" way the old map's missing entry already
 * did.
 */
function personalBundleOf(personalBundle) {
  return REFERENCE_APP_BUNDLES_BY_KEY[personalBundle]?.personal;
}

/**
 * Self-provisions ONE reference app's own PERSONAL instance - called by
 * `boot.js`'s own `renderMultiUserRoute()` the FIRST time an identity
 * reaches its own `#/<prefix>/u/me/`, for an ordinary `mode: 'global'`/
 * `'personal'` app (see that file's own doc comment on this ADDITIVE route:
 * it never replaces what the bare `#/<prefix>/` prefix means).
 * `personalBundle` unset/unknown (an ordinary global app with no personal-
 * instance story at all, e.g. the built-in admin console itself) is a
 * correct no-op - same "nothing to do" posture every `wireX()` in this file
 * already has for a page that isn't its own.
 *
 * Existence is checked the SAME way `boot.js`'s own `ensureSelfProvisioned()`
 * checks for a manifest - a real Page read (`resolvePage()`), not a raw
 * `useNode()`+poll (see that function's own "REAL RACE" doc comment for
 * why that trap matters here too, unchanged) - at THIS identity's own
 * `/<prefix>/` route, the exact route `installPersonalGuestbook()`/
 * `installPersonalBlog()` themselves create.
 *
 * ALREADY EXISTING instance: compares its own stored `data.bundleVersion`
 * (stamped by `installPersonalGuestbook()`/`installPersonalBlog()`
 * themselves, via `pageKind`'s own `data` field) against this bundle's
 * CURRENT version (`REFERENCE_APP_BUNDLES_BY_KEY[personalBundle].version`) - an older stamp (or none at all,
 * an instance from before this versioning existed) means `updateAvailable:
 * true`, `boot.js`'s own cue to inject `wirePersonalUpdateBanner()`'s
 * button. Never updates automatically - a silent, unattended overwrite of a
 * visitor's own page on every ordinary visit is not "an update," it's a
 * surprise; this only ever offers the button, the visitor decides when.
 * `config` (optional) - this app's OWN `qu-platform-apps` `config`
 * (`kinds.js`'s own doc comment, `boot.js`'s `match.config`) - passed
 * straight through to the reference app's `installX()` as extra options
 * (Blog's own `routeScheme`), so a visitor's personal instance follows the
 * SAME convention the relay-admin picked for the global one, without this
 * function needing to know what any particular option even means.
 * @param {{space: import('@qu/space-core').Space, prefix: string, personalBundle?: string, config?: Record<string, unknown>}} params
 * @returns {Promise<{updateAvailable: boolean}>}
 */
export async function provisionPersonalInstance({ space, prefix, personalBundle, config }) {
  const bundle = REFERENCE_APP_BUNDLES_BY_KEY[personalBundle];
  const personal = bundle?.personal;
  if (!personal) return { updateAvailable: false };
  const resolver = new ContentResolver(space, { appAdminPub: space.identity.signingPub });
  const page = await resolver.resolvePage(`/${prefix}/`, { timeout: 1500 });
  if (!page) {
    await personal.install(space, { prefix, ...config });
    return { updateAvailable: false };
  }
  const installedVersion = page.data?.bundleVersion ?? 0;
  return { updateAvailable: installedVersion < bundle.version };
}

/**
 * Injects a small, framework-generated "Update verfügbar" banner + button
 * at the top of THIS VISITOR's own personal-instance page - `boot.js`'s own
 * `renderMultiUserRoute()` calls this only when `provisionPersonalInstance()`
 * just reported `updateAvailable: true`, and only ever for `ref === 'me'`
 * (never for viewing someone ELSE's own personal instance: `personal.update`
 * always writes as `space.identity.signingPub`, i.e. the CURRENT session's
 * own identity - showing this button while looking at a different owner's
 * page would silently create/update the WRONG person's content, not merely
 * be a pointless no-op). Plain DOM elements this framework code creates and
 * wires itself, never sanitized content - same "trusted code, not
 * content-authored markup" posture every other framework-provided
 * interactivity in this package already uses (`view-actions.js`'s own
 * `renderItem()` doc comment has the fullest version of this reasoning).
 * `config` (optional) - see `provisionPersonalInstance()`'s own doc comment
 * on the identical param, threaded through to `update()` the same way.
 * @param {{mountEl: Element, doc: Document, space: import('@qu/space-core').Space, prefix: string, personalBundle: string, config?: Record<string, unknown>}} params
 */
export function wirePersonalUpdateBanner({ mountEl, doc, space, prefix, personalBundle, config }) {
  const personal = personalBundleOf(personalBundle);
  if (!personal || mountEl.querySelector('[data-qu-personal-update]')) return;
  const banner = doc.createElement('div');
  banner.setAttribute('data-qu-personal-update', '');
  const button = doc.createElement('button');
  button.type = 'button';
  button.textContent = 'Update verfügbar - jetzt aktualisieren';
  const status = doc.createElement('span');
  status.setAttribute('data-qu-status', '');
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = '';
    try {
      await personal.update(space, { prefix, ...config });
      banner.remove();
    } catch (err) {
      status.textContent = ` Fehler: ${err.message}`;
      button.disabled = false;
    }
  });
  banner.appendChild(button);
  banner.appendChild(status);
  mountEl.insertBefore(banner, mountEl.firstChild);
}
