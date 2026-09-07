/**
 * QU PLACEHOLDERS — `{name}` tokens resolvable inside any declaratively-
 * configured string (a shared-list name, a page route) that a generic,
 * attribute-driven mechanism (`generic-write-actions.js`'s `data-qu-action=
 * "qu-write"`, `blog-bundle.js`'s `routeScheme`) needs to fill in
 * DYNAMICALLY, without the wiring code that resolves them ever having to
 * know about a new one - a QuV3 requirement raised again here: date-
 * segmented paths (`/blog/2026/09/07/slug`) so an `'pages'` View source's
 * existing `prefix` filter (`view-sources.js`'s own doc comment) can serve
 * a year/month/day ARCHIVE for free, with zero new resolver code, simply
 * because the route string itself is already hierarchical.
 *
 * TWO SOURCES OF VALUES, MERGED (`fields` wins on a name collision - a
 * form's own submitted value is always more specific than any ambient
 * default could be):
 *   - AMBIENT ones (`AMBIENT_PLACEHOLDERS` below) - computed fresh at
 *     resolve time from `{space}` alone (today's date, the ACTING
 *     identity's own pubkey). Extend this map to add a new one (an
 *     `{alias}` once a human-readable alias registry exists, a future
 *     `{day-of-week}`, ...) - no caller anywhere needs to change: every
 *     consumer of `resolvePlaceholders()` already accepts whatever this
 *     map currently knows.
 *   - FIELD ones - whatever a form's own submitted values are (e.g.
 *     `{slug}` from a `name="slug"` input) - passed in per-call as
 *     `fields`, since these can't be known ahead of the actual submit.
 *
 * `resolvePlaceholders()` throws on a genuinely UNKNOWN placeholder (not a
 * submitted field, not in `AMBIENT_PLACEHOLDERS`) rather than leaving the
 * literal `{name}` in the result - a silently-wrong route/list name would
 * be a much worse failure mode than a loud one at write time.
 */
import { QuCrypto } from '@qu/core';

/**
 * `{name: (ctx) => string}` - `ctx` is always `{space}` (see
 * `resolvePlaceholders()`'s own doc comment on why `fields` never reaches
 * these: a name present in BOTH wins from `fields` instead, before this map
 * is even consulted). Add a new placeholder here, once, to make it usable
 * from EVERY declaratively-configured template in the app shell.
 */
export const AMBIENT_PLACEHOLDERS = {
  yyyy: () => String(new Date().getFullYear()),
  mm: () => String(new Date().getMonth() + 1).padStart(2, '0'),
  dd: () => String(new Date().getDate()).padStart(2, '0'),
  /** The ACTING identity's own pubkey, base64url - the same encoding `boot.js`'s personal-instance routing already uses, so a template can address "my own space" (e.g. a `data-qu-owner="{pub}"` tag) without the wiring code that fills it in needing to know this identity ahead of time. */
  pub: ({ space }) => QuCrypto.toBase64Url(space.identity.signingPub),
};

/**
 * @param {string} template - e.g. `"/post/{yyyy}/{mm}/{dd}/{slug}"`.
 * @param {{space: import('@qu/space-core').Space, fields?: Record<string, string>}} ctx
 * @returns {string}
 */
export function resolvePlaceholders(template, { space, fields = {} } = {}) {
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    if (name in fields) return fields[name];
    const resolve = AMBIENT_PLACEHOLDERS[name];
    if (resolve) return resolve({ space });
    throw new Error(`resolvePlaceholders: unknown placeholder "{${name}}" in "${template}" - not a submitted field and not in AMBIENT_PLACEHOLDERS`);
  });
}

/**
 * Named date-based route SCHEMES a post/entry route can follow, each just
 * the segment(s) prepended before `{slug}` - `blog-bundle.js`'s own
 * `routeScheme` config (`kinds.js`'s `platformAppsKind` own `config` field
 * doc comment) picks one of these keys; `'flat'` (the pre-existing, default
 * behavior) adds no date segment at all. Every scheme still ends in
 * `{slug}` alone - a bookmarkable, human-chosen last segment - the date
 * portion only ever prefixes it, never replaces it.
 *
 * WHY THIS MAKES YEAR/MONTH/DAY ARCHIVES FREE: a route built from any
 * non-`'flat'` scheme is hierarchical (`/post/2026/09/07/erster-post`), so
 * `view-sources.js`'s existing `'pages'` source `prefix` param already
 * filters an archive View down to a year (`prefix: '/post/2026/'`), a month
 * (`'/post/2026/09/'`), or a day (`'/post/2026/09/07/'`) with ZERO new
 * resolver code - see `docs/example-apps.md`'s own "Date-based archive
 * routing" section for a worked example. A visitor-driven "whichever
 * month the URL says" archive (the URL's own date segments selecting the
 * View's `prefix` at render time, rather than one fixed View per month) is
 * real, separate future work, not attempted here.
 */
export const ROUTE_SCHEMES = {
  flat: '{slug}',
  yyyy: '{yyyy}/{slug}',
  'yyyy/mm': '{yyyy}/{mm}/{slug}',
  'yyyy/mm/dd': '{yyyy}/{mm}/{dd}/{slug}',
};
