# Architecture

How hushsend works, one file per topic. Read § The one rule before touching `src/`.

## The one rule

Every non-serializable, live object — `RTCPeerConnection`, `RTCDataChannel`, `WebSocket`, `CryptoKey` —
lives **only** in the imperative core (`src/core/`, in `SessionController` and its sub-modules). It never
enters the Redux store, and React never holds one. Data flows one way:

```
UI  --(method call)-->  SessionController  --(work + dispatch)-->  store  --(useSelector)-->  UI
```

The store holds serializable projections only (status, peer label, words to display, transfer progress,
error), so RTK's serializability check stays ON. `src/store/connectionSlice.ts` is a **finite state
machine** — one `status` field plus a guarded transition map — which reduces the central invariant to a
status check: **no file bytes flow unless the connection is authenticated** ([connection.md](connection.md)).

## Where the code is

```
src/
├── core/                       # imperative, framework-agnostic; owns ALL live objects
│   ├── SessionController.ts    # the boundary: UI → methods; core → dispatch
│   ├── signaling/              # WebSocket client — signaling only, every inbound frame zod-validated
│   ├── webrtc/                 # RTCPeerConnection + DataChannel, DTLS fingerprints, backpressure
│   ├── crypto/                 # cpace · sas · keyConfirmation · identity · enrollment · reconnect
│   ├── keystore/               # IndexedDB: own identity key + pinned peer keys (TOFU)
│   ├── words/  link/           # the words credential · the link token + secret
│   ├── transfer/               # chunking, flow control, volume padding, the receive paths
│   ├── iceServers.ts relax.ts stunCheck.ts pathAttest.ts   # privacy mode → ICE; relay filter; STUN cross-check; path check
│   └── pairingRole.ts sasRole.ts livenessGate.ts           # pure per-pairing decisions
├── store/                      # serializable projections only — the FSM lives here
├── types/protocol.ts           # zod schemas for the UNTRUSTED inbound signaling frames
└── ui/                         # React screens; reads the store, calls the core; stark-ui-kit
```

## Topics

| File | What it covers |
|---|---|
| [connection.md](connection.md) | the connection state machine, the signaling socket's lifecycle (closed on `connected`), early frames |
| [methods.md](methods.md) | the four ways to pair — room (SAS), words, link, QR — the per-pairing role and the room lobby |
| [crypto.md](crypto.md) | CPace, key confirmation, SAS, the identity key, TOFU enrollment, the codeless reconnect |
| [transfer.md](transfer.md) | the file transfer: chunking, flow control, the receive paths, liveness after connect |
| [privacy-and-ice.md](privacy-and-ice.md) | Max privacy and Reliable, ICE configuration, the strict relay rule, path attestation |
| [qr.md](qr.md) | generating and scanning the QR code, the self-hosted decoder |
| [ui.md](ui.md) | the screens and their styling on stark-ui-kit |

The signaling server, the TURN relay and the STUN server are documented in their own repositories:
[hush-signaling-server](https://github.com/maksimfrelikh/hush-signaling-server) (its README is the protocol
reference — frames, room types, close codes — and the header of `signaling-server.js` explains the managed
rooms) and [hushsend-stun-server](https://github.com/maksimfrelikh/hushsend-stun-server). The client's side
of the protocol is `src/types/protocol.ts` and `src/core/signaling/`.
