/**
 * <qu-bind> — <qu-view>'s two-way sibling: extends it, only the actual
 * bind call differs (an override, not a second mechanism - the same
 * relationship QuV3's own `<qu-bind>`/`<qu-view>` have).
 *
 * TWO editing modes, chosen by the `editable` attribute:
 *   - absent (default): LIVE two-way binding via `@qu/space-ui`'s
 *     `bindField(..., {twoWay: true})` (or `bindCheckbox()` for
 *     `attr="checked"`) - every `input`/`change` event writes straight
 *     through, same as an ordinary uncontrolled form control synced to
 *     Space data. Same `field`/`kind`/`node-id`/`attr` attributes as
 *     `<qu-view>` (see that file's own doc comment), plus `event`
 *     (overrides which DOM event triggers a write - default `"input"`).
 *   - `editable="inline"`: EXPLICIT save/cancel editing on a
 *     `[contenteditable]` element, built on `@qu/space-ui`'s
 *     `makeInlineEditable()`, with a small icon UI this Component owns: a
 *     pencil/edit button that enters edit mode, and Save/Cancel buttons
 *     shown only while editing. This mode builds its OWN internal markup
 *     (replacing whatever children were there) - a plain
 *     `<qu-bind kind="..." node-id="..." field="..." editable="inline">`
 *     is enough, nothing to author inside it. `edit-icon="hover"`
 *     (default) shows the pencil only on hover/focus-within;
 *     `edit-icon="always"` keeps it visible.
 */
import { bindField, bindCheckbox, makeInlineEditable } from '@qu/space-ui';
import { resolveTarget, assertSafeAttrMode } from './context.js';
import { resolveField } from './resolve.js';
import { QuView } from './qu-view.js';

const stylesInjectedFor = new WeakSet();

function ensureIconStyles(doc) {
  if (stylesInjectedFor.has(doc)) return;
  stylesInjectedFor.add(doc);
  const style = doc.createElement('style');
  style.textContent = `
qu-bind .qu-bind__edit-icon, qu-bind .qu-bind__save-icon, qu-bind .qu-bind__cancel-icon {
  border: none; background: transparent; cursor: pointer; font-size: 0.85em; padding: 0 0.2em;
}
qu-bind.qu-bind--edit-hover .qu-bind__edit-icon { opacity: 0; transition: opacity 0.15s; }
qu-bind.qu-bind--edit-hover:hover .qu-bind__edit-icon,
qu-bind.qu-bind--edit-hover:focus-within .qu-bind__edit-icon { opacity: 1; }
`;
  doc.head.appendChild(style);
}

export class QuBind extends QuView {
  async _start(generation) {
    if (this.getAttribute('editable') === 'inline') return this._startInlineEditable(generation);

    const resolved = await resolveField(this, generation, () => this._generation);
    if (!resolved) return;
    const { field, release } = resolved;
    const target = resolveTarget(this);
    const attrMode = this.getAttribute('attr') ?? 'auto';

    if (attrMode === 'checked') {
      const unbind = bindCheckbox(target, field);
      this._unbind = () => {
        unbind();
        release();
      };
      return;
    }

    try {
      assertSafeAttrMode(attrMode);
    } catch (err) {
      release();
      throw err;
    }
    const options = { twoWay: true, prop: attrMode === 'auto' ? null : attrMode };
    const eventAttr = this.getAttribute('event');
    if (eventAttr) options.event = eventAttr;
    const unbind = bindField(target, field, options);
    this._unbind = () => {
      unbind();
      release();
    };
  }

  async _startInlineEditable(generation) {
    const resolved = await resolveField(this, generation, () => this._generation);
    if (!resolved) return;
    const { field, release } = resolved;
    const doc = this.ownerDocument;
    ensureIconStyles(doc);

    const textEl = doc.createElement('span');
    textEl.className = 'qu-bind__text';
    textEl.contentEditable = 'false';
    const editIcon = doc.createElement('button');
    editIcon.type = 'button';
    editIcon.className = 'qu-bind__edit-icon';
    editIcon.setAttribute('aria-label', 'Edit');
    editIcon.textContent = '✎';
    const saveIcon = doc.createElement('button');
    saveIcon.type = 'button';
    saveIcon.className = 'qu-bind__save-icon';
    saveIcon.setAttribute('aria-label', 'Save');
    saveIcon.textContent = '✓';
    saveIcon.hidden = true;
    const cancelIcon = doc.createElement('button');
    cancelIcon.type = 'button';
    cancelIcon.className = 'qu-bind__cancel-icon';
    cancelIcon.setAttribute('aria-label', 'Cancel');
    cancelIcon.textContent = '✕';
    cancelIcon.hidden = true;

    this.replaceChildren(textEl, editIcon, saveIcon, cancelIcon);
    this.classList.add(this.getAttribute('edit-icon') === 'always' ? 'qu-bind--edit-always' : 'qu-bind--edit-hover');

    const setEditingChrome = (editing) => {
      editIcon.hidden = editing;
      saveIcon.hidden = !editing;
      cancelIcon.hidden = !editing;
      textEl.contentEditable = editing ? 'true' : 'false';
    };

    const stop = makeInlineEditable(textEl, field, {
      onSave: () => setEditingChrome(false),
      onCancel: () => setEditingChrome(false),
    });

    const onEditClick = () => {
      setEditingChrome(true);
      textEl.focus();
    };
    const onSaveClick = () => stop.save();
    const onCancelClick = () => stop.cancel();
    editIcon.addEventListener('click', onEditClick);
    saveIcon.addEventListener('click', onSaveClick);
    cancelIcon.addEventListener('click', onCancelClick);

    this._unbind = () => {
      stop();
      editIcon.removeEventListener('click', onEditClick);
      saveIcon.removeEventListener('click', onSaveClick);
      cancelIcon.removeEventListener('click', onCancelClick);
      release();
    };
  }
}
