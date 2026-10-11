# hushsend — real-device test pass (step 6e)

Everything that can be verified without physical devices is done (unit + integration + Playwright
e2e across four engine projects, feature-detection review, self-hosted QR WASM); what remains is
**behaviour on real browsers, real networks, and real NAT**.

**Status (2026-10-03): DONE — 47 of 47 cases ticked or closed with a reason.** The runs are recorded one
file per day in [docs/test-runs/](docs/test-runs/README.md), together with how the pass progressed. The
ticks in § 0.1 are PRECONDITIONS, not cases; do not read them as progress.

- **Target:** the live deploy — `https://hushsend.frelikh.dev` (production build).
- **Scope closes:** BACKLOG § Step 6 / 6e "Remaining (real devices, post-deploy)" and DEPLOY.md § 0
  "Still pending" (in-browser P2P/SAS/transfer on two devices + cross-network TURN relay).
- **Out of scope:** the deferred security-audit items (BACKLOG § Security audit). Reconnect is
  codeless since 2026-09-25 — there is no reconnect code to mix with a plain room join any more.

> **Plan currency.** Cases B7, B8, C6 and E6 were added on 2026-09-18 for behaviour that landed
> after this plan was first written (STUN cross-check, the network-exposure disclosure, volume
> padding, and the reconnect early-frame fix); Phase E was rewritten on 2026-09-25 for the codeless
> reconnect (E3/E4 changed meaning, E7 added). If you are reading this after further changes, check
> `git log --oneline -- src/` against the date above before trusting the coverage: a device pass that
> silently skips a new feature is worse than one that has not run.

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

Last run 2026-09-27 against the bundle fetched over HTTPS from the live host (`index-BBI2zUuS.js` + the lazy `ponyfill-DEVIBFUV.js`, still `efe8b29`): no globals, and 1 + 1, both in the entry chunk. (The ponyfill chunk does contain the string `fastly.jsdelivr.net` — its default `locateFile`, overridden at runtime; B3 is where it must never be requested.) **Re-run it after any deploy** — do not trust this line. Every build renames the bundle, so naming a hash here only guarantees the note goes stale; what the host is serving right now is
`grep -o 'index-[^"]*\.js' /var/www/hushsend/dist/index.html`. So:

- **Failure injection is NOT available on prod** — those paths are covered by e2e. This pass observes
  *real* behaviour only. If a fault path needs driving deliberately, do it against `npm run dev`
  locally, not against the live host.
- Observation comes from browser devtools + server logs (§ 0.2).

### 0.1 Preconditions

