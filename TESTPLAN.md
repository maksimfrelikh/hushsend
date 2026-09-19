# hushsend — real-device test pass (step 6e)

Everything that can be verified without physical devices is done (unit + integration + Playwright
e2e across four engine projects, feature-detection review, self-hosted QR WASM); what remains is
**behaviour on real browsers, real networks, and real NAT**.

This used to open "the last open item before the security audit" — the audit has since run twice
internally (2026-09-12 and 2026-09-13, BACKLOG § Security audit), so that ordering is gone: the
device pass is now the last open item before a public launch, not before the audit. **Progress: 0 of
the 45 A–F cases have been run.** The two ticks in § 0.1 are PRECONDITIONS, not cases; do not read
them as progress.

- **Target:** the live deploy — `https://hushsend.frelikh.dev` (production build).
- **Scope closes:** BACKLOG § Step 6 / 6e "Remaining (real devices, post-deploy)" and DEPLOY.md § 0
  "Still pending" (in-browser P2P/SAS/transfer on two devices + cross-network TURN relay).
- **Out of scope:** the three deferred security-audit items and lobby-pick reconnect (BACKLOG
  § Security audit). Do not mix reconnect with a plain room join except where a case says so.

> **Plan currency.** Cases B7, B8, C6 and E6 were added on 2026-09-18 for behaviour that landed
> after this plan was first written (STUN cross-check, the network-exposure disclosure, volume
> padding, and the reconnect early-frame fix). If you are reading this after further changes, check
> `git log --oneline -- src/` against the date above before trusting the coverage: a device pass that
> silently skips a new feature is worse than one that has not run.

## 0. Read this before starting

**The production build has no in-app diagnostics.** `Diagnostics` is `import.meta.env.DEV`-gated and
so is every DEV knob — 13 query params (`?forceBlob=1`, `?forceIceFail=1`, `?forcePathMismatch=1`,
`?forceRelayPath=1`, `?forgeReconnectKey=1`, `?gateDelayMs=N`, `?maxAttempts=N`, `?preSasTimeoutMs=N`,
`?reconnectTimeoutMs=N`, `?sasTimeoutMs=N`, `?signalingUrl=…`, `?stallReconnect=1`,
`?stallSasNonce=1`) and their 13 `__HUSHSEND_*__` global twins. **Verify this rather than assume it**
— the 2026-09-12 audit found three of them (`maxAttempts`, `forceBlob`, `__HUSHSEND_MAX_BYTES__`)
shipping live in the deployed bundle because they lacked the gate their siblings had, and this very
paragraph asserted otherwise.

**Grepping for a knob's NAME is what cries wolf.** `forceIceFail`, `forceRelayedPath` and
`gateDelayMs` are ALSO `PeerConfig` field names, so they survive minification as class fields
(`B(this,"gateDelayMs")`) and as the properties `SessionController` hands `PeerConnection` — carrying
the constant `false`/`0` that the tree-shaken reader now returns. The name proves nothing either way;
what proves it is that the READER is gone. Two commands against the SERVED bundle, not the source:

```bash
grep -roE '__HUSHSEND_[A-Z_]+__' /var/www/hushsend/dist/assets/
```

Must print nothing. No production path touches those globals, so a single survivor means some knob
kept its whole body. Then:

```bash
grep -ohE 'URLSearchParams|location\.search' /var/www/hushsend/dist/assets/*.js | sort | uniq -c
```

Must print **exactly `1 URLSearchParams` and `1 location.search`**. Every knob reads the query string,
and production reads the URL in exactly two places: `SignalingClient.connect`, building the socket's
query (`app` / `room` / `codeType` / `device`), and the link-join scrub that rewrites the address to
`pathname + search` to strip the secret fragment. A third occurrence is a knob that shipped.

Last run 2026-09-19: no globals, and 1 + 1. **Re-run it after any deploy** — do not trust this line. Every build renames the bundle, so naming a hash here only guarantees the note goes stale; what the host is serving right now is
`grep -o 'index-[^"]*\.js' /var/www/hushsend/dist/index.html`. So:

- **Failure injection is NOT available on prod** — those paths are covered by e2e. This pass observes
  *real* behaviour only. If a fault path needs driving deliberately, do it against `npm run dev`
  locally, not against the live host.
- Observation comes from browser devtools + server logs (§ 0.2).

### 0.1 Preconditions

- [x] Frontend redeployed from current `main` (`bash ~/projects/hushsend/deploy/deploy-frontend.sh`)
      — re-done 2026-09-19; `/var/www/hushsend/dist` is byte-identical to the local build and serves
      `index-CXiHn4Vx.js`. **Re-run it if `main` has moved since**, and re-tick. It had gone stale
      once already (ticked 2026-09-12, `main` moved, nobody re-ticked) — this tick is only worth the
      date next to it.
- [x] **Verify the new bundle is live:** `grep -r 'stun.l.google' /var/www/hushsend/dist` returns
      nothing — re-confirmed 2026-09-19 (the pre-2026-09-12 bundle matched; this was the BACKLOG
      "verify after redeploy" item). The only STUN in the served bundle is
      `stun:turn.hushsend.frelikh.dev:3478`, i.e. our own — which is also the whole of BACKLOG's
      "separate the STUN server" item: one operator still holds app, signaling and STUN.
