# hushsend — backlog (remaining & deferred work)

Forward-looking work only. Current built state + implementation caveats live in CLAUDE.md
(§ Current state, § Known residuals). Update this file in the same pass as CLAUDE.md when items land.

## Step 6 — Hardening (main remaining chunk)
- ✅ **Server cap/TTL/rate-limit for `filetransfer` rooms — DONE (6a)**. The `filetransfer` app is a
  `managed` app, which gives BOTH its 4-digit (room/link/QR) and word rooms a TTL-until-connected that
  frees the code (expiry → 4010 close + later join → 4009 `'room not found'`; the live P2P channel
  survives a post-`connected` signaling close) and a per-IP create/join rate-limit (`IP_RL_MAX = 60` /
  `IP_RL_WINDOW_MS = 60000`; over → 4011 `'too many attempts'`, loopback-exempt). SAS / key-confirmation
  defeat a MITM regardless — this is abuse hygiene. `tests/integration/room-server.test.ts`.
  - **Correction (later pass):** the **seat cap is codeType-dependent, not the `managed` flag**. The
    4-digit room/link/QR rendezvous is a **mesh LOBBY** (`FILETRANSFER_MAX_PEERS`, default 8) where
    several peers see each other and each picks whom to pair 1:1 with (incl. joiner↔joiner); only the
    **words** rendezvous stays strictly 1:1 (`WORD_ROOM_MAX_PEERS = 2`, serializing secret-word
    guessing). The 4-digit TTL is now an **idle timeout** (re-armed on each join); the words TTL stays
    armed from CREATE. SAS role moved to per-pairing-by-id (see below). (See CLAUDE.md § Signaling
    server / room+SAS.)
- ✅ **Per-pairing transport/crypto role — DONE (6b)**. `this.role` (initiator/responder) is fixed
  PER-PAIRING from the two readable ids (`src/core/pairingRole.ts` `pairingRoleFor`: smaller id =
  initiator — the same id order as the SAS reader/picker; `pairingRole.test.ts`), NOT create/join.
  This removes the joiner↔joiner deadlock the mesh lobby exposed (both sides `responder` → no WebRTC
  offer + SAS commit-reveal stall): the WebRTC offer direction, CPace init, SAS nonce/commit order,
  and key-confirmation/enrollment `lv(role)` all follow it. Reconnect's protocol role stays
  create/join (the verifier-first side must be fixed). 1:1 outcome unchanged. (See CLAUDE.md
  § Per-pairing role.)
