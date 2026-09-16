# `@qu/bootstrap` API-Referenz

Kompakte Funktions-/Signatur-Referenz für `@qu/bootstrap` mit Beispielen. Für
das WARUM (Design, Motivation, Abgrenzung zu QuV3's Mountpoint-Konzept) siehe
[`docs/bootstrap-adapter-registry.md`](./bootstrap-adapter-registry.md) und
`architecture.md` §3.7ff — dieses Dokument beschreibt nur das WAS/WIE, als
schneller Einstieg beim Programmieren.

`@qu/bootstrap` hängt nur von `@qu/core`/`@qu/events`/`@qu/space-core` ab.
`@qu/space-storage`/`@qu/space-transport`/`ws` sind optionale
Peer-Dependencies — sie werden nur importiert, wenn man tatsächlich einen der
Adapter-Packs (`@qu/bootstrap/browser`/`@qu/bootstrap/node`) einbindet.

## Inhalt

- [Der Grundablauf](#der-grundablauf)
- [`AdapterRegistry`](#adapterregistry)
- [`bootstrapSpace()`](#bootstrapspace)
- [`bootstrapAliasSpace()`](#bootstrapaliasspace)
- [Identity-Stores](#identity-stores-registeridentitystoreadapters)
- [Seal-Strategies](#seal-strategies-registersealstrategyadapters)
- [Transport-Contract](#transport-contract-asserttransportshape)
- [Adapter-Packs](#adapter-packs-memorybrowsernode)
- [Vollständiges Beispiel (Browser-App)](#vollständiges-beispiel-browser-app)

## Der Grundablauf

1. Eine `AdapterRegistry` anlegen.
2. Einen oder mehrere `register*Adapters(registry)`-Helfer aufrufen — genau
   die Adapter registrieren, die diese Umgebung tatsächlich braucht (nie
   "alles registrieren und ungenutztes weglassen": jeder Import, den man
   NICHT macht, ist Code, der z. B. nie in ein Browser-Bundle wandert).
3. `bootstrapSpace({registry, identity, transport, ...})` aufrufen — liefert
   eine fertig verbundene `Space`-Instanz zurück.

```js
import { AdapterRegistry, bootstrapSpace, registerIdentityStoreAdapters } from '@qu/bootstrap';
import { registerBrowserAdapters } from '@qu/bootstrap/browser';

const registry = new AdapterRegistry();
registerIdentityStoreAdapters(registry);
registerBrowserAdapters(registry);

const identity = await registry.create('identity', 'local-storage');
const { space } = await bootstrapSpace({
  registry,
  identity,
  transport: { adapter: 'ws-client', url: 'wss://relay.example.com' },
  storage: { adapter: 'indexeddb' },
  members: [{ pub: alicePub, xPub: aliceXPub }],
});
```

## `AdapterRegistry`

Eine simple `(slot, name) -> factory`-Map. Nichts ist vorregistriert — jedes
`register*Adapters()` trägt gezielt seine eigenen Namen ein.

```js
import { AdapterRegistry } from '@qu/bootstrap';

const registry = new AdapterRegistry();
```

### `registry.register(slot, name, factory)`

Registriert `factory` unter `${slot}:${name}`. `factory` wird später mit
genau den Optionen aufgerufen, die ein `{adapter: name, ...options}`-Eintrag
mitgibt (`adapter` selbst wird dabei entfernt). Darf async sein
(`factory` darf ein Promise zurückgeben). Gibt `this` zurück (chainbar).

Wirft, wenn `(slot, name)` schon registriert ist — ein Namenskonflikt ist so
gut wie immer ein Deployment-Fehler (zwei Adapter-Packs beanspruchen
denselben Namen), kein Fall, den man still gewinnen lassen will.

```js
registry.register('storage', 'my-custom-store', ({ url }) => new MyCustomStore(url));
```

### `registry.create(slot, name, options?)`

Löst `(slot, name)` auf einen Adapter auf, indem die registrierte Factory
mit `options` aufgerufen wird. Wirft eine sprechende Fehlermeldung (nennt
alle anderen für diesen `slot` bekannten Namen — ein Tippfehler ist so
leicht zu finden), statt `undefined` zurückzugeben.

```js
const store = await registry.create('storage', 'my-custom-store', { url: 'https://...' });
```

### `registry.has(slot, name)` / `registry.names(slot)`

`has()` prüft, ob `(slot, name)` registriert ist. `names(slot)` listet alle
für einen `slot` bekannten Adapternamen — nützlich für eine
Admin-UI ("welche Adapter stehen zur Wahl?") oder eine Fehlermeldung.

```js
registry.has('transport', 'ws-client'); // true/false
registry.names('storage'); // z.B. ['memory', 'indexeddb']
```

## `bootstrapSpace()`

Der deklarative Ersatz für "`Space` von Hand mit konkreten Adapter-Instanzen
konstruieren". Jeder Slot-Wert ist EINES von drei Dingen:

- `{adapter: '<name>', ...options}` — wird via `registry.create(slot, name, options)`
  aufgelöst (der eigentliche Sinn dieser Funktion: Adapterwahl per Name/Daten,
  z. B. aus Deployment-Config, statt per hartcodiertem `import`).
- Eine bereits fertig konstruierte Instanz (alles ohne `string`-`adapter`-
  Property) — wird unverändert durchgereicht. Das ist die "Escape Hatch": man
  muss nichts registrieren, um einen einmaligen/custom Adapter zu benutzen.
- `null`/`undefined`/weggelassen — löst zu `undefined` auf (`Space`s eigener
  Default für diesen Slot).

```js
import { bootstrapSpace } from '@qu/bootstrap';

const { space, identity, transport, storage, bus, sealStrategy } = await bootstrapSpace({
  registry,                 // AdapterRegistry — nur nötig, wenn irgendein Slot {adapter: ...} nutzt
  identity,                 // REQUIRED — ein Identity-Objekt (Keypair) oder {adapter: 'local-storage'}
  transport: { adapter: 'ws-client', url: 'wss://relay.example.com' }, // REQUIRED
  storage: { adapter: 'indexeddb' },        // optional, default: Space's eigener memory-only Default
  volatileStorage: null,                    // optional, default: Space's eigener privater in-memory Store
  members: [{ pub, xPub }],                 // optional, default: []
  relayAdmins: [adminPub],                  // optional, default: []
  bus: undefined,                           // optional — undefined -> FRISCHER EventBus (Default), null -> Space's eigener stiller Default (kein Bus), oder eine bestehende EventBus-Instanz
  sealStrategy: { adapter: 'pad-to-members' }, // optional, default: sealStrategies.none (kein Padding)
});
```

**Wichtige Verhaltensdetails:**

- `identity` und `transport` sind PFLICHT — eine `Space` ohne beide ist
  sinnlos, `bootstrapSpace()` wirft sofort, wenn eines fehlt.
- Der aufgelöste `transport` wird SOFORT gegen den Transport-Contract
  geprüft (`assertTransportShape()`, siehe unten) — ein kaputter/unvollständiger
  Custom-Transport scheitert hier laut, nicht als kryptischer `TypeError`
  tief in `Space`.
- `transport.connect()` wird automatisch aufgerufen — muss man selbst nicht
  mehr tun.
- `bus` verhält sich ANDERS als `Space`s eigener Konstruktor-Default: wird
  `bus` komplett weggelassen, bekommt man einen frischen `EventBus`
  (`Space` selbst default'et dort auf `null`). Explizit `bus: null` übergeben,
  um das stille `Space`-Verhalten zu bekommen.
- Rückgabe: `{identity, transport, storage, volatileStorage, bus, sealStrategy, space}`
  — jeweils die AUFGELÖSTEN Werte (nie die rohen `{adapter, ...}`-Configs).

## `bootstrapAliasSpace()`

Das "Toter-Briefkasten"-Komfort-Feature für Sender-Anonymität
(`docs/routing-anonymity.md`): leitet aus der echten Identität einer
bestehenden `Space` eine deterministische, per-Space-eindeutige Alias-Identität
ab und bootstrapt damit eine ZWEITE, unabhängige `Space`.

```js
import { bootstrapAliasSpace } from '@qu/bootstrap';

const { space: aliasSpace, identity: aliasIdentity } = await bootstrapAliasSpace(
  realSpace,      // die eigene, bereits verbundene Space — ihre identity ist die "echte" Quelle
  'my-space-id',  // stabiler String; gleiche (realIdentity, spaceId)-Kombi -> immer dieselbe Alias-Identität
  {
    registry,
    transport: { adapter: 'ws-client', url: 'wss://relay.example.com' }, // typischerweise eine SEPARATE Verbindung
  }
);

// Die Alias-Identität kann sofort eigene 'owner'/'named'/'content'-ACL-Nodes schreiben —
// self-certifying, kein Relay-seitiges Setup nötig.
const post = await aliasSpace.createNode(postKind, { body: 'anonym' });
```

Ein in `config.identity` übergebener Wert wird IGNORIERT — die abgeleitete
Alias-Identität gewinnt immer.

### Der `join`-Hook (für `acl.write: 'members'`-Kinds)

Self-certifying Kinds funktionieren immer. Für gewöhnliche `'members'`-ACL
Kinds muss die Alias-Identität zusätzlich Relay-seitig Mitglied werden —
WIE das geschieht, ist deployment-spezifisch (HTTP-`POST /join`, ein anderes
Relay-Protokoll, …), deshalb ist es ein pluggbarer Hook statt fest verdrahtet:

```js
const { space: aliasSpace } = await bootstrapAliasSpace(
  realSpace,
  'my-space-id',
  { registry, transport: { adapter: 'ws-client', url: '...' } },
  {
    join: async (alias) => joinSpace({ name: 'anon', identity: alias }), // @qu/app-shell's joinSpace()
  }
);
```

`join(aliasIdentity)` wird VOR `bootstrapSpace()` aufgerufen; sein
Rückgabewert (`Array<{pub, xPub}>`) wird zur `members`-Liste der Alias-Space
(überschreibt `config.members`, falls beide gesetzt sind). Ohne `join` bleibt
das heutige Verhalten (`config.members` unverändert, oder die Alias-Identität
bleibt auf self-certifying Kinds beschränkt).

## Identity-Stores (`registerIdentityStoreAdapters`)

Registriert den `'identity'`-Slot mit drei fertigen Varianten — alle rufen
letztlich dieselbe `loadOrCreateIdentity(storage, key)` auf, unterscheiden
sich nur im `storage`-Backend:

| Name | Überlebt Reload | Überlebt Browser-Neustart | Typischer Einsatz |
|---|---|---|---|
| `'local-storage'` | ja | ja (gleicher Origin) | die "primäre" lokale Identität einer echten App |
| `'session-storage'` | ja | nein (weg mit dem Tab) | Session-gebundene Identität |
| `'memory'` | nur solange der Prozess lebt | nein | Tests, Demos, GunDB-artige "Fake User"/Room-Instanzen |

```js
import { AdapterRegistry, registerIdentityStoreAdapters } from '@qu/bootstrap';

const registry = new AdapterRegistry();
registerIdentityStoreAdapters(registry, { defaultKey: 'qu-identity' }); // defaultKey optional, Default: 'qu-identity'

const identity = await registry.create('identity', 'local-storage'); // oder { key: 'anderer-schlüssel' }
```

`loadOrCreateIdentity(storage, key)` ist auch direkt exportiert, für einen
eigenen vierten Storage-Backend-Typ (z. B. dateisystembasiert für eine CLI) —
`storage` muss nur `{getItem(key), setItem(key, value)}` implementieren:

```js
import { loadOrCreateIdentity } from '@qu/bootstrap';

const identity = await loadOrCreateIdentity(myCustomStorage, 'qu-identity');
// -> { signingKey, signingPub, xPrivateKey, xPublicKey } (alles Uint8Array)
```

Ruft man `loadOrCreateIdentity()` mehrfach parallel mit demselben `key` auf
(bevor irgendetwas gespeichert wurde), entsteht garantiert nur EIN Keypair —
ein modul-weiter In-Flight-Promise-Guard verhindert das Race, bei dem zwei
gleichzeitige Aufrufe unterschiedliche Keypairs generieren und einander
überschreiben.

## Seal-Strategies (`registerSealStrategyAdapters`)

Registriert den `'sealStrategy'`-Slot mit den beiden in `@qu/space-core`
eingebauten Strategien (siehe `docs/routing-anonymity.md` für das Bedrohungsmodell):

```js
import { AdapterRegistry, bootstrapSpace, registerSealStrategyAdapters } from '@qu/bootstrap';

const registry = new AdapterRegistry();
registerSealStrategyAdapters(registry);

const { space } = await bootstrapSpace({
  registry,
  identity,
  transport,
  members,
  sealStrategy: { adapter: 'pad-to-members' }, // oder { adapter: 'none' } (= Default, kein Padding)
});
```

- `'none'` — kein Padding, `envelope.to` enthält nur die tatsächlichen
  Empfänger (Default-Verhalten, unverändert).
- `'pad-to-members'` — jede an eine echte Teilmenge der Mitglieder gerichtete
  (`{recipients}`-eingeschränkte) Nachricht bekommt zusätzliche,
  byte-nicht-unterscheidbare Zufallseinträge für die ÜBRIGEN Space-Mitglieder
  angehängt, sodass ein Relay/Beobachter aus `envelope.to.length`/-inhalt
  nicht ablesen kann, WELCHE Teilmenge tatsächlich die Empfänger waren.

Eine eigene Strategie ist einfach eine synchrone Funktion
`({recipientXPubKeys, memberXPubKeys}) => Array<Uint8Array>` (die
zusätzlichen Padding-Pubkeys), die man ganz normal registriert:

```js
registry.register('sealStrategy', 'my-strategy', () => myStrategyFn);
```

## Transport-Contract (`assertTransportShape`)

Prüft, dass ein Objekt die drei PFLICHT-Methoden eines Transports besitzt —
`connect`/`send`/`onMessage` (`onStatusChange`/`getPeerId`/`close` sind
optional und werden hier NICHT geprüft). `bootstrapSpace()` ruft das
automatisch auf; man braucht es i. d. R. nicht selbst aufzurufen, außer man
baut eine eigene Bootstrap-Variante außerhalb von `bootstrapSpace()`.

```js
import { assertTransportShape, REQUIRED_TRANSPORT_METHODS } from '@qu/bootstrap';

assertTransportShape(myTransport); // wirft mit sprechender Meldung, wenn z.B. `send` fehlt
console.log(REQUIRED_TRANSPORT_METHODS); // ['connect', 'send', 'onMessage']
```

Siehe [`docs/peer-transport-contract.md`](./peer-transport-contract.md) für
den vollen Vertrag (inkl. der optionalen Methoden und dem Peer-Rollenmodell).

## Adapter-Packs (`memory`/`browser`/`node`)

Drei fertige "Umgebungs-Packs" — jeder registriert `storage`/`volatileStorage`/
`transport` (NIE `identity`, das bleibt immer ein separater Aufruf von
`registerIdentityStoreAdapters()`, siehe oben, damit zwei Packs nie um
denselben Identity-Namen konkurrieren). Import über die jeweilige Subpath-
Export, nicht über den Haupt-Barrel — das ist, was ein Browser-Bundle davor
schützt, versehentlich `node:fs`/das `ws`-Paket mitzuziehen.

### `@qu/bootstrap/memory` — `registerMemoryAdapters(registry)`

Zero-Netzwerk, zero-Disk — sicher in JEDER Umgebung (Browser, Node, Tests).

```js
import { AdapterRegistry, bootstrapSpace } from '@qu/bootstrap';
import { registerMemoryAdapters, createSharedInProcessHub } from '@qu/bootstrap/memory';

const registry = new AdapterRegistry();
registerMemoryAdapters(registry);

const hub = createSharedInProcessHub(); // eine simulierte "Relay"-Instanz - jeder Peer, der sich erreichen soll, verbindet sich mit demselben hub
const { space } = await bootstrapSpace({
  registry,
  identity: aliceIdentity,
  transport: { adapter: 'in-process', hub, peerId: 'alice' },
  storage: { adapter: 'memory' },
});
```

Registriert: `storage:'memory'`, `volatileStorage:'memory'`, `transport:'in-process'`
(braucht `{hub, peerId?}` — `peerId` default'et auf eine zufällige UUID).

### `@qu/bootstrap/browser` — `registerBrowserAdapters(registry)`

Der reale Deployment-Adapter-Satz für einen echten Browser-Client
(Referenz-Caller: `@qu/app-shell`'s `shell.js`).

```js
import { registerBrowserAdapters } from '@qu/bootstrap/browser';

registerBrowserAdapters(registry);
// registriert: storage:'indexeddb' (kein Argument), transport:'ws-client' ({url, ...options})
```

`storage:'indexeddb'` wirft, wenn kein `indexedDB`-Global existiert (privater
Modus, kein Browser). `transport:'ws-client'` wirft ohne `{url}`.

### `@qu/bootstrap/node` — `registerNodeAdapters(registry)`

Das Server-/CLI-seitige Gegenstück — nie zusammen mit `browser` im selben
Prozess registrieren (beide würden `transport:'ws-client'` beanspruchen).

```js
import { registerNodeAdapters } from '@qu/bootstrap/node';

registerNodeAdapters(registry);
// registriert: storage:'file' ({dataDir}), storage:'durable' ({backingStore?}), transport:'ws-client' ({url, ...options})
```

`storage:'file'` ist die reale On-Disk-Persistenz (Relay-/Docker-Deployment).
`storage:'durable'` ist eine In-Prozess-Simulation eines echten Backends
(test-only). `transport:'ws-client'` nutzt hier das `ws`-Paket statt eines
Browser-Globals — derselbe Adaptername wie im Browser-Pack, damit dieselbe
Config funktioniert, egal welcher der beiden Packs sie am Ende auflöst (nie
beide gleichzeitig in einem Prozess).

## Vollständiges Beispiel (Browser-App)

So sieht `@qu/app-shell`'s echter Boot-Pfad aus (gekürzt,
`packages/app-shell/src/shell.js`):

```js
import { QuCrypto } from '@qu/core';
import { ensureUserProfile } from '@qu/space-core';
import { AdapterRegistry, bootstrapSpace, registerIdentityStoreAdapters } from '@qu/bootstrap';
import { registerBrowserAdapters } from '@qu/bootstrap/browser';

// Einmal, modul-weit — mehrere <qu-app-shell> auf derselben Seite teilen sich die Registry.
const registry = new AdapterRegistry();
registerIdentityStoreAdapters(registry, { defaultKey: 'qu-identity' });
registerBrowserAdapters(registry);

// ... beim Boot einer konkreten App-Instanz:
const identity = await registry.create('identity', 'local-storage');
const [members, relayAdmins] = await Promise.all([
  joinSpace({ name, identity }),
  fetchRelayAdmins().catch(() => []),
]);

const { space } = await bootstrapSpace({
  registry,
  identity,
  transport: { adapter: 'ws-client', url: relayWsUrl },
  storage: { adapter: 'indexeddb' },
  members,
  relayAdmins,
});

await ensureUserProfile(space); // GunDB-artiges User-Node: legt das eigene Profil an, falls es noch fehlt
```

Für den Mesh-Anonymität-Anwendungsfall (Alias-Space daneben) siehe die
Beispiele oben bei `bootstrapAliasSpace()`, sowie
[`docs/routing-anonymity.md`](./routing-anonymity.md) für den vollen
Threat-Model-Hintergrund.
