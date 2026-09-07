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
 */
import { wireGuestbook } from './guestbook-actions.js';
import { wireBlog } from './blog-actions.js';
import { wireForum } from './forum-actions.js';
import { installPersonalGuestbook, updatePersonalGuestbook, GUESTBOOK_VERSION } from '../guestbook-bundle.js';
import { installPersonalBlog, updatePersonalBlog, BLOG_VERSION } from '../blog-bundle.js';
import { ContentResolver } from '@qu/app-core';

/** @param {{mountEl: Element, doc: Document, space: import('@qu/space-core').Space}} params */
export async function wireInstalledApps({ mountEl, doc, space }) {
  await Promise.all([wireGuestbook({ mountEl, doc, space }), wireBlog({ mountEl, doc, space }), wireForum({ mountEl, doc, space })]);
}

/**
 * Which reference app's own PERSONAL-instance installer a `registerApp()`
 * entry's `personalBundle` tag (`dev.js`'s own doc comment) names - a 4th
 * reference app that wants a personal-instance story of its own only
 * touches THIS map, the same "one file, one edit" posture `wireInstalledApps()`
 * above already gives the RENDER side. Forum deliberately has no entry
 * here - "my own one-person forum" doesn't map onto anything a visitor
 * would actually want (`admin-actions.js`'s own `APP_INSTALLERS.forum`
 * simply never sets `personalBundle` at all, so this is never even
 * consulted for it).
 */
const PERSONAL_INSTALLERS = {
  guestbook: installPersonalGuestbook,
  blog: installPersonalBlog,
};

/**
 * The self-service counterpart to `PERSONAL_INSTALLERS` above - which
 * reference app's own personal-instance UPDATE function
 * `wirePersonalUpdateBanner()` (below) calls when a visitor clicks their
 * own "Update verfügbar" button. Same map shape, same "Forum has no entry"
 * omission, same reasoning.
 */
const PERSONAL_UPDATERS = {
  guestbook: updatePersonalGuestbook,
  blog: updatePersonalBlog,
};

/** Each reference app's own CURRENT personal-instance bundle version - `provisionPersonalInstance()`'s own doc comment on how this is used. */
const PERSONAL_VERSIONS = {
  guestbook: GUESTBOOK_VERSION,
  blog: BLOG_VERSION,
};

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
 * CURRENT version (`PERSONAL_VERSIONS`) - an older stamp (or none at all,
 * an instance from before this versioning existed) means `updateAvailable:
 * true`, `boot.js`'s own cue to inject `wirePersonalUpdateBanner()`'s
 * button. Never updates automatically - a silent, unattended overwrite of a
 * visitor's own page on every ordinary visit is not "an update," it's a
 * surprise; this only ever offers the button, the visitor decides when.
 * @param {{space: import('@qu/space-core').Space, prefix: string, personalBundle?: string}} params
 * @returns {Promise<{updateAvailable: boolean}>}
 */
export async function provisionPersonalInstance({ space, prefix, personalBundle }) {
  const install = PERSONAL_INSTALLERS[personalBundle];
  if (!install) return { updateAvailable: false };
  const resolver = new ContentResolver(space, { appAdminPub: space.identity.signingPub });
  const page = await resolver.resolvePage(`/${prefix}/`, { timeout: 1500 });
  if (!page) {
    await install(space, { prefix });
    return { updateAvailable: false };
  }
  const currentVersion = PERSONAL_VERSIONS[personalBundle];
  const installedVersion = page.data?.bundleVersion ?? 0;
  return { updateAvailable: installedVersion < currentVersion };
}

/**
 * Injects a small, framework-generated "Update verfügbar" banner + button
 * at the top of THIS VISITOR's own personal-instance page - `boot.js`'s own
 * `renderMultiUserRoute()` calls this only when `provisionPersonalInstance()`
 * just reported `updateAvailable: true`, and only ever for `ref === 'me'`
 * (never for viewing someone ELSE's own personal instance: `PERSONAL_UPDATERS`
 * always writes as `space.identity.signingPub`, i.e. the CURRENT session's
 * own identity - showing this button while looking at a different owner's
 * page would silently create/update the WRONG person's content, not merely
 * be a pointless no-op). Plain DOM elements this framework code creates and
 * wires itself, never sanitized content - same "trusted code, not
 * content-authored markup" posture every other framework-provided
 * interactivity in this package already uses (`view-actions.js`'s own
 * `renderItem()` doc comment has the fullest version of this reasoning).
 * @param {{mountEl: Element, doc: Document, space: import('@qu/space-core').Space, prefix: string, personalBundle: string}} params
 */
export function wirePersonalUpdateBanner({ mountEl, doc, space, prefix, personalBundle }) {
  const update = PERSONAL_UPDATERS[personalBundle];
  if (!update || mountEl.querySelector('[data-qu-personal-update]')) return;
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
      await update(space, { prefix });
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