- [ ] Hard-refresh every test device (Ctrl/Cmd+Shift+R; on iOS: close the tab and reopen) so no
      device runs the cached old bundle. Confirm the asset hash in devtools matches the deployed one.
- [ ] `curl -s https://hushsend.frelikh.dev/health` → `ok`; nginx / hushsend-signaling / coturn all
      `active`.
- [ ] **The relay actually relays:** `bash deploy/verify-relay.sh` → OK. `coturn` being `active` does
      NOT mean Reliable mode works — if its `static-auth-secret` and the signaling server's
      `TURN_SECRET` have drifted, the mint still succeeds and only the allocation fails, so case C5
      (cross-network relay) would fail for a reason that has nothing to do with the devices in front
      of you. Verified 2026-09-19: 16 messages relayed, 0 lost.
- [ ] **Hairpin NAT check** — the box is behind a residential NAT, so LAN devices reach the public
      hostname only if the router hairpins. Open the site on one LAN device and one LTE device before
      starting; if a LAN device cannot load it, that is a router issue, not an app bug.

### 0.2 How to observe

| What | Where |
|---|---|
| Selected ICE candidate pair (`host` / `srflx` / **`relay`**) | Chrome: `chrome://webrtc-internals` · Firefox: `about:webrtc` |
| iPhone Safari console/network | macOS Safari Web Inspector over USB (iPhone: Settings → Safari → Advanced → Web Inspector) |
| Android Chrome console/network | `chrome://inspect` from a MacBook over USB (phone: Developer options → USB debugging) |
| **Android Firefox** console/network | `about:debugging` → *This Firefox* → *Setup* in DESKTOP Firefox — **not** `chrome://inspect`, which only sees Chromium. Slot AND-2 is Firefox and B3/B5 name it, so without this those two have no way to be observed at all |
| Signaling frames + WS lifecycle | devtools → Network → WS → Messages |
| Server side | `sudo journalctl -u hushsend-signaling -f` |
| Relay actually used | **The `relay` candidate pair in webrtc-internals is the primary evidence.** `sudo journalctl -u coturn -f` does NOT work here — the live config sets `no-stdout-log` with no `log-file=`, so journalctl carries only service start/stop (checked 2026-09-19). Sudo-free corroboration during a relayed transfer: `ss -uan` filtered to ports 49160-49200 shows coturn's relay ports bound on 192.168.1.19 — verified against a live allocation. Real session logs need a `log-file=` + `verbose` added and coturn restarted |

### 0.3 Reference numbers (from the code, for judging "expected")

- Receive path: **FSA streaming (`showSaveFilePicker`) = unbounded**; otherwise **Blob in RAM**, capped
  at **1 GiB desktop / 512 MiB mobile** (UA-based), and the cap is rejected **before** accept.
  **Measured engine ceilings** (2026-09-12, `limits.spec.ts` with the cap lifted, on a Mac):
  Chromium OK at 1 GB and 2 GB, **fails at 3 GB** (`download.saveAs: canceled`); WebKit OK to 1.5 GB,
  **fails at 1.75 GB** (freezes near 100%). Both die at the END — the chunks arrive, the single Blob
  does not — and **neither raises a catchable error**, so the desktop cap is deliberately far below.
  B2 below is what tells us whether the MOBILE cap is equally well placed; nothing else can.
- Chunk size: the SCTP-negotiated max clamped to **[16 KiB, 256 KiB]**; backpressure via `bufferedAmount`.
- Deadlines (all **120 s**): pre-SAS pairing, SAS confirmation, reconnect re-auth, **and the 1:1
  key-confirmation wait** (words / link / QR — added 2026-09-12; before it, that path had no client
  deadline at all and depended on the untrusted server's room TTL to rescue it).
- Path attestation: advisory, **15 s** to hear the peer's attestation. Never tears anything down.
- **Relay throughput (Reliable mode), measured 2026-09-19** against the live coturn with a real
  relay-only `RTCPeerConnection` pair (`iceTransportPolicy: 'relay'`, selected pair confirmed
  `local=relay remote=relay`), hushsend's own wire settings (ordered channel, 256 KiB chunks, 1 MiB
  high-water drain):
  | path | throughput |
  |---|---|
  | live coturn via `turn.hushsend.frelikh.dev` (router hairpins BOTH legs) | **1.86 MB/s** (14.9 Mbit/s) |
  | live coturn reached on loopback (router out of the client leg) | **3.84 MB/s** (30.7 Mbit/s) |
  | control: local coturn with `max-bps=0` | **24.81 MB/s** (198.5 Mbit/s) |

  So on a fast path the binding constraint is coturn's own **`max-bps=5000000`** (confirmed in
  `/etc/turnserver.conf`), not the WebRTC stack — the uncapped control is ~6.5× faster. The hairpin
  halves it again because every byte crosses the router twice (client→coturn, coturn→client). C5 is
  a CROSS-NETWORK case, so neither number is the one you will see there: expect the slower peer's
  uplink to bind long before 5 MB/s does. Use these to tell "the relay is slow" apart from "this
  link is slow". At the loopback figure the 1 GiB desktop cap takes ~4.7 min end to end.
