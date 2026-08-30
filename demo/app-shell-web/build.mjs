/**
 * APP SHELL WEB BUNDLE BUILD (demo) — thin wrapper around `@qu/app-shell`'s
 * own `build.mjs` (`buildAppShellBundle()`/`renderIndexHtml()` - see that
 * file's own doc comment for the full "why split into two pieces"), just
 * writing the result into `demo/app-shell-web/` and baking in the DEMO's
 * own persisted `app-admin` identity. The production entrypoint
 * (`packages/app-shell/relay-server.js`) uses the exact same two functions
 * directly, reading `QU_APP_ADMIN_PUB` instead of a demo identity file -
 * this is not a separate implementation, only a separate CALLER.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { buildAppShellBundle, renderIndexHtml } from '@qu/app-shell/build';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * @param {{appAdminPub: Uint8Array}} params
 * @returns {Promise<{outfile: string, indexFile: string}>}
 */
export async function buildAppShellWebBundle({ appAdminPub }) {
  const { outfile } = await buildAppShellBundle({ outDir: join(here, 'dist') });
  const indexFile = join(here, 'index.html');
  await writeFile(indexFile, renderIndexHtml({ appAdminPub }), 'utf8');
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
