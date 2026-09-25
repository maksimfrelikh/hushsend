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
  joinedAt). words/link/qr stay 1:1 auto-pair; reconnect is its own codeless method (since 2026-09-25).
  `tests/e2e/lobby.spec.ts` (joiner↔joiner + busy) + `connectionSlice.test.ts` + `room-server.test.ts`.
  (See CLAUDE.md § Room lobby.) **Deferred follow-ups below.**
  - ✅ **reconnect-in-lobby — SUPERSEDED 2026-09-25 by the codeless reconnect** (§ Reconnect UX below).
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
- ✅ **HTTP/2 is ON on the live vhost — CORRECTED 2026-09-12.** The earlier note (and DEPLOY.md § 0)
  claimed it was off, read off the plain `listen 443 ssl;` line while missing the standalone
  `http2 on;` directive below it. `curl` against the live host negotiates HTTP/2. Nothing to do.
- ✅ **Security headers were silently dropped on `/assets/` and `.wasm` — FIXED, re-verified live
  2026-09-17.** nginx applies inherited `add_header` directives ONLY when the current level defines
  none, and both locations defined their own `add_header Cache-Control`, so the server-level block
  vanished for them. The live site now repeats all six inside each block. Measured today against
  production: **6/6 on the HTML, 6/6 on the JS bundle, 6/6 on the `.wasm`** — and that is after an
  nginx package upgrade on 2026-09-15 (1.28.3-2ubuntu1.10 → .11), so the config survived it.
- ✅ **`/ws` and `/` were logged with nginx's default `combined` format — FIXED, re-verified live
  2026-09-17.** The default wrote the client IP, the full User-Agent and the rendezvous code
  (`?room=…`) to disk, quietly undoing the coarse-device-label design. `access_log off;` is now set in
  all six location blocks of the live vhost. Measured today: **0 hushsend lines in the current
  `access.log`** across four days of uptime.
  **Residual, small but worth naming rather than leaving implicit:** the ROTATED logs still hold 56
  pre-fix lines (03–10 Sep, 23 unique IPs with full User-Agents). Inspected: they are `POST /` 405
  bot noise matched by the *Referer* header — **no `?room=` rendezvous codes and no `/ws` lines** — so
  no rendezvous or pairing metadata was ever retained. They age out with logrotate. Nothing to do
  unless the retention itself is considered sensitive.
- ✅ **Stale 4th signaling copy deleted (2026-09-17).** `/var/www/hushsend/server/` held an old
  checkout that nothing ran — the systemd unit works out of `/var/www/hush-signaling-server` — but it
  was old enough to mislead someone reading it as live. Removed; services stayed up, and the three
  remaining copies (repo, `~/projects/hush-signaling-server`, the running one) all hash the same.
  Note for the next person: it did NOT need root, only the deploy user.
- **Scheduled CI expires on a quiet repo.** GitHub disables `schedule:` workflows after 60 days with
  no commits, which would silently stop the nightly engine matrix — the only thing that exercises
  firefox/webkit/interop, since that job is skipped on push. Last commit 2026-09-13, so **the nightly
  stops around 2026-11-12** unless something lands before then. Re-enable it (or run the matrix from
  the Actions tab) before any release.
