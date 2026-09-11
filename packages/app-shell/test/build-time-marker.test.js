/**
 * BUILD TIME MARKER — `build.mjs`'s own `renderIndexHtml()` doc comment on
 * `builtAt`: a `<meta name="qu-build-time">` tag, regenerated fresh every
 * `relay-server.js` process start, so an operator can tell "the relay
 * PROCESS actually restarted with the latest code" apart from "an app's own
 * CONTENT was reinstalled through the admin console" (which never touches
 * this) - a real, reported point of confusion this closes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderIndexHtml } from '../build.mjs';

test('renderIndexHtml() embeds a fresh qu-build-time <meta> tag in a real deployment\'s <head>, defaulting to "now"', () => {
  const before = Date.now();
  const html = renderIndexHtml({ appAdminPub: new Uint8Array(32) });
  const after = Date.now();
  const match = html.match(/<meta name="qu-build-time" content="([^"]+)" \/>/);
  assert.ok(match, 'a qu-build-time meta tag is present');
  const embedded = Date.parse(match[1]);
  assert.ok(embedded >= before && embedded <= after, 'defaults to the actual render-call time, not a stale/hardcoded value');
});

test('renderIndexHtml() accepts an explicit builtAt (for deterministic testing/tooling), and platform mode gets one too', () => {
  const html = renderIndexHtml({ platformMode: true, builtAt: '2026-01-01T00:00:00.000Z' });
  assert.ok(html.includes('<meta name="qu-build-time" content="2026-01-01T00:00:00.000Z" />'));
});

test('the unconfigured setup page (no app-admin, no platform mode) has no bundle to go stale, and carries no build-time marker', () => {
  const html = renderIndexHtml({});
  assert.ok(!html.includes('qu-build-time'));
});