- **`TURN_CRED_TTL_S` (3600 s) bounds when a relayed transfer may START, not how long it may RUN**
  — measured 2026-09-19, because the opposite reading is the natural one and would have made every
  transfer slower than ~2.4 Mbit/s unsafe at the 1 GiB cap. Drove a relayed transfer with a
  credential deliberately expiring after **20 s**: it delivered **70 MB over 388 s**, and coturn's log
  shows the session's `CREATE_PERMISSION` + `CHANNEL_BIND` renewal at **t=242 s** (before the 300 s
  permission lifetime) accepted with that same expired username, plus `REFRESH` accepted at t=22 s in
  a shorter run. The expiry gates the INITIAL authentication only; relayed data itself rides bound
  channels with no per-packet auth. So a long relayed transfer does not die at the one-hour mark.
  *(An earlier attempt at this test stalled and looked like a finding — it was an artifact: forcing
  `permission-lifetime=30` outran Chromium's refresh cadence, which is built for the 300 s default.
  Run it with DEFAULT lifetimes or the result means nothing.)*
- **Relay capacity: ~41 concurrent allocations**, not the 1200 `total-quota` advertises — coturn
  takes one UDP port per allocation from `min-port=49160..max-port=49200` (live config, verified
  2026-09-19), and a relayed pair where BOTH sides relay costs two. `user-quota=12` is also a
  per-SECOND bucket rather than per-user here, because the signaling server mints the username as
  the bare expiry second with no per-user part.
- Words: **4 secret words** + 1 rendezvous word (~41 bits of secret), **≤10 pairing attempts**;
  the words room TTL runs **from create** and is never re-armed (`WORD_ROOM_TTL_MS`, 180 s).
- Lobby: 4-digit code, up to **8 peers** (`FILETRANSFER_MAX_PEERS`); words/link/QR rendezvous are
  strictly **1:1** (a second joiner is bounced with 4002).
- Room TTL: idle timeout, **re-armed on each join**; words/token TTL runs from create. Expiry → 4010
  close, a later join → 4009 `room not found`.
- Per-IP rate limit **60 create/join per minute** → 4011 `too many attempts`. Several test devices
  behind one public IP share that bucket — a spurious 4011 during a heavy session is the limiter, not
  a bug. Wait a minute.
- Transfer history is **session-only** (in-memory, max 12, gone on reload).

### 0.4 Device inventory (fill in)

| Slot | Device | OS version | Browser + version | Engine | Driven by | Expected receive path | Expected QR decoder |
|---|---|---|---|---|---|---|---|
| MBP-A | MacBook | | Chrome | Blink | Claude (MCP) | FSA streaming (unbounded) | native/ponyfill |
| MBP-A | MacBook | | Brave (shields up) | Blink | Claude (MCP) | FSA streaming | native/ponyfill |
| MBP-A | MacBook | | Safari | **WebKit (the real one)** | Claude (MCP) | Blob (1 GiB cap) | zxing ponyfill |
| MBP-A | MacBook | | Firefox | Gecko | Claude (MCP) | Blob (1 GiB cap) | zxing ponyfill |
| MBP-B | MacBook | | Chrome | Blink | Claude (MCP) | FSA streaming | native/ponyfill |
| IPH | iPhone | | Safari (WebKit) | WebKit + phone limits | Claude via Safari Web Inspector (USB) | Blob (512 MiB cap) | zxing ponyfill |
| AND-1 | Android | | Chrome | Blink | Claude via `chrome://inspect` (USB) | Blob (512 MiB cap) | native BarcodeDetector |
| AND-2 | Android | | Firefox | Gecko | Claude via `about:debugging` (USB) | Blob (512 MiB cap) | zxing ponyfill |

Three engines, not four browsers: Blink (Chrome, Brave, Android Chrome), Gecko (Firefox ×2), WebKit
(Safari ×2). Brave earns its row for hardening (B9), MBP-B for a second FSA endpoint (F4).

### 0.5 How this pass is actually run — three tracks

This plan was written for a human holding the devices. It is now run mostly **through Claude Code**:
desktop browsers it drives directly, plus **real handsets attached over USB** — iPhone through Safari
Web Inspector, Android through `chrome://inspect` (both already in § 0.2). A real handset is the point:
an iOS Simulator would give real WebKit but the Mac's RAM, no camera and the Mac's network, which
silently falsifies B2, B3/B4 and the whole of Phase C.

So the useful split is not "automated vs manual" but **who has to be physically present for the
evidence to exist**:

- **T1 — Claude Code alone, across ALL THREE desktop engines.** Chrome, Brave, Firefox and Safari
  are driven over MCP, so this track is not "a browser" — it is the real engine matrix:
  **Blink** (Chrome, Brave), **Gecko** (Firefox), **WebKit** (Safari). Claude opens the pages, drives
  the flow, reads console / Network / `chrome://webrtc-internals` / `about:webrtc`.
  Two things follow, and they are the reason this track got much stronger:
  **(a) desktop Safari is REAL WebKit.** Everything headless has said about WebKit so far came from
  Playwright's WebKitGTK on Linux, which is a different port — and the one open question I would most
  want answered is WebKit-shaped: the Max-privacy gate refuses any path it cannot classify, so an
  engine whose `getStats()` does not publish a selected pair does not connect *at all*. Desktop Safari
  answers that without a handset. It is not a full substitute for iOS Safari (no phone memory limits,
  no cellular NAT), but it is the difference between a proxy and the real thing.
  **(b) Brave is Blink — it adds no engine.** It is worth running for its HARDENING, not its renderer
  (see B9), and nobody should read four browsers as four engines.
- **T2 — real device attached; Claude drives and observes, you perform ONE named physical act.**
  Point the camera, toggle a radio, lock the screen, tap an OS permission prompt, click a native save
  dialog. Everything after that act is Claude's to drive and read.
- **T3 — your eyes.** What Web Inspector cannot see or judge at all: OS-level UI (the native share
  sheet) and ergonomics (are tap targets truly reachable, is anything clipped on a real 390 px screen).

| Track | Cases | Count |
|---|---|---|
| **T1** — Claude alone, closes the case outright | A4a, A4b, A6, A7 · B7, B9 · D1–D5 · E1–E5 · F3, F5, F6, F7 | 20 |
| **T1 + T2** — T1 closes the DESKTOP half on real engines; the handset half is a separate tick | A1, A3, A4, A5, A6a · B2, B8 · E6 · F2, F8 | 10 |
| **T2** — needs one physical act from you | A2 · B1, B3, B4 · C1–C6 · F1, F4, F9 | 13 |
| **T1 + T3** — T1 closes the desktop half; the rest is your eyes | B5 (native share sheet) · B6 (phone ergonomics) | 2 |

**Two ticks, not one, for every case in the split rows.** A1 says "MBP-A Chrome → IPH Safari". With
desktop Safari on MCP there is now a second, genuinely valuable run of the same case —
**Chrome ↔ Safari on the Mac, Blink against real WebKit** — which Playwright covers only through
WebKitGTK. That run is worth doing and worth recording, and it does not tick the handset half. Log
both: `A1 · T1 · Chrome↔Safari desktop · PASS` and later `A1 · T2 · MBP-A Chrome↔IPH Safari · PASS`.

The case this reshapes most is **A6a (path attestation per engine pair)**. Its whole purpose is the
table BACKLOG needs to decide whether attestation can ever become a control, and the only real-engine
datum so far is "firefox↔webkit on one LAN says `mismatch` with no attacker present". Three real
desktop engines in six pairings, all drivable by Claude in one sitting, is most of that table.

Your physical acts, in full — this is the entire manual surface of the pass:
point the camera at a QR (A2, B3); tap **Deny**, then **Allow**, on the camera prompt (B4); click the
native save dialog (B1, F4); turn Wi-Fi off / cellular on, and back (C1–C6, F9, and the real-radio
variants of F2, F8); lock the phone or switch apps mid-transfer (F1); look at the share sheet (B5) and
at a real phone screen (B6).

**The traps — all three are the same trap this project keeps hitting: a tick that outran its evidence.**

1. **A case that names a device pairing is not closed by running its mechanism on the desktop.** A1
   says MBP-A Chrome → IPH Safari. Running link-pairing Chrome↔Chrome under T1 proves the mechanism
   and catches regressions; it does **not** tick A1. Tick it when the named pairing ran.
2. **Record WHICH pairing produced each tick**, next to the tick. Six weeks from now "A1 ✅" tells you
   nothing, and § 0.3's measured numbers are only comparable against a stated setup.
3. **T1 is a rehearsal as much as a result.** Run it first: it costs minutes, it closes 18 cases
   outright, and it means the handset session is spent on what only a handset can answer instead of on
   discovering a broken build.

---

## Phase A — same-network happy path (all 4 methods) · mostly T1; A2 needs the camera

Both peers on the home Wi-Fi, default **Max-privacy**. Baseline: if these fail, nothing below matters.

- [ ] **A1 · link** — MBP-A (Chrome) creates a one-time link → send it to IPH (Safari) out of band →
      IPH opens it. Expected: auto-join, pairing, `connected` with **no SAS screen** (link/QR
      authenticate over the link secret), URL fragment scrubbed from the address bar.
- [ ] **A2 · QR** — MBP-A shows the QR, IPH scans it with the in-app scanner. Expected: same as A1.
      Note which decoder ran (§ B3).
- [ ] **A3 · words** — MBP-A creates, IPH enters the rendezvous + the 4 secret words. Expected: `connected`
      after CPace + key confirmation, no SAS screen.
- [ ] **A4 · room / SAS** — MBP-A creates a 4-digit room, IPH joins → both land in the **lobby**, MBP-A
      presses Connect on the IPH row. Expected: **SAS screen is asymmetric** — one side shows its
      phrase (reader), the other picks blind among 3 (real + 2 decoys). **Which side reads is not
      predictable and must not be** (changed 2026-09-12): it is derived from the SAS material, not
      from the creator and no longer from the id order, precisely so the untrusted server cannot make
      BOTH peers the blind picker. Just check that **exactly one** side reads and the other picks —
      re-pair a few times and expect the roles to land differently. Correct pick → `connected`.