- **Two measurements were left half-finished** when the ladder ran on a Mac: WebKit's 1792 MB rung was
  interrupted by hand before the stall watchdog could name a percentage, and Chromium's ceiling is
  only bracketed as "2 GB OK, 3 GB fails" — the boundary between them is unmeasured. Neither blocks
  anything.
  **Do NOT run the remaining rungs on the deploy host** (checked 2026-09-17, and the earlier "a single
  ladder run away" was misleading). The Blob receive path is RAM-bound, so the rung that fails is a
  property of the MACHINE as much as the engine: this box has 6 GB plus 3 GB of swap, and the
  unmeasured rungs are 2304/2560/2816 MB held in a browser heap. It would either thrash or produce a
  ceiling that describes this server rather than the Mac the rest of the ladder was measured on —
  a number worse than no number. Finish it on the same class of machine as the original run, and
  record which machine beside the result.

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
- **stark-ui-kit 0.3.0 migration** *(open, 2026-09-25)* — the pin is still `b23a2e5` (kit 0.1.0). Bump
  to `2a3f7ec` (0.3.0) and in the same pass: (1) import `useFocusTrap` / `useScrollLock` from
  `stark-ui-kit/react` (`copyToClipboard` stays on the root entry); (2) replace the palette block of
  `src/ui/theme.css` with `import 'stark-ui-kit/theme-mono.css'` — the values here are the OLD greys
  (light `--brand-muted #6c6c6c` vs the kit's `#666666`; a high-contrast set whose hairlines sit at
  1.74:1 on white, under the 3:1 of SC 1.4.11), keeping only the font-role overrides theme.css still
  needs while fonts are not self-hosted; (3) `theme-mono.css` follows `prefers-color-scheme` while
  `<html>` has no `data-theme` — `prefs.tsx` writes it from a React effect, so check the pre-hydration
  frame on a dark-OS + light-pref browser and, if it flashes, set the attribute in `index.html` before
  the bundle; (4) re-run unit + e2e. Then rewrite CLAUDE.md § UI / styling for the new pin.
- ✅ **Transfer-history privacy — DONE** (pre-deploy). Transfer history is no longer persisted: it
  moved from a localStorage record (`persistence.ts`, now deleted) to a SESSION-ONLY in-memory Redux
  slice (`src/store/historySlice.ts`), so file names leave no local trail — the history is gone on
  reload / tab close. localStorage now holds ONLY prefs (lang/theme/privacy mode, `prefs.tsx`);
  keystore pins (IndexedDB) are untouched. "Forget" clears the pins + the in-memory history. (See
  CLAUDE.md § Current state.)

## Caveats (not scheduled — see CLAUDE.md § Known residuals)
the reconnect rendezvous repeats within one 10-min bucket · clock skew delays a reconnect by up to the
skew · dual-pin if a keystore is wiped (the wiped side can no longer reconnect; it pairs afresh).

(✅ **Pre-SAS pairing deadline firing-direction — now tested** (pre-deploy cleanup): `?stallSasNonce=1`
makes a peer reach the SAS but withhold its nonce reveal, `?preSasTimeoutMs=N` shrinks the pre-SAS
deadline (both DEV-only / tree-shaken), and `tests/e2e/room-sas.spec.ts` asserts the other side fails
at the deadline rather than hanging. See CLAUDE.md § room/SAS Timeouts.)

## Reconnect UX — DONE 2026-09-25 by removing the code (codeless reconnect)

**What changed.** Reconnect used to rendezvous over a plain 4-digit room: one side pressed Start and
read a code, the other typed it. That entry-point split produced every failure mode listed in the
history below, and the code itself was the security weak spot (an enumerable room, auto-pairing with
whoever won the race, which is what forced the blinded announcement on 2026-09-18). The rendezvous
is now **derived**: both devices hold the `pairingId` (16 secret bytes minted at enrollment), so each
computes `HMAC(pairingId, time-bucket)` → a 22-char token of exactly the link/QR shape and asks the
server for that token room **join-or-create**. Tap Reconnect on both devices, in either order; they
meet. Server-side, token rooms became join-or-create (the running `hush-signaling-server` was
updated the same day) and the link/QR creator now draws its own token too, so the server cannot
tell a reconnect from a first link meeting, nor which side initiated. Before any identity key is
shown, each side proves it holds the pairing secret with a MAC (`reconnect-hello`); the proof under
the pinned key follows, the responder first, and the initiator settles only on the responder's
`reconnect-ok` so the two sides never disagree about the outcome. Roles come from the DTLS
fingerprints, not create/join (there is no creator) and not the server's ids. No SAS is primed
underneath any more: a device without the pin cannot derive the token, never arrives, and the
waiting side ends with "the other device did not show up" (10-min cap; the room is re-taken every
2 min and at every bucket boundary meanwhile). `crypto/reconnect.ts` (rendezvous, role, hello,
schemas — unit-tested), `SessionController` (`reconnectTo`, the wait/refresh/rejoin logic —
`SessionController.reconnectRendezvous.test.ts`), `ReconnectWaitScreen`, `room-server.test.ts`
(join-or-create + TTL on a joined token), `tests/e2e/reconnect.spec.ts` (happy, stall, key-changed,
held hello, wire hygiene incl. the socket URL, order independence, no-show), `link.spec.ts` (dead
link still fails at once). See CLAUDE.md § Crypto / Reconnect and § Known residuals.

**What this closed:** both failure modes below; the "reconnect + plain room join" mismatch (a plain
join lands in a lobby, a reconnect never enters one — nothing to mix); the `pairingId` disclosure to
a code-guesser (nothing is announced); `RoomCreateScreen`, the reconnect code input, the split-hint
copy, `blindPairingId`, `reconnect-init`/`reconnect-fallback`, the SAS-fallback hold in
`trySasReady` — all deleted, not gated.

**What it did NOT do:** return-to-lobby (unrelated, still deferred below); keystore GC / pin-merge
(the dual-pin caveat stands — a wiped side pairs afresh and the other side gains a second pin).

**New residuals, small, recorded in CLAUDE.md § Known residuals:** the token repeats within one
10-minute bucket; clock skew delays the meeting by up to the skew.

### History (the by-code design, kept for the record)

Expands the deferred **reconnect-in-lobby** item (Step 6 / 6c follow-ups). The manual cross-browser
pass confirmed reconnect worked via its intended path (one side `reconnect` [create], the other
`reconnect-by-code`), and surfaced two concrete failure modes from how the entry points combined.
The two LOW-RISK parts were done first (interim liveness deadline + entry-point ergonomics); the
SECURITY-SENSITIVE parts (lobby-pick reconnect + reconnect role create/join → id-order) stayed
deferred (post-audit) until the code was removed altogether.

The two failure modes (both now gone with the code):

- ✅ **Mismatched entry → permanent "agreeing on keys" hang — FIXED (verified 2026-09-17, the text
  below had gone stale).** If one side takes the **reconnect** path (pin-based auto-pair, role
  create/join, NO SAS) while the other joins the same code via the **regular room join** (→ lobby →
  manual pick → a fresh SAS, role by id-order), the two run *different* handshakes over the same
  channel: one sends `reconnect-init` and waits for `reconnect-proof`, the other sends
  `pair-request` / `sas-commit`. SDP/DTLS negotiate fine, but the app-level key step never converges.
  This entry used to end "there is **no timeout-to-failed in this combination** … so the mismatch
  hangs forever instead of failing" — that is no longer true. `armReconnectTimeout` is armed in
  `beginPairing` for **either** side that is on the reconnect path (`SessionController`, guarded by
  `this.reconnect && !this.reconnect.fellBack`), independently of the pre-SAS timer, and the plain-SAS
  side is covered by `armSasTimeout`. A stalled re-auth ends in `failed` at 120 s. Covered by
  `reconnect.spec.ts:107` ("reconnect liveness deadline FIRES"), whose own comment names this residual
  as the thing it closes. The remaining UX complaint — that the two entry points are easy to mix up —
  is real and is the item below, but it is no longer a hang.
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

**Deferred (post-audit) — security-sensitive, NOT in this pass** *(resolved 2026-09-25: the code was
removed instead; the role moved to fingerprint order behind the hello gate — see the top of this
section and § Security audit (a))*: lobby-pick reconnect AND moving the
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
  home reconnect button now passes the selected row's `pairingId` to the reconnect entry point
  (today `reconnectTo(pairingId)`; both sides share that freshest pin, so both derive the same
  rendezvous from it).
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
  **MOVED 2026-09-25 — the role now comes from the DTLS fingerprints (`reconnectRoleFor`), and the
  argument above is satisfied differently.** The disclosure-ordering property ("a stranger who reaches
  the channel never extracts an identity key") no longer rests on WHICH side proves first: it rests on
  the `reconnect-hello` MAC under the pairing secret, which every side must verify before it sends a
  proof — so the responder discloses its key only to a peer that has already proven it holds the
  pairing (i.e. already holds that key). Fingerprint order is not the server's to choose (the ids
  were), and a MITM that presents its own certificates fails the channel binding whatever role it
  lands in. The plumbing blocker is gone too: nobody announces a pairingId — both sides derived the
  rendezvous from it. The key-changed-before-settle ordering was re-checked under the new roles:
  both branches still run the two-check verify BEFORE any settle, and the initiator now settles only
  on the responder's `reconnect-ok`, which is stronger than before (no half-connected pair).
  (→ § Reconnect UX + CLAUDE.md § Per-pairing role + § Crypto / Reconnect.)
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
  mappings produce it on direct paths). **Unavailable/empty stats used to read as "unknown, never
  relay" — that was finding F1, fixed 2026-09-13: see the F1 entry below.** Unit tests in `relax.test.ts` cover both
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
- [x] **No client-side liveness deadline on the words / link / qr key-confirmation path — FIXED
  2026-09-12.** `armConfirmTimeout` / `clearConfirmTimeout` (`SessionController`) arm a 120 s deadline
  in `runKeyConfirmation` — the moment the channel is open and our own tag has gone out — and disarm
  it on settle, on every failure and on every teardown. Expiry routes to the existing
  `onConfirmFailure`, so words counts the attempt and link/qr hard-stops, exactly as a bad tag does.
  Fail-closed, liveness only: no crypto, transcript or guessing budget changes. Original text below.
  - **(original)** `room`/SAS
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
- ✅ **`pairingId` disclosure to whoever wins the reconnect join race — FIXED 2026-09-18.**
  A reconnect rendezvous is a plain 4-digit room (`createReconnectSession` → `connect({create:true})`,
  no codeType), NOT a lobby, so it auto-pairs with the first peer that joins. 10⁴ is enumerable —
  bounded only by `IP_RL_MAX` — so a code-guesser that won the race and reached the open channel
  received the initiator's `reconnect-init` carrying the raw **`pairingId`**, a stable per-pair
  identifier, before any authentication. It could never forge a proof, which is exactly why this sat
  as "linkability + nuisance, not an auth break" through two audits; for this product's users,
  something that links two anonymous rendezvous to one relationship is not a nuisance.
  **Fix:** the initiator now announces `HMAC(key = pairingId, DOMAIN ‖ fp_min ‖ fp_max)` truncated to
  the id's own length (`blindPairingId`, `crypto/reconnect.ts`). Keyed by the secret both peers
  already share and bound to THIS session's DTLS fingerprints, so a peer holding the pin recognises
  it by RECOMPUTING (`matchBlindedPairingId` scans its pins — there is no way to invert it), while a
  stranger sees 16 bytes that differ every session and correlate with nothing. Nothing in the crypto
  changed: the signature transcript still binds the REAL pairingId, which both sides know.
  **Truncation is about compatibility, not size.** Keeping the wire field the same length means a
  peer on an older bundle still PARSES the frame, fails to match, and sends `reconnect-fallback` — so
  a mixed pair degrades to the SAS comparison instead of failing schema validation and hanging until
  the 120 s deadline. Verified by accident and then on purpose: reverting only the sender produced
  exactly that fallback, not a hang.
  9 unit tests (`reconnect.test.ts`) pin the properties that matter — same length, both sides derive
  it, DIFFERENT every session, channel-bound, unknown pin → null. An e2e reads the frames the
  DataChannel actually sent and asserts the pinned id appears in none of them, because unit tests
  prove the tag differs from the id and not that the tag is what goes out. **Negative control run:
  with both halves reverted the e2e fails on precisely that assertion while the reconnect itself
  still succeeds**, so the test isolates the leak rather than the feature.
  **Superseded 2026-09-25:** `blindPairingId` / `matchBlindedPairingId` and the `reconnect-init` frame
  are deleted — the codeless reconnect announces nothing at all (the rendezvous is derived from the
  pairingId, the hello is a MAC under it). The e2e that read the wire now asserts the hello carries
  only `{challenge, mac}` and that the socket URL's room name is a link-shaped token, not the id.
