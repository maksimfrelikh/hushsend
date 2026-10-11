# Build order, and the state CLAUDE.md recorded (until 2026-10-11)

Moved out of CLAUDE.md on 2026-10-11, when it became a short guide pointing at one file per topic.
Dated records, not maintained — the current state is in the living documents (see [README.md](README.md)).

## Build order (completed / in progress / planned)
1. ✅ **Transport** — `SignalingClient`, `PeerConnection`, core DataChannel backbone.
2. ✅ **File transfer** — chunking, backpressure, FSA/Blob caps.
3. ✅ **words path** — wordlist (EFF short #2, programmatic), `generateWords` (CSPRNG);
   `cpace` (CFRG draft-21 vectors, ristretto255+SHA512); `keyConfirmation` (ISK→HMAC, channel
   binding); rate-limit (≤10 attempts); TTL (3 min, does not tear down live P2P).
4. **room + SAS, then Identity + TOFU**:
   - ✅ **4a — room + SAS** — 4-digit code, commit-before-reveal, SAS = 3 words, fingerprint
     binding, mutual confirmation over DataChannel, pre-SAS + comparison timeouts, zod length
     checks. (Server cap/TTL/rate-limit for 4-digit rooms is **done — step 6a**, below.)
   - ✅ **4b — Identity + TOFU** — two parts:
     - **4b-i** — Ed25519 identity key + IndexedDB keystore + TOFU **enrollment** (pin peer key
       on first successful connect, channel-bound).
     - **4b-ii** — **reconnect**: mutual challenge-response signatures (channel-bound, replay-
       resistant) under the pinned keys; two-check verify (key-changed vs MITM) + "key changed" hard
       stop. **Codeless since 2026-09-25**: a rendezvous token derived from the pairing secret
       (join-or-create), a hello MAC before any identity key is shown, roles from the DTLS
       fingerprints, `reconnect-ok` so both sides agree; the SAS fallback and the 4-digit reconnect
       code are gone. `reconnect.ts` + e2e (happy, order-independent, stall, key-changed, held frame,
       wire hygiene, no-show).
5. **Real UI screens** — kit-based, status-driven screens (no router), persistent state across
   tabs / reload.
   - ✅ **5a (this step)** — real screens for the existing methods: home (method select + recent
     devices), room create/join, words create/join (5-slot autocomplete picker), **SAS as an
     ASYMMETRIC "pick from 3 phrases"** (per-pairing by id: the smaller-id side reads its phrase, the
     other is the blind picker), reconnect (pinned-key → no SAS; visible key-changed hard stop),
     transfer (progress / backpressure / FSA-Blob / cancel), failed/error screens, light-dark +
     EN/RU. Dev harness removed; a DEV-only diagnostics strip (tree-shaken from prod) carries the
     test-observable projections. **Recent devices are read from the keystore** (`recentDevices.ts`
     → `listPins()`) — the single source of pins/keys; localStorage holds ONLY prefs (`prefs.tsx`,
     lang/theme/**privacy mode**) — no peer keys, no pairingIds, no secrets, **no transfer history**
     (history is SESSION-ONLY: in-memory Redux `historySlice`, gone on reload — see § Build order 6 /
     transfer-history privacy); "forget" clears the keystore pins AND the in-memory history. The SAS
     pick-from-3 display logic is isolated + unit-tested in `sasOptions.ts` (`sasOptions.test.ts`).
     (The Privacy/Reliable toggle was rendered disabled here in 5a; it is now FUNCTIONAL — step 6d
     client side, see **Privacy mode + ICE** §.)
   - ✅ **5b** — link + QR methods. High-entropy one-time secret S in the URL fragment
     (scrub-after-read), token rendezvous (`codeType=token` — initially a 4-digit room; replaced
     with a high-entropy token rendezvous pre-deploy, see [methods.md](../architecture/methods.md) § link/qr method), channel-bound key-confirmation over S
     (`LINK_CONFIRM_DOMAIN`) — no PAKE, no SAS. qr = the same link via `qrcode` (generate) +
     `barcode-detector` ponyfill + `getUserMedia` (scan, with a paste fallback). `src/core/link/` +
     link/qr screens + `src/ui/qr.ts` + e2e (link happy / link wrong-secret / qr post-scan).
6. **Hardening**:
   - ✅ **6a — server cap/TTL/rate-limit for `filetransfer` rooms** — `managed: true` (TTL +
     per-IP rate-limit). TTL-until-connected freeing the code (4010 close / 4009 on a later join),
     per-IP create/join rate-limit (4011, loopback-exempt). Server-only change;
     hush-signaling-server `tests/room-server.test.ts`. **Correction (later pass):** the seat cap is
     codeType-dependent, NOT the `managed` flag — the 4-digit **room** rendezvous is a **mesh LOBBY**
     (`FILETRANSFER_MAX_PEERS`, default 8); the **words** AND (pre-deploy) the link/qr **token**
     rendezvous are strictly 1:1 (`ONE_TO_ONE_MAX_PEERS = 2`). The 4-digit lobby TTL is an **idle
     timeout** (re-armed on each join); the 1:1 words/token TTLs stay armed from CREATE. Also: **SAS UI
     role is now per-pairing by readable-id order**
     (`src/core/sasRole.ts`, projected as `connection.sasRole`, fail-closed restart on a missing id)
     so the lobby's joiner↔joiner pairs still get one reader + one picker. See **Signaling server**
     [claude-md-retired-sections.md](claude-md-retired-sections.md) § *Managed-room hardening* and room/SAS [methods.md](../architecture/methods.md) § *Server cap / TTL / rate-limit* + *SAS role*.
   - ✅ **6b — per-pairing transport/crypto role** — `this.role` (initiator/responder) is now fixed
     **PER-PAIRING from the readable ids** (`src/core/pairingRole.ts` `pairingRoleFor`, same id order
     as the SAS reader/picker; unit-tested in `pairingRole.test.ts`), NOT create/join. This breaks the
     joiner↔joiner deadlock (both `responder` → no WebRTC offer + SAS commit-reveal stall) for the
     mesh lobby: the WebRTC offer, CPace init, SAS nonce/commit order, and key-confirmation/enrollment
     `lv(role)` all follow it; reconnect's protocol role is the exception — from the DTLS
     fingerprints since 2026-09-25 (was create/join). 1:1 outcome unchanged. Foundation for the
     lobby-UI (next). See **Per-pairing role** §.
   - ✅ **6c — Room lobby UI (mesh roster + pick→connect)** — the room method no longer auto-pairs:
     creator AND joiners land in `awaitingPeer` (`joining → awaitingPeer`, no new state) and see a
     `LobbyScreen` — the 4-digit code + a roster (`connection.roster` = `{id, device, joinedAt}` from
     welcome/peer-joined) + a Connect button per peer. Pick → `pair-request`; the smaller id offers
     (per-pairing role 6b), glare/dedup handled, **busy-reject** returns the picker to the lobby with a
     clear notice (no hang). Works for ANY pair incl. **joiner↔joiner**. Signaling protocol grew:
     `welcome.peers` + `peer-joined` now carry `{id, device, joinedAt}` (coarse device label sent by
     the client, server-capped ≤32 + server-stamped joinedAt; the `device` label was removed again
     2026-09-27 — [claude-md-retired-sections.md](claude-md-retired-sections.md) § Signaling server). words/link/qr are NOT lobbies (auto-pair
     with one peer); reconnect is its own codeless method (own wait screen, auto-pairs). `LobbyScreen` +
     `pickPeer`/`onPairRequest`/`onBusy`; `tests/e2e/lobby.spec.ts` (joiner↔joiner + busy),
     `connectionSlice.test.ts` (roster), `room-server.test.ts` (roster protocol). See **Room lobby** §.
     **Deferred:** return-to-lobby after a finished/aborted session — see BACKLOG. (reconnect-in-lobby
     was superseded by the codeless reconnect on 2026-09-25; link/qr lobby-race resistance is done.)
   - ✅ **6d — TURN relay + Reliable / Max-privacy (STRICT) mode** *(DONE)* —
     **server side**: the signaling server mints short-lived HMAC coturn credentials on a
     `turn-request` frame (`use-auth-secret` scheme, `TURN_SECRET` shared with coturn + never sent to
     clients, empty-urls when unconfigured → direct-only); env `TURN_SECRET` / `TURN_URLS` /
     `TURN_CRED_TTL_S`; coturn deploy template — today hush-signaling-server `deploy/turn/`;
     `tests/turn-credentials.test.ts` there. **Client side:** the home
     **PrivacyToggle is functional** (persisted pref, default Max-privacy) and drives `iceServers` —
     **Max-privacy = STUN-only, never requests creds; Reliable = STUN + TURN**, creds fetched via
     `requestTurnCredentials` (`turn-request`) after `welcome` + before the PC, empty-urls → direct-only.
     `src/core/iceServers.ts` (builder, `VITE_STUN_URLS` STUN config) + `iceServers.test.ts`;
     `prefs.tsx` pref + `<PrivacyModeSync>` (App) → `setPrivacyMode`; `tests/e2e/privacy.spec.ts`.
     **Max-privacy strict model (this pass — was relax-retry, now strict):** Max-privacy NEVER relays —
     no consent escalation. The PeerConnection always drops the peer's `typ relay` candidates
     (`src/core/relax.ts` filter) and never requests TURN, so a live Max-privacy ICE failure is
     **terminal**: `onIceFailed` → `failDirect` → the existing `failed` state with a switch-to-Reliable
     hint (`directFailHint`, EN/RU; `direct-fail-hint` testid). The relax-offer / `connection.relax` /
     `relax` signaling frame / bilateral `relaxConnection`/`declineRelax` / `setConfiguration`+`restartIce`
     escalation were all **REMOVED** (this also removes the asymmetric-relax bug class, incl. the
     suspected Firefox mixed-privacy hang — gone by design). `src/core/relax.ts` (filter only,
     `relax.test.ts`), `FailedScreen` hint, `?forceIceFail=1` DEV knob, `tests/e2e/relax.spec.ts`. See
     **Privacy mode + ICE / Max-privacy strict model** §.
   - ✅ **6e — cross-browser pass** — the **no-device parts are DONE** (this pass): (1) the QR-scan
     WASM is **self-hosted** (vendored, served from `'self'`, no CDN — `src/ui/zxingWasm.ts`
     `createQrDetector` + `setZXingModuleOverrides` over a Vite `?url` asset; `zxingWasm.test.ts`;
     CSP CDN dropped), and (2) a **feature-detection / graceful-degradation review** confirmed every
     browser-API path degrades cleanly with a fallback/message: QR-scan (no `BarcodeDetector` →
     self-hosted zxing; camera denied/absent → paste fallback — added an explicit
     `navigator.mediaDevices?.getUserMedia` guard), file save (no FSA `showSaveFilePicker` → Blob
     fallback + size cap, rejected pre-accept), `navigator.locks` (cross-tab keystore lock → degrade
     to direct call), `navigator.share`/`crypto.subtle`/`indexedDB` (all guarded with fallbacks).
     **Real-device status:** Android Chrome verified 2026-10-02 (Pixel 5); **iOS Safari verified 2026-10-03
     on an iPhone 15** (iOS 26.6, driven by WebDriver): transport on the LAN, on LTE (Max fails closed with
     the hint, Reliable relays through coturn at 1.7 MB/s), site-storage receive to 2 GiB, QR scan + camera
     deny, share sheet, reconnect — [the 2026-10-03 run log](../test-runs/2026-10-03.md). One platform limit found: iOS Safari
     ends the connection on screen lock ([claude-md-retired-sections.md](claude-md-retired-sections.md) § Known residuals). TESTPLAN 47/47 closed 2026-10-03; Android
     Firefox was dropped by the owner (too rare a combination) and stays untested.
   - ✅ **6f — nginx deployment — LIVE at hushsend.frelikh.dev** — the config
     templates + runbook are built and committed: `deploy/nginx.conf.example` (TLS, 80→443, SPA
     `try_files $uri /index.html`, the `/ws` proxy with `proxy_set_header X-Real-IP $remote_addr;` +
     WS-upgrade + raised `proxy_read_timeout`, and security headers — HSTS / a build-tuned **CSP**
     [`'wasm-unsafe-eval'` for the QR-scan WASM, now **self-hosted** so `connect-src` lists no CDN —
     step 6e] / `Permissions-Policy camera=(self)`),
     the server env template and the coturn template (both in hush-signaling-server since 2026-10-03), and
     `deploy/DEPLOY.md` (step-by-step + inline gotchas). The only code change was an **additive startup
     `[config]` summary log** (no secrets) in `signaling-server.js`. Consolidated env reference:
     **[claude-md-retired-sections.md](claude-md-retired-sections.md) § Deployment / configuration above. **LIVE — first bring-up 2026-06-20 on a VPS
     (`frelikhmax.fvds.ru`), MOVED to the owner's home server 2026-08-16**, which is what serves it
     today (facts re-verified on the box 2026-09-12; **DEPLOY.md § 0 is the as-realized source of
     truth** — do not cite the old VPS): Ubuntu 26.04.1, nginx 1.28.3, **Node v22.22.1 system
     `/usr/bin/node`** (not nvm); frontend built on-server → `/var/www/hushsend/dist`; signaling = the
     SEPARATE universal repo `hush-signaling-server` (clone `~/projects/…`, **running copy
     `/var/www/hush-signaling-server`**) under systemd `hushsend-signaling` (`127.0.0.1:8080`,
     `User=frelikh`); **coturn on the SAME host, `turn:`-only on `:3478`** (no `turns:`/TLS); TLS =
     the box's **wildcard `*.frelikh.dev`** cert (certbot DNS-01), not a per-host webroot cert. The
     host is behind a **residential NAT**, so the router forwards 80/443 tcp + 3478 tcp/udp + the
     relay range 49160–49200/udp, and coturn needs `external-ip=<public>/<lan>` or the relay
     advertises a private address. The old `http2 on;` → `listen … ssl http2;` template fix was for
     the VPS's nginx 1.24 and no longer applies (1.28 accepts both; HTTP/2 is ON now — `curl` from the Mac negotiated `HTTP/2 200`, 2026-09-27;
     this line used to say OFF). External smoke ALL green (security headers/CSP, `/health`,
     `.wasm` as `application/wasm`, `/ws`→426 reaching Node, SPA fallback). The in-browser
     P2P/SAS/transfer test on two devices and the cross-network TURN relay check are DONE (6e real-device,
     2026-10-02/03 — [the 2026-10-02 run log](../test-runs/2026-10-02.md)). (link/qr high-entropy rendezvous = codeType=token, done pre-deploy.)

## Current state (as recorded until 2026-10-11)
- ✅ `src/core/crypto/` — `cpace` (CFRG draft-21 vectors passing), `keyConfirmation` (channel
  binding + MITM tests), `sas` (commit-before-reveal, HKDF-SHA512, fingerprint binding, timeouts,
  zod length checks), `identity` (Ed25519, WebCrypto non-extractable + noble fallback),
  `enrollment` (TOFU exchange + pin, channel-bound), `reconnect` (TOFU re-auth, codeless: the
  derived rendezvous token + time bucket, roles from the DTLS fingerprints, the hello MAC, the
  channel-bound signature under the pinned key + fresh challenges, two-check verify, key-change
  detection, the hello/proof/ok wire schemas). Words wordlist (EFF short #2) programmatic.
- ✅ `src/core/keystore/` — IndexedDB (+ in-memory backend for unit tests) behind
  `KeystoreBackend`; own identity key + pinned peer keys (`pairingId → peer key`). Cross-tab
  identity-generation single-flight via `navigator.locks`; "key changed" detection on reconnect.
- ✅ `src/core/words/` — `generateWords` (CSPRNG, rejection-sampled), rate-limit counter (≤10
  attempts), TTL handling (does not kill live P2P).
- ✅ `src/core/link/` — `link.ts` (pure): `generateLinkSecret` (16 CSPRNG bytes, base64url),
  `generateRendezvousToken` (the client-drawn token room the creator takes — join-or-create),
  `buildLinkUrl` (`<origin>/#<token>.<S>`), `parseLink` (strict: 22-char base64url rendezvous TOKEN +
  16-byte S, no throw; rejects an old 4-digit code). The rendezvous is a high-entropy token
  (`RENDEZVOUS_TOKEN_BYTES = 16`), so link/qr can't be enumerated/squatted. Used by the link/qr
  methods; the secret never reaches the server. (`link.test.ts`.)
- ✅ `src/core/livenessGate.ts` — pure `peerLeftAbortsPairing(established, channelOpen)` predicate
  (+ `livenessGate.test.ts`): a signaling `peer-left` aborts a pairing ONLY before the DataChannel
  transport is up. Backs the per-pair close-signaling-on-`connected` privacy feature
  (`SessionController.closeSignalingAfterConnect` + `this.channelOpen`) — applied to the `words`,
  `link/qr` AND `room/SAS` `onPeerLeft` branches (`SessionController.sasPeerLeft.test.ts` covers the
  SAS branch + the room per-pair close + reconnect's own close and peer-left gate) — see
  **[connection.md](../architecture/connection.md) § Signaling WS lifecycle**.
- ✅ `src/core/` — transport (SignalingClient, PeerConnection), file transfer (+ `transfer/opfs.ts`, the
  site-storage receive path; `transfer/streamDownload.ts` + `public/dl/sw.js`, the straight-to-Downloads
  path), SessionController
  orchestration (incl. SAS + post-connect enrollment wiring + the link/qr key-confirmation-over-S
  path, step 5b; **per-pair signaling-socket close on `connected`** — 1:1 methods via
  `tryVerifyConfirmation` AND room/SAS pairs via `trySasSettle`, both through
  `closeSignalingAfterConnect` (ALL methods, reconnect included) — with `peer-left` decoupled from P2P liveness —
  `livenessGate`). FSM in store (status, transitions,
  invariants enforced). The per-pairing
  transport/crypto role is fixed from the readable ids in `SessionController.beginPairing` via
  `src/core/pairingRole.ts` `pairingRoleFor` (smaller id = initiator; same id order as
  `sasRole.ts`; `pairingRole.test.ts`) — drives the WebRTC offer, CPace init, SAS nonce/commit
  order, and key-confirmation/enrollment `lv(role)`; reconnect's protocol role comes from the DTLS
  fingerprints instead (`reconnectRoleFor`). The codeless reconnect's wait logic (derive the token,
  re-take it at bucket boundaries / before the TTL / on a server close, give up with a clear reason)
  lives in `reconnectTo` / `takeReconnectRendezvous` / `rejoinReconnectRendezvous`
  (`SessionController.reconnectRendezvous.test.ts`, fake signaling + fake timers).
  Pre-PC WebRTC signals (offer/answer/ICE arriving for the active pairing while `this.peer` is null —
  e.g. a Reliable answerer still awaiting coturn creds in `startPeer`) are buffered in
  `pendingPeerSignals` and replayed by `flushPendingPeerSignals` after the PC is built, then cleared on
  every teardown — the **mixed-privacy / link-qr deadlock fix** (`SessionController.pendingPeerSignals.test.ts`;
  see **Privacy mode + ICE** §). The post-connect loss path — `onConnectionLost` (every loss signal
  after `established`), `onPeerInterrupted` + the `INTERRUPT_GRACE_MS` backstop, `closeOnPageHide` — is
  described in [transfer.md](../architecture/transfer.md) § File transfer → *Liveness after connect* (`SessionController.connectionLost.test.ts`).
- ✅ `src/core/relax.ts` — Max-privacy STRICT relay enforcement (step 6d + the 2026-09-12 audit fix;
  pure + `relax.test.ts`): the relay-candidate predicate (`isRelayCandidate`/`shouldDropCandidate` —
  Max-privacy ALWAYS drops the peer's `typ relay` candidates, off in Reliable) AND the
  selected-path check that closes the peer-reflexive bypass (`relayCandidateEndpoint`/`endpointKey`
  record what was dropped; `selectedRemoteCandidate` reads the selected pair out of a `getStats()`
  report across engine shapes; `isForbiddenRemoteCandidate` is the verdict). The live wiring (filter +
  endpoint recording in `PeerConnection.addIce`; `openChannelUnlessRelayed` gating `onOpen` at
  channel-open; `onIceFailed` → `failDirect` → the existing `failed` state with a switch-to-Reliable
  hint) is in PeerConnection + SessionController. **Max-privacy never relays** — the relax-offer / `connection.relax`
  / `relax` signaling frame / `relaxConnection`/`declineRelax` / `restartIce`-over-relay machinery was
  removed (strict model, this pass).
- ✅ `src/ui/` — **real, status-driven screens, REDESIGNED 2026-09-26 from the Claude Design canvas**
  ([ui.md](../architecture/ui.md) § UI / styling has the reference, the rules and the gates), built on kit tokens + the kit's
  `controls.css` / `theme-toggle.css` / `layout.css` (monochrome, inversion-as-emphasis, light/dark via
  `[data-theme]`, English only — the RU table is kept, the switch hidden). `ScreenRouter` picks a screen by
  FSM status (+ method), paced ([ui.md](../architecture/ui.md) § UI / styling → Screen pacing); `HomeScreen` (h1, the **Max privacy / Reliable radio group** — step 6d, drives
  `iceServers` — Invite someone → the method picker [Link or QR code / Code words / Room], the room code
  form, Enter code words → `WordPicker`, Scan a QR code → `ScanScreen`, a **Reconnect section** listing
  paired devices with a per-device Reconnect [`session.reconnectTo(pairingId)`, no code shown or typed]
  and a per-device × [`recentDevices.forgetDevice` — removes every pin of that peer key] plus the global
  "Forget pinned devices" [`resetIdentity` + history `forgotten`], and "About privacy and security" as
  three `<details>` items), `ReconnectWaitScreen` (the reconnect's `awaitingPeer`: two dots meeting +
  "Waiting for the other device", deliberately no code and no token), `LobbyScreen` (step 6c — the room
  mesh lobby: the 4-digit code as the hero + Copy code + the roster [`connection.roster`] as tap-target
  rows → `pickPeer`, the busy reply as a notice line), `WordsCreateScreen` (five numbered words, the
  attempt line after a wrong guess, no copy), `ShareScreen` (link AND qr: the QR + the link + Copy link +
  Share — `LinkCreateScreen` / `QrCreateScreen` are merged into it), `ScanScreen` (qr receive: camera in
  the viewfinder + the paste-link fallback), `ConnectingScreen` (creating/joining/pairing/confirming,
  only when a stage outlasts the hold, with the paced stage title — a Max-privacy ICE failure routes to the Failed screen with a switch-to-Reliable hint, NOT a relay offer;
  step 6d STRICT), `SasScreen` (**asymmetric pick-from-3**: reader shows its phrase as the largest text
  in the app + the HEARD sentence above the confirm; picker is blind among the real + 2 local decoys as
  aria-pressed cards — role from the SAS material, `connection.sasRole`; the refusal on both sides is a
  quiet pill of the confirm's geometry, not a label; fail-closed "verification interrupted / Restart
  verification" on a missing role, rendered through the Failed layout),
  `TransferScreen` (the heading "Secure channel open" + sr-only `auth-state`; the path check as
  disclosure rows only in the non-ok states; the file zone + Choose files, the picked list, Send; ONE
  row per transfer with its progress; incoming Accept / Decline; delivered / declined / cancelled /
  error inside the same container, then **"New transfer"** [`new-transfer-btn`] which
  resets the per-transfer projection through `session.resetTransfer()` → a CLEAN ready-to-send per
  send, never touching the connection or the history; **Save file** [`save-file-btn`] when a received
  file finished while the page was hidden; the `interrupted` alert line while ICE is `disconnected`;
  the muted `relayed` path row),
  `FailedScreen` (ONE screen, variants by reason + method — mismatch (one title; the description names
  the cause THIS side saw: the peer's SAS reject, our own, a words key-confirmation, or the generic
  check), `waitExpired` (our OWN words / link / room ran out while we waited in it with nobody engaged —
  `WAIT_EXPIRED_REASON`, since 2026-09-29; it used to get the joiner's "check the digits"), expired, `server` (a signaling
  drop that is not a room answer, 1006 above all; it used to read "Room not found"), noShow, direct (on a
  desktop Mac + the macOS Local Network permission hint, `ui/platform.ts`),
  `lost` (an authenticated channel died — shows the last file's outcome, `LastTransfer` /
  `last-transfer`, with Save file when one is held), generic. **Nothing is said twice** (owner,
  2026-09-27): no eyebrows, a description only where it adds something, the raw reason shown only for
  `generic` and `lost` and kept on the container as `data-reason` for tests; `FailureLayout`
  (`data-testid="failure"`, `data-variant`) is shared with the SAS restart; the reconnect key-changed
  hard stop inverts the whole viewport via `hs-app--inverted` set in `App.tsx`). The link fragment auto-join + scrub lives in
  `App.tsx` (`LinkFragmentJoin`), and so does the `pagehide` goodbye (`PageHideGoodbye`). Shared `ui.tsx` (Glyph, Space/Grow, Pill on the kit's `.pill`,
  TextLink, IconButton, AlertLine, Collapsible, Disclosure, MeetDots, CopyPill, SharePill, TopBar with
  the kit theme toggle, Wordmark, StatusBeacon, Screen, Kicker), `components/` (`WordPicker` — five
  fields, listbox on touch / inline completion on pointer; DEV-only `Diagnostics`), `qr.ts` (link→SVG QR
  via `qrcode`; `qr.test.ts`), `prefs.tsx` + `i18n.ts` (lang/theme/**privacy mode**, the last pushed
  into the core via `<PrivacyModeSync>` → `setPrivacyMode`; `translate` falls back to `en`),
  `sasOptions.ts` (+ `sasOptions.test.ts`: SAS pick-from-3 decoys + scoring) over `random.ts` (CSPRNG),
  `recentDevices.ts` (paired devices read from the keystore, **deduped by `peerPublicKey`** —
  `dedupeByPeerKey`, ONE row per distinct peer key keeping the most-recent pin whose `pairingId` drives
  the reconnect tap — plus `forgetDevice(peerPublicKey)`, which removes EVERY pin of that key so a
  stale sibling cannot resurface as a row; `recentDevices.test.ts`). **Transfer history is
  SESSION-ONLY** — an in-memory Redux slice (`src/store/historySlice.ts`), NOT persisted (file names are
  a privacy trail; gone on reload), kept **bounded** (`HISTORY_CAP = 12`) + **clearable** (`forgotten`,
  via the home "forget"); the per-send transfer reset does NOT clear it (`transferSlice.test.ts` /
  `historySlice.test.ts`). localStorage holds **only prefs** (lang/theme/privacy mode); there is no
  `persistence.ts`. The `dev` store slice stays as the auxiliary projection feed (identity pubkey /
  pinned peer / public DTLS fingerprints / **ICE config** / log) the SessionController publishes; all
  fields are serializable + non-sensitive (RTK `serializableCheck` stays ON), and the DEV-only
  `Diagnostics` is what surfaces them (display gated behind `import.meta.env.DEV`). `main.tsx` also
  exposes `window.__hsStore` / `__hsKeystore` in DEV only, for the visual and a11y gates.
- ✅ Server — signaling, corrected `clientIp()`, word + token rendezvous allocation (`codeSpec`).
  **Managed-room hardening (done — 6a)** for ALL `filetransfer` rooms (`managed: true` → TTL + per-IP
  rate-limit). **Seat cap is codeType-dependent (NOT `managed`):** the 4-digit **room** rendezvous is a
  **mesh LOBBY** (`maxPeers` = `FILETRANSFER_MAX_PEERS`, default 8); the **words** AND link/qr **token**
  rendezvous are strictly 1:1 (`ONE_TO_ONE_MAX_PEERS = 2`); a joiner past the cap → 4002. The **token**
  codeType (`tokenCode`, `TOKEN_RE` validator, 22 base64url chars) is **join-or-create** (since
  2026-09-25): the client TAKES a token and the first arrival opens the room — link/QR (a random
  token) and the codeless reconnect (a token derived from the pairing secret) look identical to the
  server. **TTL until connected** frees the code (4010 close; a later 4-digit/word join → 4009; a
  token can simply be taken again): the 4-digit lobby TTL is an **idle timeout** (`ROOM_TTL_MS`,
  re-armed on each join via `makeTtlTimer`); the 1:1 words AND token TTLs are armed once when the
  room comes into being (`WORD_ROOM_TTL_MS` / `TOKEN_ROOM_TTL_MS`, no re-arm). Per-IP
  create/join rate-limit unchanged (`IP_RL_MAX` / `IP_RL_WINDOW_MS`, 4011, loopback-exempt), creator
  destroy. `clipboard` mesh opts out. **TURN creds (6d, server side — done):** `turn-request` →
  `turn-credentials` mints short-lived HMAC coturn creds (`use-auth-secret`; `TURN_SECRET` shared with
  coturn + never sent to clients; empty-urls when unconfigured → direct-only); env `TURN_SECRET` /
  `TURN_URLS` / `TURN_CRED_TTL_S`. Ready for deployment behind nginx + a separately-deployed coturn
  (hush-signaling-server `deploy/turn/`).
  (hush-signaling-server `tests/` — `room-server.test.ts`, `word-room-server.test.ts`,
  `turn-credentials.test.ts`, `turn-relay.test.ts`.)
- ✅ `src/ui/zxingWasm.ts` — self-hosted QR-scan WASM (step 6e): `createQrDetector` lazily imports
  the `barcode-detector` ponyfill and `setZXingModuleOverrides({ locateFile })` it to a Vite `?url`
  asset (`zxing-wasm/reader/zxing_reader.wasm?url`, fingerprinted into `dist/assets`, same-origin)
  so the fallback decoder never fetches from a CDN. `zxingWasm.test.ts` proves the wired `locateFile`
  resolves to `'self'`, never jsdelivr/fastly. ScanScreen consumes it.
- 📋 Pending: step 6 — **6d DONE**; **6e no-device parts DONE** (self-hosted QR WASM +
  feature-detection review + **cross-ENGINE e2e**: `tests/e2e/interop.spec.ts` launches two real
  browsers per test and runs link-pairing + a hashed transfer across chrome/firefox/webkit in both
  directions — run it with `E2E_SIGNALING_PORT=… npx playwright test`, engines absent from the host
  skip with a printed reason; the WHOLE suite also runs per engine as its own project —
  chromium/firefox/**webkit** 40/40 each (count as of 2026-09-26) — where **webkit needs
  `E2E_STUN_URLS` on a headless host**:
  it cannot disable mDNS obfuscation, so without a STUN server its only host candidate is
  `<uuid>.local` and two of its tabs never pair. plus a `mobile-webkit` project (WebKit + the iPhone device descriptor) that is the ONLY place the
  UA-selected mobile receive cap runs, and an opt-in size ladder, `tests/e2e/limits.spec.ts`); **6f LIVE** — deployed + externally verified at hushsend.frelikh.dev
  (coturn same-host `turn:`-only :3478; signaling = separate repo under systemd; see DEPLOY.md § 0);
  the real-device pass (in-browser P2P/SAS/transfer on two devices + cross-network TURN relay) is DONE —
  **TESTPLAN.md** 47/47 as of 2026-10-03; what is left is nice-to-haves and the pre-launch items, tracked
  in **BACKLOG.md** / **THREATMODEL.md**.
- 🔒 **SECOND audit pass, 2026-09-12 — fully malicious server. Three complete breaks found and
  FIXED**, plus a persistent pre-auth hole: (1) SAS **certificate grinding** — the commit covered only
  the nonces, so a relay could grind its own certificates after both nonce exchanges and make both
  humans read the SAME phrase (reproduced in 4.25 s); fixed by holding every nonce reveal until the
  fingerprints are pinned (`maybeRevealSasNonce`). (2) **Server-chosen roles** — both `pairingRoleFor`
  and `sasRoleFor` ordered server-assigned ids that appear in no transcript, so the server could make
  both peers the blind picker; the SAS split now comes from the SAS material (`sasReaderIsFpMin`).
  (3) **Re-entrant `welcome`** flipped `this.role` mid-handshake, turning key-confirmation's role label
  into a tag-reflection oracle (words without the words, link/qr without S); `onWelcome` is now
  once-only. (4) **Enrollment ran pre-auth**, planting pins and leaking the long-term identity key;
  now gated on `established` with a held-and-replayed frame and first-write-wins pinning. Also: three
  DEV knobs that shipped live are gated, the RECEIVE side of the no-bytes gate is closed, SDP-embedded
  relay candidates are stripped, renegotiation after channel-open is refused, the step-1
  unauthenticated path is deleted, protocol strings are length-bounded, the 1:1 confirm path got its
  own liveness deadline, and the SAS refusals carry the same weight as the confirms (kept through
  the 2026-09-26 redesign — see [ui.md](../architecture/ui.md) § UI / styling). Regressions in
  `SessionController.auditFixes.test.ts` + `sasRole.test.ts` + `relax.test.ts`. Full write-up in
  **[security-audits.md](security-audits.md) § Security audit / Second pass**; of its two open items, path attestation is built
  (advisory) and the `pairingId` disclosure is closed structurally by the codeless reconnect
  (2026-09-25: nothing is announced any more).
- 🔍 **Internal security-audit pass done 2026-09-12** (reasoning + code review, no devices): the
  reconnect create/join role (since replaced by fingerprint-order roles behind the hello gate,
  2026-09-25 — [security-audits.md](security-audits.md) § Security audit (a)) and the `peerLeftAbortsPairing` narrowing both held
  (with sharper arguments recorded); the **Max-privacy strict relay claim did NOT** — a peer-reflexive candidate
  could still complete a relayed path in a mixed-privacy pair, **now fixed** by the selected-path check
  above ([privacy-and-ice.md](../architecture/privacy-and-ice.md) § Max-privacy strict model). Verdicts, the remaining findings, and the doc corrections they
  forced are in **[security-audits.md](security-audits.md) § Security audit**. An INDEPENDENT audit is still wanted before a public
  launch.
