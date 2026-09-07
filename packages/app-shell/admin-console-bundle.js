/**
 * THE BUILT-IN ADMIN CONSOLE, AS A PLAIN BUNDLE — the reference "Package"
 * architecture.md §7 talks about, applied to the built-in admin app
 * itself: no hardcoded DOM-building JS, just a
 * `{manifest, templates, pages}` object in the exact shape `@qu/app-core`'s
 * `installGlobalAppBundle()` already consumes (the SAME shape
 * `installAppBundle()` uses for an ordinary app - see that function's own
 * doc comment). `bin/install-admin-console.mjs` writes this into the SAME
 * main Space every other app's content lives in, once, at bootstrap; from
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
 *
 * `<form data-qu-action="install-app" data-app-type="...">` (three of them,
 * one per reference app) is the SAME convention, one level up: rather than
 * requiring an operator to already have run an install script AND know its
 * own `appAdminPub` by heart (what "App registrieren" above still assumes),
 * these seed a brand-new Guestbook/Blog/Forum under a relay-admin-chosen
 * prefix AND register it in one click - `admin-actions.js`'s
 * `wireAdminConsole()` doc comment has the full story on why this installs
 * into the relay-admin's OWN main Space (never a bespoke per-app identity).
 * Any NAMED field beyond `prefix` (Blog's own `routeScheme` `<select>`
 * below) is passed straight through to that installer's own `installX()`
 * AND persisted into the app's `qu-platform-apps` `config` (`dev.js`'s
 * `setAppConfig()`) - a new reference app wanting one more install-time
 * option only ever needs to add the input here, `admin-actions.js`'s own
 * generic submit handler needs no per-field change.
 *
 * `<div data-qu-bind="file-app-installers">` is the SAME convention's
 * DYNAMIC counterpart - `admin-actions.js`'s `wireAdminConsole()` fills it
 * with one more install form per discovered `/apps/*` app (repo root's own
 * `apps/README.md` has the full "why files, not Storage, for these"
 * reasoning) that ISN'T already one of the three static forms above - never
 * requires editing this STORED content again just because a new file-based
 * app was added to the repo.
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
<h2>Beispiel-App installieren</h2>
<p>Erstellt eine fertig eingerichtete App unter dem gewählten Pfad-Präfix (in diesem, dem Relay-Admin eigenen Space) und registriert sie sofort - kein separates <code>installAppBundle()</code> nötig.</p>
<form data-qu-action="install-app" data-app-type="guestbook">
  <label>Pfad-Präfix (z.B. "gaestebuch"): <input name="prefix" required pattern="[a-z0-9\-]+"></label>
  <button type="submit">Gästebuch installieren</button>
  <p data-qu-status></p>
</form>
<form data-qu-action="install-app" data-app-type="blog">
  <label>Pfad-Präfix (z.B. "blog"): <input name="prefix" required pattern="[a-z0-9\-]+"></label>
  <label>Datums-Schema für Beiträge:
    <select name="routeScheme">
      <option value="flat">Kein Datum (/post/titel)</option>
      <option value="yyyy">Jahr (/post/2026/titel)</option>
      <option value="yyyy/mm">Jahr/Monat (/post/2026/09/titel)</option>
      <option value="yyyy/mm/dd">Jahr/Monat/Tag (/post/2026/09/07/titel)</option>
    </select>
  </label>
  <button type="submit">Blog installieren</button>
  <p data-qu-status></p>
</form>
<form data-qu-action="install-app" data-app-type="forum">
  <label>Pfad-Präfix (z.B. "forum"): <input name="prefix" required pattern="[a-z0-9\-]+"></label>
  <button type="submit">Forum installieren</button>
  <p data-qu-status></p>
</form>
<div data-qu-bind="file-app-installers"></div>
<h2>App registrieren</h2>
<p>Setzt voraus, dass die App bereits installiert wurde (z.B. über <code>installAppBundle()</code>) - hier wird sie nur unter einem Pfad-Präfix eingehängt. Für diese Admin-Konsole selbst nicht nötig - sie ist bereits unter ihrem eigenen Präfix registriert.</p>
<form data-qu-action="register-app">
  <label>Pfad-Präfix (z.B. "forum"): <input name="prefix" required pattern="[a-z0-9\-]+"></label><br>
  <label>App-Admin-Pubkey (base64): <input name="appAdminPub" required size="48"></label><br>
  <label>Name: <input name="name" required></label><br>
  <button type="submit">Registrieren</button>
</form>`,
    },
  ],
};
