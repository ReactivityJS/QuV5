/**
 * APPLICATION CONTENT KINDS — see docs/app-shell-arbeitsauftrag.md §5-14.
 * These are ordinary `@qu/space-core` Kind-Schemas, nothing more: the App
 * Runtime interprets what they mean, `@qu/space-core`/the Relay never do
 * (architecture.md §1, "Relay bleibt Application-blind").
 *
 * THREE DIFFERENT ACL SHAPES, chosen by CARDINALITY and by who's allowed
 * to write, not by "how important" a Kind is:
 *
 *   - `qu-app` (the App Manifest) and `qu-route-registry` are SINGLETONS -
 *     exactly one per app owner. `acl.write: 'named'` fits them exactly as
 *     `@qu/space-core`'s own `presenceKind`/`aliasRegistryKind` already use
 *     it: `Space.createNode()` derives their id as
 *     `deriveOwnerNodeId(ownerPub, kind)` - self-certifying, no relay-side
 *     membership needed just to SUBSCRIBE (see relay.js's own doc comment
 *     on why `'owner'`/`'named'` Nodes skip that gate) - exactly right for
 *     "the manifest must be discoverable before you're even a Space
 *     member." Their meta-stamp is automatically `visibility: 'public'`
 *     too (see kind-schema.js's own `metaVisibility` rule) - nothing to do
 *     here.
 *
 *   - `qu-page`/`qu-template`/`qu-style` are MANY-PER-OWNER (one per
 *     route/template-name/style-name) AND want REAL, exclusive per-owner
 *     write-ACL - not "any Space member," which would let ANY joined
 *     visitor overwrite ANY app's pages the instant several independently-
 *     owned apps share one relay (architecture.md §7's "The Platform
 *     layer" - the concrete case that surfaced this gap). `acl.write:
 *     'content'` (`@qu/space-core`'s kind-schema.js) is exactly this: the
 *     owner (plus anyone they've explicitly `grantWriter(id, kind,
 *     granteePub, {path})`ed - the SAME primitive `'named'` already uses,
 *     just many-per-owner) may write, self-certifying via
 *     `deriveContentNodeId(ownerPub, kind, path)`, no relay-side
 *     membership needed to SUBSCRIBE either. This is a GLOBAL Qu
 *     primitive, not an app-core invention - any many-per-owner content
 *     Kind (a calendar event, a forum post, a chat room) wants the exact
 *     same "who may edit THIS ONE thing" answer.
 *
 * `publicMeta()` BELOW IS NOT COSMETIC - it fixes a real bug found while
 * building the first real-relay App Shell demo (`demo/app-shell-relay.mjs`/
 * `demo/install-app-shell-demo.mjs`): `defineKind()` always derives a
 * `'members'`/`'content'`-mode Kind's META-STAMP visibility as
 * `'encrypted'` (see kind-schema.js's own doc comment), REGARDLESS of what
 * visibility the Kind's own FIELDS declare. A Node's meta-stamp is its
 * Y.Doc's very FIRST update (`node.js`'s `stampMeta()`), sealed for
 * whoever was a valid recipient AT THAT MOMENT. Because Yjs integrates one
 * author's updates as a strictly ordered, gapless sequence (see grant.js's
 * "WRITE-BEFORE-GRANT IS A TRAP" doc comment for the exact same property
 * applied to grants), a reader who cannot decrypt THAT FIRST update - e.g.
 * a visitor who joins AFTER the app-admin already created the page/
 * template/style, the App Shell's own core use case - can then NEVER
 * integrate ANY LATER update to that Node from that author either, even
 * though every field on it is declared `visibility: 'public'` and every
 * later envelope IS actually public-mode. The content silently,
 * permanently never renders for that reader - no error, no crash (see
 * `@qu/space-core`'s `debug.space.write.remote.undecryptable`), just an
 * empty template forever.
 *
 * The fix stays entirely in THIS package - `@qu/space-core` needs no
 * change: `stampMeta()` reads `kindSchema.metaVisibility` off whatever
 * Kind-Schema object it's handed, so a Kind-Schema whose `acl.write` is
 * still `'content'` (so id-derivation/grants keep working exactly as
 * kind-schema.js defines them) but whose `metaVisibility` is overridden to
 * `'public'` gets exactly what this Kind actually needs: real per-owner
 * write-ACL AND `'public'`-mode envelopes (no recipient list, no
 * decryption, no gap possible) for EVERY write including the founding one.
 * `Space.compactNode()`'s own uniform-visibility check (see space.js)
 * still holds - meta and every field here are ALL `'public'` - so these
 * Nodes remain compactable too, a nice confirmation this isn't fighting
 * the framework's own invariants, just correcting `defineKind()`'s
 * (otherwise sensible) DEFAULT for a case it wasn't designed for.
 */
import { defineKind } from '@qu/space-core';
import { QuCrypto } from '@qu/core';

/** @param {object} kindSchema @returns {object} A shallow copy with `metaVisibility` forced to `'public'` - see this file's own doc comment for why. */
function publicMeta(kindSchema) {
  return Object.freeze({ ...kindSchema, metaVisibility: 'public' });
}

/** The App Manifest - the entry point of an application (docs §5). One per app owner. */
export const appManifestKind = defineKind('qu-app', {
  fields: {
    name: { shape: 'atomic', visibility: 'public' },
    version: { shape: 'atomic', visibility: 'public' },
    rootTemplate: { shape: 'atomic', visibility: 'public' }, // a qu-template PATH, resolved via content-id.js
    defaultRoute: { shape: 'atomic', visibility: 'public' },
    theme: { shape: 'atomic', visibility: 'public' }, // a qu-style PATH, resolved via content-id.js
    metadata: { shape: 'atomic', visibility: 'public' }, // caller-defined JSON string, deliberately unstructured
  },
  acl: { write: 'named' },
});

/**
 * The set of routes an app defines (docs §12/§15) - a REGISTRY Node, the
 * same "one Node enumerates many others" pattern `@qu/space-core`'s
 * `alias.js`/`AliasRegistry` already uses, because `Space`/a relay have no
 * "list every Node of Kind X" query (see content-id.js's own doc comment).
 * Not consulted for resolving ONE known route (the Router derives that
 * page's id directly, see router.js) - only for ENUMERATING every route an
 * app has (a nav menu, a sitemap, the Dev API's own bookkeeping).
 */
