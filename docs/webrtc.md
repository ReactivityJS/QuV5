# WebRTC: Signaling, Data-Channels, Audio/Video

Ein optionales, App-initiiertes P2P-Modul auf `@qu/space-transport` — kein
Ersatz für den Relay-vermittelten Yjs-Sync einer `Space` (der bleibt
unverändert), sondern ein zweites, unabhängiges Feature, das eine App
gezielt einsetzt, wenn sie einen echten Echtzeit-P2P-Kanal zu einem
konkreten anderen Mitglied braucht: ein Spiele-Datenkanal, ein Sprach-/
Video-Call. Für das WARUM/die Design-Diskussion (Signaling huckepack vs.
eigener Dienst, Transport-Slot vs. eigenständiges Plugin) siehe die
"Mesh, Signaling, WebRTC"-Sektion in
[`docs/peer-transport-contract.md`](./peer-transport-contract.md).

## Die drei Bausteine

```
Space's eigener Transport (z.B. WsClientTransport)
        │
        ▼
wrapWithSignaling(transport)  ──►  liefert einen Transport-Vertrag-konformen
        │                          Wrapper: Space merkt nichts, bekommt
        │                          weiterhin ALLE eigenen Nachrichten
        │                          unverändert.
        ▼
createWebRTCPeer({ signaling, identity, remotePub, iceServers })
        │
        ▼
peer.createDataChannel(...) / peer.addTrack(...) / peer.setEnabled(...) / ...
```

1. **Signaling** (`wrapWithSignaling()`) — SDP/ICE-Austausch huckepack über
   die bereits offene Relay-Verbindung, flüchtig (kein Storage/Mirror am
   Relay).
2. **`createWebRTCPeer()`** — verhandelt EINE `RTCPeerConnection` zu einem
   konkreten Mitglied, liefert eine Instanz mit Data-Channel-/Media-API.
3. **Die zurückgegebene `peer`-Instanz** — was eine App tatsächlich hält
   und aufruft, so lange die Verbindung besteht.

## `wrapWithSignaling(transport)`

`packages/space-transport/src/webrtc-signaling.js`

```js
import { wrapWithSignaling } from '@qu/space-transport/webrtc-signaling';
import { WsClientTransport } from '@qu/space-transport/ws-client-transport';

const inner = new WsClientTransport('wss://your-relay.example.com');
const signaling = wrapWithSignaling(inner);

// signaling erfüllt den vollen Transport-Vertrag - an bootstrapSpace()/new Space() geben wie jeden anderen Transport:
const { space } = await bootstrapSpace({ registry, identity, transport: signaling, ... });
// oder: new Space({ identity, members, transport: signaling })
```

**Warum das nötig ist:** `Transport.onMessage(cb)` ist ein
Single-Listener-Slot - `Space` registriert seinen eigenen Handler genau
einmal. Ein zweiter `.onMessage()`-Aufruf würde Space's Handler stillschweigend
stehlen. `wrapWithSignaling()` löst das: es beansprucht den EINEN
`onMessage()`-Slot des rohen Transports selbst, leitet alles außer
`rtc-signal`-Nachrichten unverändert an Space weiter, und routet
`rtc-signal`-Nachrichten stattdessen an eigene Listener. Space selbst
kennt `rtc-signal` als Konzept nicht - **null Änderungen an
`@qu/space-core`**.

Zusätzliche Methoden des Wrappers:
- `sendSignal(toPubB64, signal)` - schickt `signal` (ein beliebiges,
  JSON-serialisierbares Objekt - SDP-Description oder ICE-Kandidat) an das
  Mitglied mit dieser Pubkey.
- `onSignal(cb) -> unsubscribe` - **Multi-Listener** (anders als
  `onMessage()` selbst): mehrere gleichzeitige `createWebRTCPeer()`-Aufrufe
  (z. B. mehrere Gegner in einem Spiel) können jeweils eigene Listener
  registrieren und selbst nach `from` filtern.

Optionale Transport-Methoden (`onStatusChange`/`getPeerId`/`close`) werden
nur durchgereicht, wenn der zugrunde liegende Transport sie selbst hat -
ein Wrapper um `InProcessTransport` (kein `onStatusChange`) täuscht also
keins vor.

## Relay-seitig: `rtc-signal` (flüchtig, presence-authentifiziert)

