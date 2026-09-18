# App-Entwickler-Guide: Eine App mit Qu bauen

Eine praxisnahe, grobe Anleitung: wie eine App das Framework tatsächlich
nutzt — Bootstrap, Framework-API (inkl. File-Handling), deklarative
Qu-Components im HTML, und optionales WebRTC. Für das WARUM/die Architektur
siehe `architecture.md` (Gesamtüberblick), `docs/bootstrap-api.md`
(vollständige `@qu/bootstrap`-Referenz) und `docs/webrtc.md` (vollständige
WebRTC-Referenz) — dieses Dokument ist der schnelle praktische Einstieg,
keine vollständige API-Referenz.

**Leitgedanke, der sich durch das ganze Framework zieht:** So viel wie
möglich passiert deklarativ im HTML (Qu-Components binden sich selbst an
Space-Daten), so wenig wie möglich in eigenem JS-Glue-Code. Eine App
definiert ihre Kind-Schemas, bootstrapt eine `Space`, und lässt den Rest
weitgehend die Qu-Components und den App-Shell/Renderer erledigen.

## Inhalt

- [1. Framework-API](#1-framework-api)
  - [1.6 Dateien: lokal speichern, syncen, teilen](#16-dateien-lokal-speichern-syncen-teilen)
- [2. Qu-Components im HTML](#2-qu-components-im-html)
- [3. WebRTC in einer App nutzen](#3-webrtc-in-einer-app-nutzen)
- [4. Vollständiges Beispiel](#4-vollständiges-beispiel)

## 1. Framework-API

### 1.1 Initialisierung — `@qu/bootstrap`

Jede App startet mit genau EINER `Space`-Instanz. Die `AdapterRegistry`
entscheidet, WELCHE konkreten Adapter (Storage/Transport/Identity) benutzt
werden, per Name statt per hartcodiertem `import` — siehe
`docs/bootstrap-api.md` für die volle Referenz.

```js
import { AdapterRegistry, bootstrapSpace, registerIdentityStoreAdapters } from '@qu/bootstrap';
import { registerBrowserAdapters } from '@qu/bootstrap/browser';

const registry = new AdapterRegistry();
registerIdentityStoreAdapters(registry);   // 'memory' / 'local-storage' / 'session-storage'
registerBrowserAdapters(registry);          // 'indexeddb' storage, 'ws-client' transport

const identity = await registry.create('identity', 'local-storage'); // EIN Keypair pro Browser/Profil, persistiert
const { space } = await bootstrapSpace({
  registry,
  identity,
  transport: { adapter: 'ws-client', url: 'wss://your-relay.example.com' },
  storage: { adapter: 'indexeddb' },        // überlebt Reload/Neustart
  members: [{ pub: alicePub, xPub: aliceXPub }, ...], // wer Teil dieser Space ist
});
```

`space` ist ab hier die zentrale Instanz, über die deine App liest/schreibt
und die Qu-Components im HTML sich binden (siehe Abschnitt 2). Für Tests/
Demos gibt es `@qu/bootstrap/memory` (`registerMemoryAdapters`) — zero
Netzwerk/Disk, simulierter In-Process-Relay, kein echter Server nötig.

### 1.2 Content-Typen definieren — Kind-Schema

Jeder Datentyp deiner App ist ein `Kind` — ein Bündel aus Feldern (mit
eigener `shape`/`visibility`) plus EINEM ACL-Modus, der bestimmt, wer
schreiben darf.

```js
import { defineKind } from '@qu/space-core';

const noteKind = defineKind('my-app-note', {
  fields: {
    title:  { shape: 'atomic', visibility: 'public' },     // ganzer Wert auf einmal ersetzt
    body:   { shape: 'text',   visibility: 'encrypted' },   // kollaborativer Rich-/Plain-Text (Yjs Y.Text)
    tags:   { shape: 'list',   visibility: 'public' },      // Array, per push()
  },
  acl: { write: 'owner' }, // 'members' | 'owner' | 'named' | 'content' | 'relay-admins'
});
```

| `shape` | Bedeutung |
|---|---|
| `atomic` | Ein Wert, atomar per `.set()` ersetzt (String/Zahl/Objekt). |
| `text` | Kollaboratives Textfeld (Yjs `Y.Text`), `.insert()`/`.delete()`/`.replaceText()`. |
| `list` | Array, per `.push()` erweitert; `.toArray()` zum Lesen. |
| `richtext` | Wie `text`, gedacht für einen Rich-Text-Editor (ProseMirror-Bindung, siehe `@qu/space-ui`). |

| `visibility` | Bedeutung |
|---|---|
| `encrypted` (Default) | AES-GCM-verschlüsselt für die aktuellen Empfänger (Space-Mitglieder oder `recipients`). |
| `public` | Unverschlüsselt, aber weiterhin SIGNIERT — jeder mit Zugriff auf den Relay kann lesen, niemand kann fälschen. |

| `acl.write` | Wer darf schreiben |
|---|---|
| `members` | Jedes aktuelle Space-Mitglied (flache Liste). |
| `owner` | Nur der Ersteller — self-certifying, Node-Id aus dem Owner-Pubkey abgeleitet, kein Relay-Setup nötig. |
| `named` | Owner + explizit per `grantWriter()` Berechtigte. |
| `content` | Viele Items EINES Owners (siehe `defineCollectionKind()` unten). |
| `relay-admins` | Nur Relay-Admins (App-weite Konfiguration/Manifeste). |

**Viele gleichartige Items eines Besitzers** (Blogposts, Kontakte, ...) —
nicht `owner` (nur EIN Node pro Owner), sondern:

```js
import { defineCollectionKind } from '@qu/app-core';

const { itemKind, registryKind, registryField } = defineCollectionKind('blog-post', {
  fields: {
    title: { shape: 'atomic', visibility: 'public' },
    body:  { shape: 'text',   visibility: 'public' },
  },
});
```

### 1.3 Lesen & Schreiben — `Space`/`Node`/`Field`

```js
// Erstellen (self-certifying Kinds wie 'owner' brauchen keine id):
const note = await space.createNode(noteKind, { title: 'Erste Notiz', tags: ['privat'] });
await note.field('body').insert(0, 'Hallo Welt');

// Ein bekanntes Node holen - der empfohlene Standardweg (lazy, referenzgezählt, local-first):
const { node, release } = await space.useNode(someNodeId, noteKind);
const title = await node.field('title').get();
const unsubscribe = node.field('title').observe(() => console.log('title changed'));
// ... später:
unsubscribe();
release(); // WICHTIG: jedes useNode() braucht ein passendes release(), sonst bleibt die Subscription offen
```

### 1.4 Live, sortierte Feeds über mehrere Quellen — Views

```js
import { createView, openLiveView } from '@qu/app-core';

await createView(space, {
  name: 'blog-feed',
  sources: [
    { type: 'pages', prefix: '/blog/' },                                    // Routen/Seiten
    { type: 'collection', itemKind, registryKind, titleField: 'title', excerptField: 'body' }, // eine Collection
    { type: 'shared-list', name: 'guestbook' },                             // eine geteilte Liste
  ],
  sortBy: 'title', sortOrder: 'asc',
});

const view = await openLiveView(space, { appAdminPub, ...config }); // config kommt normalerweise vom ContentResolver
const items = await view.toArray(); // {title, excerpt, route, timestamp, raw}[]
view.observe(() => console.log('feed changed'));
view.setQuery('suchbegriff'); // client-seitige Volltextsuche über title/excerpt
```

### 1.5 Eigenes User-Profil (GunDB-artig)

```js
import { ensureUserProfile } from '@qu/space-core';

await ensureUserProfile(space); // legt das eigene Profil an, falls es noch nicht existiert - idempotent
```

### 1.6 Dateien: lokal speichern, syncen, teilen

**Der zentrale Unterschied: Daten speichern ≠ Datei speichern.** Ein
gewöhnliches Kind-Schema-Feld (Abschnitt 1.2) lebt IM Yjs-CRDT selbst —
klein, strukturiert, jede Änderung ein neues signiertes (ggf.
verschlüsseltes) Envelope, das der Relay mitschneidet/spiegelt. Das ist
absichtlich UNGEEIGNET für eine große Binärdatei: der Relay leitet/spiegelt
nur signierte Envelopes weiter, und Yjs' eigene Update-Historie kennt kein
"ersetze/verwirf die alten Bytes" — für ein Foto oder Video würde die
mitgeschnittene Historie unbegrenzt wachsen. Deshalb trennt `@qu/space-plugins`'
`UploadOutbox` bewusst zwei Dinge:
  - **METADATEN** (Name, Größe, Status, ...) — ein ganz normales,
    self-certifying `'owner'`-ACL Kind-Schema-Feld, läuft über den exakt
    gleichen Sync-Pfad wie jedes andere Feld.
  - **DIE BYTES SELBST** — laufen NIEMALS durch Space/den Relay. Du gibst
    `UploadOutbox` einen lokalen Store (fürs sofortige lokale Speichern)
    und eine `upload()`-Funktion (wohin die Bytes tatsächlich gehen - ein
    Objektspeicher, dein eigener Server, whatever) - das Framework
    verwaltet nur die QUEUE/den Status, nie die Bytes selbst.

```js
import { UploadOutbox } from '@qu/space-plugins';

// localStore: {save(id, blob), load(id), remove(id)} - z.B. IndexedDB im Browser, Filesystem in Node.
const outbox = new UploadOutbox(
  space,
  indexedDbBlobStore,                              // lokal speichern
  async (record, blob) => {                        // syncen - deine eigene Upload-Logik
    const res = await fetch('https://your-object-store.example.com/upload', { method: 'POST', body: blob });
    if (!res.ok) throw new Error('upload failed'); // wirft -> Record bleibt 'failed', retry(id) später möglich
  },
  space.bus                                        // optional: aktiviert den 'synced'-Status (relay-bestätigt, nicht nur "mein upload() ist fertig")
);

const fileId = await outbox.enqueue({ name: 'urlaub.jpg', size: blob.size, mimeType: 'image/jpeg' }, blob);
// -> lokal SOFORT gespeichert + Metadaten geschrieben, sobald enqueue() resolved (Upload selbst läuft im Hintergrund)

await outbox.watch(fileId, (record) => console.log(record.status));
// 'pending' -> 'uploading' -> 'done' (eigener upload() fertig) -> 'synced' (Relay hat die Metadaten bestätigt)
```

**Teilen** ist KEIN eigener Mechanismus — es ist derselbe
`recipients`-Trick, den "Groups and private/shared content" (README) schon
für Seiten nutzt, nur angewendet auf eine Datei-REFERENZ statt auf Text:
die Bytes liegen (über deine eigene `upload()`-Funktion) irgendwo extern,
und was du tatsächlich "teilst" ist ein kleiner, für genau die gewünschten
Empfänger verschlüsselter Datensatz (z. B. `{url, name, key?}` — `key?`,
falls die Bytes selbst am Ablageort nochmal separat verschlüsselt sind):

```js
import { createPrivatePage } from '@qu/app-core';

// nur `group.members` (deren xPub) kann das je entschlüsseln - der Relay sieht nur Ciphertext:
await createPrivatePage(space, {
  route: `/files/${fileId}`,
  title: 'urlaub.jpg',
  content: JSON.stringify({ url: uploadedUrl, name: 'urlaub.jpg' }),
  recipients: group.members.map((m) => m.xPub),
});
```

Empfangsbestätigung PRO Person (nicht nur "hochgeladen", sondern "diese
Person hat es tatsächlich abgerufen"):

```js
import { markFileReceived, watchFileReceipts } from '@qu/space-plugins';

await markFileReceived(receiverSpace, fileId);           // der Empfänger bestätigt
const receipts = await watchFileReceipts(uploaderSpace, receiverPub); // der Uploader beobachtet live, wer schon hat
```

## 2. Qu-Components im HTML

`@qu/space-components` registriert drei Custom Elements
(`<qu-view>`/`<qu-bind>`/`<qu-list>`), die sich SELBST an Space-Daten
binden — Template-Autoren schreiben plain HTML, keine JS-Handler:

```js
import '@qu/space-components/elements'; // Side-Effect-Import: registriert die drei Tags
```

Ein Component erreicht seine `Space` durch Aufwärtslaufen im DOM (nie
über ein globales Singleton) — irgendein Vorfahre (typischerweise
`<qu-app-shell>`) muss `.quSpace` (die Space-Instanz) gesetzt haben, und
optional `.quKinds = {name: kindSchema}`, damit `kind="name"`-Attribute
im HTML aufgelöst werden können.

### `<qu-view>` — nur lesen, live

```html
<qu-view kind="note" node-id="abc123" field="title"></qu-view>
<!-- mit attr: welche DOM-Property beschrieben wird ("auto" = .value bei Formularfeldern, sonst .textContent) -->
<qu-view kind="note" node-id="abc123" field="body" attr="textContent"></qu-view>
```

### `self` — binde an "diese Seite", ohne die Node-Id zu kennen

Der häufigste Fall in einem hand-geschriebenen Template: Content-addressierte
Node-Ids sind Hashes, niemand tippt die von Hand. `self` löst automatisch
gegen die Seite auf, die gerade gerendert wird:

```html
<h1><qu-view self field="title"></qu-view></h1>
<qu-bind self field="content" editable="inline"></qu-bind>
```

### `<qu-bind>` — zwei Wege, live oder mit Save/Cancel

```html
<!-- Live, jeder Tastendruck schreibt sofort (wie ein unkontrolliertes Formularfeld): -->
<qu-bind kind="note" node-id="abc123" field="title"><input></qu-bind>

<!-- Explizites Speichern/Abbrechen mit Stift-Icon-UI (für 'text'-Felder gedacht): -->
<qu-bind kind="note" node-id="abc123" field="body" editable="inline"></qu-bind>
```

### `<qu-list>` — eine `list`-Shape live als Liste rendern

```html
<qu-list kind="note" node-id="abc123" field="tags" key="id" item-tag="li">
  <template>
    <qu-view field="text"></qu-view> <!-- kein eigenes kind/node-id: liest vom aktuellen Listen-Item -->
  </template>
</qu-list>
```

### Views im HTML einbinden

```html
<div data-qu-view="blog-feed"></div>
```
`@qu/app-shell`'s `view-actions.js` verdrahtet das nach jedem Rendering
automatisch — ein neuer Post/Guestbook-Eintrag erscheint live, ohne Reload.

### Die App-Shell selbst einbinden

```html
<qu-app-shell app-admin-pub="BASE64-PUBKEY-DES-APP-OWNERS"></qu-app-shell>
<script type="module" src="/qu/app-shell.js"></script>
```

## 3. WebRTC in einer App nutzen

WebRTC ist bewusst KEIN Ersatz für den Space-eigenen Yjs-Sync (der bleibt
Relay-vermittelt) — es ist ein rein optionales, App-initiiertes Modul für
Fälle, die einen echten Echtzeit-P2P-Kanal brauchen: Spiele-Datenkanal,
Sprach-/Videoanruf. Volle Referenz: [`docs/webrtc.md`](./webrtc.md).

```js
import { WsClientTransport } from '@qu/space-transport/ws-client-transport';
import { wrapWithSignaling } from '@qu/space-transport/webrtc-signaling';
import { createWebRTCPeer } from '@qu/space-transport/webrtc-peer';

// Signaling läuft huckepack über die bereits offene Relay-Verbindung - dafür wird der Transport
// VOR dem Bootstrap gewrappt und wie jeder andere Transport übergeben (Space merkt nichts davon):
const signaling = wrapWithSignaling(new WsClientTransport('wss://your-relay.example.com'));
const { space } = await bootstrapSpace({ registry, identity, transport: signaling, storage: { adapter: 'indexeddb' } });

// Die App braucht keinen zweiten Connect, kein eigenes Signaling-Protokoll:
const peer = await createWebRTCPeer({
  signaling,                   // derselbe Wrapper von oben
  identity,                    // die eigene Identität
  remotePub: otherUserPub,     // wen wir anrufen/verbinden wollen
  iceServers: [{ urls: 'stun:your-own-stun.example.com:3478' }], // KEIN Default - siehe Datenschutz-Hinweis unten
});

// --- Daten (z. B. Spielzustand, niedrige Latenz, nicht CRDT-synchronisiert) ---
const dc = peer.createDataChannel('game-state');
dc.send(JSON.stringify({ x: 10, y: 20 }));
dc.onMessage((msg) => updateGameState(JSON.parse(msg)));

// --- Audio/Video (z. B. ein "Phone"/Chat-Call) ---
const localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
for (const track of localStream.getTracks()) await peer.addTrack(track, localStream); // triggert automatisch Renegotiation
peer.onTrack((remoteStream) => { videoEl.srcObject = remoteStream; });

// Laufzeit-Steuerung, wie ein Schalter - kein Renegotiation nötig:
peer.setEnabled('video', false); // Kamera "aus" (Gegenseite sieht Stillstand), Verbindung bleibt bestehen
peer.setEnabled('video', true);
peer.setEnabled('audio', false); // Mute

// Tatsächlich entfernen (z. B. Video ganz aus dem Call nehmen):
await peer.removeTrack(videoTrack); // triggert automatisch Renegotiation

peer.onStateChange((state) => console.log(state)); // 'connecting'|'connected'|'disconnected'|'failed'|'closed'
peer.close();
```

`peer` ist die "Instanz mit API", die eine App hält (z. B. in ihrem eigenen
UI-Store) und beliebig oft während der Verbindungsdauer aufruft — ein
optionales Modul, das eine App, die es nie aufruft, überhaupt nicht
bemerkt.

**Datenschutz-Hinweis (wichtig genug für diese Doku):** Anders als der
Relay-vermittelte Yjs-Sync tauscht echtes P2P-WebRTC ICE-Kandidaten aus,
die tendenziell die echte IP-Adresse beider Peers offenlegen — auch
gegenüber einem konfigurierten STUN/TURN-Server. Das ist ein bewusster
Trade-off, den eine App erst eingeht, sobald sie `createWebRTCPeer()`
tatsächlich aufruft; deshalb gibt es keinen Default-STUN-Server, `iceServers`
muss explizit übergeben werden.

Siehe `docs/peer-transport-contract.md` für den Hintergrund (Transport-
Vertrag, Peer-Rolle) und `docs/routing-anonymity.md` für das generelle
Bedrohungsmodell, gegen das dieser Trade-off abgewogen wurde.

## 4. Vollständiges Beispiel

Eine minimale "Notizen"-App, alle Teile zusammen:

```js
// app.js
import { AdapterRegistry, bootstrapSpace, registerIdentityStoreAdapters } from '@qu/bootstrap';
import { registerBrowserAdapters } from '@qu/bootstrap/browser';
import { defineKind } from '@qu/space-core';
import '@qu/space-components/elements';

const noteKind = defineKind('my-app-note', {
  fields: {
    title: { shape: 'atomic', visibility: 'public' },
    body:  { shape: 'text', visibility: 'encrypted' },
  },
  acl: { write: 'owner' },
});

const registry = new AdapterRegistry();
registerIdentityStoreAdapters(registry);
registerBrowserAdapters(registry);

const identity = await registry.create('identity', 'local-storage');
const { space } = await bootstrapSpace({
  registry,
  identity,
  transport: { adapter: 'ws-client', url: 'wss://your-relay.example.com' },
  storage: { adapter: 'indexeddb' },
});

const note = await space.createNode(noteKind, { title: 'Meine erste Notiz' });

// dem HTML zugänglich machen - ein Vorfahre der Qu-Components:
document.querySelector('#app').quSpace = space;
document.querySelector('#app').quKinds = { note: noteKind };
document.querySelector('#app').dataset.nodeId = note.id; // für die Attribute unten
```

```html
<!-- index.html -->
<div id="app">
  <h1><qu-view kind="note" node-id="..." field="title"></qu-view></h1>
  <qu-bind kind="note" node-id="..." field="body" editable="inline"></qu-bind>
</div>
<script type="module" src="/app.js"></script>
```

Für eine vollständige, per Relay ausgelieferte App (Routing, CMS,
Multi-User-Modus, Views/Feeds, installierbare Beispiel-Apps wie
Guestbook/Blog/Forum) siehe stattdessen `@qu/app-shell` +
`docs/example-apps.md` — dieser Guide zeigt bewusst nur die nackten
Framework-Bausteine, kein fertiges App-Gerüst (Framework-Fokus, siehe
diese Session's eigene Priorität "wenig bis kein Aufwand in Apps").
