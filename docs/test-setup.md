# Real-device test pass — before you start

Section 0 of [TESTPLAN.md](../TESTPLAN.md): the preconditions, how to observe, the reference numbers to
judge "expected" by, the device inventory and how the pass is run. The cases themselves (A1 … F9) are
in TESTPLAN.md; the runs are recorded in [test-runs/](test-runs/README.md).

## 0. Read this before starting

**The production build has no in-app diagnostics.** `Diagnostics` is `import.meta.env.DEV`-gated and
so is every DEV knob — 14 query params (`?forceBlob=1`, `?forceIceFail=1`, `?forcePathMismatch=1`,
`?forceRelayPath=1`, `?forgeReconnectKey=1`, `?gateDelayMs=N`, `?maxAttempts=N`, `?preSasTimeoutMs=N`,
`?reconnectTimeoutMs=N`, `?reconnectWaitMs=N`, `?sasTimeoutMs=N`, `?signalingUrl=…`,
`?stallReconnect=1`, `?stallSasNonce=1`) and their 14 `__HUSHSEND_*__` global twins. **Verify this rather than assume it**
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
query (`app` / `room` / `codeType`), and the link-join scrub that rewrites the address to
`pathname + search` to strip the secret fragment. A third occurrence is a knob that shipped.

Last run 2026-10-13 against the bundle fetched over HTTPS from the live host (`index-DMFBuANo.js` + the lazy `ponyfill-DUnUwklG.js`, `afaabd4`): no globals, and 1 + 1, both in the entry chunk. (The ponyfill chunk does contain the string `fastly.jsdelivr.net` — its default `locateFile`, overridden at runtime; B3 is where it must never be requested.) **Re-run it after any deploy** — do not trust this line. Every build renames the bundle, so naming a hash here only guarantees the note goes stale; what the host is serving right now is
`grep -o 'index-[^"]*\.js' /var/www/hushsend/dist/index.html`. So:

- **Failure injection is NOT available on prod** — those paths are covered by e2e. This pass observes
  *real* behaviour only. If a fault path needs driving deliberately, do it against `npm run dev`
  locally, not against the live host.
- Observation comes from browser devtools + server logs (§ 0.2).

### 0.1 Preconditions

- [x] Frontend redeployed from current `main` (`bash ~/projects/hushsend/deploy/deploy-frontend.sh`)
      — 2026-10-13 ~18:56 UTC, commit `afaabd4` (the 2026-10-11 pre-launch fixes —
      [history](history/pre-launch.md)). `/var/www/hushsend/dist` is byte-identical to a clean local
      build of `afaabd4` (42 files, equal sha256 manifests) and the public URL serves
      `index-DMFBuANo.js`. Checked live the same evening in a Chromium browser: the home page carries
      the VPN advice; a well-formed link whose token room nobody holds fails at once as "This link
      expired or was already used", fragment scrubbed; with `RTCPeerConnection` deleted and the served
      entry module evaluated again, the page is "This browser can't send files", a link fragment is
      scrubbed and no WebSocket is opened. The signaling server's running copy is unchanged at
      `112c37f`. **Re-run it if `main` has moved since**, and re-tick — this tick is only worth the
      date next to it (it went stale twice: ticked 2026-09-12 and 2026-10-03, `main` moved, nobody
      re-ticked). The earlier redeploys and what each was checked with:
      [followups-and-ops.md](history/followups-and-ops.md) § Frontend redeploys checked live.
- [x] **Verify the new bundle is live:** `grep -r 'stun.l.google' /var/www/hushsend/dist` returns
      nothing — re-confirmed 2026-10-13 for `index-DMFBuANo.js` (on the clean build the live dist is
      byte-identical to, and on the served chunks) (the pre-2026-09-12 bundle matched; this was the
      BACKLOG "verify after redeploy" item). The only STUN in the served bundle is
      `stun:stun.hushsend.frelikh.dev:3479` — hushsend-stun-server since 2026-10-10, on the same box, so
      one operator still holds app, signaling and STUN ([BACKLOG.md](../BACKLOG.md) § Security — open).
- [ ] Hard-refresh every test device (Ctrl/Cmd+Shift+R; on iOS: close the tab and reopen) so no
      device runs the cached old bundle. Confirm the asset hash in devtools matches the deployed one.
- [x] `curl -s https://hushsend.frelikh.dev/health` → `ok`; nginx / hushsend-signaling / coturn /
      hushsend-stun all `active` — 2026-10-13 (`/health` from the Mac; `systemctl is-active` over SSH).
      Worth the date only.
