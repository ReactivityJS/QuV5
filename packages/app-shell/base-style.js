/**
 * BASE STYLE — a small, deliberately minimal baseline stylesheet, inlined
 * once into the page `<head>` (`build.mjs`'s `renderIndexHtml()`) so it
 * cascades to EVERY app/page/form rendered inside `<qu-app-shell>` - one
 * place, not one `<style>` block duplicated per reference app bundle.
 * Purely visual structure (spacing, readable widths, an actually-visible
 * form surface) - no color theme/branding decisions, no layout framework,
 * nothing an app's own `qu-style` `theme` can't already override or
 * extend (this stylesheet loads FIRST, in `<head>`; an app's own `theme`
 * CSS, injected per-page by `renderPage()`, comes after in the cascade
 * and wins on equal specificity). The concrete bug this closes: a Blog
 * post's own `content` field had NO visible surface at all before this -
 * neither the plain `<textarea>` nor `bindRichText()`'s bare
 * `contenteditable` `<div>` had a border/min-height/background, so an
 * author could type into it, its OWN presence on the page not obviously
 * visible.
 */
export const BASE_STYLE_CSS = `
  body { font-family: system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; color: #1a1a1a; }
  h1, h2, h3 { line-height: 1.25; }
  a { color: #2454b8; }
  ul[data-qu-bind], ul[data-qu-view] { list-style: none; padding: 0; margin: 0.5rem 0; }
  ul[data-qu-bind] > li, ul[data-qu-view] > * { padding: 0.5rem 0; border-bottom: 1px solid #e5e5e5; }

  form { margin: 1rem 0; padding: 1rem; border: 1px solid #ddd; border-radius: 6px; background: #fafafa; }
  form label { display: block; margin-bottom: 0.75rem; font-weight: 600; }
  form label input, form label select, form textarea { display: block; width: 100%; margin-top: 0.25rem; font-weight: normal; box-sizing: border-box; }
  form input, form select, form textarea { padding: 0.5rem; border: 1px solid #ccc; border-radius: 4px; font: inherit; font-size: 0.95rem; }
  form textarea { min-height: 6rem; resize: vertical; }
  form input[type="checkbox"] { width: auto; display: inline-block; margin: 0 0.35rem 0 0; }

  button { padding: 0.5rem 1rem; border: 1px solid #2454b8; border-radius: 4px; background: #2454b8; color: #fff; font: inherit; cursor: pointer; margin: 0.25rem 0.35rem 0 0; }
  button:hover { background: #1c4295; }
  button:disabled { background: #eee; border-color: #ccc; color: #999; cursor: default; }
  button[data-qu-draft-btn] { background: #fff; color: #2454b8; }
  button[data-qu-draft-btn]:hover { background: #eef2fb; }

  [data-qu-status] { min-height: 1.2rem; margin: 0.5rem 0 0; font-size: 0.9rem; color: #555; }

  input[type="search"][data-qu-search-for] { display: block; width: 100%; box-sizing: border-box; padding: 0.5rem; margin: 0.75rem 0; border: 1px solid #ccc; border-radius: 4px; font: inherit; }

  .qu-richtext-toolbar { margin-top: 0.25rem; }
  .qu-richtext-toolbar button { padding: 0.3rem 0.6rem; margin: 0 0.35rem 0.35rem 0; }
  .qu-richtext-editor { min-height: 8rem; padding: 0.6rem 0.75rem; border: 1px solid #ccc; border-radius: 4px; background: #fff; box-sizing: border-box; }
  .qu-richtext-editor .ProseMirror { outline: none; min-height: 7rem; }
  .qu-richtext-editor :is(h1, h2, h3) { margin-top: 0; }

  /* Admin console app rows (admin-actions.js's own appRowGroup()) - separates each row's
     link/CMS/visibility/danger-zone controls onto their own line instead of one flat run, with a
     short muted hint line explaining what a control does (e.g. the "neue shared-list" input). */
  .qu-app-row-group { display: block; margin-top: 0.4rem; }
  .qu-app-row-hint { display: block; font-size: 0.8rem; color: #666; margin-bottom: 0.2rem; }
`;
