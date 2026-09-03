import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderPage } from '../src/render.js';

function dom() {
  const { window } = new JSDOM('<!doctype html><body><div id="mount"></div></body>');
  return window;
}

test('renderPage() mounts the template with the page content in its "content" slot, sets the title, and injects the theme CSS', () => {
  const { document } = dom();
  const mountEl = document.getElementById('mount');

  renderPage({
    mountEl,
    doc: document,
    templateHtml: '<main><qu-slot name="content"></qu-slot></main>',
    page: { title: 'Hallo Qu', content: '<p>Hallo aus dem Space!</p>' },
    css: 'body { margin: 0; }',
  });

  assert.equal(mountEl.innerHTML, '<main><p>Hallo aus dem Space!</p></main>');
  assert.equal(document.title, 'Hallo Qu');
  assert.equal(document.head.querySelector('style[data-qu-style="qu-app-theme"]').textContent, 'body { margin: 0; }');
});

test('renderPage() sanitizes both the template and the page content before composing them', () => {
  const { document } = dom();
  const mountEl = document.getElementById('mount');

  renderPage({
    mountEl,
    doc: document,
    templateHtml: '<main onclick="evil()"><qu-slot name="content"></qu-slot></main>',
    page: { title: 'x', content: '<script>alert(1)</script><p>ok</p>' },
    css: '',
  });

  assert.ok(!mountEl.innerHTML.includes('onclick'));
  assert.ok(!mountEl.innerHTML.includes('<script'));
  assert.ok(mountEl.innerHTML.includes('<p>ok</p>'));
});

test('renderPage() with a null page/template renders the built-in "not found" fallback instead of throwing', () => {
  const { document } = dom();
  const mountEl = document.getElementById('mount');

  renderPage({ mountEl, doc: document, templateHtml: null, page: null, css: '' });

  assert.ok(mountEl.innerHTML.includes('404'));
});

test('renderPage() fills extra named slots from page.data, alongside the "content" slot', () => {
  const { document } = dom();
  const mountEl = document.getElementById('mount');

  renderPage({
    mountEl,
    doc: document,
    templateHtml: '<article><header data-slot="author"><qu-slot name="author"></qu-slot></header><main><qu-slot name="content"></qu-slot></main></article>',
    page: { title: 'A post', content: '<p>Body</p>', data: { author: 'Alice' } },
    css: '',
  });

  assert.equal(mountEl.querySelector('[data-slot="author"]').innerHTML, 'Alice');
  assert.equal(mountEl.querySelector('main').innerHTML, '<p>Body</p>');
});

test('renderPage() sanitizes string data-slot values, and stringifies non-string ones', () => {
  const { document } = dom();
  const mountEl = document.getElementById('mount');

  renderPage({
    mountEl,
    doc: document,
    templateHtml: '<div><qu-slot name="bio"></qu-slot><qu-slot name="views"></qu-slot></div>',
    page: { title: 'x', content: '', data: { bio: '<script>alert(1)</script><b>hi</b>', views: 42 } },
    css: '',
  });

  assert.ok(!mountEl.innerHTML.includes('<script'));
  assert.ok(mountEl.innerHTML.includes('<b>hi</b>'));
  assert.ok(mountEl.innerHTML.includes('42'));
});

test('renderPage() with no page.data (or data: null) fills only the "content" slot - fully backward compatible', () => {
  const { document } = dom();
  const mountEl = document.getElementById('mount');

  renderPage({
    mountEl,
    doc: document,
    templateHtml: '<main><qu-slot name="content"></qu-slot><qu-slot name="author">default author</qu-slot></main>',
    page: { title: 'x', content: '<p>Body</p>', data: null },
    css: '',
  });

  assert.equal(mountEl.innerHTML, '<main><p>Body</p>default author</main>');
});

test("renderPage()'s own content field wins over a same-named data key", () => {
  const { document } = dom();
  const mountEl = document.getElementById('mount');

  renderPage({
    mountEl,
    doc: document,
    templateHtml: '<qu-slot name="content"></qu-slot>',
    page: { title: 'x', content: 'real content', data: { content: 'accidental collision' } },
    css: '',
  });

  assert.equal(mountEl.innerHTML, 'real content');
});

test('renderPage() called twice with the same styleId updates the existing <style>, never duplicates it', () => {
  const { document } = dom();
  const mountEl = document.getElementById('mount');

  renderPage({ mountEl, doc: document, templateHtml: '<p></p>', page: null, css: 'a{}' });
  renderPage({ mountEl, doc: document, templateHtml: '<p></p>', page: null, css: 'b{}' });

  const styleEls = document.head.querySelectorAll('style[data-qu-style="qu-app-theme"]');
  assert.equal(styleEls.length, 1);
  assert.equal(styleEls[0].textContent, 'b{}');
});
