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
 * ALSO exports `provisionPersonalInstance()` (below) - the SAME "one file
 * for every reference app" posture, one level over: `boot.js`'s own
 * `renderMultiUserRoute()` calls it to self-provision a visitor's own
 * PERSONAL Guestbook/Blog the first time they reach `#/<prefix>/u/me/`, an
 * ADDITIVE route alongside an ordinary `mode: 'global'` app's own shared
 * content (never replacing what the bare prefix means - see that
 * function's own top doc comment for the full routing story).
 */
import { wireGuestbook } from './guestbook-actions.js';
import { wireBlog } from './blog-actions.js';
import { wireForum } from './forum-actions.js';
import { installPersonalGuestbook } from '../guestbook-bundle.js';
import { installPersonalBlog } from '../blog-bundle.js';
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
 * Self-provisions ONE reference app's own PERSONAL instance - called by
 * `boot.js`'s own `renderMultiUserRoute()` the FIRST time an identity
 * reaches its own `#/<prefix>/u/me/`, for an ordinary `mode: 'global'` app
 * (see that file's own doc comment on this ADDITIVE route: it never
 * replaces what the bare `#/<prefix>/` prefix means). `personalBundle`
 * unset/unknown (an ordinary global app with no personal-instance story at
 * all, e.g. the built-in admin console itself) is a correct no-op - same
 * "nothing to do" posture every `wireX()` in this file already has for a
 * page that isn't its own.
 *
 * Existence is checked the SAME way `boot.js`'s own `ensureSelfProvisioned()`
 * checks for a manifest - a real Page read (`resolvePage()`), not a raw
 * `useNode()`+poll (see that function's own "REAL RACE" doc comment for
 * why that trap matters here too, unchanged) - at THIS identity's own
 * `/<prefix>/` route, the exact route `installPersonalGuestbook()`/
 * `installPersonalBlog()` themselves create.
 * @param {{space: import('@qu/space-core').Space, prefix: string, personalBundle?: string}} params
 */
export async function provisionPersonalInstance({ space, prefix, personalBundle }) {
  const install = PERSONAL_INSTALLERS[personalBundle];
  if (!install) return;
  const resolver = new ContentResolver(space, { appAdminPub: space.identity.signingPub });
  const page = await resolver.resolvePage(`/${prefix}/`, { timeout: 1500 });
  if (!page) await install(space, { prefix });
}
