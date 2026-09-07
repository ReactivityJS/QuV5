# /apps — file-based reference apps

This directory is for apps that genuinely need CODE, not just CMS content
(a Page/Template + a `qu-list`/`qu-bind`/`qu-view` data source) — the
dividing line the project settled on: if an app's own Template can declare
where its data comes from purely through those attributes, it belongs in
Storage as an ordinary CMS-authored app (see `packages/app-shell`'s
`guestbook-bundle.js`/`blog-bundle.js`/`forum-bundle.js` — none of them live
here, on purpose, they're fully expressible that way). An app that needs
real behavior beyond that (live geolocation, a game loop, a custom protocol,
...) gets a folder here instead.

**Convention**: `apps/<name>/index.js` default-exports a descriptor:

```js
export default {
  key: 'chat',           // stable id - matches the folder name by convention
  label: 'Chat',         // shown in the admin console's install UI
  install,               // (space, {prefix}) => Promise<void> - first-time content
  update,                // optional - (space, {prefix}) => Promise<void> - idempotent re-apply, see bundle-upsert.js
  version: 1,            // optional - bumped when install/update's own content changes
  sharedLists: (prefix) => [...],   // optional - shared-list names this app's Kinds use (dev.js's registerApp() own doc comment on why the relay needs to know these upfront)
  viewNames: (prefix) => [...],     // optional - adminViewKind names this app's global content uses
  personalBundle: undefined,        // optional - see guestbook-bundle.js's own doc comment; only for apps with a personal-instance story
  wire,                  // optional - ({mountEl, doc, space}) => Promise<void> - the app's own framework-provided interactivity (installed-apps-actions.js's own "content stays inert markup" posture), called after every render regardless of which page is showing (a correct no-op on any page that isn't its own)
};
```

Same shape `packages/app-shell/src/admin-actions.js`'s own (hardcoded)
`APP_INSTALLERS` map entries already use for Guestbook/Blog/Forum - an app
here is administered identically, through the same "Beispiel-App
installieren" UI, no special-casing.

**Discovery**: `packages/app-shell/apps-registry.mjs`'s `generateAppsRegistry()`
scans this directory at build time (called from `build.mjs`'s
`buildAppShellBundle()`, so both `relay-server.js` at boot and
`demo/app-shell-web/build.mjs` pick up whatever's here automatically - no
code changes elsewhere needed to add a new app) and writes a generated
static-import file, `packages/app-shell/apps-registry.generated.js` -
COMMITTED, not git-ignored (`node --test` runs against plain source, never
through a real build first, so a committed copy is what tests see - run
`npm run apps:registry` after adding/removing an `/apps/*` folder to
refresh it before testing locally; `npm test` already does this itself via
its own `pretest` script). A folder with no `index.js` (or one that fails
to import) is skipped with a console warning, never a hard build failure.

**Docker**: `packages/app-shell/Dockerfile` already `COPY . .`s the whole
repo root before building, so anything added here ships in the image with
zero Dockerfile changes.

**IMPORTANT - a REAL esbuild trap this convention runs into**: an
`/apps/*` app's own code (`bundle.js`/`actions.js`/whatever) ends up
bundled into the BROWSER (`@qu/app-shell`'s `shell.js` reaches it
transitively, via `wireInstalledApps()` -> the generated registry -> your
`index.js`). Importing anything from `@qu/app-shell`'s own PACKAGE ROOT
(`import { x } from '@qu/app-shell'`) pulls in that package's ENTIRE
public surface, including server/test-only code (`boot.js`'s
`startPlatform()`, `identity.js`, `live-app-resolver.js`) that transitively
needs `node:fs`/`node:path` - esbuild's `platform: 'browser'` build then
fails outright ("Could not resolve 'node:fs/promises'"), a real, observed
failure, not a hypothetical one (`apps/chat/actions.js`'s own doc comment
has the exact story). Always import a NARROW, browser-safe SUBPATH instead
- e.g. `@qu/app-shell/verify-writes`, `@qu/app-shell/bundle-upsert` - the
same rule `packages/app-shell/src/shell.js`'s own imports already follow
(never that package's own root either, e.g.
`@qu/space-transport/ws-client-transport`). If you need something from
`@qu/app-shell` that has no narrow subpath exported yet, add one to that
package's own `package.json` `exports` map rather than reaching for the
root.
