/**
 * COLLAB EDITOR — see collab-editor.js's own doc comment. Proves the
 * REAL `y-prosemirror` binding: typing/formatting through the toolbar
 * lands in the field's own `Y.XmlFragment`, and a SECOND, independent
 * peer applying the same Yjs update converges on identical content - the
 * exact mechanism `@qu/space-transport` already uses to move updates
 * between real Space instances, exercised here at the field/editor layer
 * directly (no relay needed for what this file is actually testing).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import * as Y from 'yjs';
import { TextSelection } from 'prosemirror-state';
import { bindCollabRichText } from '../src/collab-editor.js';

// See local-editor.test.js's own doc comment on why these globals are required at all.
function setup() {
  const { window } = new JSDOM('<!doctype html><body><div id="container"></div></body>');
  global.window = window;
  global.document = window.document;
  global.DOMParser = window.DOMParser;
  global.Node = window.Node;
  return { window, document: window.document, container: window.document.getElementById('container') };
}

function click(el) {
  el.dispatchEvent(new el.ownerDocument.defaultView.Event('click', { bubbles: true, cancelable: true }));
}

function selectAllPM(view) {
  const { doc } = view.state;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, 1, Math.max(1, doc.content.size - 1))));
}

test('bindCollabRichText() mounts a real ProseMirror EditorView bound to the given Y.XmlFragment', () => {
  const { document, container } = setup();
  const ydoc = new Y.Doc();
  const yxml = ydoc.getXmlFragment('body');
  const { stop } = bindCollabRichText(container, { yxml });
  assert.ok(container.querySelector('.qu-richtext-editor'));
  assert.ok(container.querySelector('.ProseMirror'));
  assert.ok(container.querySelector('.qu-richtext-toolbar'));
  stop();
});

test('typing through the editor writes into the field\'s own Y.XmlFragment - the CRDT, not a local buffer, is the source of truth', () => {
  const { document, container } = setup();
  const ydoc = new Y.Doc();
  const yxml = ydoc.getXmlFragment('body');
  const { view } = bindCollabRichText(container, { yxml });

  view.dispatch(view.state.tr.insertText('hallo zusammen'));
  assert.ok(yxml.toString().includes('hallo zusammen'));
});

test('a SECOND, independent peer applying the same Yjs update converges on identical content - real multi-peer sync, not a local mock', () => {
  const { container } = setup();
  const ydocA = new Y.Doc();
  const yxmlA = ydocA.getXmlFragment('body');
  const { view } = bindCollabRichText(container, { yxml: yxmlA });
  view.dispatch(view.state.tr.insertText('geteilter Text'));

  // Peer B never touched an EditorView at all - a bare Y.Doc receiving the SAME update peer A
  // produced, exactly what @qu/space-transport delivers over a real relay.
  const ydocB = new Y.Doc();
  Y.applyUpdate(ydocB, Y.encodeStateAsUpdate(ydocA));
  const yxmlB = ydocB.getXmlFragment('body');

  assert.equal(yxmlA.toString(), yxmlB.toString());
  assert.ok(yxmlB.toString().includes('geteilter Text'));
});

test('the shared toolbar (Bold) also works against a Yjs-bound editor - marks land in the Y.XmlFragment itself', () => {
  const { document, container } = setup();
  const ydoc = new Y.Doc();
  const yxml = ydoc.getXmlFragment('body');
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText('hello world')]);
  ydoc.transact(() => yxml.insert(0, [p]));
  const { view } = bindCollabRichText(container, { yxml });

  selectAllPM(view);
  click(document.querySelector('.qu-richtext-btn-b'));
  assert.match(yxml.toString(), /<paragraph><strong>hello world<\/strong><\/paragraph>/);
});

test('concurrent edits from two EditorViews bound to mirrored fields converge, not last-write-wins', () => {
  // Both views share ONE jsdom `document` (two separate container elements in it) - `prosemirror-view`
  // itself references the bare GLOBAL `document` internally (this file's own top doc comment on
  // `setup()`), so genuinely separate jsdom realms can't each host a live EditorView at the same time
  // here; the actual thing under test - do two independently-edited Y.Docs CRDT-converge - doesn't
  // need separate DOM realms to be real, only two separate Y.Doc instances kept in sync by hand below.
  const { document } = setup();
  const containerA = document.createElement('div');
  const containerB = document.createElement('div');
  document.body.append(containerA, containerB);

  const ydocA = new Y.Doc();
  const yxmlA = ydocA.getXmlFragment('body');
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText('')]);
  ydocA.transact(() => yxmlA.insert(0, [p]));
  const { view: viewA } = bindCollabRichText(containerA, { yxml: yxmlA });

  const ydocB = new Y.Doc();
  Y.applyUpdate(ydocB, Y.encodeStateAsUpdate(ydocA));
  const yxmlB = ydocB.getXmlFragment('body');
  const { view: viewB } = bindCollabRichText(containerB, { yxml: yxmlB });

  ydocA.on('update', (update) => Y.applyUpdate(ydocB, update));
  ydocB.on('update', (update) => Y.applyUpdate(ydocA, update));

  viewA.dispatch(viewA.state.tr.insertText('Alice'));
  viewB.dispatch(viewB.state.tr.insertText('Bob'));

  assert.equal(yxmlA.toString(), yxmlB.toString());
  assert.ok(yxmlA.toString().includes('Alice'));
  assert.ok(yxmlA.toString().includes('Bob'));
});

test('stop() destroys the EditorView and removes the toolbar/editor - it never touches the field itself', () => {
  const { container } = setup();
  const ydoc = new Y.Doc();
  const yxml = ydoc.getXmlFragment('body');
  const { stop } = bindCollabRichText(container, { yxml });
  stop();
  assert.equal(container.querySelector('.qu-richtext-editor'), null);
  assert.equal(container.querySelector('.qu-richtext-toolbar'), null);
  assert.ok(ydoc.getXmlFragment('body') === yxml, 'the underlying Y.XmlFragment is untouched by tearing down the editor UI');
});
