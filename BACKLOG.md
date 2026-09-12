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
  - ✅ **close the signaling socket on connect for the room method — DONE (per-pair, no "seal room"
    needed).** Research found the "seal room" step was never required: a room is **N independent 1:1
    pairs** over a shared lobby socket and **re-pairing on the fly is not a thing**, so once two peers
    raise their 1:1 channel the socket has no further job *for them* — a connected room/SAS pair just
    closes its OWN socket like the 1:1 methods (`closeSignalingAfterConnect` now fires from
    `trySasSettle`; the room exclusion in its guard was lifted — and reconnect's went the same way on
    2026-09-12, so no method is exempt now). The close is a
    **WS close ONLY** — no room-destroy / leave frame — so the server runs `peers.delete(self)` +
    broadcasts a benign `peer-left` to the remaining members (`signaling-server.js:422-436`): the room
    **survives** (deleted only when empty), and **unrelated pairs are untouched** (their liveness is
    their own DataChannel/ICE; `onPeerLeft` returns early on an id ≠ `this.peerId` after the roster
    update). Correctness prerequisite landed in the same pass: the **SAS `onPeerLeft` branch was migrated
    to the `peerLeftAbortsPairing(established, channelOpen)` gate** (was a bare `!established`), so the
    cross-channel race — a peer's post-connect `peer-left` racing its DataChannel `sas-confirm` — can no
    longer tear down a pair where both humans already confirmed. Unit:
    `SessionController.sasPeerLeft.test.ts`; e2e green (`room-sas.spec.ts` / `lobby.spec.ts` /
    `ws-close.spec.ts`). See CLAUDE.md § Signaling WS lifecycle.
    - **Residuals (do NOT block per-pair close):**
      - ✅ **(a) reconnect now closes its socket too — DONE 2026-09-12.** This was deferred until
        reconnect-in-lobby landed, but the audit showed waiting had a cost: reconnect was the ONE
        pairing holding its socket for the whole session, which told the untrusted server "these two
        have met before" AND the session duration, purely from behaviour. Both parts landed together,
        because the close is only safe with the gate: the reconnect `onPeerLeft` branch moved from a
        bare `!this.established` to `peerLeftAbortsPairing(established, channelOpen)` (the two sides
        settle independently, so our own close's `peer-left` would otherwise abort a peer mid-settle),
        and `settleReconnect` now calls `closeSignalingAfterConnect`. Unit:
        `SessionController.sasPeerLeft.test.ts` (closes + both sides of the gate); e2e:
        `ws-close.spec.ts` (reconnect connects, both sockets close, neither drops, and a transfer
        started afterwards arrives intact). Independent of reconnect-in-lobby, which stays deferred.
      - **(b) "pick a leaving peer → busy vs timeout" UX nit** — a narrow stale-roster race: picking a
        peer in the instant it is closing its socket (post-connect) can leave the picker briefly waiting
        rather than getting an immediate `busy`. It still fails closed (the pre-SAS/reconnect deadlines
        bound it) — a UX nicety, not a correctness blocker. Folds into return-to-lobby work.
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
  - ✅ **Cross-ENGINE e2e — DONE (2026-09-12).** The suite drove two tabs of the SAME Chromium, which
    proves the protocol but not that two different WebRTC stacks agree — SDP dialects, candidate
    handling, DTLS and SCTP sizing are exactly where engines diverge, and that is what bites on a real
    phone→laptop transfer. `tests/e2e/interop.spec.ts` now launches TWO REAL BROWSERS per test and runs
    the link method plus a 200 KB hashed transfer across **chrome↔firefox, chrome↔webkit and
    firefox↔webkit, in both directions** (5 pairs). All green on the box (chrome 153, firefox 151,
    webkit 26.5). Engines that are not installed SKIP with a printed reason, so a Chrome-only machine
    behaves as before. Required splitting `playwright.config.ts` into two projects: the runner applies
    `use.channel`/`use.launchOptions` even to browsers a test launches itself, so a Chromium channel
    leaked into `firefox.launch()` (`Unsupported firefox channel "chrome"`). Setup on a fresh host:
    `sudo npx playwright install-deps firefox webkit` then `npx playwright install firefox webkit`.
    **Not a substitute for real devices:** Playwright's WebKit is WebKitGTK on Linux, not Safari on
    iOS; no camera, no cellular NAT, no cross-network path.
  - ✅ **Per-engine suite matrix + size ladder — DONE (2026-09-12).** The WHOLE suite now runs under
    each engine as its own Playwright project: **32/32 under each of chromium / firefox / webkit**
    (count as of 2026-09-12 — it was 28/28 when this landed; plus the 4 phone-profile tests and the
    5 interop pairs). Firefox needed no code change at all. **WebKit needed a STUN server on the
    stand, not a code change:** it has no switch to disable mDNS obfuscation of host candidates
    (Chromium has the flag, Firefox the pref), so it only ever emits `<uuid>.local` — measured on the
    box: chrome/firefox emit `192.168.1.19`, webkit emits `<uuid>.local` — and a headless server runs
    no mDNS responder, so two WebKit tabs never pair and every connecting test times out. One STUN
    endpoint gives it a usable `srflx` instead: `E2E_STUN_URLS=stun:127.0.0.1:3478` (loopback keeps it
    on the machine). NOT a product bug — real networks and real iPhones have mDNS; it is a stand
    limitation, now plumbed through `playwright.config.ts`. (The interop pairs passed even before
    this, because the *other* engine advertised a real IP and WebKit's address was learned as
    peer-reflexive — the same RFC 8445 §7.3.1.3 mechanism as the Max-privacy finding, here being
    useful.) `tests/e2e/limits.spec.ts` adds an OPT-IN **size ladder** (`E2E_LIMITS=1`,
    `E2E_LIMITS_SIZES=…`) that lifts our own `__HUSHSEND_MAX_BYTES__` cap so the ENGINE is what fails,
    walks the rungs and stops at the first failure. First run (256/512 MB, wire-time only): **every
    rung OK on every engine** — chromium 6.6/5.0 MB/s, firefox 2.2/3.5, webkit 2.3/3.2. **Do not read
    those rates as a product characteristic:** the box is a throttled mobile Ryzen 5 3500U at ~19%
    clock under load average 10–14, sharing itself with the live services. Bigger rungs (1–2 GB) are
    for a workstation — the receiving tab holds the whole file in RAM.
    **First real ceilings, measured on a Mac (2026-09-12):** Chromium OK at 1 GB (30 MB/s) and 2 GB
    (25 MB/s), **fails at 3 GB** with `download.saveAs: canceled`; WebKit OK to 1.5 GB, **fails at
    1.75 GB**, freezing after ~80%. Both fail at the END, so it is the single-Blob handover that
    collapses, not chunk reception — and neither engine raises a catchable error, it just stops.
    This VALIDATES `MAX_BYTES_DESKTOP_BLOB = 1 GiB` as conservative-on-purpose (see the constant's
    comment): raising it would swap a clear pre-accept refusal for a dead tab. The MOBILE cap
    (512 MiB) remains unmeasured — only a real iOS device can answer that (TESTPLAN § B2).
  - ✅ **Phone-profile e2e — DONE (2026-09-12).** `tests/e2e/mobile.spec.ts` under a new
    `mobile-webkit` project (WebKit + the iPhone 13 device descriptor: iOS UA, 390 px viewport,
    touch). This exists because the receive ceiling is chosen from the **User-Agent**
    (`isMobileUA()` → `MAX_BYTES_MOBILE_BLOB` 512 MB vs the desktop 1 GiB) and that decision had **no
    coverage at any level** — a regex nothing exercised, guarding the one cap we cannot measure on
    hardware yet. Four cases, all green: the phone UA picks the 512 MB ceiling and an oversize file is
    refused **before any byte** with the PHONE cap quoted (a `1.0 GB` there would mean the desktop
    ceiling leaked onto a phone); a normal transfer completes over the Blob path (WebKit has no FSA,
    so nothing needs forcing); nothing overflows 390 px on home / picker / the five-word credential;
    and QR falls back to pasting the link when the camera is unusable. Paired with the first unit
    tests `fileTransfer.ts` has ever had (`fileTransfer.test.ts`, 9 cases: cap by device class, the
    no-navigator fallback, the exact refusal wording `512 MB` / `1.0 GB`, chunk clamping).
    **Not a handset:** Playwright's WebKit is WebKitGTK wearing an iPhone UA — real iOS memory
    pressure, background-tab suspension, camera permissions and cellular NAT stay unproven.
  - **Remaining (real devices, post-deploy):** what only hardware shows — QR scan + camera permissions
    on actual iOS Safari, the FSA→Blob cap on real hardware, everything cross-network (TESTPLAN § C),
    and iOS background-tab suspension mid-transfer (§ F1). Engine-level transport interop is now
    pre-covered headlessly (above).
- ✅ **Deployment behind nginx (6f) — LIVE at hushsend.frelikh.dev (see DEPLOY.md § 0 — the
  as-realized source of truth).** First bring-up 2026-06-20 on a VPS (`frelikhmax.fvds.ru`); **the live
  instance MOVED to the owner's home server 2026-08-16** and that is what runs today (re-verified on the
  box 2026-09-12): Ubuntu 26.04.1, nginx 1.28.3, **Node v22.22.1 system `/usr/bin/node`** (not nvm);
  frontend built on-server → `/var/www/hushsend/dist`; signaling = the SEPARATE universal repo
  `hush-signaling-server` (clone `~/projects/…`, **running copy `/var/www/hush-signaling-server`**) under
  systemd `hushsend-signaling` (127.0.0.1:8080, `User=frelikh`); **coturn on the SAME host, `turn:`-only
  on :3478** (no `turns:`); TLS = the box's **wildcard `*.frelikh.dev`** cert (certbot DNS-01). Home
  server ⇒ **residential NAT**: the router forwards 80/443 tcp + 3478 tcp/udp + relay 49160–49200/udp and
  coturn sets `external-ip=<public>/<lan>`. External smoke green (headers/CSP, /health, `.wasm`→
  `application/wasm`, /ws→426, SPA fallback); **remaining: in-browser P2P/SAS/transfer + cross-network
  relay**. The `http2 on;` → `listen … ssl http2;` template fix was for the VPS's nginx 1.24 and no
  longer applies (1.28 takes both; HTTP/2 is currently off on the vhost — the committed template does
  enable it, so that vhost drifted from the template). Original deploy-prep artifacts built + committed:
  `deploy/nginx.conf.example` (TLS, 80→443, SPA `try_files $uri /index.html`, the `/ws`
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
- ✅ **Dead third-party STUN fallback removed from the bundle — DONE (2026-09-12).** `PeerConnection.ts`
  carried `DEFAULT_ICE_SERVERS = [{urls:'stun:stun.l.google.com:19302'}]` behind
  `this.config.iceServers ?? DEFAULT_ICE_SERVERS`. It was **unreachable** (the sole call site,
  `SessionController.startPeer`, always passes `buildIceServers()`'s array), but it still shipped as a
  literal string in `dist/assets/*.js` — spotted in a bundle audit during the home-server deploy
  (2026-08-16) and left as tech debt. Now `PeerConfig.iceServers` is **required**, the constant is gone,
  and the constructor's `config: PeerConfig = {}` default was dropped with it — so a missing ICE config
  is a compile error instead of a silent fall back to a third party. Behaviour is unchanged (the single
  call site already passed `buildIceServers()`'s array); the only observable difference is the Google
  host string no longer appearing in a built bundle. Verified on the box (Node 22, throwaway copy):
  `tsc --noEmit` clean, eslint clean, **184 vitest tests green** (159 unit + 25 integration).
  ✅ **Verified after the 2026-09-12 redeploy:** `grep -r 'stun.l.google' /var/www/hushsend/dist`
  returns nothing — the live bundle no longer carries the third-party host string.
- ✅ **Close the signaling socket on connect (per-pair: 1:1 methods + room/SAS) — DONE.** For `words` /
  `link` / `qr` AND a connected `room`/SAS pair the client closes its OWN signaling socket the instant it
  reaches an authenticated `connected` (`SessionController.closeSignalingAfterConnect` — from
  `tryVerifyConfirmation` for 1:1 key-confirmation, from `trySasSettle` for room/SAS; a side-effect on
  entering `connected` — no new FSM state, gated to the `connected` success branch so failure paths are
  untouched; **reconnect included since 2026-09-12** — it was the last exemption, see § Security
  audit). By then signaling has no job left (ICE/SDP exchanged, key-confirmation / SAS-confirm +
  enrollment ride the DataChannel), so the **untrusted server
  learns no session duration** — it sees only the short pairing window, then both peers vanish. The close
  is **WS-only** (no room-destroy / leave frame), so for the room mesh the server just drops the leaver +
  notifies the rest — the **room survives** and **unrelated pairs are untouched** (no "seal room" step
  needed: a room is N independent 1:1 pairs). Each side closes independently (no coordinating signal —
  key-confirmation / SAS-confirm is mutual). **Liveness was decoupled from room presence:** the
  `peer-left` each close generates on the other side must not drop / fail / bounce a connected (or
  about-to-be-connected) peer, so `src/core/livenessGate.ts`
  `peerLeftAbortsPairing(established, channelOpen)` aborts a pairing ONLY before the DataChannel transport
  is up (after that, liveness = DataChannel/ICE, and a real abort is caught by `onChannelClose`) — and the
  **SAS `onPeerLeft` branch now uses this same gate** (was a bare `!established`), closing the
  cross-channel `peer-left`-vs-`sas-confirm` race. **Guess-protection (words) is NOT weakened** — every
  actual guess is counted by the confirmation-mismatch / channel-close paths; `peer-left` is the sole
  counter only pre-transport, which the gate still catches; SAS has no guess budget at all. Unit:
  `livenessGate.test.ts` (arm/disarm boundary) + `SessionController.sasPeerLeft.test.ts` (SAS branch gate
  + room per-pair close + reconnect, included since 2026-09-12). e2e: `tests/e2e/ws-close.spec.ts`
  (link + words + reconnect —
  supersedes the old `words-ttl.spec.ts`), with `room-sas.spec.ts` / `lobby.spec.ts` confirming room/SAS
  + lobby behaviour under the per-pair close. See CLAUDE.md § Signaling WS lifecycle.
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

## Ops / housekeeping (small, no devices)
- ✅ **The RUNNING signaling copy is back in sync — VERIFIED 2026-09-12.** `/var/www/hush-signaling-server`
  (what systemd runs) is at `3cfd00a`, the `DEV_ORIGINS` commit, and 0 behind its `origin/main`. Keep
  pulling it whenever the repo moves — drift in the other direction is what once hid a hardcoded dev
  origin for a whole test run. Check it with
  `git -C /var/www/hush-signaling-server rev-list --count HEAD..origin/main` (needs a `git fetch` first);
  a doc-only change needs no `systemctl restart`.
- **HTTP/2 is off on the live vhost** while the committed nginx template enables it (DEPLOY.md § 0).
  A free win, not a fix for anything — but the vhost and the template should agree.
- **Scheduled CI expires on a quiet repo.** GitHub disables `schedule:` workflows after 60 days with
  no commits, which would silently stop the nightly engine matrix. If the repo goes quiet, re-enable
  it (or run the matrix from the Actions tab before a release).
- **Two measurements were left half-finished** when the ladder ran on a Mac: WebKit's 1792 MB rung was
  interrupted by hand before the stall watchdog could name a percentage, and Chromium's ceiling is
  only bracketed as "2 GB OK, 3 GB fails" — the boundary between them is unmeasured. Neither blocks
  anything; both are a single ladder run away (`E2E_LIMITS_SIZES=2304,2560,2816`).

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

- ✅ **Mixed-privacy room never connects (early offer dropped) — DONE.** When the two sides used
  DIFFERENT privacy modes, a **Reliable-mode answerer** is still fetching coturn creds (`ensureTurnReady`)
  inside `startPeer` when the **Max-privacy offerer**'s offer arrives — so `this.peer` is still null and
  the offer hit the `this.peer?.handleSignal` **no-op** in `onSignal` and was **silently dropped**,
  deadlocking the pair. Same latent race in **link/qr** (`startPeer` with no CPace gate to serialize the
  offer); **words** was shielded by its CPace round-trip. **Fixed** by buffering pre-PC WebRTC signals
  (`SessionController.pendingPeerSignals`) and replaying them after the PC is built
  (`flushPendingPeerSignals`), cleared on every teardown/reset/retry (`clearPendingPeerSignals`). The
  buffer is method-agnostic (shared WebRTC tail of `onSignal`) so it closes BOTH the room and the link/qr
  race; the relay filter / strict-privacy / `ensureTurnReady` / `turn-request` are untouched, and the
  "TURN in `iceServers` from the first candidate" invariant holds (`setRemoteDescription` is
  iceServers-independent). Deterministic regression: `SessionController.pendingPeerSignals.test.ts`
  (controllable `ensureTurnReady` + mock PeerConnection). (→ CLAUDE.md § Privacy mode + ICE.)

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

**First internal pass done 2026-09-12** (code review + reasoning, no devices): (a) and (b) hold as
designed — with a sharper argument than the docs carried; **(c) does NOT hold as claimed** — see the
finding below. Three actionable items came out of the pass and are listed after the three checks.
An INDEPENDENT audit is still wanted; this pass only removes the known-unknowns.

- [x] **(a) Reconnect role create/join → id-order (deferred) — REVIEWED 2026-09-12: keep create/join.**
  The safety property itself is role-INDEPENDENT: both branches of `onReconnectProof` run the
  two-check verify BEFORE `settleReconnect`, so no side can reach `established` under an unpinned key
  whatever the roles are. What create/join actually buys is **disclosure ordering**: the initiator
  verifies first and only then sends its own proof, while the responder proves FIRST (it reveals its
  long-term Ed25519 public key + a channel-bound signature before it has verified anything — gated
  only on holding a pin for the announced `pairingId`). Create/join pins the *creator* — the side that
  opened the reconnect room — to the verifier-first seat, so a stranger who reaches the channel never
  extracts the creator's identity key. Under id-order the seat is decided by **server-assigned ids**,
  so ~half the time the creator would prove first to whoever won the join race.
  **The concrete blocker for a move, though, is not crypto but plumbing:** the reconnect initiator is
  also *the side that knows WHICH `pairingId` to reconnect under* (chosen in the UI —
  `createReconnectSession(pairingId?)` reads it from the recent-devices row; the joiner only types a
  code). `pairingRoleFor` would hand the initiator seat to whichever id sorts smaller, which may be
  the side that has no pairingId to announce. So a lobby-pick reconnect needs an **announcer role
  separate from the transcript role**, not a reuse of `pairingRoleFor`. Recorded here so the next
  attempt does not rediscover it.
  (→ § Reconnect UX / "Deferred (post-audit)" + CLAUDE.md § Per-pairing role + § Crypto / Reconnect.)
- [x] **(b) Guess-narrowing of `peerLeftAbortsPairing` (WS-close) — REVIEWED 2026-09-12: CONFIRMED, the
  bound is intact.** The docs' argument (the authoritative counters are confirmation-mismatch and
  channel-close, both untouched) is correct but not the load-bearing one. The bound actually rests on
  a structural invariant that is stronger and easier to check: **the creator returns to "accept another
  joiner" ONLY through `onWordsPairingFailure`, which increments the counter** (one-shot per attempt via
  `attemptResolved`), **and `onPeerJoined` refuses to engage a newcomer while `this.peer || this.role`
  is set**. So an attacker cannot park an unresolved attempt (channel open, signaling socket closed —
  the `peer-left` the narrowing now ignores) and start a second one beside it: the creator is simply
  not accepting anyone until the current attempt resolves, and every resolution counts. Independently,
  the words room TTL is armed from CREATE and never re-armed (`WORD_ROOM_TTL_MS`, 180 s) → `closeRoom`
  → 4010 → `onSignalingClose` fails the client, so wall-clock bounds the attempt count too. Every
  *informative* guess needs the DataChannel (the confirmation tag rides it), and both of its outcomes —
  tag mismatch, or channel close before `established` — are counted regardless of signaling presence.
  (→ § Signaling WS lifecycle.)
- [x] **(c) Strict relay filter — REVIEWED 2026-09-12: did NOT hold as claimed → FIXED the same day.**
  The filter is correct for what it does — it drops every SIGNALLED `typ relay` candidate and never
  requests TURN — but that is not the same as "no relay path can complete on our side", because ICE
  also learns candidates it was never told about. Closed by verifying the path we actually got (see
  the finding below, now DONE). (→ CLAUDE.md § Privacy mode + ICE / Max-privacy strict model.)

### Findings from the 2026-09-12 pass (actionable)

- ✅ **Max-privacy can still be relayed via a PEER-REFLEXIVE candidate (broke the STRICT claim) —
  FIXED 2026-09-12.**
  `shouldDropCandidate` filters candidates we ADD (`PeerConnection.addIce`); it cannot filter the ones
  ICE **learns**. Per RFC 8445 §7.3.1.3 an agent that receives a STUN binding request from a transport
  address matching no known remote candidate creates a **peer-reflexive remote candidate** and runs a
  triggered check against it. A **Reliable** peer relaying through coturn sends its checks FROM the
  relayed address (its TURN permission covers our signalled host/srflx), so our Max-privacy side
  learns that relayed address as `prflx`, pairs with it, and can nominate it — **after** we dropped the
  very same address as `typ relay`. When the direct path works this is harmless (the direct pair has
  higher priority); it bites exactly in the case the strict model exists for — **direct fails, so the
  relayed prflx pair is the only valid one → we connect through the relay instead of failing closed.**
  Reachable in the supported **mixed-privacy** configuration (Max ↔ Reliable); a Max ↔ Max pair has no
  relay anywhere and is unaffected. **Impact is the privacy promise, not confidentiality** — DTLS +
  SAS/PAKE are untouched and no MITM is enabled; what breaks is "Max privacy ⇒ your traffic never
  transits a relay", since the relay (our own coturn, which the threat model treats as UNTRUSTED) then
  sees both IPs, timing and volume, and the user was told that could not happen.
  **Fix as built:** `PeerConnection.addIce` now records the endpoint of every candidate the filter
  drops (`relayCandidateEndpoint` → `endpointKey`, `address|port` — `|` because IPv6 is full of
  colons), and `openChannelUnlessRelayed` runs at DataChannel open **before `onOpen` reaches the
  SessionController**: it reads `pc.getStats()`, resolves the selected pair with
  `selectedRemoteCandidate` (transport `selectedCandidatePairId` → Firefox `selected` →
  nominated+succeeded → succeeded) and refuses via `isForbiddenRemoteCandidate` when the remote is
  typed `relay` OR sits on a dropped endpoint. A refusal reuses the terminal direct-failure path
  (`onIceFailure` → `onIceFailed` → `failDirect` + switch-to-Reliable hint) and `onOpen` never fires,
  so **no byte crosses a relayed path**. Deliberately NOT blanket-rejecting `prflx` (legitimate NAT
  mappings produce it on direct paths), and unavailable/empty stats read as "unknown", never "relay" —
  a missing API must not tear down a working connection. 15 unit tests in `relax.test.ts` cover both
  pure halves (including the IPv6 and Firefox-`ip` shapes). **The REFUSAL branch now has direct e2e
  coverage too (2026-09-12):** `?forceRelayPath=1` (DEV-only, tree-shaken) stubs the gate's VERDICT and
  nothing else, so the refusal, teardown and the reason the user sees are all production code —
  reproducing it for real would need a relaying peer AND a failed direct path, which no loopback test
  can build. `tests/e2e/relax.spec.ts` asserts the refusing side reaches the terminal `failed` with the
  switch-to-Reliable hint, that the peer does not hang, and that NO transfer UI ever renders (no byte
  crossed) — beside a CONTROL case where the same pairing without the knob still authenticates, since
  a gate that refused everything would pass the first test.
  **Still to confirm on real devices (TESTPLAN § C4):** Max ↔ Reliable with the direct path forced to
  fail — the Max side must now land on `failed` + the hint, and `chrome://webrtc-internals` must show
  no relayed selected pair.
  **Residual (open):** the check runs at channel-open only. A mid-session ICE **re-nomination** onto a
  learned relay path (the direct path dies later, the relayed prflx pair takes over) is not re-checked.
  Re-running the check on `iceconnectionstatechange` would cover it, but tearing down a live transfer
  on a stats read needs its own care — left deliberate and documented rather than half-done.
- [ ] **No client-side liveness deadline on the words / link / qr key-confirmation path.** `room`/SAS
  has `armSasTimeout` (pre-SAS + comparison, 120 s) and reconnect has `armReconnectTimeout` (120 s),
  but the 1:1 confirm path has **none**: a peer that opens the DataChannel and then simply goes silent
  (never sends its `confirm` tag) leaves us in `confirming` until the SERVER's from-create room TTL
  (`WORD_ROOM_TTL_MS` / `TOKEN_ROOM_TTL_MS`, 180 s) closes the socket and `onSignalingClose` fails us.
  So liveness on this path is **delegated to the untrusted server** — a server that simply never
  expires the room hangs the client indefinitely, which is precisely the failure mode the reconnect
  deadline was added to remove. Same shape, same fix: arm a 120 s deadline at pairing start on the
  words/link/qr path, cleared on settle/failure. Fail-closed, liveness only — no crypto change.
  (Note this does NOT affect the guessing bound above: it is the *creator* who hangs, and a hung
  creator accepts no further attempts.)
- [ ] **`pairingId` disclosure to whoever wins the reconnect join race.** A reconnect session rendezvous
  over the plain **4-digit** room (`createReconnectSession` → `connect({create:true})`, no codeType), is
  NOT a lobby (`isLobby()` false — sas set AND reconnect set) and therefore **auto-pairs with the first
  peer that joins**. A 4-digit code is enumerable (10⁴, bounded only by `IP_RL_MAX` 60/min/IP), so a
  code-guesser that wins the race and completes the channel receives the initiator's `reconnect-init`
  and learns its **`pairingId`** — a stable per-pair identifier — before any authentication. It cannot
  forge a proof (hard stop / fallback), so this is **linkability + nuisance, not an auth break**.
  **Possible fix:** announce a *blinded* id instead of the raw one — e.g. `HMAC(pairingId, fp_min‖fp_max)`
  — which a peer holding the pin can recognise by recomputation while a stranger learns nothing
  correlatable across sessions. Folds naturally into the reconnect-in-lobby work.

### Doc corrections made in the same pass

- **CLAUDE.md § Known residuals overstated the `pairingId` leak.** It said reconnect "announces it over
  signaling-routed setup, so the untrusted relay can observe 'these two have paired before'". It does
  not: every reconnect frame rides the **DataChannel** (`sendReconnect` → `this.peer.send`), which is
  DTLS-protected, and `pairingId` appears in **no** signaling schema (`src/types/protocol.ts`). The
  relay never sees it. The linkability residual is real but arrives by a **different** route — see the
  next item — and the text has been corrected to say so.
- **The actual reconnect fingerprint the relay CAN see: the post-connect socket close.** Every other
  method closes its own signaling socket the instant it reaches `connected`
  (`closeSignalingAfterConnect`), and **reconnect WAS explicitly excluded** — so a reconnect pair was the
  one pair that *kept its socket open for the whole session*. That handed the untrusted server both
  "this pair is a reconnect (they have paired before)" AND the session duration the close was designed
  to hide. ✅ **FIXED the same day** — reconnect was folded into the per-pair close together with the
  `peerLeftAbortsPairing` gate it required (see residual (a) under § Signaling WS lifecycle).
