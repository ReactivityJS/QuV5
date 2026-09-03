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
 *   - `renderIndexHtml({appAdminPub, platformMode})` — a pure string
 *     template, no I/O. THIS piece is inherently PER-DEPLOYMENT (it embeds
 *     one specific identity's pubkey into `<qu-app-shell app-admin-pub="...">`
 *     or a bare `<qu-app-shell relay-admin-pub>` platform marker, docs
 *     §5/§19-21) - it has to run at BOOT time from whatever THIS deployment
 *     is configured with, never baked into a shared image ahead of time.
 *     `platformMode` takes priority over `appAdminPub` when both are given
 *     (a platform deployment, `startPlatform()`, serves however many apps
 *     its `qu-platform-apps` registry lists - see `shell.js`'s own doc
 *     comment on the same priority). `relay-admin-pub`'s VALUE carries no
 *     meaning any more (`platformAppsKind` is now `'relay-admins'`-ACL,
 *     checked against the boot-time `QU_RELAY_ADMINS` list, never against
 *     one distinguished pubkey embedded in this markup - see
 *     `@qu/app-core`'s `kinds.js` own doc comment) - the attribute's mere
 *     PRESENCE is what `shell.js` reads, to decide `startPlatform()` vs
 *     `startApp()`. Neither set renders a plain SETUP page instead - "an
 *     empty App Shell" (docs §3/§32) needs to say so on the page, not
 *     silently serve a shell that can never resolve a manifest.
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

/** @param {{appAdminPub?: Uint8Array|null, platformMode?: boolean}} params @returns {string} full `index.html` markup. */
export function renderIndexHtml({ appAdminPub = null, platformMode = false } = {}) {
  if (!appAdminPub && !platformMode) {
    return `<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8" />
    <title>Qu App Shell</title>
  </head>
  <body style="font-family: sans-serif; max-width: 40rem; margin: 3rem auto; line-height: 1.5;">
    <h1>Qu App Shell</h1>
    <p>Dieser Relay liefert die App Shell aus, aber es ist noch keine Anwendung
      und kein Relay-Admin zugeordnet (weder <code>QU_APP_ADMIN_PUB</code> noch
      <code>QU_RELAY_ADMINS</code> ist gesetzt).</p>

    <h2>Deine Browser-Identity</h2>
    <p>Diese Seite lädt bereits die App-Shell-Bundle (<code>/bundle.js</code>) und
      erzeugt/lädt damit automatisch eine Identity in diesem Browser - genau der
      "remember me"-Mechanismus (<code>loadOrCreateIdentity()</code>), den ein
      späterer Besuch als Visitor sowieso schon nutzt. Der private Schlüssel bleibt
      ausschließlich in <code>localStorage</code> dieses Browsers - dieser Relay
      bekommt ihn nie zu sehen.</p>
    <p>Signing-Pubkey (für <code>QU_APP_ADMIN_PUB</code> oder als Eintrag in
      <code>QU_RELAY_ADMINS</code>): <code data-qu-pub>lädt…</code></p>
    <p>X25519-Pubkey (für <code>QU_MEMBERS_JSON</code>, als
      <code>{"pub":"…","xPub":"…"}</code>): <code data-qu-xpub>lädt…</code></p>
    <p>Für Skripte/die Konsole steht <code>window.Qu</code> bereit -
      <code>Qu.pub</code>/<code>Qu.xPub</code> (bereits oben angezeigt),
      <code>Qu.identity</code> (die vollen Schlüssel), oder
      <code>await Qu.regenerate()</code> für eine komplett neue Identity
      (unwiderruflich - eine bereits irgendwo hinterlegte Pubkey wird dadurch
      für diesen Browser unbrauchbar).</p>

    <h2>Nächste Schritte</h2>
    <ol>
      <li>Am schnellsten: <pre>npm run bootstrap:platform</pre> - erzeugt eine EIGENE
        (server-seitige) Identity und gibt beim ersten Lauf den nötigen
        <code>QU_RELAY_ADMINS</code>-Wert zum Einfügen in DEINE
        Deployment-Config aus (egal ob Compose, <code>docker stack</code>,
        Kubernetes, ...) - schreibt selbst nichts. Nach dem Neu-Deployen mit
        diesem Wert installiert ein zweiter Lauf Admin-Konsole + eine
        CMS-verwaltete Demo-Shell-App. Siehe
        <code>packages/app-shell/bin/bootstrap-platform.mjs</code>.</li>
      <li>Von Hand, mit DEINER Browser-Identity von oben: für EINE einzelne App setze
        deren Pubkey als <code>QU_APP_ADMIN_PUB</code>. Für eine PLATTFORM aus mehreren
        Apps unter Pfad-Präfixen: setze stattdessen <code>QU_RELAY_ADMINS</code> (ein
        JSON-Array reiner base64-Pubkeys, z.B. <code>["&lt;pub1&gt;","&lt;pub2&gt;"]</code>,
        ein Eintrag pro Relay-Admin) - siehe <code>architecture.md</code> §7. Jeder gelistete
        Relay-Admin administriert damit sowohl die App-Registrierung als auch die
        eingebaute <code>#/admin</code>-Konsole mit GENAU DIESER Browser-Identity - keine
        separate Admin-Identity nötig. Jeder Relay-Admin kann anschließend (z.B. über
        <code>#/admin</code>) weitere Apps registrieren, ganz ohne weiteren Relay-Neustart.
        Danach den Relay neu starten (nur für diesen allerersten
        <code>QU_RELAY_ADMINS</code>-Wert nötig).</li>
      <li>EINZELNE App: installiere sie aus einem separaten Prozess, der den
        privaten Schlüssel hält:
        <pre>node demo/install-app-shell-demo.mjs --relay wss://&lt;dieser-host&gt; --dir &lt;pfad-zu-deiner-app-admin-identity&gt;</pre>
        PLATTFORM: jede App ist ohne Registrierung bereits unter ihrer eigenen
        Owner-Id erreichbar; die eingebaute <code>#/admin</code>-Konsole selbst
        wird einmalig über
        <pre>node packages/app-shell/bin/install-admin-console.mjs --relay wss://&lt;dieser-host&gt;</pre>
        installiert (siehe dessen eigener Kommentar).
      </li>
    </ol>
    <p>Siehe <code>docs/app-shell-arbeitsauftrag.md</code> und <code>architecture.md</code> §7.</p>

    <script type="module" src="/bundle.js"></script>
  </body>
</html>
`;
  }
  const rootAttr = platformMode ? 'relay-admin-pub' : `app-admin-pub="${QuCrypto.toBase64(appAdminPub)}"`;
  return `<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Qu</title>
  </head>
  <body>
    <qu-app-shell ${rootAttr}></qu-app-shell>

    <script type="module" src="/bundle.js"></script>
  </body>
</html>
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { outfile } = await buildAppShellBundle({});
  console.log(`[build] bundled -> ${outfile}`);
}
