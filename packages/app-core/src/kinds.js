/**
 * APPLICATION CONTENT KINDS — see docs/app-shell-arbeitsauftrag.md §5-14.
 * These are ordinary `@qu/space-core` Kind-Schemas, nothing more: the App
 * Runtime interprets what they mean, `@qu/space-core`/the Relay never do
 * (architecture.md §1, "Relay bleibt Application-blind").
 *
 * TWO DIFFERENT ACL SHAPES, chosen by CARDINALITY, not by "how important"
 * a Kind is:
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
 *     route/template-name/style-name). `acl.write: 'members'` is what lets
 *     `Space.createNode()` honor a caller-supplied, content-addressed id
 *     (see `content-id.js`'s own doc comment for the full "why") instead of
 *     collapsing every page onto the same self-certifying Node.
 *
 * `publicMeta()` BELOW IS NOT COSMETIC - it fixes a real bug found while
 * building the first real-relay App Shell demo (`demo/app-shell-relay.mjs`/
 * `demo/install-app-shell-demo.mjs`): `defineKind()` always derives
 * `'members'`-mode Kind's META-STAMP visibility as `'encrypted'` (see
 * kind-schema.js's own doc comment), REGARDLESS of what visibility the
 * Kind's own FIELDS declare. A Node's meta-stamp is its Y.Doc's very FIRST
 * update (`node.js`'s `stampMeta()`), sealed for whoever was in the
 * WRITER's OWN member list AT THAT MOMENT. Because Yjs integrates one
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
 * still `'members'` (so `Space.createNode()` still honors a
 * content-addressed `{id}`) but whose `metaVisibility` is overridden to
 * `'public'` gets exactly what this Kind actually needs: content-addressed
 * ids for write-ACL purposes, `'public'`-mode envelopes (no recipient list,
 * no decryption, no gap possible) for EVERY write including the founding
 * one. `Space.compactNode()`'s own uniform-visibility check (see space.js)
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

/** One page (docs §7). Node id = `deriveContentNodeId(ownerPub, 'qu-page', route)`. */
export const pageKind = publicMeta(
  defineKind('qu-page', {
    fields: {
      route: { shape: 'atomic', visibility: 'public' },
      title: { shape: 'atomic', visibility: 'public' },
      template: { shape: 'atomic', visibility: 'public' }, // a qu-template PATH
      content: { shape: 'text', visibility: 'public' }, // real Y.Text - collaborative editing "for free" (docs §7)
    },
    acl: { write: 'members' },
  })
);

/** One template (docs §8). Node id = `deriveContentNodeId(ownerPub, 'qu-template', name)`. */
export const templateKind = publicMeta(
  defineKind('qu-template', {
    fields: {
      html: { shape: 'text', visibility: 'public' },
    },
    acl: { write: 'members' },
  })
);

/** One style sheet (docs §11). Node id = `deriveContentNodeId(ownerPub, 'qu-style', name)`. */
export const styleKind = publicMeta(
  defineKind('qu-style', {
    fields: {
      css: { shape: 'text', visibility: 'public' },
    },
    acl: { write: 'members' },
  })
);
