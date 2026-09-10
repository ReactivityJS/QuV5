/**
 * BASE STYLE — `base-style.js`'s own doc comment: one small stylesheet
 * inlined into `build.mjs`'s `renderIndexHtml()` page `<head>`, so every
 * app/form/rich-text surface rendered inside `<qu-app-shell>` gets a
 * visible, consistent baseline with zero per-bundle wiring. Proves it's
 * actually embedded (not just written and never wired in) and that the
 * concrete "Body-Feld gar nicht sichtbar" bug this closes - a `<textarea>`/
 * `.qu-richtext-editor` with no visible surface - has real rules.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderIndexHtml } from '../build.mjs';
import { BASE_STYLE_CSS } from '../base-style.js';

test('renderIndexHtml() embeds the shared base stylesheet in <head>, for both a single-app and a platform deployment', () => {
  const singleApp = renderIndexHtml({ appAdminPub: new Uint8Array(32) });
  const platform = renderIndexHtml({ platformMode: true });
  for (const html of [singleApp, platform]) {
    assert.match(html, /<head>[\s\S]*<style>[\s\S]*<\/style>[\s\S]*<\/head>/, 'a <style> block sits inside <head>');
    assert.ok(html.includes(BASE_STYLE_CSS), 'the embedded CSS is exactly the shared constant, not a stale copy');
  }
});

test('the base stylesheet gives forms, buttons, status messages, and the rich-text surface real, visible rules', () => {
  assert.match(BASE_STYLE_CSS, /form\s*\{[^}]*border/, 'a form itself gets a visible border');
  assert.match(BASE_STYLE_CSS, /form (input|textarea)[^{]*\{[^}]*border/, 'inputs/textareas are visibly bordered');
  assert.match(BASE_STYLE_CSS, /button\s*\{[^}]*background/, 'buttons get a real background, not bare browser default styling');
  assert.match(BASE_STYLE_CSS, /\.qu-richtext-editor\s*\{[^}]*(border|min-height)/, 'the rich-text surface (built-in editor or the optional ProseMirror one) is visibly bordered/sized - the actual fix for the reported "Body-Feld gar nicht sichtbar" bug');
});
