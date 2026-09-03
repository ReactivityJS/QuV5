# Arbeitsauftrag: QuV5 App Shell und Content Runtime

**Status:** Entwurf, angepasst an den Stand des Repos vom 2026-08-30 (siehe
`architecture.md`, `docs/v5-space-core-guide.md`). Dies ist eine überarbeitete
Fassung der ursprünglichen Arbeitsanweisung — Struktur und Zielsetzung bleiben
erhalten, aber alle Annahmen über vorhandene APIs, Datenmodelle und
Paketstruktur wurden auf das tatsächliche `@qu/*`-Framework abgebildet.
Abschnitte, die inhaltlich vom Original abweichen, sind mit **„Anpassung"**
markiert.

## 0. Zusammenfassung der Analyse (Abschnitt 31 vorgezogen)

Bevor irgendetwas implementiert wird, hier die Ergebnisse der geforderten
Bestandsaufnahme (Original-Abschnitt 31), weil sie fast jeden späteren
Abschnitt beeinflussen:

1. **Space/Node/Field** (`@qu/space-core`): `Space` ist lokal-first,
   verbindungsorientiert, kennt **keine Query-API** ("gib mir alle Nodes vom
   Kind X"). Man muss die Node-ID kennen, um sie zu abonnieren
   (`useNode`/`subscribeNode`/`loadNode`). Das ist die zentrale Randbedingung
   für das ganze Content-/Namespace-Modell (siehe Abschnitt 12).
2. **Kind-Schema** (`kind-schema.js`): Ein Feld hat `shape`
   (`atomic|text|list`) und `visibility` (`encrypted|public`), unabhängig
   voneinander. Ein Kind hat `acl.write` = `members|owner|named` und
   `persistence` = `durable|volatile`. Es gibt **keine** Node- oder
   Field-Level-ACL, erst recht keine Namespace-Hierarchie. `'owner'`-Kinds
   nutzen bereits `deriveOwnerNodeId(pub, kind)` → eine ID mit Präfix `~`
   (`OWNER_NODE_PREFIX`) — das ist bereits fast wörtlich der `~pub/<identity>/`
   -Gedanke aus Abschnitt 12/14 des Originals, nur dass er heute pro *Kind*
   und nicht pro *Pfad* gilt.
3. **Registry-Node-Muster** (`alias.js`): Da es keine Query-API gibt, löst
   das Framework "gib mir alle X" bereits genau einmal: `AliasRegistry` ist
   ein Bus-Watcher, der Registry-Nodes (ein Node pro Mitglied, deterministische
   ID, ein Feld mit `{aliasPub, aliasXPub}`) einsammelt. **Dieses Muster ist
   die Vorlage** für Route-/Page-/Component-Registries (Abschnitt 12/15).
4. **Grant-Mechanismus** (`grant.js`, `Space.grantWriter()`): `'named'`-ACL
   erlaubt bereits genau das, was Abschnitt 19-21 als "App-Admin darf
   app/* schreiben" braucht — als Autorisierung *eines zusätzlichen
   Schreibers pro Node*, nicht pro Namespace. Wichtig: **write-before-grant
   ist ein permanenter Fehler** (Yjs-Clock-Lücke) — Grants müssen vor dem
   ersten Schreibversuch vorliegen.
5. **Events** (`@qu/events`): `EventBus` ist der einzige Hook-Mechanismus,
   überall im Client und Relay identisch. Jede neue Erweiterung (Router,
   Resolver, Executable-Module-Loader) sollte sich als Bus-Watcher
   einklinken, nicht als neuer Mechanismus — exakt wie `AliasRegistry` und
   `push-handler.js` es vormachen.
6. **`@qu/space-ui`** ist die einzige vorhandene UI-Schicht: reines
   Vanilla-JS/DOM-Binding (`bindField`, `bindList`, `makeInlineEditable`,
   Upload-Status), **keine Custom Elements, kein Component-System, kein
   Template-Rendering**. Ein `qu-*`-Component-/Slot-System ist komplett neue
   Arbeit, sollte aber `space-ui`s Bindings als Low-Level-Baustein
   wiederverwenden statt sie zu duplizieren.
7. **Relay** (`relay-app-server.js`) serviert heute statisch `demo/web/`
   und hat das bereits **als Platzhalter dokumentiert**: *"the intent is for
   this to grow into 'the app the relay serves on start' ... what replaces
   the current `demo/web/` client with a real one later"*. Die App Shell aus
   diesem Auftrag ist exakt dieser "spätere echte Client" — kein neuer
   Relay-Code nötig, nur `STATIC_FILES`/`webDir` auf das App-Shell-Build
   zeigen lassen.
8. Es existiert **keine** feingranulare ACL (Namespace→Kind→Node→Field, wie
   in Original-Abschnitt 21 unterstellt). Das Design muss also anfangs mit
   Kind-weiter ACL + Grants auskommen und die feinere Ebene explizit als
   spätere, separate Erweiterung ausweisen (siehe Abschnitt 21).

## 1. Ziel (unverändert)

Eine generische App Shell auf Basis von QuV5, die weder Quniverse noch
Messenger, Forum, Kalender oder eine andere konkrete Anwendung kennt. Sie
initialisiert die QuV5-Runtime, verbindet sich mit einem Qu Space und lädt
die eigentliche Anwendung aus App Manifest, Templates, Pages, Routes,
Components, Styles und Content, die als gewöhnlicher Qu-Content im Space
liegen.

**Leitprinzip (unverändert, ist bereits Repo-Philosophie):**

```
Relay ≠ App
Shell ≠ App
Framework ≠ App

Space + App Runtime = App
```

Das passt exakt zu `architecture.md` §1: "UI-agnostic core, optional UI
layer on top" — die App Shell ist einfach die nächste optionale Schicht
oberhalb von `@qu/space-ui`, nicht unterhalb.

## 2. Vier Ebenen (angepasst an tatsächliche Pakete)

| Ebene | Original-Begriff | Tatsächliche Entsprechung |
|---|---|---|
| 1 | QuV5 Framework | `@qu/core`, `@qu/events`, `@qu/space-core`, `@qu/space-storage`, `@qu/space-transport` (unverändert, **nicht anfassen**) |
| 2 | App Shell | neues, minimales Paket `@qu/app-shell` — Boot-Sequenz, DOM-Mountpoint |
| 3 | App Runtime | neue Pakete `@qu/app-core` (Manifest/Router/Resolver/Permissions) + `@qu/app-renderer` (Template/Slot/Component-Rendering, aufbauend auf `@qu/space-ui`) |
| 4 | Application Content | gewöhnliche Qu-Nodes neuer Kinds (`qu-app`, `qu-page`, `qu-template`, `qu-route-registry`, `qu-style`, `qu-theme`, `qu-security-policy`) — **kein neues Storage-Konzept** |

Framework bleibt exakt wie in `architecture.md` beschrieben: kennt keine
konkrete Anwendung, wird für dieses Vorhaben **nicht verändert** — mit einer
möglichen Ausnahme, siehe Abschnitt 21 (Grant-Erweiterung), die aber separat
und rückwärtskompatibel bliebe.

## 3. Minimaler App-Shell-Einstiegspunkt (unverändert im Konzept)

```html
<body>
    <qu-app-shell></qu-app-shell>
    <script type="module" src="/qu/app-shell.js"></script>
</body>
```

**Anpassung:** Diese `index.html` ersetzt konkret das, was
`relay-app-server.js` heute unter `/` bzw. `/index.html` aus
`demo/web/index.html` ausliefert. `STATIC_FILES` in
`relay-app-server.js` bekommt Einträge für den App-Shell-Build statt für
`demo/web/`; `relay-server.js`s `webDir`-Parameter zeigt dann auf
`packages/app-shell/dist/`. Das Relay-Modul selbst bleibt unverändert —
es weiß nach wie vor nicht, was es da ausliefert.

## 4. Boot-Sequenz (angepasst an reale API-Aufrufe)

```
index.html
    ↓
App Shell (app-shell.js)
    ↓
Identity laden/erzeugen (lokal, z.B. IndexedDB — Framework-Storage-API)
    ↓
new Space({ identity, members, transport, storage, bus })   ← @qu/space-core
    ↓
Transport verbinden (WsClientTransport)                     ← @qu/space-transport
    ↓
App Manifest auflösen: space.useNode(appManifestId, qu-app)
    ↓
AppRuntime starten (@qu/app-core)
    ↓
Route-Registry + Styles/Theme laden (registry-Node, s. Abschnitt 12)
    ↓
Components registrieren (@qu/app-renderer registry)
    ↓
Router initialisieren (Hash-Routing, s. Abschnitt 6)
    ↓
aktuelle Route auflösen → Page-Node laden
    ↓
Template-Node laden → Slots/Components rekursiv auflösen
    ↓
DOM rendern
```

**Anpassung gegenüber Original:** "Storage initialisieren" und "Transport
verbinden" sind im echten API keine getrennten Schritte, die die App Shell
selbst orchestriert — `new Space({...})` nimmt Storage/Transport/Bus fertig
konstruiert entgegen (`space.js`). Die App Shell instanziiert also Adapter
(`createFileStore`/IndexedDB-Adapter/`WsClientTransport`) und übergibt sie an
`Space`, statt eigene Lifecycle-Methoden dafür zu erfinden.

## 5. App Manifest — Kind `qu-app`

**Anpassung:** Kein `#/`-Pfad, sondern ein gewöhnlicher, selbstzertifizierender
Node. Ein App Manifest gehört einer **App-Admin-Identity** (Abschnitt 20) und
wird über `deriveOwnerNodeId(appAdminPub, 'qu-app')` gefunden — jeder, der die
App-Admin-Pubkey kennt (z.B. aus der Relay-/Deployment-Konfiguration), kann
das Manifest ohne Registry lokalisieren. Genau dasselbe Muster wie
`presenceKind`/`aliasRegistryKind`.

```js
export const appManifestKind = defineKind('qu-app', {
  fields: {
    name:           { shape: 'atomic', visibility: 'public' },
    version:        { shape: 'atomic', visibility: 'public' },
    rootTemplate:   { shape: 'atomic', visibility: 'public' }, // Node-ID oder Pfad-Key
    defaultRoute:   { shape: 'atomic', visibility: 'public' },
    theme:          { shape: 'atomic', visibility: 'public' },
    securityPolicy: { shape: 'atomic', visibility: 'public' }, // Node-ID des qu-security-policy Node
    metadata:       { shape: 'atomic', visibility: 'public' }, // JSON-String, bewusst unstrukturiert
  },
  acl: { write: 'named' }, // Owner (App-Admin) + ggf. delegierte Mitautoren
});
```

`visibility: 'public'` ist hier bewusst gewählt: Ein App-Manifest muss von
jedem Client ohne vorherige Space-Mitgliedschaft lesbar sein — sonst kann die
App Shell nicht einmal die Login-/Join-Seite rendern. Dasselbe Argument, das
`kind-schema.js` bereits für Identity-/Profil-Nodes macht.

## 6. Routing (unverändert im Konzept, präzisiert)

Hash-Routing (`#/forum/topic/123`) bleibt richtig, weil es **keinen
Relay-Request pro Route** erzeugt — konsistent mit "Relay bleibt
Application-blind" (Abschnitt 29). Der Router ist reiner Client-Code in
`@qu/app-core`, kennt keine konkreten Routen, sondern fragt den
**Route-Resolver** (Abschnitt 12) nach `route → pageNodeId`.

## 7-11. Pages, Templates, Components, Slots, Styles/Themes

Konzeptionell unverändert gegenüber dem Original. Als Kind-Schemas (Beispiele,
nicht final):

```js
export const pageKind = defineKind('qu-page', {
  fields: {
    route:    { shape: 'atomic', visibility: 'public' },
    title:    { shape: 'atomic', visibility: 'public' },
    template: { shape: 'atomic', visibility: 'public' }, // Template-Node-ID
    content:  { shape: 'text',   visibility: 'public' }, // HTML ODER strukturiertes JSON (s.u.)
    metadata: { shape: 'atomic', visibility: 'public' },
  },
  acl: { write: 'named' },
});

export const templateKind = defineKind('qu-template', {
  fields: { html: { shape: 'text', visibility: 'public' } },
  acl: { write: 'named' },
});

export const styleKind = defineKind('qu-style', {
  fields: { css: { shape: 'text', visibility: 'public' } },
  acl: { write: 'named' },
});
```

**Anpassung:** `content` als `shape: 'text'` (echter `Y.Text`) statt als
großer atomarer String ist kein Original-Punkt, aber folgt direkt aus
Abschnitt 7 ("nicht zwingend große unstrukturierte HTML-Strings" +
"kollaborative Bearbeitung" in Abschnitt 27) — `Y.Text` gibt kollaboratives
Editieren praktisch gratis, weil es exakt der Mechanismus ist, den
`field.js`/`TextField` bereits für genau diesen Zweck bereitstellt. Für die
"strukturierte Qu Components/Nodes"-Variante (visueller Editor, Abschnitt 27)
ist `shape: 'list'` von Section-Nodes der natürliche Kandidat — jedes Element
ein JSON-Objekt `{type, props, children}`; das ist späteres Ausbaustadium,
sollte aber jetzt schon im Kind-Schema nicht ausgeschlossen werden (z.B.
`content` optional durch ein `sections`-Listenfeld ersetzbar).

Slot-Auflösung, Component-Registry: reine `@qu/app-renderer`-Logik, kein
Space-API-Bezug — dafür gibt es im Framework nichts wiederzuverwenden außer
dem generellen "Registry-Objekt mit `register/get/list`"-Stil von
`KindRegistry`.

## 12. Namespace-Modell (grundlegend angepasst)

**Das ist der Punkt, an dem sich das Original am stärksten von der Realität
unterscheidet.** Es gibt in `space-core` kein Dateisystem, keine Pfade, keine
"Ordner" — nur Node-IDs (String) und Kinds. Ein `#/app/pages/*`-Baum wie im
Original ist keine Storage-Struktur, sondern **eine Auflösungs-Konvention**,
gebaut aus zwei vorhandenen Bausteinen:

1. **Deterministische IDs für "genau ein bekanntes Ding"** — wie
   `deriveOwnerNodeId(pub, kind)` bereits für `qu-app`, Presence, Alias-Registry
   tut. Für Pages/Templates braucht es eine kleine Erweiterung um eine
   *Pfad-Komponente*, z.B. in `@qu/app-core` (nicht in `space-core` — das
   Framework bleibt unverändert):

   ```js
   // @qu/app-core — NICHT in space-core, baut nur auf dessen Primitiven auf
   async function deriveContentNodeId(ownerPub, kind, path) {
     const digest = await QuCrypto.sha256(
       new TextEncoder().encode(`${kind}:${QuCrypto.toBase64(ownerPub)}:${path}`)
     );
     return '~' + QuCrypto.toBase64Url(digest);
   }
   ```

   Damit lässt sich `template/forum` bei bekanntem App-Admin-Pubkey direkt
   auflösen, ganz ohne Registry-Lookup.

2. **Registry-Nodes für "gib mir alle"** — exakt das `alias.js`-Muster: ein
   Node vom Kind `qu-route-registry` (Owner = App-Admin, `acl.write: 'named'`),
   dessen `routes`-Feld (`shape: 'list'`, Einträge `{route, pageNodeId}`) die
   Menge aller Routen der App hält. Analog `qu-component-registry` für
   installierte Components. Das ist nötig, weil ein Router *nicht* für jede
   denkbare Route raten kann, ob sie existiert — er muss die Menge kennen.

Das Original-Baumbild bleibt als **logisches** Modell sinnvoll (für
Dokumentation, Dev-Tools, mentale Landkarte), ist aber **kein** physisches
Speicherlayout:

```
qu-app (Manifest, ~pub/<app-admin>)
 ├── qu-route-registry (~pub/<app-admin>)   → Liste { route → pageNodeId }
 ├── qu-page Nodes (deriveContentNodeId(app-admin, 'qu-page', route))
 ├── qu-template Nodes (deriveContentNodeId(app-admin, 'qu-template', name))
 ├── qu-style / qu-theme Nodes (dito)
 └── global/user Content: siehe unten
```

## 13-14. Globaler Content und User Content (angepasst)

**Global:** genau wie App-Content, nur mit einer **relay-admin**-Identity als
Owner statt app-admin (Abschnitt 20). `#/global/templates/*` wird
`deriveContentNodeId(relayAdminPub, 'qu-template', name)`.

**User Content (`~pub/<identity>/...`):** Hier passt das Original-Namensschema
fast 1:1 auf ein bereits vorhandenes Konzept — `'owner'`-ACL-Node-IDs tragen
schon heute das `~`-Präfix (`OWNER_NODE_PREFIX` in `kind-schema.js`). Ein
User-eigenes Theme ist einfach `deriveContentNodeId(userPub, 'qu-theme',
'default')` — **kein neuer Mechanismus**, nur dieselbe Owner-ACL-Konvention,
die Presence und Alias-Registry längst nutzen. Für das Relay ist das ein ganz
gewöhnlicher `'owner'`-Kind-Node, keine Sonderbehandlung.

## 15-16. Override-/Resolution-System und Framework Defaults (konkretisiert)

```
User Override   (~pub/<identity>/..., höchste Priorität)
    ↓
App Override    (owner = app-admin)
    ↓
Global Content  (owner = relay-admin)
    ↓
Framework Default (im @qu/app-renderer-Bundle einkompiliert, Fallback)
```

`ContentResolver` (Abschnitt 23) probiert die IDs in dieser Reihenfolge via
`space.useNode(id, kind)` und nimmt den ersten Treffer. **Wichtig, weil
lokal-first:** `useNode()` prüft zuerst lokalen Storage, dann Netz — ein
Override-Versuch für eine Ebene, die es nicht gibt, ist kein Fehler, sondern
schlicht ein `useNode()`, der nie einen Node-Content liefert (Timeout/kein
Treffer), und der Resolver geht zur nächsten Ebene über. Das muss im Resolver
sauber mit Timeouts/AbortSignal gehandhabt werden, sonst blockiert eine
fehlende User-Override-Ebene das Rendering.

## 17-18. Security: JavaScript und Security Policy (angepasst)

Konzept (drei Vertrauensstufen) bleibt richtig. **Anpassung:** Die
Durchsetzung sollte sich am bereits etablierten Bus-Watcher-Muster
orientieren statt an einem neuen Sandbox-Mechanismus:

- **Stufe 1 (Content):** HTML/CSS/Templates/Pages — der Renderer fasst diese
  Strings **nie** mit `eval`/`new Function`/`innerHTML` von Skript-Tags an.
  Ein `app-renderer`-Sanitizer (eigenes Unterpaket, wie im
  Original vorgeschlagen) entfernt `<script>` und `on*`-Attribute aus jedem
  aus dem Space geladenen HTML kompromisslos, bevor es ins DOM geht.
- **Stufe 2 (Trusted Components):** Ein `qu-*`-Tag löst über die
  Component-Registry (`@qu/app-renderer`) auf. Registrierung geschieht **nur**
  durch tatsächlich mit dem App-Shell-/App-Renderer-Bundle ausgeliefertes
  JS (statisch importiert) — niemals durch aus dem Space geladenen Code.
  Das deckt sich mit "Components sollen nicht automatisch JavaScript
  benötigen" (Original §9): ein deklaratives Component ist nur Template +
  Props + Slots, ganz ohne JS-Modul.
- **Stufe 3 (Executable Modules):** Dynamischer `import()` einer Modul-URL ist
  nur erlaubt, wenn (a) die URL/der Hash in der `qu-security-policy` des
  Manifests unter `trustedModuleSigners`/erlaubten Hashes steht, UND (b) diese
  Policy selbst von `relay-admin`/`app-admin` (`'owner'`/`'named'`-ACL)
  geschrieben wurde, nicht von normalem User-Content. Ganz konkret: Die
  Policy-Node-ID kommt aus dem `qu-app`-Manifest-Feld `securityPolicy`
  (Abschnitt 5), und *dieses Manifest* ist bereits `'named'`-ACL-geschützt —
  ein normaler User kann die Policy also strukturell nicht überschreiben,
  weil er gar keine Schreibberechtigung auf diesen Node hat. Das ist exakt
  "die Policy soll selbst geschützt sein" aus dem Original, umgesetzt mit
  vorhandenem ACL-Mechanismus statt einem neuen Schutzkonzept.

```js
export const securityPolicyKind = defineKind('qu-security-policy', {
  fields: {
    allowInlineScript:    { shape: 'atomic', visibility: 'public' },
    allowExternalScript:  { shape: 'atomic', visibility: 'public' },
    allowDynamicModules:  { shape: 'atomic', visibility: 'public' },
    trustedModuleSigners: { shape: 'list',   visibility: 'public' }, // Pubkeys (base64)
    allowIframe:          { shape: 'atomic', visibility: 'public' },
    allowExternalAssets:  { shape: 'atomic', visibility: 'public' },
  },
  acl: { write: 'named' },
});
```

Phase 1 (Abschnitt 34) braucht **kein** Modul-Signatur-/Sandbox-System zu
implementieren — es reicht, dass Stufe 3 strukturell noch **gar nicht**
erreichbar ist (kein `import()`-Aufruf im Renderer-Code), damit "beliebiges
JavaScript wird nicht automatisch ausgeführt" (Akzeptanzkriterium 16) von
Anfang an gilt.

## 19-21. Admin Identity, Rollen, ACL-Erweiterung (grundlegend angepasst)

**Status: `relay-admin`-Rolle implementiert, inkl. eines echt vertraulichen
Admin-Realms**, siehe architecture.md §7 ("The Platform layer"). Statt (wie
unten ursprünglich skizziert) Owner globaler Content-Kinds zu sein, ist die
`relay-admin`-Rolle in ZWEI Teilen umgesetzt:

1. Ein additiv-only Registry-Kind (`qu-platform-apps`, `'named'`-ACL auf
   die Relay-Admin-Pubkey), das Pfad-Präfixe auf App-Admin-Pubkeys
   abbildet — `@qu/app-core`'s `PlatformRuntime`/`installAppBundle()`/
   `registerApp()`. Registrierung ist rein optional/kosmetisch: jede App
   ist per Default bereits unter ihrer eigenen Owner-Id erreichbar, ganz
   ohne Mitwirkung des relay-admin (`PlatformRuntime.resolveForPath()`s
   eigener Fallback).
2. Ein ECHTER, separater, vertraulicher `Space`/Relay-Forwarder (der
   "Admin-Realm", eigene `members`-Liste via `QU_RELAY_ADMINS`,
   erreicht über `/admin-ws`) für alles, was tatsächlich NUR für Admins
   lesbar sein soll — inklusive der eingebauten `#/admin`-Konsole selbst,
   die als GEWÖHNLICHER, installierter Qu-Content dort lebt
   (`packages/app-shell/admin-console-bundle.js` +
   `bin/install-admin-console.mjs`), nicht als Framework-Sonderfall.

Bewusst KEIN Superuser über gewöhnlichen App-Content: ein `app-admin`
bleibt alleiniger Owner seines eigenen `qu-app`/`qu-page`/`qu-template`/
`qu-style`, der relay-admin entscheidet nur, WELCHE bereits installierten
Apps unter welchem Präfix eine Alias-Adresse bekommen (bzw. wer den
Admin-Realm lesen/schreiben darf — dort gilt `acl.write: 'members'`, jeder
konfigurierte Admin gleichberechtigt, kein Einzel-Owner). `qu-platform-apps`
selbst ist inzwischen `acl.write: 'relay-admins'` (`@qu/space-core`s
kind-schema.js eigener Kommentar zu diesem Modus) — dieselbe STATISCHE,
beim Relay-Start konfigurierte Liste (`QU_RELAY_ADMINS`, ersetzt die
früheren getrennten `QU_APP_ADMIN_PUBS`/`QU_RELAY_ADMIN_PUB`/
`QU_RELAY_ADMIN_MEMBERS_JSON`) trägt jetzt sowohl die Admin-Realm-
Mitgliedschaft als auch das Schreibrecht auf die Plattform-Registry, mit
mehreren gleichberechtigten Relay-Admins statt einem Einzel-Owner. Ein
NEUER App-Admin braucht dagegen KEINEN eigenen statischen Eintrag mehr:
`registerApp()` allein genügt, der Relay beobachtet `qu-platform-apps`
selbst live (`packages/app-shell/src/live-app-resolver.js`, eine interne,
über `InProcessTransport` an den eigenen Hub angebundene `Space`) und
reklassifiziert die neue Identität ohne Neustart — die früher hier als
offen benannte Live-Discovery-Lücke (siehe architecture.md §7) ist damit
geschlossen.

**Anpassung:** Das Original unterstellt eine bereits vorhandene, erweiterbare
ACL-Hierarchie (Space → Namespace → Kind → Node → Field). Die gibt es nicht.
Was es gibt: **Kind-weite** ACL (`members`/`owner`/`named`) plus
node-spezifische Grants (`grantWriter`). Für Phase 1 reicht das vollständig
aus, wenn Rollen als **Identities mit bestimmten Owner-Beziehungen** modelliert
werden, nicht als eigenes Rechte-System:

| Rolle | Umsetzung mit vorhandenen Mitteln |
|---|---|
| `relay-admin` | Eine normale Qu-Identity. Ihre Pubkey ist Owner der globalen Content-Kinds (`qu-template`/`qu-style`/... unter `global/`). Kein Relay-Sonderrecht — das Relay verifiziert Schreibzugriffe auf diese Nodes exakt wie bei jedem `'owner'`/`'named'`-Kind über `deriveOwnerNodeId`/`verifyGrant`. Der private Key liegt beim Betreiber/Admin-Client, nie beim Relay-Prozess. |
| `app-admin` | Eine Identity, Owner des `qu-app`-Manifests und aller `qu-page`/`qu-template`/`qu-route-registry`/`qu-style`-Nodes der App (alle `acl.write: 'named'`). Zusätzliche Mitautoren via `space.grantWriter(nodeId, kind, granteePub)` — **vor** dem ersten Schreibversuch des Grantees (siehe Abschnitt 0.4). |
| `user` | Schreibt nur eigene `'owner'`-ACL-Nodes (`~`-Präfix, eigene Pubkey) — das ist bereits die Standard-Semantik von `acl.write: 'owner'`, keine Sonderregel nötig. |

**Feinere Berechtigungen (Original-Abschnitt 21) sind explizit
zurückgestellt**, nicht implementiert: Eine spätere Erweiterung wäre am
ehesten ein zusätzliches, optionales `pathPrefix`-Feld in `signGrant()`
(analog zum bestehenden `kind`-Feld) plus eine Prüfung in
`relay.js`/`verifyEnvelope()`, die den Node-ID-Präfix gegen den Grant
abgleicht — das wäre eine Erweiterung *innerhalb* des bestehenden
Grant-Mechanismus, kein Parallelsystem. Diese Erweiterung ist **nicht Teil
von Phase 1** (siehe Abschnitt 34) und würde, falls nötig, in `space-core`/
`space-transport` selbst landen (einzige Ausnahme vom "Framework bleibt
unverändert"-Grundsatz), nicht in der App Shell.

## 22-23. App Runtime API / Content Resolver (angepasst)

```js
// @qu/app-shell
class AppShell {
  async boot({ identity, relayUrl, storage }) { /* baut Space auf, startet AppRuntime */ }
}

