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
  humans compare a **SAS** (short string, digits/emoji/words) out-of-band. SAS is mandatory
  and unskippable; the key-changed / mismatch path is a hard stop, not a dismissable toast.
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
- A-side: `create=1&codeType=word` → server allocates rendezvous word from EFF short #2 →
  client generates 4 secret words → shows all 5 in order → A reads them aloud → waits
  (`awaitingPeer`).
- B-side picker: 5 positions, each its own **autocomplete** input over the **full** wordlist
  (type ≥3 chars → unique word → tap). The per-position list MUST be the full list — never a
  short "correct + decoys" set (B can't know the answer; transmitting candidates would leak
  the set to the server and collapse entropy).
- On all 5 selected: split → word 1 = rendezvous → `room=<word1>` join; words 2–5 = CPace
  password (PRS), canonical join format: `utf8ToBytes(secret.map(w => w.toLowerCase()).join('\n'))`.
- Pairing: **CPace** (draft-irtf-cfrg-cpace-21, CPACE-RISTRETTO255-SHA512) over signaling
  new `{kind:'cpace', sid?, msg}` frames (sid = 16-byte session nonce, initiator generates
  and sends on first frame; responder echoes). → shared key K. Exchange offer/answer/ICE →
  DTLS. **Key-confirmation:** each side MACs the negotiated DTLS fingerprint (the one from
  received SDP, that DTLS validates) + role label under K via HKDF-SHA512 derivation, exchanges
  it over a DataChannel control message `{kind:'confirm', role?, tag}`; verify with
  `equalBytes` → `connected`; mismatch (wrong words or MITM) → `failed`, no data. **No SAS** —
  successful CPace + key-confirmation IS the authentication.
- **Rate-limit / TTL**: word-room windows are bounded by **MAX_PAIRING_ATTEMPTS = 10**
  (failed CPace/confirmation/peer-drop/transport-abort counts as an attempt). On reaching the
  cap or if a server-side TTL (**WORD_ROOM_TTL_MS = 180000**, ~3 min) expires **before**
  `connected`, the word-room is invalidated → invalidates the rendezvous. After `connected`,
  TTL does NOT tear down the already-authenticated P2P connection; signaling closes but the
  DataChannel persists, allowing long transfers (10GB+ at typical speeds may exceed 3 min).
  A counts attempts and can manually regenerate (fresh 5 words, new room). This bounds online
  guessing: ≤10 tries × ~2 per guess ≈ 2^4 vs 2^41 secret space.
- Server: word-rooms cap at **2 peers max** (creator + one joiner; 3rd joiner bounced with
  `4002 'room full'`). This serializes guesses and ensures the room is 1:1.
### room method (SAS) — in progress (step 4a)
Server allocates a 4-digit public code; both sides connect, then humans compare a short
string (SAS) **out-of-band** (voice/QR/etc.) — the MITM check.
 
**SAS design (commit-before-reveal, per ZRTP / Vaudenay)**: to prevent a MITM-server from
grinding certs to match SAS on both sides, reveal the SAS only after committing to random
nonces:
- Responder (B, joiner) sends `{kind:'sas-commit', c}` where `c = SHA-256("hushsend/sas/commit"
  || nonceB)`, nonceB = 16 random bytes. Initiator (A) sends `{kind:'sas-nonce', nonce: nonceA}`.
- B reveals `{kind:'sas-nonce', nonce: nonceB}`. A verifies `c = SHA-256(...)` (abort on
  mismatch). Both derive:
```
  SAS = H("hushsend/sas" || lv(nonceA) || lv(nonceB) || lv(fp_min) || lv(fp_max))
```
  where `fp_min/fp_max` = sorted DTLS fingerprints (lexicographic order, same canonicalization
  as words key-confirmation), `lv` = length-prefix. Then render SAS as **3 words from EFF
  short #2** (≈31 bits, readable aloud). Both sides must derive the same triple.
- **Exchange over DataChannel**: each side sends `{kind:'sas-confirm', ok: <bool>}` after the
  human either confirms (both SAS match) or denies (mismatch). Both must confirm → `connected`;
  any deny/timeout/abort → `failed`. This is not a cryptographic boundary (SAS already
  authenticated the channel via fingerprint binding), but a **coordination gate** ensuring both
  sides agree on authenticity before allowing data transfer.
- **Server cap / TTL**: the 4-digit room respects anti-farming measures: max 2 peers, TTL
  before `connected`, user can regenerate. (Out of scope for 4a; will be added in a separate
  pass alongside identity/TOFU.)