- [ ] **A4a · the SAS refusal is reachable and equal-weight** — on the picker screen confirm
      "None of these match — stop" is a full-width button, not a faint link, and on the reader screen
      that the warning ("only continue once you have HEARD your peer say these words back") is
      legible on a phone. Tap the picker's refusal: expected **both** sides end in the
      "channel may be compromised" hard stop, no transfer UI on either.
- [ ] **A4b · the reader can still stop after confirming** — reader taps "They read it back correctly"
      BEFORE the picker answers, then taps the abort on the waiting screen. Expected: the session
      fails closed. (A reject is accepted even after our own approval, up to settle — a reader who
      clicked too early must not be trapped.)
- [ ] **A5 · transfer both ways** — over the A1 connection send a small file (≈5 MB) MBP-A → IPH, then
      IPH → MBP-A. Expected: progress advances monotonically, file arrives intact (**check the size and
      open it**), receiver's terminal plaque shows a **"New transfer"** button.
- [ ] **A6 · WS closes on connect** — in devtools Network → WS, confirm the signaling socket **closes
      shortly after `connected`** for all of A1–A4 **and for reconnect (Phase E)**, while the transfer
      keeps working afterwards. This is the per-pair privacy close: the server must not observe the
      session duration. Reconnect was the last exemption and was folded in on 2026-09-12 — if its
      socket stays open, that regression is the whole point of checking it here.
- [ ] **A6a · path attestation never blocks a transfer** — it is ADVISORY. On every pair, especially
      a Safari↔non-Safari one, confirm the transfer completes regardless of the verdict. A `mismatch`
      here is EXPECTED between engines (see § Phase B) and must stay cosmetic; if a transfer is ever
      refused or torn down because of it, that is a bug, not a detection.
- [ ] **A7 · multi-file** — send 3 files at once. Expected: all arrive, progress is per-transfer, no
      stale filename from the previous send after "New transfer".

## Phase B — browser capability matrix · mixed: B7/B9 are T1, the camera and phone-RAM cases are T2

The point of 6e: every fallback path on a real engine, not a polyfilled test env.

> **Record the path-attestation verdict on EVERY pair you make in this pass.** The DEV diagnostics
> strip shows `path-verdict` / `path-selected` / `path-peer-addrs` (they are dev-only, so read them
> against `npm run dev`, not the live host). Attestation is ADVISORY precisely because we do not yet
> know what real engines report: a firefox↔webkit pair on one LAN says `mismatch` with no attacker
> present, because WebKit cannot attest to the address it was reached on. What this pass needs is the
> table — for each pair (same-network and cross-network, each engine combination): the verdict, what
> each side selected, and what each side attested. That decides whether the check can become a
> control, and in which direction. See BACKLOG § Security audit / Path attestation.

> **The phone-shaped half is pre-covered too** by `tests/e2e/mobile.spec.ts` (WebKit + an iPhone
> device descriptor): the 512 MB cap is genuinely selected by the phone UA and quoted in the refusal,
> the Blob path completes, the layout holds at 390 px, and the QR paste fallback works. So on a real
> handset those are re-confirmations; what only the handset can answer is **memory pressure at the
> cap, background-tab suspension (§ F1), camera permissions (B4) and cellular NAT (§ C)**.
>
> **Already pre-covered headlessly** by `tests/e2e/interop.spec.ts` (chrome ↔ firefox ↔ webkit, both
> directions, link pairing + a hashed 200 KB transfer): cross-engine SDP/ICE/DTLS/SCTP interop and the
> Blob receive path. So B1–B2 below are confirming on real hardware rather than discovering; **B3–B5
> are the ones that can only be answered here** — a headless box has no camera, and Playwright's
> WebKit on Linux is not Safari on iOS.

- [ ] **B1 · FSA streaming (Chrome desktop)** — receive on MBP-A Chrome. Expected: a **save dialog
      appears on accept** (inside the click gesture), bytes stream to disk, RAM does not grow with the
      file (watch Activity Monitor on a ≈2 GB file).
- [ ] **B2 · Blob fallback + cap** — receive on IPH Safari and on MBP-A Firefox. Expected: no save
      dialog; the file lands via a download at the end. Then offer a file **over the cap** (>512 MiB to
      IPH, >1 GiB to MBP-A Firefox): the receiver must **refuse before accepting**, with a clear
      message naming the limit — never accept and then die of OOM mid-transfer.
- [ ] **B3 · QR scan + self-hosted WASM** — scan on IPH Safari and AND-2 Firefox (the ponyfill path).
      Expected: scanning works, and in Network the WASM is fetched from
      `https://hushsend.frelikh.dev/assets/zxing_reader-*.wasm` with `Content-Type: application/wasm`.
      **Nothing may be requested from `jsdelivr` / `fastly` / any third-party host** — that is the whole
      point of the 6e vendoring. Also scan on AND-1 Chrome (native `BarcodeDetector`; no WASM fetch at all).