- ✅ **(F1) The Max-privacy channel-open gate read "cannot tell" as "no relay" — FIXED 2026-09-13.**
  `openChannelUnlessRelayed` asked `selectedPathIsRelayed()`, which took `isForbiddenRemoteCandidate`'s
  `!remote → false` branch for an answer. But `selectedRemoteCandidate` returns null until ICE
  publishes a selection, and **its own docstring already said the caller must read that as unknown,
  NEVER as safe** — so the gate whose entire purpose is to make STRICT true could open a channel on a
  path it had not looked at. Not theoretical: this codebase's other consumer of the same resolver,
  `SessionController.verifyPath`, needed a 20×250 ms poll for exactly this condition, and it runs
  LATER in the session than the gate does. Same class as the peer-reflexive finding above — a control
  that is silently inert — and reachable in the live deployment, where `TURN_SECRET`/`TURN_URLS` are
  configured and Max ↔ Reliable pairs therefore exist.
  **Fix as built:** the policy moved into `relax.classifySelectedPath` (pure, injected clock/sleep/
  stats-reader, so it is unit-testable without a browser) and returns `direct` | `relayed` |
  `undetermined`. The gate now opens ONLY on `direct`; `undetermined` takes the same terminal refusal
  path as `relayed`. A null read CONTINUES the poll rather than ending it, so a transient `getStats()`
  rejection does not decide the session, while an engine with no `getStats()` at all never yields a
  judgement and is refused — the honest outcome, since the Max-privacy promise cannot be kept on an
  engine that cannot report its own path.
  **Measured before changing the policy** (the point being not to repeat the mistake of deciding from
  a loopback intuition): chromium, firefox and webkit each report a selected pair on the **first** read
  after DataChannel open — 0–1 ms, 3/3 runs per engine — so a healthy connection never waits and the
  5 s deadline is insurance, not latency. 9 unit tests in `relax.test.ts`, one of which reproduces the
  old wave-through against the old expression. Full suites after the change: 243 unit,
  firefox e2e 33/33, webkit+interop 38/38.
