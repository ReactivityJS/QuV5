/**
 * BROWSER BUNDLE BUILD — bundles `demo/web/main.js` (the browser client:
 * `@qu/core`, `@qu/space-core`, `@qu/space-transport`'s browser-safe
 * `ws-client-transport` subpath, `@qu/events`, and `yjs` itself) into one
 * self-contained ESM file, `demo/web/dist/bundle.js`, which
 * `demo/relay.mjs` serves as a static asset at `/bundle.js`.
 *
 * Run standalone (`npm run build:web`) or imported and called by
 * `demo/relay.mjs` at startup (see that file) - either way produces the
 * same output, so there's no separate "did you remember to build the
 * frontend" step for anyone just running `npm run demo:relay`.
 *
 * `platform: 'browser'` matters: the DEFAULT `main.js` import graph is
 * entirely browser-safe already (see `ws-client-transport.js`'s own doc
 * comment on why that subpath exists specifically to avoid `node:crypto`),
 * but `platform: 'browser'` is what makes esbuild refuse to silently
 * accept a future accidental Node-only import instead of bundling
 * something broken.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));

/** @returns {Promise<{outfile: string}>} */
export async function buildWebBundle() {
  const outfile = join(here, 'dist', 'bundle.js');
  await esbuild.build({
    entryPoints: [join(here, 'main.js')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
    logLevel: 'silent', // relay.mjs/this script's own caller prints a one-line summary instead - see below.
  });
  return { outfile };
}

// Only run the build (and print) when this file is executed directly (`npm run build:web`) -
// importing buildWebBundle() from relay.mjs must NOT also trigger this console output.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { outfile } = await buildWebBundle();
  console.log(`[build:web] bundled -> ${outfile}`);
}
