/**
 * RICH TEXT — a minimal, dependency-free WYSIWYG surface for a plain
 * `<textarea>` a form already reads raw HTML from (a Blog post's own
 * `content`, a CMS page body, ...). `bindRichText()` hides the textarea,
 * inserts a small toolbar + a `contenteditable` `<div>` right after it,
 * seeds the div from the textarea's CURRENT `.value`, and mirrors every
 * edit back into `textareaEl.value` on the div's own `'input'` event - so
 * whatever ALREADY reads `textareaEl.value` at submit time (every form's
 * own submit handler in this codebase) keeps working completely
 * unmodified, with zero awareness this exists.
 *
 * Deliberately NOT built on the deprecated `document.execCommand()`
 * (inconsistent across engines, and jsdom - this project's own test
 * runtime - doesn't implement it at all) - every command here is a small,
 * direct `Range`/`Selection` manipulation instead: wrap the current
 * selection in an inline tag (bold/italic/link), or replace the closest
 * block ancestor (heading/list). Deliberately NOT a full editor (no
 * undo stack beyond the browser's native `contenteditable` one, no
 * nested-list support, no paste-cleanup) - "a UX win over a raw HTML
 * `<textarea>`," this roadmap item's own stated bar, not a WYSIWYG
 * framework.
 *
 * ONE-WAY MIRRORING, BY DESIGN: the div -> textarea sync only fires on the
 * div's own `'input'` event (a real user typing/using the toolbar) -
 * setting `textareaEl.value` PROGRAMMATICALLY (e.g. an editor loading an
 * existing post's content back into the form) does NOT reach the visible
 * div on its own (no DOM event exists for that). Call the returned
 * `refresh()` right after such an assignment to pull the new value back
 * into view - `@qu/app-shell`'s `rich-text-actions.js` own `refreshRichText()`
 * is the framework-level convenience for exactly this.
 */

const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'DIV']);

/**
 * @param {HTMLTextAreaElement} textareaEl
 * @param {{doc?: Document, prompt?: (message: string) => string|null}} [options] - `prompt` (default `doc.defaultView.prompt`) supplies the Link button's URL - injectable so a test (or an app wanting a nicer modal) never depends on the real, blocking `window.prompt`.
 * @returns {{refresh: () => void, stop: () => void}} `refresh()` re-seeds the visible editor from `textareaEl.value` - see this file's own "ONE-WAY MIRRORING" doc comment. `stop()` removes the toolbar/editor and un-hides the original textarea.
 */
export function bindRichText(textareaEl, { doc = textareaEl.ownerDocument, prompt = (msg) => doc.defaultView?.prompt?.(msg) ?? null } = {}) {
  textareaEl.hidden = true;

  const toolbar = doc.createElement('div');
  toolbar.className = 'qu-richtext-toolbar';
  const editor = doc.createElement('div');
  editor.className = 'qu-richtext-editor';
  editor.setAttribute('contenteditable', 'true');
  editor.innerHTML = textareaEl.value;

  function sync() {
    textareaEl.value = editor.innerHTML;
  }
  editor.addEventListener('input', sync);

  function activeRange() {
    const sel = doc.defaultView.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    return editor.contains(range.commonAncestorContainer) ? range : null;
  }

  /**
   * Wraps the current (non-collapsed) selection in a new `<tagName>`
   * element - used for bold/italic/link. Refuses (no-op) when the
   * selection SPANS more than one block ancestor (e.g. across two `<p>`s) -
   * a real, found bug this guards against: `range.extractContents()` then
   * returns a fragment containing PARTIAL block elements, and wrapping
   * that in an inline tag produces invalid nesting (`<strong><p>...</p>
   * <p>...</p></strong>`) that a later HTML re-parse (saving, then
   * reloading the post for editing) silently reshuffles/corrupts - safer
   * to do nothing than to produce broken markup a user can't see coming.
   */
  function wrapSelection(tagName, configure) {
    const range = activeRange();
    if (!range || range.collapsed) return;
    if (closestBlock(range.startContainer) !== closestBlock(range.endContainer)) return;
    const wrapper = doc.createElement(tagName);
    configure?.(wrapper);
    wrapper.appendChild(range.extractContents());
    range.insertNode(wrapper);
    const sel = doc.defaultView.getSelection();
    const after = doc.createRange();
    after.selectNodeContents(wrapper);
    sel.removeAllRanges();
    sel.addRange(after);
  }

  function closestBlock(node) {
    let el = node.nodeType === 3 /* Node.TEXT_NODE */ ? node.parentElement : node;
    while (el && el !== editor && !BLOCK_TAGS.has(el.tagName)) el = el.parentElement;
    return el && el !== editor ? el : null;
  }

  /** Toggles the selection's closest block between `<tagName>` and a plain `<p>` - used for the heading button. Falls back to the editor's own first child (a bare, unwrapped editor body) when no block ancestor exists yet. */
  function toggleBlock(tagName) {
    const range = activeRange();
    const block = (range && closestBlock(range.commonAncestorContainer)) ?? editor.firstElementChild;
    if (!block) return;
    const el = doc.createElement(block.tagName === tagName.toUpperCase() ? 'p' : tagName);
    el.innerHTML = block.innerHTML;
    block.replaceWith(el);
  }

  /** Wraps the selection's closest block in a new `<tagName>` (`ul`/`ol`) containing one `<li>` - used for the list buttons. */
  function wrapAsList(tagName) {
    const range = activeRange();
    const block = range && closestBlock(range.commonAncestorContainer);
    const li = doc.createElement('li');
    li.innerHTML = block ? block.innerHTML : editor.innerHTML;
    const list = doc.createElement(tagName);
    list.appendChild(li);
    if (block) block.replaceWith(list);
    else editor.replaceChildren(list);
  }

  function addButton(label, title, run) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = `qu-richtext-btn qu-richtext-btn-${label.toLowerCase()}`;
    btn.textContent = label;
    btn.title = title;
    // `mousedown` -> preventDefault(), NOT `click` - a REAL browser moves focus (and collapses
    // whatever selection was inside `editor`) to the clicked button on mousedown, before the 'click'
    // handler below ever runs, unless that default is prevented here - the standard fix every rich
    // text toolbar needs. No separate `editor.focus()` call is needed either way: preventing the
    // mousedown default means focus (and the selection) never actually left `editor` in the first
    // place. jsdom (this project's own test runtime) doesn't move focus on mousedown at all, so this
    // exact bug never reproduces there - covered by hand-verification against a real browser instead.
    btn.addEventListener('mousedown', (event) => event.preventDefault());
    btn.addEventListener('click', () => {
      run();
      sync();
    });
    toolbar.appendChild(btn);
    return btn;
  }

  addButton('B', 'Fett', () => wrapSelection('strong'));
  addButton('I', 'Kursiv', () => wrapSelection('em'));
  addButton('Link', 'Link einfügen', () => {
    const range = activeRange();
    if (!range || range.collapsed) return;
    const url = prompt('URL:');
    if (!url) return;
    wrapSelection('a', (a) => a.setAttribute('href', url));
  });
  addButton('H2', 'Überschrift', () => toggleBlock('h2'));
  addButton('•', 'Aufzählung', () => wrapAsList('ul'));

  textareaEl.insertAdjacentElement('afterend', editor);
  textareaEl.insertAdjacentElement('afterend', toolbar);

  return {
    refresh() {
      editor.innerHTML = textareaEl.value;
    },
    stop() {
      toolbar.remove();
      editor.remove();
      textareaEl.hidden = false;
    },
  };
}