- [x] **The relay actually relays:** `bash /var/www/hush-signaling-server/deploy/turn/verify-relay.sh` (the script lived in this repo's `deploy/` until 2026-10-03) → OK — 2026-09-27 on the server:
      16 messages relayed, 0 lost, average RTT 30 ms. Worth the date only. `coturn` being `active` does
      NOT mean Reliable mode works — if its `static-auth-secret` and the signaling server's
      `TURN_SECRET` have drifted, the mint still succeeds and only the allocation fails, so case C5
      (cross-network relay) would fail for a reason that has nothing to do with the devices in front
      of you. First verified 2026-09-19 (the same 16 / 0).
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

- Receive path (since 2026-09-28 — owner's rule "disk wherever possible"; [transfer.md](architecture/transfer.md) § File transfer):
  **1. OPFS** — site storage, NO dialog, bounded by the site quota (measured 10 GiB Chrome / 76.8 GiB
  Safari / 10 GiB Firefox on the Mac), handed over as a download at the end; **2. FSA** — the save
  dialog, only when OPFS cannot hold the file; **3. Blob in RAM, 200 MiB on every device** — the
  last resort (a private window without site storage). Whatever no path can take is refused
  **before** accept. A file finishing while the page is hidden waits for **Save file**. (Until
  2026-09-27: FSA first, else Blob capped 1 GiB desktop / 512 MiB mobile by UA.)
  **Measured engine ceilings** (2026-09-12, `limits.spec.ts` with the cap lifted, on a Mac):
  Chromium OK at 1 GB and 2 GB, **fails at 3 GB** (`download.saveAs: canceled`); WebKit OK to 1.5 GB,
  **fails at 1.75 GB** (freezes near 100%). Both die at the END — the chunks arrive, the single Blob
  does not — and **neither raises a catchable error**, so the desktop cap is deliberately far below.
  B2 below is what tells us whether the MOBILE cap is equally well placed; nothing else can.
- Chunk size: the SCTP-negotiated max clamped to **[16 KiB, 256 KiB]**; backpressure via `bufferedAmount`.
- Deadlines (all **120 s**): pre-SAS pairing, SAS confirmation, reconnect re-auth, **and the 1:1
  handshake** (words / link / QR — added 2026-09-12 for the key-confirmation wait; armed from pairing
  start since 2026-10-11, so it bounds the WebRTC bring-up too —
  [methods.md](architecture/methods.md) § link / qr method). Before 2026-09-12 that path had no client
  deadline at all and depended on the untrusted server's room TTL to rescue it.
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
  link is slow". At the loopback figure 1 GiB takes ~4.7 min end to end.
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
| MBP-A | MacBook | macOS 26 | Chrome 154 | Blink | Claude via **Playwright** driving the installed Chrome (`channel:'chrome'`, persistent profiles, since 2026-09-27) | straight into Downloads through the download worker (since 2026-09-28, live since `c5a51c4`); site storage only if the worker cannot come up | native `BarcodeDetector` since 2026-10-03 (`b73651d`), zxing ponyfill on its first throw — see B3 |
| MBP-A | MacBook | | Brave 154 (shields up) | Blink | Claude (Claude-in-Chrome extension) | the stream path expected (desktop Chromium; not probed — shields may block the worker, then site storage) — Brave ships no `showSaveFilePicker`, so no dialog fallback | zxing ponyfill |
| MBP-A | MacBook | macOS 26 | Safari 26.6 | **WebKit (the real one)** | Claude via **WebDriver** (`safaridriver`, since 2026-09-27 — see § 0.5) | OPFS (probed 2026-09-27: writes to disk, quota 76.8 GiB) | zxing ponyfill |
| MBP-A | MacBook | macOS 26 | Firefox 156 | Gecko | Claude via **WebDriver** (`geckodriver`, since 2026-09-27) | OPFS (probed 2026-09-27: writes to disk, quota 10 GiB) — never the stream path: Firefox fails a streamed download unsafely (2026-09-28) | zxing ponyfill |
| MBP-A | MacBook | macOS 26 | Claude's built-in Chromium 152 | Blink | Claude (built-in browser) — a SECOND profile next to Brave, so E-cases are honest | the stream path expected (desktop Chromium); before 2026-09-28 its FSA dialog could not be shown in the pane | zxing ponyfill |
| MBP-B | MacBook | | Chrome | Blink | Claude (Playwright) | straight into Downloads (the stream path) | zxing ponyfill |
| IPH | iPhone | | Safari (WebKit) | WebKit + phone limits | Claude via Safari Web Inspector (USB) | OPFS expected (not yet probed on a device); Save file if the screen was locked | zxing ponyfill |
| AND-1 | **Google Pixel 5** (the owner's; attached 2026-10-02) | Android 14, patch 2023-11-05 (EOL) | Chrome 152 | Blink | Claude over CDP via USB (`adb forward … chrome_devtools_remote`, the `android-device` skill) + `adb` for native UI; no SIM — "LTE" is a second Wi-Fi with a VPN exit in France | OPFS expected (mobile Chromium does not stream until a handset proves it — B2/B10) — no dialog while the connection is live; the save dialog only past the quota (Chrome 149 HAS `showSaveFilePicker`, and a dialog left open ~20 s killed the connection — why disk-without-dialog is now first) | native `BarcodeDetector` since 2026-10-03, zxing ponyfill on its first throw (the 2026-10-02 scan ran zxing) |
| SIM-iOS | iPhone 17 **simulator** (rehearsal only) | iOS 27.0 | Safari | WebKit, but the Mac's RAM and network | Claude via simulator taps + screenshots (safaridriver cannot reach it) | OPFS expected (not probed on the simulator) | zxing ponyfill |
| SIM-iPad | iPad (A16) **simulator** (rehearsal only) | iPadOS 27.0 | Safari | WebKit | as SIM-iOS | OPFS expected; the UA no longer matters (it sent a desktop UA, which picked the 1 GiB cap until 2026-09-27) | zxing ponyfill |
| EMU-AND | Pixel 9 Pro **emulator** (rehearsal only) | Android 17 (user build) | Chrome 149 | Blink | Claude over CDP (`adb forward … localabstract:chrome_devtools_remote`) + `adb` for native UI | OPFS expected — no dialog any more (it was FSA through the system save dialog) | zxing ponyfill |
| AND-2 | Android | | Firefox | Gecko | Claude via `about:debugging` (USB) | OPFS expected | zxing ponyfill |

Three engines, not four browsers: Blink (Chrome, Brave, Android Chrome), Gecko (Firefox ×2), WebKit
(Safari ×2). Brave earns its row for hardening (B9), MBP-B for a second disk endpoint (F4).

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
| **T1 + T2** — T1 closes the DESKTOP half on real engines; the handset half is a separate tick | A1, A3, A4, A5, A6a · B2, B8, B10 · E6, E7 · F2, F8 | 12 |
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