export const routeRegistryKind = defineKind('qu-route-registry', {
  fields: {
    /** `Array<{route: string, title: string, excerpt?: string}>` - see resolver.js's `resolveRoutes()`. `excerpt` (optional, dev.js's `publishRoute()`/`publishGlobalRoute()`) is a plaintext snippet of the page's own content, captured at PUBLISH time only (never updated on a later edit - see `dev.js`'s own doc comment) - what `view-sources.js`'s `'pages'` source surfaces as `item.excerpt`, the thing that makes `openLiveView()`'s `setQuery()` full-text search actually search page CONTENT, not just titles. */
    routes: { shape: 'list', visibility: 'public' },
  },
  acl: { write: 'named' },
});

/** Enumerates every `qu-template` name an app owner has published (one per app-admin, self-certifying) - the SAME "registry Node, not a query" pattern `routeRegistryKind` above already uses, for a CMS-style editor (`@qu/app-shell`'s `cms-ui.js`) to list "every template" without a relay-side "list every Node of this Kind" query, which doesn't exist. `dev.js`'s `createTemplate()` appends to this itself - a caller never has to remember a separate "publish" call the way pages/routes historically did. */
export const templateRegistryKind = defineKind('qu-template-registry', {
  fields: {
    /** `Array<{name: string}>` - see resolver.js's `resolveTemplateNames()`. */
    templates: { shape: 'list', visibility: 'public' },
  },
  acl: { write: 'named' },
});

/** Enumerates every `qu-style` name an app owner has published - see `templateRegistryKind`'s own doc comment, identical shape/reasoning. */
export const styleRegistryKind = defineKind('qu-style-registry', {
  fields: {
    /** `Array<{name: string}>` - see resolver.js's `resolveStyleNames()`. */
    styles: { shape: 'list', visibility: 'public' },
  },
  acl: { write: 'named' },
});

/**
 * COLLECTIONS — many STRUCTURED items of one caller-defined shape, all
 * owned by one identity (a blog's posts, a contact list, a forum's
 * threads, a chat's messages - "Blog-Post usw." in the user's own
 * framing). Generalizes the EXACT SAME `acl.write: 'content'`
 * self-certifying-per-item + `acl.write: 'named'` enumeration-registry
 * pattern `qu-page`/`qu-template`/`qu-style` (and their own
 * `*RegistryKind`s) already establish above, into ONE reusable call
 * instead of hand-writing a fresh Kind-Schema pair per use case. `fields`
 * is entirely caller-defined (any shape `defineKind()` itself accepts,
 * `'atomic'`/`'text'`/`'list'`) - a blog post's `{title, author,
 * publishedAt, tags, body}` is exactly as valid a Collection item shape
 * as a contact's `{name, email, phone}` or a forum thread's own fields.
 *
 * `dev.js`'s `createCollectionItem()`/`editCollectionItem()` and
 * `resolver.js`'s `resolveCollectionItems()`/`resolveCollectionItem()`
 * are the generic counterparts to `createTemplate()`/`editTemplate()`/
 * `resolveTemplateNames()`/`resolveTemplate()` - same mechanics, just
 * parametrized by the `{itemKind, registryKind, registryField}` this
 * function returns instead of one hardcoded Kind.
 *
 * NOT YET COVERED (see architecture.md §7's own roadmap note): a
 * Collection's items aren't wired into `HashRouter`/`AppRuntime.
 * resolveRoute()` (a blog's individual posts don't get their own `#/...`
 * sub-routes automatically - only `qu-page` does that), the CMS editor
 * (`cms-actions.js`) has no UI yet for AUTHORING a new Collection type or
 * its items, and there is no reactive/live-binding story for a
 * Collection's data in a rendered template - all real, deliberately
 * separate future work, not attempted in this pass.
 *
 * @param {string} itemKindName - e.g. `"qu-blog-post"` - also derives the registry Kind's own name (`"qu-blog-post-registry"`).
 * @param {{fields: object}} params - `fields` in the exact shape `defineKind()`'s own `fields` argument takes.
 * @returns {{itemKind: object, registryKind: object, registryField: string}}
 */
export function defineCollectionKind(itemKindName, { fields }) {
  const itemKind = publicMeta(defineKind(itemKindName, { fields, acl: { write: 'content' } }));
  const registryField = 'items';
  const registryKind = defineKind(`${itemKindName}-registry`, {
    fields: {
      /** `Array<{name: string}>` - `name` here is each item's own `path` (dev.js's `createCollectionItem()`) - see `resolveCollectionItems()`. */
      [registryField]: { shape: 'list', visibility: 'public' },
    },
    acl: { write: 'named' },
  });
  return { itemKind, registryKind, registryField };
}

