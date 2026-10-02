# hushsend — real-device test pass (step 6e)

Everything that can be verified without physical devices is done (unit + integration + Playwright
e2e across four engine projects, feature-detection review, self-hosted QR WASM); what remains is
**behaviour on real browsers, real networks, and real NAT**.

This used to open "the last open item before the security audit" — the audit has since run twice
internally (2026-09-12 and 2026-09-13, BACKLOG § Security audit), so that ordering is gone: the
device pass is now the last open item before a public launch, not before the audit. **Progress: 21 of
the 47 A–F cases are closed (A4a, A4b, A6, A7, B1, B7, B9, D1–D5, E1–E5, F3, F5–F7 — see § Result log:
the four 2026-09-27 entries and the 2026-09-28 ones, where A4b closed on the live build and B1 closed
twice — on the site-storage path in the morning, and again on the straight-to-Downloads path after
`c5a51c4` went live); the
desktop halves of A1, A2, A3, A4, A5, A6a, B2, B3, B5, B6, B8, B10, C6, E7 and F8 ran on the REAL
desktop engines (Chrome, Brave, Safari, Firefox) and wait for their handset half — B2's and B10's under
the receive paths replaced on 2026-09-28, so those desktop halves are due again; the iOS-Simulator,
iPad-Simulator and Android-Emulator rehearsals (2026-09-27 evening entry) covered A1, A3, A4, A5, B4
(paste fallback), B5, B6, B8, B10's caps, F1, F2 and F8 — rehearsals, not ticks; 1 is still FAILED
(F2, on the emulator with real airplane mode — its root cause is fixed and live since `153addd`, the
re-run needs a phone) and is in BACKLOG — A4b and F3 failed too and pass on the live build; the rest
need a handset, a radio or a camera.** (The total read "46" here until 2026-09-28: a stale count — the
plan has 47 checkbox cases.) The ticks in § 0.1 are PRECONDITIONS, not cases; do not read them as
progress.