- [x] Frontend redeployed from current `main` (`bash ~/projects/hushsend/deploy/deploy-frontend.sh`)
      — re-done 2026-10-03 ~01:35 UTC (commit `981f8df`: the reconnect wait returns to waiting when the
      engaged peer vanishes before any transport — the ghost at the rendezvous); byte-identical to a
      clean local build of `981f8df`, the public URL serves `index-DkYJ-hTt.js`; checked on the phone
      ([the 2026-10-02 run log](docs/test-runs/2026-10-02.md), end of the 2026-10-02 entry). Before it, 2026-10-03 ~00:55 UTC (commit `190151b`: the three UX fixes from the Pixel 5 pass — the
      Max hint under the peer-left race, the reconnect wait's retry, the Finishing line);
      `/var/www/hushsend/dist` is byte-identical to a clean local build of `190151b` (42 files), the public
      URL serves `index-CkRmiW5i.js`, no `stun.l.google`; the three fixes were then checked on the live
      build ([the 2026-10-02 run log](docs/test-runs/2026-10-02.md), end of the 2026-10-02 entry). The visual gate ran on the deploy host against
      this commit: 181 / 181 after recording `transfer-finishing` (and re-recording the sas-picker's
      seeded decoys, which had moved — see that commit). Before it, 2026-10-02 ~19:20 UTC (commit `9bdda44`: the QR scanner's zxing glue/wasm ABI fix —
      `zxing-wasm` 3.1.3 — plus the vitest ABI gate and this pass's records); `/var/www/hushsend/dist` is
      byte-identical to a clean local build of `9bdda44` (42 files, equal sha256 manifests), the public
      URL serves `index-CL2avokU.js` and `zxing_reader-BxB2YfIY.wasm`, no `stun.l.google`. Checked live
      the same minute with real Chrome 154 and its fake camera: the QR decoded and the pair connected in
      0.5 s, the `.wasm` fetched from our origin only — **a browser that had the site open keeps the OLD
      bundle until a hard refresh / cache clear (`index.html` is cached), so every test device needs one
      before re-testing.** Before it, the owner's 2026-10-01 deploy of `c5f6e94` (`index-6QS8zIWA.js`),
      which is the build the scanner was found dead on. Before that, 2026-09-29 19:44 UTC (commit `8c9ea59`: a link opened into an already-open
      tab joins via `hashchange`; honest failure copy — a waiting side's own expired room, the mismatch
      description by cause; the macOS Local Network hint; the STUN probe window 12 s);
      `/var/www/hushsend/dist` is byte-identical to a clean local build of `8c9ea59` (42 files, equal
      sha256 manifests) and the public URL serves `index-C-42SlIP.js`. Checked live with real Chrome the
      same evening: a link set as the fragment of an open home tab joined in 608 ms with no reload (a
      marker in `window` survived) and the fragment was scrubbed; a link nobody opened failed on its
      creator exactly 180 s later (the live `TOKEN_ROOM_TTL_MS`) as "Your link expired — Nobody opened
      it in time" (`data-reason` `nobody joined before the code expired`). Before it, 2026-09-29 18:47
      UTC, `273e9e7` (the screen pacing — a screen the
      FSM leaves for a pre-connection stage is held 400 ms with its controls quiet, the Connecting
      screen appears only when a stage outlasts that, each of its titles stays ≥ 500 ms; CLAUDE.md §
      UI / styling → Screen pacing); `/var/www/hushsend/dist` is byte-identical to a clean local build
      of `273e9e7` (42 files, equal sha256 manifests) and the public URL serves `index-CwM5wm6M.js`.
      Checked live the same evening with real Chrome on both sides (link method, 5 direct + 3 relayed
      runs, on a LAN that was slow that night — 59 ms average ping to the server): no screen flashed;
      a run under 400 ms went straight from the held Share screen / an empty column to Transfer, a
      longer one showed "Creating session…" / "Joining…" / "Agreeing on keys…" for 500–650 ms, and a
      confirming stage of 2–20 ms never got its "Verifying…" title. The day before, `1f2abab` (app code
      `254c31b`: a held copy gives way to the next big file after 2 min) was checked the same way — 42
      files, `index-Cs9XZg39.js`. Earlier on 2026-09-28 `c5a51c4`
      (straight into Downloads on desktop Chromium, flow control, the site-storage reservation) was
      checked the same way — 42 files, `dl/sw.js` the download worker, served as `index-B-Rj0zzX.js`; `dl/sw.js`
      is served as `application/javascript`, and a `/dl/<id>` no worker answers falls back to the app
      page with `X-Frame-Options: DENY` (so a hidden iframe can never render it). The signaling
      server's running copy (`/var/www/hush-signaling-server`) is unchanged at `3d96125`, `/health` ok,
      nginx / hushsend-signaling / coturn `active` — checked 2026-09-29 after the 19:44 deploy. **Re-run it if `main` has moved since**, and
      re-tick. It had gone stale
      once already (ticked 2026-09-12, `main` moved, nobody re-ticked) — this tick is only worth the
      date next to it.
- [x] **Verify the new bundle is live:** `grep -r 'stun.l.google' /var/www/hushsend/dist` returns
      nothing — re-confirmed 2026-09-29 for `index-C-42SlIP.js` (on the clean build the live dist is
      byte-identical to) (the pre-2026-09-12 bundle matched; this was the BACKLOG
      "verify after redeploy" item). The only STUN in the served bundle is
      `stun:turn.hushsend.frelikh.dev:3478`, i.e. our own — which is also the whole of BACKLOG's
      "separate the STUN server" item: one operator still holds app, signaling and STUN.
- [ ] Hard-refresh every test device (Ctrl/Cmd+Shift+R; on iOS: close the tab and reopen) so no
      device runs the cached old bundle. Confirm the asset hash in devtools matches the deployed one.
- [x] `curl -s https://hushsend.frelikh.dev/health` → `ok`; nginx / hushsend-signaling / coturn all
      `active` — 2026-09-27 (curl from the Mac; `systemctl is-active` over SSH). Worth the date only.
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

- Receive path (since 2026-09-28 — owner's rule "disk wherever possible"; CLAUDE.md § File transfer):
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

## Phase A — same-network happy path (all 4 methods) · mostly T1; A2 needs the camera

Both peers on the home Wi-Fi, default **Max-privacy**. Baseline: if these fail, nothing below matters.

- [x] **A1 · link** *(AND-1 half ✅ 2026-10-02 — Pixel 5 Chrome ×3; IPH half ✅ 2026-10-03 — iPhone 15 Safari, 2.0 / 1.7 s, host↔host)* — MBP-A (Chrome) creates a one-time link → send it to IPH (Safari) out of band →
      IPH opens it. Expected: auto-join, pairing, `connected` with **no SAS screen** (link/QR
      authenticate over the link secret), URL fragment scrubbed from the address bar.
- [x] **A2 · QR** *(AND-1 half ✅ 2026-10-02 on the fixed live build `9bdda44` — the Pixel 5 decoded the QR off the Mac's screen and connected in 8.5 s; before the fix the scanner was dead on every engine, [the 2026-10-02 run log](docs/test-runs/2026-10-02.md). IPH ✅ 2026-10-03: the iPhone's camera read the QR off the Mac's screen, connected in 29 s)* — MBP-A shows the QR, IPH scans it with the in-app scanner. Expected: same as A1.
      Note which decoder ran (§ B3).
- [x] **A3 · words** *(AND-1 half ✅ 2026-10-02; IPH ✅ 2026-10-03)* — MBP-A creates, IPH enters the rendezvous + the 4 secret words. Expected: `connected`
      after CPace + key confirmation, no SAS screen.
- [x] **A4 · room / SAS** *(AND-1 half ✅ 2026-10-02, 8 rooms, reader 5× creator / 3× phone; IPH ✅ 2026-10-03, 2 rooms, roles both ways)* — MBP-A creates a 4-digit room, IPH joins → both land in the **lobby**, MBP-A
      presses Connect on the IPH row. Expected: **SAS screen is asymmetric** — one side shows its
      phrase (reader), the other picks blind among 3 (real + 2 decoys). **Which side reads is not
      predictable and must not be** (changed 2026-09-12): it is derived from the SAS material, not
      from the creator and no longer from the id order, precisely so the untrusted server cannot make
      BOTH peers the blind picker. Just check that **exactly one** side reads and the other picks —
      re-pair a few times and expect the roles to land differently. Correct pick → `connected`.
- [x] **A4a · the SAS refusal is reachable and equal-weight** — on the picker screen confirm
      "None of these match — stop" is a full-width pill of the same size as the confirm, not a faint
      label (the 2026-09-12 audit decision; the 2026-09-26 redesign briefly made it a label and that
      was reverted the same day), and on the reader screen that "Stop — they don't have this phrase"
      is the same, and that the sentence "Only continue once you have HEARD your peer say these words
      back." sits directly above the confirm pill and is legible on a phone. Tap the picker's
      refusal: expected **both** sides end in the "channel may be compromised" hard stop, no transfer
      UI on either.
- [x] **A4b · the reader can still stop after confirming** — reader taps "They read it back correctly"
      BEFORE the picker answers, then taps the abort on the waiting screen. Expected: the session
      fails closed. (A reject is accepted even after our own approval, up to settle — a reader who
      clicked too early must not be trapped.) *(PASS on the live build 2026-09-28 — the "Stop" pill on
      "Verifying…" ends both sides in the hard stop; [the run log](docs/test-runs/README.md).)*
- [x] **A5 · transfer both ways** *(AND-1 half ✅ 2026-10-02: site storage on the phone, the stream path on the Mac, both verified; IPH ✅ 2026-10-03: site storage on the phone, the stream path on the Mac, both verified)* — over the A1 connection send a small file (≈5 MB) MBP-A → IPH, then
      IPH → MBP-A. Expected: progress advances monotonically, file arrives intact (**check the size and
      open it**), receiver's terminal plaque shows a **"New transfer"** button.
- [x] **A6 · WS closes on connect** — in devtools Network → WS, confirm the signaling socket **closes
      shortly after `connected`** for all of A1–A4 **and for reconnect (Phase E)**, while the transfer
      keeps working afterwards. This is the per-pair privacy close: the server must not observe the
      session duration. Reconnect was the last exemption and was folded in on 2026-09-12 — if its
      socket stays open, that regression is the whole point of checking it here.
- [x] **A6a · path attestation never blocks a transfer** *(✅ 2026-10-03: Chrome ↔ iPhone Safari read `mismatch` on the Mac and the 3 MB send completed — [the 2026-10-03 run log](docs/test-runs/2026-10-03.md))* — it is ADVISORY. On every pair, especially
      a Safari↔non-Safari one, confirm the transfer completes regardless of the verdict. A `mismatch`
      here is EXPECTED between engines (see § Phase B) and must stay cosmetic; if a transfer is ever
      refused or torn down because of it, that is a bug, not a detection.
- [x] **A7 · multi-file** — send 3 files at once. Expected (wording fixed 2026-09-27 to the behaviour
      shipped since `1082b7d`): the sender lists the three files and sends them as ONE store-mode
      `hushsend-files.zip` with one progress bar; the receiver is offered that zip, and every member
      unzips byte-identical; after "New transfer" the next offer shows ITS own name, never the zip's.

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
> device descriptor): the phone's real receive path completes (on that build site storage cannot
> write, so it is the RAM fallback — the probe and the fall-back are what that proves), a forced RAM
> receive over 200 MiB is refused before any byte, the layout holds at 390 px, and the QR paste
> fallback works. So on a real
> handset those are re-confirmations; what only the handset can answer is **memory pressure at the
> cap, background-tab suspension (§ F1), camera permissions (B4) and cellular NAT (§ C)**.
>
> **Already pre-covered headlessly** by `tests/e2e/interop.spec.ts` (chrome ↔ firefox ↔ webkit, both
> directions, link pairing + a hashed 200 KB transfer): cross-engine SDP/ICE/DTLS/SCTP interop and the
> Blob receive path. So B1–B2 below are confirming on real hardware rather than discovering; **B3–B5
> are the ones that can only be answered here** — a headless box has no camera, and Playwright's
> WebKit on Linux is not Safari on iOS.

- [x] **B1 · straight into Downloads, no dialog (Chrome desktop)** — receive on MBP-A Chrome.
      Expected: **no save dialog**; the download starts at Accept and the browser writes the file as it
      arrives (the download worker, `dl/sw.js`) — **nothing in site storage**, RAM flat on a ≈2 GB file,
      the saved file intact. Cancel one in Chrome's downloads list mid-transfer: both sides end
      (receiver "error · the browser stopped the download", sender "cancelled") and no partial file is
      left. Pause one there: the sender's progress stops (flow control) and resumes with the download;
      RAM stays flat. *(Reworded twice on 2026-09-28: the morning's tick proved the site-storage path
      — a disk file, no dialog, the dialog only past the quota, all PASS on the live build (§ Result
      log) — which desktop Chrome no longer takes; Firefox and Safari do, so those checks moved to
      B2/B10. PASS on the live `c5a51c4` the same day — [the run log](docs/test-runs/README.md).)*
- [x] **B2 · disk receive on the phone + the RAM fallback's cap** *(IPH disk half ✅ 2026-10-03: 1 GiB and 2 GiB into Safari's site storage, verified; RAM rung ✅ 2026-10-03 in a private Safari tab: 250 MB refused before Accept naming the 200 MB cap and the private window, 200 MiB accepted via RAM and delivered)* — receive on IPH Safari and on MBP-A
      Firefox (both keep site storage — neither may stream, see CLAUDE.md § File transfer). Expected:
      no save dialog; the file goes to site storage and lands via a download at the end — a file well
      past 200 MiB (say 1 GiB) must complete on the PHONE, which is what the disk path is for. Then in a **private window** (where site storage may be unusable → the RAM path)
      offer a file **over 200 MiB**: the receiver must **refuse before accepting**, naming the limit —
      never accept and then die of OOM mid-transfer. *(Reworded 2026-09-28 for the disk-first path; the
      old caps were 512 MiB phone / 1 GiB desktop.)* **2026-09-28, desktop Chrome incognito: FAILS this
      rung** — there site storage IS usable but holds only ~430 MiB while `navigator.storage.estimate()`
      reports the normal profile's 10 GiB, so a 600 MiB file was accepted on the disk path and died at
      74 % ([the run log](docs/test-runs/README.md), BACKLOG § UX bugs). Re-run after the fix: Chrome incognito now streams into
      Downloads (expect a 1 GiB file to complete there, nothing in site storage); Firefox private has no
      site storage (`getDirectory()` → SecurityError, measured) — expect the RAM path, a refusal before
      accept above 200 MiB; Safari private — by hand (safaridriver cannot open one).
- [x] **B3 · QR scan + self-hosted WASM** *(AND-1 half ✅ 2026-10-02 on `9bdda44`: the scan fetched the ponyfill + `zxing_reader-BxB2YfIY.wasm` from our origin only and decoded; IPH ✅ 2026-10-03; AND-2 Firefox half DROPPED by the owner 2026-10-03 — too rare a combination to hold the case open)* — scan on IPH Safari and AND-2 Firefox (the ponyfill path).
      Expected: scanning works, and in Network the WASM is fetched from
      `https://hushsend.frelikh.dev/assets/zxing_reader-*.wasm` with `Content-Type: application/wasm`.
      **Nothing may be requested from `jsdelivr` / `fastly` / any third-party host** — that is the whole
      point of the 6e vendoring. Also scan on AND-1 Chrome — it fetches the SAME WASM: the app imports
      `barcode-detector/ponyfill` where the browser has no native QR detector (iOS Safari, Firefox); since
      2026-10-03 Chrome desktop / Android use their own `BarcodeDetector` with a runtime fallback to zxing
      (owner's decision, CLAUDE.md § QR). The ponyfill itself never delegates to a native detector
      (measured 2026-09-27 on desktop Chrome, which has one; corrected from
      "native; no WASM fetch at all").
- [x] **B4 · camera permission denied** *(Android half ✅ 2026-10-02: Block → paste fallback, no crash; re-allow is via the site-settings sheet because Chrome offers "Never allow"; IPH ✅ 2026-10-03: deny → "Camera unavailable — paste the link below instead")* — on IPH, deny the camera prompt. Expected: a clean
      **paste-the-link fallback**, no crash, no dead screen. Re-allow and confirm the scanner recovers.
- [x] **B5 · share / copy** *(AND-1 half ✅ 2026-10-02 — the system share sheet opened on a real tap; IPH ✅ 2026-10-03 (the share sheet opened); Firefox half ✅ 2026-10-03: no `navigator.share` → no Share button, Copy link → "Copied", the clipboard holds exactly the link)* — on IPH and AND-1 the **Share** button uses the native sheet; on MBP-A
      Firefox (no `navigator.share`) it must be **absent**, with Copy still present and working.
- [x] **B7 · STUN cross-check verdict per engine — NEW 2026-09-17, and the device pass is what
      decides it.** The client asks every configured STUN server what our public address is, using one
      throwaway PeerConnection per server, and compares (`core/stunCheck.ts`). Read `stun-verdict` /
      `stun-addresses` in the DEV strip on EVERY engine in the matrix. **This needs two STUN URLs in
      `VITE_STUN_URLS`** — with one it is `unknown` by design and the case proves nothing. Exact setup,
      worked out 2026-09-19 (two flags cost a while to find: coturn REFUSES to start with
      `--allow-loopback-peers` unless the admin CLI is secured, and its default pidfile is unwritable
      as a normal user):

      ```bash
      # 1. two loopback STUN servers (NOT 3478 or 3479 — the TURN relay and hushsend-stun own those
      #    here; the recipe used 3479/3480 until hushsend-stun took 3479 on 2026-10-10)
      for P in 3480 3481; do
        turnserver -n --listening-ip=127.0.0.1 --listening-port=$P \
          --no-auth --no-tls --no-dtls --no-cli --pidfile= --log-file=stdout &
      done
      # 2. a LOCAL signaling server that trusts the dev origin
      NODE_ENV=development HOST=127.0.0.1 PORT=8191 DEV_ORIGINS=http://localhost:5291 \
        node node_modules/hush-signaling-server/signaling-server.js &
      # 3. the dev build, pointed at BOTH of the above
      VITE_SIGNALING_URL=ws://127.0.0.1:8191 \
      VITE_STUN_URLS=stun:127.0.0.1:3480,stun:127.0.0.1:3481 \
        npx vite --port 5291 --strictPort
      ```

      Verified end to end 2026-09-19: the page loads, the DEV strip renders, and `stun-verdict` reads
      **`agree`** with no console errors — so a `unknown` in this case is a real result about the
      engine, not a broken harness.
      On the Mac (Homebrew coturn **4.18**) `--no-dtls` and `--no-cli` no longer exist and the command
      exits 255 with its help text; there use `turnserver -n -S -z --listening-ip=127.0.0.1
      --listening-port=$P --no-tls --pidfile /tmp/turn$P.pid --log-file stdout` (checked 2026-09-27).

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
- [x] **B8 · the network-exposure disclosure renders** *(PASS 2026-10-02 on the Pixel 5: closed by default, opens on tap, nothing clipped at 392 px; RU not checked — English only by decision)* — — NEW 2026-09-13.** On the landing, the collapsed
      "What your network can still see" block (testid `network-exposure`) must be present, **closed by
      default**, readable in EN and RU, and open on tap on a phone. It states the two things
      cryptography does not hide (cleartext SNI; the direct connection to your correspondent) and the
      Tor/VPN-on-both-sides advice. Check the text is not clipped at 390 px — it is the longest prose
      in the app.
- [x] **B6 · theme / language / layout** *(Android half ✅ 2026-10-02 — both themes, no clipping, 44 px targets; iPhone ✅ 2026-10-03: both themes, 44 px targets, no overflow at 393 px)* — check the app in light+dark and EN+RU on the iPhone and on a
      MacBook: no clipped text, no horizontal scroll, tap targets reachable, the 4-digit code and word
      slots legible.
- [x] **B9 · privacy-hardened browser (Brave, shields up) — NEW 2026-09-19.** Brave is Blink, so it
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
- [x] **B10 · size ladder up to 5 GB — every receive path, every engine as sender — NEW 2026-09-27
      (owner's request).** *(Handset half of the site-storage row ✅ 2026-10-02: Pixel 5 Chrome, 1 / 2 / 3 / 4 GiB + 1 B / 5 GiB all PASS at 3.0–5.5 MB/s, Chrome PSS flat 201–264 MB — [the 2026-10-02 run log](docs/test-runs/2026-10-02.md). IPH site-storage rungs ✅ 2026-10-03: 1 and 2 GiB block-verified at 12.6 / 29.4 MB/s, 4 GiB + 1 B and 5 GiB by hand in the owner's tab — "Delivered" = the receiver confirmed every declared byte, 11.6 / 12.8 MB/s over Wi-Fi, no block verify on the phone; the RAM rung ✅ in a private tab (B2); past-the-quota on a phone not attempted — the iPhone reports 41 GB free.)* Limits differ by OS, browser and device, and § 0.3's ceilings come from
      Playwright builds on one Mac (Chromium and WebKit only: no Gecko, no real Safari, no phone). So
      walk each receive path up its ladder on the REAL engines and devices:

      | receive path | sizes to offer | expected |
      |---|---|---|
      | *(2026-09-28: the paths changed — rows kept for the record of the 2026-09-27 run; the NEW rows below are what to walk next)* | | |
      | FSA streaming (Chrome desktop) | 1, 2, 3 GiB, **4 GiB + 1 B** (the 32-bit edge), **5 GiB** | completes, every byte verified, receiver memory flat |
      | Blob, desktop cap 1 GiB (Safari, Firefox, Brave, Chrome without FSA) | 1 GiB + 1 B, 5 GiB, then **exactly 1 GiB** | the first two refused BEFORE accept, naming the limit; 1 GiB completes AND the download lands on disk intact |
      | Blob, mobile cap 512 MiB (iOS Safari, Android Firefox; Android Chrome only where `showSaveFilePicker` is absent — Chrome 149 has it, so its default path is FSA, see AND-1) | 512 MiB + 1 B, 5 GiB, then **exactly 512 MiB** | the same; on a real handset this is also B2's memory-pressure datum |
      | every engine as SENDER | 5 GiB into an FSA receiver | completes; sender memory does not grow with the file |
      | **NEW 2026-09-28 · straight into Downloads (desktop Chrome, the default there)** | 1, 2, 3 GiB, 4 GiB + 1 B, 5 GiB | completes with NO dialog and nothing in site storage, the saved file's SHA-256 right, receiver memory flat |
      | same · the download PAUSED in Chrome's list mid-transfer, then resumed | 2 GiB | the sender stops at a window's worth (16 MiB) past the receiver, memory flat while paused, completes intact after resume |
      | same · the download CANCELLED in Chrome's list | 2 GiB | receiver "error · the browser stopped the download", sender "cancelled", no partial file |
      | **NEW · OPFS (Firefox, Safari, mobile — the default there)** | 1, 2, 3 GiB, 4 GiB + 1 B, 5 GiB — up to the site quota | completes with NO dialog, every byte verified, receiver memory flat, the download lands intact |
      | **NEW · past the quota** (Chrome: > 10 GiB here) | quota + 1 GiB | Chrome/Android: the save dialog appears (FSA); Safari/Firefox: refused before accept, naming the room |
      | **NEW · RAM fallback 200 MiB** (a private window without usable site storage) | 200 MiB + 1 B, then exactly 200 MiB | the first refused before accept; 200 MiB completes |
      | *(2026-09-28, the live `c5a51c4`: the stream rungs PASS on Chrome, the site-storage rungs PASS on Firefox with the over-quota refusal and on Safari to 5 GiB, the RAM rung PASS on Firefox private — [the 2026-09-28 run log](docs/test-runs/2026-09-28.md). The desktop half of B10 is done; the handset half is what is left.)* | | |

      **Build the files so they cost the page nothing and still prove every byte:** 1 MiB blocks, each
      a unique 16-byte header plus one shared body, assembled from Blob parts that REFERENCE that body.
      A 5 GiB `File` then holds ~1 MiB of RAM on the sender, and the receiver checks every block, so
      reordering, duplication and truncation all fail. For an unattended FSA run the save dialog can be
      replaced in-page by an OPFS file handle (the same `createWritable()` stream); the dialog itself is
      B1's T2 step. Let the Blob path's final download really happen, because that hand-off is where
      the engines died in § 0.3, and hash the saved file. Record per run: pair, size, MB/s, outcome,
      verify result, and the peak RSS of the sender's and the receiver's process trees (`ps` every 5 s).
      A phone-sized receiver is the case this ladder exists for; a simulator or emulator run is a
      rehearsal, not the tick.

## Phase C — cross-network + privacy modes (the part only real networks can prove) · entirely T2

IPH (or AND-1) on **LTE with Wi-Fi off**, MacBook on the home Wi-Fi.

- [x] **C1 · Max-privacy direct across networks** *(PASS 2026-10-02, outcome (b): Mac Chrome ↔ Pixel 5 on a VPN Wi-Fi, both sides terminal `failed` with the hint in 18–48 s — [the 2026-10-02 run log](docs/test-runs/2026-10-02.md))* — both sides default Max-privacy, link method.
      **⚠️ Caveat found 2026-10-03 — the outcome does not generalise.** In every C1 run (and on the Max side of
      C3) the desktop sat on the SERVER'S OWN LAN, and from there the STUN reply is the ROUTER's LAN address:
      re-measured 2026-10-03, Chrome on the Mac at 192.168.1.38 gathered `srflx 192.168.1.1` from
      `stun:turn.hushsend.frelikh.dev:3478` (the router hairpins and rewrites the source). So the home side
      never advertised its public mapping and the remote peer had nothing to reach — a failure by
      construction, whatever the phone's NAT. **Direct connectivity across networks is untested for anyone
      not on the server's LAN.** To test it, put the desktop on any OTHER network (café, office, a friend's
      Wi-Fi) and pair it with the phone on LTE, both in Max privacy.
      Expected either (a) `connected` via a `srflx` candidate pair — confirm in webrtc-internals that
      the selected pair is **not `relay`** — or (b) if the NATs won't traverse, a **terminal `failed`
      screen with the "switch to Reliable" hint**. Both are correct; a **hang is not**. Record which.
- [x] **C2 · Reliable relay** *(PASS 2026-10-02: `relay ↔ relay` on our coturn, 50 MB in 165 s = 0.3 MB/s with the phone behind a VPN — [the 2026-10-02 run log](docs/test-runs/2026-10-02.md))* — both sides switch to **Reliable**, repeat. Expected: `connected`; in
      webrtc-internals the selected candidate pair is **`relay`**, and coturn logs show an allocation
      from both peers. Then **transfer a ≈50 MB file over the relay** and note throughput — this is the
      only test that proves coturn's `external-ip` / port-forwarding config is actually right.
- [x] **C3 · mixed privacy (regression)** *(PASS 2026-10-02: both directions × link + room, all terminal in 16–19 s, no deadlock; the Max side's hint is lost when the peer gives up first — BACKLOG § UX bugs)* — one side **Max-privacy**, the other **Reliable**. Run it in
      **both directions** (swap which side creates, so each side gets to be the offerer) and on **both
      the room and the link method**. Expected: **no deadlock** — this is the `pendingPeerSignals` fix
      (a Reliable answerer still fetching TURN creds used to silently drop the offer). Either it
      connects directly, or the Max-privacy side fails closed with the hint — never a stuck "agreeing
      on keys".
- [x] **C4 · Max-privacy never relays** *(PASS 2026-10-02: no `turn-request` from the Max side in any of 4 runs, nothing relayed; control = the LAN runs that connected direct)* — — verifies the 2026-09-12 audit fix.** During C3 confirm on the
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
- [x] **C6 · volume padding, and what it costs on a real link — NEW 2026-09-17.** *(✅ 2026-10-03 on the iPhone: 300 KiB → 524 371 B on the wire (+70.7 %), 50 MB → +0.7 % at 4.0 MB/s, files the real size — but the path was not recorded and was probably the USB cable, not LTE, so the cellular cost is still unmeasured; [the 2026-10-03 run log](docs/test-runs/2026-10-03.md), the C6 caveat)* In Max privacy the
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
- [x] **C5 · mobile-to-mobile** *(DROPPED by the owner 2026-10-03: both handsets have each been paired with the Mac across networks — Max fails closed, Reliable relays — and a phone↔phone pair would add only a second carrier NAT on the same relay)* — IPH (LTE) ↔ AND-1 (different LTE / other Wi-Fi), Reliable. The
      carrier-NAT-to-carrier-NAT case the desktop pair never exercises.

## Phase D — room lobby (mesh) · entirely T1

- [x] **D1 · roster** — MBP-A creates a room; IPH, AND-1, AND-2 join. Expected: every member sees the
      others by readable id and join time, in join order; leaving a device removes its row. *(Reworded
      2026-09-27: the coarse device label the plan used to expect is gone from the protocol — owner's
      decision, BACKLOG § UX bugs — after the redesign had already stopped rendering it. The 2026-09-27
      tick checked exactly the id + join time.)*
- [x] **D2 · joiner ↔ joiner** — IPH connects to AND-1 (neither is the creator). Expected: it pairs and
      completes SAS normally. The TRANSPORT role (who offers) still comes from the id order, which is
      why this case exists; the SAS reader/picker split no longer does (see A4), so check here too
      that exactly one side reads.
- [x] **D3 · busy reject** — while IPH↔AND-1 are paired, MBP-A presses Connect on IPH. Expected: MBP-A
      gets a clear **busy notice and returns to the lobby** — no hang, no silent failure.
- [x] **D4 · two independent pairs** — pair IPH↔AND-1 and MBP-A↔AND-2 **in the same room**, then
      transfer on both at once. Expected: both work; neither pair's per-pair signaling close disturbs
      the other; the room survives.
- [x] **D5 · SAS mismatch** — on a fresh pair, deliberately pick the **wrong** phrase. Expected: a hard
      failure with a clear message; no transfer possible afterwards.

## Phase E — reconnect (codeless since 2026-09-25: tap Reconnect on both, no code) · T1, except E6/E7 on real devices

- [x] **E1 · pin created** — after any successful fresh pairing (A1–A4), both devices list the peer
      under recent devices, **once** (the dedup-by-peer-key fix — pair the same two devices 3 times and
      confirm still exactly one row).
- [x] **E2 · reconnect happy path** — on MBP-A tap **Reconnect** on the IPH row; MBP-A shows "Waiting
      for the other device" with **no code anywhere**. On IPH tap **Reconnect** on the MBP-A row.
      Expected: `connected` **without any SAS screen** (pin-based re-auth), then transfer works. In
      devtools → WS on either side: the socket URL carries `room=<22-char token>&codeType=token` and
      no `create=1` — the same shape as a link (this is the "server cannot tell a reconnect from a
      first meeting" claim; record it).
- [x] **E3 · order does not matter** — repeat E2 with IPH tapping first and MBP-A a minute later, and
      once more tapping both within a second of each other. Expected: `connected` every time. (Under
      the old by-code design "both press Start" opened two rooms that never met; that is the bug this
      case now proves gone.)
- [x] **E4 · nobody came** — tap Reconnect on MBP-A only. Expected: the wait screen, then after
      **10 minutes** a clear "The other device did not show up" failure — never a silent spinner.
      Meanwhile in devtools → WS: the socket is re-taken every ~2 minutes (a fresh room, same token
      within the 10-minute bucket; a new token at a bucket boundary). Also try: MBP-A on Reconnect
      while IPH does a **plain room join** with any 4-digit code — expected: nothing meets, MBP-A ends
      the same way; no hang, no handshake mismatch (there is no shared room to mismatch in).
- [x] **E6 · reconnect over a SLOW link** *(PASS 2026-10-02: 5/5 in 5.4–6.7 s, Pixel 5 behind a VPN in France ↔ Mac, relay both ways — the link is slow but not cellular; [the 2026-10-02 run log](docs/test-runs/2026-10-02.md))* — the case the 2026-09-17 race lived in.** An early reconnect
      frame (today the `reconnect-hello` both sides send at channel-open) used to be dropped for good
      when it arrived before the receiving side had processed channel-open, leaving both peers in
      "agreeing on keys" until the 120 s deadline. It is fixed (held and replayed), and the window
      widens when the channel-open path is slow — which is exactly what a phone on a weak cellular
      signal produces. So: reconnect **IPH on LTE with one bar (or with the Network Link Conditioner on
      a bad profile) ↔ MBP-A**, five times. Expected: `connected` without a SAS screen, every time. Any
      run that sits in "agreeing on keys" and then fails at ~120 s is the same bug returning — capture
      the DEV log, which names which guard dropped what (`reconnect: dropped …` / `holding …` /
      `replaying held …`).
- [x] **E5 · the other side forgot the pairing** — on IPH press **forget** (clears pins), then tap
      Reconnect on MBP-A using the stale row. Expected: IPH has no row to tap and cannot derive the
      rendezvous; MBP-A waits and ends in "did not show up" (E4), whose copy says to pair afresh. Then
      pair afresh by any method (A1–A4): expected `connected`, and afterwards MBP-A lists IPH **once**
      (the dedup) — a reconnect from that new row works. **Never a silent auto-accept.** (The
      key-changed hard stop itself — a peer presenting a DIFFERENT key under the SAME pairing — cannot
      be produced on real devices without the DEV forge knob; it is covered by the e2e.)
- [x] **E7 · clock skew — NEW 2026-09-25.** *(PASS 2026-10-02 on the Pixel 5: +4 min met in 4.1 s; +15 min never met, both sides "did not show up" at 603 s with six rendezvous takes each — [the 2026-10-02 run log](docs/test-runs/2026-10-02.md))* The rendezvous is derived from each device's OWN clock in
      10-minute buckets. Set IPH's clock **+4 minutes** by hand (disable automatic time), then E2.
      Expected: they still meet — at worst after a delay of up to the skew (each side re-derives at
      its own bucket boundary), never a failure. Then set it **+15 minutes** (more than a bucket):
      expected: they meet only once the wait has absorbed the skew, or MBP-A ends in "did not show
      up" at 10 minutes — record which, this is the stated limit. Restore automatic time.

## Phase F — real-world robustness · mixed: F3/F5/F6/F7 are T1, the rest need a radio or a dialog

- [x] **F1 · phone screen lock / app switch mid-transfer** *(Android half ✅ 2026-10-02/03 on the Pixel 5: the 200 MB receive ran on under the locked screen, the finished row showed "arrived in the background — Save file", one tap landed it in Downloads with the right SHA-256; IPH ❌→✅ 2026-10-03: iOS Safari tears the connection down on screen lock (both sides "Connection lost" within 17 s); MITIGATED the same day by a Screen Wake Lock requested inside the Accept / Send tap (`bf485ae`) — a 3 GiB receive with Auto-Lock at 30 s ran to Delivered with the phone untouched; a deliberate lock or an app switch still ends it (measured), and the transfer screen says so)* — start a ≈200 MB transfer to IPH, then lock
      the screen / switch apps for ~30 s and come back. Expected: either it keeps going or it fails
      visibly with a recoverable state — **iOS suspends background tabs**, so record exactly what
      happens; this is the single most likely real-world surprise. **Since 2026-09-28:** if the file
      completed while the screen was locked, the finished row must show **Save file** (the download was
      held, not lost — the simulator rehearsal lost it silently); tap it and check the file.
- [x] **F2 · network drop** *(PASS 2026-10-02: Pixel 5's Wi-Fi off 20 s mid-600 MB — both sides "Connection lost" 19 s after the cut; an ~8 s cut with nothing in flight recovered by itself — [the 2026-10-02 run log](docs/test-runs/2026-10-02.md))* — mid-transfer, disable Wi-Fi on one side for ~20 s and re-enable.
      Expected: a visible failure or a recovery, never a frozen progress bar that claims to be alive.
- [x] **F3 · tab close** — close the receiver's tab mid-transfer. Expected: the sender notices and shows
      a failure.
- [x] **F4 · large transfer** *(DROPPED by the owner 2026-10-03: no second computer; the 2 GB-class transfers ran Mac↔phone instead — B10, [the 2026-10-03 run log](docs/test-runs/2026-10-03.md))* — ≈2 GB MBP-A Chrome → MBP-B Chrome (the receiver streams straight into
      Downloads, no dialog — since 2026-09-28). Expected: it completes, memory stays flat, and the
      signaling socket is long gone by then (A6).
- [x] **F5 · code expiry** — create a words session and leave it untouched past its TTL, then try to
      join. Expected: the code is freed — the waiting side is closed out (4010) and a later join gets
      `room not found` (4009), with a readable message rather than a raw code.
- [x] **F6 · history is session-only** — after a few transfers, reload the page. Expected: the transfer
      history is **empty** (in-memory only); `localStorage` holds only lang/theme/privacy prefs.
- [x] **F7 · second joiner on a 1:1 method** — forward the same link/QR to a second device. Expected:
      the one-time link reaches exactly one receiver. Which refusal the second joiner sees depends on
      timing: after the first pair connects, both sockets close and the token room is gone, so the
      second joiner gets the dead-link failure ("the link has expired or was already used") at once;
      the 4002 "room full" bounce is reachable only while the first two are still pairing.
- [x] **F8 · silent peer on the 1:1 confirm path** *(Android half ✅ 2026-10-03: Pixel 5 on a VPN Wi-Fi, Reliable, Wi-Fi cut right after `welcome` — the sender ended in 25 s, the server's `peer-left` beat the 120 s deadline; [the 2026-10-03 run log](docs/test-runs/2026-10-03.md). IPH half CLOSED AS A TOOLING LIMIT 2026-10-03: the "silent peer" needs a hook installed before the page loads, which Safari WebDriver cannot do; the mechanism is proven on the Pixel and headlessly)* — open a link on the receiving device and, the
      instant the connection starts, put that browser in a state where it cannot answer (airplane mode
      works; force-quitting the tab does not — that raises a channel close instead, which is a
      different path). Expected: the SENDER ends in **`failed` within ~120 s**, not an endless
      "agreeing on keys". This deadline is new (2026-09-12); before it, this path had no client-side
      bound at all and only the untrusted server's room TTL ended the wait — a server that simply
      never expired the room hung the client forever. **Time it and write the number down.**
- [x] **F9 · slow mobile network does NOT trip the new deadlines** *(PASS 2026-10-02 on the slow link available — Pixel 5 behind a VPN, relayed: words 5.5 s, room/SAS ×2 — no cellular, the phone has no SIM)* — the mirror of F8 and the risk it
      carries. Repeat A3 (words) and A4 (room/SAS) on a **weak cellular** connection, not Wi-Fi. The
      SAS nonce reveal now waits for the DTLS fingerprints to be pinned, so the handshake has more
      serialised steps than before. Expected: still connects well inside 120 s. If a real phone on a
      real network gets anywhere near the deadline, the deadline is wrong, not the network.

---
