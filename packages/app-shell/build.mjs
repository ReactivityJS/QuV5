/**
 * BUILD — bundles `src/shell.js` for the browser (esbuild) and renders the
 * `index.html` a relay serves alongside it. Split into two DELIBERATELY
 * separate, pure pieces:
 *
 *   - `buildAppShellBundle()` — pubkey-agnostic JS bundling, safe to run
 *     ONCE ahead of time (e.g. at Docker BUILD time, the same way
 *     `demo/web/build.mjs` bundles the chat demo's `main.js` - see that
 *     file's own doc comment on why that avoids needing a bundler in the
 *     runtime image).
 *   - `renderIndexHtml({appAdminPub})` — a pure string template, no I/O.
 *     THIS piece is inherently PER-DEPLOYMENT (it embeds one specific
 *     app-admin's pubkey into `<qu-app-shell app-admin-pub="...">, docs
 *     §5) - it has to run at BOOT time from whatever pubkey THIS
 *     deployment is configured with, never baked into a shared image ahead
 *     of time. `appAdminPub: null` renders a plain SETUP page instead -
 *     "an empty App Shell" (docs §3/§32) needs to say so on the page,
 *     not silently serve a shell that can never resolve a manifest.
 *
 * Used by two callers: `demo/app-shell-web/build.mjs` (the in-repo demo,
 * which also writes an on-disk identity file for convenience) and this
 * package's own `relay-server.js` (the production entrypoint, which reads
 * the app-admin pubkey from `QU_APP_ADMIN_PUB` instead).
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as esbuild from 'esbuild';
import { QuCrypto } from '@qu/core';

const here = dirname(fileURLToPath(import.meta.url));

/** @param {{outDir?: string}} [params] @returns {Promise<{outfile: string}>} */
export async function buildAppShellBundle({ outDir = join(here, 'dist') } = {}) {
  const outfile = join(outDir, 'bundle.js');
  await esbuild.build({
    entryPoints: [join(here, 'src', 'shell.js')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    logLevel: 'silent', // callers print their own one-line summary instead.
  });
  return { outfile };
}

/** @param {{appAdminPub: Uint8Array|null}} params @returns {string} full `index.html` markup. */
export function renderIndexHtml({ appAdminPub }) {
  if (!appAdminPub) {
    return `<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8" />
    <title>Qu App Shell</title>
  </head>
  <body style="font-family: sans-serif; max-width: 40rem; margin: 3rem auto; line-height: 1.5;">
    <h1>Qu App Shell</h1>
    <p>Dieser Relay liefert die App Shell aus, aber es ist noch keine Anwendung
      zugeordnet (<code>QU_APP_ADMIN_PUB</code> ist nicht gesetzt).</p>
    <ol>
      <li>Erzeuge eine App-Admin-Identity (ein normales Ed25519/X25519-Schlüsselpaar,
        z.B. mit <code>QuCrypto.generateKeypair()</code> aus <code>@qu/core</code>) -
        der private Schlüssel bleibt bei dir, dieser Relay bekommt ihn nie zu sehen.</li>
      <li>Setze deren öffentlichen Signing-Schlüssel (base64) als
        <code>QU_APP_ADMIN_PUB</code> in der Relay-Konfiguration und starte den
        Relay neu.</li>
      <li>Installiere eine erste Anwendung aus einem separaten Prozess, der den
        privaten Schlüssel hält:
        <pre>node demo/install-app-shell-demo.mjs --relay wss://&lt;dieser-host&gt; --dir &lt;pfad-zu-deiner-app-admin-identity&gt;</pre>
      </li>
    </ol>
    <p>Siehe <code>docs/app-shell-arbeitsauftrag.md</code> und <code>architecture.md</code> §7.</p>
  </body>
</html>
`;
  }
  return `<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Qu</title>
  </head>
  <body>
    <qu-app-shell app-admin-pub="${QuCrypto.toBase64(appAdminPub)}"></qu-app-shell>

    <script type="module" src="/bundle.js"></script>
  </body>
</html>
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { outfile } = await buildAppShellBundle({});
  console.log(`[build] bundled -> ${outfile}`);
}
