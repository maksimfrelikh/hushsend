# hushsend — project guide for Claude Code

Privacy-first P2P file transfer. Browser-to-browser over WebRTC/DTLS (end-to-end); the
server only does **signaling** (rendezvous + relaying opaque SDP/ICE). The signaling server
is **untrusted** — all confidentiality and authenticity are established client-side
(PAKE / SAS + DTLS), with TOFU key pinning.

Repo layout: the Vite frontend is at the repo root; the signaling server lives in `server/`
(own `package.json`, dep `ws`) so it can be split into its own repo later. Keep it
self-contained; do **not** create a shared types package between client and server —
duplicate the small signaling protocol instead.

## Keep this file in sync (read this first)
This file + the repo are the ONLY context a fresh session has — sessions do not remember prior
work. So whenever a change alters the app's actual state, update this file in the SAME pass:
- completing or advancing a build step → update **Build order** and **Current state** markers;
- adding / removing / renaming a core module → update the file lists in **Current state**;
- changing a protocol, constant, or invariant → update the relevant **Crypto** / method section;
- deferring something → note it under **Known residuals / deferred**.
Stale markers (e.g. a finished step still marked 🚧, or a built module missing from the
inventory) cause real rework for the next session. Treat doc drift as a bug.

## Stack (locked — do not swap)
- React + TypeScript, **Vite** — static SPA, **no SSR** (SSR contradicts the threat model).
- **Redux Toolkit** slices. **No RTK Query** (no REST surface; signaling is WebSocket,
  everything else is P2P DataChannel).
- No router — screens are driven by connection state.
- Raw `RTCPeerConnection` + `RTCDataChannel` (NOT PeerJS/simple-peer — we need control of
  SDP and the DTLS fingerprint for channel binding).
- Crypto: `@noble/curves` (+ `@noble/hashes`); WebCrypto where available.
- `zod` for validating inbound signaling frames.
- ESLint + Prettier; **Vitest** (unit) and **Playwright** (e2e, Chromium) — keep both suites green.

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
(Identity enrollment is an action on `connected`, not a state; SAS timeouts lead to `failed`
without adding states. **Reconnect re-auth (4b-ii) adds NO states** — it reuses `pairing →
confirming → connected | failed`, and `pairing → awaitingSas` when it falls back to SAS.)

**Hard invariant:** no file bytes flow unless the connection is authenticated (status reaches
`connected` / the `established` gate, i.e. after key-confirmation or mutual SAS-confirm). Keep
this as a single gate check.

## Connection methods (4)
All four resolve to the same FSM and the same DataChannel transfer; they differ only in how
peers rendezvous + authenticate.
- **link** — secret in the URL **fragment** (`#…`), scrubbed via `history.replaceState`
  immediately after read (never sent to the server). *(planned)*
