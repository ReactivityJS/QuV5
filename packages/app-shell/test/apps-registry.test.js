/**
 * FILE-BASED APP DISCOVERY — `apps-registry.mjs`'s own top doc comment on
 * the full "why generated, why here" reasoning. Exercises `generateAppsRegistry()`
 * against a throwaway temp directory - never the repo's real `/apps` (that's
 * `admin-actions.js`'s own tests' job, through the real, committed
 * `apps-registry.generated.js`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateAppsRegistry } from '../apps-registry.mjs';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'qu-apps-registry-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('generateAppsRegistry() discovers every /apps/<name>/index.js and writes a static-import registry, in deterministic (sorted) order', async () => {
  await withTempDir(async (dir) => {
    const appsDir = join(dir, 'apps');
    await mkdir(join(appsDir, 'zebra'), { recursive: true });
    await writeFile(join(appsDir, 'zebra', 'index.js'), 'export default { key: "zebra", label: "Zebra" };\n');
    await mkdir(join(appsDir, 'alpha'), { recursive: true });
    await writeFile(join(appsDir, 'alpha', 'index.js'), 'export default { key: "alpha", label: "Alpha" };\n');

    const outFile = join(dir, 'out', 'apps-registry.generated.js');
    const { names } = await generateAppsRegistry({ appsDir, outFile });
    assert.deepEqual(names, ['alpha', 'zebra'], 'sorted, not readdir()\'s own OS-dependent order');

    const generated = await import(outFile);
    assert.deepEqual(
      generated.discoveredApps.map((a) => a.key),
      ['alpha', 'zebra']
    );
  });
});

test('generateAppsRegistry() skips a folder with no index.js, without failing the whole scan', async () => {
  await withTempDir(async (dir) => {
    const appsDir = join(dir, 'apps');
    await mkdir(join(appsDir, 'incomplete'), { recursive: true }); // no index.js in here.
    await mkdir(join(appsDir, 'real'), { recursive: true });
    await writeFile(join(appsDir, 'real', 'index.js'), 'export default { key: "real", label: "Real" };\n');

    const outFile = join(dir, 'apps-registry.generated.js');
    const { names } = await generateAppsRegistry({ appsDir, outFile });
    assert.deepEqual(names, ['real']);
  });
});

test('generateAppsRegistry() writes an empty registry (never throws) when the /apps directory does not exist at all', async () => {
  await withTempDir(async (dir) => {
    const outFile = join(dir, 'apps-registry.generated.js');
    const { names } = await generateAppsRegistry({ appsDir: join(dir, 'does-not-exist'), outFile });
    assert.deepEqual(names, []);
    const contents = await readFile(outFile, 'utf8');
    assert.match(contents, /discoveredApps = \[\]/);
  });
});

test('generateAppsRegistry() is safe to re-run - a folder REMOVED since the last run disappears from the regenerated registry, not just accumulates', async () => {
  await withTempDir(async (dir) => {
    const appsDir = join(dir, 'apps');
    await mkdir(join(appsDir, 'temp-app'), { recursive: true });
    await writeFile(join(appsDir, 'temp-app', 'index.js'), 'export default { key: "temp-app", label: "Temp" };\n');
    const outFile = join(dir, 'apps-registry.generated.js');

    let { names } = await generateAppsRegistry({ appsDir, outFile });
    assert.deepEqual(names, ['temp-app']);

    await rm(join(appsDir, 'temp-app'), { recursive: true, force: true });
    ({ names } = await generateAppsRegistry({ appsDir, outFile }));
    assert.deepEqual(names, [], 're-scans fresh every call, never caches a since-removed app');
  });
});