`packages/space-transport/src/relay.js` erkennt einen sechsten
Nachrichtentyp: `{type:'rtc-signal', to, signal}`. Wichtige
Sicherheitseigenschaft: **der Absender wird niemals aus dem
Client-Payload übernommen** - die weitergeleitete Nachricht trägt
`from: presence.pubFor(fromPeerId)`, also genau die Pubkey, die diese
Verbindung bereits per signiertem `hello` bewiesen hat (derselbe
Vertrauens-Mechanismus, den `handleHello()` ohnehin schon etabliert). Ein
Client, der versucht, `from` selbst zu fälschen, wird ignoriert - das Feld
wird serverseitig immer überschrieben.

**Niemals gemirrort/gespeichert** (anders als jeder Node-Write): ein
Zielmitglied, das gerade nicht online ist (`presence.peerIdFor()` findet
keine Verbindung), verwirft die Nachricht still - kein Fehler, kein
Debug-Event, kein Catch-up für einen später wiederkommenden Peer. Ein
ICE-Kandidat/SDP-Offer ist außerhalb der Verhandlung, zu der er gehörte,
ohnehin bedeutungslos - hier nachträglich etwas "nachzuliefern" wäre
sinnlos und würde nur ein unbegrenzt wachsendes Verbindungsversuchs-Log
erzeugen.

## `createWebRTCPeer(options)`

`packages/space-transport/src/webrtc-peer.js` (Browser-only - eigener
Subpath-Export, siehe unten)

```js
import { createWebRTCPeer } from '@qu/space-transport/webrtc-peer';

const peer = await createWebRTCPeer({
  signaling,                       // der wrapWithSignaling()-Wrapper von oben
  identity,                        // die eigene Identität (nur signingPub wird gelesen)
  remotePub: otherMemberPub,       // Uint8Array ODER bereits-base64 string
  iceServers: [{ urls: 'stun:...' }], // PFLICHT, kein Default (siehe Datenschutz-Hinweis unten)
});
```

