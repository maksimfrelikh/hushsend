# hushsend — backlog (remaining & deferred work)

Remaining and deferred work, plus a done-log of the completed hardening. Current built state +
implementation caveats live in CLAUDE.md (§ Current state, § Known residuals). Update this file in
the same pass as CLAUDE.md when items land.

## Step 6 — Hardening (6a–6d + 6f DONE; 6e real-device pass remaining)
- ✅ **Server cap/TTL/rate-limit for `filetransfer` rooms — DONE (6a)**. The `filetransfer` app is a
  `managed` app, which gives all its rooms (the 4-digit **room**, **word**, and link/QR **token**) a TTL-until-connected that
  frees the code (expiry → 4010 close + later join → 4009 `'room not found'`; the live P2P channel
  survives a post-`connected` signaling close) and a per-IP create/join rate-limit (`IP_RL_MAX = 60` /
  `IP_RL_WINDOW_MS = 60000`; over → 4011 `'too many attempts'`, loopback-exempt). SAS / key-confirmation
  defeat a MITM regardless — this is abuse hygiene. `tests/integration/room-server.test.ts`.
  - **Correction (later pass):** the **seat cap is codeType-dependent, not the `managed` flag**. The
    4-digit **room** rendezvous is a **mesh LOBBY** (`FILETRANSFER_MAX_PEERS`, default 8) where
    several peers see each other and each picks whom to pair 1:1 with (incl. joiner↔joiner); the
    **words** AND link/QR **token** rendezvous stay strictly 1:1 (`ONE_TO_ONE_MAX_PEERS = 2` — words
    to serialize secret-word guessing, token because a one-time link/QR has a single receiver).
    (link/QR moved off the 4-digit room to their own high-entropy token pre-deploy — see below.)
    The 4-digit TTL is now an **idle timeout** (re-armed on each join); the 1:1 words/token TTLs stay
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
  - **close the signaling socket on connect for the mesh (room) method** *(deferred — needs "seal
    room")* — the 1:1 methods (words/link/qr) now CLOSE their own signaling socket on `connected` so the
    untrusted server learns no session duration (DONE — see below + CLAUDE.md § Signaling WS lifecycle).
    The **room** method does NOT, because its socket is a shared LOBBY: it carries the live roster and
    other peers' `pair-request`/`busy` picks, and a paired pair may want to return to the lobby (the
    deferred item above). Closing it would need a **"seal room"** step — the pair tells the server (and/or
    the lobby) it has finished pairing, so the server can stop routing to it / free its seat without
    treating the close as a generic `peer-left` for the other lobby members, and the FSM gains a defined
    "in a 1:1 inside a still-live lobby" notion. Until that lands, the room socket stays open
    post-`connected` (the server still learns the room's session duration for SAS pairs). 1:1 is the
    common case and is covered; mesh is the residual. (When built, coordinate with return-to-lobby +
    reconnect-in-lobby, which all touch the same lobby/seat lifecycle.)
  - ✅ **link/qr lobby-race resistance — DONE** (pre-deploy; same fix as "High-entropy rendezvous for
    link/QR" below — ONE change closes both). link/qr no longer share the 4-digit lobby: they rendezvous
    via their own high-entropy **token** (`codeType=token`, 128-bit, strictly 1:1 `ONE_TO_ONE_MAX_PEERS
    = 2`). A stray peer can't reach the room (token is unguessable) and a forwarded link still reaches a
    SINGLE receiver (a 2nd joiner is bounced 4002) — interloper-resistance is now STRUCTURAL, not a
    `peers[0]` heuristic. See CLAUDE.md § link/qr method + § Signaling server.
- ✅ **TURN relay + Reliable / Max-privacy (STRICT) mode (6d)** — *DONE*.
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
  - ✅ **Max-privacy STRICT model — DONE (this pass; supersedes the earlier relax-retry).** Max-privacy
    NEVER relays — there is NO consent escalation. The PeerConnection ALWAYS drops the peer's `typ relay`
    ICE candidates in Max-privacy (`src/core/relax.ts` `isRelayCandidate`/`shouldDropCandidate`, filtered
    in `PeerConnection.addIce`) and never requests TURN, so a direct connection that can't come up is
    **terminal**: `onIceFailed` → `failDirect` → the existing `failed` state (no new FSM state) with a
    switch-to-Reliable hint on `FailedScreen` (`directFailHint`, EN/RU; `direct-fail-hint` testid).
    **resolved-by-removal:** the relax-offer, `connection.relax` projection + `relaxChanged`, the `relax`
    signaling frame, the bilateral `relaxConnection`/`declineRelax`/`onRelaxSignal`/`maybeRestartForRelay`
    logic, and `pc.setConfiguration`/`restartIce`-over-relay were all DELETED. This **closes the whole
    class of asymmetric relax bugs** — including the suspected **Firefox mixed-privacy hang**, whose
    failure mode (one side half-relaxed while the other filters) is gone by design: a Max-privacy side
    that can't go direct now fails fast. `relax.ts` is reduced to the relay-candidate filter. Reliable is
    unchanged (STUN + TURN, auto-relay on a direct failure). `?forceIceFail=1` DEV knob drives the e2e.
    `relax.test.ts` (filter only) + `tests/e2e/relax.spec.ts` (Max-privacy ICE failure → `failed` + hint,
    no offer, no hang). See CLAUDE.md § Privacy mode + ICE / Max-privacy strict model.
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
- ✅ **Deployment behind nginx (6f) — LIVE (deployed 2026-06-20 at hushsend.frelikh.dev; see DEPLOY.md § 0).**
  On `frelikhmax.fvds.ru` (Ubuntu 24.04, nginx 1.24, Node 24/nvm): frontend built on-server →
  `/var/www/hushsend/dist`; signaling = the SEPARATE universal repo `~/projects/hush-signaling-server`
  under systemd `hushsend-signaling` (127.0.0.1:8080); **coturn on the SAME host, `turn:`-only on :3478**
  (no `turns:`); cert via certbot webroot. External smoke green (headers/CSP, /health, `.wasm`→
  `application/wasm`, /ws→426, SPA fallback); **remaining: in-browser P2P/SAS/transfer + cross-network
  relay**. Template fix during deploy: `http2 on;` → `listen … ssl http2;` (nginx 1.24 lacks the 1.25+
  directive). Original deploy-prep artifacts Built +
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
- ✅ **Close the signaling socket on connect for the 1:1 methods — DONE.** For `words` / `link` / `qr`
  the client closes its OWN signaling socket the instant it reaches an authenticated `connected`
  (`SessionController.closeSignalingAfterConnect`, a side-effect on entering `connected` — no new FSM
  state, gated to the `connected` success branch so failure paths are untouched). By then signaling has
  no job left (ICE/SDP exchanged, key-confirmation + enrollment ride the DataChannel), so the **untrusted
  server learns no session duration** — it sees only the short pairing window, then both peers vanish.
  Each side closes independently (no coordinating signal — key-confirmation is mutual). **Liveness was
  decoupled from room presence:** the `peer-left` each close generates on the other side must not drop /
  fail / bounce a connected (or about-to-be-connected) peer, so `src/core/livenessGate.ts`
  `peerLeftAbortsPairing(established, channelOpen)` aborts a 1:1 pairing ONLY before the DataChannel
  transport is up (after that, liveness = DataChannel/ICE, and a real abort is caught by
  `onChannelClose`). **Guess-protection (words) is NOT weakened** — every actual guess is counted by the
  confirmation-mismatch / channel-close paths; `peer-left` is the sole counter only pre-transport, which
  the gate still catches. Unit: `livenessGate.test.ts` (arm/disarm boundary). e2e: `tests/e2e/ws-close.spec.ts`
  (link + words — supersedes the old `words-ttl.spec.ts`, since the client now closes proactively rather
  than waiting for the server TTL). **Mesh (room) close is deferred** — needs "seal room" (see Step 6
  follow-ups above). See CLAUDE.md § Signaling WS lifecycle.
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
- **coturn `turns:` (TURN over TLS on :5349)** *(deferred — agreed at deploy 2026-06-20)*. The live
  deploy runs coturn **`turn:`-only on :3478** (no TLS, `no-tls`/`no-dtls`). Strict corporate networks
  that only allow outbound 443/TLS can't reach a plain `turn:`/STUN relay; for those, enable `turns:`:
  issue a cert for `turn.hushsend.frelikh.dev`, set `cert`/`pkey` + `tls-listening-port=5349` in
  `/etc/turnserver.conf` (and drop `no-tls`/`no-dtls`), open `5349/tcp` in ufw, and append the
  `turns:turn.hushsend.frelikh.dev:5349` URI to the server's `TURN_URLS`. No client/build change — the
  client uses whatever URIs the signaling server hands out. (Until then Reliable mode falls back to
  `turn:`/3478, which covers most networks.)
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
at the deadline rather than hanging. See CLAUDE.md § room/SAS Timeouts.)

## Reconnect UX — lobby-pick reconnect + entry-point ergonomics (PARTIALLY DONE; observed in the manual test pass)

Expands the deferred **reconnect-in-lobby** item (Step 6 / 6c follow-ups). The manual cross-browser
pass confirmed reconnect works correctly via its intended path (one side `reconnect` [create], the
other `reconnect-by-code`), and surfaced two concrete failure modes from how the entry points
combine. **The two LOW-RISK parts are now DONE** (interim liveness deadline + entry-point ergonomics —
see ✅ items under "What done looks like"); the SECURITY-SENSITIVE parts (lobby-pick reconnect +
reconnect role create/join → id-order) remain **deferred (post-audit)**.

The two failure modes (both now fail-closed / less likely, not yet fully fixed):

- **Mismatched entry → permanent "agreeing on keys" hang.** If one side takes the **reconnect** path
  (pin-based auto-pair, protocol role create/join, NO SAS) while the other joins the same code via
  the **regular room join** (→ lobby → manual pick → always a *fresh* SAS, role by id-order), the two
  run *different* handshakes over the same channel: one sends `reconnect-init` and waits for
  `reconnect-proof`, the other sends `pair-request` / `sas-commit`. SDP/DTLS negotiate fine
  (fingerprints exchange), but the app-level key step never converges → both sit in `pairing`
  ("agreeing on keys") indefinitely. Note there is **no timeout-to-failed in this combination** — the
  pre-SAS deadline guards the SAS side, not a stalled `reconnect-init`, so the mismatch hangs forever
  instead of failing.
- **Both sides press `reconnect` → two separate rooms, no rendezvous.** `reconnect` is
  reconnect-**create** (allocates its own room/code); pressing it on both peers makes two independent
  rooms that never meet. Same create/join asymmetry as every method, but the single "reconnect" label
  reads like "reconnect to my peer" rather than "open a reconnect room" — the create-vs-join split for
  reconnect is non-obvious.

**What "done" looks like:**
- A **lobby pick** should detect that the target peer is already pinned (`pairingId → key` present on
  both sides) and route that pair through **reconnect-auth (no SAS)** instead of a fresh SAS — i.e.
  reconnect becomes reachable *from the mesh lobby*, not only via the separate by-code path. (This is
  the original reconnect-in-lobby goal.) ***(still deferred — see "Deferred (post-audit)" below.)***
- **The reconnect PROTOCOL role must move from create/join to id-order.** ***(still deferred — see
  "Deferred (post-audit)" below.)***
- ✅ **Interim hardening — liveness deadline on the reconnect wait — DONE (this pass).** The reconnect
  re-auth wait (reconnect-init → reconnect-proof/fallback) now has its OWN liveness deadline,
  INDEPENDENT of the SAS pre-timer (which guards the SAS commit-reveal, not a stalled reconnect). A
  mismatched-entry pair — one side on reconnect, the other on the plain-SAS lobby path (a fresh SAS,
  never a reconnect response) — now ends in **`failed`** instead of an infinite "agreeing on keys".
  Prod-fixed at the same **120 s** default as the pre-SAS deadline, read through a DEV-only override
  (`reconnectTimeoutMs()` ← `?reconnectTimeoutMs=N` / `window.__HUSHSEND_RECONNECT_TIMEOUT_MS__`,
  tree-shaken in prod) for cheap e2e. Armed at pairing start (`SessionController.beginPairing`,
  reconnect path only); cleared on settle (`settleReconnect`) / fallback (`reconnectFallback`) / fail
  (`failReconnect`) / dispose (and a Max-privacy ICE failure clears it via `failDirect`; `failSas`
  also cross-closes it, so a parallel reconnect timer can't fire a second teardown when reconnect
  falls back to SAS); expiry
  → `failReconnect` (→ `failed` + close), the SAME terminal path as a key-change / MITM. **Fail-closed,
  liveness only — the two-check verify, the reconnect role (create/join), the wire frames, and the
  crypto are UNTOUCHED.** DEV knob `?stallReconnect=1` (withholds the reconnect-proof) drives the
  firing e2e (`tests/e2e/reconnect.spec.ts` — "reconnect liveness deadline FIRES"). The optional
  fail-fast/hint on the OTHER side (an already-pinned peer joining via the fresh-SAS lobby path) was
  NOT done — it is nontrivial (the plain-SAS side has no reconnect state to key off) and the deadline
  already removes the hang. (See CLAUDE.md § Crypto / Reconnect.)
- ✅ **Entry-point ergonomics — DONE (this pass).** The reconnect create-vs-join split is now explicit
  on the home screen: a **"Reconnect a device"** section with a one-line split hint ("one side starts +
  shares the code, the other joins with it; both starting opens two rooms"), then two clearly-labelled
  affordances — **Start** (tap a recent device → `createReconnectSession` opens a room + shows a code)
  vs **Join — enter the code the other side is showing** (`joinReconnectSession`). EN/RU. UI-only — the
  reconnect protocol / roles / wire format are unchanged; testids (`create-reconnect-btn` /
  `reconnect-input` / `join-reconnect-btn`) are stable. This makes "reconnect on both" and "reconnect +
  regular join" no longer easy mistakes.

**Deferred (post-audit) — security-sensitive, NOT in this pass:** lobby-pick reconnect AND moving the
reconnect PROTOCOL role from create/join to id-order. The role move changes the **verifier-first
ordering** the two-check **key-changed-vs-MITM** verify depends on (today create/join fixes the
verifier-first side so a key change is caught before a forger can settle); re-deriving it from the
readable ids needs the key-changed-before-settle ordering re-verified under id-roles first. Until that
audit lands, the lobby keeps doing a fresh SAS, reconnect stays the separate by-code auto-pair path,
and the two **must not be mixed** — but the mix no longer HANGS (it now fails closed, per the liveness
deadline above), and the entry-point ergonomics make the mix far less likely.

## UX bugs — found in the manual test pass (Phase 1)

- ✅ **Recent-devices / reconnect list accumulates duplicate rows for the same peer — DONE
  (display-dedup).** The list (read from the keystore via `listPins()`) was keyed by `pairingId`, but
  every *fresh* pairing (room+SAS / words / link/qr) runs enrollment, which mints a NEW
  key-independent `pairingId`. So pairing the same two devices repeatedly — and the dual-pin-after-wipe
  case — left several pins with **distinct pairingIds but the same `peerPublicKey`** → one row per pin.
  **Fixed:** `src/ui/recentDevices.ts` now dedups the list by **`peerPublicKey`** (the stable identity)
  via `dedupeByPeerKey` — one row per distinct peer key, keeping the **most-recent pin** (by
  `firstSeen`), whose `pairingId` drives the reconnect tap (both sides pinned it at the freshest
  enrollment → valid) and whose `label`/`firstSeen` show in the row; rows ordered newest-first. The
  home reconnect button now passes the selected row's `pairingId` to `createReconnectSession(pairingId?)`
  (UI selection only — the reconnect protocol / wire format / create-join role are unchanged).
  `src/ui/recentDevices.test.ts` (in-memory keystore backend). This is a **display** fix; pins are NOT
  removed from the keystore.
  - **keystore-GC / pin-merge** *(still deferred)* — collapsing the redundant pins to one canonical pin
    per peer in the keystore itself (so the dual-pin caveat stops accumulating dead pins) is NOT done;
    the dedup is display-only. See § Caveats (dual-pin).

- ✅ **Post-transfer "send another" doesn't reset between sends — DONE.** The done screen now parks on
  its terminal plaque with an explicit **"New transfer"** button (`new-transfer-btn`, reusing the
  existing `newTransfer` string); the drop zone shows ONLY in a clean idle state, so a finished/aborted
  transfer never lingers alongside a fresh pick. Each new send starts from a clean slate — `sendFiles`
  already dispatches `transferActions.reset()`, and the "New transfer" button dispatches it (plus clears
  the local file pick) on the way back to ready-to-send, without touching the connection. In-memory
  history is left **bounded** (`HISTORY_CAP = 12`, oldest dropped) and **clearable** (`forgotten`, wired
  to the home "forget" alongside the pin reset) — both already present, kept and now unit-tested. The
  per-send reset touches ONLY the transfer slice — it does NOT clear history records. Session-only
  history semantics unchanged (in-memory, gone on reload). `src/store/transferSlice.test.ts` +
  `src/store/historySlice.test.ts`.

## Security audit — scrutinize before public launch

Surface area for an independent security audit before the public launch — pointers to the
security-sensitive decisions already made, gathered in one place (not a restatement; each links to
where the design + rationale live).

- [ ] **(a) Reconnect role create/join → id-order (deferred).** The reconnect PROTOCOL role stays
  create/join, which fixes the **verifier-first ordering** the two-check **key-changed-vs-MITM** verify
  depends on (a key change is caught before a forger can settle). Before any move to id-order,
  re-verify the **key-changed-before-settle** property still holds under id-roles.
  (→ § Reconnect UX / "Deferred (post-audit)" above + CLAUDE.md § Per-pairing role + § Crypto / Reconnect.)
- [ ] **(b) Guess-narrowing of `peerLeftAbortsPairing` (WS-close).** Confirm the narrowing — a
  `peer-left` aborts a 1:1 pairing ONLY pre-transport (`!established && !channelOpen`); a
  post-channel-open `peer-left` is ignored — does NOT weaken the words anti-bruteforce bound. The
  argument: the authoritative guess counter is confirmation-mismatch (`onConfirmFailure`) /
  channel-close (both untouched); `peer-left` was the sole counter only before the channel ever opened.
  (→ § Signaling WS lifecycle.)
- [ ] **(c) Strict relay filter.** Confirm `isRelayCandidate` / `shouldDropCandidate` (Max-privacy
  ALWAYS drops the peer's `typ relay` candidates AND never requests TURN) genuinely prevents a relay
  path from completing on our side. (→ CLAUDE.md § Privacy mode + ICE / Max-privacy strict model.)
- [ ] **(d) Crypto / protocol core.** CPace (draft-irtf-cfrg-cpace-21, ristretto255), SAS
  commit-before-reveal + DTLS-fingerprint binding, key-confirmation channel binding (HMAC over the
  lexicographically sorted DTLS fingerprints), TOFU enrollment, reconnect two-check verify, and the
  `lv`-canonicalization + per-method domain separation. (→ CLAUDE.md § Crypto.)
- [ ] **(e) Known residuals.** `pairingId` relay-linkability across reconnects; dual-pin accumulation
  after a keystore wipe. (→ CLAUDE.md § Known residuals / deferred + § Caveats above.)
- [ ] **(f) Deploy footgun.** `X-Real-IP` / `TRUST_PROXY` pairing (`clientIp()` → per-IP caps + the
  4011 anti-enumeration limiter); shared-NAT `IP_RL_MAX` tuning. (→ CLAUDE.md § Deployment /
  configuration + Step 6 / 6f above.)