/**
 * THE PLATFORM APP REGISTRY (docs/app-shell-arbeitsauftrag.md §19-21) - ONE
 * GLOBAL, relay-wide registry (not one per relay-admin identity - see
 * "OWNERSHIP" below), mapping a URL PATH PREFIX to the `qu-app` that owns
 * it: `Array<{prefix: string, appAdminPub: string (base64), name: string}>`.
 * This is what lets ONE App Shell deployment host SEVERAL independent apps
 * (a messenger at `#/messages`, a forum at `#/forum`, ...), each with its
 * OWN app-admin identity/content, without the Shell or the Relay ever
 * hardcoding which apps exist - see `platform.js`'s `PlatformRuntime` for
 * how a route gets split into `(prefix, subPath)` and delegated to the
 * matching app's own `AppRuntime`.
 *
 * OWNERSHIP: `acl.write: 'relay-admins'` (`@qu/space-core`'s kind-schema.js
 * own doc comment on the mode), NOT `'named'` - several relay-admins,
 * configured as one flat, boot-time list (`QU_RELAY_ADMINS`, see
 * `packages/app-shell/relay-server.js`'s own doc comment), may all register
 * apps here on equal footing, with no single distinguished "owner" identity
 * and no manual per-admin `grantWriter()` bootstrapping needed (a relay
 * operator's config alone is enough - `'named'` would need one admin's
 * PRIVATE key to sign a grant for every other admin, something no relay
 * process ever holds). `PLATFORM_REGISTRY_ANCHOR` below is therefore a
 * FIXED, non-cryptographic id input (same idea as `globalAppAnchor()`
 * further down this file, just a single anchor instead of one per prefix)
 * - there is exactly ONE such registry per relay,
 * so its id carries no ownership meaning, only "'relay-admins'-ACL, THIS
 * Kind" (mirrors `deriveOwnerNodeId()`'s own "self-certifying" idea, just
 * with a list-membership check instead of a single owner pubkey behind it).
 * This is a real, deliberate change from an earlier revision of this Kind
 * (one registry NODE per relay-admin's own pubkey, `acl.write: 'named'`) -
 * that shape only ever let ONE relay-admin's own registry be consulted at
 * all (`PlatformRuntime` took a single `relayAdminPub`), so multiple
 * relay-admins never actually shared one registry; this shape genuinely
 * does. Registering an app here does NOT grant its app-admin anything
 * beyond a routing slot - each app's own content stays governed entirely by
 * ITS OWN `acl.write`/`grantWriter()`, exactly as if it were the only app
 * on the relay (docs §19: "Das Relay soll nicht einfach selbst als
 * allmächtiger Benutzer auftreten").
 *
 * `publicMeta()`-wrapped for the same reason `pageKind`/etc. are (this
 * file's own top doc comment) - `'relay-admins'`-ACL Kinds default their
 * meta-stamp to `'encrypted'` (kind-schema.js), but this registry's own
 * fields are all `'public'` and it lives in the OPEN-JOIN main Space, where
 * every visitor (not just relay-admins) must be able to read it to resolve
 * routes at all.
 *
 * ONLY ADDITIVE for now - `ListField` (see `@qu/space-core`'s `field.js`)
 * has no removal primitive, so there is no `unregisterApp()`; the Dev
 * API/admin UI built on this can only ever grow the list. Real, separate
 * work if "unmount an app" is ever needed (see docs' own "Nicht-Ziele").
 */
export const PLATFORM_REGISTRY_ANCHOR = new Uint8Array(32);
PLATFORM_REGISTRY_ANCHOR.set(new TextEncoder().encode('qu-platform-registry'));

