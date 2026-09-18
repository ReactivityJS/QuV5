/**
 * REAL-BROWSER WEBRTC SMOKE TEST — the end-to-end proof the fake-based
 * `webrtc-peer.test.js` deliberately CAN'T give: a real `RTCPeerConnection`
 * (Chromium, via Playwright) on each side, real SDP/ICE negotiation, real
 * relay-piggybacked signaling over a real WebSocket relay on a real
 * loopback port - the same code (`wrapWithSignaling()`/`createWebRTCPeer()`)
 * an app would actually ship, bundled once via esbuild and run unmodified
 * in two separate browser pages.
 *
 * OPTIONAL, SKIPS CLEANLY when Playwright/Chromium isn't available in the
 * current environment (no `playwright` package installed, or no chromium
 * binary at the expected path) - this is a real-browser dependency this
 * package does NOT otherwise have (see this file's own package.json entry:
 * `playwright` is a ROOT devDependency, present only where a maintainer/CI
 * explicitly wants this proof to run) - every other test in this suite
 * stays 100% `node:test`, zero browser required. Never treat a skip here as
 * a failure: it means "not verified in a real browser this run," not "the
 * feature is broken."
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { build } from 'esbuild';
import { QuCrypto } from '@qu/core';
import { createWsServerHub, createRelayForwarder } from '../src/index.js';

const CHROMIUM_PATH = process.env.QU_TEST_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';

async function actor() {
  const kp = await QuCrypto.generateKeypair();
  return { signingKey: kp.privateKey, signingPub: kp.publicKey, xPrivateKey: kp.xPrivateKey, xPublicKey: kp.xPublicKey };
}

function identityToB64(identity) {
  return {
    signingKey: QuCrypto.toBase64(identity.signingKey),
    signingPub: QuCrypto.toBase64(identity.signingPub),
    xPrivateKey: QuCrypto.toBase64(identity.xPrivateKey),
    xPublicKey: QuCrypto.toBase64(identity.xPublicKey),
  };
}

async function loadPlaywright() {
  if (!existsSync(CHROMIUM_PATH)) return null;
  try {
    return await import('playwright');
  } catch {
    return null;
  }
}

test('createWebRTCPeer() over a real browser (Chromium) + real WebSocket relay: a data channel message actually arrives', async (t) => {
  const playwright = await loadPlaywright();
  if (!playwright) {
    t.skip('playwright / chromium not available in this environment - see this file\'s own top doc comment');
    return;
  }

  const bundle = await build({
    entryPoints: [new URL('./webrtc-browser-harness.entry.js', import.meta.url).pathname],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
  });
  const bundledCode = bundle.outputFiles[0].text;

  const alice = await actor();
  const bob = await actor();
  const members = [{ pub: alice.signingPub, xPub: alice.xPublicKey }, { pub: bob.signingPub, xPub: bob.xPublicKey }];

  // A plain 200 for any request - `page.goto()` below needs a real http(s) origin to navigate to
  // (see that call's own comment) and would otherwise hang forever waiting for a response this
  // server, with no request handler at all, would never send.
  const httpServer = createServer((_req, res) => {
    res.writeHead(200);
    res.end();
  });
  const wss = new WebSocketServer({ server: httpServer });
  const hub = createWsServerHub(wss);
  createRelayForwarder({ hub, members, resolveKindSchema: () => null });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;
  const relayUrl = `ws://127.0.0.1:${port}`;

  const browser = await playwright.chromium.launch({
    executablePath: CHROMIUM_PATH,
    args: ['--use-fake-ui-for-media-stream', '--disable-background-networking', '--no-first-run', '--disable-sync', '--disable-features=Translate'],
  });
  try {
    // Navigate to a real http(s) origin FIRST - `about:blank` (a fresh page's default) doesn't
    // reliably expose `window.crypto.subtle` in Chromium, which QuCrypto needs for signing. The
    // relay's own httpServer answers ANY path (even a 404) with a real http://127.0.0.1 origin,
    // which IS a secure context (the loopback exception) - no separate static file server needed.
    const httpOrigin = relayUrl.replace('ws://', 'http://');
    const alicePage = await browser.newPage();
    const bobPage = await browser.newPage();
    await alicePage.goto(httpOrigin).catch(() => {});
    await bobPage.goto(httpOrigin).catch(() => {});
    await alicePage.addScriptTag({ content: bundledCode });
    await bobPage.addScriptTag({ content: bundledCode });

    const aliceB64 = identityToB64(alice);
    const bobB64 = identityToB64(bob);

    await Promise.all([
      alicePage.evaluate(
        ({ relayUrl, identityB64, remotePubB64 }) => window.QuWebRTCHarness.connect({ relayUrl, identityB64, remotePubB64 }),
        { relayUrl, identityB64: aliceB64, remotePubB64: QuCrypto.toBase64(bob.signingPub) }
      ),
      bobPage.evaluate(
        ({ relayUrl, identityB64, remotePubB64 }) => window.QuWebRTCHarness.connect({ relayUrl, identityB64, remotePubB64 }),
        { relayUrl, identityB64: bobB64, remotePubB64: QuCrypto.toBase64(alice.signingPub) }
      ),
    ]);

    const [, received] = await Promise.all([
      alicePage.evaluate(() => window.QuWebRTCHarness.createChannelAndSend('smoke-test-channel', 'hello from a real browser')),
      bobPage.evaluate((timeoutMs) => window.QuWebRTCHarness.waitForChannelMessage(timeoutMs), 15000),
    ]);

    assert.equal(received, 'hello from a real browser');
  } finally {
    await browser.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