- ✅ **(F2) A detected interposer was displayed identically to an ordinary Safari — FIXED 2026-09-13.**
  `pathSettled` took `{ confirmed: boolean }` and stored `'yes' | 'no'`, so `mismatch` — the only
  positive evidence this system can produce — collapsed onto `unknown`, which is the ORDINARY outcome
  on Safari/iOS. Same badge, same class, same hint; and that hint states the cause as *"this browser
  does not expose enough to check it. Safari never does"*, which on a mismatch is simply untrue — the
  browsers exposed plenty, the check ran and disagreed. Because `Diagnostics` (which holds the real
  verdict) is tree-shaken out of production — verified against the served bundle: `path-verdict`
  appears 0 times — the detection had **no representation anywhere a user could see it**, while the
  benign state it hid behind is common enough to train people to ignore it.
  The original reasoning for collapsing — that a `mismatch` is not reliable enough to accuse anyone
  with, since honest firefox↔webkit pairs produce it — is still right, and nothing here turns it into
  an accusation. What was wrong was the consequence. **Fix as built:** `connection.pathCheck` carries
  the verdict three-way; `mismatch` gets its own label (`⚠ route did not match`), its own weight
  (`hs-badge--alert`, the inverted fill the design language already uses for danger) and its own copy,
  which names BOTH causes and ends with something to do. `ok` shows no hint at all. Regression tests:
  3 in `connectionSlice.test.ts` (the reducer could not even represent the difference before) and an
  e2e in `privacy.spec.ts` driven by a new DEV-only `?forcePathMismatch=1` that stubs the VERDICT
  only — badge, class, hint and the absence of a teardown are all production code — asserting the
  mismatch side is distinct from both other states while the honest side stays `ok` with no hint.
- ✅ **(F4) Code comments asserting controls that do not exist — FIXED 2026-09-13.** Two call sites
  read `startPathAttestation(); // verify WHO is on the path — gates file bytes`, and `verifyPath`'s
  docstring opened with "`mismatch` is a HARD STOP on the same terminal path as a SAS mismatch". The
  body has never done either. CLAUDE.md § Path attestation carried the same claim
  ("`mismatch` → terminal, same teardown as an authenticity failure"). This is the repo's own
  documented failure mode — confident prose read as specification — having moved from the docs into
  the code, where two audits passed over it. All four corrected, and the advisory status is now stated
  at the top of the function that would have to implement the control.

