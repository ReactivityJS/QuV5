/**
 * relay-server.js — the actual, standalone process the Dockerfile runs.
 * Spawned for real (not imported - it's a script with top-level side
 * effects, not a module of exported functions) to prove the env-var
 * contract this task fixed: QU_MEMBERS_JSON is OPTIONAL (the relay starts
 * and serves fine with none configured - only 'members'-mode ACL Kinds
 * need it), and the relay's own identity is auto-generated, persisted,
 * and retrievable via `--print-identity` without ever needing a manual
 * keygen-then-paste step.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QuCrypto } from '@qu/core';
import { buildWebBundle } from '../../../demo/web/build.mjs';

const RELAY_SERVER_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'relay-server.js');

// A real Docker build bundles demo/web/main.js at BUILD TIME (see the Dockerfile) - running
// relay-server.js straight from source, as these tests do, needs that same bundle to already
// exist, so build it once up front rather than relying on a prior manual `npm run build:web`.
await buildWebBundle();

function freePort() {
  // Ports in this range are unlikely to collide across parallel test files - good enough for a
  // spawned-process test that can't ask the OS for port 0 the way an in-process http.Server can.
  return 20000 + Math.floor(Math.random() * 10000);
}

async function waitUntil(conditionFn, { timeout = 3000, interval = 20 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await conditionFn()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

async function isHealthy(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    return res.ok;
  } catch {
    return false;
  }
}

test('relay-server.js starts and serves /healthz with NO QU_MEMBERS_JSON set at all', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qu-relay-server-'));
  const port = freePort();
  const child = spawn('node', [RELAY_SERVER_PATH], {
    env: { ...process.env, QU_RELAY_PORT: String(port), QU_RELAY_DATA_DIR: dir, QU_MEMBERS_JSON: '' },
  });
  try {
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    await waitUntil(() => isHealthy(port));
    assert.ok(stdout.includes('no \'members\'-mode members configured'));

    const identityFile = JSON.parse(await readFile(join(dir, 'relay-identity.json'), 'utf8'));
    assert.ok(identityFile.signingPub); // the relay generated its OWN identity as a side effect of starting, unprompted.
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test('--print-identity prints the relay\'s public identity and exits WITHOUT starting the WebSocket server', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qu-relay-server-'));
  const port = freePort();
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn('node', [RELAY_SERVER_PATH, '--print-identity'], {
        env: { ...process.env, QU_RELAY_PORT: String(port), QU_RELAY_DATA_DIR: dir },
      });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`exited ${code}`))));
    });

    const parsed = JSON.parse(output);
    assert.ok(parsed.fingerprint);
    assert.ok(parsed.pub);
    assert.ok(parsed.xPub);
    assert.equal(await isHealthy(port), false); // never started listening - --print-identity is a one-shot, not a server mode.
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the relay identity persists across restarts - a second boot reuses the same one, not a fresh one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qu-relay-server-'));
  try {
    const printOnce = () =>
      new Promise((resolve, reject) => {
        const child = spawn('node', [RELAY_SERVER_PATH, '--print-identity'], { env: { ...process.env, QU_RELAY_DATA_DIR: dir } });
        let stdout = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.on('close', (code) => (code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`exited ${code}`))));
      });

    const first = await printOnce();
    const second = await printOnce();
    assert.equal(second.fingerprint, first.fingerprint);
    assert.equal(second.pub, first.pub);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('QU_FEDERATE_UPSTREAM_URL connects this relay to an upstream relay as a subscribing peer, without crashing either', async () => {
  const upstreamDir = await mkdtemp(join(tmpdir(), 'qu-relay-server-'));
  const downstreamDir = await mkdtemp(join(tmpdir(), 'qu-relay-server-'));
  const upstreamPort = freePort();
  const downstreamPort = freePort();

  const upstream = spawn('node', [RELAY_SERVER_PATH], {
    env: { ...process.env, QU_RELAY_PORT: String(upstreamPort), QU_RELAY_DATA_DIR: upstreamDir },
  });
  try {
    await waitUntil(() => isHealthy(upstreamPort));

    const downstream = spawn('node', [RELAY_SERVER_PATH], {
      env: {
        ...process.env,
        QU_RELAY_PORT: String(downstreamPort),
        QU_RELAY_DATA_DIR: downstreamDir,
        QU_FEDERATE_UPSTREAM_URL: `ws://127.0.0.1:${upstreamPort}`,
      },
    });
    try {
      let downstreamOut = '';
      downstream.stdout.on('data', (d) => (downstreamOut += d));
      await waitUntil(() => isHealthy(downstreamPort));
      await waitUntil(() => downstreamOut.includes('federating with'));
      assert.equal(await isHealthy(upstreamPort), true); // the upstream relay is unaffected, still healthy.
    } finally {
      downstream.kill();
      await rm(downstreamDir, { recursive: true, force: true });
    }
  } finally {
    upstream.kill();
    await rm(upstreamDir, { recursive: true, force: true });
  }
});

test('relay-server.js serves the browser app at / and /bundle.js, and answers /members.json + POST /join', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qu-relay-server-'));
  const port = freePort();
  const child = spawn('node', [RELAY_SERVER_PATH], {
    env: { ...process.env, QU_RELAY_PORT: String(port), QU_RELAY_DATA_DIR: dir, QU_MEMBERS_JSON: '' },
  });
  try {
    await waitUntil(() => isHealthy(port));

    const indexRes = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(indexRes.ok, true);
    assert.match(indexRes.headers.get('content-type'), /text\/html/);

    const bundleRes = await fetch(`http://127.0.0.1:${port}/bundle.js`);
    assert.equal(bundleRes.ok, true);

    const beforeJoin = await (await fetch(`http://127.0.0.1:${port}/members.json`)).json();
    assert.deepEqual(beforeJoin, []); // no QU_MEMBERS_JSON configured - nobody yet.

    const kp = await QuCrypto.generateKeypair();
    const joinRes = await fetch(`http://127.0.0.1:${port}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'newcomer', pub: QuCrypto.toBase64(kp.publicKey), xPub: QuCrypto.toBase64(kp.xPublicKey) }),
    });
    assert.equal(joinRes.ok, true);
    const joinBody = await joinRes.json();
    assert.equal(joinBody.ok, true);
    assert.ok(joinBody.fingerprint);

    const afterJoin = await (await fetch(`http://127.0.0.1:${port}/members.json`)).json();
    assert.equal(afterJoin.length, 1);
    assert.equal(afterJoin[0].name, 'newcomer');
    assert.equal(afterJoin[0].pub, QuCrypto.toBase64(kp.publicKey));
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test('QU_ALLOW_JOIN=false disables joining (403) while the app is still served', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qu-relay-server-'));
  const port = freePort();
  const child = spawn('node', [RELAY_SERVER_PATH], {
    env: { ...process.env, QU_RELAY_PORT: String(port), QU_RELAY_DATA_DIR: dir, QU_ALLOW_JOIN: 'false' },
  });
  try {
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    await waitUntil(() => isHealthy(port));
    await waitUntil(() => stdout.includes('DISABLED'));

    const indexRes = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(indexRes.ok, true); // the app itself is unaffected - only /join is gated.

    const kp = await QuCrypto.generateKeypair();
    const joinRes = await fetch(`http://127.0.0.1:${port}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'blocked', pub: QuCrypto.toBase64(kp.publicKey), xPub: QuCrypto.toBase64(kp.xPublicKey) }),
    });
    assert.equal(joinRes.status, 403);

    const members = await (await fetch(`http://127.0.0.1:${port}/members.json`)).json();
    assert.deepEqual(members, []); // the rejected join never took effect.
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
