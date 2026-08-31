/**
 * THE BUILT-IN ADMIN CONSOLE, AS A PLAIN BUNDLE — the reference "Package"
 * architecture.md §7 talks about, applied to the admin realm itself: no
 * hardcoded DOM-building JS, just a `{manifest, templates, pages}` object
 * in the exact shape `@qu/app-core`'s `installAdminAppBundle()` already
 * consumes (the SAME shape `installAppBundle()` uses for an ordinary app -
 * see that function's own doc comment). `bin/install-admin-console.mjs`
 * writes this into the admin realm's own Space once, at bootstrap; from
 * then on this console is ordinary, editable, versioned Qu content - not
 * framework code - exactly like any other installed app.
 *
 * The one interactive bit (the "register an app" form) is inert markup
 * here too - `<form data-qu-action="register-app">` is a CONVENTION
 * `@qu/app-shell`'s own `admin-actions.js` wires up after render, never a
 * `<script>` (which `@qu/app-renderer`'s `sanitizeHtml()` strips
 * unconditionally regardless - see that file's own doc comment on Stufe 1
 * of the security model). `<ul data-qu-bind="platform-apps-list">` is the
 * matching convention for the installed-apps listing.
 */
export const adminConsoleBundle = {
  manifest: { name: 'Relay-Admin', rootTemplate: 'main', defaultRoute: '/' },
  templates: [
    {
      name: 'main',
      html: '<div style="font-family: sans-serif; max-width: 40rem; margin: 2rem auto; line-height: 1.5; padding: 0 1rem;"><qu-slot name="content"></qu-slot></div>',
    },
  ],
  pages: [
    {
      route: '/',
      title: 'Relay-Admin',
      template: 'main',
      content: `<h1>Relay-Admin</h1>
<h2>Installierte Apps</h2>
<ul data-qu-bind="platform-apps-list"></ul>
<h2>App registrieren</h2>
<p>Setzt voraus, dass die App bereits installiert wurde (z.B. über <code>installAppBundle()</code>) - hier wird sie nur unter einem Pfad-Präfix eingehängt. Für den Admin-Realm selbst nicht nötig - der ist bereits unter seinem eigenen Präfix registriert.</p>
<form data-qu-action="register-app">
  <label>Pfad-Präfix (z.B. "forum"): <input name="prefix" required pattern="[a-z0-9-]+"></label><br>
  <label>App-Admin-Pubkey (base64): <input name="appAdminPub" required size="48"></label><br>
  <label>Name: <input name="name" required></label><br>
  <button type="submit">Registrieren</button>
</form>`,
    },
  ],
};
