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
    /** `Array<{route: string, title: string}>` - see resolver.js's `resolveRoutes()`. */
    routes: { shape: 'list', visibility: 'public' },
  },
  acl: { write: 'named' },
});

/**
 * THE PLATFORM APP REGISTRY (docs/app-shell-arbeitsauftrag.md §19-21) - one
 * per relay-admin, mapping a URL PATH PREFIX to the `qu-app` that owns it:
 * `Array<{prefix: string, appAdminPub: string (base64), name: string}>`.
 * This is what lets ONE App Shell deployment host SEVERAL independent apps
 * (a messenger at `#/messages`, a forum at `#/forum`, ...), each with its
 * OWN app-admin identity/content, without the Shell or the Relay ever
 * hardcoding which apps exist - see `platform.js`'s `PlatformRuntime` for
 * how a route gets split into `(prefix, subPath)` and delegated to the
 * matching app's own `AppRuntime`.
 *
 * Same singleton-per-owner shape as `appManifestKind`/`routeRegistryKind`
 * (`acl.write: 'named'`, self-certifying id, no membership gate to even
 * discover it) - a relay-admin is just another identity, not a relay-side
 * superuser (docs §19: "Das Relay soll nicht einfach selbst als
 * allmächtiger Benutzer auftreten"). Registering an app here does NOT
 * grant its app-admin anything beyond a routing slot - each app's own
 * content stays governed entirely by ITS OWN `acl.write`/`grantWriter()`,
 * exactly as if it were the only app on the relay.
 *
 * ONLY ADDITIVE for now - `ListField` (see `@qu/space-core`'s `field.js`)
 * has no removal primitive, so there is no `unregisterApp()`; the Dev
 * API/admin UI built on this can only ever grow the list. Real, separate
 * work if "unmount an app" is ever needed (see docs' own "Nicht-Ziele").
 */
export const platformAppsKind = defineKind('qu-platform-apps', {
  fields: {
    /**
     * `Array<{prefix: string, appAdminPub: string|null, name: string, realm: 'main'|'admin'}>`
     * - see `dev.js`'s `registerApp()`/`platform.js`'s `PlatformRuntime`.
     * `realm: 'admin'` entries (`appAdminPub: null`) route into the
     * confidential admin realm (see this file's own "THE ADMIN REALM" doc
     * comment) instead of an ordinary owner-pubkey-addressed app - the
     * SAME registry, the SAME `'public'`-visibility mapping (an alias
     * existing, and which realm it points at, is not itself a secret -
     * only the realm's own CONTENT is), no separate mechanism. This
     * mapping is itself only a convenience: `PlatformRuntime.resolveForPath()`
     * falls back to treating an UNREGISTERED prefix as a literal
     * base64url-encoded owner pubkey when nothing here matches, so no
     * app-admin needs a relay-admin's cooperation just to be reachable at
     * all - registering a prefix here only ever adds a prettier alias.
     */
    apps: { shape: 'list', visibility: 'public' },
  },
  acl: { write: 'named' },
});