## Crypto
- **CPace** (balanced PAKE) for the words method — over `@noble/curves` ristretto255
  (+ hash-to-curve) and `@noble/hashes` SHA-512, against the CFRG test vectors
  (draft-irtf-cfrg-cpace-21, April 2026). Password = secret words only (rendezvous excluded).
  - Specifics: sid = fresh 16-byte nonce per session, generated by initiator and sent with
    first CPace message; both sides use it in ISK derivation. Abort conditions (per draft-21):
    invalid point, point = identity. Scalar sampling: uniform ≤ 2^252 < ristretto255 order,
    rejection-sample for nonzero (negligible bias; ~2^-127).
- **Ed25519 identity key** (TOFU pinning + reconnect signatures): prefer WebCrypto
  non-extractable Ed25519 (private key never in JS heap); fall back to `@noble/curves`
  Ed25519 where unsupported. Signatures interoperate across both paths.
- **Keystore**: IndexedDB — own identity key + pinned peer keys (TOFU). A changed peer key =
  "key changed" hard stop → re-verify, never silent.
- **Key-confirmation / channel binding**: each side derives `confKey = HKDF-SHA512(ISK,
  info="hushsend/cpace/confirm")`, then `tag = HMAC-SHA256(confKey, lv(role) || lv(fp_min)
  || lv(fp_max))`, where `fp_min/fp_max` are the DTLS fingerprints (lexicographically sorted)
  from the local cert and the received SDP; `lv` = length-prefixed encoding (same as in CPace);
  role = initiator/responder. Exchange `tag` over DataChannel control message; verify with
  `equalBytes` (constant-time). This binds both the session key (via ISK) and the actual DTLS
  channel (via fingerprints) — a MITM with different certs on each leg produces mismatched tags.
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
- **Word-room allocation** (codeType=word): server maintains its own copy of EFF short #2,
  allocates rendezvous word via the same collision-retry loop (dual codeType). Validates word
  membership on join. Returns `codeType=word` in welcome. 4-digit `allocate` is unchanged;
  room/link/QR continue to use it. Word-rooms expire on TTL or cap-reached; freed words return
  to the pool.
## Build order (completed / in progress / planned)
1. ✅ **Transport** — `SignalingClient`, `PeerConnection`, core DataChannel backbone.
2. ✅ **File transfer** — chunking, backpressure, FSA/Blob caps.
3. ✅ **words path** — wordlist (EFF short #2, programmatic), `generateWords` (CSPRNG);
   `cpace` (CFRG draft-21 vectors, ristretto255+SHA512); `keyConfirmation` (ISK→HMAC, channel
   binding); rate-limit (≤10 attempts); TTL (3 min, does not tear down live P2P).
4. 🚧 **room + SAS** — 4-digit code, commit-before-reveal, SAS = 3 words, fingerprint binding,
   mutual confirmation over DataChannel. Out of scope for this pass: server cap/TTL for
   4-digit rooms.
5. 📋 **Identity + TOFU** — Ed25519 keystore (IndexedDB); pin peer keys on first successful
   connect; "key changed" hard stop (reconnect signatures + channel-binding).
6. 📋 **Real UI screens** — replace dev harness with kit-based screens; link/QR; persistent
   state across tabs / page reload.
## Current state
- ✅ `src/core/crypto/` — cpace (CFRG draft-21 vectors passing), keyConfirmation (channel
  binding + MITM tests), complete. Words wordlist (EFF short #2) programmatically generated.
- ✅ `src/core/words/` — generateWords (CSPRNG, rejection-sampled), rate-limit counter (≤10
  attempts), TTL handling (does not kill live P2P).
- ✅ `src/core/` — transport (SignalingClient, PeerConnection), file transfer, SessionController
  orchestration. FSM in store (status, transitions, invariants enforced).
- 🚧 `src/ui/` — dev harness with room+words pickers; real screens pending (step 6).
- ✅ Server — signaling, corrected clientIp(), word-room allocation, 2-peer cap, TTL,
  creator destroy. Ready for deployment behind nginx.
- 📋 Server rate-limit / TTL on 4-digit rooms, identity keystore, TOFU (4b/5).
## Cross-cutting invariants
- No file bytes before `status === 'connected'`.
- Validate every inbound signaling frame with the zod schemas (the server is untrusted).
- Secret words / link secrets never go to the server; link secrets live in the URL fragment
  and are scrubbed after read.
- All random credential material from a CSPRNG, never user-chosen.
- After `connected`, signaling closure does not tear down the live P2P connection (enables
  long transfers and future reconnect).