- [ ] **B4 · camera permission denied** — on IPH, deny the camera prompt. Expected: a clean
      **paste-the-link fallback**, no crash, no dead screen. Re-allow and confirm the scanner recovers.
- [ ] **B5 · share / copy** — on IPH and AND-1 the **Share** button uses the native sheet; on MBP-A
      Firefox (no `navigator.share`) it must be **absent**, with Copy still present and working.
- [ ] **B7 · STUN cross-check verdict per engine — NEW 2026-09-17, and the device pass is what
      decides it.** The client asks every configured STUN server what our public address is, using one
      throwaway PeerConnection per server, and compares (`core/stunCheck.ts`). Read `stun-verdict` /
      `stun-addresses` in the DEV strip on EVERY engine in the matrix. **This needs two STUN URLs in
      `VITE_STUN_URLS`** — with one it is `unknown` by design and the case proves nothing. Exact setup,
      worked out 2026-09-19 (two flags cost a while to find: coturn REFUSES to start with
      `--allow-loopback-peers` unless the admin CLI is secured, and its default pidfile is unwritable
      as a normal user):

      ```bash
      # 1. two loopback STUN servers (NOT 3478 — the live coturn owns that here)
      for P in 3479 3480; do
        turnserver -n --listening-ip=127.0.0.1 --listening-port=$P \
          --no-auth --no-tls --no-dtls --no-cli --pidfile= --log-file=stdout &
      done
      # 2. a LOCAL signaling server that trusts the dev origin
      NODE_ENV=development HOST=127.0.0.1 PORT=8191 DEV_ORIGINS=http://localhost:5291 \
        node server/signaling-server.js &
      # 3. the dev build, pointed at BOTH of the above
      VITE_SIGNALING_URL=ws://127.0.0.1:8191 \
      VITE_STUN_URLS=stun:127.0.0.1:3479,stun:127.0.0.1:3480 \
        npx vite --port 5291 --strictPort
      ```

      Verified end to end 2026-09-19: the page loads, the DEV strip renders, and `stun-verdict` reads
      **`agree`** with no console errors — so a `unknown` in this case is a real result about the
      engine, not a broken harness.

      **`npm run dev` on this host does NOT work, and fails in a way that wastes an hour.** Vite's
      default 5173 is held by an unrelated app, so it silently moves to 5174; the client's dev default
      signaling URL is `ws://localhost:8080`, which is the **live production** signaling server; and
      production runs with an empty dev-origin allowlist, so every socket is closed with
      **4003 `origin not allowed`** and the app just never connects. Hence all three explicit ports
      above — the same host-safe pair the e2e suite uses (8191 / 5291).
      Expected on chromium and webkit: `agree`, with a real address. **Firefox measured `unknown`
      headlessly** — it reported no server-reflexive candidate and exposes no `url` on local
      candidates — but that was on LOOPBACK, where the reflexive address equals the host address and
      is legitimately pruned. **Whether Firefox can answer on a real network is an open question only
      this pass can settle**, and it decides whether the feature covers two engines or three. Record
      the verdict, not just pass/fail.
- [ ] **B8 · the network-exposure disclosure renders — NEW 2026-09-13.** On the landing, the collapsed
      "What your network can still see" block (testid `network-exposure`) must be present, **closed by
      default**, readable in EN and RU, and open on tap on a phone. It states the two things
      cryptography does not hide (cleartext SNI; the direct connection to your correspondent) and the
      Tor/VPN-on-both-sides advice. Check the text is not clipped at 390 px — it is the longest prose
      in the app.
- [ ] **B6 · theme / language / layout** — check the app in light+dark and EN+RU on the iPhone and on a
      MacBook: no clipped text, no horizontal scroll, tap targets reachable, the 4-digit code and word
      slots legible.
- [ ] **B9 · privacy-hardened browser (Brave, shields up) — NEW 2026-09-19.** Brave is Blink, so it
      adds **no engine coverage** — it is here for its HARDENING. This product's users skew towards
      hardened browsers, and Brave ships WebRTC defaults Chrome does not: shields, fingerprint
      randomisation, and a **WebRTC IP-handling policy** that can withhold local and/or
      server-reflexive candidates. Since Max privacy is STUN-only and refuses to relay, a browser that
      withholds srflx has nothing left to pair on. Run **A1 (link) and A5 (transfer) with shields UP at
      the default setting, in BOTH privacy modes.** Expected: it connects, or it fails **visibly** with
      the switch-to-Reliable hint — a silent hang is the bug. Record the WebRTC policy setting and
      which candidate types were gathered (`chrome://webrtc-internals`). If Max privacy cannot gather
      an srflx there, that is a real-world limit to state in the README, not a defect to fix: the
      strict model is doing exactly what it promises.

## Phase C — cross-network + privacy modes (the part only real networks can prove) · entirely T2

IPH (or AND-1) on **LTE with Wi-Fi off**, MacBook on the home Wi-Fi.

- [ ] **C1 · Max-privacy direct across networks** — both sides default Max-privacy, link method.
      Expected either (a) `connected` via a `srflx` candidate pair — confirm in webrtc-internals that
      the selected pair is **not `relay`** — or (b) if the NATs won't traverse, a **terminal `failed`
      screen with the "switch to Reliable" hint**. Both are correct; a **hang is not**. Record which.
