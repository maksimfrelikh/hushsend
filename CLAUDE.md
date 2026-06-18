# hushsend — project guide for Claude Code

Privacy-first P2P file transfer. Browser-to-browser over WebRTC/DTLS (end-to-end); the
server only does **signaling** (rendezvous + relaying opaque SDP/ICE). The signaling server
is **untrusted** — all confidentiality and authenticity are established client-side
(PAKE / SAS + DTLS), with TOFU key pinning.

Repo layout: the Vite frontend is at the repo root; the signaling server lives in `server/`
(own `package.json`, dep `ws`) so it can be split into its own repo later. Keep it
self-contained; do **not** create a shared types package between client and server —
duplicate the small signaling protocol instead.

## Stack (locked — do not swap)
- React + TypeScript, **Vite** — static SPA, **no SSR** (SSR contradicts the threat model).
- **Redux Toolkit** slices. **No RTK Query** (no REST surface; signaling is WebSocket,
  everything else is P2P DataChannel).
- No router — screens are driven by connection state.
- Raw `RTCPeerConnection` + `RTCDataChannel` (NOT PeerJS/simple-peer — we need control of
  SDP and the DTLS fingerprint for channel binding).
- Crypto: `@noble/curves` (+ `@noble/hashes`); WebCrypto where available.
- `zod` for validating inbound signaling frames.
- ESLint + Prettier, Vitest.

## Architecture — the one rule
All non-serializable, live objects (`RTCPeerConnection`, `RTCDataChannel`, `WebSocket`,
`CryptoKey`) live ONLY in the imperative core (`src/core/`, in `SessionController` and its
sub-modules). They never enter the Redux store and React never holds them. One-way flow:

`UI → SessionController method → work + dispatch → store → useSelector → UI`

The store holds only serializable projections (status, peer label, words to display,
transfer progress, error). RTK's serializability check stays ON.

## Connection state machine
`src/store/connectionSlice.ts` is the FSM: a single `status` field + an `ALLOWED` transition
map + a `canGo` guard. States: `idle | creating | awaitingPeer | joining | pairing |
awaitingSas | confirming | connected | failed`. Illegal transitions are ignored (warn in dev).

**Hard invariant:** no file bytes flow unless `status === 'connected'` (i.e. after
key-confirmation). Keep this as a single status check.

## Connection methods (4)
All four resolve to the same FSM and the same DataChannel transfer; they differ only in how
peers rendezvous + authenticate.
- **link** — secret in the URL **fragment** (`#…`), scrubbed via `history.replaceState`
  immediately after read (never sent to the server).
- **qr** — same as link, payload shown/scanned as a QR.
- **room** — server allocates a 4-digit code (public, not secret); after connect the two
  humans compare a **SAS** (digits/emoji) out-of-band. SAS is mandatory and unskippable; the
  key-changed / mismatch path is a hard stop, not a dismissable toast.
- **words** — PAKE-authenticated, **no SAS**. See below.

### words method (finalized)
A reads a phrase aloud (voice OOB), B reproduces it by **selecting**, not free-typing. PAKE
makes the low-entropy spoken phrase safe (attacker limited to online guessing; the
untrusted-server transcript is not offline-attackable).

- Wordlist: **EFF short list #2 (1296 words)** — each word has a unique 3-character prefix
  (fast autocomplete) and the list is misread-resistant (good for a voice channel). Generate
  with a **CSPRNG**, uniform, rejection-sampled (no modulo bias). Never user-chosen.
- Phrase = **5 words = 1 rendezvous + 4 secret** (~41-bit secret).
  - **rendezvous word** = room id. PUBLIC, server-allocated, from the same EFF short #2 list.
  - **4 secret words** = the CPace password. Client-generated, **never sent to the server**.
- A-side: `create=1` → server allocates rendezvous word → client generates 4 secret words →
  shows all 5 in order → A reads them aloud → waits (`awaitingPeer`).
- B-side picker: 5 positions, each its own **autocomplete** input over the **full** wordlist
  (type ~3 chars → unique word → tap). The per-position list MUST be the full list — never a
  short "correct + decoys" set (B can't know the answer; transmitting candidates would leak
  the set to the server and collapse the entropy).
- On all 5 selected: split → word 1 = rendezvous → `room=<word1>` join; words 2–5 = CPace
  password.
- Pairing: **CPace** over signaling on the 4 secret words → shared key K. Exchange
  offer/answer/ICE → DTLS. **Key-confirmation:** each side MACs the negotiated DTLS
  fingerprint under K and exchanges it; verify → `connected`; mismatch (wrong words or MITM)
  → abort, no data. **No SAS** — successful CPace + key-confirmation IS the authentication.
- Abuse: secret words are ephemeral + short TTL; after **≤10** failed attempts (rate-limited)
  invalidate and regenerate (bounds online guessing to ≤10 vs 2^41; avoids one-fail griefing).

