# Peer-Rolle & Transport-Vertrag

> Umsetzung von Arbeitspaket 4 aus `docs/quv5-vs-quv3-decision.md`: "Ein
> gemeinsames Lifecycle-Interface für Space und Relay dokumentieren/
> idealerweise einführen … für spätere Portabilität (z. B. Mesh/
> WebRTC-Peers)." Bewusst NUR Dokumentation + eine dünne Validierung in
> diesem Schritt — kein WebRTC-Code. WebRTC/Mesh bleiben "im Hinterkopf"
> für eine spätere Arbeit; dieses Dokument legt nur den Vertrag fest, an
> dem sich diese spätere Arbeit ausrichten wird.

## Die Erkenntnis: die Peer-Rolle existiert bereits — sie war nur nie benannt

QuV5 hat KEINE literale `Peer`-Klasse (wie QuV3 auch keine hatte — siehe
`docs/quv5-vs-quv3-decision.md`s Gegenüberstellung), aber die Symmetrie, um
die es geht, existiert bereits, konkret beweisbar an
`@qu/space-transport`'s `federation.js`: ein Relay, das mit einem anderen
(Upstream-)Relay föderiert, tut das, indem es **selbst zu einem ganz
gewöhnlichen Client wird** — dieselben signierten `hello`/`subscribe`-
Kontrollnachrichten, über eine ganz gewöhnliche Transport-Verbindung,
dieselbe Klasse (`Space`), die auch ein Browser-Client nutzt. `federation.
js`'s eigener Doc-Kommentar: "a relay federating 'looks like' one more
client to the relay it federates with." Das IST die Peer-Rolle aus QuV3s
symmetrischer `SyncEngine`-Nutzung — sie musste nicht neu gebaut werden,
nur explizit benannt und als Vertrag festgeschrieben werden, damit ein
künftiger Mesh-Node sich bewusst daran ausrichten kann, statt sie zufällig
zu entdecken.

