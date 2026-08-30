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

test('renderPage() called twice with the same styleId updates the existing <style>, never duplicates it', () => {
  const { document } = dom();
  const mountEl = document.getElementById('mount');

  renderPage({ mountEl, doc: document, templateHtml: '<p></p>', page: null, css: 'a{}' });
  renderPage({ mountEl, doc: document, templateHtml: '<p></p>', page: null, css: 'b{}' });

  const styleEls = document.head.querySelectorAll('style[data-qu-style="qu-app-theme"]');
  assert.equal(styleEls.length, 1);
  assert.equal(styleEls[0].textContent, 'b{}');
});