- ✅ **Verifiable delivery, first step — BUILT 2026-09-13.** THREATMODEL § 1's top-ranked risk, and the
  pass found its hardest technical precondition already satisfied but unnoticed: **the production
  build is byte-for-byte reproducible.** A fresh `vite build` with the deploy script's environment
  reproduced all eight files of the served tree exactly, JS included. What was missing was only the
  attestation half — CI ran typecheck/lint/vitest/e2e but never built the bundle.
  **Built:** `.github/workflows/ci.yml` job `build-attest` builds on a GitHub runner, **builds twice
  and fails unless the two are byte-identical** (without that guard a published hash is meaningless,
  because "live ≠ CI" would become the ordinary outcome), publishes the SHA-256 manifest in the public
  run summary, uploads it as an artifact, and attaches a signed provenance attestation via
  `actions/attest-build-provenance` — verifiable with `gh attestation verify`, recorded in a public
  transparency log. `deploy/build-env.sh` is now the single source of the VITE_* values baked into the
  bundle (the deploy script and CI both source it — two copies that agree today would be a silent
  break tomorrow, and the break would look like tampering). `deploy/bundle-manifest.sh` generates the
  manifest for both sides; `deploy/verify-bundle.sh` checks a LIVE deployment against it.
  **Verified end-to-end, not just written:** the verifier was run against production and matched all
  8 files including the lazily-fetched `.wasm` whose path only appears inside the JS; both negative
  cases (one altered hash, one manifest entry the host does not serve) exit 1 loudly; the CI step
  sequence was executed locally and the two builds were byte-identical.
  **Stated limits** (in `deploy/verify-bundle.sh`'s header, README and THREATMODEL, because
  overclaiming here is the exact failure mode this repo keeps hitting): it does nothing for a browser
  already served a hostile bundle; selective tampering at one IP is caught only by someone checking
  from that vantage point; and it proves the bytes match a build of a commit, not that the commit is
  honest. It removes "silently" — nothing more, and that is worth having.
  **Still open:** no scheduled check from an unrelated network, no independent mirror, no
  pre-delivered client (extension / desktop). Those are the forms that protect the user at load time.

- ✅ **(F3, partial) The network exposures are now stated in the UI — 2026-09-13.** The pass found an
  exposure listed nowhere: there is no ECH on this deployment, so the TLS handshake carries
  `hushsend.frelikh.dev` in **cleartext SNI**, and an observer therefore learns "this person opened a
  privacy file-transfer tool" from ONE side, without decrypting anything and before any transfer
  happens. For this audience that fact is frequently the one acted on — it is upstream of the
  social-graph residual, which at least requires a transfer to occur. Neither it nor the social-graph
  residual appeared anywhere in the interface: the privacy toggle says only "your peer sees your IP",
  which is a much smaller claim than "your provider sees that you used this, and who with".
  **Built:** a collapsed `<details>` on the landing (`NetworkExposure`, testid `network-exposure`),
  EN + RU, naming both exposures and ending in the only action that helps — Tor or a VPN **on both
  sides**, since one side alone does not address the direct-connection point. Collapsed deliberately:
  both are permanent properties of the deployment rather than events, and a standing banner would be
  dismissed within a day AND would train users to dismiss the path-attestation badge, which does
  report an event. e2e in `smoke.spec.ts` asserts it is present, starts collapsed, is honest in the
  summary line alone, and carries all three points once opened.
  **Still open — this is disclosure, not mitigation.** Removing the exposure needs an onion service, a
  mirror on a domain that is not obviously this tool, or ECH. Also note the whole deployment is one
  name on one IP (app + signaling + STUN/TURN), so it is trivially blockable and public in CT logs.

**The e2e flake, chased to a cause rather than rerun away:**