- ✅ **Room lobby UI (core) — DONE (6c)**. The room method no longer auto-pairs: creator + joiners
  land in `awaitingPeer` (`joining → awaitingPeer`, no new state) and see a `LobbyScreen` — the 4-digit
  code + a roster (`connection.roster` = `{id, device, joinedAt}` maintained from welcome/peer-joined/
  peer-left) + a Connect button per peer. Pick → `pair-request`; the smaller id offers (per-pairing
  role 6b); glare/dedup handled; **busy-reject** returns the picker to the lobby with a clear notice (no
  hang). Works for ANY pair incl. joiner↔joiner. Signaling protocol grew: `welcome.peers` + `peer-joined`
  now carry `{id, device, joinedAt}` (coarse client device label, server-capped ≤32 + server-stamped
  joinedAt). words/link/qr stay 1:1 auto-pair; reconnect stays the by-code auto-pair path.
  `tests/e2e/lobby.spec.ts` (joiner↔joiner + busy) + `connectionSlice.test.ts` + `room-server.test.ts`.
  (See CLAUDE.md § Room lobby.) **Deferred follow-ups below.**
  - **reconnect-in-lobby** *(deferred)* — let a lobby pick target a previously-paired peer and reconnect
    via the pinned key (no SAS) instead of a fresh SAS. Today lobby picks ALWAYS do a fresh SAS;
    reconnect remains a SEPARATE by-code path (auto-pairs, simple code screen). **When built, the
    reconnect PROTOCOL role must move to id-order** (it is currently create/join, which is well-defined
    only for the 1:1 by-code path — a mesh pick has no creator/joiner) AND the key-changed-before-settle
    ordering must be re-checked under id-roles. Until then, do NOT route reconnect through the lobby.
  - **return-to-lobby (general)** *(deferred)* — after a FINISHED or aborted 1:1 session (transfer done,
    SAS mismatch, peer left), return to the lobby to pick another peer without re-joining. Only the
    narrow busy-bounce return is built (pre-connection); a post-`connected` return needs channel/transfer
    teardown + a fresh SAS state and is not wired.
  - ✅ **link/qr lobby-race resistance — DONE** (pre-deploy; same fix as "High-entropy rendezvous for
    link/QR" below — ONE change closes both). link/qr no longer share the 4-digit lobby: they rendezvous
    via their own high-entropy **token** (`codeType=token`, 128-bit, strictly 1:1 `ONE_TO_ONE_MAX_PEERS
    = 2`). A stray peer can't reach the room (token is unguessable) and a forwarded link still reaches a
    SINGLE receiver (a 2nd joiner is bounced 4002) — interloper-resistance is now STRUCTURAL, not a
    `peers[0]` heuristic. See CLAUDE.md § link/qr method + § Signaling server.
- ✅ **TURN relay + Reliable / Max-privacy mode + relax-retry (6d)** — *DONE*.
  - ✅ **Server side — DONE (this pass).** The signaling server answers a **`turn-request`** frame with
    short-lived HMAC coturn credentials (`use-auth-secret` / REST scheme): `username` = a future
    unix-expiry, `credential = base64(HMAC-SHA1(TURN_SECRET, username))`; reply
    `{type:'turn-credentials', urls, username, credential, ttl}`. Gated on `cfg.managed` (filetransfer
    only). **`TURN_SECRET` is shared with coturn's `static-auth-secret` and NEVER sent to the client**
    — only the derived per-session credential. Graceful when unconfigured: empty `TURN_SECRET` →
    empty `urls` → the client stays direct-only. Bounded by the existing per-socket message rate-limit
    (no extra limiter). Env: `TURN_SECRET` / `TURN_URLS` (comma-separated → array) / `TURN_CRED_TTL_S`
    (default 3600). coturn deployed SEPARATELY — `deploy/coturn.conf.example` (relay-port range +
    firewall, `user-quota` / `total-quota` / `max-bps`, anti-SSRF `no-multicast-peers` /
    `no-loopback-peers` / `denied-peer-ip` on RFC1918 + link-local, `fingerprint`, `no-cli`).
    `tests/integration/turn-credentials.test.ts`. (See CLAUDE.md § Signaling server / TURN credentials.)
  - ✅ **Client side — DONE (this pass).** The home **PrivacyToggle is now functional** (persisted pref
    `hushsend.privacy`, default **Max-privacy**, pushed into the core via `<PrivacyModeSync>` →
    `SessionController.setPrivacyMode`). It drives `iceServers` (`src/core/iceServers.ts`
    `buildIceServers`, build-time `VITE_STUN_URLS` STUN config): **Max-privacy = STUN-only, NEVER
    requests creds** (direct-only, peer sees your IP); **Reliable = STUN + TURN**, with creds fetched
    via `SignalingClient.requestTurnCredentials` (`turn-request` → zod-validated `turn-credentials`)
    AFTER `welcome` and BEFORE the PC (kicked off at `beginPairing`, awaited in `startPeer`). **Empty
    urls (relay undeployed) ⇒ stay direct-only** (username/credential ignored — keyed off `urls.length`).
    Unit: `iceServers.test.ts`; e2e: `tests/e2e/privacy.spec.ts` (toggle renders/flips/default-max,
    Max-privacy connects directly with no TURN, Reliable assembles the TURN iceServer from fetched
    creds — relay itself not run). See CLAUDE.md § Privacy mode + ICE.
  - ✅ **relax-retry — STRICT model, DONE (this pass).** Max-privacy NEVER relays without consent: the
    PeerConnection DROPS the peer's `typ relay` ICE candidates until this side relaxes
    (`src/core/relax.ts` `isRelayCandidate`/`shouldDropCandidate`, filtered in `PeerConnection.addIce`),
    so we can't be relayed locally OR via the peer without consent. A LIVE Max-privacy ICE failure (or a
    peer's relax) OFFERS a relay escalation (`connection.relax = {available, localRelaxed, peerRelaxed}`;
    status stays `pairing`, NO new FSM state) on `ConnectingScreen` rather than hard-failing. Accept
    (`relaxConnection`): fetch creds (the B1 fetch, forced) + `setConfiguration(STUN+TURN)` + stop
    filtering + send the `relax` signaling frame; decline → `failed`. The relay forms ONLY once BOTH
    relax — self-enforcing bilateral (the other side keeps filtering until it does) — and only the
    per-pairing INITIATOR `restartIce()`s (`shouldRestartForRelay`). The restart is on the EXISTING PC
    (`setConfiguration` + `createOffer({iceRestart:true})`) — no teardown, no new cert → DTLS fingerprint
    + SAS binding preserved; SAS is confirmed once, over the relay (ICE fails before the DataChannel).
    `?forceIceFail=1` DEV knob drives it in e2e. `relax.test.ts` + `connectionSlice.test.ts` +
    `tests/e2e/relax.spec.ts`; a relay actually carrying bytes needs coturn → verified at deploy. See
    CLAUDE.md § Privacy mode + ICE / relax-retry.
