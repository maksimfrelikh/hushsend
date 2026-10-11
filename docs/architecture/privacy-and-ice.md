# Privacy modes, ICE and path attestation

Part of the architecture reference — [README.md](README.md) is the index.

## Privacy mode + ICE (Max-privacy / Reliable — step 6d, DONE)
*(Separate privacy lever — server learns no session duration: for the 1:1 methods the client closes its
signaling socket on `connected`. See **[connection.md](connection.md) § Signaling WS lifecycle**. The toggle below is unrelated — it
only governs `iceServers`.)*

The home **"Max privacy" toggle is FUNCTIONAL** and drives the WebRTC `iceServers` (the only transport
behaviour behind it). It is a persisted UI pref (`prefs.tsx`, `hushsend.privacy`, **default `max`**),
pushed into the core via `<PrivacyModeSync>` (App) → `SessionController.setPrivacyMode`. The mode is
**read at pairing start** (when `iceServers` are assembled), so flipping it mid-session affects the
**NEXT** connection, NOT the live one. **Max-privacy is STRICT — it NEVER relays** (no consent
escalation): a live Max-privacy ICE failure is **terminal** (→ `failed` + a switch-to-Reliable hint),
see **Max-privacy strict model** below.
- **Builder** (`src/core/iceServers.ts`, pure + unit-tested in `iceServers.test.ts`):
  `buildIceServers({mode, stunUrls, turn})`.
  - **Max-privacy (`max`, default)**: `iceServers = [{urls: <STUN>}]` (or `[]` if no STUN) — **STUN
    only, NO TURN, and creds are NEVER requested** (the relay is never contacted; the peer sees your IP).
  - **Reliable (`reliable`)**: `[{urls: <STUN>}, {urls: <TURN urls>, username, credential}]` — STUN +
    TURN, so a pair that can't connect directly relays through coturn (the relay carries only
    E2E-encrypted bytes). It does NOT hide your IP from the PEER — we signal our srflx candidate in
    every mode, so the peer learns the address whichever pair ICE selects; the relay moves the ROUTE
    (the peer's ISP sees coturn, not us — THREATMODEL § 4), not what the peer is told. TURN is added **ONLY when the fetched `urls` is
    non-empty** — empty urls (TURN undeployed) ⇒ STUN-only (we IGNORE username/credential then; relay
    availability is keyed off `urls.length`, never off a credential being present).
- **STUN config**: build-time `VITE_STUN_URLS` (comma-separated → array; `parseStunUrls`). Empty in
  dev/test = no STUN (two loopback tabs use host candidates).
- **NO built-in / third-party ICE fallback (invariant).** `PeerConfig.iceServers` is **required** and
  `PeerConnection` has **no default** — `buildIceServers()` is the ONLY source. A built-in public STUN
  would leak the client's public IP to a host we don't control on every connection, contradicting the
  threat model, so there is nothing to fall back to; `[]` (no ICE servers at all — dev/loopback, or
  Max-privacy with no STUN configured) is a legitimate value and is passed explicitly. (A dead
  `DEFAULT_ICE_SERVERS = stun:stun.l.google.com` fallback lived in `PeerConnection.ts` until it was
  removed: unreachable in the app, but it still shipped as a string in `dist/` — found in a bundle
  audit at deploy. Never reintroduce an implicit default.)
- **Cred fetch (Reliable only)**: `SignalingClient.requestTurnCredentials()` sends `{type:'turn-request'}`
  and awaits the zod-validated `{type:'turn-credentials', urls, username, credential, ttl}` reply (the
  untrusted relay — validated before use). Fetched **after** the WS is up (`welcome` arrived) and
  **before** the PeerConnection is created, so TURN is in `iceServers` from the first ICE candidate:
  `SessionController.ensureTurnReady()` is kicked off at the START of `beginPairing` (runs in parallel
  with CPace/SAS) and `startPeer` awaits the SAME memoized fetch before building the PC. Never throws —
  a closed socket / timeout / absent relay resolves to **NO_TURN (empty urls)** → direct-only. Creds are
  reset per session (`openSignaling`) since they are bound to the live socket.
  **Empty urls is now PROJECTED to the user** (`connection.relayUnavailable`, set from
  `ensureTurnReady`; added 2026-09-19): Reliable silently degrading to direct-only was visible ONLY in
  the DEV diagnostics log, which is tree-shaken out of production — so a user who picked Reliable FOR
  the fallback got Max-privacy connectivity with no indication, and the failure that followed read as
  ordinary bad luck. `FailedScreen` renders `relayUnavailableHint` (EN/RU, testid
  `relay-unavailable-hint`) so the failure names the missing fallback. Always false in Max privacy,
  which never requests creds. `SessionController.relayUnavailable.test.ts` pins it, with both negative
  controls (a relay that IS there, and Max privacy). The built ICE config is
  published to the DEV diagnostics (`dev.iceConfig` — mode/relay/urls/username/credential) for the e2e.
- **Pre-PC WebRTC-signal buffer (mixed-privacy / link-qr deadlock fix)**: because `startPeer` `await`s
  `ensureTurnReady()` BEFORE building the PeerConnection, a **Reliable-mode answerer** is still fetching
  coturn creds when a **Max-privacy offerer**'s offer arrives — so `this.peer` is null and the offer used
  to hit the `this.peer?.handleSignal` no-op in `onSignal` and be **silently dropped** (deadlock). Fix:
  `SessionController.pendingPeerSignals` buffers WebRTC offer/answer/ICE that arrive for the ACTIVE
  pairing (past the `from === this.peerId` gate) while `this.peer` is null, and `startPeer` REPLAYS the
  queue in arrival order right after building the PC (`flushPendingPeerSignals`); ICE that races ahead of
  the offer is re-buffered by the PC's own `pendingIce`, and `setRemoteDescription` doesn't depend on
  `iceServers`, so the "TURN in iceServers from the first candidate" invariant is intact. The buffer is a
  level ABOVE `pendingIce` (whole signals, not just ICE) and is **method-agnostic** — it lives in the
  shared WebRTC tail of `onSignal`, so it closes BOTH the room and the latent link/qr race (words is
  unaffected: its offer is serialized behind the CPace gate, so the PC is already up). CLEARED
  (`clearPendingPeerSignals`) on EVERY teardown/reset/retry — `resetPairingToLobby`, `teardownPeerOnly`
  (words retry), `failLink`, `failSas`, `failReconnect`, `failDirect`, `dispose` — so a stale signal from
  a finished attempt can never replay into the next attempt's PC. Unit-tested deterministically in
  `SessionController.pendingPeerSignals.test.ts` (controllable `ensureTurnReady` + mock PeerConnection:
  offer-while-`peer===null` is buffered → creds resolve → PC built → offer replayed → answer emitted; and
  `resetPairingToLobby` empties the queue).
- **Tests**: `iceServers.test.ts` (builder: max→STUN-only/empty, max ignores TURN, reliable+creds→STUN+TURN,
  reliable+empty-urls→STUN-only, default=max never relays); `tests/e2e/privacy.spec.ts` (toggle renders +
  flips + default max; Max-privacy still connects directly with no TURN; Reliable fetches creds via
  `turn-request` and assembles a correct TURN iceServer — the relay itself is not run, both modes connect
  over loopback). Server `turn-credentials` minting is **done (6d server side)** — see Signaling server §.

### Max-privacy strict model (done — completes 6d)
**Max-privacy NEVER relays. Period — no consent escalation, no relay-retry.** Two always-on mechanisms
enforce it in Max-privacy, then a direct failure is **terminal**:
- **No local TURN** — Max-privacy never requests coturn creds, so we never offer a relay candidate
  (`ensureTurnReady` is a no-op off Reliable).
- **Strict relay-candidate filter** — the PeerConnection **DROPS the peer's incoming `typ relay` ICE
  candidates** (`PeerConnection.addIce` → `shouldDropCandidate` / `isRelayCandidate`, the only thing
  left in **`src/core/relax.ts`**), so a relay candidate the peer SIGNALS is never added on our side.
  The filter is **fixed at construction** (`filterRelay = privacyMode === 'max'`) — Max-privacy never
  flips it. In Reliable the filter is off (relay allowed).
- **Selected-path check at channel-open (added 2026-09-12 — closes the audit finding).** Mechanisms 1+2
  are NOT sufficient alone: they cover candidates we ADD, not the ones ICE **learns**. A peer relaying
  through coturn sends its connectivity checks FROM the relayed address, and RFC 8445 §7.3.1.3 has our
  agent learn that address as a **peer-reflexive** candidate and pair with it — the same address we
  just dropped as `typ relay`. It bites only when the direct path fails (otherwise the direct pair wins
  on priority), i.e. exactly the case this model exists for, and only in a **mixed-privacy** pair
  (Max ↔ Reliable; Max ↔ Max has no relay anywhere). So the PeerConnection now **verifies the path it
  actually got**: every dropped relay candidate's endpoint is remembered (`relayCandidateEndpoint` →
  `droppedRelayEndpoints`), and at DataChannel open — **BEFORE `onOpen` reaches the SessionController**
  — `openChannelUnlessRelayed` reads `pc.getStats()`, resolves the selected pair
  (`selectedRemoteCandidate`, engine-agnostic: transport `selectedCandidatePairId` → Firefox
  `selected` → nominated+succeeded → succeeded) and refuses via `isForbiddenRemoteCandidate` when the
  remote is typed `relay` OR sits on a dropped endpoint. A refusal takes the SAME terminal path as a
  direct ICE failure (`onIceFailure` → `onIceFailed` → `failDirect` + hint) and `onOpen` never fires,
  so **no byte can cross a relayed path**. A `prflx` remote we never dropped is ALLOWED — legitimate
  NAT mappings produce those on genuinely direct paths.
  **Unavailable/empty stats ⇒ REFUSE (changed 2026-09-13, finding F1).** This used to read "unknown,
  not relay — we never tear down a working connection over a missing API", and that was the hole:
  `selectedRemoteCandidate` returns null until ICE publishes a selection, so the gate waved through
  every path it had simply not looked at yet. Its own docstring already said a caller must read null
  as unknown NEVER as safe, and the condition is real — `SessionController.verifyPath` needed a 5 s
  poll for exactly this, and runs LATER in the session than the gate. So the rule is now POSITIVE:
  **open only on a path established to be direct.** `relax.classifySelectedPath` polls for a
  judgement (`SELECTED_PAIR_TIMEOUT_MS` 15 s — it shipped as 5 s, the constant's comment says why it
  was raised to match `PATH_ATTEST_TIMEOUT_MS` / `SELECTED_PAIR_POLL_MS` 100 ms), retrying on a null read
  so a transient `getStats()` rejection does not decide the session, and anything still
  `undetermined` at the deadline is refused down the same terminal path as a relay. Measured
  2026-09-13: chromium, firefox and webkit each report a selected pair on the FIRST read at
  channel-open (0–1 ms, 3/3 runs per engine), so a healthy connection never waits and the deadline is
  insurance, not latency. `relax.test.ts` covers both pure halves **and the policy** (including the
  reproduction of the old wave-through); the browser-side confirmation is **TESTPLAN § C4**.
  - **Residual:** the check runs at channel-open. A mid-session ICE **re-nomination** onto a learned
    relay path (e.g. the direct path dies later) is not re-checked — noted in [security-audits.md](../history/security-audits.md) § Security audit.
