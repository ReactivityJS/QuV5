/**
 * REFERENCE APPS — the ONE list of every built-in `defineAppBundle()`
 * descriptor (`guestbook-bundle.js`/`blog-bundle.js`/`forum-bundle.js`/
 * `admin-console-bundle.js`), imported by BOTH `admin-actions.js` (the
 * "Update verfügbar"/mode-button/install-form machinery) AND
 * `installed-apps-actions.js` (personal-instance self-provisioning) - so
 * the two never again need their own, independently-maintained lookup
 * (previously `APP_INSTALLERS` in one file, `PERSONAL_INSTALLERS`/
 * `PERSONAL_UPDATERS`/`PERSONAL_VERSIONS` - THREE separate maps - in the
 * other, all four required to be kept in sync by hand for every reference
 * app). A 5th reference app now touches exactly ONE line here, never four
 * scattered ones - the same "one file, one edit" posture
 * `installed-apps-actions.js`'s own `wireInstalledApps()` already
 * established for the RENDER side.
 */
import { guestbookBundle } from './guestbook-bundle.js';
import { blogBundle } from './blog-bundle.js';
import { forumBundle } from './forum-bundle.js';
import { adminConsoleAppBundle } from './admin-console-bundle.js';

/** @type {Array<ReturnType<import('./app-bundle.js').defineAppBundle>>} */
export const REFERENCE_APP_BUNDLES = [guestbookBundle, blogBundle, forumBundle, adminConsoleAppBundle];

/** `key -> bundle` - `admin-actions.js`'s own `resolveInstaller()` looks up an already-registered prefix's `appType` against this. */
export const REFERENCE_APP_BUNDLES_BY_KEY = Object.fromEntries(REFERENCE_APP_BUNDLES.map((bundle) => [bundle.key, bundle]));
