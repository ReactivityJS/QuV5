/**
 * STYLES — injects a resolved `qu-style`'s CSS into the document as a
 * single, idempotent `<style>` element keyed by `id` (docs/
 * app-shell-arbeitsauftrag.md §11): calling this again with the SAME `id`
 * updates the existing element's content instead of appending a duplicate
 * - a route change that resolves the same theme twice (the common case)
 * never accumulates `<style>` tags.
 */
export function injectStyle(doc, id, css) {
  let styleEl = doc.head.querySelector(`style[data-qu-style="${id}"]`);
  if (!styleEl) {
    styleEl = doc.createElement('style');
    styleEl.setAttribute('data-qu-style', id);
    doc.head.appendChild(styleEl);
  }
  styleEl.textContent = css ?? '';
  return styleEl;
}
