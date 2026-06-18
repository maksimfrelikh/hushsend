# hushsend — scaffold

Privacy-first P2P file transfer. The browser-to-browser transfer is end-to-end
over WebRTC/DTLS; the server only does **signaling** (rendezvous + relaying
opaque SDP/ICE). The server is treated as untrusted — confidentiality and
authenticity are established client-side (PAKE / SAS + DTLS, with TOFU key
pinning).

This is a **skeleton**: the architecture, the folder layout, the core/UI
boundary, and the connection state machine are in place. Everything that needs
real protocol/crypto logic is a typed stub that throws `not implemented` with a
TODO pointing at what goes there. It compiles and runs (you'll see placeholder
screens).

## Run

```bash
npm install
npm run dev        # vite dev server
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + vite build
```

Dev runs over `http://localhost` (a secure context, so Web Crypto works). To
test on a phone over a LAN IP you'll want HTTPS — uncomment `https` in
`vite.config.ts` (or add `@vitejs/plugin-basic-ssl`).

## Layout

```
hushsend/
├── index.html
├── vite.config.ts            # SPA, no SSR (SSR would contradict the threat model)
├── tsconfig*.json            # strict, verbatimModuleSyntax
├── eslint.config.js
└── src/
    ├── main.tsx              # React root + <Provider>
    ├── types/
    │   └── protocol.ts       # zod schemas validating UNTRUSTED inbound signaling frames
    ├── store/                # serializable projections only — never live objects
    │   ├── index.ts          # configureStore
    │   ├── hooks.ts          # typed useAppDispatch / useAppSelector
    │   ├── connectionSlice.ts # *** the connection FSM (status + guarded transitions) ***
    │   └── transferSlice.ts  # transfer progress
    ├── core/                 # imperative, framework-agnostic; owns ALL live objects
    │   ├── SessionController.ts   # the boundary: UI -> methods; core -> dispatch
    │   ├── signaling/SignalingClient.ts  # WebSocket wrapper (signaling only)
    │   ├── webrtc/PeerConnection.ts      # raw RTCPeerConnection + RTCDataChannel
    │   ├── crypto/
    │   │   ├── cpace.ts            # CPace (balanced PAKE) for the words method
    │   │   ├── identity.ts         # Ed25519 identity key (WebCrypto + noble fallback)
    │   │   ├── keystore.ts         # IndexedDB: own key + pinned peer keys (TOFU)
    │   │   └── keyConfirmation.ts  # MAC the DTLS fingerprint under the PAKE key
    │   ├── words/words.ts    # EFF wordlist: 1 rendezvous + 3 secret words
    │   └── transfer/fileTransfer.ts  # chunking + backpressure; FSA / Blob save
    └── ui/                   # React; reads store via useSelector, calls the core
        ├── App.tsx           # creates the single SessionController
        ├── SessionProvider.tsx   # context exposing the controller (useSession)
        └── screens/index.tsx     # ScreenRouter — screen per status (no URL router)
```

## The one rule: core / UI boundary

All non-serializable, live objects — `RTCPeerConnection`, `RTCDataChannel`,
`WebSocket`, `CryptoKey` — live **only** in `core/` (in `SessionController` and
its sub-modules). They never enter the Redux store and React never holds them.

Data flows one way:

```
UI  --(method call)-->  SessionController  --(work + dispatch)-->  store  --(useSelector)-->  UI
```

The store holds only serializable projections (status, peer label, the words to
display, transfer progress, error). Because of that, RTK's serializability check
stays on.

`connectionSlice.ts` is the **finite state machine**: one `status` field plus an
`ALLOWED` transition map and a `canGo` guard. Illegal transitions are ignored
(warned in dev), so invariants reduce to a status check — most importantly,
**no file bytes flow unless `status === 'connected'`** (i.e. after
key-confirmation).

## Implement next (suggested order)

1. **words** — fill `WORDLIST` (EFF large, 7776) and implement `generateWords()`
   (CSPRNG + rejection sampling). `splitWords()` is already done.
2. **signaling** — `SignalingClient.connect()` / `send()`, validating every
   inbound frame with `serverMessageSchema`.
3. **webrtc** — `PeerConnection` offer/answer/ICE, expose local + remote DTLS
   fingerprints, and `send()` with `bufferedAmount` backpressure.
4. **crypto** — `cpace.ts` against the CFRG vectors; `identity.ts` (WebCrypto
   Ed25519 non-extractable + noble fallback) and `keystore.ts` (TOFU).
5. **keyConfirmation** — MAC the DTLS fingerprint under the CPace key; wire it
   into `SessionController.beginPairing()` (mismatch -> `failed`).
6. **transfer** — `fileTransfer.ts` send/receive, FSA where available, Blob
   fallback otherwise.
7. Wire real screens to replace the placeholders in `screens/index.tsx`.

### QR (add when you build that screen)

Not pulled in yet to keep install lean:

```bash
npm i barcode-detector qrcode
```

`barcode-detector` is a ponyfill — it uses the native `BarcodeDetector` where
available and falls back to zxing-wasm on iOS/Firefox, so QR scanning works on
all browsers from one code path. `qrcode` is for generation.

### Server tweaks (companion signaling server)

- **`allocate` for the words method** — emit a word from the EFF list as the
  room id (reuse the existing collision-retry loop) instead of a 4-digit code,
  so the rendezvous lives inside the words.
- **X-Forwarded-For fix** — derive the client IP from a header your proxy
  controls (e.g. `X-Real-IP`, or the rightmost-N hops), not the leftmost XFF
  entry. The leftmost value is client-controllable behind an appending proxy, so
  as written the per-IP caps can be bypassed.
