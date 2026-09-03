/**
 * <qu-list> — stamps a `<template>` CHILD once per item of a Space list
 * Field, keeping ATOMIC per-item DOM updates on every change: built on
 * `@qu/space-ui`'s `bindList()`, the actual keyed-reconciliation primitive
 * this Component wraps - only the item(s) that actually changed get
 * re-rendered, a pure reorder MOVES the existing element instead of
 * tearing it down, see that file's own doc comment for the full mechanism.
 *
 * CURATED lists only for v1 (the list Field's own array IS the data - see
 * `@qu/space-core`'s field.js `ListField`) - QuV3's DERIVED case (many
 * sibling Nodes, e.g. this framework's own Collections, `@qu/app-core`'s
 * `kinds.js` `defineCollectionKind()`) needs a second per-item Node
 * resolution step this Component doesn't do yet; a natural, separate
 * extension, not built speculatively here.
 *
 * Attributes: `kind`/`node-id` (resolve the Node holding the list field -
 * see resolve.js), `field` (the list-shape field name), `key` (a property
 * name - dot-path allowed, e.g. `"user.id"` - read off each item to
 * identify it stably across re-renders; defaults to `"id"`), `item-tag`
 * (every stamped item is wrapped in one element of this tag name - a
 * single, predictable per-item DOM node for `bindList()`'s own keyed
 * diffing to track regardless of how many top-level nodes the `<template>`
 * itself contains; default `"div"`).
 *
 * Item rendering: each item is a PLAIN VALUE (already decrypted/
 * deserialized by `ListField.toArray()`), not a Space Node of its own -
 * inside the stamped `<template>`, a `<qu-view field="...">` with NO
 * `kind`/`node-id` of its own reads that property (dot-path allowed)
 * straight off the current item, stamped once per render (no separate
 * Space subscription - the item value only ever changes via a whole new
 * `render()` call from `bindList()`, which this Component already
 * responds to). `<qu-bind>` has no per-item WRITE path yet (`ListField`
 * has no per-index update, only `push()` - field.js's own doc comment) -
 * one used inside a `<qu-list>` item without its own explicit
 * `kind`/`node-id` is simply inert, not a bug to route around.
 */
import { bindList } from '@qu/space-ui';
import { getPath } from './context.js';
import { resolveNodeRef } from './resolve.js';

function stampItem(templateEl, item, doc, itemTag) {
  const fragment = templateEl.content.cloneNode(true);
  for (const view of fragment.querySelectorAll('qu-view[field]')) {
    if (view.hasAttribute('kind') || view.hasAttribute('node-id')) continue; // has its own Space Node - leave it alone, it resolves itself once connected.
    const value = getPath(item, view.getAttribute('field')) ?? '';
    const target = view.children.length === 1 ? view.children[0] : view;
    const attrMode = view.getAttribute('attr') ?? 'auto';
    const prop = attrMode === 'auto' ? ('value' in target ? 'value' : 'textContent') : attrMode;
    target[prop] = value;
  }
  const wrapper = doc.createElement(itemTag);
  wrapper.appendChild(fragment);
  return wrapper;
}

export class QuList extends HTMLElement {
  connectedCallback() {
    this._generation = (this._generation ?? 0) + 1;
    this._stopList = null;
    this._start(this._generation);
  }

  async _start(generation) {
    let ref = resolveNodeRef(this);
    if (!ref) {
      await Promise.resolve();
      if (generation !== this._generation) return;
      ref = resolveNodeRef(this);
      if (!ref) return;
    }
    const fieldName = this.getAttribute('field');
    if (!fieldName) return;
    const { space, kindSchema, nodeId } = ref;
    const { node, release } = await space.useNode(nodeId, kindSchema);
    if (generation !== this._generation) {
      release();
      return;
    }
    const templateEl = this.querySelector('template');
    if (!templateEl) {
      release();
      return;
    }
    const field = node.field(fieldName);
    const keyProp = this.getAttribute('key') ?? 'id';
    const itemTag = this.getAttribute('item-tag') ?? 'div';
    const doc = this.ownerDocument;
    // A dedicated container, not `this` directly - bindList() reconciles its target's CHILDREN,
    // and `<template>` (kept as this element's OWN child, re-used as the stamp source on every
    // reconcile) must never be mistaken for a stray leftover item and removed.
    const container = doc.createElement('div');
    this.appendChild(container);

    const stopList = bindList(container, field, {
      key: (item, i) => String(getPath(item, keyProp) ?? i),
      render: (item) => stampItem(templateEl, item, doc, itemTag),
    });
    this._stopList = () => {
      stopList();
      container.remove();
      release();
    };
  }

  disconnectedCallback() {
    this._generation = (this._generation ?? 0) + 1;
    this._stopList?.();
    this._stopList = null;
  }
}