- ✅ **Reconnect stalled at `pairing` for 120 s — ROOT CAUSE FOUND AND FIXED 2026-09-17.** Took three
  sessions, two wrong theories and one broken experiment, so the whole chain is recorded here rather
  than the conclusion alone.

  **The bug.** `PeerConnection.setupChannel` wires `onmessage` SYNCHRONOUSLY, while `onopen` runs the
  Max-privacy relay gate, which AWAITS `getStats()` before handing the channel to the
  SessionController. Between those two moments the channel already delivers peer frames but
  `rc.fps` is not set yet — so the initiator's `reconnect-init`, landing in that window, hit
  `if (!rc.fps) return` in `onReconnectFrame` and was discarded **permanently**. The sender never
  resends (it considers itself announced), so both sides sat in `pairing` until the 120 s deadline,
  with NOTHING written to the dev log. Confidentiality was never affected; what broke was
  reconnecting to an already-known device — roughly 1 CI engine-matrix night in 5, and 4 of 8 local
  webkit runs.

  **Fix:** hold the early frame and replay it once `rc.fps` is set (`pendingReconnectFrame`). Not an
  invention — `pendingEnrollFrame` and `pendingPathAttest` already do exactly this for the same class
  of race; reconnect was the one path without the guard.

  **How it was proved, after hunting failed.** Chasing the flake did not work: with instrumentation in
  place it went 6 full webkit runs without reproducing. So the window was made controllable instead —
  `?gateDelayMs=N` (DEV-only, tree-shaken, verified `function aA(){return 0}` in the built bundle)
  holds the channel back from the owner on ONE side. It stubs nothing else: the drop/hold decision,
  the deadline and the state machine are all production code. With the window widened and the fix
  removed, the failure is **deterministic — 5 of 5** — and its signature is the production one
  verbatim: `Expected: "connected", Received: "pairing"`, 123 polls. Regression test:
  `reconnect.spec.ts` "reconnect-init arriving before channel-open is held, not dropped".

  **A wrong experiment worth recording.** The first old-vs-new comparison showed the OLD code passing,
  which nearly produced the conclusion "hypothesis refuted". The flaw was in the experiment: removing
  the fix by stashing `SessionController.ts` also removed the `gateDelayMs` wiring declared in the
  same file, so the "old code" ran with no delay at all and had no race to lose to. Revert the
  BEHAVIOUR under test, never the instrument that creates the condition.

  **Evidence for the fix, at its real strength.** Full webkit suite after: **0 failures in 6 runs**,
  against 4 in 8 before. All engines green afterwards (79 passed, chromium/firefox/interop/mobile).
  That is strong, not conclusive: in the wild the window is a few event-loop turns rather than 3 s, so
  whether this accounts for EVERY nightly failure is for the nightly matrix to say over the coming
  days. Watch it.

  **Contributing, and stated plainly: the F1 gate widened the window.** `SELECTED_PAIR_TIMEOUT_MS`
  turned the await into a bounded poll of up to 15 s, so a change made for Max-privacy correctness
  very likely made this pre-existing race more frequent. The race predates it (baseline `6d11d1c`
  failed identically), but the honest statement is that the two interacted.

  **Related fix in the same pass: the silent branches now speak.** Every drop on the reconnect path
  logs which guard did it, channel-open logs what it decided, and the unreachable
  "initiator without a pairingId" now fails closed with a reason instead of 120 s of silence. That
  ambiguity is what made this expensive to find: a dropped frame and a never-sent frame looked
  identical from outside.

  **Earlier contributor, fixed separately (2026-09-13) and still worth keeping:** browser processes
  accumulated across a run because `reconnect.spec.ts` was the only spec closing its contexts —
  measured 31 at peak and climbing, now 12 and flat. That closed the chromium half; it was never the
  whole cause, and this entry is the rest of it.

- [ ] **CONFIRM the reconnect fix on the nightly matrix (opened 2026-09-17).** The root cause is
  proved and its regression test is deterministic, but in the wild the window is a few event-loop
  turns rather than the 3 s the test forces — so whether it accounts for EVERY nightly failure is
  still open. Baseline to beat: the engine matrix failed 1 night in 5 (13–16 Sep green, 17 Sep red,
  all on the same commit). **Watch `e2e (firefox · webkit · interop · phone profile)` for ~5 nights
  from 18 Sep.** Green throughout ⇒ close it. A failure ⇒ read the dev log in the report, which now
  names which guard dropped what; that is exactly what the logging in this commit was for.
  **Night 1 of ~5 — 18 Sep, GREEN** (commit `9b42ccad`, engine matrix 5.6 min). Worth almost nothing
  on its own, and recorded as such: the matrix was green 4 nights in 5 BEFORE the fix, so one green
  night is the expected outcome about 80% of the time either way. The load-bearing evidence is still
  the deterministic reproduction (5/5 failures without the fix, passes with it) and 0-in-6 webkit
  suite runs after. This is corroboration accumulating, not a result.
- ✅ **Reconnect spec's patience raised above the app's own deadline (2026-09-17).** The app fails a
  stalled re-auth at 120 s (`DEFAULT_RECONNECT_TIMEOUT_MS`) while the spec waited 60 s, so the test
  gave up first and "the app stalled" was indistinguishable from "the app failed correctly" — the
  ambiguity that cost three debugging sessions. Now 140 s, with the per-test budget at 300 s to fit.
  Deliberately not done while the stall was unexplained; safe once the cause was found.