export const platformAppsKind = publicMeta(
  defineKind('qu-platform-apps', {
    fields: {
      /**
       * `Array<{prefix: string, appAdminPub: string|null, name: string, realm: 'main'|'global', mode?: 'off'|'global'|'multiuser'|'personal', sharedLists?: string[], globalViewNames?: string[], globalTemplateNames?: string[], globalStyleNames?: string[], personalBundle?: string, appType?: string, bundleVersion?: number, config?: Record<string, unknown>, removed?: true}>`
       * - see `dev.js`'s `registerApp()`/`setAppMode()`/`setAppBundleVersion()`/
       * `setAppConfig()`/`unregisterApp()`, `platform.js`'s `PlatformRuntime`. `realm: 'global'` entries (`appAdminPub: null`)
       * route into content ANY configured relay-admin collectively
       * administers (see this file's own "GLOBAL APP CONTENT" doc comment)
       * instead of an ordinary owner-pubkey-addressed app - the SAME
       * registry, the SAME `'public'`-visibility mapping, no separate
       * mechanism; the built-in admin console is simply the one
       * ALWAYS-present `realm: 'global'` entry (conventionally at prefix
       * `"admin"`), not a special case. This mapping is itself only a
       * convenience: `PlatformRuntime.resolveForPath()` falls back to
       * treating an UNREGISTERED prefix as a literal base64url-encoded
       * owner pubkey when nothing here matches, so no app-admin needs a
       * relay-admin's cooperation just to be reachable at all - registering
       * a prefix here only ever adds a prettier alias.
       *
       * `mode` (a `realm: 'global'` app's own runtime state, ignored for
       * `realm: 'main'`, defaults to `'global'` when absent - every entry
       * from before this field existed, admin console included, keeps
       * working unchanged) - see architecture.md §7's "Three administrable
       * states, not a feature-gate" for the full design reasoning:
       *   - `'off'` - not routable at all (`resolveForPath()` returns
       *     `null`, same as an unregistered prefix) - a relay-admin's OWN
       *     ordinary write-ACL already fully controls this, no new
       *     mechanism needed.
       *   - `'global'` (the default/legacy behavior) - only relay-admins
       *     may write its content (`qu-admin-*` Kinds, `'relay-admins'`-ACL) -
       *     what every `realm: 'global'` app already did before `mode`
       *     existed.
       *   - `'multiuser'` - the global/shell content stays exactly as in
       *     `'global'` mode (just relocated to `#/admin/<prefix>/...`,
       *     `boot.js`'s `parseAdminSubPath()`), and the BARE prefix ITSELF
       *     flips to mean "my own space" - every visiting identity (relay-
       *     admins included) gets their OWN, self-provisioned, self-owned
       *     `'content'`-ACL namespace right there
       *     (`#/<prefix>/<pubkey-or-"me">/...`, `boot.js`'s
       *     `startPlatform()`) - deliberately NOT a relay-enforced toggle:
       *     self-owned content is, by design, never gate-able (nobody
       *     needs anyone's permission to write their OWN Node) - `mode`
       *     here only decides which ROUTING shape this app's own visitors
       *     get, never who may write what (that was always, and remains,
       *     entirely up to each Kind's own `acl.write`). Meant for a whole
       *     personal SITE per visitor (the built-in "cms" reference app),
       *     not a feed - see `'personal'` right below for that shape.
       *   - `'personal'` - the ADDITIVE `#/<prefix>/u/<ref>/...` route
       *     (`boot.js`'s `renderMultiUserRoute()`, `routeNamespace:
       *     '/'+prefix` - the SAME mechanism `'global'` mode already grants
       *     any app declaring a `personalBundle`) stays exactly as in
       *     `'global'` mode, but the BARE prefix no longer shows a single
       *     relay-admin-authored page - instead it renders a read-only,
       *     PUBLIC AGGREGATE FEED merged across every visitor's own
       *     personal instance (`boot.js`'s `renderAggregateShell()`,
       *     resolving the well-known `<prefix>-personal-feed` View by
       *     naming convention - an app opts into this by creating that
       *     View at install time, e.g. `guestbook-bundle.js`'s
       *     `installGuestbook()` sourcing it from the shared list every
       *     personal instance already writes into). For a Gästebuch/Blog-
       *     style app where "one feed everyone contributes to" already IS
       *     the point, this replaces needing a SEPARATE, redundantly
       *     relay-admin-curated global instance at all - unlike
       *     `'multiuser'` above, there is no per-visitor SITE here, only
       *     ONE shared, aggregated read surface plus each visitor's own
       *     write-side instance.
       *
       * `bundleVersion` (optional, `realm: 'global'` only) - the version of
       * this app's own bundled GLOBAL content last applied via
       * `installX()`/`updateX()` (`dev.js`'s `setAppBundleVersion()`) -
       * compared against a reference app's own current `version` constant
       * by the admin console to decide whether to show an "Update
       * verfügbar" affordance. Unrelated to any PERSONAL instance's own
       * version, which travels on that instance's own page `data` field
       * instead (`installed-apps-actions.js`'s own doc comment) - the two
       * are administered by different people (a relay-admin here, each
       * visitor for their own instance there) and can genuinely drift
       * apart. `appType` (optional) - which entry of `admin-actions.js`'s
       * own `APP_INSTALLERS` this prefix was installed from (e.g.
       * `'guestbook'`) - lets the admin console look up that installer's
       * current `version`/`update()` for the button above; omitted for a
       * manually `registerApp()`ed app with no known reference bundle (no
       * Update affordance shown for those, correctly - there is nothing to
       * compare against).
       *
       * `config` (optional) - a small, entirely free-form JSON bag for
       * whatever ONE MORE per-app setting a reference app's own bundle
       * needs to remember between install and a LATER re-apply/self-
       * provisioning call, without a Kind-Schema change every time a new
       * one comes up (`dev.js`'s `setAppConfig()` own "push a newer entry,
       * merge into `config`, everything else carried over" doc comment) -
       * e.g. `blog-bundle.js`'s `routeScheme` (`'flat'`/`'yyyy'`/`'yyyy/mm'`/
       * `'yyyy/mm/dd'`, `@qu/app-shell`'s `qu-placeholders.js` own doc
       * comment on the scheme names and what a post's route looks like
       * under each). Not interpreted by this Kind or `platform.js` at all -
       * purely a caller-defined dictionary, the SAME "no shape imposed"
       * posture `platformAppsKind.apps` itself already has one level up.
       * `boot.js`'s own `match.config` (spread straight off whichever entry
       * `resolveForPath()`/`resolveApps()` returned - no separate accessor
       * needed) is how a render call site reads it back, e.g. to pass the
       * SAME `routeScheme` down to a visitor's own personal-instance
       * installer as the relay-admin picked for the global one.
       *
       * `globalTemplateNames`/`globalStyleNames` (optional, `realm: 'global'`
       * only) - `dev.js`'s `createGlobalTemplate()`/`createGlobalStyle()` own
       * doc comment on the gap this closes: unlike a global app's PAGE routes
       * (discovered LIVE by `live-app-resolver.js` watching
       * `adminRouteRegistryKind`), templates/styles have no registry of
       * their own to watch - a NEW template/style name is classified
       * correctly ONLY if the relay already knows to expect it, otherwise it
       * silently misclassifies against the generic `'content'`-ACL fallback
       * and REJECTS the write (no grant exists for a `'relay-admins'`-ACL
       * Kind - that mode has no self-grant concept at all). The built-in
       * admin console's own `"main"` template is hardcoded as always-known
       * (`live-app-resolver.js`'s own `KNOWN_GLOBAL_TEMPLATE_NAMES`) - ANY
       * OTHER global app installing its own template/style (e.g.
       * `installGlobalCms()`'s own `__cms__` template, for a `realm: 'global'`
       * app that isn't "admin") MUST list its name(s) here at registration
       * time, the exact same "tell the relay before writing it" requirement
       * `globalViewNames`/`sharedLists` already have, one Kind over.
       *
       * `removed` (optional, `true` when present) - `unregisterApp()`'s own
       * marker: this prefix's registration is retracted, exactly as
       * thoroughly as if it had never been registered at all
       * (`platform.js`'s `resolveApps()` filters these out entirely, not
       * just `resolveForPath()` - unlike `mode: 'off'`, which still LISTS
       * the app, just unreachable, `removed` hides it from every listing
       * too). The one real removal primitive this ONLY-ADDITIVE list gets -
       * not a genuine deletion (no entry is ever erased, "additive" stays
       * true), but every reader treats a `removed` entry as the current,
       * final word for that prefix, the same "last entry wins" convention
       * `mode`/`bundleVersion` updates already use, just one more field
       * shape. Never implies the app's own CONTENT is gone - see
       * `dev.js`'s `nullGlobalAppContent()` for the (relay-admin-owned,
       * `realm: 'global'` GLOBAL instance only - a visitor's own personal
       * instance is self-owned and can never be reached by an uninstall)
       * best-effort content-clearing this pairs with in the admin console.
       *
       * Updating `mode`/`bundleVersion`, or retracting a prefix via
       * `removed`, is always a normal `apps.push()` of a new entry with the
       * SAME `prefix` (this list has no in-place update/removal primitive
       * at all, "ONLY ADDITIVE" above) - every reader treats the LAST entry
       * for a given `prefix` as current (`platform.js`'s own
       * `resolveForPath()`/`resolveApps()`), the same log-of-states
       * pattern, just more fields deep now.
       */
      apps: { shape: 'list', visibility: 'public' },
    },
    acl: { write: 'relay-admins' },
  })
);