| Parameter | Pflicht | Bedeutung |
|---|---|---|
| `signaling` | ja | ein `wrapWithSignaling()`-Wrapper - typischerweise derselbe, der bereits an `Space` übergeben wurde. |
| `identity` | ja | nur `identity.signingPub` wird gelesen (für die Polite/Impolite-Bestimmung, siehe unten) - nie irgendwohin gesendet. |
| `remotePub` | ja | Pubkey des Ziel-Mitglieds. |
| `iceServers` | ja, kein Default | siehe Datenschutz-Hinweis. |
| `RTCPeerConnectionImpl` | nein | Default `globalThis.RTCPeerConnection` - injizierbar für Tests (ein Fake/Double, wie `WsClientTransport`'s `WebSocketImpl`). |

### Die zurückgegebene `peer`-Instanz

```js
// --- Data Channels (z.B. Spiele-State, niedrige Latenz) ---
const dc = peer.createDataChannel('game-state');
dc.send(JSON.stringify({ x: 10, y: 20 }));
dc.onMessage((data) => console.log(data));
dc.close();

peer.onDataChannel((channel) => { /* Kanal, den die GEGENSEITE initiiert hat */ });

// --- Audio/Video ---
const localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
for (const track of localStream.getTracks()) await peer.addTrack(track, localStream); // triggert automatisch Renegotiation, resolved erst wenn sie abgeschlossen ist
peer.onTrack((remoteStream) => { videoEl.srcObject = remoteStream; });
await peer.removeTrack(videoTrack); // ebenfalls automatische Renegotiation

// --- Laufzeit-Umschalten (kein Renegotiation-Overhead) ---
peer.setEnabled('video', false); // Kamera "aus" - Gegenseite sieht Stillstand, Verbindung bleibt bestehen
peer.setEnabled('audio', false); // Mute

// --- Status ---
peer.onStateChange((state) => console.log(state)); // 'new'|'connecting'|'connected'|'disconnected'|'failed'|'closed'
peer.close();
```

Jede `on*()`-Methode gibt eine `unsubscribe`-Funktion zurück
(`() => void`), demselben Muster wie überall sonst in diesem Framework
(`Field.observe()`, `View.observe()`, ...).

### Renegotiation ist automatisch

`addTrack()`/`removeTrack()` lösen intern das Browser-eigene
`negotiationneeded`-Event aus, das `createWebRTCPeer()` selbstständig mit
einer neuen Offer/Answer-Runde über `signaling` beantwortet - die App muss
dafür **nichts** manuell orchestrieren. Beide Methoden geben ein Promise
zurück, das erst resolved, wenn diese ausgelöste Runde tatsächlich
abgeschlossen ist.

### Glare-Vermeidung (Perfect Negotiation)

Verhandeln beide Seiten gleichzeitig (z. B. beide fügen im selben Moment
einen Track hinzu), wird das über das etablierte "Perfect
Negotiation"-Muster (WebRTC-Spezifikation) aufgelöst: beide Seiten
berechnen unabhängig voneinander, rein durch String-Vergleich ihrer
eigenen und der fremden Pubkey, dieselbe "polite"/"impolite"-Rolle - kein
zusätzliches Protokoll, keine Koordination nötig. Bei einer Kollision
tritt die "polite" Seite zurück und übernimmt die eingehende Offer statt
ihrer eigenen; die "impolite" Seite setzt sich durch.

### Datenschutz-Hinweis: kein Default-`iceServers`

Anders als der Relay-vermittelte Yjs-Sync tauscht echtes P2P-WebRTC
ICE-Kandidaten aus, die tendenziell die echte IP-Adresse beider Peers
offenlegen - auch gegenüber einem konfigurierten STUN/TURN-Server. Das ist
ein bewusster Trade-off, den eine App erst eingeht, sobald sie
`createWebRTCPeer()` tatsächlich aufruft - deshalb gibt es keinen
Default-Wert, `iceServers` muss immer explizit übergeben werden (auch eine
bewusst leere Liste `[]` ist erlaubt und bedeutet "nur direkte/Loopback-
Kandidaten, kein STUN/TURN").

## Imports/Subpaths

Browser-only Dateien (nutzen `RTCPeerConnection`, ein Browser-Global)
haben eigene Subpath-Exports, damit ein Bundle, das nur `@qu/space-transport`s
Haupt-Barrel importiert, niemals versehentlich Browser-Code mitzieht (und
umgekehrt):

```js
import { wrapWithSignaling } from '@qu/space-transport/webrtc-signaling'; // browser- UND node-sicher (keine Browser-Globals)
import { createWebRTCPeer } from '@qu/space-transport/webrtc-peer';        // BROWSER-ONLY (RTCPeerConnection)
```

`wrapWithSignaling` ist zusätzlich auch über den Haupt-Barrel
(`@qu/space-transport`) erreichbar, da es selbst keine Browser-Globals
nutzt - `createWebRTCPeer` bewusst nicht, dieselbe Regel, die schon
`ws-client-transport.js`/`indexeddb-store.js` befolgen.

## Was bewusst NICHT gebaut ist

- **Echtes Mesh** (mehrere gleichzeitige Peer-Verbindungen EINES Knotens,
  der selbst weiterleitet) - weiterhin zurückgestellt, siehe
  `docs/peer-transport-contract.md`s eigene "Mesh"-Sektion. `createWebRTCPeer()`
  verwaltet genau EINE Verbindung zu genau EINEM Mitglied; eine App, die
  mehrere braucht, ruft es mehrfach auf (ein `createWebRTCPeer()`-Aufruf
  pro Gegenüber).
- **WebRTC als Space-eigener `transport`-Slot** (1:1-P2P-Sync statt über
  Relay) - der `signaling`-Wrapper erfüllt zwar den vollen
  Transport-Vertrag und könnte theoretisch direkt an `bootstrapSpace()`
  übergeben werden, aber `createWebRTCPeer()` selbst ist bewusst ein
  SEPARATES, unabhängiges Modul, nicht in Space's eigenen Sync
  eingehängt - siehe diese Doku's eigene Einleitung.

## Tests

- `packages/space-transport/test/rtc-signal-relay.test.js` - Relay-seitiges
  Forwarding (Authentifizierung, Drop-Verhalten, kein Mirroring).
- `packages/space-transport/test/webrtc-signaling.test.js` - der
  Signaling-Wrapper, inkl. einer echten `Space` über einen gewrappten
  Transport (beweist Transparenz).
- `packages/space-transport/test/webrtc-peer.test.js` - die eigentliche
  Verhandlungslogik, gegen ein injiziertes `FakeRTCPeerConnection` (Data
  Channels, Tracks, Mute, Glare) - kein echter Browser nötig.
- `packages/space-transport/test/webrtc-browser-smoke.test.js` - EIN
  echter End-to-End-Beweis über echtes Chromium (Playwright) + einen
  echten WebSocket-Relay auf einem echten Loopback-Port. Übersprungen
  (nicht fehlgeschlagen), wenn Playwright/Chromium in der aktuellen
  Umgebung nicht verfügbar sind (`playwright` ist eine reine
  Root-`devDependency`, kein Laufzeit-Dependency irgendeines Packages).
  Dieser Test deckte während der Entwicklung einen echten
  Serialisierungs-Bug auf (`RTCSessionDescription`s Felder liegen auf dem
  Prototyp, `encodeForWire()`s `Object.entries()`-Walk sah sie nicht) -
  ein Beleg dafür, warum der Fake allein nicht ausreicht.