- [ ] **Path attestation over the authenticated channel — BUILT, but ADVISORY ONLY (2026-09-12).**
  The mechanism is in the tree and working; what is NOT done is making it a control, and the blocker
  is measured rather than guessed. **It fails on honest Safari.** With the gate in place (`mismatch`
  → teardown, bytes gated) an `interop · firefox → webkit` pair on ONE LAN failed reproducibly with
  no attacker present: WebKit cannot disable mDNS obfuscation, so it offers only `<uuid>.local` host
  candidates, its peer learns the real address peer-reflexively, and WebKit therefore cannot attest
  to the address it was reached on. Removing the gate: 9/9 interop and 96/96 engine tests pass. Since
  that is exactly what real Safari/iOS does, failing closed there would break honest transfers on a
  primary target platform — worse than the leak it closes.
  **Enforcement was RE-TESTED after the "wait for ICE to select a pair" fix and still fails.** The
  first removal happened before that fix, so the obvious theory was that the failure had been a race.
  It is not: with the gate back on, `interop · firefox → webkit` failed **intermittently — one run in
  two**, while advisory mode passed 3/3. Intermittent is worse than consistent here: a spurious
  "someone is in between" destroys an honest transfer at a random moment AND teaches the user to
  dismiss the one warning that matters. Root cause is structural, not a race: a peer behind NAT does
  not reliably know the address its peer reaches it on (mDNS host candidates, peer-reflexive
  learning), so "the address I selected is not one you named" is not by itself evidence of an
  attacker. **Do not flip this on from a loopback run.**
  **Also note what enforcement would NOT buy even if it were stable:** the srflx address a peer
  attests to comes from the STUN server's reply. In the current deployment STUN and signaling are the
  SAME host, so one operator can both inject a candidate and tell the peer to attest the attacker's
  address — the check passes. Enforcement is only worth something once STUN is not the signaling
  operator (ideally 2+ independent STUN servers cross-checked, so a single lying one is caught).
  **Next step, and the reason the verdict is now projected:** the real-device pass should record
  `path-verdict` / `path-selected` / `path-peer-addrs` on each engine, which is the input needed to
  choose between (a) inverting the check — each side attests the address it SELECTED, and the peer
  checks that against its OWN local addresses, so the side that must know the address is the side
  that does know it; (b) gating only when both sides report a usable set; or (c) leaving it advisory.
  Details of what IS built below.
- ℹ️ **What was built (the mechanism).** A hostile server can put
  itself ON THE PATH in Max privacy and no candidate filter can stop it: ICE credentials ride the SDP
  it relays, so it can answer connectivity checks, and a client cannot tell an attacker's `typ host`
  from the peer's — the peer's real address is only ever learned FROM the server. Confidentiality was
  never affected (DTLS is end-to-end; a forwarding attacker sees ciphertext), but the Max-privacy PATH
  promise was not verifiable. **Built:** `src/core/pathAttest.ts` (pure) +
  `SessionController.startPathAttestation` / `onPathAttest` / `verifyPath` / `failPath`. On
  `established` each side sends `{kind:'path-attest', addrs}` over the AUTHENTICATED DataChannel and
  checks that the remote address ICE actually selected (`PeerConnection.selectedRemoteAddress`, via
  `getStats()`) is one the peer named. In principle a forwarding attacker's two moves are both
  visible: pass the real addresses through → `mismatch`; drop the frame → nothing arrives within
  15 s. Today both outcomes are RECORDED, not enforced — see the blocker above. `unknown` (an engine
  that cannot enumerate candidates, or no selected pair yet) is benign by design, which is precisely
  why `tests/e2e/privacy.spec.ts` asserts a real same-engine pair reaches `ok` on chromium, firefox
  AND webkit: `unknown` everywhere would make a broken implementation indistinguishable from a
  working one. The verdict is polled until ICE has actually selected a pair (the attestation frame
  can beat the selection — measured on firefox↔webkit). **Residual, stated plainly:** the comparison is address-only (honest
  NATs vary the port, so comparing ports would reject working connections), and it rests on the peer's
  own view of its addresses, which for srflx comes from STUN — the same operator. An operator that
  both lies over STUN *and* sits on the path can still make the two sides agree; removing that means
  not being the STUN provider. Unit: `pathAttest.test.ts`. (See CLAUDE.md § Path attestation.)
- [ ] **Separate the STUN server from signaling — STARTED 2026-09-12.** The attestation above is
  defeated by one adversary holding BOTH, so this is the precondition for it ever becoming a control.
  The deployment lives in its own repo,
  [`hushsend-stun-server`](https://github.com/maksimfrelikh/hushsend-stun-server) (config + runbook +
  `verify.sh`; no server code — it is coturn). Relaying is refused structurally there by defining NO
  authentication, since a TURN allocation must be authenticated and a STUN binding request must not.
  **Not yet wired in:** `VITE_STUN_URLS` still points at the existing coturn on the app host, and
  during development all three services share one machine — which buys no separation at all, one
  operator. The property only starts to exist when STUN runs under a DIFFERENT party.
- ✅ **Cross-check several independent STUN servers in the client — BUILT 2026-09-17.**
  `core/stunCheck.ts`: one throwaway `RTCPeerConnection` per configured STUN URL, each with only that
  URL, then compare the public addresses they report. `agree` / `disagree` / `unknown`, projected to
  the DEV strip always and to the USER only on `disagree` — a badge that is always green is a badge
  people stop reading (the F2 lesson). Advisory: nothing is gated on it.
  **The obvious design does not work, which is why this was measured before it was written.** Putting
  several STUN URLs in ONE `iceServers` entry does not give one result per server: ICE prunes
  redundant candidates before the application sees them, so chromium and webkit both yield a SINGLE
  srflx candidate attributed to the first URL, and a disagreement is invisible. Separate probe
  connections were verified to give per-server views with `url` attribution on chromium and webkit.
  **Firefox reported no srflx candidate at all** in that measurement and exposes no `url` field on
  local candidates — on loopback, where the reflexive address equals the host address and is
  legitimately pruned, so this is not yet evidence about Firefox on a real network. `unknown` is
  benign by design, so the feature degrades rather than breaks there. Worth recording properly in the
  real-device pass.
  **Limits, stated up front:** address only, never the port (each probe uses its own socket, so even
  an honest NAT varies the port); a multi-WAN or CGNAT client can disagree HONESTLY, so a
  disagreement is shown and never acted on; and it says nothing at all while one server is
  configured — which is today's deployment.
  8 unit tests (`stunCheck.test.ts`) pin the policy, including that `unknown` and `disagree` stay
  distinct. e2e in `privacy.spec.ts` asserts a real verdict is reached with two servers rather than
  silently sitting at `unknown`; the nightly CI matrix now starts a SECOND coturn so it actually runs
  there instead of skipping forever.
  **Still open, and it is the operational half:** this is the client side of a property that only
  starts to exist when the STUN servers are run by DIFFERENT people. Today app, signaling and STUN
  are one IP (the repos are separate, the machines are not).
