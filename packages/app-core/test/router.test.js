import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { HashRouter } from '../src/router.js';

function dom(hash = '') {
  const { window } = new JSDOM(`<!doctype html><body></body>`, { url: `https://example.test/${hash}` });
  return window;
}

test('current() normalizes an empty/root hash to "/"', () => {
  const window = dom();
  const router = new HashRouter({ window, onChange: () => {} });
  assert.equal(router.current(), '/');
});

test('current() strips the leading "#" from a route hash', () => {
  const window = dom('#/forum/topic/123');
  const router = new HashRouter({ window, onChange: () => {} });
  assert.equal(router.current(), '/forum/topic/123');
});

test('start() fires onChange immediately with the current route, and again on every hashchange', async () => {
  const window = dom('#/hello');
  const seen = [];
  const router = new HashRouter({ window, onChange: (route) => seen.push(route) });

  router.start();
  assert.deepEqual(seen, ['/hello']);

  window.location.hash = '#/forum';
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(seen, ['/hello', '/forum']);
});

test('navigate() sets location.hash, which in turn fires onChange via hashchange', async () => {
  const window = dom();
  const seen = [];
  const router = new HashRouter({ window, onChange: (route) => seen.push(route) });
  router.start();

  router.navigate('/calendar/2026/08');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(seen.at(-1), '/calendar/2026/08');
});

test('stop() detaches the hashchange listener', async () => {
  const window = dom();
  const seen = [];
  const router = new HashRouter({ window, onChange: (route) => seen.push(route) });
  router.start();
  router.stop();

  window.location.hash = '#/after-stop';
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(!seen.includes('/after-stop'));
});