- [ ] **C2 · Reliable relay** — both sides switch to **Reliable**, repeat. Expected: `connected`; in
      webrtc-internals the selected candidate pair is **`relay`**, and coturn logs show an allocation
      from both peers. Then **transfer a ≈50 MB file over the relay** and note throughput — this is the
      only test that proves coturn's `external-ip` / port-forwarding config is actually right.
- [ ] **C3 · mixed privacy (regression)** — one side **Max-privacy**, the other **Reliable**. Run it in
      **both directions** (swap which side creates, so each side gets to be the offerer) and on **both
      the room and the link method**. Expected: **no deadlock** — this is the `pendingPeerSignals` fix
      (a Reliable answerer still fetching TURN creds used to silently drop the offer). Either it
      connects directly, or the Max-privacy side fails closed with the hint — never a stuck "agreeing
      on keys".
- [ ] **C4 · Max-privacy never relays — verifies the 2026-09-12 audit fix.** During C3 confirm on the
      Max-privacy side that **no `turn-request` frame is sent** (devtools → WS → Messages). Then force the
      DIRECT path to fail while the peer stays Reliable (easiest: put both on mobile networks, or use a
      restrictive Wi-Fi) and read the Max side's **selected candidate pair** in `chrome://webrtc-internals`.
      Expected: **terminal `failed` + the switch-to-Reliable hint**, and no relayed selected pair. The
      audit found that ICE can LEARN the peer's relay address as a `prflx` candidate even though we drop
      the signalled `typ relay` one; the fix refuses such a path at channel-open, before any byte. So:
      **`failed` ⇒ the fix works**; a **connection whose selected remote candidate is `relay`, or `prflx`
      at the peer's TURN address, means the gate did not catch it** — capture the full candidate-pair
      table and reopen BACKLOG § Security audit / Findings.
      Worth pairing with a control: the same Max ↔ Reliable run where the direct path DOES work must
      still connect normally (the gate must not reject a legitimate `prflx` from a NAT mapping).
- [ ] **C6 · volume padding, and what it costs on a real link — NEW 2026-09-17.** In Max privacy the
      transfer is padded so its byte count lands on a bucket edge instead of naming the file
      (`core/transfer/padding.ts`): powers of two below 1 MiB, then ≤12.5% overhead. Send a **300 KiB**
      file (ladder: → 512 KiB, a 70% jump no chunking accident could produce) and a **~50 MB** file
      over **LTE**, in Max privacy. Expected: both arrive byte-identical, and the received file is the
      REAL size — the filler is never written. In `chrome://webrtc-internals` the data-channel
      `bytesSent` should show the padded volume, not the file size.
      **What this case is really for is the cost.** Headless tests prove the arithmetic; only a real
      cellular link shows whether the overhead is acceptable to someone paying per megabyte. Record
      the wall-clock and the byte counts for both sizes, padded vs the file. If the small-file case
      feels slow on LTE, `PAD_FLOOR` / `BUCKETS_PER_OCTAVE` are the two constants to reconsider — that
      is a product decision the numbers should inform.
- [ ] **C5 · mobile-to-mobile** — IPH (LTE) ↔ AND-1 (different LTE / other Wi-Fi), Reliable. The
      carrier-NAT-to-carrier-NAT case the desktop pair never exercises.

## Phase D — room lobby (mesh) · entirely T1

- [ ] **D1 · roster** — MBP-A creates a room; IPH, AND-1, AND-2 join. Expected: every member sees the
      others with a sane device label and join order; leaving a device removes its row.
- [ ] **D2 · joiner ↔ joiner** — IPH connects to AND-1 (neither is the creator). Expected: it pairs and
      completes SAS normally. The TRANSPORT role (who offers) still comes from the id order, which is
      why this case exists; the SAS reader/picker split no longer does (see A4), so check here too
      that exactly one side reads.
- [ ] **D3 · busy reject** — while IPH↔AND-1 are paired, MBP-A presses Connect on IPH. Expected: MBP-A
      gets a clear **busy notice and returns to the lobby** — no hang, no silent failure.
- [ ] **D4 · two independent pairs** — pair IPH↔AND-1 and MBP-A↔AND-2 **in the same room**, then
      transfer on both at once. Expected: both work; neither pair's per-pair signaling close disturbs
      the other; the room survives.
- [ ] **D5 · SAS mismatch** — on a fresh pair, deliberately pick the **wrong** phrase. Expected: a hard
      failure with a clear message; no transfer possible afterwards.

## Phase E — reconnect (its own by-code path — do not route it through the lobby) · T1, except E6 on a real link

- [ ] **E1 · pin created** — after any successful fresh pairing (A1–A4), both devices list the peer
      under recent devices, **once** (the dedup-by-peer-key fix — pair the same two devices 3 times and
      confirm still exactly one row).
- [ ] **E2 · reconnect happy path** — on MBP-A press **Start** on the IPH row (it opens a room + shows a
      code); on IPH use **Join** and enter that code. Expected: `connected` **without any SAS screen**
      (pin-based re-auth), then transfer works.