- **`pairingId` disclosure to whoever wins the reconnect join race** — closed twice: blinded on
  2026-09-18 (the entry under the first pass above), then made moot on 2026-09-25 when the 4-digit
  reconnect room was removed with the code — nothing is announced any more (§ Reconnect UX).

### Codeless reconnect (2026-09-25)

- ✅ **The reconnect code is gone — see § Reconnect UX for the design and what it closed.** From the
  audit's point of view, what moved: (1) the reconnect rendezvous went from an enumerable 4-digit room
  to a 128-bit token derived from the pairing secret, taken join-or-create, indistinguishable on the
  wire from link/QR (link/QR creators draw their own token now, so `create=1` is no longer a signal of
  who initiated either); (2) a `reconnect-hello` MAC under the pairing secret gates every proof, so
  the long-term identity key is disclosed only to a proven pin-holder — this is what let the role move
  off create/join (item (a) above); (3) the initiator settles only on `reconnect-ok`; (4) the SAS
  fallback that ran UNDER the reconnect is gone, which also removes the "mismatched entry" class
  entirely. **Open for the independent audit:** the pairingId is now load-bearing as a secret — its
  storage is the same IndexedDB as the pins (readable by an XSS or a hostile extension; the identity
  key has the non-extractable WebCrypto protection, the pairingId does not), and the derivations
  (rendezvous, hello) should be read with that in mind. The 10-min bucket is a stated linkability
  trade (same-bucket retries show the same token); the time input is the client's own clock, never
  the server's.
- **Server-side, `hush-signaling-server`:** token rooms are join-or-create and the managed TTL is
  armed whenever a room comes into being (`created`), not only on `create=1`. Integration-tested
  (`room-server.test.ts`: first arrival opens, second finds, third bounced 4002, TTL fires on a
  joined token, the 4-digit shape still says 4009). Deployed to the running copy the same day.

### Volume padding + a receiver bound (2026-09-17)

- ✅ **Volume padding — BUILT, on in Max privacy.** THREATMODEL road-map item 6, previously marked
  optional. Without it the contents are unreadable but the VOLUME is not hidden: chunks are
  16–256 KiB and the total is ≈ the file size, so anyone on the path reads "4,723,811 bytes in 12 s",
  and against a known candidate set an exact byte count identifies a document about as well as its
  name would. `core/transfer/padding.ts` sends filler after the real bytes so the total lands on a
  bucket edge: powers of two below 1 MiB (small files are the most identifiable and the cheapest to
  hide), then steps of an eighth of the leading power of two above it.
  **The ladder is a stated trade, not a default that happened.** Powers of two throughout would hide
  the most and cost up to 2× bandwidth — unacceptable for people on metered and slow links, which is
  this product's audience. The ceiling is therefore 12.5%, and the cost is resolution: above 1 MiB an
  observer still learns the size to within 12.5%, which against a SMALL candidate set may still
  identify a document. `BUCKETS_PER_OCTAVE` is the one constant to change if that trade should go the
  other way.
  **What it does NOT hide, in the module header so nobody reads more into it:** duration and timing,
  the fact that a transfer happened or between whom, and the number of transfers.
  **Max privacy only.** That mode already refuses to connect rather than relay, so trading bandwidth
  for privacy is the same bargain; Reliable was chosen for convenience and relays anyway.
  No wire-protocol field was added — both sides derive the bucket from the declared size, and the
  receiver simply stops writing at it. 8 unit tests pin the ladder (monotonic, never truncating,
  overhead capped); an e2e counts the bytes the DataChannel actually put on the wire and hashes what
  arrived, because unit tests prove arithmetic and not that the filler is sent, dropped and harmless.
- ✅ **The receiver now writes at most the size the sender DECLARED.** Found while building the above.
  The size guard ran BEFORE accept, against the declared size, and nothing enforced it afterwards — so
  on the streaming path (Chromium File System Access, which has no RAM ceiling to stop it) a sender
  could declare 2 MB and write whatever it liked to the user's disk. The peer is authenticated and the
  two humans trust each other, so this was never a stranger attack; but "you accepted 2 MB" must not
  be able to become 50 GB on disk, and the bound is what makes padding invisible anyway.

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
