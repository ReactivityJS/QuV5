/**
 * SHARED EXTENSION-POINT HOST — the app-shell-wide `ExtensionPointHost`
 * (`@qu/extensions`) every framework-provided wiring (`cms-actions.js`,
 * `admin-actions.js`, ...) renders/collects FROM, and every "bundle"
 * (`blog-bundle.js`/`forum-actions.js`/`guestbook-actions.js`, or a future
 * `/apps/*` plugin) contributes INTO, without either side importing the
 * other - the concrete realization of the "Slots/Actions/ExtensionPoints"
 * principle ported from Qu V3's `@qu/foundation`, generalized from
 * `admin-sections.js`'s own registry (see that file's own doc comment on
 * how it now sits ON TOP of this).
 *
 * ONE INSTANCE PER PROCESS, exactly like `admin-sections.js`'s own
 * module-level `Map` before this file existed - a bundle contributes at
 * module-load time (a plain top-level `extensionPoints.contribute(...)`
 * call in its own file, no loader/registration step needed since every
 * bundle already lives in-process together, see `@qu/extensions`' own top
 * doc comment on why V3's dynamic-`import()` machinery isn't needed here).
 *
 * KNOWN EXTENSION POINTS (grows as more framework code adopts this instead
 * of a hardcoded call - documented here, not enforced, the same "point
 * names are just strings" posture `@qu/events`' topics already have):
 *   - `"cms.pageActions"` (`collect`) - `cms-actions.js`'s per-route list
 *     row calls this for every listed Page/View, appending each returned
 *     `{id, label, onClick}` as an extra button alongside the built-in
 *     "open in editor" one - e.g. a Blog plugin offering "Duplizieren" on
 *     every one of its own routes without `cms-actions.js` knowing Blog
 *     exists.
 */
import { ExtensionPointHost } from '@qu/extensions';

export const extensionPoints = new ExtensionPointHost();

/** Test-only escape hatch, same reasoning as `admin-sections.js`'s own `_clearAdminSectionsForTest()` - a test contributing its OWN throwaway entry into this SHARED, process-wide host needs a way to undo that without leaking into later tests in the same process. */
export function _clearExtensionPointForTest(point) {
  extensionPoints._clearPointForTest(point);
}