> **2026-09-28: the owner's seven decisions are LIVE** — deployed by the owner at 04:32 UTC (frontend
> `90fdc15`, whose app code is `673509d`'s: the receiver's confirmation, the A4b stop, the forget
> confirmation, no device label, the disk-first receive path, "Save file", the failure screens, the
> relayed verdict; then signaling `3d96125`), verified the same hour — § 0.1 re-ticked. Cases whose
> expectations changed (B1, B2, B10, F1, F4) are reworded below; B1 was unticked for the change and
> closed again on the live build.
>
> **2026-09-28, later: LIVE since 06:32 UTC (`c5a51c4`)** — desktop Chromium now receives STRAIGHT INTO
> DOWNLOADS through a download worker (no copy in site storage, no RAM, no dialog); site storage is
> reserved before accept (the incognito quota lie); flow control (a paused download pauses the sender).
> B1, B2, B10 and F4 were reworded for it; B1 then passed on the live build again the same morning, and
> the desktop halves of B2 and B10 were re-run there (§ Result log, the last 2026-09-28 entry).
>
> **2026-09-27, after the pass: the F2/F3 root cause is fixed and DEPLOYED** (the connection-lost
> path — BACKLOG § UX bugs, first item; live since 19:58 UTC as `153addd`, § 0.1 re-ticked). **F3 passes
> on the live build** (fourth 2026-09-27 entry). F2 stays unticked until re-run on a real phone.
> Expected: "Connection interrupted" within ~6 s of the cut, then the "Connection lost" screen when the
> engine gives up (Chrome ~16 s). The same change closes the transport on `pagehide`: in **F1**, if the
> session ends the instant the phone locks or switches apps (rather than when the network gives up),
> suspect that and write it down.

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
      (§ Result log, end of the 2026-10-02 entry). Before it, 2026-10-03 ~00:55 UTC (commit `190151b`: the three UX fixes from the Pixel 5 pass — the
      Max hint under the peer-left race, the reconnect wait's retry, the Finishing line);
      `/var/www/hushsend/dist` is byte-identical to a clean local build of `190151b` (42 files), the public
      URL serves `index-CkRmiW5i.js`, no `stun.l.google`; the three fixes were then checked on the live
      build (§ Result log, end of the 2026-10-02 entry). The visual gate ran on the deploy host against
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
- [x] **The relay actually relays:** `bash deploy/verify-relay.sh` → OK — 2026-09-27 on the server:
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
| MBP-A | MacBook | macOS 26 | Chrome 154 | Blink | Claude via **Playwright** driving the installed Chrome (`channel:'chrome'`, persistent profiles, since 2026-09-27) | straight into Downloads through the download worker (since 2026-09-28, not yet live); site storage only if the worker cannot come up | zxing ponyfill (never native — see B3) |
| MBP-A | MacBook | | Brave 154 (shields up) | Blink | Claude (Claude-in-Chrome extension) | the stream path expected (desktop Chromium; not probed — shields may block the worker, then site storage) — Brave ships no `showSaveFilePicker`, so no dialog fallback | zxing ponyfill |
| MBP-A | MacBook | macOS 26 | Safari 26.6 | **WebKit (the real one)** | Claude via **WebDriver** (`safaridriver`, since 2026-09-27 — see § 0.5) | OPFS (probed 2026-09-27: writes to disk, quota 76.8 GiB) | zxing ponyfill |
| MBP-A | MacBook | macOS 26 | Firefox 156 | Gecko | Claude via **WebDriver** (`geckodriver`, since 2026-09-27) | OPFS (probed 2026-09-27: writes to disk, quota 10 GiB) — never the stream path: Firefox fails a streamed download unsafely (2026-09-28) | zxing ponyfill |
| MBP-A | MacBook | macOS 26 | Claude's built-in Chromium 152 | Blink | Claude (built-in browser) — a SECOND profile next to Brave, so E-cases are honest | the stream path expected (desktop Chromium); before 2026-09-28 its FSA dialog could not be shown in the pane | zxing ponyfill |
| MBP-B | MacBook | | Chrome | Blink | Claude (Playwright) | straight into Downloads (the stream path) | zxing ponyfill |
| IPH | iPhone | | Safari (WebKit) | WebKit + phone limits | Claude via Safari Web Inspector (USB) | OPFS expected (not yet probed on a device); Save file if the screen was locked | zxing ponyfill |
| AND-1 | **Google Pixel 5** (the owner's; attached 2026-10-02) | Android 14, patch 2023-11-05 (EOL) | Chrome 152 | Blink | Claude over CDP via USB (`adb forward … chrome_devtools_remote`, the `android-device` skill) + `adb` for native UI; no SIM — "LTE" is a second Wi-Fi with a VPN exit in France | OPFS expected (mobile Chromium does not stream until a handset proves it — B2/B10) — no dialog while the connection is live; the save dialog only past the quota (Chrome 149 HAS `showSaveFilePicker`, and a dialog left open ~20 s killed the connection — why disk-without-dialog is now first) | zxing ponyfill (never native) |
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

- [ ] **A1 · link** *(AND-1 half ✅ 2026-10-02 — Pixel 5 Chrome ×3; the named IPH run pending)* — MBP-A (Chrome) creates a one-time link → send it to IPH (Safari) out of band →
      IPH opens it. Expected: auto-join, pairing, `connected` with **no SAS screen** (link/QR
      authenticate over the link secret), URL fragment scrubbed from the address bar.
- [ ] **A2 · QR** *(AND-1 half ✅ 2026-10-02 on the fixed live build `9bdda44` — the Pixel 5 decoded the QR off the Mac's screen and connected in 8.5 s; before the fix the scanner was dead on every engine, § Result log. IPH pending)* — MBP-A shows the QR, IPH scans it with the in-app scanner. Expected: same as A1.
      Note which decoder ran (§ B3).
- [ ] **A3 · words** *(AND-1 half ✅ 2026-10-02; IPH pending)* — MBP-A creates, IPH enters the rendezvous + the 4 secret words. Expected: `connected`
      after CPace + key confirmation, no SAS screen.
- [ ] **A4 · room / SAS** *(AND-1 half ✅ 2026-10-02, 8 rooms, reader 5× creator / 3× phone; IPH pending)* — MBP-A creates a 4-digit room, IPH joins → both land in the **lobby**, MBP-A
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
      "Verifying…" ends both sides in the hard stop; § Result log.)*
- [ ] **A5 · transfer both ways** *(AND-1 half ✅ 2026-10-02: site storage on the phone, the stream path on the Mac, both verified; IPH pending)* — over the A1 connection send a small file (≈5 MB) MBP-A → IPH, then
      IPH → MBP-A. Expected: progress advances monotonically, file arrives intact (**check the size and
      open it**), receiver's terminal plaque shows a **"New transfer"** button.
- [x] **A6 · WS closes on connect** — in devtools Network → WS, confirm the signaling socket **closes
      shortly after `connected`** for all of A1–A4 **and for reconnect (Phase E)**, while the transfer
      keeps working afterwards. This is the per-pair privacy close: the server must not observe the
      session duration. Reconnect was the last exemption and was folded in on 2026-09-12 — if its
      socket stays open, that regression is the whole point of checking it here.
- [ ] **A6a · path attestation never blocks a transfer** — it is ADVISORY. On every pair, especially
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
      B2/B10. PASS on the live `c5a51c4` the same day — § Result log.)*
- [ ] **B2 · disk receive on the phone + the RAM fallback's cap** — receive on IPH Safari and on MBP-A
      Firefox (both keep site storage — neither may stream, see CLAUDE.md § File transfer). Expected:
      no save dialog; the file goes to site storage and lands via a download at the end — a file well
      past 200 MiB (say 1 GiB) must complete on the PHONE, which is what the disk path is for. Then in a **private window** (where site storage may be unusable → the RAM path)
      offer a file **over 200 MiB**: the receiver must **refuse before accepting**, naming the limit —
      never accept and then die of OOM mid-transfer. *(Reworded 2026-09-28 for the disk-first path; the
      old caps were 512 MiB phone / 1 GiB desktop.)* **2026-09-28, desktop Chrome incognito: FAILS this
      rung** — there site storage IS usable but holds only ~430 MiB while `navigator.storage.estimate()`
      reports the normal profile's 10 GiB, so a 600 MiB file was accepted on the disk path and died at
      74 % (§ Result log, BACKLOG § UX bugs). Re-run after the fix: Chrome incognito now streams into
      Downloads (expect a 1 GiB file to complete there, nothing in site storage); Firefox private has no
      site storage (`getDirectory()` → SecurityError, measured) — expect the RAM path, a refusal before
      accept above 200 MiB; Safari private — by hand (safaridriver cannot open one).
- [ ] **B3 · QR scan + self-hosted WASM** *(AND-1 half ✅ 2026-10-02 on `9bdda44`: the scan fetched the ponyfill + `zxing_reader-BxB2YfIY.wasm` from our origin only and decoded; IPH Safari + AND-2 Firefox pending)* — scan on IPH Safari and AND-2 Firefox (the ponyfill path).
      Expected: scanning works, and in Network the WASM is fetched from
      `https://hushsend.frelikh.dev/assets/zxing_reader-*.wasm` with `Content-Type: application/wasm`.
      **Nothing may be requested from `jsdelivr` / `fastly` / any third-party host** — that is the whole
      point of the 6e vendoring. Also scan on AND-1 Chrome — it fetches the SAME WASM: the app imports
      `barcode-detector/ponyfill`, which is always the zxing implementation and never delegates to a
      native `BarcodeDetector` (measured 2026-09-27 on desktop Chrome, which has one; corrected from
      "native; no WASM fetch at all").
- [ ] **B4 · camera permission denied** *(Android half ✅ 2026-10-02: Block → paste fallback, no crash; re-allow is via the site-settings sheet because Chrome offers "Never allow"; IPH pending)* — on IPH, deny the camera prompt. Expected: a clean
      **paste-the-link fallback**, no crash, no dead screen. Re-allow and confirm the scanner recovers.
- [ ] **B5 · share / copy** *(AND-1 half ✅ 2026-10-02 — the system share sheet opened on a real tap; IPH + Firefox halves pending)* — on IPH and AND-1 the **Share** button uses the native sheet; on MBP-A
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
- [ ] **B6 · theme / language / layout** *(Android half ✅ 2026-10-02 — both themes, no clipping, 44 px targets; iPhone pending)* — check the app in light+dark and EN+RU on the iPhone and on a
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
- [ ] **B10 · size ladder up to 5 GB — every receive path, every engine as sender — NEW 2026-09-27
      (owner's request).** *(Handset half of the site-storage row ✅ 2026-10-02: Pixel 5 Chrome, 1 / 2 / 3 / 4 GiB + 1 B / 5 GiB all PASS at 3.0–5.5 MB/s, Chrome PSS flat 201–264 MB — § Result log. Still open: the RAM rung and past-the-quota on a phone, and an iPhone.)* Limits differ by OS, browser and device, and § 0.3's ceilings come from
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
      | *(2026-09-28, the live `c5a51c4`: the stream rungs PASS on Chrome, the site-storage rungs PASS on Firefox with the over-quota refusal and on Safari to 5 GiB, the RAM rung PASS on Firefox private — § Result log. The desktop half of B10 is done; the handset half is what is left.)* | | |

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

- [x] **C1 · Max-privacy direct across networks** *(PASS 2026-10-02, outcome (b): Mac Chrome ↔ Pixel 5 on a VPN Wi-Fi, both sides terminal `failed` with the hint in 18–48 s — § Result log)* — both sides default Max-privacy, link method.
      Expected either (a) `connected` via a `srflx` candidate pair — confirm in webrtc-internals that
      the selected pair is **not `relay`** — or (b) if the NATs won't traverse, a **terminal `failed`
      screen with the "switch to Reliable" hint**. Both are correct; a **hang is not**. Record which.
- [x] **C2 · Reliable relay** *(PASS 2026-10-02: `relay ↔ relay` on our coturn, 50 MB in 165 s = 0.3 MB/s with the phone behind a VPN — § Result log)* — both sides switch to **Reliable**, repeat. Expected: `connected`; in
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
- [x] **E6 · reconnect over a SLOW link** *(PASS 2026-10-02: 5/5 in 5.4–6.7 s, Pixel 5 behind a VPN in France ↔ Mac, relay both ways — the link is slow but not cellular; § Result log)* — the case the 2026-09-17 race lived in.** An early reconnect
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
- [x] **E7 · clock skew — NEW 2026-09-25.** *(PASS 2026-10-02 on the Pixel 5: +4 min met in 4.1 s; +15 min never met, both sides "did not show up" at 603 s with six rendezvous takes each — § Result log)* The rendezvous is derived from each device's OWN clock in
      10-minute buckets. Set IPH's clock **+4 minutes** by hand (disable automatic time), then E2.
      Expected: they still meet — at worst after a delay of up to the skew (each side re-derives at
      its own bucket boundary), never a failure. Then set it **+15 minutes** (more than a bucket):
      expected: they meet only once the wait has absorbed the skew, or MBP-A ends in "did not show
      up" at 10 minutes — record which, this is the stated limit. Restore automatic time.

## Phase F — real-world robustness · mixed: F3/F5/F6/F7 are T1, the rest need a radio or a dialog

- [ ] **F1 · phone screen lock / app switch mid-transfer** *(Android half ✅ 2026-10-02/03 on the Pixel 5: the 200 MB receive ran on under the locked screen, the finished row showed "arrived in the background — Save file", one tap landed it in Downloads with the right SHA-256; IPH pending)* — start a ≈200 MB transfer to IPH, then lock
      the screen / switch apps for ~30 s and come back. Expected: either it keeps going or it fails
      visibly with a recoverable state — **iOS suspends background tabs**, so record exactly what
      happens; this is the single most likely real-world surprise. **Since 2026-09-28:** if the file
      completed while the screen was locked, the finished row must show **Save file** (the download was
      held, not lost — the simulator rehearsal lost it silently); tap it and check the file.
- [x] **F2 · network drop** *(PASS 2026-10-02: Pixel 5's Wi-Fi off 20 s mid-600 MB — both sides "Connection lost" 19 s after the cut; an ~8 s cut with nothing in flight recovered by itself — § Result log)* — mid-transfer, disable Wi-Fi on one side for ~20 s and re-enable.
      Expected: a visible failure or a recovery, never a frozen progress bar that claims to be alive.
- [x] **F3 · tab close** — close the receiver's tab mid-transfer. Expected: the sender notices and shows
      a failure.
- [ ] **F4 · large transfer** — ≈2 GB MBP-A Chrome → MBP-B Chrome (the receiver streams straight into
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
- [ ] **F8 · silent peer on the 1:1 confirm path** *(Android half ✅ 2026-10-03: Pixel 5 on a VPN Wi-Fi, Reliable, Wi-Fi cut right after `welcome` — the sender ended in 25 s, the server's `peer-left` beat the 120 s deadline; § Result log. IPH pending)* — open a link on the receiving device and, the
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

## Result log

Record per case: `ID · track (T1/T2/T3) · device pair · browser versions · PASS/FAIL · notes`. The
track belongs in the line because the same case can be run two ways: a T1 desktop rehearsal of A1
proves the mechanism, a T2 run on the named MBP↔iPhone pairing is what closes it, and a log that does
not say which produced the tick cannot tell them apart later. For a failure capture:
the selected candidate pair (webrtc-internals / about:webrtc), the WS message trace, the console
output, and whether it reproduced on the other engine.

### 2026-09-26 · T1 rehearsal · Brave 154 (Chromium 154, macOS), two tabs of ONE profile

Setup: production bundle `index-BBI2zUuS.js` (`efe8b29`); both peers are tabs of the same Brave
profile, driven over the Claude-in-Chrome MCP from laptop-server. **Same profile = shared
`localStorage` and shared keystore**, so this setup cannot run the reconnect cases (E) honestly and
its privacy-mode toggle is global to both tabs. Two corrections to § 0.4 / § 0.5 found on the first
try: **the MCP extension is Chromium-only — Firefox and Safari cannot be driven by Claude at all**
(they are T2-style: the owner clicks, Claude observes its own side + the server); and `chrome://`
pages (`webrtc-internals`) are unreachable through it, so ICE evidence needs the owner's eyes.

- A1 · T1 · Brave↔Brave · **Max privacy · FAIL 2/2** — `pairing` → `failed` at 15.0 s both runs,
  "Couldn't connect directly" with the switch-to-Reliable hint (so B9's "fails visibly, never a
  silent hang" holds). **Not the app:** a raw STUN-only `RTCPeerConnection` pair between the same
  two tabs also ends `connectionState=failed` at 15 s with ZERO candidate pairs in `getStats()`.
  Candidates gathered: one mDNS host (`<uuid>.local`) + one srflx `192.168.1.1` (the router's LAN
  address — the hairpinned STUN reply). Root cause open; suspects are macOS "Local Network"
  permission for Brave and Brave's WebRTC IP-handling policy. To be re-run on Chrome.
- A1 · T1 · Brave↔Brave · **Reliable · PASS 2/3** — connected in 2 s and in <10 s, no SAS screen,
  fragment scrubbed from the address bar. One run failed at 17 s with "channel closed during
  pairing"; `deploy/verify-relay.sh` in the same minute: 16 messages relayed, 0 lost. Unexplained.
- A5 · T1 · Brave→Brave · Reliable · **PASS** — 5 000 000 B in <3 s, sender "Delivered" / receiver
  "Received" at 100 %, "New transfer" button present. Reverse direction ran as A7. **Bytes on disk
  NOT verified** (Brave ships no `showSaveFilePicker` → Blob download into the Mac's Downloads;
  expected sha256 `5ae91e7e…e2d9`).
- A6 · T1 · link · Reliable · **PASS** — `ss -tn` on the host: 0 established nginx↔signaling
  (`:8080`) sockets while both peers were `connected`, and still 0 during the transfer.
- A7 · T1 · Brave→Brave · **PASS, with a note** — three files are sent as ONE `hushsend-files.zip`
  (2 700 362 B, stored). That has been the behaviour since the first transfer commit (`1082b7d`)
  but no doc says so, and this case's "progress is per-transfer / no stale filename" wording
  assumes three transfers. Fix the wording, or the behaviour — decide, then re-tick.
- F6 · T1 · **PASS** — reload → history gone.
- B9 · partial — Brave 154 shields default: `showSaveFilePicker` **undefined** (so B1's FSA path
  cannot be run on Brave; it needs Chrome), `BarcodeDetector` present. Max privacy fails visibly
  (above). The WebRTC-policy value and the candidate-pair evidence are still to be read by the owner.
- **New UX bug (→ BACKLOG):** after `connected`, a peer that leaves (tab navigated away) is never
  surfaced — the other side sits on "Secure channel open" indefinitely; a later Send fails with
  "transfer error · data channel is not open" while the status still says `connected`.
  `onChannelClose` has no `established` branch. Related to F3 but a distinct case (idle, not
  mid-transfer).
- **New UX bug (→ BACKLOG):** a link opened in a tab that already shows hushsend is a hash-only,
  same-document navigation; the app parses the fragment at load only (`App.tsx` `parseLink`), so
  nothing happens. Pasting a link into the address bar of an open hushsend tab does exactly this.
- Tool note, not app: the extension's ref-based clicks did not toggle the privacy radio nor open
  Invite; coordinate clicks did.

### 2026-09-27 · T1 on all three REAL desktop engines · Brave 154 ↔ Claude Chromium 152 ↔ Safari 26.6 ↔ Firefox 156

Setup: production bundle `index-BBI2zUuS.js` (`efe8b29`, unchanged); `/health` ok. Four browsers,
four separate profiles/keystores: **Brave 154** (Claude-in-Chrome extension; no FSA), **Claude's
built-in Chromium 152** (its own profile; FSA present but the pane cannot show the save dialog),
**Safari.app 26.6** and **Firefox.app 156.0.1** driven over **WebDriver** (`safaridriver -p 4444`
after `safaridriver --enable` + Develop → Allow Remote Automation; `geckodriver 0.37.1` from brew) by a
file-based driver running in the owner's terminal, outside the Claude sandbox. This supersedes the
2026-09-26 "Firefox and Safari cannot be driven" note: they can, but two caveats — **safaridriver
sessions are storage-isolated and geckodriver starts a fresh profile per session**, so Safari/Firefox
pins live only inside one session (E-cases on them need Safari.app/Firefox.app by hand). SSH to the
host failed from the sandbox all session (`No route to host`), so server-side evidence (`ss`,
journalctl) is absent; all WS/ICE evidence below comes from in-page wrappers over `WebSocket` and
`RTCPeerConnection` installed on the creator side before the pairing. `chrome://webrtc-internals` is
unreachable from both Chromium drivers.

**Root cause of the 2026-09-26 Max-privacy failures — the macOS "Local Network" permission, not the
app.** On this LAN every browser gathers one mDNS host candidate (`<uuid>.local`) plus an srflx of
`192.168.1.1` — the hairpinned STUN reply names the ROUTER's LAN address, useless between LAN peers —
so a same-LAN Max-privacy pair rides on mDNS alone. Brave could not even connect two
`RTCPeerConnection`s inside ONE page (ICE stayed `new` for 20 s; Chromium: 8 ms), and the moment the
owner granted Privacy & Security → Local Network to Brave/Firefox/Safari it opened in 14 ms and every
Max-privacy case below passed. README item: on macOS 15+ a browser without that permission cannot pair
on the same LAN in Max privacy; the app fails visibly with the Reliable hint (correct), but the hint
sends the user to the wrong fix.

Engine pairs (all link method, Max privacy unless stated; `unknown` = "direct path not confirmed"):

| pair (creator → joiner) | connected | selected pair (creator's stats) | WS close after connect | path verdict |
|---|---|---|---|---|
| Brave → Chromium · Max | 14 ms after the joiner arrived | host udp → host (mDNS, addresses hidden) | 50 ms | unknown / unknown |
| Brave → Chromium · **Reliable** | 0.2 s | host udp → host — `turn-request`/`turn-credentials` exchanged, TURN in `iceServers`, relay NOT selected | at connect | unknown |
| Safari → Chromium | 1.0 s | host → host udp | 160 ms | unknown / unknown |
| Firefox → Chromium | 1.8 s | host `<uuid>.local` → host `<uuid>.local` udp | 200 ms | unknown / unknown |
| Firefox → Safari (run 1) | 1.2 s | host (mDNS) → **prflx** | 34 ms | Firefox unknown; Safari pending at +3 s |
| Firefox → Safari (run 2) | 0.8 s | host (mDNS) → prflx | 20 ms | unknown / unknown |
| Safari → Firefox | 0.6 s | host → host udp | 208 ms | unknown / unknown (Safari read at +60 s) |

So on one LAN in Max privacy the attestation verdict is `unknown` on EVERY engine pair, including
Blink↔Blink, because mDNS hides the host addresses the check needs; the headless firefox↔webkit
`mismatch` did NOT reproduce on the real engines. The A6a table still needs the cross-network runs.

- A1 · T1 · every pair in the table · **PASS** — auto-join, no SAS, fragment scrubbed. (Handset half
  open.) First Brave→Chromium Max run FAILED at 9.6 s with the Reliable hint — the permission, above.
- A3 · T1 · Brave creates, Chromium enters the five words · **PASS** — `connected` in 0.8 s, "code
  words verified", no SAS; only the rendezvous word reached the server (`room=ebook&codeType=word`).
- A4 · T1 · Brave↔Chromium (room 0164, then 4422) · **PASS** — both land in the lobby, pick → SAS
  asymmetric: one reader, one blind picker with the real phrase among 3. Roles vary (Safari read once
  and picked once against Chromium); Brave read in all 3 Brave↔Chromium pairs — sample more.
- A4a · T1 · **PASS** — both refusals are 52-px full-width pills directly under the confirm
  (400/431 px wide at desktop), the HEARD sentence sits directly above the reader's confirm; picker's
  refusal → both sides on "This channel may be compromised" in ≤1.4 s, no transfer UI. Copy nit: the
  kicker says "numbers didn't match".
- A4b · T1 · **FAIL** — the reader confirmed before the picker answered and landed on "Verifying…"
  (`confirming`) with NO control at all: no abort, no Back. The controller would accept a reject after
  approval; the screen cannot send one. → BACKLOG.
- A5 · T1 · all directions Brave↔Chromium (Reliable + Max), Chromium↔Safari, Chromium↔Firefox,
  Safari↔Firefox · **PASS** — 5 000 000 B each way, monotonic, receiver Blob captured via a
  `URL.createObjectURL` hook and SHA-256 equal to the sender's every time; "New transfer" present.
  200 MiB Chromium→Brave ≈48 MB/s on the LAN. (Handset half open.)
- A6 · T1 · link (Max, Reliable), words, room/SAS, reconnect — on Brave, Chromium, Safari, Firefox ·
  **PASS** — every creator/joiner closed its socket 20–460 ms after `connected` (code 1005), transfers
  ran afterwards. Reconnect included (Brave 170 ms, Chromium 100 ms).
- A7 · T1 · **PASS with the known note** — 3 files arrive as one `hushsend-files.zip` (2 700 724 B);
  wording decision still open, not re-ticked.
- B2 · T1 desktop half · real Safari and real Firefox receivers · **PASS** — Blob path, no dialog; a
  1 258 291 200 B offer is refused BEFORE accept within 1.5 s: "This file is 1.2 GB — larger than the
  1.0 GB this browser can save. Open hushsend in Chrome on desktop to receive it."; the sender shows
  "declined" + that reason. Note for drivers: the FSA-vs-Blob choice is made when the OFFER arrives.
- B5 · T1 desktop half · **PASS** — Firefox (no `navigator.share`): Share absent, Copy present;
  Safari desktop: both present.
- B6 · T1 desktop half · Chromium emulating 375×812 + dark · **PASS** — home, the open
  network-exposure block and the words picker: no horizontal scroll, nothing overflows the viewport,
  52-px pills, 44-px word fields at 17.6 px. Real phone still T3.
- B8 · T1 · real Safari + real Firefox · **PASS** — `network-exposure` is a `<details>`, closed by
  default, opens on click, 777 chars naming the direct-connection fact and the Tor/VPN advice; no
  horizontal scroll at 1000/1710 px. Phone width covered by B6 above (375 px, Chromium).
- B9 · partial — Brave 154 shields default: Max privacy WORKS once Local Network is granted (host
  candidates gathered and used, srflx gathered); `showSaveFilePicker` still absent (so B1/F4 need a
  real Chrome, which the owner does not have). The WebRTC-policy value in `brave://settings` is
  still the owner's eyes.
- C6 · T1 arithmetic half · Brave→Chromium Max · **PASS** — 307 200 B file → data-channel
  `bytesSent` 524 745 B (= the 512 KiB bucket + ~457 B control), receiver wrote the real 307 200 B,
  hash equal; 5 000 000 B → 5 243 376 B (the 5 MiB bucket, +4.9 %). LTE cost half open.
- D1 · T1 · room 4422 with Brave, Chromium ×2 tabs, real Safari · **PASS** — every roster lists the
  other three with a label + join time; leavers disappear; a pair that CONNECTS also leaves the roster
  (its sockets close on connect — so D3 must be provoked during pairing, and the "room survives" of D4
  means the other pair's closes do not disturb it).
- D2 · T1 · Safari(joiner) picks Chromium tab-2(joiner) · **PASS** — one reader, one picker,
  `connected` in 0.6 s, "SAS confirmed".
- D3 · T1 · **PASS** — with Brave↔Chromium in the SAS phase, a third member pressed Connect on Brave →
  "vivid-robin is busy with another peer — pick someone else." in 0.2 s, back in the lobby with the
  roster intact; Brave's SAS undisturbed.
- D4 · T1 · Brave↔Chromium and Safari↔Chromium-2 in one room · **PASS** — both connected, transfers on
  both at once (52 428 800 B in 1.2 s; 5 000 000 B in 0.4 s; hashes equal), both still connected.
- D5 · T1 · picker chose a decoy · **PASS** — hard failure both sides in ≤0.6 s, no transfer.
- E1 · T1 · Brave↔Chromium paired 4× today, Chromium↔Safari/Firefox once each · **PASS** — one row
  per distinct peer key (Chromium: Brave, Firefox, two Safari sessions = 4 rows; Brave: Chromium once).
- E2 · T1 · Brave(profile A) ↔ Chromium(profile B) · **PASS** — "Waiting for the other device", no
  code; the other side taps → idle→joining→connected in 0.3 s, "verified via pinned key", no SAS;
  socket URL `room=<22-char token>&codeType=token&device=Desktop`, no `create=1` (claim recorded);
  1 000 000 B transfer afterwards, hash equal.
- E3 · T1 · **PASS** — Chromium-first (Brave ~5 s later; a full minute could not be waited from the
  sandbox, but the 10-min hold with 2-min re-takes is proven in E5) and both-within-101-ms: connected
  in 0.3–0.7 s, no SAS, every ordering.
- E4 · mechanics observed inside E5 (the lone waiter re-took the rendezvous at 120.6/240.6/389.6/
  510.9 s, a NEW token at 268.6 s = the 06:00 UTC bucket boundary, "did not show up" at 600.15 s);
  the "MBP-A only" and "plain 4-digit join on the other side" variants not run — not ticked.
- E5 · T1 · **PASS** — Chromium reconnect to Firefox whose profile no longer holds the pin → 10-min
  wait → "The other device did not show up" + the pair-afresh copy; forget Brave via the row ×
  ("Forget device …") → row gone; fresh link pairing → Chromium lists Brave ONCE again; reconnect from
  the new row → connected in 0.6 s. No silent auto-accept anywhere.
- F3 · T1 · Chromium sends 900 MB to Brave, Brave's tab closed at 8 % · **FAIL** — the sender froze
  at 46 % "Sending · connected" and never failed in 72 s of polling; recovered only via Close channel.
  Same root as the BACKLOG "peer gone after connected" bug, now shown mid-transfer. → BACKLOG.
- F5 · T1 · **PASS** — Firefox's words room: WS 4010 "expired" at 180.6 s, failed screen "Room not
  found or code expired" + "New words"; a later join with the same words: 4009 "room not found",
  same human message with the raw detail as a secondary line. (Copy nit: the CREATOR's expiry reads
  "Room not found".) Also observed: a 4-digit lobby with two members and no new joins dies at 3 min
  (idle TTL, by design) with the same "room not found" copy.
- F6 · T1 · re-confirmed on Chromium (reload → history gone; localStorage = theme/privacy only).
- F7 · T1 · Safari opens a link Brave→Chromium had already consumed · **PASS, different path** —
  failed in 0.4 s "the link has expired or was already used": the pair's sockets close on connect, so
  the token room is gone before a second joiner can be bounced with 4002; 4002 is reachable only while
  the first two are still pairing. The one-receiver guarantee holds either way.
- **Transport finding (real WebKit): Firefox(creator)↔Safari(joiner), run 1** connected, then Firefox
  saw `ice:disconnected` at +14 s and `failed` at +36 s, transport total 1 132 B, data-channel gone;
  a 5 MB transfer accepted on Safari stayed at 0 %. Run 2 and the reverse direction lived for minutes,
  and Safari.app CRASHED ("unexpectedly quit") minutes after run 1 and again later in the session —
  so the likelier reading is a WebKit process crash, not a protocol issue. Watch Console.app crash
  reports for Safari/WebContent; needs more runs.
- **UX finding (F2-class):** after that ICE failure BOTH sides kept showing `connected` ("Sending
  0 %" / "Receiving 0 %") for >60 s. Nothing in the app reacts to a dead connection after
  `established`. → BACKLOG (same item as F3 / peer-gone).
- Tooling notes: (1) the built-in-browser JS, the extension JS and Bash calls in one message run
  SEQUENTIALLY, so a 40 s poll on one side delays the other's action; (2) loading `/` and then the link
  in the same tab is the hash-only bug — always go through `/health`; (3) the Brave extension's first
  click after a navigation is often swallowed — JS `.click()` on the testids is reliable; (4)
  `d.type` in safaridriver hung the session twice — set values with the native setter + `input` event.

### 2026-09-27 (afternoon) · T1 + size ladder to 5 GiB + first iOS-Simulator rehearsal · Chrome 154 ↔ Safari 26.6 ↔ Firefox 156 ↔ iPhone 17 simulator (iOS 27.0)

Setup: production bundle `index-BBI2zUuS.js` (`efe8b29`, unchanged; checked over HTTPS and on the host).
SSH to the host worked this time (invoked as the bare `ssh laptop-server '…'`): nginx / signaling /
coturn `active`, `verify-relay.sh` OK, 0 established signaling sockets. **Real Google Chrome 154** is new
in the matrix, driven over Playwright's `channel:'chrome'` with persistent profiles (chromeA / chromeB),
so the FSA path finally ran on the product it exists for. Safari/Firefox over WebDriver as in the
morning. The Mac's srflx this session was a PUBLIC address (212.175.35.143; once 176.88.94.88 on a cold
Firefox probe), not the morning's hairpinned 192.168.1.1, so this Mac was not behind the server's NAT
and the hairpin precondition was not exercised. The Mac has **8 GiB of RAM**, which bounds every number
below that involves memory. The harness (files, drivers, scenarios) is described in
`~/projects/claude/tools/webdriver/README.md` on the Mac.

**B7 · T1 · all four desktop engines · PASS (verdicts recorded).** Local dev build (`vite :5291`,
signaling `:8191`), because production has one STUN server and no DEV strip:

| engine | two loopback STUNs (3479 + 3480) | live `turn.hushsend.frelikh.dev:3478` + loopback 3479 |
|---|---|---|
| Chromium 152 (built-in) | `agree` · 127.0.0.1 | `disagree` · 212.175.35.143 vs 127.0.0.1 |
| Chrome 154 | `agree` · 127.0.0.1 | `disagree` · same pair |
| Safari 26.6 | `agree` · 127.0.0.1 | `disagree` · same pair |
| Firefox 156 | `unknown` (no srflx from a loopback server) | `unknown` · only 212.175.35.143 answered |

The `disagree` column is the check doing its job, not a bug: one server really sees loopback and the
other the public address. The open Firefox question is settled: **on a real network Firefox does report
an srflx candidate with its address in `getStats()`** (212.175.35.143), so the feature covers three
engines once two real STUN operators exist. Two caveats: from a LOOPBACK server Firefox reports nothing,
and on a cold profile its first srflx took **9.8 s** (a 4 s probe got none; warm probes took 0.26 s),
above `PROBE_TIMEOUT_MS` (4 s), so a cold Firefox can read `unknown` in production. → BACKLOG.

**B10 · size ladder (new case) · desktop half PASS, mobile rung rehearsed on the simulator.**

| receive path · pair | sizes | outcome |
|---|---|---|
| FSA (dialog → OPFS handle) · Chrome B → Chrome A | 1, 2, 3 GiB, 4 GiB + 1 B, 5 GiB | all done, every block verified; 51.1 / 50.7 / 47.0 / 45.1 / 50.6 MB/s; progress monotonic |
| senders into Chrome FSA | Safari → Chrome 5 GiB · Firefox → Chrome 5 GiB | both done, verified; 50.0 and 48.1 MB/s |
| Blob, desktop cap · Chrome B → Safari / Firefox / Chrome-without-FSA | 1 GiB + 1 B, 5 GiB | refused BEFORE accept in 0.3–1.0 s, reason names the 1.0 GB limit |
| same three | exactly 1 GiB | done; Blob verified in-page AND the file the browser saved to disk has the expected SHA-256 (`edef0d81…`) on all three |
| Blob, mobile cap · Chrome A → iPhone 17 simulator | 512 MiB + 1 B, 5 GiB | refused before accept, reason names the **512 MB** limit (the UA picked the mobile cap) |
| same | exactly 512 MiB | delivered in ~16 s; iOS asked "Do you want to download…", saved to Files; SHA-256 of the saved file matches (`486628bc…`) |

Memory (RSS of each browser's process tree, sampled every 5 s): the Chrome FSA receiver stayed flat for
every size (tree ≤ ~550 MiB, largest process ≤ 256 MiB at 5 GiB); the Chrome sender likewise (largest
≤ 215 MiB). **The Safari SENDER did not stay flat**: its WebContent process grew to ~940 MiB near the end
of the 5 GiB send (from ~300 MiB) and dropped after it. That is harmless on this Mac and a risk on a
phone. → BACKLOG. The simulator's largest process peaked at ~640 MiB while holding the 512 MiB Blob, but
simulator memory is the Mac's, so that number says nothing about a real iPhone. Copy nit: the cap + 1 B
refusal reads "This file is 1.0 GB — larger than the 1.0 GB this browser can save" (same for 512 MB).

- A7 · T1 · Chrome B → Chrome A (Blob path, download saved) · **PASS** under the corrected wording — the
  sender listed three files ("Send · 3 files"), the receiver was offered `hushsend-files.zip` 3.8 MB,
  `unzip -v` shows three Stored members and each is byte-identical (SHA-256) to its source; the next
  single file after "New transfer" was offered under its own name.
- A4 · T1 · Chrome A creates, Chrome B joins, 6 fresh rooms · roles vary: in the 5 that completed the
  creator read 3 times and picked 2 times, the real phrase was always among the picker's 3, all reached
  "SAS confirmed". One room creation showed no code within 20 s while the iOS Simulator was booting and
  the Mac was out of memory — not reproduced, unexplained.
- F8 · T1 desktop half · Chrome A creates a link, a separate Chrome profile joins and never sends its own
  confirmation tag (transport alive, app silent) · **PASS** — the creator sat on "Verifying…" with its
  signaling socket still open, then failed **≈120 s after its channel opened** (channel up ~12 s after
  the join; failure seen between the 126 s and 133 s polls: "Couldn't connect — peer did not complete
  key confirmation in time"), well before the 180 s token-room TTL, and closed its own socket. The silent side had already verified the creator's tag, showed "Secure channel open" and
  kept showing it after the creator gave up — the same "peer gone after connected" hole as F3 (BACKLOG).
- A2 · T1 desktop rehearsal · Chrome A shows the QR; a Chrome profile whose fake camera plays that QR
  (`--use-file-for-fake-video-capture`) scans it in the app · **PASS** — connected 6.2 s after tapping
  Scan, fragment scrubbed, creator "one-time secret verified". The real-camera and handset halves stay open.
- B3 · T1 desktop half · same run · **PASS**, and one plan claim corrected — the only host contacted was
  `hushsend.frelikh.dev`; the decoder came from `/assets/zxing_reader-B47v7G7e.wasm` (200,
  `application/wasm`). Chrome HAS a native `BarcodeDetector` and the app still fetched the WASM: the
  ponyfill never uses the native one, so CLAUDE.md § QR and this plan's AND-1 expectation were wrong
  (both corrected). iOS/Firefox scans remain.
- B9 · T1 · **PASS, closed** — the owner confirmed Brave's WebRTC IP-handling policy is **Default**;
  candidates gathered and A1 + A5 in both modes are in the morning entry. The Brave extension stopped
  answering this afternoon (two calls timed out) while the Mac was out of memory; not an app issue.
- A6a · T1 desktop half · **PASS** — every transfer in both 2026-09-27 sessions completed; every verdict
  on one host was `unknown`; nothing was refused or torn down over attestation.
- A1 · T1 rehearsal · Chrome A → iPhone 17 simulator (link opened via `simctl openurl`) · **PASS** — "Secure
  channel open", no SAS; host↔host UDP; Chrome's signaling socket closed 0.3 s after connect.
- A5 · T1 rehearsal · Chrome A → simulator 5 000 000 B · **PASS** — iOS "Received" + the download prompt;
  the saved file's SHA-256 matches (`89391b9f…`). The simulator → desktop direction was not run.
- Tooling, not app: safaridriver cannot open a session on the iOS 27 simulator ("Could not find any
  session hosts", and its Safari → Advanced has no Remote Automation switch), so the simulator is driven
  by taps and screenshots with the evidence taken on the desktop side of the pair.

### 2026-09-27 (evening) · iPhone + iPad simulators, Android emulator, B1/E4/E7 on desktop · Chrome 154 ↔ iPhone 17 sim (iOS 27.0) ↔ iPad (A16) sim (iPadOS 27.0) ↔ Pixel 9 Pro emulator (Android 17, Chrome 149)

Setup: production bundle `index-BBI2zUuS.js` (`efe8b29`, unchanged; checked over HTTPS and on the host);
`/health` ok, nginx / signaling / coturn `active`, 0 established signaling sockets. SSH worked at 18:20
and returned `No route to host` from 19:45, so there is no server-side evidence after that. Harness as in
the afternoon (`claude/tools/webdriver/` on the Mac) plus three engines in the Playwright driver:
`android` (Chrome in the emulator over CDP through `adb forward … localabstract:chrome_devtools_remote`),
`none` (plain `adb`), and `chrome-direct` (desktop Chrome with mDNS host-candidate obfuscation off, so
the emulator can reach it). One simulator or emulator at a time (8 GiB RAM); the owner closed Music and
Safari when the simulator's input lagged by seconds; the Wi-Fi was off for a moment at the start and the
reconnect attempt that ran into it is discarded. **Everything on a simulated device is a REHEARSAL**
(§ 0.5 — the Mac's RAM, CPU and network, no camera) and ticks no handset half; B1 and E4 are desktop
cases and are ticked.

**iPhone 17 simulator (iOS 27.0, Safari) ↔ Chrome A**, Max privacy, host↔host UDP:
- Link pairing (twice, once through the paste field) · PASS — "one-time secret verified", no SAS, Chrome's
  socket closed after connect.
- A5 · simulator → Chrome A · 5 000 000 B picked in Files · PASS — received into OPFS (dialog stubbed),
  every block verified, SHA-256 `89391b9f…` = expected, sender "Delivered". The afternoon ran only the
  other direction.
- A3 · Chrome A creates, the simulator enters the five words · PASS on the third try — "code words
  verified", no SAS, the touch listbox offered completions ("lever" → "levers"), only the rendezvous word
  reached the server. The first two tries expired while typing under memory pressure outlasted the words
  room's 180 s TTL: the creator got 4010 and "Room not found or code expired" + "New words" — the TTL
  doing its job.
- A4 · 3 rooms, Chrome A creates · PASS — exactly one reader each time; Chrome A read in rooms 1–2 and
  was the blind picker in room 3; the real phrase always among the picker's 3; all "SAS confirmed".
- D1 · the simulator's lobby row for Chrome reads "<readable id> joined HH:MM" — no device label is
  rendered any more (case text annotated, BACKLOG).
- E1/E2 · PASS — after a fresh link pairing each lists the other once; Chrome taps Reconnect, the
  simulator taps its row → connected 5.1 s after Chrome's tap, "verified via pinned key", no SAS; socket
  `room=<22 chars>&codeType=token&device=Desktop`, no `create=1`, closed after connect; then 1 000 000 B
  Chrome → simulator over that channel, saved in Files, SHA-256 `93a9b27b…` = expected. Before this, the
  simulator's keystore was found empty (a new identity, 0 pins) — likely a stray tap of mine on "Forget
  pinned devices", which acts without confirmation (BACKLOG); not verified.
- B4 (no camera) · PASS — "Scan a QR code" in the simulator: the viewfinder stays empty and the
  paste-the-link field is there; a pasted link joined. The real Deny/Allow camera prompt stays open.
- B5 · PASS — Share opens the iOS share sheet (Reminders / Safari / More; Copy / Add to Reading List /
  Open in Safari); the app's Copy link put the full 75-character link on the pasteboard (`simctl pbpaste`).
- B6/B8 · 402 pt, the app's light and dark themes (the toggle persists across reload) · PASS — "What your
  network can still see" is closed by default, opens on tap, and all four paragraphs fit with no clipping
  or horizontal scroll in both themes; the word slots are legible in both, the 4-digit hero checked in
  light. With the OS set to dark the app stays light — by design (`data-theme="light"` in `index.html`).
- F1 · 400 MB Chrome → simulator, screen LOCKED right after Accept · the transfer finished (sender
  "Delivered" after 28 s; 11 s unlocked), but **after unlock no download prompt was pending, no file was in
  Files, no error was shown** — the Blob hand-off was lost. Control run unlocked: prompt, saved, SHA-256
  `b7353bc3…` = expected. → BACKLOG. The real-phone F1 stays open.

**iPad (A16) simulator (iPadOS 27.0)** — B10 / the BACKLOG question · **the DESKTOP cap**: a 1 GiB + 1 B
offer was refused naming "the 1.0 GB this browser can save", a 512 MiB + 1 B offer was offered (Accept
shown, declined), and the iPad's coarse label in `peer-joined` was `Desktop`. A link opened into the
iPad's existing hushsend tab did nothing (the hash-only bug, BACKLOG).

**Pixel 9 Pro emulator (Android 17 user build, Chrome 149.0.7827.5, UA `Linux; Android 10; K … Mobile`)**,
behind QEMU's SLIRP NAT (guest 10.0.2.15):
- A1 · Max privacy · the creator failed visibly with "Couldn't connect directly — Switch to Reliable"
  (expected here: the guest cannot resolve the Mac's mDNS host candidates); the Android joiner showed
  "Room not found or code expired … signaling closed (code 1006)" — the wrong copy (BACKLOG).
- A1 · Reliable · PASS — connected (19 s on the slow guest), no SAS, fragment scrubbed, both sockets closed
  after connect; `getStats()` on both sides selected `relay udp 94.46.199.61` ↔ `relay udp 94.46.199.61`
  while both pages' path verdict was `ok` ("direct path confirmed") — **the BACKLOG suspicion, confirmed**.
  Android's `peer-joined` label: `Mobile`.
- A3 · Reliable · PASS — the Android page (touch mode) entered the five words; connected 13.3 s after
  Connect, "code words verified", no SAS, `room=<word>&codeType=word`, sockets closed after connect.
- A4 · Reliable · 3 rooms · PASS — creator picker / reader / picker, exactly one reader each time, the real
  phrase always among the picker's 3, all "SAS confirmed".
- A5 · Chrome A → Android · PASS, with a finding — **Chrome 149 on Android has `showSaveFilePicker`**:
  Accept opens Android's own save UI (DocumentsUI → Downloads → SAVE) inside the gesture, i.e. the FSA
  path, not the Blob path § 0.4 expected (corrected). With SAVE pressed within ~12 s: 5 000 000 B saved,
  SHA-256 `89391b9f…` = expected. Every run where the dialog stayed up 40 s or more lost the connection
  (BACKLOG, with the numbers). Cancelling the dialog ends the receiver cleanly ("Transfer ended ·
  cancelled").
- A5 · Android → Chrome A · 5 000 000 B, twice · PASS — monotonic, every block verified, 0.4 MB/s through
  the relay.
- B5 · PASS — Share opens Android's system share sheet ("Sharing link", the link, copy, Send to devices,
  QR Code); BACK closes it.
- B10 caps · PASS — by default (FSA present) 512 MiB + 1 B and 5 GiB are both OFFERED (uncapped). With
  `showSaveFilePicker` removed in-page (the Blob path) both are refused before accept, naming 512 MB — the
  UA selects the mobile cap. 64 MiB on that Blob path over the relay: delivered, every block verified
  in-page; the app triggered the download (Playwright saw the event for the blob URL), but Chrome under
  CDP automation canceled it, so its landing in Downloads is NOT verified.
- B10 512 MiB · **not completed** — on the FSA path (SAVE after 11 s; a 200 ms heartbeat in the page never
  paused more than 1.1 s) over a direct path (Chrome with mDNS obfuscation off, the emulator throttled to
  16 Mbit/s) it reached 49 MB at ~0.5 MB/s, then the connection failed. Transfers INTO the emulator beyond
  a few MB died this way — unthrottled after ~1.3–1.8 MB, on the direct SLIRP path and on the relay alike;
  throttled, a 64 MiB relay run survived at 0.4 MB/s (~25 min for 512 MiB). An emulator networking limit:
  the phone-sized receive stays open for a real phone. Every stall left both screens on "transferring"
  (BACKLOG, peer-gone).
- F2 · real airplane mode for 20 s, 9.6 s into a 30 MB Android → Chrome send · **FAIL** — both peer
  connections `disconnected` ~10 s into the cut and `failed` 10 s later; after the network returned: no
  recovery and no visible failure — both sides on "transferring" (3 407 872 / 4 194 304 B) for 150 s+.
  Same root as F3 (BACKLOG).
- F8 · real airplane mode the moment the Android joiner's socket had its `welcome` · PASS by the transport
  path — the creator failed **22 s** after the cut with "Couldn't connect — channel closed during pairing"
  (ICE failed first, so the 120 s confirm deadline was not needed); the joiner, back online, showed the
  1006 "Room not found" copy again.

**Desktop:**
- B1 · T2 · Chrome B → Chrome A (MBP-A), 2 GiB, Max privacy · **PASS** — Accept (a real click) opened
  Chrome's native save dialog inside the gesture; the owner clicked Save; ~51 MB/s (24 % → 100 % in 32 s);
  the saved file is 2 147 483 648 B with SHA-256 `0df1e700…` = expected. Receiver RAM flat: Chrome A's
  process tree 270–407 MiB, largest process ≤ 214 MiB (sampled every 5 s). The dialog defaulted to
  `~/Documents`, not Downloads. The test file went to the Trash afterwards.
- E4 · T1 · Chrome B on Reconnect for Chrome A, which never taps it · **PASS** — the rendezvous re-taken
  at 120 s (same token), a NEW token at 123.8 s (the 20:50:00 bucket boundary), again at 243.8 / 363.8 /
  483.9 s; "The other device did not show up" + the pair-afresh copy at exactly 600.0 s. Meanwhile Chrome A
  did a plain room join (4711 → 4009 "room not found", readable copy) and sat 60 s in a lobby of its own,
  which stayed empty: nothing met, no hang.
- E7 · T1 rehearsal — a separate profile's PAGE clock shifted by an init script (`skew-init.js`), not a
  device clock · **+4 min · PASS** — both tapped Reconnect at 20:56:44, 6.5 min into the unskewed side's
  bucket, when the skewed side was already in the next one; they met at 21:00:00–21:00:03, the unskewed
  side's boundary, "verified via pinned key" — the stated "at worst after a delay of up to the skew"
  (3 min 16 s here). **+15 min** · they never met: the skewed side took the next bucket's token at 262.5 s (its own
  21:20 boundary = real 21:05), the unskewed side at 560.8 s (real 21:10), so the two never held the same
  token, and BOTH ended "The other device did not show up" at 600.1 s. A skew larger than one bucket is
  not absorbed by the wait — the stated limit, now measured. The real-device clock half stays open.
- B10 desktop Blob cap on **Brave 154** (the retry — its extension had timed out in the afternoon), Chrome B → Brave,
  Max privacy, host↔host · **PASS** — Brave has no `showSaveFilePicker`; 1 GiB + 1 B and 5 GiB were refused
  BEFORE accept in 0.5 / 0.7 s naming "the 1.0 GB this browser can save"; exactly 1 GiB was delivered in
  ~21 s (~51 MB/s), "Received", and the file in `~/Downloads` is 1 073 741 824 B with SHA-256 `edef0d81…`
  = expected (created 21:12:38, right after the transfer). It was NOT visible in Downloads at 21:13–21:14
  and was at 21:16, after the owner was asked to look at Brave — most likely held by Brave's download UI
  until confirmed (not observed by me). This completes the Blob row of the ladder for every desktop
  engine named in it. Test file moved to the Trash.

Tooling notes (not app): the iPhone simulator's input lagged by seconds under memory pressure, and on a
freshly booted iPad simulator wallpaper/Siri indexing pinned the CPU for minutes (`kernel_task` 188 %).
The emulator's first Chrome launch after boot was killed by Play Services ("forcing restart due to module
googlecertificates"). Chrome's first-run was skipped with `am set-debug-app --persistent
com.android.chrome` + `/data/local/tmp/chrome-command-line` (both reverted afterwards). Playwright calls
into the Android page hung for the full 170 s while DocumentsUI was in front, so native UI is driven with
`adb shell input tap` (web content appears in `uiautomator dump` with its bounds).

### 2026-09-27 (late evening) · the connection-lost fix, deployed · F3 on the live build · Chrome 154 ↔ Chrome 154

Setup: production bundle `index-DJlj4l6z.js` (`153addd`; its code is `defe379`'s), deployed by the owner
at 19:58 UTC. `/var/www/hushsend/dist` is byte-identical to a local build of `153addd` (41 files, equal
sha256 manifests), `stun.l.google` is absent, `/health` ok, nginx / signaling / coturn `active`, the
signaling server unchanged at `2b5b913`. Real Google Chrome 154 driven by Playwright (`channel:
'chrome'`), two SEPARATE browser contexts on the Mac with mDNS host-candidate obfuscation off
(same-machine pairing); the receiver's `showSaveFilePicker` deleted so it takes the Blob path (headless
Chrome cannot show the native picker). Link pairing, Max privacy, a 512 MB sparse file.
- F3 · the receiver's tab closed with 1 MiB received · **PASS** — the sender ended on "Connection lost"
  25 ms after the close: "not delivered · stopped at 3.5 MB", signal "data channel closed" (the
  receiver's `pagehide` goodbye). Before the fix the same shape left the sender on "Sending 46 %" for
  over a minute.
- Its mirror (not a plan case) · the SENDER's tab closed with 1 MiB received · the receiver ended
  "Connection lost · not received · stopped at 1.3 MB" after 16.2 s, signal "ICE failed" — the
  Chromium-only delay CLAUDE.md § Known residuals records; no frozen screen in between.
- The sender counted 3.5 MB while the receiver had 1 MiB: "sent" is what went into the send buffer —
  which is why a "Delivered" that waits for the receiver's confirmation is in the works (BACKLOG).

### 2026-09-28 · the owner's decisions, deployed · A4b and B1 on the live build, Chrome incognito · Chrome 154 ↔ Chrome 154

Setup: production bundle `index-9nSghGio.js` (`90fdc15`; its app code is `673509d`'s), deployed by the
owner at 04:32 UTC. `/var/www/hushsend/dist` is byte-identical to a clean local build of `90fdc15` (41
files, equal sha256 manifests; the public URL serves the same entry), `stun.l.google` is absent; the
signaling server's running copy is at `3d96125`, relaunched 04:32:44 UTC, `/health` ok, TURN configured.
Real Google Chrome 154 driven by Playwright (`channel: 'chrome'`): two persistent profiles (chromeA,
chromeB) for A4b and B1; for the incognito rows, off-the-record contexts of one Chrome — the storage
model of an incognito window. Memory = RSS of each profile's whole Chrome process tree, every 2 s.
- A4b · T1 · chromeA creates a 4-digit room, chromeB joins (room 8249; the creator picked, the joiner
  read) · **PASS** — the reader confirmed first and got "Verifying…" with "Stop — they don't have this
  phrase" while the picker was still choosing; Stop ended BOTH sides in the hard stop ("This channel may
  be compromised"; reasons "SAS rejected — words did not match" / "peer reported a SAS mismatch"), no
  transfer UI on either. Copy nit: that screen tells a picker who never confirmed anything "The phrase
  you confirmed doesn't match your peer's".
- B1 · T1 · chromeA → chromeB, 2 GiB, the browser left as is · **PASS** — no save dialog asked for
  (`showSaveFilePicker` wrapped: 0 calls); 39.4 s, 54.5 MB/s, progress monotonic, the sender
  "Delivered"; the site-storage copy verified block by block in-page, and Chrome's own download of it
  saved a 2 147 483 648-byte file with the expected SHA-256 (`0df1e700…`); the receiver's tree stayed at
  414–643 MiB (largest process ≤ 222 MiB) through the whole 2 GiB. Past the quota (reported 10 240 MiB;
  an 11 GiB offer): Accept asked for the save dialog inside the gesture (`navigator.userActivation.isActive`
  true at the call). The dialog was answered "Cancel" in-page, so the native window itself was not on
  screen in this run (it was on 2026-09-27, clicked by the owner); the receiver ended "cancelled", the
  sender "declined · recipient cancelled". The hold after hand-off (`OPFS_HOLD_MS`, 10 min): 7 min in,
  the site-storage folder still held exactly the delivered 2 GiB file (usage 2 048 MiB); at 05:05:44,
  ~10 min after the hand-off, it was empty and usage 0 — the timer removes it on the live build.
- B2's private-window rung, on the desktop (not the tick — B2 is a phone case) · Chrome incognito ·
  **FAIL** — the receiver reports quota 10 240 MiB, usage 0, but site storage holds only ~430 MiB there
  (a bare write stopped at 426 MiB with `QuotaExceededError`). hushsend plans by the reported quota, so
  a 600 MiB file was ACCEPTED on the disk path and died at 445 MB (74 %): receiver "transfer error · The
  operation failed because it would cause the application to exceed its storage quota.", sender
  "cancelled · stopped at 448 MB". The incognito browser's tree grew from ~765 to ~1 124 MiB during it
  and fell back once the partial file was removed — that storage looks RAM-backed. A normal profile, for
  comparison: 1 GiB written in 0.9 s, tree +10 MiB. → BACKLOG § UX bugs.

### 2026-09-28 (later) · the no-copy rule's engineering · a probe page and the LOCAL build · Chrome 154 ↔ Firefox 156 ↔ Safari 26.6 (the Mac)

Not ticks — measurements that decided the design (CLAUDE.md § File transfer), on real engines.
- **Memory, one yardstick** (RSS of every process of the receiving browser, 1 GiB received from Chrome
  on the live build): the table given to the owner earlier mixed yardsticks (Chrome's whole browser vs
  Firefox's main process vs Safari's largest process). Measured the same way: a blank tab already costs
  Chrome ~790 MiB (browser 195, GPU 117, network 85, storage 61, renderers 330) and Firefox ~1.7 GiB
  (six pre-launched content processes); the hushsend tab's own process is Chrome ~152 MiB idle / 175
  connected / 215–242 receiving, Firefox ~198 / 226 / ~347 — its JS heap 4 MiB idle, 10 MiB connected
  (Chrome's `performance.memory`). Safari's numbers swing with macOS compression on this 8 GiB Mac.
  None grows with the file.
- **Straight into Downloads through a service worker** (probe: `/dl/sw.js`, a transferred stream, 1 GiB
  of structured blocks): Chrome — 1 GiB in 1.2 s, the saved file's SHA-256 right, memory back at once;
  Firefox — the same (1.65 s, SHA-256 right); Safari — `DataCloneError` for a transferred stream, and
  fed chunk by chunk it created the download and wrote **0 bytes**. Failure modes: an aborted stream
  ends the download "canceled" on Chrome (bundled Chromium and Chrome 154), and so does a worker killed
  mid-download (CDP `ServiceWorker.stopAllWorkers`); on **Firefox** an aborted stream leaves the
  download in progress for good (a `.part` of 6–8 MiB plus an empty file under the real name, also with
  the worker erroring its own stream), and once the worker was unregistered Firefox **completed a 7 MiB
  file declared as 64 MiB** under the real name. A stream closed short completes on both engines (the
  app never closes short — it errors). Chrome kept a 420 s stream alive with a ping every 10 s and the
  file arrived intact (past the 5-minute event limit). → the stream path is desktop Chromium only.
- **Reservation** (`truncate(size)` on a fresh writable): 5 GiB in 1–2 ms on Chrome, Firefox and Safari,
  counted in the quota at once, writes then start at 0; incognito Chrome refuses 1 GiB in 2 ms
  (`QuotaExceededError`) and takes 300 MiB; Safari's `estimate()` still counts a removed file for a
  while. Firefox private: no site storage at all (`getDirectory()` → `SecurityError`).
- **The local build in real Chrome** (two persistent profiles, vite + the dev signaling server on the
  Mac): 2 GiB received through the download worker at 50.6 MB/s, the sender "Delivered", nothing in
  site storage, no hand-off, the saved file's SHA-256 right (`0df1e700…`), the receiver's tree 804–985
  MiB throughout. **Flow control:** the 5 GiB download PAUSED in `chrome://downloads` 3 s after Accept —
  for the 15 s it stayed paused the sender did not move a byte (174 063 616) and sat 15.3 MiB ahead of
  the receiver (the 16 MiB window), the receiver's tree flat at 935–947 MiB; after Resume both ended
  "done" and the 5 GiB file's SHA-256 was right (`7a9e331b…`).
- Suites on this code: unit 313/313, integration 26 + 2 skipped (turn-relay: no coturn on the Mac, as
  before), e2e 143 passed / 14 skipped / 2 failed (the two WebKit path-attestation cases, as before),
  axe 112/112.

### 2026-09-28 (after `c5a51c4` went live) · the stream path and the ladders on the live build · Chrome 154 ↔ Firefox 156 ↔ Safari 26.6 (the Mac)

Setup: `c5a51c4` live since 06:32 UTC (§ 0.1). Real browsers on the Mac: Chrome through Playwright
(persistent profiles chromeA → chromeB; incognito = an off-the-record context), Firefox and Safari
through WebDriver (Firefox private = `browser.privatebrowsing.autostart`); chromeA sends every file
(1 MiB structured blocks, every byte checked by the saved file's SHA-256). Memory = RSS of the
receiving browser's whole process tree every 2 s. The Mac was under heavy memory pressure (swap
3.5 of 5 GB), so absolute numbers run high; what matters is that none grows with the file.
- B1 · T1 · Chrome · **PASS** (ticked) — the download worker is registered only when the file is offered
  (none before) and the stream frame appears at Accept; 2 GiB arrived in 49 s, 0 save dialogs, 0
  hand-offs, nothing in site storage, the saved file intact, the sender "Delivered", the receiver's
  tree 441–819 MiB. Cancelled in `chrome://downloads` 3 s in: receiver "error · the browser stopped the
  download (cancelled, or the disk is full)", sender "cancelled · stopped at 137 MB", no file kept.
  Paused there 3 s in: the sender did not move a byte for 15 s and sat 15.3 MiB (the window) ahead of the
  receiver, tree flat (538–872 MiB); resumed, both "done", the file intact. 75 s after the last
  download the worker was gone again.
- B2's private rung · Chrome incognito · PASS — 1 GiB through the stream path (the worker at the offer,
  the frame at Accept), nothing in site storage, the file intact (the quota it reports is still the
  fake 10 GiB — no longer read on this path). The morning's FAIL is fixed.
- B2's desktop half · Firefox · PASS — 1 GiB through site storage (no worker: Firefox never streams),
  46 MB/s, the copy held in site storage, the saved file intact. Firefox private · PASS — no site
  storage (`getDirectory()` → SecurityError); 250 MiB refused in ~1 s, before accept ("This file is 250
  MB — larger than the 200 MB this browser can take right now…"), 200 MiB + 1 B refused in bytes
  ("209715201 bytes — larger than the 209715200 bytes"), exactly 200 MiB received through RAM, intact.
- B2's desktop half · Safari · PASS for 1 GiB — site storage (quota 78 643 MiB, no worker), 32.5 MB/s;
  the WebDriver window counts as hidden, so the app held the file and showed "It arrived while this
  page was in the background. Tap to save it."; the tap handed it over, the site-storage copy verified
  and the file Safari saved to ~/Downloads intact.
- B10 · stream rungs · Chrome · **PASS** — 1, 2, 3 GiB, 4 GiB + 1 B, 5 GiB: 46.6 / 50.2 / 51.4 / 45.0 /
  49.5 MB/s, progress monotonic, 0 hand-offs, nothing in site storage, every saved file intact; the
  receiver's tree 322–725 MiB over the whole ladder (largest process ≤ 341 MiB).
- B10 · site-storage rungs · Firefox · **PASS** — 1, 2, 3 GiB, 4 GiB + 1 B, 5 GiB: 54.4 / 60.0 / 61.7 /
  52.8 / 58.8 MB/s, each held for "Save file" (background window), tapped, every saved file intact;
  tree 123–631 MiB. 11 GiB (past the 10 GiB quota): refused before accept in 3 s — "larger than the 9.9
  GB this browser can take right now". **Found:** a second big file right after the first — 6 GiB
  received, then 5 GiB offered 4 s later — was refused "larger than the 3.9 GB … Free up disk space"
  with 267 GB free: the first file's held copy fills the quota for up to 10 minutes (BACKLOG § UX bugs).
- B10 · site-storage rungs · Safari · first run stopped at 2 GiB — the transfer reached site storage,
  "Save file" was tapped, and then Safari asked whether to allow the download (confirmed by the owner,
  who saw it); that prompt blocks WebDriver. Not a product failure (no crash report, nothing in
  WebKit's log). **Re-run the same evening with downloads allowed for the site: PASS** — 2, 3, 4 GiB +
  1 B, 5 GiB at 43.7 / 43.9 / 40.9 / 42.9 MB/s, no worker, the site-storage copy verified block by block
  each time, and every file Safari saved to ~/Downloads has the expected SHA-256.
- Harness, not product: Chrome 154 crashed (browser process, SIGSEGV) on the first download in a
  Playwright profile relaunched after an intercepted download — a plain 5-byte blob download crashed
  it too, and with the profile's `History` moved aside it did not. Recorded for the harness.
- F4 · attempted with the deploy host as the second machine (headless Chromium 149 on Linux, the live
  site reached through its own nginx, the Mac's Chrome with real host IPs) · **not a result** — the two
  never finished pairing, in Max privacy nor in Reliable ("Agreeing on keys…" on both, no page error):
  the host firewalls every inbound port but 80/443/22/3478 and the relay range, and from inside the LAN
  it cannot reach its own public address (where its TURN listens). An environment limit, not a product
  one; F4 still needs a second real machine (or the phone).

### 2026-09-28 (evening) · the owner's eviction rule on the live build · Chrome 154 → Firefox 156 (the Mac)

Setup: `1f2abab` live since ~18:00 UTC (its app code `254c31b`'s: a delivered copy held ≥ 2 min gives
way to the next big file; before that the refusal says so) — § 0.1. chromeA sends to Firefox (site
storage, 10 GiB quota), each file checked by the saved file's SHA-256.
- 6 GiB received at 54.4 MB/s, handed over at once, intact; site storage then holds its copy (6 145 MiB).
- 5 GiB offered 21 s after that hand-off · refused before accept, in the new words: "This file is 5.0
  GB, and this browser's storage is still holding the last file it received while its download
  finishes. Try again in a couple of minutes, or receive it in another browser."
- 5 GiB offered again 125 s after the first hand-off · **accepted** — the 6 GiB copy gave way — received
  at 60.6 MB/s, intact; site storage then holds only the new copy (5 121 MiB). The BACKLOG item "a second
  big file right after the first" is closed on the live build.

### 2026-10-02 · the FIRST real handset · Chrome 154 (the Mac, Playwright) ↔ **Pixel 5** (Android 14, Chrome 152) over USB — Phase A on the LAN, Phase C over a VPN Wi-Fi

Setup: live `8c9ea59` (§ 0.1 unchanged). The phone is the owner's Pixel 5 (`redfin`, Android 14, security
patch 2023-11-05 — no updates any more, Chrome 152.0.7977.82, 1080×2340 @ 440 dpi, no SIM), attached over
USB and driven over CDP exactly like the emulator (`adb forward … chrome_devtools_remote`; the
`android-device` skill). Desktop side: the installed Chrome 154 through Playwright (`chromeA`). Two
networks: **home LAN** (Mac 192.168.1.35, phone 192.168.1.34, same /24; the phone drops ICMP) and, from
F8 on, the phone on a **second Wi-Fi that exits through a VPN in France** ("enlight me", srflx seen as
81.53.x.x) — the stand-in for "LTE" (no SIM in the phone). Every number below says which.

**Phase A on the LAN (default Max privacy on both — see the trap at the end).**
- **A1 · T2 · Mac Chrome → Pixel Chrome · PASS** — ×3. Connected in 0.9 / 1.0 / 1.0 s (joiner, from
  opening the link), fragment scrubbed (`location.href` = the bare origin), no SAS screen, selected pair
  `host ↔ host` on the LAN (the Mac's host candidate is mDNS-obfuscated, so the phone sees it as `prflx`
  with no address). Both signaling sockets close ≤ 1.4 s after `connected` (A6 on the phone).
- **A3 · T2 · Mac creates words, Pixel types them · PASS** — the five words typed into the five fields in
  touch mode (listbox), `connected` 2.4 s after Connect, "code words verified", `host ↔ host`.
- **A4 · T2 · Mac creates a room, Pixel joins, Mac picks the Pixel row · PASS** — 8 fresh rooms: exactly
  one reader + one picker every time, the real phrase among the picker's three every time, both sides
  "verified — SAS confirmed". The reader landed on the creator 5 times and on the phone 3 times — the
  split is not fixed to the creator, as designed. (Stand note: the phone's lobby roster read back empty
  in 4 of 8 rooms — the harness read it after the pick had already left the lobby screen; not a product
  finding.)
- **A5 · T2 · both ways · PASS** — 5 MB Mac → Pixel in 2.3 s: the phone took the **site-storage path**
  (no dialog, `usageDetails.fileSystem` 5 000 368 after, an `incoming` directory present), every block
  verified, "Received" + **New transfer** on the finished row. 5 MB Pixel → Mac in 2.2 s: desktop Chrome
  streamed it straight into Downloads (nothing in its site storage), the saved file's SHA-256 right.
- **A6a** — the phone read "direct path not confirmed" (`unknown`: its selected remote is the Mac's
  mDNS-hidden `prflx`) while the Mac read "direct path confirmed"; the transfers above ran regardless.
  Advisory, as it must be. Verdict table row: Chrome-desktop ↔ Chrome-Android on one LAN = `ok` / `unknown`.
- **E1 (phone half)** — after all of the above the phone's Reconnect section lists the Mac **once**
  (`device e7:f2:4e:82`), and the Mac lists the phone once (`device 41:d2:23:80`).
- **B5 · T2 · Pixel · PASS** — the Share screen has Share AND Copy; a real `adb` tap on Share opened the
  system share sheet (`com.android.intentresolver … ChooserActivityLauncher`, screenshot
  `and_share.png`: the link in the sheet's preview); Back returned to Chrome.
- **B8 · T2 · Pixel · PASS** — "What your network can still see" present, **closed** by default, opens on
  tap (777 characters), nothing clipped (the only element with `scrollWidth > clientWidth` is an
  `sr-only` span, by design), no horizontal scroll at 392 CSS px.
- **B6 (Android half) · PASS** — light and dark (the kit toggle flips `data-theme`, stored), the home,
  method picker and the open disclosure at 392 × 721 CSS px: no clipping, no horizontal scroll, all 14
  controls on the home ≥ 44 px (screenshots `b6_*.png`). RU is not checked: English only by decision.
- **F8** — NOT drivable on the LAN: from `welcome` to `connected` the link path takes ~1.5 s and
  `svc wifi disable` lands later than that, so the cut hit an open channel (and gave an F2 datum: an
  ~8 s cut without a transfer in flight → "Connection interrupted" on the Mac after ~6 s, then ICE came
  back by itself and both sides were `connected` again ~16 s after the cut). The emulator's SLIRP
  slowness is what made F8 drivable there; on a real LAN it needs a different cut (owner's airplane
  mode is on already — the phone has no SIM — so that switch is not available either).
- **F2 · T2 · Pixel → Mac, 600 MB over the relay, Wi-Fi off at 9 s for 20 s · PASS (visible failure)** —
  both PeerConnections `disconnected` 7–9 s after the cut, `failed` 10 s after that; both screens
  "Connection lost" 19 s after the cut, i.e. before the Wi-Fi came back; no frozen bar. (By then the
  phone had silently rejoined a DIFFERENT Wi-Fi — see the trap.)

**Phase C — the phone on the VPN Wi-Fi (France), the Mac on the home LAN.**
- **C1 · T2 · Max ↔ Max, link · PASS, outcome (b)** — ×2: terminal `failed` with "Couldn't connect
  directly — Switch to Reliable" on BOTH sides (the Mac's also carries the macOS Local Network hint),
  phone 18 s, Mac 18–48 s. No hang.
- **C2 · T2 · Reliable ↔ Reliable, link · PASS** — connected in 5.2 s, selected pair **`relay ↔ relay`**
  (our coturn, 94.46.199.61) on both sides, both rows read "relayed through the server", sockets closed
  after connect. **50 MB Mac → Pixel over the relay: 165 s = 0.3 MB/s**, intact. That is well under the
  relay's 5 Mbit/s cap (~0.6 MB/s) and the 1.86 MB/s measured on 2026-09-19; the VPN leg is the likely
  bottleneck. A 600 MB send the other way ran at the same 0.3 MB/s (F2 above).
- **C3 · T2 · mixed privacy, both directions, link AND room · PASS (no deadlock)** — four runs, every one
  terminal in 16–19 s, never a stuck "agreeing on keys". The Max side's copy depends on a RACE: when its
  own ICE failed first (phone-Max on link; both room runs) it read "Couldn't connect directly — Switch to
  Reliable"; when the Reliable peer's ICE gave up ~2 s earlier (Mac-Max as link creator, twice) the
  `peer-left` arrived first and the Max side read **"peer left during pairing"** — fail-closed, but
  without the hint the case promises. BACKLOG § UX bugs.
- **C4 · T2 · PASS** — in all four C3 runs the Max side sent **no `turn-request`** (full frame log; the
  Reliable side sent exactly one) and nothing connected, so no relayed pair could exist: "failed ⇒ the
  fix works". Control: the Phase A runs where the phone was unknowingly on Reliable (the trap) and the
  Mac on Max connected `host ↔ host` on the LAN — the gate passes a legitimate direct path.
- **F9 · T2 · words + room/SAS over the VPN relay (Reliable both) · PASS** — words `connected` 5.5 s
  after Connect; room/SAS ×2 connected, both verified. Nowhere near the 120 s deadlines.
- **E6 · T2 · reconnect ×5 over the VPN relay (Reliable both) · PASS** — 5/5 "reconnect — verified via
  pinned key" in 5.4–6.7 s from the first tap, no SAS screen, `relay ↔ relay`, socket
  `room=<22>&codeType=token`, no `create=1`, closed after connect.
- **E7 · T2 · phone clock +4 min (`cmd alarm set-time`, auto time off) · PASS** — met in 4.1 s.
  **+15 min:** see the line below this entry (ran in the background).

- **E7 +15 min · PASS — the stated limit, observed in full (second run, later that evening, phone on the
  LAN over wireless adb).** Phone clock +15 min, both tapped Reconnect within a second: neither side ever
  met the other; each re-took the rendezvous on its own schedule (6 sockets each over the wait — the
  2-min refresh plus each side's own bucket boundary, the phone's 15 min ahead of the Mac's), and **both
  ended at 603 s with "The other device did not show up"** — the Mac and the phone within the same 10 s
  poll. No hang, no SAS, no handshake mismatch. (A first attempt earlier in the evening observed only
  200 s — the driver's 170 s command limit — and then the owner switched the phone's Wi-Fi mid-wait: its
  socket died with **1006 and the phone ended at once with "Couldn't connect — reconnect: signaling
  connection failed"** instead of re-taking — BACKLOG § UX bugs.)

**Back on the LAN (phone on ROSTELECOM again, both Max).**
- **B2 (phone half) · T2 · Mac → Pixel 1 GiB · PASS** — **site storage, no dialog**: 197 s = 5.5 MB/s
  on this LAN, every block verified, `usageDetails.fileSystem` = 1 073 742 192 after, "Received" + New
  transfer; Chrome's total PSS on the phone sampled every 5 s: **245–257 MB** for the whole receive (40
  samples) — flat. (This is also the OPFS ladder's 1 GiB rung on a handset — B10.) The RAM-fallback rung
  (a private window over 200 MiB) was NOT run: an incognito tab cannot be driven through this CDP socket.
- **C6 (LAN stand-in, Max privacy) · PASS on the arithmetic** — 300 KiB went over the DataChannel as
  **524 371 bytes** (the 512 KiB bucket, +70.7 %), 50 MB as **50 331 735** (the 48 MiB bucket, +0.7 %);
  both received intact at their REAL sizes ("300 KB" / "48 MB" rows). 1.4 s and 8.6 s on the LAN. The
  cellular COST stays unmeasured: no SIM.
- **F1 (Android half) · T2 · 200 MB Mac → Pixel, screen locked by `keyevent 26` ~6 s after Accept, left
  locked ~40 s · PASS with a surprise** — the transfer **kept going while locked**, slower (done at 66 s
  against 36 s with the screen on), and completed. **`document.visibilityState` stayed `visible`
  throughout** — Android Chrome did not report the lock to the page — so the finished row did NOT show
  "Save file": the download was started at once (`download click` in the log). Whether a download
  started under a locked screen lands cannot be checked under CDP (Playwright cancels downloads in a
  browser it is attached to — nothing in `/sdcard/Download`); needs one run by hand, Chrome detached.
  **Done by hand, Chrome NOT attached (00:05, after the ladder) — F1 Android half · PASS, and the
  `visible` above was a CDP artefact.** Chrome force-stopped and the link opened by `am start`; the owner
  tapped Accept; `keyevent 26` locked the screen 6 s later; the owner left it locked ~40 s. The sender
  reached "Delivered" 43 s after the lock (the transfer ran on under the locked screen, 200 MB in ~49 s).
  On the phone, nothing in Downloads yet — instead the finished row "Received … 191 MB ✓" with **"It
  arrived while this page was in the background. Tap to save it." and the Save file pill** (screenshot
  `f1_after.png`): the page DID go hidden for real, and the hold worked as designed (2026-09-28). One
  tap on Save file (a real `input tap`): `/sdcard/Download/hs-f1-manual-200000000.bin`, 200 000 000
  bytes, **SHA-256 equal to the generator's**. So on Android Chrome: a receive survives the screen lock,
  the download is held rather than lost, and a single tap lands it intact.
- **F8 · T2 · the phone on the VPN Wi-Fi, Reliable both, Wi-Fi cut 1.8 s after `welcome` · PASS (25 s).**
  Over the relay the join takes ~5 s, so the cut landed while the phone was still "Joining…" (no
  PeerConnection yet — it was waiting for its TURN credentials). The Mac sat in "Agreeing on keys…" with
  its PeerConnection `new` and ended at **25.3 s** with "Couldn't connect — peer left during pairing":
  the SERVER noticed the dead socket and broadcast `peer-left` long before the 120 s client deadline
  would have. No endless wait. (The phone, Wi-Fi back 8 s later: "Lost the connection to the server —
  Check your internet connection and start again", plus the relay-unavailable line because its
  `turn-credentials` never arrived — honest, if a little misleading about WHY there was no relay.) On
  the LAN this case is not reachable: the join completes in ~1.5 s, faster than `svc wifi disable`.
- **B10 · past the quota on the phone · PASS** — a 16 GiB offer (the phone's site quota read 10–15 GB
  across the evening) was accepted on the Pixel 5 through a trusted click: planReceive skipped site
  storage and **the system save dialog came to the front** (`com.google.android.documentsui …
  PickActivity`, screenshot `quota_dialog.png`) — the File System Access path, as the table predicts for
  Chrome/Android. Back out of the dialog: receiver "Transfer ended · cancelled", sender "declined —
  recipient cancelled", nothing transferred, the channel still open.
- **B10 · the "RAM rung" in an incognito tab on the phone · NOT APPLICABLE on Android Chrome.** An
  incognito tab (opened from Chrome's menu; reachable over the same DevTools socket — Android hands every
  tab, incognito included, to one BrowserContext, so the harness picks it by URL) reported site storage
  **usable** (the one-byte OPFS probe wrote and closed), `estimate()` 10 GB, `showSaveFilePicker` present.
  A 250 MiB offer over the relay was accepted with **no dialog and went to site storage** ("Receiving …
  1 %"), so the RAM path is never reached there: unlike desktop Chrome incognito (430 MiB of real room
  behind a 10 GiB estimate) and Firefox private (no OPFS at all), Android Chrome incognito simply has
  working site storage. The 200 MiB cap stays covered by the e2e and by Firefox private on the desktop.

**The three fixes (`190151b`, deployed 2026-10-03 ~00:55 UTC, byte-identical to a clean build), checked
on the live build after clearing every browser's cache:**
- **Finishing line** — chromeA → chromeB on the Mac, Max, 1 GiB + 1 B (bucket 1.125 GiB → 128 MiB of
  filler): at 23.9 s both panels switched to "Finishing", the sender's status line "Hiding the file's
  size — a little extra data goes out after the file.", the receiver's "The sender is hiding the file's
  size — a little extra data arrives after the file.", 2.4 s later Delivered / Received.
- **Max hint under the peer-left race** — the C3 run that used to lose it (Mac Max creator ↔ Pixel 5
  Reliable on the VPN Wi-Fi, link): the phone's ICE failed at 17.7 s, its `peer-left` reached the Mac at
  19.6 s while the Mac's PeerConnection was still `connecting`, and the Mac now reads **"Couldn't connect
  directly — Switch to Reliable…"** (18.7 s). Fail-closed as before; the copy is now the useful one.
- **Reconnect wait across a network drop** — Pixel 5 alone on the wait screen, Wi-Fi off 12 s: the socket
  died with 1006, the wait **stayed up** and re-took the rendezvous every 3 s while offline (each
  attempt closing 1006 at once), and the first socket after the network returned opened — the fix
  works. Then a new finding: that socket found a peer in the token room — **the phone's own previous
  socket, which the server had not yet declared dead** (it needs ~25 s, cf. F8) — pairing began
  against the ghost, nothing answered, and the server's eventual `peer-left` ended the wait as
  "reconnect aborted — peer left during re-auth". BACKLOG § UX bugs (the ghost at the rendezvous).
- **The ghost fix (`981f8df`, deployed ~01:35 UTC, byte-identical to a clean build) — the same scenario
  on the live build:** Wi-Fi off 12 s → sockets re-taken every 3 s while offline → the first socket after
  the network returned met the ghost ("Agreeing on keys…", ~3 s) → **back to "Waiting for the other
  device" on a fresh socket** and still waiting when the 120 s observation ended. The wait survives both
  the drop and the ghost; the cap is the original one (`waitUntil`).
- **B10 (phone, site-storage ladder) · T2 · Mac → Pixel 5 over USB, Max, one pair:** **2 GiB PASS** (510 s
  = 4.2 MB/s, every block verified, Chrome PSS 223–264 MB over 99 samples, site storage then 2048 MB of a
  12.3 GB quota), **3 GiB PASS** (1062 s = 3.0 MB/s, verified, PSS 211–229 MB; usage 3072 MB — the 2 GiB
  copy had already given way), **4 GiB + 1 B · INCONCLUSIVE — the harness called a stall that was the
  padding tail.** Every declared byte arrived (both counters at 4 294 967 297 / 4 294 967 297 after
  ~1040 s = 3.9 MB/s, PSS 201–231 MB), and in Max privacy the sender then pushes the filler: at 2^32 + 1 the
  bucket is 4.5 GiB, so **512 MiB of filler, ~137 s at this speed, during which both sides sit at "100 %"
  by design** (progress is not emitted for filler). The harness's stall detector fires after 60 s without
  receiver progress, declared `stalled` at 1100 s, and the next rung's set-up tore the session down — so
  whether the receive would have completed ~1 min later was not observed. (A snapshot taken in that
  window showed the OPFS `incoming/` folder with the writable's `.crswap` pre-sized to 4 294 967 297
  bytes next to a 0-byte target, both sides `transferring`, PeerConnection `connected` — consistent with
  the filler still in flight; a first reading of it as "close() hung for 46 min" was wrong: the 46 min
  was the page's uptime since pairing.) Two probes exonerate OPFS itself on this phone: sparse files of
  2^32 − 1 / 2^32 / 2^32 + 1 bytes and a REAL 4 GiB + 1 B write (28 s, ~150 MB/s) all `close()` in ≤ 5 ms
  with the right size. **Re-run with a 400 s stall window (`STALL_S`), fresh pair, Max: 4 GiB + 1 B PASS**
  — done in 1144 s = 3.8 MB/s, every block verified (verify 32 s on the phone), PSS 238–249 MB over 221
  samples, "Received … 4.0 GB" + New transfer; **5 GiB PASS** — 1279 s = 4.2 MB/s (no filler: 5 GiB is a
  bucket edge), verified (40 s), PSS 240–243 MB over 247 samples, site storage then 5120 MB of a 15.4 GB
  quota (the 4 GiB copy had given way). **So the phone's site-storage ladder is 1 · 2 · 3 · 4+1 B · 5 GiB,
  all PASS, memory flat throughout — the handset half of B10's OPFS row is closed.** Not walked on the
  phone: the RAM rung (incognito is not reachable over this CDP socket) and past-the-quota (would need
  > 15 GB). Product note for BACKLOG: on a slow link a big file's padding tail is minutes of "100 %"
  with no sign of life — the UI should say what it is doing.
- **B4 (Android half) · T2 · PASS, deny half** — the owner tapped Block on Chrome's camera prompt: the
  viewfinder gave way to "Camera unavailable — paste the link below instead." with the paste field under
  it, no crash, `permissions.query({name:'camera'})` = `denied`. ("Never allow" is what Chrome offered,
  so re-allowing meant the site-settings sheet — Permissions → Camera — not a second prompt.)
- **A2 · T2 · Pixel 5 scans the QR on the Mac's screen · FAIL on the live build — and so does the desktop
  rehearsal now.** Camera re-allowed, the QR framed large and sharp in the viewfinder (screenshot
  `scan_now.png`): no decode, ever. The phone's console: every frame dies in **`LinkError:
  WebAssembly.instantiate(): Import #78 "a" "ya": function import requires a callable`**. The desktop
  fake-camera rehearsal (`sc_qr`, Chrome 154) against the SAME live build: the identical error, 60 s, no
  connect — the rehearsal that PASSED on 2026-09-27. **Cause:** the live site had moved to a build of
  `c5f6e94` (2026-10-01, "runtime deps refreshed within their ranges"): `barcode-detector` went
  3.2.0 → 3.2.2, whose inlined glue is **zxing-wasm 3.1.3 (78 imports)**, while the exact direct pin
  still vendored the **3.1.0 reader (80 imports)** — the version coupling CLAUDE.md § QR warns about,
  with nothing enforcing it: `tsc`, `vite build` and the e2e (which scans through the paste fallback)
  all stayed green. **B3 therefore also FAILS on this build on every engine** — the self-hosting half
  holds (the ponyfill 15 KB and the 1064 KB `.wasm` came from `hushsend.frelikh.dev` only, nothing
  from jsdelivr/fastly, on the phone and on the desktop), the decoding half does not. **Fixed in the
  working tree 2026-10-02 (not yet committed/deployed):** `zxing-wasm` pinned to 3.1.3 (one deduped
  copy with barcode-detector's), the built glue's 78 keys match the built `.wasm`'s 78 imports, and a
  new `vitest` gate in `src/ui/zxingWasm.test.ts` instantiates the ponyfill's glue with the vendored
  reader and decodes a real hushsend-link QR (its negative control — the same glue with the old 3.1.0
  bytes — reproduces the LinkError). Verified on a local `vite preview` of the fixed build with the
  fake camera: decoded in 0.5 s, `zxing_reader-BxB2YfIY.wasm` fetched same-origin, no console error.
  **Committed and deployed as `9bdda44` the same evening (§ 0.1); the desktop fake-camera scan on the
  LIVE build then decoded + connected in 0.5 s — A2's desktop rehearsal and B3's desktop half PASS
  again.**
- **A2 · T2 · Pixel 5 scans the QR on the Mac's screen · PASS on the fixed live build (`9bdda44`)** —
  the phone's Chrome cache cleared over CDP (it had the old bundle open; the entry chunk then read
  `index-CL2avokU.js`), the owner pointed the camera at the Mac's Share screen: the scanner left the
  viewfinder 7.3 s after opening (decode), `connected` at 8.5 s, both sides "one-time secret verified",
  fragment scrubbed, `host ↔ host`. The phone's Chrome was **154.0.8037.126** by then — the owner updated
  it mid-pass (everything above A2 ran on 152). **B3 (Android half) · PASS** in the same run: the scan
  fetched `ponyfill-BuxwROcg.js` (15 KB) and `zxing_reader-BxB2YfIY.wasm` (1068 KB) from
  `hushsend.frelikh.dev` only — nothing from jsdelivr / fastly / any third party. (Stand note: the USB
  cable comes loose when the phone is lifted to the screen; Wireless debugging works without pairing —
  `adb mdns services` → `adb connect <ip>:<port>` — but Android switched it off when the screen slept.)

**The trap this session hit — record the phone's privacy mode AND its SSID with every run.** The phone's
stored pref was Reliable from an earlier session, so the first A1/A3/A4/A5 runs were mixed-privacy on the
LAN (they connected `host ↔ host`, which is the C4 control, and A1 was re-run Max ↔ Max before being
ticked). And `svc wifi enable` after an F2/F8 cut rejoined the STRONGER saved network — the VPN Wi-Fi —
so from F8 on every run was cross-network until the roster dump said so. Read the SSID back
(`dumpsys wifi`) before claiming which network a run used.

**When the pass is done:** fold the results into `BACKLOG.md` § Step 6 / **6e** (and its
"Remaining (real devices, post-deploy)" line) and `CLAUDE.md` § Current state / Build order in the
SAME pass — doc drift is a bug (CLAUDE.md § Keep this file in sync). Bugs found here become new
BACKLOG items under "UX bugs — found in the manual test pass"; anything security-shaped goes to
§ Security audit instead of being fixed ad hoc.