/** One page (docs §7). Node id = `deriveContentNodeId(ownerPub, 'qu-page', route)`. Write-ACL: the owner, plus anyone explicitly `grantWriter(id, 'qu-page', granteePub, {path: route})`ed - see kind-schema.js's own "THE 'content' ACL mode" doc comment. */
export const pageKind = publicMeta(
  defineKind('qu-page', {
    fields: {
      route: { shape: 'atomic', visibility: 'public' },
      title: { shape: 'atomic', visibility: 'public' },
      template: { shape: 'atomic', visibility: 'public' }, // a qu-template PATH
      content: { shape: 'text', visibility: 'public' }, // real Y.Text - collaborative editing "for free" (docs §7)
      /**
       * STRUCTURED page data, beyond the single `content` blob above - an
       * arbitrary JSON-serializable object, e.g. `{author: 'Alice',
       * publishedAt: '2026-01-01', tags: ['qu','cms']}`. Each top-level key
       * is resolved into the SAME-NAMED `<qu-slot>` in the page's template
       * (`@qu/app-renderer`'s `render.js`), ALONGSIDE the `"content"` slot,
       * never instead of it - a template author defines however many named
       * slots a page actually needs, not just one. `null`/unset (the
       * default) means no extra slots - fully backward compatible with
       * every page that only ever used `title`+`content`. Deliberately
       * `'atomic'`-shape (a single opaque value, last-write-wins as a
       * whole, unlike `content`'s field-level collaborative Y.Text) - this
       * is for STATIC structured authoring (a blog post's byline, a
       * page's meta description, ...), not live/reactive per-visitor data
       * (see architecture.md §7's own roadmap note on why that's
       * deliberately NOT this field's job).
       */
      data: { shape: 'atomic', visibility: 'public' },
      /**
       * A `qu-style` NAME (same "name, resolved via content-id.js at render
       * time" convention `template` above already uses) to load for THIS
       * page specifically, instead of falling back to the Manifest's own
       * single, app-wide `theme` style (`appManifestKind`'s own `theme`
       * field) - `runtime.js`'s `AppRuntime.resolveRoute()` prefers this
       * over `manifest.theme` when set, auto-loaded the exact same way the
       * manifest theme already is (a page/template author never has to
       * reference it from markup or JS - `boot.js`'s `renderPage()` already
       * receives the resolved `css` string as one more plan field, same
       * shape as before this existed). `null`/unset (the default) keeps the
       * pre-existing "one app-wide theme for every page" behavior
       * unchanged - fully backward compatible.
       */
      style: { shape: 'atomic', visibility: 'public' },
      /**
       * `'draft'` | `'published'` | `null`/unset (treated as `'published'` -
       * every page written before this field existed keeps working exactly
       * as before, no migration). See `resolver.js`'s `resolvePage()` own
       * doc comment: the app's OWN rendering path (ordinary navigation, a
       * `'pages'` View source) never resolves a `'draft'` page unless the
       * caller explicitly opts in with `includeDrafts: true` (the editor's
       * own "load this draft back into the form" case) - a draft looks
       * exactly like "never published" to everyone else, the SAME 404-style
       * `null` an unpublished route already produces. NOT a confidentiality
       * mechanism - this field, like every other on this Kind, is
       * `visibility: 'public'`: content-addressed id derivation still works
       * for anyone who already knows/guesses the route (this Kind's own doc
       * comment, `routeRegistryKind`'s own "not a query" reasoning) - only
       * the app's own resolver path honors `status`, not the underlying
       * Node. Genuine confidentiality needs `visibility: 'encrypted'`
       * (`privatePageKind`), a different, narrower-audience Kind entirely.
       */
      status: { shape: 'atomic', visibility: 'public' },
    },
    acl: { write: 'content' },
  })
);

/** One template (docs §8). Node id = `deriveContentNodeId(ownerPub, 'qu-template', name)`. Same write-ACL as `pageKind` - see its own doc comment. */
export const templateKind = publicMeta(
  defineKind('qu-template', {
    fields: {
      html: { shape: 'text', visibility: 'public' },
    },
    acl: { write: 'content' },
  })
);

/** One style sheet (docs §11). Node id = `deriveContentNodeId(ownerPub, 'qu-style', name)`. Same write-ACL as `pageKind` - see its own doc comment. */
export const styleKind = publicMeta(
  defineKind('qu-style', {
    fields: {
      css: { shape: 'text', visibility: 'public' },
    },
    acl: { write: 'content' },
  })
);

/**
 * A GROUP - a named, owner-curated list of members - the one generic
 * primitive `mode: 'multiuser'`-style self-sovereign content needs to be
 * shared with SOMEONE beyond "everyone" or "just me," without inventing
 * app-specific relay logic for it (the same "keine app-spezifischen Kinds
 * im Relay" constraint every other feature in this package already
 * respects - a group is exactly as generic as `pageKind`/`templateKind`
 * themselves, usable by CMS today and Chat/Kalender/whatever else later,
 * unchanged). Node id = `deriveContentNodeId(ownerPub, 'qu-group', name)` -
 * MANY per owner (you can curate several groups, e.g. "Familie", "Team X"),
 * `acl.write: 'content'` (same self-owned, grantable write-ACL as
 * `pageKind` - an owner may `grantWriter()` a co-admin the exact same way).
 *
 * `members` is a single `'atomic'` value (`Array<{pub: string, xPub:
 * string}>`, both base64 - the SAME `{pub, xPub}` shape `Space`'s own
 * `members` constructor option already uses), REPLACED wholesale on every
 * edit - never a `'list'`/`ListField` (`platformAppsKind`'s own "ONLY
 * ADDITIVE, no removal" doc comment) - a group's whole POINT is that
 * people leave it again, which an append-only log can't express. This
 * does mean two concurrent edits race last-write-wins (whichever
 * `editGroup()` call's write lands at the relay later wins outright, no
 * merge) - an accepted, low-stakes tradeoff for v1: a group is normally
 * curated by one owner at a time, not simultaneously by several.
 *
 * `members` is deliberately `visibility: 'public'` - readable by anyone
 * who already knows this group's Node id (its OWN existence is no more
 * secret than a page's route already is) - "who is in this group" is a
 * much weaker secret than whatever content later gets ENCRYPTED for the
 * group's current members (`@qu/app-core`'s `resolveGroup()`/
 * `createPrivatePage()`, this file's own doc comment on `privatePageKind`
 * below), and keeping it public sidesteps a real chicken-and-egg problem a
 * `visibility: 'encrypted'` members list would otherwise create for every
 * member OTHER than the group's own owner (whoever wants to encrypt new
 * content for "everyone currently in the group" needs to read that list
 * WITHOUT already being able to decrypt it circularly). Metadata privacy
 * for group membership itself is real, separate future work if it's ever
 * needed - not attempted here.
 */