- 🚧 **Cross-browser pass (6e)** — the **no-device parts are DONE** (this pass); the real-device
  test remains (post-deploy).
  - ✅ **Self-hosted QR-scan WASM — DONE.** `barcode-detector@3.2.0`'s default `locateFile` fetched
    `zxing_reader.wasm` from `fastly.jsdelivr.net` at scan time (iOS/Firefox fallback) — a privacy
    (client-IP leak) + supply-chain (executable WASM from an uncontrolled host) risk. Now vendored:
    `src/ui/zxingWasm.ts` `createQrDetector` imports the `.wasm` as a Vite `?url` asset
    (`zxing-wasm/reader/zxing_reader.wasm?url` → fingerprinted into `dist/assets`, same-origin) and
    `setZXingModuleOverrides({ locateFile })` points the loader at it BEFORE the detector
    instantiates. Lazy load preserved (only the URL string is bundled; ponyfill JS + WASM still load
    only on a real scan, now from `'self'`). `zxing-wasm@3.1.0` pinned as a direct dep (exact, matches
    barcode-detector's inlined copy). CSP `connect-src` dropped the CDN → `'self' wss://<host>` only
    (`'wasm-unsafe-eval'` stays — it permits compiling the WASM, not fetching it). Unit:
    `zxingWasm.test.ts`. (`nginx.conf.example` + `DEPLOY.md` CSP updated.)
  - ✅ **Feature-detection / graceful-degradation review — DONE.** Walked every browser-API path and
    confirmed a clean fallback/message when the API is absent: QR-scan (`BarcodeDetector` →
    self-hosted zxing ponyfill; `getUserMedia` denied/absent → paste-the-link fallback, hardened with
    an explicit `navigator.mediaDevices?.getUserMedia` guard so an insecure context can't throw on
    the property access); file save (`showSaveFilePicker` absent → RAM Blob fallback + size cap,
    rejected BEFORE accept); `navigator.locks` (cross-tab keystore lock → degrade to a direct call);
    `navigator.share` (ShareButton renders null when absent — Copy remains); `crypto.subtle` Ed25519
    (→ noble fallback); `indexedDB` (open rejects, treated non-fatal). No working logic rewritten —
    only the missing mediaDevices guard added.
  - **Remaining (real devices, post-deploy):** transport + FSA→Blob caps + QR scan + camera
    permissions on actual iOS Safari / Firefox.
- 🚧 **Deployment behind nginx (6f)** — **deploy-prep artifacts DONE; the live deploy is ops.** Built +
  committed: `deploy/nginx.conf.example` (TLS, 80→443, SPA `try_files $uri /index.html`, the `/ws`
  proxy with `X-Real-IP` + WS-upgrade + raised `proxy_read_timeout`, HSTS / build-tuned **CSP**
  [`'wasm-unsafe-eval'` for the QR-scan WASM, now **self-hosted** (step 6e) so `connect-src` lists no
  CDN] / `Permissions-Policy camera=(self)`), `server/.env.example` (all server env + criticality notes),
  `deploy/coturn.conf.example` (from 6d), `deploy/DEPLOY.md` (step-by-step + inline gotchas). Only code
  change: an additive startup `[config]` summary log (no secrets) in `signaling-server.js`. Consolidated
  env reference in CLAUDE.md § Deployment / configuration. **Remaining (ops, not code):** run
  nginx/coturn/DNS/TLS on real hosts; **verify the CSP against the deployed build (esp. QR scan on a
  non-Chromium browser — overlaps 6e).** The X-Real-IP/TRUST_PROXY pairing is documented in all three
  artifacts; the footgun it guards against:
  WS proxy to 127.0.0.1:8080, TLS certs, and **nginx MUST set
  `proxy_set_header X-Real-IP $remote_addr;`** (plus run the server with `TRUST_PROXY=1`). This is not
  optional plumbing — without it `clientIp()` falls back to `socket.remoteAddress`, which (nginx on the
  same host) is always loopback `127.0.0.1`, so **every** client looks like one loopback IP:
  - `MAX_CONNS_PER_IP` then bounds ALL clients TOGETHER under a single per-IP bucket (a global cap, not
    per-client);
  - the per-IP create/join **rate-limit is effectively disabled** (loopback is exempt by design — see
    `isLoopback`), so the 4011 anti-enumeration limiter never fires.
  Even with X-Real-IP set, clients behind a **shared NAT** (one public IP) divide `IP_RL_MAX` / window
  among everyone behind it → a busy office could see a spurious 4011. Tune `IP_RL_MAX` for the deploy;
  this is defense-in-depth only (worst case is a retry — SAS / key-confirmation are what stop a MITM).

## Security / correctness follow-ups (small)
- ✅ **SAS fail-closed on unset role — DONE** (folded into the mesh-lobby fix). The SAS role is no
  longer a UI default — it is computed PER PAIRING from the two readable ids (`src/core/sasRole.ts`
  `sasRoleFor`: lexicographically smaller id reads), projected as `connection.sasRole`. When the role
  is unresolved (`null` — a missing id), `SasScreen` renders an explicit **"restart verification"**
  screen, NEVER a functional blind picker. This both fixes the joiner↔joiner "two pickers" lobby case
  and closes the original fail-closed concern. (`sasRole.test.ts`; e2e resolves the reader by id.)
- ✅ **High-entropy rendezvous for link/QR — DONE** (pre-deploy). The 4-digit room is replaced by a
  128-bit CSPRNG **token** (`codeType=token`) carried in the link (no UX cost — the link already
  carries the rendezvous). Server: third codeType beside the 4-digit room + word — `tokenCode`
  (allocator = `randomBytes(16)` → base64url, 22 chars; validator = strict `TOKEN_RE`), strictly 1:1
  (`ONE_TO_ONE_MAX_PEERS = 2`, like words), managed with a from-create TTL (`TOKEN_ROOM_TTL_MS`).
  Client: link/qr request `codeType=token`; `buildLinkUrl`/`parseLink` build/validate `<token>.<S>`
  (`RENDEZVOUS_TOKEN_BYTES`); S + the key-confirmation-over-S auth flow are UNCHANGED. Eliminates
  4-digit squatting/enumeration for link/QR — resistance is now structural. room stays 4-digit, words
  stays `word`. Tests: `room-server.test.ts` (token alloc / validator / 1:1 cap), `link.test.ts` +
  `qr.test.ts` (token round-trip), `link.spec.ts` (link/qr e2e over token rendezvous). This is the
  SAME fix as "link/qr lobby-race resistance" above. (See CLAUDE.md § link/qr method + § Signaling server.)

## Nice-to-have / future
- **stark-ui-kit componentization** — once a 2nd consumer exists (or the screen set is final),
  promote the generic primitives (button, input, toggle, pill, hairline-card, sheet) from the app's
  `.hs-*` layer into the kit as real React components (props + a11y + tests). Domain pieces (SAS
  cards, word slots, code display, transfer, key-changed banner) stay app-local. Don't extract
  prematurely.
- ✅ **Transfer-history privacy — DONE** (pre-deploy). Transfer history is no longer persisted: it
  moved from a localStorage record (`persistence.ts`, now deleted) to a SESSION-ONLY in-memory Redux
  slice (`src/store/historySlice.ts`), so file names leave no local trail — the history is gone on
  reload / tab close. localStorage now holds ONLY prefs (lang/theme/privacy mode, `prefs.tsx`);
  keystore pins (IndexedDB) are untouched. "Forget" clears the pins + the in-memory history. (See
  CLAUDE.md § Current state.)

## Caveats (not scheduled — see CLAUDE.md § Known residuals)
pairingId relay-linkability · dual-pin if a keystore is wiped.

(✅ **Pre-SAS pairing deadline firing-direction — now tested** (pre-deploy cleanup): `?stallSasNonce=1`
makes a peer reach the SAS but withhold its nonce reveal, `?preSasTimeoutMs=N` shrinks the pre-SAS
deadline (both DEV-only / tree-shaken), and `tests/e2e/room-sas.spec.ts` asserts the other side fails
at the deadline rather than hanging. The pre-SAS deadline is also re-armed when the relax relay offer
surfaces. See CLAUDE.md § room/SAS Timeouts + § Privacy mode + ICE / relax-retry.)
