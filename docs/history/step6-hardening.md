# Step 6 — hardening (6a–6f), 2026-09

Dated records, moved out of BACKLOG.md on 2026-10-11 when it became a list of open work only. Each entry
was true on its date; the current state is in the living documents (see [README.md](README.md)).

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
  [methods.md](../architecture/methods.md) § Per-pairing role.)
- ✅ **Room lobby UI (core) — DONE (6c)**. The room method no longer auto-pairs: creator + joiners
  land in `awaitingPeer` (`joining → awaitingPeer`, no new state) and see a `LobbyScreen` — the 4-digit
  code + a roster (`connection.roster` = `{id, device, joinedAt}` maintained from welcome/peer-joined/
  peer-left) + a Connect button per peer. Pick → `pair-request`; the smaller id offers (per-pairing
  role 6b); glare/dedup handled; **busy-reject** returns the picker to the lobby with a clear notice (no
  hang). Works for ANY pair incl. joiner↔joiner. Signaling protocol grew: `welcome.peers` + `peer-joined`
  now carry `{id, device, joinedAt}` (coarse client device label, server-capped ≤32 + server-stamped
  joinedAt; the `device` label was removed again 2026-09-27 — see [ux-fixes.md](ux-fixes.md) § UX bugs). words/link/qr stay 1:1 auto-pair; reconnect is its own codeless method (since 2026-09-25).
  `tests/e2e/lobby.spec.ts` (joiner↔joiner + busy) + `connectionSlice.test.ts` + `room-server.test.ts`.
  (See [methods.md](../architecture/methods.md) § Room lobby.) **Deferred follow-ups below.**
  - ✅ **reconnect-in-lobby — SUPERSEDED 2026-09-25 by the codeless reconnect** ([reconnect.md](reconnect.md) § Reconnect UX below).
    The goal was to reach a pinned peer without the separate by-code path; the by-code path no longer
    exists — a tap on the recent-devices row meets the other device at a rendezvous derived from the
    pairing secret, and the lobby is not involved. The role question it carried (create/join is
    undefined for a mesh pick) was answered by deriving the reconnect role from the DTLS fingerprints.
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
    `ws-close.spec.ts`). See [connection.md](../architecture/connection.md) § Signaling WS lifecycle.
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
    `peers[0]` heuristic. See [methods.md](../architecture/methods.md) § link/qr method + [claude-md-retired-sections.md](claude-md-retired-sections.md) § Signaling server.
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
    `tests/integration/turn-credentials.test.ts`. (See [claude-md-retired-sections.md](claude-md-retired-sections.md) § Signaling server / TURN credentials.)
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
    creds — relay itself not run). See [privacy-and-ice.md](../architecture/privacy-and-ice.md) § Privacy mode + ICE.
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
    no offer, no hang). See [privacy-and-ice.md](../architecture/privacy-and-ice.md) § Privacy mode + ICE / Max-privacy strict model.
- ✅ **Cross-browser pass (6e) — DONE.** The no-device parts landed first (below); the real-device pass ran
  2026-10-02 (Pixel 5, Android 14 Chrome) and 2026-10-03 (iPhone 15, iOS 26.6 Safari over WebDriver) — TESTPLAN
  47/47 ticked or closed with a reason ([the run log](../test-runs/README.md)). Android Firefox was dropped by the owner.
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
    each engine as its own Playwright project: **33/33 under each of chromium / firefox / webkit**
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
  - **Real devices (post-deploy) — DONE for Android Chrome (Pixel 5, 2026-10-02) and iOS Safari (iPhone 15,
    2026-10-03, driven by WebDriver):** QR scan + camera permissions on actual iOS Safari ✅, the disk/RAM
    receive paths on real hardware ✅ (site storage to 2 GiB on the iPhone, 5 GiB on the Pixel), everything
    cross-network (TESTPLAN § C: Max fails closed with the hint, Reliable relays through coturn — 1.7 MB/s
    on LTE) ✅, and iOS mid-transfer suspension (§ F1) MEASURED: iOS Safari ends the connection on screen
    lock ([ux-fixes.md](ux-fixes.md) § UX bugs, first item). Engine-level transport interop is pre-covered headlessly (above). The pass
    is tracked case by case in TESTPLAN.md — **47 of 47 closed as of 2026-10-03** ([the 2026-10-03 run log](../test-runs/2026-10-03.md); B3's
    Android-Firefox half, C5 and F4 were dropped by the owner, F1-iOS and F8-iPhone closed as platform /
    tooling limits — the ticks say so). The findings are in [ux-fixes.md](ux-fixes.md) § UX bugs below. **6e is DONE.**
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
  `application/wasm`, /ws→426, SPA fallback); the in-browser P2P/SAS/transfer and cross-network relay
  checks are DONE (6e real-device, 2026-10-02/03). The `http2 on;` → `listen … ssl http2;` template fix was for the VPS's nginx 1.24 and no
  longer applies (1.28 takes both; HTTP/2 is ON on the live vhost — [followups-and-ops.md](followups-and-ops.md) § Ops, corrected 2026-09-12; this
  line kept saying "off" until 2026-10-03). Original deploy-prep artifacts built + committed:
  `deploy/nginx.conf.example` (TLS, 80→443, SPA `try_files $uri /index.html`, the `/ws`
  proxy with `X-Real-IP` + WS-upgrade + raised `proxy_read_timeout`, HSTS / build-tuned **CSP**
  [`'wasm-unsafe-eval'` for the QR-scan WASM, now **self-hosted** (step 6e) so `connect-src` lists no
  CDN] / `Permissions-Policy camera=(self)`), `server/.env.example` (all server env + criticality notes),
  `deploy/coturn.conf.example` (from 6d), `deploy/DEPLOY.md` (step-by-step + inline gotchas). Only code
  change: an additive startup `[config]` summary log (no secrets) in `signaling-server.js`. Consolidated
  env reference in [claude-md-retired-sections.md](claude-md-retired-sections.md) § Deployment / configuration. The ops half is done too: nginx/coturn/DNS/TLS
  run on the real host, and the CSP held for a real QR scan on a non-Chromium engine (iOS Safari, the
  self-hosted zxing WASM, 2026-10-03 — TESTPLAN A2/B3). The X-Real-IP/TRUST_PROXY pairing is documented in all three
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