- **ICE-fail → terminal `failed` + hint**: an ICE failure (`iceconnectionstatechange` /
  `connectionstatechange` → `failed`) while filtering routes to `onIceFailed` (one-shot), which calls
  `failDirect(DIRECT_FAIL_REASON)` → close + `fail()` → the **existing `failed` state** (no new FSM
  state). The `FailedScreen` classifies the reason from its text (like the MITM / room-not-found cases)
  and renders the hint **"Couldn't connect directly. Switch to Reliable to allow relaying through a
  server."** (i18n `directFailHint`, EN/RU; testid `direct-fail-hint`). In Reliable an ICE failure is a
  genuine `onClose` → `failed` (relay was available and still couldn't save it — no hint).
  `DIRECT_FAIL_REASON` (`"couldn't connect directly (Max privacy)"`) is the stable marker the screen
  keys off (`/connect directly|max privacy/`).
- **A pre-transport `peer-left` during a Max-privacy direct attempt ALSO ends as the direct failure
  (since 2026-10-03).** In a Max ↔ Reliable pair across two NATs both ICE agents time out ~15 s after
  `connecting`; when the PEER's gives up first its socket closes and its `peer-left` reaches us before
  our own `failed`, and the Max side used to read "peer left during pairing" — fail-closed, but without
  the one actionable line (TESTPLAN C3 on the Pixel 5, 2026-10-02: the hint showed or not depending on
  who lost the race). `SessionController.peerLeftWhileDirectAttempt()` (Max privacy + a PeerConnection
  in flight + channel not open + not established) routes the link/qr, room/SAS and reconnect
  `onPeerLeft` branches through `failDirect(DIRECT_FAIL_REASON)`; **words is excluded** (its peer-left
  is a counted guess with its own retry copy). Unit: `SessionController.sasPeerLeft.test.ts`.
- **No relax-offer / bilateral / relax signal**: there is NO consent-gated relay escalation. The
  `connection.relax` projection, the `relax` signaling frame, `relaxConnection`/`declineRelax`, and the
  `pc.setConfiguration`/`restartIce` ICE-restart-over-relay were all **removed**. This also removes the
  whole class of asymmetric relax bugs (incl. the suspected Firefox mixed-privacy hang — the failure
  mode is gone by design: a Max-privacy side that can't go direct fails fast instead of half-relaxing).
- **DEV/TEST knob**: `?forceIceFail=1` (DEV-gated, like `forgeReconnectKey`) makes the PeerConnection
  treat ICE as failed AND suppress its own candidates, driving the Max-privacy-direct-failure path in
  e2e without a real network failure.
- **Tests**: `relax.test.ts` (the relay-candidate filter: drops `typ relay` only while filtering, off
  in Reliable, safe on null/empty); `tests/e2e/relax.spec.ts` (`forceIceFail` Max-privacy → both sides
  reach `failed` with the `direct-fail-hint`, no relay offer, no hang). Reliable's relay actually
  carrying bytes is hush-signaling-server's **`tests/turn-relay.test.ts`** (2026-09-19): it spawns a real coturn
  in the production `use-auth-secret` mode, spawns the signaling server with the SAME secret, mints
  over the WebSocket exactly as the client does and drives `turnutils_uclient` with the reply, so the
  one cross-service invariant — `TURN_SECRET` == coturn `static-auth-secret` — is checked rather than
  assumed. Its NEGATIVE CONTROL mints under a different secret and requires the same relay to refuse
  it (coturn answers `Cannot complete Allocation`), which is what stops the check from passing against
  a relay with authentication switched off. CI installs coturn on every push and sets
  `REQUIRE_RELAY_TEST=1`, which turns "coturn missing" from a skip into a hard failure.
  **Measured ceiling (2026-09-19)** — a real relay-only `RTCPeerConnection` pair through the LIVE
  coturn, selected pair confirmed `relay`/`relay`, hushsend's own chunking + backpressure: **3.84 MB/s**
  of payload reached on loopback, **1.86 MB/s** via the public name (the home router hairpins BOTH
  legs, so every byte crosses it twice), against **24.81 MB/s** for the same benchmark on a local
  coturn with `max-bps=0`. So coturn's `max-bps=5000000` is what binds on a fast path, deliberately —
  it is still far above a residential uplink, which is what will bind a real cross-network pair.
  Numbers + the capacity note (~41 concurrent allocations from the 49160-49200 port range, NOT the
  1200 `total-quota` advertises) are in [test setup](../test-setup.md) § 0.3.

## Path attestation (`src/core/pathAttest.ts`) — who is actually on the wire
Authentication answers "is this my peer?"; attestation answers **"is the traffic going to them?"**.
The audit established that no candidate filter can answer the second one: ICE credentials ride the
SDP the untrusted server relays, so it can answer our connectivity checks itself and inject its own
`typ host` candidate at its own address — and a client cannot tell that from the peer's, because the
peer's real address is only ever learned FROM the server. The relay filter (`relax.ts`) refuses
`typ relay`, which stops an honest peer's TURN path, not a server that never offers one.

So the claim moves onto a channel the attacker does not control, exactly as the DTLS fingerprint
binding already does for identity. On `established` each side sends
`{kind:'path-attest', addrs}` over the **authenticated** DataChannel (`startPathAttestation`) and
checks that the remote address ICE actually selected for it (`PeerConnection.selectedRemoteAddress`,
from `getStats()`) appears in the peer's set (`pathVerdict`). An interposer's address is in neither
peer's set, so it is named by the very peer it is impersonating. A forwarding attacker has two moves
and both are caught: pass the real addresses through (→ `mismatch`) or drop the frame (→ nothing
arrives → the 15 s deadline fails the session). A TERMINATING attacker never reaches here — the
fingerprint binding stops it at the SAS / key-confirmation step.

- **Verdicts.** `ok` (selected address attested), `unknown` (nothing to judge on — no selected
  address, or an engine that reports no usable candidates), `mismatch` (checked, and the address we
  selected is in neither of the peer's), and since 2026-09-27 **`relayed`** — decided BEFORE the address
  check from the selected pair's candidate types (`relax.selectedPairRelayed`: our local candidate or
  the peer's remote one is `relay`). Through a TURN relay the address check passes honestly (the
  relayed peer names its relay address), so `ok` used to say "direct path confirmed" about a relayed
  session — proven on Chrome ↔ the Android emulator. Reliable mode only (Max privacy refuses a relayed
  path at channel-open); shown as the muted row "relayed through the server". **All four are advisory:
  none tears anything down.** This
  bullet used to end "`mismatch` → terminal, same teardown as an authenticity failure", which the code
  has never done — and two audits read past it because it was phrased as a specification. Corrected
  2026-09-13 (finding F4) together with the two call-site comments that claimed the attestation
  "gates file bytes".
- **Projection (changed 2026-09-13, finding F2).** The verdict now reaches the USER three-way as
  `connection.pathCheck`, not two-way. It used to be collapsed to `pathConfirmed: 'yes' | 'no'`, so
  `mismatch` — the only positive evidence of an interposer this system can produce — rendered
  identically to `unknown`, the everyday outcome on Safari, under a hint whose stated cause ("this
  browser does not expose enough to check it") is false on a mismatch. Since the DEV diagnostics that
  hold the real verdict are tree-shaken out of production, that left the detection with no
  representation anywhere a user could see it. `mismatch` now has its own label
  (`⚠ route did not match`), its own weight (`hs-badge--alert`) and its own copy, which names BOTH
  causes — honest NAT/Safari quirk, or someone carrying the connection — and gives an action, rather
  than accusing. Still projected DEV-only in full as `dev.pathVerdict` / `dev.pathSelected`
  (`path-verdict` / `path-selected` testids); the user-facing badge carries `data-path-verdict`.
- ⚠️ **ADVISORY — it does NOT tear down and does NOT gate bytes.** It was built as a control (fail
  closed on `mismatch`, gate `sendFiles`/`acceptIncoming`) and the gate was REMOVED after a
  firefox↔webkit pair on one LAN failed it reproducibly **with no attacker present**. The cause is
  structural, not a bug: WebKit cannot disable mDNS obfuscation of host candidates, so it only ever
  offers `<uuid>.local`, its peer learns its real address peer-reflexively, and WebKit therefore
  **cannot attest to the address it was actually reached on**. That is what real Safari does,
  including iOS. A control that fails closed there breaks honest transfers on a primary target
  platform — worse than the leak it closes. Measured, not assumed: with the gate in place
  `interop · firefox → webkit` failed reproducibly, and on the RE-TEST after the "wait for ICE to
  select a pair" fix it failed **intermittently, one run in two** — which is worse, not better, since
  a spurious "someone is in between" both destroys an honest transfer at random and trains the user
  to dismiss the warning that matters. Without the gate, 9/9 interop + 96/96 engine tests pass.
- **What it buys today: evidence.** The verdict is logged and projected, so the real-device pass can
  record what each engine actually reports — precisely the input needed to decide whether this can
  become a control (e.g. by having each side attest the address it SELECTED and checking that against
  our own, which inverts who needs to know what). Tracked in [security-audits.md](../history/security-audits.md) § Security audit.
- **Other limits, stated not hidden.** Address only, never the port — plenty of honest NATs vary
  the port per destination, so comparing ports would reject working connections; an attacker sharing
  the peer's IP is therefore not caught. And it rests on the peer's own view of its addresses, which
  for srflx comes from STUN — **the same operator**. An operator that both lies over STUN *and* sits
  on the path can still make the two sides agree; the way to remove that is to stop being the STUN
  provider.
- Pure halves unit-tested in `pathAttest.test.ts`; `tests/e2e/privacy.spec.ts` asserts a real pair
  reaches `ok` on every engine — `unknown` is allowed, so a broken implementation would otherwise
  look exactly like a working one.