export const groupKind = defineKind('qu-group', {
  fields: {
    name: { shape: 'atomic', visibility: 'public' },
    members: { shape: 'atomic', visibility: 'public' },
  },
  acl: { write: 'content' },
});

/**
 * A PRIVATE/SHARED PAGE - `pageKind`'s sibling for content that should NOT
 * be readable by every Space member by default (the honest answer to "CMS
 * heißt nicht automatisch, dass alle Seiten alle sehen können" - a real,
 * reported gap: `pageKind`'s own fields are ALL `visibility: 'public'`,
 * fixed once per Kind-Schema, never per-instance - see `@qu/space-core`'s
 * field.js's own doc comment on why visibility can't just be a per-write
 * choice on the SAME Kind). SAME shape as `pageKind` (`route`/`title`/
 * `template`/`content`/`data`) and the SAME `acl.write: 'content'`
 * self-owned write-ACL, but `visibility: 'encrypted'` on every field
 * except `route` (kept `'public'` - needed for ordinary routing/
 * enumeration, and a route string alone reveals no page CONTENT) - and,
 * UNLIKE `pageKind`, deliberately NOT wrapped in `publicMeta()`: this
 * Kind's own meta-stamp (existence/owner/timestamp) should be exactly as
 * hidden as its content, not just its fields - see `publicMeta()`'s own
 * doc comment above for why that override exists at all, and why skipping
 * it here is the deliberate choice for genuinely private content.
 *
 * Reachable through the EXACT SAME `AppRuntime`/`ContentResolver`
 * machinery as any other Kind (`resolveTimeout` unaffected) - a caller who
 * doesn't pass `recipients` when creating one degenerates to "shared with
 * nobody but the owner" (see `@qu/space-core`'s `Space._effectiveRecipients()`
 * doc comment: the owner's own key is always included, defensively, no
 * matter what) - genuinely private, single-user notes are simply the
 * degenerate case of this same Kind, not a separate concept.
 */
export const privatePageKind = defineKind('qu-private-page', {
  fields: {
    route: { shape: 'atomic', visibility: 'public' },
    title: { shape: 'atomic', visibility: 'encrypted' },
    template: { shape: 'atomic', visibility: 'encrypted' },
    content: { shape: 'text', visibility: 'encrypted' },
    data: { shape: 'atomic', visibility: 'encrypted' },
  },
  acl: { write: 'content' },
});

/**
 * A NAMED, SHARED, APPEND-ONLY LIST any Space member may write to directly -
 * the missing primitive a genuine guestbook needs: many DIFFERENT visitors
 * each contributing their OWN entry to ONE common list, as opposed to
 * `defineCollectionKind()`'s shape (`acl.write: 'content'`, one identity
 * curating many items it each individually owns - right for "an app-admin's
 * own blog posts," wrong for "any visitor signs the guestbook"). `entries`
 * is `acl.write: 'members'` (kind-schema.js's own doc comment on the mode) -
 * a flat, symmetric "any current Space member may write" check, the SAME
 * mode `Space`'s own `presenceKind` already uses for exactly this reason -
 * with NO per-item ownership/grant concept at all: nobody "owns" one entry
 * more than another, matching a real guestbook's own social contract.
 *
 * `entries` is a single `'list'`-shape field of caller-defined plain
 * objects (`Array<object>`, e.g. `{name, message, ts}` for a guestbook) -
 * the SAME "no separate per-item Kind-Schema" shape `groupKind.members`/
 * `platformAppsKind.apps` already use, deliberately NOT wrapping each entry
 * in its own Node the way a Collection's items are: a Y.Array's own CRDT
 * merge already handles many DIFFERENT authors concurrently `.push()`ing
 * without a conflict (each insert lands independently, no last-write-wins
 * clobbering, no relay-side coordination needed) - exactly the property
 * "many strangers write to the same list at once" needs, and exactly why
 * this does NOT need `defineCollectionKind()`'s per-item content-addressing
 * at all. No removal/edit primitive by design (same "ONLY ADDITIVE" choice
 * `platformAppsKind`'s own doc comment makes, for the same reason: a
 * guestbook entry, once posted, is not normally something ITS OWN AUTHOR
 * can silently rewrite later) - moderation (an admin removing an entry) is
 * real, separate future work, not attempted here.
 *
 * ONE Kind, MANY independent lists: `sharedListAnchor(name)` below derives
 * a fixed, non-cryptographic, per-NAME anchor (the exact same "no real
 * keypair behind this id, purely a stable hash input" idea
 * `globalAppAnchor(prefix)` already uses one section up) - `deriveOwnerNodeId
 * (await sharedListAnchor('guestbook'), sharedListKind.kind)` is a
 * well-known id EVERY member can independently compute from just the name
 * string, no discovery/registration step needed - so a deployment can run
 * as many named shared lists (a guestbook, a feedback box, a simple poll's
 * vote log, ...) as it wants, each isolated from the others by name alone.
 */
export async function sharedListAnchor(name) {
  return QuCrypto.sha256(new TextEncoder().encode(`qu-shared-list:${name}`));
}

export const sharedListKind = publicMeta(
  defineKind('qu-shared-list', {
    fields: {
      entries: { shape: 'list', visibility: 'public' },
    },
    acl: { write: 'members' },
  })
);