// @qu/app-core
class AppRuntime {
  constructor(space, { manifestId, bus }) {}
  async resolveManifest()
  async resolveRoute(hash)          // → { pageNodeId } | null
  async resolvePage(pageNodeId)
  async resolveTemplate(templateId) // durchläuft ContentResolver (Override-Kette)
  async resolveComponent(name)
  async resolveStyle(styleId)
  async render(rootEl)
}

// @qu/app-core
class ContentResolver {
  constructor(space, { appAdminPub, relayAdminPub }) {}
  async resolve(kind, path, { userPub? }) // Override-Kette aus Abschnitt 15
}
```

**Anpassung:** `createSpace()`/`initializeStorage()`/`initializeTransport()`
aus dem Original sind keine separaten AppShell-Methoden, weil `Space` diese
Konstruktion bereits selbst als Konstruktor-Parameter kapselt
(`new Space({identity, members, transport, storage, bus})`, `space.js`).
Die App Shell instanziiert die Adapter und übergibt sie — mehr nicht.
`ContentResolver` ist bewusst **kein** Storage: er ruft ausschließlich
`space.useNode()`/`loadNode()` auf (Original-Vorgabe in Abschnitt 23/24
bereits korrekt, hier nur konkretisiert).

## 24. Storage (bestätigt, keine Änderung nötig)

Bereits heute genau das geforderte Bild: `@qu/space-storage` bietet
Memory/Durable/File-Adapter mit identischem Contract
(`append/load/replace`), `Space` nimmt einen Adapter entgegen, ohne ihn zu
kennen. Für den Browser fehlt aktuell ein IndexedDB-Adapter — das ist die
einzige tatsächlich neue Storage-Arbeit, und sie gehört nach
`@qu/space-storage` (Framework-Ebene), nicht in die App Shell, weil sie
denselben `append/load/replace`-Contract implementiert wie die drei
bestehenden Adapter. Private Keys bleiben getrennt (z.B. eigener,
nicht-synchronisierter IndexedDB-Object-Store oder WebCrypto
`non-extractable` Keys) — das ist ein reines App-Shell-Detail beim
Identity-Bootstrap, keine Framework-Änderung.

## 25. Dev-/Admin-Modus (unverändert im Konzept)

`qu.dev.createPage(...)` etc. sind dünne Wrapper um
`space.createNode(pageKind, {...}, {id: deriveContentNodeId(...)})` +
Route-Registry-Update. Ein Bundle-Import (`manifest.json` + `templates/` +
...) iteriert einfach über dieselben `createNode`-Aufrufe. Kein neuer
Mechanismus, nur Tooling oberhalb der Kind-Schemas aus Abschnitt 5-11.

## 26-27. Publishing/Drafts, CMS-Fähigkeit (Publishing/Drafts unverändert
als Ausblick; ein In-Browser-CMS-Editor ist inzwischen gebaut)

Publish/Draft-States (ein `status`-Feld `draft|published|archived` auf
`pageKind`) bleiben bewusst außerhalb von Phase 1 (siehe Original-Abschnitt
34, unverändert übernommen) — `content` als `Y.Text` verhindert das nicht,
das Feld lässt sich jederzeit nachträglich ergänzen (Yjs-Maps sind da
tolerant). Die CMS-Fähigkeit selbst — Templates/Styles im Browser anlegen
und Page-Daten über einen Editor speichern, statt nur über die CLI-Dev-API
— ist dagegen inzwischen gebaut: `packages/app-shell/cms-bundle.js` +
`src/cms-actions.js`, siehe `architecture.md` §7's "The built-in CMS
editor" für die vollständige Beschreibung. Draft/Publish bleibt trotzdem
offen — der Editor schreibt immer direkt, es gibt noch keinen
Zwischenzustand.

## 28-29. Framework/Application Content trennen, Relay bleibt
Application-blind (bestätigt, keine Änderung)

Beides ist bereits geltende Architekturregel dieses Repos
(`architecture.md` §1, `relay.js`s "content-blind by construction"). Diese
Vorgabe verstärkt nur, was ohnehin gilt — keine Anpassung nötig, aber wichtig
gegenzuprüfen: **keine** neuen HTTP-Endpunkte in `relay-app-server.js` für
`/pages`, `/templates` etc. Alles läuft über den bestehenden WebSocket-
Envelope-Mechanismus (`subscribe`/Updates), nicht über REST.

## 30. Repository-Struktur (angepasst an flache Paketkonvention)

**Anpassung:** Das Original schlägt verschachtelte Unterordner pro Paket vor
(`app-core/manifest/runtime/router/resolver/permissions/`). Das Repo nutzt
durchgehend **flache** `packages/<name>/src/*.js`-Pakete
(vgl. `packages/space-core/src/`). Zielstruktur, minimal, keine unnötigen
Pakete (§30 des Originals, hier ernst genommen — `app-components` und
`app-storage` als eigene Pakete entfallen):

```
packages/
├── core/            (bestehend, unverändert)
├── events/           (bestehend, unverändert)
├── space-core/        (bestehend, unverändert)
├── space-storage/      (bestehend — ggf. + IndexedDB-Adapter, Abschnitt 24)
├── space-transport/     (bestehend, unverändert — relay-app-server.js zeigt künftig auf app-shell/dist)
├── space-plugins/        (bestehend, optional, unverändert)
├── space-ui/               (bestehend, optional, unverändert — app-renderer baut darauf auf)
│
├── app-core/          @qu/app-core
│   └── src/
│       ├── kinds.js          — qu-app/qu-page/qu-template/qu-route-registry/qu-style/qu-theme/qu-security-policy
│       ├── content-id.js     — deriveContentNodeId() (Abschnitt 12)
│       ├── resolver.js       — ContentResolver, Override-Kette (Abschnitt 15/23)
│       ├── router.js         — Hash-Router (Abschnitt 6)
│       ├── runtime.js        — AppRuntime (Abschnitt 22)
│       └── index.js
│
├── app-renderer/       @qu/app-renderer
│   └── src/
│       ├── template.js       — Slot-Auflösung (Abschnitt 11)
│       ├── components.js     — Component-Registry + Built-ins (Abschnitt 9)
│       ├── sanitizer.js       — HTML/Script-Sanitizing (Abschnitt 17)
│       ├── styles.js          — Style/Theme-Injection (Abschnitt 11)
│       └── index.js
│
└── app-shell/           @qu/app-shell
    └── src/
        ├── boot.js            — Boot-Sequenz (Abschnitt 4)
        ├── shell.js            — <qu-app-shell> Bootstrap-Element
        └── index.html/index.js — Build-Ziel, das relay-app-server.js künftig ausliefert
```

## 31. (bereits als Abschnitt 0 vorgezogen)

## 32-35. Phase-1-Ergebnis, Akzeptanzkriterien, Nicht-Ziele, Leitprinzip
(inhaltlich unverändert, terminologisch angepasst)

Phase 1 bleibt exakt der Proof of Concept aus dem Original: leere
`index.html` → App Shell → Space → `qu-app`-Manifest → Route-Registry → Page
→ Template → Slot/Component → DOM, demonstriert an `#/` und `#/hello`.

Akzeptanzkriterien 1-20 bleiben inhaltlich gültig; Kriterium 18 ("Admin-Rechte
sind an Qu Identities/ACLs gekoppelt") ist mit dem in Abschnitt 19-21
beschriebenen Owner-/Named-ACL-Modell bereits mit **vorhandenen** Mitteln
erfüllbar, ohne neue ACL-Konzepte zu bauen. Kriterium 20 ("leere Shell →
funktionsfähige Anwendung via Dev/Admin API") entspricht Abschnitt 25.

Nicht-Ziele (Original-Abschnitt 34) bleiben unverändert gültig — insbesondere
"vollständige Node-/Field-Level-ACL" bleibt explizit außerhalb von Phase 1
(vgl. Abschnitt 21 dieser Fassung).

Leitprinzip bleibt wörtlich wie im Original, siehe Abschnitt 1 oben.

---

## Wichtigste Abweichungen gegenüber dem Original — Kurzfassung

Für alle, die nur den Diff wollen:

1. **Kein Namespace-Primitive im Framework** — `#/app/...`/`#/global/...`/
   `#/~pub/...` sind eine Auflösungs-Konvention in `@qu/app-core`
   (deterministische IDs + Registry-Nodes), keine Speicherstruktur in
   `space-core`.
2. **ACL ist Kind-weit, nicht hierarchisch** — Rollen (relay-admin/app-admin/
   user) werden über Owner-/Named-ACL und Grants abgebildet, nicht über ein
   neues RBAC-System. Feingranulare ACL bleibt bewusst zurückgestellt.
3. **Relay muss nicht angefasst werden** — `relay-app-server.js` hat den
   Umbau bereits als Platzhalter dokumentiert; nur der ausgelieferte
   Static-Build ändert sich.
4. **`@qu/space-ui` ist die Grundlage von `@qu/app-renderer`**, nicht
   Konkurrenz dazu — Field-Binding/List-Diffing wird wiederverwendet, nicht
   neu gebaut.
5. **Flache Paketstruktur statt verschachtelter Unterordner**, drei neue
   Pakete statt fünf (`app-core`, `app-renderer`, `app-shell`) — keine
   separaten `app-components`/`app-storage`-Pakete in Phase 1.
6. **Executable-Module-Trust läuft über die bestehende Manifest-ACL**
   (Security-Policy-Node ist selbst `'named'`-ACL-geschützt), nicht über ein
   neues Schutzkonzept.
