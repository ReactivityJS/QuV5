/**
 * DEV CONSOLE — `initDevConsole()` (dev-console.js), the piece that makes
 * the relay's own unconfigured setup page (`build.mjs`'s `renderIndexHtml()`)
 * offer a genuinely usable identity-bootstrapping tool: a persisted
 * identity in `window.Qu`, its base64 pubkeys rendered into any matching
 * `[data-qu-pub]`/`[data-qu-xpub]` element, and a `regenerate()` escape
 * hatch. Uses a plain in-memory fake for `storage`/`doc`/`win` rather than
 * jsdom - nothing here needs a real DOM beyond `querySelector`/
 * `textContent`/`dispatchEvent`, which a tiny fake covers directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initDevConsole } from '../src/dev-console.js';

function fakeStorage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
}

function fakeDoc() {
  const elements = new Map(); // selector -> element
  const events = [];
  return {
    _elements: elements,
    querySelector(selector) {
      return elements.get(selector) ?? null;
    },
    dispatchEvent(event) {
      events.push(event);
    },
    _events: events,
  };
}

function fakeElement() {
  return { textContent: null };
}

class FakeCustomEvent {
  constructor(type, { detail } = {}) {
    this.type = type;
    this.detail = detail;
  }
}

test('initDevConsole() persists a fresh identity, assigns it to win.Qu, and exposes base64 pub/xPub plus base64url pubUrl', async () => {
  const storage = fakeStorage();
  const doc = fakeDoc();
  const win = { CustomEvent: FakeCustomEvent };

  const api = await initDevConsole({ storage, doc, win });

  assert.equal(win.Qu, api);
  assert.equal(typeof api.pub, 'string');
  assert.equal(typeof api.xPub, 'string');
  assert.equal(typeof api.pubUrl, 'string');
  assert.ok(api.identity.signingPub instanceof Uint8Array);
  assert.equal(typeof api.QuCrypto.toBase64, 'function');
  assert.ok(storage.getItem('qu-identity'), 'persisted under the shared IDENTITY_STORAGE_KEY');
  assert.equal(api.pubUrl, api.QuCrypto.toBase64Url(api.identity.signingPub), 'pubUrl is the base64URL form, never plain base64 - a raw base64 pubkey routinely contains "/"/"+", which breaks silently when pasted into a hash route');
  assert.ok(!/[+/=]/.test(api.pubUrl), 'pubUrl never contains "+"/"/"/"=" - genuinely URL-safe, unlike pub');
});

test('initDevConsole() renders the pub/xPub/pubUrl into [data-qu-pub]/[data-qu-xpub]/[data-qu-pub-url] elements when present', async () => {
  const storage = fakeStorage();
  const doc = fakeDoc();
  const pubEl = fakeElement();
  const xPubEl = fakeElement();
  const pubUrlEl = fakeElement();
  doc._elements.set('[data-qu-pub]', pubEl);
  doc._elements.set('[data-qu-xpub]', xPubEl);
  doc._elements.set('[data-qu-pub-url]', pubUrlEl);
  const win = { CustomEvent: FakeCustomEvent };

  const api = await initDevConsole({ storage, doc, win });

  assert.equal(pubEl.textContent, api.pub);
  assert.equal(xPubEl.textContent, api.xPub);
  assert.equal(pubUrlEl.textContent, api.pubUrl);
});

test('initDevConsole() is a correct no-op when no [data-qu-pub]/[data-qu-xpub] elements exist - never throws', async () => {
  const storage = fakeStorage();
  const doc = fakeDoc();
  const win = { CustomEvent: FakeCustomEvent };
  await assert.doesNotReject(() => initDevConsole({ storage, doc, win }));
});

test('initDevConsole() reuses the SAME persisted identity on a later call (e.g. a second page load)', async () => {
  const storage = fakeStorage();
  const win1 = { CustomEvent: FakeCustomEvent };
  const first = await initDevConsole({ storage, doc: fakeDoc(), win: win1 });

  const win2 = { CustomEvent: FakeCustomEvent };
  const second = await initDevConsole({ storage, doc: fakeDoc(), win: win2 });

  assert.equal(first.pub, second.pub);
  assert.equal(first.xPub, second.xPub);
});

test('regenerate() clears the stored identity and reloads', async () => {
  const storage = fakeStorage();
  const doc = fakeDoc();
  let reloaded = false;
  const win = { CustomEvent: FakeCustomEvent, location: { reload: () => (reloaded = true) } };

  const api = await initDevConsole({ storage, doc, win });
  assert.ok(storage.getItem('qu-identity'));

  await api.regenerate();
  assert.equal(storage.getItem('qu-identity'), null);
  assert.ok(reloaded);
});

test('initDevConsole() dispatches a qu-dev-console-ready event with the api as detail', async () => {
  const storage = fakeStorage();
  const doc = fakeDoc();
  const win = { CustomEvent: FakeCustomEvent };

  const api = await initDevConsole({ storage, doc, win });

  assert.equal(doc._events.length, 1);
  assert.equal(doc._events[0].detail, api);
});