/**
 * A VIEW — a Drupal-Views-style CONFIGURATION for a live, aggregated feed
 * pulled from one or more OTHER content sources (`@qu/app-core`'s own
 * `view-sources.js` interprets it) - "user-feed combines Blog + Gästebuch"
 * (the user's own framing) is exactly what this is for: a page never has
 * to hardcode "read routeRegistryKind, then also read this shared list,
 * merge, sort" logic itself - a View Node holds that recipe as ordinary
 * Kind-Schema data, resolved and kept LIVE by `openLiveView()`.
 *
 * DELIBERATELY GENERIC, not a CMS-only concept: `acl.write: 'content'`
 * (self-owned, many-per-owner - the SAME shape `qu-template`/`qu-style`
 * already use) means ANY app built on `@qu/app-core` - a Forum, a
 * Live-Ticker, a future GeoChase - can `createView()`/`editView()` its own
 * feeds the exact same way, through the exact same Dev API, with no
 * dependency on the built-in CMS whatsoever; the CMS editor is simply ONE
 * caller among possibly several (see `@qu/app-shell`'s `cms-actions.js`
 * own doc comment on why it stays a thin, replaceable "reference editor,"
 * not the only possible one).
 *
 * `sources` is `Array<{type: string, ...params}>` - PLAIN data, the same
 * "no separate per-item Kind-Schema, just plain objects in a field"
 * shape `groupKind.members`/`platformAppsKind.apps` already use - each
 * entry's `type` is looked up in `view-sources.js`'s own
 * `VIEW_SOURCE_ADAPTERS` registry at RESOLVE time (never at write time -
 * writing a View never needs to import/know about the Kind-Schemas its
 * OWN sources happen to use, only their `type` name and params).
 * `itemTemplate` is ordinary Template-shaped HTML (`<qu-slot name="...">`
 * placeholders, the EXACT SAME mechanism `@qu/app-renderer`'s `slots.js`
 * already fills for a Page's own template) stamped ONCE PER RESOLVED
 * ITEM, not once per View - see `view-sources.js`'s own doc comment for
 * which slot names a given source type fills (`title`/`excerpt`/`route`/
 * `timestamp` for the two built-in adapters).
 */
export const viewKind = defineKind('qu-view', {
  fields: {
    sources: { shape: 'atomic', visibility: 'public' }, // Array<{type: string, ...params}> - see view-sources.js.
    sortBy: { shape: 'atomic', visibility: 'public' }, // 'title'|'timestamp'|null - null means "source order, sources in list order".
    sortOrder: { shape: 'atomic', visibility: 'public' }, // 'asc'|'desc'
    limit: { shape: 'atomic', visibility: 'public' }, // number|null
    itemTemplate: { shape: 'text', visibility: 'public' },
    // `route`/`template` are PURELY DESCRIPTIVE bookkeeping - `null` for an embed-only View
    // (`<div data-qu-view="name">` inside some other page's own content, unchanged from before
    // these existed). `dev.js`'s `createView()` is what actually MAKES a View visitable at `route`
    // (auto-creating a plain wrapper `qu-page` there) - this Kind itself has no routing behavior of
    // its own, same "Kind-Schema is just data, the App layer interprets it" posture every other
    // Kind here already has. Stored here (rather than only ever passed to `createView()` and
    // forgotten) purely so `resolveView()` can tell a caller (the CMS editor, primarily) whether -
    // and where - a given View is already visitable, without it having to separately guess/remember.
    route: { shape: 'atomic', visibility: 'public' },
    template: { shape: 'atomic', visibility: 'public' },
  },
  acl: { write: 'content' },
});

/**
 * GLOBAL APP CONTENT (architecture.md §7, REVISED TWICE — first "One relay
 * Space, not two" folded the built-in admin console into the ordinary main
 * Space instead of a separate confidential realm; this revision
 * generalizes that SAME `'relay-admins'`-ACL idea from "the one admin
 * console" to ANY number of relay-admin-administered apps): `qu-admin-app`/
 * `qu-admin-page`/`qu-admin-template`/`qu-admin-style` (Kind names kept for
 * continuity with the admin-console-only revision of this design - they
 * are NOT specific to the built-in admin console any more) are the
 * `acl.write: 'relay-admins'` counterparts to `qu-app`/`qu-page`/
 * `qu-template`/`qu-style` above: content ANY configured relay-admin may
 * write, with NO single distinguished owner - "wir berechtigen in dem
 * Space alle Admins des Relays" (the user's own framing), now for as many
 * GLOBAL apps as a deployment registers, not just one. A `platformAppsKind`
 * entry's `realm: 'global'` (see that Kind's own doc comment) marks an app
 * as globally administered this way, as opposed to an ordinary `realm:
 * 'main'` app owned by one independent app-admin identity
 * (`acl.write: 'content'`, above). The built-in admin console
 * (`bin/install-admin-console.mjs`) is simply the FIRST, conventionally-
 * always-installed global app - `registerApp({prefix: 'admin', realm:
 * 'global'})` - not a framework special case any more: `platform.js`'s own
 * routing treats every `realm: 'global'` entry identically, whatever its
 * prefix.
 *
 * `acl.write: 'relay-admins'` (`@qu/space-core`'s kind-schema.js own doc
 * comment on the mode) is exactly the same primitive `qu-platform-apps`
 * uses: a flat, symmetric, boot-time-configured list (`QU_RELAY_ADMINS`),
 * checked completely independently of ordinary Space membership. Crucially,
 * this means ANY configured relay-admin can install/edit ANY global app's
 * content using their OWN ALREADY-EXISTING identity (the same one their
 * browser already generated and persists via `loadOrCreateIdentity()`/
 * `IDENTITY_STORAGE_KEY`) the moment their pubkey is listed in
 * `QU_RELAY_ADMINS` - no separate "app owner" keypair to generate and
 * import into the browser, no private key ever needs to move between a
 * script and a browser tab, and no per-relay-admin `grantContentWriter()`
 * bootstrapping needed either (unlike `'content'`-ACL, which would need
 * one admin's PRIVATE key to sign a grant for every OTHER admin, and would
 * need re-granting for every FUTURE relay-admin added later - `'relay-
 * admins'` needs neither, by construction).
 *
 * Node ids need no real owner pubkey to stay unique - `globalAppAnchor(prefix)`
 * below derives a fixed, public, NON-cryptographic 32-byte anchor PER
 * PREFIX (nobody's private key corresponds to it - it is never used to
 * verify a signature, only fed through the exact same
 * `deriveOwnerNodeId()`/`deriveContentNodeId()` functions every other Kind
 * here already uses, purely as a stable hash input), so several global
 * apps' content Nodes never collide with each other. See `dev.js`'s
 * `createGlobalApp()`/`createGlobalPage()`/etc. and `resolver.js`/
 * `runtime.js`'s optional `kinds`/`appAdminPub` override for how
 * `ContentResolver`/`AppRuntime` reuse their EXACT existing id-derivation
 * code paths for this, unchanged, just handed an anchor instead of a real
 * app-admin's pubkey - `boot.js`'s `startPlatform()` passes
 * `globalAppAnchor(match.prefix)` for any `realm: 'global'` match, no
 * longer one hardcoded constant.
 */
