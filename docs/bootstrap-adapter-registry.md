# Bootstrap: the Mountpoint/Adapter-Registry (`@qu/bootstrap`)

> Umsetzung von Arbeitspaket 2 aus `docs/quv5-vs-quv3-decision.md`: "Dünne
> generische Schicht über dem bestehenden Space/Transport/Storage-Split,
> die Pfade explizit auf Adapter mappt — macht Verdrahtung deklarativ statt
> ad hoc im Bootstrap-Code."

## Das Problem

`Space` (`@qu/space-core`) war immer schon Dependency-Injection-fähig — der
Konstruktor nimmt `identity`/`transport`/`storage`/`volatileStorage` als
fertig konstruierte Objekte entgegen, nie als Klassennamen. Das Problem lag
eine Ebene höher: **welche konkrete Adapter-Klasse** an einer Bootstrap-Stelle
tatsächlich verwendet wird, stand bislang als harter `import` im Code, z. B.
in `@qu/app-shell`'s `shell.js` (vor diesem Paket):

```js
import { createIndexedDbStore, isIndexedDbAvailable } from '@qu/space-storage/indexeddb-store';
import { WsClientTransport } from '@qu/space-transport/ws-client-transport';
// ...
const transport = new WsClientTransport(relayUrl);
const storage = isIndexedDbAvailable() ? createIndexedDbStore() : undefined;
const space = new Space({ identity, members, transport, storage });
```

Ein Deployment, das einen anderen Transport oder Storage-Backend wollte,
musste diesen Code ändern. Das ist genau die QuV3-Lücke, die Arbeitspaket 2
schließt: QuV3 hatte `QuMount.resolve(path)` — eine generische,
Pfad→Adapter-Registry; in V5 gibt es (mangels flacher Pfad-Namespace) keinen
Pfad zum Dispatchen, aber dieselbe Grundidee lässt sich eine Ebene höher
anwenden: **welcher Adapter welchen Slot (`identity`/`transport`/`storage`/
`volatileStorage`) bedient, ist ein benannter Bootstrap-Parameter, nie ein
Hardcoded-Import.**

## Die zwei Bausteine

### `AdapterRegistry`

Eine reine `(slot, name) -> factory`-Map, ohne jede Kenntnis von Qu selbst:

```js
import { AdapterRegistry } from '@qu/bootstrap';

const registry = new AdapterRegistry();
registry.register('storage', 'my-backend', (options) => new MyStorageAdapter(options));
```

`register()` wirft bei einem doppelt vergebenen `(slot, name)`-Paar — das ist
fast immer ein Konfigurationsfehler (zwei Adapter-Packs, die denselben Namen
für sich reklamieren), nie etwas, das die zweite Registrierung stillschweigend
gewinnen lassen sollte.

### `bootstrapSpace()`

Löst jeden Slot entweder über die Registry (`{adapter: '<name>', ...options}`)
oder nimmt eine bereits fertig konstruierte Instanz direkt entgegen (alles
ohne `adapter`-Property), konstruiert dann die `Space`:

```js
import { bootstrapSpace } from '@qu/bootstrap';

const { space } = await bootstrapSpace({
  registry,
  identity: { adapter: 'local-storage', key: 'qu-identity' },
  transport: { adapter: 'ws-client', url: 'wss://relay.example.com' },
  storage: { adapter: 'indexeddb' },
  members,
});
```

`identity` und `transport` sind Pflicht; `storage`/`volatileStorage` bleiben
optional (wie bei `Space` selbst). `transport.connect()` wird automatisch
aufgerufen. `bus` bekommt standardmäßig einen frischen `EventBus` (anders als
`Space`s eigener `null`-Default) — `bus: null` schaltet das explizit ab.

## Mountpoint (Slot) vs. Pack — zwei verschiedene Achsen, nicht zu verwechseln

Es gibt genau EINEN universellen Satz an Mountpoints/Slots:
`identity`/`transport`/`storage`/`volatileStorage`. Das ist die Adresse, die
ein Peer kennt und anspricht — `Space` selbst ruft nur `storage.append(...)`/
`storage.load(...)`/`transport.send(...)` auf und hat **keinerlei** Kenntnis
davon, ob dahinter IndexedDB, eine Datei oder `localStorage` steckt. Dieser
Vertrag war schon vor `@qu/bootstrap` universell (`Space`'s Konstruktor ist
seit jeher Dependency-Injection-fähig) — `@qu/bootstrap` fügt nur hinzu,
DASS der konkrete Adapter hinter einem Slot per Config-Name statt per
Hardcoded-Import gewählt wird. Peer-seitiger Code fragt also NIE "bin ich im
Browser?" — er fragt "wie spreche ich `storage` an?", und die Antwort ist
für jeden Adapter identisch.