**Die Peer-Rolle, konzeptionell** (bewusst keine neue gemeinsame Basisklasse
— siehe Arbeitspaket 4's eigene Klammer "nicht zwingend als Klasse"):
jede Instanz, die an einem Sync-Austausch teilnimmt, tut dies über exakt
EINEN gemeinsamen Nenner — eine `identity` (Ed25519+X25519-Keypair) plus
eine oder mehrere Transport-Verbindungen, über die sie signierte/versiegelte
Envelopes sendet und empfängt. `Space` (Client-Rolle, genau EIN Transport)
und `Relay`/`createRelayForwarder()` (Server-Rolle, VIELE gleichzeitige
Verbindungen über einen `Hub`) sind zwei unterschiedlich PARAMETRISIERTE
Nutzungen derselben zugrunde liegenden Idee, kein Gegensatz — `federation.
js` ist der Beweis, dass ein Relay jederzeit auch die Client-Rolle
(via `Space`) gegenüber einem ANDEREN Peer einnehmen kann.

## Der Transport-Vertrag (Peer-Seite: genau EINE Verbindung)

Das, was `Space`s Konstruktor als `transport` entgegennimmt — und worauf
sich ein künftiger WebRTC-DataChannel-Adapter exakt ausrichten muss, um per
`@qu/bootstrap`s Adapter-Registry (`docs/bootstrap-adapter-registry.md`)
registrierbar zu sein:

```js
/**
 * @typedef {object} Transport
 * @property {() => Promise<void>} connect - Stellt die Verbindung her (bzw. meldet "fertig", falls synchron/sofort verbunden wie InProcessTransport).
 * @property {(data: object) => void} send - Sendet eine Nachricht (plain, JSON-serialisierbares Objekt - siehe "Nachrichtenformen" unten). Darf intern queuen (WsClientTransport tut das, solange der Socket noch nicht offen ist).
 * @property {(callback: (msg: {data: object}) => void) => void} onMessage - Registriert EINEN Handler für eingehende Nachrichten (kein Multi-Listener-Bus - Space registriert genau einmal, in seinem eigenen Konstruktor).
 * @property {(callback: (update: {status: string}) => void) => void} [onStatusChange] - OPTIONAL. `'connected'`/`'disconnected'`/`'reconnecting'`/`'reconnected'` - nur wenn der Transport einen echten Lifecycle hat (WsClientTransport hat einen, InProcessTransport bewusst keinen - Space behandelt das Fehlen über `?.` als No-Op, nie als Fehler).
 * @property {() => string} [getPeerId] - OPTIONAL, rein informativ/für Tests.
 * @property {() => void} [close] - OPTIONAL. Beendet die Verbindung endgültig (deaktiviert bei WsClientTransport jeden weiteren Reconnect-Versuch).
 */
```

Referenzimplementierungen: `InProcessTransport` (`in-process-transport.js`,
simuliert, für Tests/Demos — kein `onStatusChange`) und `WsClientTransport`
(`ws-client-transport.js`, echtes WebSocket, MIT `onStatusChange` +
Reconnect-Backoff). **Ein künftiger WebRTC-Transport implementiert exakt
dieselben drei Pflichtmethoden** (`connect`/`send`/`onMessage`) über einen
`RTCDataChannel` statt eines `WebSocket` — nichts an `Space`, `Node` oder
`Field` müsste sich dafür ändern; das ist der ganze Witz dieses Vertrags.

**Nachrichtenformen** (was tatsächlich durch `send()`/`onMessage()` fließt
— ein Transport selbst muss KEINE davon verstehen, nur Objekte
durchreichen): `{type:'hello', pub, sig}`, `{type:'subscribe'|
'unsubscribe', nodeId, pub, sig}`, `{nodeId, envelope}` (ein Write —
`envelope` ist bereits signiert+ggf.verschlüsselt, siehe `envelope.js`),
`{type:'grant', ...}`, `{type:'member-joined'|'member-left', pub, xPub?}`,
`{type:'write-ack'|'sync-ack', nodeId, ...}`. Ein Transport, der über einen
echten Draht geht (WebSocket, künftig eine WebRTC-DataChannel), muss diese
Objekte JSON-fähig machen — `encodeForWire()`/`decodeFromWire()`
(`wire-codec.js`) übernehmen dabei ausschließlich die `Uint8Array`↔base64-
Konvertierung, die `JSON.stringify` sonst stillschweigend zerstören würde;
ein In-Process-Transport (Objekte per Referenz) braucht das nicht.

## Der Hub-Vertrag (Relay-Seite: VIELE gleichzeitige Verbindungen)

Bewusst ein SEPARATER, kleinerer Vertrag — `createRelayForwarder()` braucht
auf der Server-Seite nie "eine" Verbindung, sondern "wer ist gerade
verbunden, liefere dem/denen das hier aus":

```js
/**
 * @typedef {object} Hub
 * @property {(onMessageFromPeer: (peerId: string, data: object) => void) => void} registerRelay
 * @property {(peerId: string, fromPeerId: string, data: object) => void} deliverTo
 * @property {() => string[]} peerIds
 * @property {(handler: (peerId: string) => void) => void} [registerDisconnect]
 */
```

Referenzimplementierungen: `createInProcessHub()` (Tests) und
`createWsServerHub(wss)` (echter WebSocket-Server). Ein künftiger
Signaling-fähiger Mesh-Knoten würde ebenfalls einen `Hub` implementieren,
falls er selbst Verbindungen von mehreren anderen Peers annehmen soll
(siehe "Mesh" unten) — das ist bereits heute exakt der Mechanismus, über
den `relay-server.js` das tut.

## `assertTransportShape()` — fail-fast statt stiller Fehlfunktion tief in `Space`

`@qu/bootstrap`s `bootstrapSpace()` prüft den `transport`-Slot jetzt gegen
genau diesen Vertrag, BEVOR er an `Space` übergeben wird — ein Tippfehler
im eigenen Adapter (`send` fehlt, `onMessage` heißt `onMsg`) schlägt sofort
mit einer klaren Meldung fehl, statt irgendwo tief in `Space._sendHello()`
als kryptischer `TypeError`:

```js
bootstrapSpace({ registry, identity, transport: myBrokenTransport, ... });
// Error: bootstrapSpace: "transport" is missing required method(s): send
// - see docs/peer-transport-contract.md
```

Prüft bewusst NUR die drei PFLICHT-Methoden (`connect`/`send`/
`onMessage`) — `onStatusChange`/`getPeerId`/`close` sind optional und
werden nie verlangt.

## Mesh, Signaling-Relays, WebRTC — wo dieser Vertrag hinführt (noch nicht gebaut)

Drei Dinge, bewusst nicht verwechselt:

1. **Ein WebRTC-Transport** ist reine Adapter-Arbeit (siehe oben) — ein
   `RTCDataChannel`-Wrapper, der `connect`/`send`/`onMessage` erfüllt,
   registriert sich wie `ws-client` unter einem Namen in der
   Adapter-Registry. Kein Core-Code ändert sich.
2. **Ein Signaling-Relay** (wer hilft zwei WebRTC-Peers, sich overhaupt zu
   finden/SDP+ICE auszutauschen) ist ORTHOGONAL zu Qus eigenem Relay
   (`relay.js`, das Node-Envelopes spiegelt/weiterleitet) — ein
   eigenständiges, winziges Protokoll (Standard-WebRTC-Signaling, z. B. im
   Stil von `y-webrtc`s eigenem Signaling-Server), das bei Bedarf NEBEN
   dem bestehenden Relay-Prozess laufen kann, ohne dass `relay.js` selbst
   etwas davon wissen muss.
3. **Echtes Mesh** (mehrere gleichzeitige Peer-Verbindungen EINES Knotens,
   der dann selbst weiterleitet) braucht mehr als nur einen neuen
   Transport — `Space` geht heute von GENAU EINEM Transport aus
   (Stern-Topologie: Peer ↔ Relay ↔ Peer, nie direkt, siehe `space.js`s
   eigenen Konstruktor). Ein Mesh-Knoten bräuchte eine THIN ROUTING-SCHICHT
   OBERHALB von `Space` (mehrere `Space`- oder `Transport`-Instanzen, je
   eine pro Mesh-Nachbar, plus eigene Weiterleitungslogik) — analog dazu,
   wie `createRelayForwarder()` heute schon eine dünne Schicht ÜBER dem
   Hub-Vertrag ist, keine Änderung an `Space`/`Node`/`Field` selbst.
   `federation.js` ist der nächstliegende, bereits existierende Präzedenzfall
   (ein Relay, der selbst Peer eines anderen Relays ist) — ein Mesh-Knoten
   wäre die Verallgemeinerung davon auf mehr als zwei Hops/eine feste
   Hierarchie.

**Warum das jetzt schon gefahrlos aufschiebbar ist:** der Yjs-Update-Byte-
Payload (`Y.encodeStateAsUpdate()`/`Y.applyUpdate()`, versiegelt über
`envelope.js`) ist bereits transport-UNABHÄNGIG — er fließt heute
identisch durch `InProcessTransport` und `WsClientTransport`. Eine künftige
WebRTC-/Mesh-Erweiterung ändert NUR, WIE diese Bytes von A nach B kommen,
nie WAS sie sind oder wie sie verarbeitet werden (siehe `docs/quv5-vs-quv3-
decision.md`s Status-Update zu Arbeitspaket 3: Yjs bleibt bewusst die
alleinige Sync-Basis).