- **qr** — same as link, payload shown/scanned as a QR. *(planned)*
- **room** — server allocates a 4-digit code (public, not secret); after connect the two
  humans compare a **SAS** (3 words from EFF short #2) out-of-band. SAS is mandatory and
  unskippable; the key-changed / mismatch path is a hard stop, not a dismissable toast.
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

### room method (SAS) — done
Server allocates a 4-digit public code; both sides connect, then humans compare a short
string (SAS) **out-of-band** (voice/QR/etc.) — the MITM check.

**SAS design (commit-before-reveal, per ZRTP / Vaudenay)**: to prevent a MITM-server from
grinding certs to match SAS on both sides, reveal the SAS only after committing to random
nonces:
- Responder (B, joiner) sends `{kind:'sas-commit', c}` where `c = SHA-256("hushsend/sas/commit"
  || nonceB)`, nonceB = 16 random bytes. Initiator (A) sends `{kind:'sas-nonce', nonce: nonceA}`.
- B reveals `{kind:'sas-nonce', nonce: nonceB}`. A verifies `c = SHA-256(...)` with `equalBytes`
  (abort on mismatch). Order is critical: B is committed before nonceA is revealed. Both derive
  (HKDF-SHA512, same KDF as the words key-confirmation):
```
  SAS = HKDF-SHA512(IKM = lv(nonceA) || lv(nonceB) || lv(fp_min) || lv(fp_max),
                    salt = ∅, info = "hushsend/sas")
```
  where `fp_min/fp_max` = sorted DTLS fingerprints (lexicographic order, same canonicalization
  as words key-confirmation), `lv` = length-prefix. The commitment `c` stays SHA-256 (a hash is
  the right primitive for a binding commitment). Then render SAS as **3 words from EFF short #2**
  (≈31 bits, readable aloud); each word index is a bias-free 8-byte reduction of the HKDF output.
  Both sides must derive the same triple.
- **Exchange over DataChannel**: each side sends `{kind:'sas-confirm', ok: <bool>}` after the
  human either confirms (both SAS match) or denies (mismatch). Both must confirm → `connected`;
  any deny/timeout/abort → `failed`. This is not a cryptographic boundary (SAS already
  authenticated the channel via fingerprint binding), but a **coordination gate** ensuring both
  sides agree on authenticity before allowing data transfer.
- **Timeouts**: one reused timer bounds the coordination phases, default **120000 ms** (~2 min).
  It arms at peer-joined to bound the pre-SAS pairing window (peer sent commit but withheld its
  nonce → no longer hangs; this deadline is fixed / non-overridable), then re-arms at SAS-display
  to bound the comparison + confirm window. The comparison value is dev-overridable for tests
  (`?sasTimeoutMs=N` / `window.__HUSHSEND_SAS_TIMEOUT_MS__`, gated behind `import.meta.env.DEV`,
  so it is dead code / tree-shaken in prod). On expiry → `failSas` → `failed` + close, same path
  as deny/abort.
- **Inbound validation**: `sas-commit` / `sas-nonce` frames are zod-validated to exact decoded
  lengths (commit = 32 bytes, nonce = 16 bytes); malformed / short / odd-hex frames are rejected
  before any crypto (untrusted relay).
- **Server cap / TTL**: the 4-digit room still needs anti-farming (max 2 peers, TTL before
  `connected`, regenerate). **Deferred** — separate server pass (see Known residuals).

## Crypto
- **CPace** (balanced PAKE) for the words method — over `@noble/curves` ristretto255
  (+ hash-to-curve) and `@noble/hashes` SHA-512, against the CFRG test vectors
  (draft-irtf-cfrg-cpace-21, April 2026). Password = secret words only (rendezvous excluded).
  - Specifics: sid = fresh 16-byte nonce per session, generated by initiator and sent with
    first CPace message; both sides use it in ISK derivation. Abort conditions (per draft-21):
    invalid point, point = identity. Scalar sampling: uniform ≤ 2^252 < ristretto255 order,
    rejection-sample for nonzero (negligible bias; ~2^-127).
- **Ed25519 identity key** (TOFU pinning + reconnect signatures): prefer WebCrypto
  non-extractable Ed25519 (private key never in the JS heap; the non-extractable `CryptoKey` is
  stored in IndexedDB and cannot be read back); fall back to `@noble/curves` Ed25519 (stores the
  32-byte seed) where unsupported. Signatures interoperate across both paths — verify uses noble
  unconditionally (Ed25519 is RFC 8032, signature format is canonical).
- **Identity enrollment (TOFU, done)**: runs ONLY after `connected` — i.e. over the already
  SAS/words-authenticated channel, where the MITM is already defeated, so exchanging public keys
  is trustworthy (this is the trust-on-first-use moment). It is an action on `connected`, NOT an
  FSM state, and does NOT gate `connected` or transfer; a bad enrollment signature only skips the
  pin + warns, never tears down the human/PAKE-authenticated session. The initiator generates a
  key-independent random `pairingId` (16 bytes) — key-independent so a swapped key under the same
  id is detectable on reconnect. Each side signs its OWN public key:
```
  sign( lv("hushsend/identity/enroll") || lv(pairingId) || lv(ownPubKey) || lv(fp_min) || lv(fp_max) || lv(role) )
```
  (same `lv` + sorted-fingerprint canonicalization as key-confirmation / SAS; fingerprints from
  the parsed SDP — channel binding). The verifier reconstructs with the received key as the
  signer's `ownPubKey`, the peer's role, the shared `pairingId`, and its own fingerprints. On
  success each side pins `pairingId → peerPublicKey`. Frames (`enroll-init {pairingId, pubKey,
  sig}`, `enroll-ack {pubKey, sig}`) are zod-validated to exact lengths (pairingId 16B, pubKey
  32B, sig 64B).
- **Reconnect (TOFU re-auth, done — 4b-ii)**: when both sides ALREADY hold a pin for the same
  `pairingId` (from a prior enrollment), they reconnect with **NO human step** — a mutual signature
  under the pinned keys replaces SAS/words. It reuses the room rendezvous and rides on top of the
  SAS state, which stays primed as the fallback. Path selection: the initiator announces the
  pairingId (`reconnect-init`); both look up their pin. Both-have-pin → reconnect-auth; a pin
  missing on either side → `reconnect-fallback` → the normal first connect (SAS + enrollment).
  Each side proves possession of its pinned private key over a fresh, channel-bound transcript:
```
  sign( lv("hushsend/identity/reconnect") || lv(pairingId) || lv(challengeInitiator) || lv(challengeResponder) || lv(fp_min) || lv(fp_max) || lv(role) )
```
  (same `lv` + sorted-fingerprint canonicalization as enroll/SAS/key-confirmation; fingerprints
  from the parsed SDP — channel binding. Each side draws a fresh 16-byte CSPRNG challenge; both are
  bound in fixed role order.) **Verification is TWO separate checks** so a key change is told apart
  from a MITM: (1) does the PRESENTED key equal the PINNED key for this pairingId? No → **key
  changed** hard stop (SSH-style — the peer under this id is using a different key; a visible stop,
  never a toast, no bytes). (2) does the signature verify under the PINNED key over the transcript
  rebuilt with OUR fingerprints + the peer's role? No (key matched) → channel-binding / **MITM**
  hard stop, no bytes. Both pass → authenticated reconnect (`connected`, no re-enrollment).
  **Replay** is closed by the channel binding (a fresh DTLS cert per session) AND the explicit
  challenges (so freshness does not rely on assuming the cert is fresh). Frames (`reconnect-init
  {pairingId, challenge}`, `reconnect-proof {challenge, pubKey, sig}`, `reconnect-fallback {}`) are
  zod-validated to exact lengths (pairingId 16B, challenge 16B, pubKey 32B, sig 64B). DEV/TEST knob
  `?forgeReconnectKey=1` makes a side present a fresh key under the real pairingId, driving the
  key-changed e2e.
- **Keystore** (IndexedDB, behind a `KeystoreBackend` port — an IndexedDB impl for the app, an
  in-memory impl for unit tests): stores own identity (non-extractable `CryptoKey` or noble seed)
  and pinned peer keys (`pairingId → { peerPublicKey, firstSeen, label? }`). Pinning on first
  successful connect (enrollment, above) and the **"key changed" hard stop on reconnect** (presented
  key ≠ pin → abort, never silent — `presentedKeyMatchesPin`) are both **done** (4b-i / 4b-ii).
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
4. ✅ **room + SAS** — 4-digit code, commit-before-reveal, SAS = 3 words, fingerprint binding,
   mutual confirmation over DataChannel, pre-SAS + comparison timeouts, zod length checks.
   Deferred: server cap/TTL for 4-digit rooms.
5. **Identity + TOFU** — two parts:
   - ✅ **4b-i** — Ed25519 identity key + IndexedDB keystore + TOFU **enrollment** (pin peer key
     on first successful connect, channel-bound).
   - ✅ **4b-ii** — **reconnect**: mutual challenge-response signatures (channel-bound, replay-
     resistant) under the pinned keys; two-check verify (key-changed vs MITM) + "key changed" hard
     stop; falls back to SAS + enrollment when a pin is missing. `reconnect.ts` + e2e (happy +
     key-changed).
6. 📋 **Real UI screens** — replace dev harness with kit-based screens; link/QR; persistent
   state across tabs / page reload.

## Current state
- ✅ `src/core/crypto/` — `cpace` (CFRG draft-21 vectors passing), `keyConfirmation` (channel
  binding + MITM tests), `sas` (commit-before-reveal, HKDF-SHA512, fingerprint binding, timeouts,
  zod length checks), `identity` (Ed25519, WebCrypto non-extractable + noble fallback),
  `enrollment` (TOFU exchange + pin, channel-bound), `reconnect` (TOFU re-auth: channel-bound
  signature under the pinned key + fresh challenges, two-check verify, key-change detection). Words
  wordlist (EFF short #2) programmatic.
- ✅ `src/core/keystore/` — IndexedDB (+ in-memory backend for unit tests) behind
  `KeystoreBackend`; own identity key + pinned peer keys (`pairingId → peer key`). Cross-tab
  identity-generation single-flight via `navigator.locks`; "key changed" detection on reconnect.
- ✅ `src/core/words/` — `generateWords` (CSPRNG, rejection-sampled), rate-limit counter (≤10
  attempts), TTL handling (does not kill live P2P).
- ✅ `src/core/` — transport (SignalingClient, PeerConnection), file transfer, SessionController
  orchestration (incl. SAS + post-connect enrollment wiring). FSM in store (status, transitions,
  invariants enforced).
- 🚧 `src/ui/` — dev harness: room + words pickers, SAS display + confirm, reconnect (create /
  join-by-code) with the authenticated-no-SAS outcome + visible key-changed hard-stop banner, own
  identity fingerprint + pinned peer + "Forget pins / reset". Real screens pending (step 6).
- ✅ Server — signaling, corrected `clientIp()`, word-room allocation, 2-peer cap, TTL, creator
  destroy. Ready for deployment behind nginx.
- 📋 Pending: server rate-limit/TTL on 4-digit rooms; real UI screens (step 6).

## Known residuals / deferred
- **Pre-SAS pairing deadline is untested in the firing direction** (room method). The timer
  mechanism is exercised by the comparison-timeout e2e and happy-path proves it does not fire
  prematurely, but "withheld nonce → fires at deadline" has no e2e (would need a stalled-peer
  harness knob). Low severity (liveness, not crypto).
- **`pairingId` is a metadata leak to the relay** (reconnect). It is an identifier, not a secret,
  and reconnect announces it over signaling-routed setup, so the untrusted relay can observe "these
  two have paired before" (linkability across reconnects). It carries no key material and does not
  weaken the auth (the signature under the pinned key is what authenticates); it is a privacy /
  traffic-analysis residual, not a confidentiality one.
- **Dual-pin under different pairingIds if one side loses its keystore** (reconnect). If a peer
  clears storage (or the keystore is wiped) it no longer holds the pin, so the next connect falls
  back to SAS + a FRESH enrollment → a NEW pairingId. The other side keeps the stale pin AND gains
  the new one (two pins for the same human). Benign (the fresh enrollment is itself human-verified),
  but the keystore accumulates a dead pin. Not fixed (no GC / pin-merge yet).
- **Server cap/TTL for 4-digit rooms** still deferred (parallel to the word-room cap/TTL). SAS
  catches a MITM regardless; this is anti-farming / 1:1 hygiene. link/QR also ride 4-digit rooms,
  so this server pass is deferred until those are in view.

## Cross-cutting invariants
- No file bytes before the connection is authenticated (`connected` / `established`).
- Validate every inbound signaling frame with the zod schemas (the server is untrusted).
- Secret words / link secrets never go to the server; link secrets live in the URL fragment
  and are scrubbed after read.
- All random credential material from a CSPRNG, never user-chosen.
- After `connected`, signaling closure does not tear down the live P2P connection (enables
  long transfers and future reconnect).