`@qu/bootstrap/memory`, `/browser`, `/node` sind dagegen **keine** zweite
Mountpoint-Ebene, sondern reine Bundling-Gruppierungen — eine Folge einer
harten, im Repo schon lange vor diesem Paket etablierten Einschränkung:
esbuild kann `node:fs`/das `ws`-Paket nicht in ein Browser-Bundle auflösen,
selbst wenn der Code-Pfad zur Laufzeit nie ausgeführt würde (deshalb
importieren `@qu/space-storage`'s `indexeddb-store.js` und
`@qu/space-transport`'s `ws-client-transport.js` seit jeher über eigene
Subpaths, nie über ihr jeweiliges Barrel — siehe deren eigene Doc-Kommentare).
Ein einziges "erkennt automatisch Browser vs. Node"-Pack ist aus demselben
Grund NICHT sicher baubar: ein `if (…) await import('./node.js')` würde von
esbuild trotzdem STATISCH aufgelöst — der "tote" Zweig mit `node:fs` würde
wieder ins Browser-Bundle gezogen und den Build brechen. Die Trennung muss
auf Datei-Ebene bleiben, damit der Bundler den ungenutzten Zweig gar nicht
erst sieht.

**Praktische Konsequenz:** ein Deployment wählt GENAU EINMAL, an seinem
eigenen Bundle-Einstiegspunkt (so wie `@qu/app-shell`'s `shell.js` es tut),
welches Pack es registriert — z. B. `registerBrowserAdapters()` im
Browser-Bundle-Einstieg, `registerNodeAdapters()` in einem Node-Prozess. Ab
diesem einen Aufruf ist für JEDEN weiteren Codepfad (App-Code, `@qu/app-core`,
UI-Komponenten) komplett unsichtbar, welcher Adapter tatsächlich läuft — die
Wahl bleibt vollständig auf den Bootstrap-Einstiegspunkt beschränkt.

## Mitgelieferte Adapter-Packs

Bewusst NICHT automatisch registriert — jedes Deployment baut sich seine
eigene Registry aus genau den Packs zusammen, die es tatsächlich bundeln will
(Browser-Code darf z. B. nie `node:fs` mitziehen):

| Pack | Export | Slots | Für |
|---|---|---|---|
| Identity | `@qu/bootstrap` (`registerIdentityStoreAdapters`) | `identity`: `'memory'`, `'local-storage'`, `'session-storage'` | Jedes Deployment — immer separat aufgerufen, siehe unten. |
| Memory | `@qu/bootstrap/memory` (`registerMemoryAdapters`) | `storage`/`volatileStorage`: `'memory'`; `transport`: `'in-process'` | Tests, Demos, rein temporäre Peers. |
| Browser | `@qu/bootstrap/browser` (`registerBrowserAdapters`) | `storage`: `'indexeddb'`; `transport`: `'ws-client'` | Ein echtes Browser-Deployment (`@qu/app-shell`'s `shell.js`). |
| Node | `@qu/bootstrap/node` (`registerNodeAdapters`) | `storage`: `'file'`/`'durable'`; `transport`: `'ws-client'` | Server/CLI-Peers. |

Dieselben SLOT-NAMEN (`storage`, `transport`) tauchen in mehreren Packs
wieder auf (nur `volatileStorage`/`identity` sind exklusiv einem Pack
zugeordnet) — das ist kein Zufall, sondern zeigt genau die obige Trennung:
`storage: {adapter: 'indexeddb'}` und `storage: {adapter: 'file'}` sind zwei
NAMEN im selben universellen Slot, nur aus verschiedenen Packs registriert.

**Warum Identity ein eigener Schritt ist:** `registerBrowserAdapters()` und
`registerMemoryAdapters()` würden sonst beide versuchen, dieselben
`identity`-Namen zu registrieren, sobald ein Deployment beide Packs
kombiniert (z. B. "Browser-Storage/-Transport, aber eine flüchtige
In-Memory-Identität für eine Wegwerf-Raum-Instanz") — `AdapterRegistry`
lehnt das als Duplikat ab. Deshalb immer:

```js
import { AdapterRegistry, registerIdentityStoreAdapters, bootstrapSpace } from '@qu/bootstrap';
import { registerBrowserAdapters } from '@qu/bootstrap/browser';

const registry = new AdapterRegistry();
registerIdentityStoreAdapters(registry);
registerBrowserAdapters(registry);
```

## Identität: wo lebt sie, wie lange?

`identity-stores.js` (`@qu/bootstrap`) verallgemeinert das, was vorher
`@qu/app-shell`'s `identity.js` allein anbot — "wo liegt die lokale
Identität" ist eine Bootstrap-Entscheidung, keine App-Shell-Spezifität.
Drei eingebaute Adapter, EINE Achse: wie lange die Identität überlebt.

- **`'local-storage'`** — überlebt Reload UND Browser-Neustart (gleicher
  Origin). Die "primäre lokale Identität" — eine pro Browser/Profil, über
  alle Apps eines Origins hinweg geteilt.
- **`'session-storage'`** — überlebt Reload, weg sobald der Tab schließt.
- **`'memory'`** — überlebt nur, solange der Prozess selbst läuft (ein
  In-Process-`Map`, geschlüsselt über `key`): mehrfache `bootstrapSpace()`-
  Aufrufe im selben Prozess mit demselben `key` bekommen dieselbe generierte
  Identität, nichts überlebt einen Neustart. Der richtige Default für eine
  echt TEMPORÄRE Identität — GunDB-artiger "Fake-User"/Raum-Instanz, ein
  Test, ein Demo-Peer.

Ein Aufruf ohne jeden `identity`-Adapter (ein direkt übergebenes, frisch
generiertes Keypair) bleibt weiterhin möglich — das ist die "nicht einmal
prozesslokal persistiert, jedes Mal ein neues Keypair"-Variante, für die es
bewusst KEINEN benannten Adapter gibt (sie braucht keinen: einfach
`QuCrypto.generateKeypair()` aufrufen und das Ergebnis direkt als `identity`
übergeben).

Alle drei Adapter rufen letztlich dieselbe `loadOrCreateIdentity(storage,
key)` auf — eine vierte Variante (z. B. Dateisystem-basiert für eine CLI)
registriert einfach ihren eigenen `storage`-förmigen Adapter gegen den
`'identity'`-Slot, ohne Änderung an diesem Paket.

`@qu/app-shell`'s `identity.js` exportiert `loadOrCreateIdentity`/
`IDENTITY_STORAGE_KEY` unverändert weiter (ein reiner Re-Export, keine
zweite Implementierung) — wichtig nicht nur aus Tidiness-Gründen, sondern
für Korrektheit: `shell.js` und `dev-console.js` müssen für denselben
Storage-Key dieselbe In-Flight-Promise-Absicherung teilen (siehe
`identity-stores.js`'s eigenen Doc-Kommentar zur Race-Bedingung bei zwei
gleichzeitigen ersten Aufrufen), was eine zweite, unabhängige Kopie derselben
Logik stillschweigend brechen würde.

## Einen eigenen Adapter registrieren

Kein Änderung an diesem Paket nötig — jeder Aufrufer kann jederzeit einen
eigenen Adapter für einen bestehenden oder neuen Slot registrieren:

```js
registry.register('storage', 'my-backend', ({ connectionString }) => createMyStorage(connectionString));
// ...
await bootstrapSpace({ registry, identity, transport, storage: { adapter: 'my-backend', connectionString } });
```

Ein komplett neuer SLOT (nicht nur ein neuer Adapter für einen bestehenden)
funktioniert genauso — `AdapterRegistry` kennt a priori keine festen
Slot-Namen, `bootstrapSpace()` fragt nur die vier ab, die `Space` selbst
braucht.

## Was dieses Paket bewusst NICHT tut

- Es entscheidet nicht, WELCHE Kind-Schemas/ACL-Modi existieren (das bleibt
  `@qu/space-core`).
- Es löst nicht die Mitgliederliste (`members`/`relayAdmins`) über die
  Registry auf — das bleibt Sache des Aufrufers (`joinSpace()`/
  `fetchRelayAdmins()`, `@qu/app-shell`'s `identity.js`), da diese vom
  konkreten Relay-Protokoll abhängen, nicht vom generischen Adapter-Konzept.
- Es bietet keine Laufzeit-Entdeckung ("was für Adapter gibt es alles")
  über Prozessgrenzen hinweg — `registry.names(slot)` listet nur, was DIESER
  Prozess tatsächlich registriert hat.

Diese drei Punkte sind bewusste Abgrenzungen, keine Lücken: das
Peer-/User-Management (GunDB-artige User-Nodes, öffentlich/verschlüsselt,
siehe `docs/quv5-vs-quv3-decision.md` Arbeitspaket 5) baut auf der
`'identity'`-Slot-Idee dieses Pakets auf, ist aber eine eigene, spätere
Arbeit — dieses Paket liefert nur das WO, nicht das WAS einer Identität.