## Crypto
- **CPace** (balanced PAKE) for the words method — over `@noble/curves` ristretto255
  (+ hash-to-curve) and `@noble/hashes` SHA-512, against the CFRG test vectors
  (draft-irtf-cfrg-cpace). Password = the secret words only (rendezvous excluded).
- **Ed25519 identity key** (TOFU pinning + reconnect signatures): prefer WebCrypto
  non-extractable Ed25519 (private key never in JS heap); fall back to `@noble/curves`
  Ed25519 where unsupported. Signatures interoperate across both paths.
- **Keystore**: IndexedDB — own identity key + pinned peer keys (TOFU). A changed peer key =
  "key changed" hard stop → re-verify, never silent.
- **Key-confirmation / channel binding**: MAC the DTLS `a=fingerprint` (the one DTLS actually
  validates against, from the received SDP) under the session key. This is what stops a MITM
  after PAKE; mismatch → abort.

## File transfer
- DataChannel with chunking + **backpressure** (`bufferedAmount` /
  `bufferedAmountLowThreshold`).
- Save-to-disk: **File System Access** (`showSaveFilePicker`) to stream to disk where
  available (Chromium); fall back to in-memory **Blob** on iOS Safari / Firefox (RAM-bound).
  Cap very large files on the Blob path — multi-GB streaming-to-disk is unreliable on iOS
  (platform limit). The transfer itself works on all browsers.

## QR
Add `barcode-detector` + `qrcode` when building the QR screen (not in the scaffold yet). Use
the **`barcode-detector` ponyfill** (native `BarcodeDetector` where available, zxing-wasm
fallback) so scanning works on iOS/Firefox/everywhere from one path; `getUserMedia` for the
camera; `qrcode` for generation.

## UI / styling — stark-ui-kit (required)
Install: `npm install github:maksimfrelikh/stark-ui-kit`.
- Import `stark-ui-kit/styles.css` once, at the app root (`src/main.tsx`).
- Set the theme by overriding `--brand-*` in a global CSS file.
- Build ALL styling on kit tokens. Do **not** introduce new color/spacing/radius scales:
  - radii `--r-*`; typography `--t-*` + weight / label tokens; spacing `--gut` / `--scale` /
    `--maxw`; semantic colors `--bg` / `--fg` / `--muted` / `--line` / `--ink`; motion
    `--ease-*` / `--dur-*`.
- For focus-trap, scroll-lock, and copy-to-clipboard use the kit's hooks/utilities —
  `useFocusTrap`, `useScrollLock`, `copyToClipboard` — do not reimplement.
- Build screens against the Claude Design mockups (provided separately).
- Design priority: kit is the source of truth; mockups are reference for layout/flow — where
  they conflict with kit components/tokens, the kit wins; never derive new tokens from
  mockups, only `--brand-*` values.

## Signaling server (`server/signaling-server.js`)
Self-contained Node + `ws`; PURE signaling, never carries file data. Already corrected:
`clientIp()` reads `X-Real-IP` (set by nginx), not the client-controllable leftmost
X-Forwarded-For; binds to `127.0.0.1` (only the local nginx reaches it). Run with
`TRUST_PROXY=1` behind nginx.
- Frontend (static `dist/`) and the WS share one host behind nginx; nginx must set
  `proxy_set_header X-Real-IP $remote_addr;` and proxy the WS (e.g. `location /ws`) to
  `127.0.0.1:8080`. Client connects to `wss://<host>/ws?app=filetransfer&…`.
- **TODO for the words method:** add a word-room allocation path — a parallel `codeType`
  (e.g. `create=1&codeType=word`) that allocates the rendezvous word from EFF short #2 (reuse
  the existing collision-retry loop). Do NOT replace the 4-digit `allocate` — room/link/QR
  still use it.

## Build order (suggested)
1. **Transport** — `SignalingClient` (WS + zod-validate every inbound frame) →
   `PeerConnection` (offer/answer/ICE, expose local+remote DTLS fingerprints, DataChannel
   send with backpressure). Backbone for all methods; testable end-to-end.
2. **words path** — wordlist + `generateWords` (CSPRNG); `cpace` (CFRG vectors);
   `keyConfirmation`; wire into `SessionController.beginPairing`.
3. **room + SAS**, then **identity/keystore + TOFU + reconnect signatures**.
4. Replace placeholder screens with real ones (kit + mockups). link/QR after transport.

## Current state
Everything in `src/core/` (signaling, webrtc, crypto, words, transfer) are typed **stubs**
that throw "not implemented" with TODOs. The store (FSM) and the core/UI boundary are real.
`src/core/words/words.ts` currently has placeholder constants `1 rendezvous + 3 secret / EFF
large 7776` — **update to 1 + 4 / EFF short #2 (1296)** per the finalized words method above.

## Cross-cutting invariants
- No file bytes before `status === 'connected'`.
- Validate every inbound signaling frame with the zod schemas (the server is untrusted).
- Secret words / link secrets never go to the server; link secrets live in the URL fragment
  and are scrubbed after read.
- All random credential material from a CSPRNG, never user-chosen.