- [ ] **E3 · both press Start** — expected: two separate rooms, no rendezvous, and the UI's split hint
      makes that obvious. Confirm it is understandable, not a mystery hang.
- [ ] **E4 · mismatched entry fails closed** — one side **Start (reconnect)**, the other joins the same
      code via the **regular room join**. Expected: the reconnect side ends in **`failed` within ~120 s**
      (the liveness deadline), NOT an endless "agreeing on keys". Time it.
- [ ] **E6 · reconnect over a SLOW link — the case the 2026-09-17 race lived in.** An early
      `reconnect-init` used to be dropped for good when it arrived before the receiving side had
      processed channel-open, leaving both peers in "agreeing on keys" until the 120 s deadline. It is
      fixed (held and replayed), and the window widens when the channel-open path is slow — which is
      exactly what a phone on a weak cellular signal produces. So: reconnect **IPH on LTE with one
      bar (or with the Network Link Conditioner on a bad profile) ↔ MBP-A**, five times. Expected:
      `connected` without a SAS screen, every time. Any run that sits in "agreeing on keys" and then
      fails at ~120 s is the same bug returning — capture the DEV log, which now names which guard
      dropped what (`reconnect: dropped …` / `holding …` / `replaying held …`).
- [ ] **E5 · key change** — on IPH press **forget** (clears pins), then reconnect from MBP-A using the
      stale pin. Expected: the key-changed hard stop on the pinned side, or a clean fall back to a fresh
      SAS — whichever the design says, but never a silent auto-accept.

## Phase F — real-world robustness · mixed: F3/F5/F6/F7 are T1, the rest need a radio or a dialog

- [ ] **F1 · phone screen lock / app switch mid-transfer** — start a ≈200 MB transfer to IPH, then lock
      the screen / switch apps for ~30 s and come back. Expected: either it keeps going or it fails
      visibly with a recoverable state — **iOS suspends background tabs**, so record exactly what
      happens; this is the single most likely real-world surprise.
- [ ] **F2 · network drop** — mid-transfer, disable Wi-Fi on one side for ~20 s and re-enable.
      Expected: a visible failure or a recovery, never a frozen progress bar that claims to be alive.
- [ ] **F3 · tab close** — close the receiver's tab mid-transfer. Expected: the sender notices and shows
      a failure.
- [ ] **F4 · large transfer** — ≈2 GB MBP-A Chrome → MBP-B Chrome (FSA both ways). Expected: it
      completes, memory stays flat, and the signaling socket is long gone by then (A6).
- [ ] **F5 · code expiry** — create a words session and leave it untouched past its TTL, then try to
      join. Expected: the code is freed — the waiting side is closed out (4010) and a later join gets
      `room not found` (4009), with a readable message rather than a raw code.
- [ ] **F6 · history is session-only** — after a few transfers, reload the page. Expected: the transfer
      history is **empty** (in-memory only); `localStorage` holds only lang/theme/privacy prefs.
- [ ] **F7 · second joiner on a 1:1 method** — forward the same link/QR to a second device. Expected:
      the second joiner is rejected (4002) — the one-time link reaches exactly one receiver.
- [ ] **F8 · silent peer on the 1:1 confirm path** — open a link on the receiving device and, the
      instant the connection starts, put that browser in a state where it cannot answer (airplane mode
      works; force-quitting the tab does not — that raises a channel close instead, which is a
      different path). Expected: the SENDER ends in **`failed` within ~120 s**, not an endless
      "agreeing on keys". This deadline is new (2026-09-12); before it, this path had no client-side
      bound at all and only the untrusted server's room TTL ended the wait — a server that simply
      never expired the room hung the client forever. **Time it and write the number down.**
- [ ] **F9 · slow mobile network does NOT trip the new deadlines** — the mirror of F8 and the risk it
      carries. Repeat A3 (words) and A4 (room/SAS) on a **weak cellular** connection, not Wi-Fi. The
      SAS nonce reveal now waits for the DTLS fingerprints to be pinned, so the handshake has more
      serialised steps than before. Expected: still connects well inside 120 s. If a real phone on a
      real network gets anywhere near the deadline, the deadline is wrong, not the network.

---

## Result log

Record per case: `ID · track (T1/T2/T3) · device pair · browser versions · PASS/FAIL · notes`. The
track belongs in the line because the same case can be run two ways: a T1 desktop rehearsal of A1
proves the mechanism, a T2 run on the named MBP↔iPhone pairing is what closes it, and a log that does
not say which produced the tick cannot tell them apart later. For a failure capture:
the selected candidate pair (webrtc-internals / about:webrtc), the WS message trace, the console
output, and whether it reproduced on the other engine.

**When the pass is done:** fold the results into `BACKLOG.md` § Step 6 / **6e** (and its
"Remaining (real devices, post-deploy)" line) and `CLAUDE.md` § Current state / Build order in the
SAME pass — doc drift is a bug (CLAUDE.md § Keep this file in sync). Bugs found here become new
BACKLOG items under "UX bugs — found in the manual test pass"; anything security-shaped goes to
§ Security audit instead of being fixed ad hoc.