export async function globalAppAnchor(prefix) {
  return QuCrypto.sha256(new TextEncoder().encode(`qu-global-app:${prefix}`));
}

/** Global-app counterpart to `appManifestKind` - see this file's own "GLOBAL APP CONTENT" doc comment. */
export const adminAppManifestKind = publicMeta(
  defineKind('qu-admin-app', {
    fields: {
      name: { shape: 'atomic', visibility: 'public' },
      version: { shape: 'atomic', visibility: 'public' },
      rootTemplate: { shape: 'atomic', visibility: 'public' },
      defaultRoute: { shape: 'atomic', visibility: 'public' },
      theme: { shape: 'atomic', visibility: 'public' },
      metadata: { shape: 'atomic', visibility: 'public' },
    },
    acl: { write: 'relay-admins' },
  })
);

/** Global-app counterpart to `pageKind`, including its `data` field (kept in lockstep - `resolver.js`'s `resolvePage()` is shared code, used for both `pageKind` and this one via its `kinds` override, and unconditionally reads `data`). Node id = `deriveContentNodeId(globalAppAnchor(prefix), 'qu-admin-page', route)`. */
export const adminPageKind = publicMeta(
  defineKind('qu-admin-page', {
    fields: {
      route: { shape: 'atomic', visibility: 'public' },
      title: { shape: 'atomic', visibility: 'public' },
      template: { shape: 'atomic', visibility: 'public' },
      content: { shape: 'text', visibility: 'public' },
      data: { shape: 'atomic', visibility: 'public' },
      /** Global-app counterpart to `pageKind.style` - see that field's own doc comment (identical reasoning: resolves against `createGlobalStyle()`'s own `adminStyleKind` instead of the self-owned one). */
      style: { shape: 'atomic', visibility: 'public' },
      /** Global-app counterpart to `pageKind.status` - identical reasoning/scope. */
      status: { shape: 'atomic', visibility: 'public' },
    },
    acl: { write: 'relay-admins' },
  })
);

/** Global-app counterpart to `templateKind`. Node id = `deriveContentNodeId(globalAppAnchor(prefix), 'qu-admin-template', name)`. */
export const adminTemplateKind = publicMeta(
  defineKind('qu-admin-template', {
    fields: {
      html: { shape: 'text', visibility: 'public' },
    },
    acl: { write: 'relay-admins' },
  })
);

/** Global-app counterpart to `styleKind`. Node id = `deriveContentNodeId(globalAppAnchor(prefix), 'qu-admin-style', name)`. */
export const adminStyleKind = publicMeta(
  defineKind('qu-admin-style', {
    fields: {
      css: { shape: 'text', visibility: 'public' },
    },
    acl: { write: 'relay-admins' },
  })
);

/**
 * Global-app counterpart to `routeRegistryKind` - `acl.write: 'relay-admins'`
 * instead of `'named'`, since a global app has NO single owner identity to
 * self-certify a `'named'`-ACL registry against: ANY configured relay-admin
 * may add a route here, not just whichever one happened to create it (the
 * SAME reasoning `platformAppsKind`'s own doc comment gives for why
 * `qu-platform-apps` itself isn't `'named'`-ACL either). One Node id per
 * global app - `deriveOwnerNodeId(globalAppAnchor(prefix), 'qu-admin-
 * route-registry')` - shared by every relay-admin who publishes a route
 * under that prefix. `@qu/app-shell`'s `live-app-resolver.js` watches this
 * Node for EVERY currently-known global app (the same reactive idea it
 * already applies to `qu-platform-apps` itself), so a relay-admin creating
 * a brand-new page under an EXISTING global app needs no relay restart -
 * unlike `templateRegistryKind`/`styleRegistryKind`, this one has no global
 * counterpart at all (templates/styles are a smaller, deliberately more
 * static set for global apps - not discovered by watching a live registry
 * the way page routes are). A new template/style name still needs no relay
 * restart, just an upfront declaration instead of a registry to watch -
 * `platformAppsKind`'s own `globalTemplateNames`/`globalStyleNames` fields.
 */
export const adminRouteRegistryKind = publicMeta(
  defineKind('qu-admin-route-registry', {
    fields: {
      /** `Array<{route: string, title: string}>` - see resolver.js's `resolveRoutes()`. */
      routes: { shape: 'list', visibility: 'public' },
    },
    acl: { write: 'relay-admins' },
  })
);

/**
 * Global-app counterpart to `viewKind` - same fields, `acl.write:
 * 'relay-admins'` instead of `'content'`, anchored the same way every other
 * `qu-admin-*` Kind is (`deriveContentNodeId(globalAppAnchor(prefix),
 * 'qu-admin-view', name)`). Added specifically so the Guestbook/Blog/Forum
 * reference apps (`@qu/app-shell`) could become `realm: 'global'` apps
 * without losing Views: a `realm: 'main'` app's Views/Pages are
 * content-addressed by (owner identity, kind, path) - `viewKind` fine for
 * ONE independently-owned app, but fatally wrong for "install as many of
 * these as you like under different prefixes, all from the SAME
 * relay-admin session" (every such install would derive the exact SAME
 * node id for its own index page/View, silently clobbering each other -
 * the real, observed bug this Kind exists to close). `resolver.js`'s
 * `resolveView()`/`view-actions.js`'s `wireViews()` accept a `kinds.viewKind`
 * override the exact same way they already accept one for `pageKind` - see
 * `dev.js`'s `createGlobalView()`/`editGlobalView()` for the matching
 * write-side counterparts. Previously left as a documented, deliberate gap
 * (`@qu/app-shell`'s `cms-actions.js`'s own `wireViewEditor()` used to be a
 * no-op in global mode) - not any more.
 */
export const adminViewKind = publicMeta(
  defineKind('qu-admin-view', {
    fields: {
      sources: { shape: 'atomic', visibility: 'public' },
      sortBy: { shape: 'atomic', visibility: 'public' },
      sortOrder: { shape: 'atomic', visibility: 'public' },
      limit: { shape: 'atomic', visibility: 'public' },
      itemTemplate: { shape: 'text', visibility: 'public' },
      route: { shape: 'atomic', visibility: 'public' },
      template: { shape: 'atomic', visibility: 'public' },
    },
    acl: { write: 'relay-admins' },
  })
);