/** One page (docs §7). Node id = `deriveContentNodeId(ownerPub, 'qu-page', route)`. Write-ACL: the owner, plus anyone explicitly `grantWriter(id, 'qu-page', granteePub, {path: route})`ed - see kind-schema.js's own "THE 'content' ACL mode" doc comment. */
export const pageKind = publicMeta(
  defineKind('qu-page', {
    fields: {
      route: { shape: 'atomic', visibility: 'public' },
      title: { shape: 'atomic', visibility: 'public' },
      template: { shape: 'atomic', visibility: 'public' }, // a qu-template PATH
      content: { shape: 'text', visibility: 'public' }, // real Y.Text - collaborative editing "for free" (docs §7)
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
 * THE ADMIN REALM (architecture.md §7 "The Platform layer", revised) — a
 * genuinely CONFIDENTIAL counterpart to the five Kinds above, for content
 * only a relay's own admins may ever read: same fields/shapes as
 * `qu-app`/`qu-page`/`qu-template`/`qu-style`/`qu-platform-apps`, but every
 * field keeps `defineKind()`'s DEFAULT `visibility: 'encrypted'` (no
 * `publicMeta()` wrapper - that wrapper exists specifically to make
 * `qu-page` etc. PLAINTEXT for anyone who joins the relay's ordinary,
 * open-join Space; admin content wants the opposite). Encryption alone does
 * nothing without a correspondingly SMALL, curated recipient list - see
 * `packages/app-shell/relay-server.js`'s own "ADMIN REALM" doc comment: the
 * admin realm is served from a wholly SEPARATE `Space`/relay-forwarder
 * instance, whose `members` are the relay's configured admin identities
 * ONLY (never open-join), so `'encrypted'`-visibility content here is
 * sealed for exactly that small list - an ordinary visitor of the main,
 * public Space is never a member of THIS one and so can never decrypt
 * anything here, not even with the relay's own cooperation (see
 * envelope.js - the relay itself never holds an X25519 private key).
 *
 * `acl.write: 'members'` here (not `'named'`, unlike `qu-app`/
 * `qu-platform-apps` above) is DELIBERATE: the admin realm has no single
 * "owner" identity - "wir berechtigen in dem Space alle Admins des
 * Relays" (the user's own framing) - any configured admin should be able
 * to manage it, exactly the same flat-membership-is-the-ACL model
 * `qu-page`/`qu-template`/`qu-style` already use for an ordinary app's
 * OWN co-authors, just scoped to a members list that IS the admin set
 * instead of "whoever joined this relay."
 *
 * Node ids need no real owner pubkey to stay unique - there is exactly
 * ONE admin realm per relay, so `ADMIN_REALM_ANCHOR` is a fixed, public,
 * NON-cryptographic 32-byte constant (nobody's private key corresponds to
 * it - it is never used to verify a signature, only fed through the exact
 * same `deriveOwnerNodeId()`/`deriveContentNodeId()` functions every other
 * Kind here already uses, purely as a stable hash input) - see
 * `dev.js`'s `createAdminApp()`/`createAdminPage()`/etc. and
 * `resolver.js`/`runtime.js`'s optional `kinds` override for how
 * `ContentResolver`/`AppRuntime` reuse their EXACT existing id-derivation
 * code paths for this, unchanged, just handed this constant instead of a
 * real app-admin's pubkey.
 */
export const ADMIN_REALM_ANCHOR = new Uint8Array(32);
ADMIN_REALM_ANCHOR.set(new TextEncoder().encode('qu-admin-realm'));

/** Admin-realm counterpart to `appManifestKind` - see this file's own "THE ADMIN REALM" doc comment. */
export const adminAppManifestKind = defineKind('qu-admin-app', {
  fields: {
    name: { shape: 'atomic' },
    version: { shape: 'atomic' },
    rootTemplate: { shape: 'atomic' },
    defaultRoute: { shape: 'atomic' },
    theme: { shape: 'atomic' },
    metadata: { shape: 'atomic' },
  },
  acl: { write: 'members' },
});

/** Admin-realm counterpart to `pageKind`. Node id = `deriveContentNodeId(ADMIN_REALM_ANCHOR, 'qu-admin-page', route)`. */
export const adminPageKind = defineKind('qu-admin-page', {
  fields: {
    route: { shape: 'atomic' },
    title: { shape: 'atomic' },
    template: { shape: 'atomic' },
    content: { shape: 'text' },
  },
  acl: { write: 'members' },
});

/** Admin-realm counterpart to `templateKind`. Node id = `deriveContentNodeId(ADMIN_REALM_ANCHOR, 'qu-admin-template', name)`. */
export const adminTemplateKind = defineKind('qu-admin-template', {
  fields: {
    html: { shape: 'text' },
  },
  acl: { write: 'members' },
});

/** Admin-realm counterpart to `styleKind`. Node id = `deriveContentNodeId(ADMIN_REALM_ANCHOR, 'qu-admin-style', name)`. */
export const adminStyleKind = defineKind('qu-admin-style', {
  fields: {
    css: { shape: 'text' },
  },
  acl: { write: 'members' },
});
