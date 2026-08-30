/**
 * APP SHELL WEB BUNDLE BUILD — bundles `packages/app-shell/src/shell.js`
 * (the ONE fixed piece of application JavaScript a Relay serves - see that
 * file's own doc comment) into `demo/app-shell-web/dist/bundle.js`, and
 * generates `demo/app-shell-web/index.html` with the running demo's real
 * app-admin pubkey baked into `<qu-app-shell app-admin-pub="...">` - the
 * one thing that tells this otherwise-generic Shell which application to
 * load (docs/app-shell-arbeitsauftrag.md §5). Same "no separate frontend
 * build step" posture `demo/web/build.mjs` already established for the
 * chat demo - `app-shell-relay.mjs` calls this at startup.
 *
 * `packages/app-shell/public/index.html` is the STATIC reference markup
 * (its own doc comment says as much) - this is the one place that turns it
 * into something an actual relay can serve, by substituting in a REAL
 * pubkey and pointing the script tag at `/bundle.js` (the path
 * `@qu/space-transport`'s `relay-app-server.js` STATIC_FILES map already
 * serves, unmodified, for the chat demo too).
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import * as esbuild from 'esbuild';
import { QuCrypto } from '@qu/core';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * @param {{appAdminPub: Uint8Array}} params
 * @returns {Promise<{outfile: string, indexFile: string}>}
 */
export async function buildAppShellWebBundle({ appAdminPub }) {
  const outfile = join(here, 'dist', 'bundle.js');
  await esbuild.build({
    entryPoints: [join(dirname(dirname(here)), 'packages', 'app-shell', 'src', 'shell.js')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    logLevel: 'silent', // app-shell-relay.mjs prints its own one-line summary instead - see below.
  });

  const indexFile = join(here, 'index.html');
  const html = `<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Qu App Shell Demo</title>
  </head>
  <body>
    <qu-app-shell app-admin-pub="${QuCrypto.toBase64(appAdminPub)}"></qu-app-shell>

    <script type="module" src="/bundle.js"></script>
  </body>
</html>
`;
  await writeFile(indexFile, html, 'utf8');

  return { outfile, indexFile };
}

// Only run (and print) when executed directly - importing buildAppShellWebBundle() from
// app-shell-relay.mjs must NOT also trigger this console output (same pattern demo/web/build.mjs uses).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { ensureIdentity } = await import('../lib/identity.mjs');
  const dir = join(dirname(here), '.app-shell-identities');
  const appAdmin = await ensureIdentity('app-admin', dir);
  const { outfile, indexFile } = await buildAppShellWebBundle({ appAdminPub: appAdmin.signingPub });
  console.log(`[build:app-shell-web] bundled -> ${outfile}\n[build:app-shell-web] index -> ${indexFile}`);
}
