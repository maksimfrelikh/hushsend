# UX bugs found in the manual test pass, and their fixes (2026-09 – 2026-10)

Dated records, moved out of BACKLOG.md on 2026-10-11 when it became a list of open work only. Each entry
was true on its date; the current state is in the living documents (see [README.md](README.md)).

- ✅ **iOS Safari ends the WebRTC connection when the screen locks — found 2026-10-03 on the iPhone 15
  (iOS 26.6), TESTPLAN F1. Owner chose (c) the same day, LIVE as `bf485ae`: `ui/wakeLock.ts` holds a Screen
  Wake Lock while a transfer is in flight — requested INSIDE the Accept / Send tap, because iOS grants it only
  with user activation (the first build asked from the phase-change effect and was refused silently) — and the
  transfer screen says to keep the screen on. Verified on the phone: a 3 GiB receive with Auto-Lock at 30 s ran
  to Delivered untouched (CLAUDE.md § File transfer). An app switch still ends the connection (measured).**
- ✅(code) **Controls "blink" on a tap on the phone — found 2026-10-03 by the owner (screen recording).** Two
  things stacked: iOS's own tap highlight (the kit sets `-webkit-tap-highlight-color` to fg 10 % on `:root`)
  flashed across the whole path-disclosure row and the details summaries the moment a finger landed, and the
  kit's `.pill:active` — the full ink inversion with a `--dur-fast` fade — turned every pill black for the
  length of the touch (on a mouse the hover already holds the inversion, so a press is invisible there).
  Hover rules were NOT the cause: kit and app already gate them with ` (hover: hover)`. Fix in
  `app.css`: the system highlight is off on the app's controls (they all carry their own feedback), and on
  `(pointer: coarse)` a quiet pill press — wash one step darker, no transition — replaces the inversion
  (option (b) of the three put to the owner). **Folded into the kit the same day — stark-ui-kit 0.3.2
  (`f9d9250`): `theme-mono.css` sets `--brand-tap-highlight: transparent`, `controls.css` gives `.pill` / `.btn` the
  quiet press under `(hover: none)`; hushsend pins it and dropped its own copy. frelikh still pins 0.3.0 —
  bump it to get the same (kit CLAUDE.md § How a change travels).
- ✅(code) **The column was 144 px narrower than the boards on a desktop — found 2026-10-03 by the owner ("looks
  like a small tablet version on my MacBook").** `.hs-main` set `--maxw: 520px` on the kit's `.wrap`, a
  border-box whose `padding-inline: var(--gut)` sits INSIDE that max-width — so the content column was 376 px
  at 1440 (gutter 72) and 452 px at 680 (gutter 34), while MainDesktop / MainTablet draw a 520 px column with
  the gutter outside it; the h1 wrapped to two lines where the board has one. Now
  `--maxw: calc(520px + 2 * var(--gut))`: content 520 at 680 and 1440, measured; 375 unchanged (the viewport
  binds). Every visual baseline at 680 and 1440 shifts — re-recorded 2026-10-03 in `9775117` (the owner, 48
  files: 24 at 680, 24 at 1440).
- ✅(code, LIVE `bf485ae`) **The ended row clipped its reason on a phone (2026-10-03, owner's screenshot):**
  "declined · This file is 5.0 GB — larger than the…" ran off the right edge at 393 px, so the actionable
  part (free up space / use a normal window) was unreadable. A reason that is a sentence now gets its own
  line under the label (`.hs-box__reason`); the short "stopped at 12 MB" aside stays on the right. The same
  pass put a hairline between the Finishing explanation and the keep-the-screen-on line on the transfer
  screen (`.hs-send__keepon`) — the two grey sentences read as one (owner's screenshot). The visual baselines
  of `transfer-declined` / `transfer-error` at 375 were re-recorded 2026-10-03 in `9775117`;
  `transfer-finishing` is not in that commit (presumably unchanged — not checked). An 800 MB receive stopped at 14 % the moment the owner locked the phone: ICE
  went `disconnected` ~7 s later and `failed` ~10 s after that, and both sides showed "Connection lost"
  (the Mac: "not delivered · stopped at 109 MB · ICE failed"). The loss path is honest, but on an iPhone a
  receive survives only while the screen stays on — the Pixel 5 ran on under the lock (F1 Android half),
  so this is iOS suspending the page, not the app. Nothing in the hidden-page / Save-file logic helps,
  because the connection itself is gone. **Mitigation candidates for the owner:** (a) hold a **Screen
  Wake Lock** (`navigator.wakeLock.request('screen')`, Safari ≥ 16.4, Chrome, Firefox) while a transfer
  is in flight on either side — the lock by timeout then never happens (a deliberate button press still
  ends it), released on done / cancel / fail; (b) a one-line hint on the phone's transfer screen
  ("keep the screen on"); (c) both. Measured, not assumed: [the 2026-10-03 run log](docs/test-runs/2026-10-03.md).
- 🔴→✅(code) **QR scanning dead on the live build since the 2026-10-01 dependency refresh — found
  2026-10-02 on the Pixel 5, confirmed on desktop Chrome 154 (TESTPLAN A2/B3).** `c5f6e94` moved
  `barcode-detector` 3.2.0 → 3.2.2 within its `^` range; its inlined zxing glue is now zxing-wasm 3.1.3
  (78 imports) while the exact direct pin `zxing-wasm: 3.1.0` kept vendoring the 3.1.0 reader (80
  imports). Every detect call died in `WebAssembly.instantiate` with `LinkError: Import #78 "a" "ya":
  function import requires a callable`, caught by ScanScreen's per-frame `catch {}` — the viewfinder
  looked alive and nothing was ever decoded; only the paste fallback worked. This is exactly the coupling
  CLAUDE.md § QR warns about, and the warning was all there was: `tsc`, `vite build`, the e2e (paste
  fallback) and the 2026-10-01 dep refresh's own checks were green. **Fixed in the tree 2026-10-02
  (commit + deploy pending):** pin moved to 3.1.3 (deduped with barcode-detector's copy) and a vitest
  gate (`zxingWasm.test.ts`) that instantiates the ponyfill's glue with the vendored `.wasm` and decodes a
  real hushsend-link QR — the negative control with the 3.1.0 bytes reproduces the LinkError. Verified
  on a local preview with the fake camera (decode in 0.5 s). **Still open:** (a) an e2e that scans a QR
  through the real camera path (Chromium `--use-fake-device-for-media-stream` +
  `--use-file-for-fake-video-capture` with a y4m rendered from the live link, as the harness's
  `qr2y4m.cjs` does) so the WHOLE scan path is in CI, not just the ABI; (b) ScanScreen's silent
  `catch {}`: a decoder that throws the same error on every frame should surface the paste fallback (or
  a "scanner unavailable" line) instead of a live-looking viewfinder — the first frames' error is
  "transient" only if a later frame succeeds.
- ✅(code, 2026-10-03) **A Max-privacy side that cannot go direct does not always get the "Switch to
  Reliable" hint — found 2026-10-02 on the live build, Mac Chrome (Max) ↔ Pixel 5 (Reliable) across two
  networks (TESTPLAN C3).** Done as proposed: `peerLeftWhileDirectAttempt()` (Max + PeerConnection in
  flight + no transport) sends the link/qr, room/SAS and reconnect `onPeerLeft` branches through
  `failDirect(DIRECT_FAIL_REASON)`; words untouched. Unit-tested in `SessionController.sasPeerLeft.test.ts`
  (CLAUDE.md § Max-privacy strict model). Original note:
  Whose ICE gives up first decides the copy: when the Max side's own ICE reached `failed` first it read
  "Couldn't connect directly — Switch to Reliable" (the phone as Max on the link method; both room runs);
  when the Reliable peer's ICE failed ~2 s earlier its socket closed, the `peer-left` arrived first and
  the Max side ended through the pre-transport `onPeerLeft` branch as **"Couldn't connect — peer left
  during pairing"** (twice, with the Mac as Max creator on the link method; the two ICE timeouts are both
  ~15 s from `connecting`, so the order is a photo finish). Fail-closed either way, so not a security
  finding — but the one actionable line (relay would have saved this) is missing exactly in the mixed
  pair the hint exists for. Candidate fix: when a pre-transport `peer-left` lands on a Max-privacy pairing
  whose PeerConnection is still `connecting`/`checking` (ICE not failed, not connected), fail with
  `DIRECT_FAIL_REASON` (or append the hint) instead of the bare "peer left" — the peer leaving before any
  transport existed is, in Max privacy, overwhelmingly a direct path that could not be built. Decide
  with the owner; keep the words branch's guess-counting untouched.
- ✅(code, 2026-10-03 — owner chose option 1) **The padding tail is minutes of "100 %" with no sign of
  life on a slow link — seen 2026-10-02 on the Pixel 5 ladder (TESTPLAN B10).** Done as the UI line:
  `TransferScreen` derives `finishing` (transferring + every declared byte crossed), titles the panel
  "Finishing" and adds a `role=status` line — "Hiding the file's size — a little extra data goes out /
  arrives after the file" in Max privacy, "Waiting for the other side to confirm…" / "Saving the file."
  otherwise (CLAUDE.md § File transfer). No core or protocol change; the ladder is untouched. Visual/a11y
  scene `transfer-finishing`. Original note: At 2^32 + 1 B the Max-privacy bucket is 4.5 GiB, so after the last
  real byte the sender pushes 512 MiB of filler; progress is deliberately not emitted for it (the UI
  would read > 100 %), so at this LAN's 3.9 MB/s both screens showed "Sending/Receiving … 100 %" for
  ~137 s with the bar full and nothing moving — long enough that the test harness called it a hang. The
  arithmetic is right (padding.ts: ≤ 12.5 % above 1 MiB) and headless tests cover it; the cost of the
  2026-09-17 decision shows only on a real device on a real link. Options: a "finishing — hiding the
  file's size" line while filler flows, or a padding ceiling in absolute bytes (a cap of, say, 64 MiB of
  filler buys back the minutes at the cost of a coarser bucket for files over 512 MiB — files that
  size are rarer and their exact size is less telling). Owner's call.
- ✅(code, 2026-10-03) **A reconnect wait that loses its network for a few seconds meets its own GHOST at
  the rendezvous — found 2026-10-03 on the Pixel 5 while verifying the retry fix.** Done as proposed:
  `resumeReconnectWait` — a pre-transport `peer-left` on the reconnect method, or the re-auth deadline
  with no channel ever opened, tears the half-pairing down, returns to the wait screen (`pairing →
  awaitingPeer`) and re-takes the rendezvous, against the ORIGINAL wait cap (`waitUntil`) and the
  re-join cap; a peer that raised a channel and then stalled still fails. Unit-tested in
  `SessionController.reconnectRendezvous.test.ts` (CLAUDE.md § Reconnect → Rendezvous). Original note: Wi-Fi off for 12 s under the wait: the
  phone's socket died (1006), the new retry loop re-took the rendezvous every 3 s while offline (each
  attempt failing to open), and when the network came back the first socket that opened found a PEER in
  the token room — the phone's OWN previous socket, which the server had not yet noticed was dead (it
  detects a dead socket in ~25 s, cf. F8). Pairing started against the ghost ("Agreeing on keys…"), the
  ghost never answered, and ~25 s later the server's `peer-left` ended the session as "reconnect aborted
  — peer left during re-auth". Two consequences: the wait is lost after a blip it had just survived,
  and while the ghost sits there the 1:1 token room is FULL, so the real other device would be bounced
  with 4002 for those seconds. Candidate fix: a pre-transport `peer-left` (or the liveness deadline) on
  the RECONNECT method should return to WAITING and re-take the rendezvous — the other device may still
  come — rather than fail, bounded by the existing wait cap; and/or treat a peer that never sends its
  hello within a few seconds the same way. Owner's call (it changes the reconnect failure semantics).
- ✅(code, 2026-10-03) **A reconnect wait dies on a network change instead of re-taking — found 2026-10-02
  on the Pixel 5 (TESTPLAN E7 +15 min).** The 1006 itself was already answered with a re-take; what ended
  the wait was the re-take's socket failing to OPEN on a network still coming up. Now that failure
  schedules another take after `RECONNECT_RETRY_MS` (3 s) inside the same `RECONNECT_MAX_REJOINS` cap,
  and the browser's `online` event re-takes at once (not counted). "Signaling connection failed" is kept
  for the cap running out. Unit-tested in `SessionController.reconnectRendezvous.test.ts` (CLAUDE.md
  § Reconnect → Rendezvous). Original note: While the phone sat on `ReconnectWaitScreen` the owner switched its Wi-Fi; the
  signaling socket closed with **1006** and the wait ended at once as "Couldn't connect — reconnect:
  signaling connection failed". The wait re-takes the rendezvous on a `room-closed` / server close and on
  the 2-min refresh, but a 1006 (abnormal close — the network under the socket went away) is treated as
  terminal. A phone walking from Wi-Fi to cellular, or roaming between access points, is exactly the device
  that waits for a reconnect. Candidate fix: treat a 1006 during the wait like a server close — one more
  take after a short backoff, inside the existing `RECONNECT_MAX_REJOINS` bound — and keep "signaling
  connection failed" for the case where the re-take itself cannot open. Owner's call.

- ✅ **Firefox (any site-storage browser): a second big file right after the first is refused with
  "Free up disk space" while the disk is nearly empty — found 2026-09-28 on the live build.** The
  delivered file's copy stays in site storage for `OPFS_HOLD_MS` (10 min) and counts against the site's
  quota (Firefox: 10 GiB), so after a 6 GiB receive a 5 GiB offer 4 s later was refused: "This file is
  5.0 GB — larger than the 3.9 GB this browser can take right now. Free up disk space, or receive it in
  another browser…" — with 267 GB free on the Mac. Correct by the rules, misleading in the words, and it
  blocks back-to-back big receives on Firefox for up to 10 minutes. (b) the words — DONE 2026-09-28 (in
  code, not deployed): when the file would fit but for the held copies (`opfsHeldBytes`), the refusal
  reads "This file is 5.0 GB, and this browser's storage is still holding the last file it received —
  that copy is cleared within 10 minutes of its download. Try again in a few minutes, or receive it in
  another browser." (unit-tested; live since the `7e71275` deploy). (a) — DONE 2026-09-28, LIVE since
  ~18:00 UTC (`1f2abab`) and verified there (TESTPLAN, the evening entry: 6 GiB, then 5 GiB at 21 s →
  refused in the new words, at 125 s → accepted, the old copy gone; owner: "someone receiving several
  files with the site open will not leave the downloads unanswered"): a new receive that needs the room drops this tab's delivered copies held ≥ 2 minutes
  (`evictHeld`, `OPFS_EVICT_AFTER_MS`) and plans again by reservation; only a copy younger than that
  still refuses, now "try again in a couple of minutes". Safari hits it only past ~38 GB (its quota is
  76.8 GiB); desktop Chrome never (it streams).
- ✅ **Straight into Downloads on desktop Chromium, with flow control — DONE 2026-09-28, LIVE since
  06:32 UTC (`c5a51c4`) and verified there (TESTPLAN, the last 2026-09-28 entry: B1, the stream and
  site-storage ladders to 5 GiB, a cancelled and a paused download, Chrome incognito, Firefox private)
  (owner: "where it can be done without RAM, save straight into Downloads with no copy in site
  storage").** A download worker (`public/dl/sw.js`, scope `/dl/`, registered per offer and
  unregistered after) streams the file into the browser's download manager as it arrives: no copy, no
  RAM, no dialog, no quota. Desktop Chromium only — measured on the real engines: Chrome 154 wrote
  1 GiB through it intact and flat, and an aborted stream or a worker killed mid-download ends the
  download FAILED; **Firefox 156 fails unsafely** (an aborted download stalls with a `.part` left; a
  dead worker makes it COMPLETE a truncated file), **Safari 26.6** writes 0 bytes. Firefox, Safari and
  mobile browsers keep site storage. Flow control rides along: the receiver grants a 16 MiB window in
  `accept` and tops it up with `credit` as its sink takes the bytes, so a paused download pauses the
  sender instead of filling the receiver's RAM (backward compatible both ways). Tests: unit
  `fileTransfer.flow.test.ts`, `fileTransfer.test.ts` (plan order), e2e `receive-disk.spec.ts` (the
  stream arrives intact with nothing in site storage; a download cancelled in the browser stops both
  sides), `connection-lost.spec.ts` (a started stream download ends FAILED). **Still to prove:** mobile
  Chromium on a handset (then it could stream too), Firefox on a later version (re-run the two failure
  probes before enabling it), and a paused download on the live build (TESTPLAN B10).
- ✅ **Chrome incognito: a file past ~430 MiB was accepted to site storage and died mid-transfer —
  FIXED 2026-09-28, LIVE since 06:32 UTC (`c5a51c4`); found and re-checked the same day on the live
  build ([the run log](docs/test-runs/README.md), B2's private-window rung: incognito Chrome now streams 1 GiB straight
  into Downloads, nothing in site storage).** In an incognito (off-the-record) context
  `navigator.storage.estimate()` reports the normal profile's quota (10 GiB on this Mac — Chrome does
  not let a site tell incognito apart by its quota) while site storage holds only ~430 MiB and looks
  RAM-backed. `planReceive` trusted the estimate, so a 600 MiB offer was accepted on the OPFS path and
  failed at 74 % with the browser's raw "exceed its storage quota" text. Now: (1) desktop Chromium —
  incognito included, Playwright's contexts are off-the-record — streams straight into Downloads and
  never touches site storage; (2) wherever site storage IS used, the plan RESERVES the whole size
  before the offer is shown (`opfsCanHold`: `truncate(size)` on a probe writable — 1–2 ms for 5 GiB on
  Chrome, Firefox and Safari, sparse, counted in the quota at once, a fast QuotaExceededError in
  incognito) and again at accept (`createIncoming(size)`), so a store that cannot hold the file is
  known before a byte crosses; (3) a QuotaExceededError reads "not enough space in this browser's
  storage — free up disk space, or receive in a normal (not private) window". Firefox private has no
  site storage at all (`getDirectory()` → SecurityError), so it takes the RAM path ≤200 MiB and refuses
  larger files before accept. Safari private: not measured (safaridriver cannot open one).
- ✅ **Peer gone after `connected` — FIXED and DEPLOYED 2026-09-27 (`153addd`); F3 re-run PASS on the live
  build; F2 not yet re-run (needs a phone).**
  Every loss signal after `established` (DataChannel close, connection closed, ICE failed, and a
  30 s backstop on `disconnected`) now reaches `SessionController.onConnectionLost`: the in-flight
  transfer is failed first ("connection lost"), the session goes `connected → failed`, and
  FailedScreen's `lost` variant shows the last file's outcome ("not delivered" / "not received" /
  "delivered"). While ICE is `disconnected` the transfer screen says "Connection interrupted"; the
  sender's drain wait no longer hangs on a closed channel; a `pagehide` goodbye closes the transport,
  so a closed receiver is noticed in 41 ms instead of 16.5 s (on Chromium a SENDER closing mid-send
  still takes ~16 s — cause not established; Firefox and WebKit notice it in under a second). This also
  covers (c): a link sender that gives up closes its connection, which the verified receiver now reads
  as lost. Verified: 19 new unit tests and `tests/e2e/connection-lost.spec.ts` — Chromium 154 (receiver
  closes / sender closes / receiver's renderer crashed: interruption shown at 6.4 s, session ended at
  16.3 s), Playwright Firefox and WebKit (the two closed-tab cases). Live since 19:58 UTC; on the live build F3
  passed (the sender said "Connection lost · not delivered" 25 ms after the receiver's tab closed —
  TESTPLAN, fourth 2026-09-27 entry). Still to do: re-run F2 on a real phone. Details: CLAUDE.md § File transfer →
  *Liveness after connect*. The original report, for the record:
  **Peer gone after `connected` is never surfaced (found 2026-09-26, Brave↔Brave T1).** Once
  `established`, `SessionController.onChannelClose` has no branch: the peer navigates away, its
  DataChannel closes, and this side stays on "Secure channel open" / `connected` indefinitely. A
  later Send fails visibly ("transfer error · data channel is not open"), so it is not a hang, but
  the screen lies until then. Expected: a "peer left" terminal state (or a notice + return home).
  **Confirmed 2026-09-27 in two more shapes ([the 2026-09-27 run log](docs/test-runs/2026-09-27.md)): (a) F3 — the receiver's tab was
  closed at 8 % of a 900 MB send and the SENDER froze at 46 % "Sending · connected" for >70 s, no
  failure, recoverable only via Close channel; (b) a Firefox↔Safari pair whose ICE went
  `disconnected`→`failed` 14–36 s after connect left BOTH sides on `connected` ("Sending 0 %" /
  "Receiving 0 %") for >60 s; (c) F8 (2026-09-27 afternoon) — when the SENDER of a link gives up on key
  confirmation after 120 s, the silent receiver, which had already verified the sender's tag, keeps
  showing "Secure channel open" to a peer that is gone.** **And in three more on the Android emulator
  (2026-09-27 evening): (d) F2 with REAL airplane mode for 20 s mid-transfer — both peer connections went
  `disconnected` ~10 s into the cut and `failed` 10 s later; after the network returned nothing
  recovered and nothing failed: the receiver sat on "Receiving 3 407 872 B" and the sender on "Sending
  4 194 304 B" for 150 s+; (e) the Android save-dialog death (next item) — a 0-byte file, the receiver on
  "Receiving 0 %", the sender on "offered"; (f) every stalled bulk transfer through the emulator's
  network (a harness limit, but the app's reaction is the same: both sides keep "transferring").**
  One fix covers all of them: handle `connectionstatechange`
  `failed`/`disconnected` and the DataChannel `close` in the `established` phase — fail the in-flight
  transfer visibly and end the session (a "peer left" terminal state), instead of nothing.
- ✅ **"Delivered" waits for the receiver's confirmation — DONE 2026-09-27, LIVE 2026-09-28 (`90fdc15`; owner's
  decision).** Found while fixing the item above: the sender said "Delivered" the moment `eof` sat in its
  send buffer, with up to a MiB still in flight (the live F3 run showed it — 3.5 MB "sent" against 1 MiB
  received), so a receiver whose tab died in that window left the sender claiming a delivery that never
  happened. Now the receiver sends `{t:'received'}` once every DECLARED byte is saved (an `eof` short of
  the declared size is an error, and the receiver sends `cancel` so the sender stops waiting), and the
  sender reports done only on it; a loss while it waits ends "not delivered". The phase flips before the
  eof send, so a confirmation that overtakes a drain wait still counts. `fileTransfer.lost.test.ts`.
- ✅ **Android save dialog killing the transfer — SUPERSEDED 2026-09-28, LIVE the same day (`90fdc15`; owner's
  rule: "disk wherever possible, a dialog only if disk needs one").** Receives now go to site storage
  (OPFS) with NO dialog while the connection is live; the save dialog is used only when OPFS cannot
  hold the file (quota) — CLAUDE.md § File transfer. Needs the real Android phone to confirm (OPFS on
  Chrome 149 for Android was not probed on a device). The report, for the record:
  **Android Chrome: the transfer dies if the system save dialog stays open for more than ~10–20 s
  (found 2026-09-27, emulator, [the 2026-09-27 run log](docs/test-runs/2026-09-27.md) third entry).** Chrome 149 on Android HAS
  `showSaveFilePicker`, so Accept opens Android's own save UI (DocumentsUI → Downloads → SAVE) inside
  the gesture — the FSA path, uncapped, not the 512 MiB Blob path the plan assumed. With the picker in
  front for 40 s or more (four runs — my automation was slow to press SAVE) both peers' ICE went
  `disconnected` within ~10–20 s of it opening and `failed` 10 s later; a SAVE after that created a
  0-byte file (twice) and both screens froze (previous item). With the picker dismissed within ~11–12 s
  (two runs) the connection survived and the 5 MB file saved byte-identical.
  The page's own JS kept running while the picker was up (a 200 ms heartbeat never paused more than
  1.1 s), so the mechanism is not a frozen page — not established; a real phone may differ. A person
  browsing folders in that dialog can easily take 20 s. Options, owner's call: prefer the Blob path on
  mobile UAs, or survive/resume after the picker (needs the peer-gone fix above at the least).
  Cancelling the picker is handled well: the receiver ends "Transfer ended · cancelled".
  **Since the peer-gone fix (deployed 2026-09-27):** the freeze half is gone — both sides
  end on the connection-lost screen when ICE fails under the picker, and what the picker returns
  afterwards is discarded instead of opening a writer to a dead peer. The underlying behaviour (the
  connection dying while the picker is up) and the 0-byte file are unchanged — the decision above
  still stands.
- ✅ **A signaling drop now reads "Lost the connection to the server" — DONE 2026-09-28, LIVE the same day
  (`90fdc15`).** FailedScreen's `expired` keeps 4009/4010/4002 and room answers; any other `signaling
  closed` (1006 above all) is the new `server` variant. The report:
  **A signaling drop during pairing reads as "Room not found or code expired" (found 2026-09-27,
  Android emulator).** `FailedScreen` puts any `signaling closed (code N)` into the `expired` variant
  (`/(not found|expired|4009|room full|signaling closed)/`), so a network drop (1006) while a LINK or
  WORDS join is pairing shows "Room not found or code expired — Check the digits or start your own
  room" to someone who typed no digits. Seen twice: the Android joiner of a Max-privacy link pair that
  could not connect, and the Android joiner after F8's airplane mode. Fix: keep `expired` for
  4009/4010/4002 and give 1006/other closes a "lost the connection to the server" variant.
- ✅ **A file that completes while the page is hidden waits for "Save file" — DONE 2026-09-28, LIVE the
  same day (`90fdc15`; owner: option A).** The controller holds the finished file when `visibilityState` is
  `hidden` and the finished row shows Save file; the tap hands it over. e2e `receive-disk.spec.ts`
  (visibility faked); the real iPhone (F1) still has to confirm. The report:
  **iOS (simulator): a Blob download that fires while the screen is locked is lost silently
  (found 2026-09-27, TESTPLAN F1 rehearsal).** 400 MB to the iPhone 17 simulator with the screen locked
  right after Accept: the transfer itself finished (sender "Delivered" after 28 s), but the hand-off to
  the download — iOS's "Do you want to download…" prompt — was never shown: after unlock no prompt was
  pending, no file was in Files, no error was shown. The same transfer unlocked (control) prompted and
  saved a byte-identical file. On a real iPhone this is the likeliest shape of F1; the receiver should
  re-offer the save (a "Save file" button on the finished row) when the page was hidden at the
  hand-off. Needs the real-phone run to confirm. **Real iPhone 15, 2026-10-03: the shape is different —
  the CONNECTION dies on lock (the item at the top of this section), so the hand-off never comes into
  play; Save file after a lock mid-transfer is therefore untestable on iOS, and the hidden-page fix
  stays relevant for an app switch that does not lock (not measured).**
- ✅ **The lobby device label — REMOVED from the protocol 2026-09-27 (owner's decision); client and
  server (`hush-signaling-server` `3d96125`) LIVE 2026-09-28, the client first.** Since the 2026-09-26 redesign a roster row was
  the readable id + join time and `peer.device` (`Desktop`/`Mobile`) was sent, capped and relayed but
  never rendered — metadata for the untrusted server and nobody else. The client no longer sends
  `?device=`, the server neither reads nor relays it, and the client's schema tolerates an old server
  that still does (zod strips the key). TESTPLAN D1 reworded. Deploy order: the frontend first (it
  ignores `device` either way), then the signaling server — a tab still running the OLD client rejects
  roster frames without `device`, so hard-refresh after the deploy, as § 0.1 already says.
- ✅ **"Forget pinned devices" asks first — DONE 2026-09-27, LIVE 2026-09-28 (`90fdc15`).** The row turns into
  "Forget every paired device? Each will have to pair again." with **Forget all** / **Cancel**, Cancel
  focused (a stray Enter cannot wipe anything); `tests/a11y` covers the contract, `visual` the state
  (`home-forget-confirm`). It still also rotates this browser's own identity key: once the pins are
  gone no pairing survives either way, and a fresh key keeps this browser unlinkable to its past
  pairings — nothing the user would notice, so the owner was told rather than asked. The report:
  **"Forget pinned devices" acts on one tap, with no confirmation (noted 2026-09-27).** `onForgetAll`
  calls `resetIdentity` directly — the identity key is regenerated and every pin is gone, so every
  paired device has to pair afresh. On the iPhone simulator the keystore was found in exactly that state
  (new identity, 0 pins) after a tap sequence of mine near the bottom of the home screen — the likely
  cause, not verified. A confirm step (or an undo) is cheap for an irreversible action.
- ✅ **The SAS reader can stop after confirming early — DONE 2026-09-27, LIVE 2026-09-28; A4b
  PASS on the live build.** "Verifying…" now carries the reader screen's "Stop — they don't have this phrase" pill
  (`sas-waiting-abort`, `ConnectingScreen`) wired to `confirmSas(false)`; e2e `room-sas.spec.ts` "A4b".
  The report: **The SAS reader cannot stop after confirming early (found 2026-09-27, A4b).** The reader taps
  "They read it back — connect" before the picker has answered and lands on "Verifying…"
  (`confirming`) with no control at all — no abort, no Back. `SessionController` accepts a reject
  after our own approval up to settle (that is the whole point of the A4b case), but the waiting screen
  never offers one, so a reader who clicked too early is trapped until the picker answers or the
  120 s deadline. Expected: the same "Stop — they don't have this phrase" pill on the waiting screen,
  wired to `confirmSas(false)`.
- ✅ **Same-LAN Max privacy needs the macOS "Local Network" permission — DOCUMENTED 2026-09-29, LIVE
  the same day (`8c9ea59`; the hint itself is covered by unit tests, not yet seen on a real direct
  failure on a Mac).** README § Privacy modes says it, and the direct-fail screen adds `localNetworkHint`
  (`local-network-hint`) on a desktop Mac (`ui/platform.ts` `isMacDesktop`: a Macintosh UA with no
  multi-touch — an iPad asking for the desktop site is not a Mac; unit-tested). NOT done: the optional
  detection of "only an mDNS host + a private srflx". The report (found 2026-09-27): On one LAN every browser gathers only an mDNS host candidate plus an srflx that is the
  ROUTER's LAN address (the hairpinned STUN reply), so LAN peers pair over mDNS alone; a browser that
  lacks Privacy & Security → Local Network (Brave did) cannot resolve or publish `.local` and fails
  visibly with the switch-to-Reliable hint — which points at the wrong fix. The 2026-09-26 "Max
  privacy FAIL 2/2" was exactly this. README / the direct-fail hint should mention the permission on
  macOS 15+; optionally detect "only mDNS host + srflx that is a private address" and say so.
- ✅ **Copy nits from the 2026-09-27 pass — the rest FIXED 2026-09-29, LIVE the same day
  (`8c9ea59`; checked live: a link nobody opened failed on its creator after the server's 180 s as
  "Your link expired").** The waiting
  side of an expired room — the creator of words / a link / a 4-digit room, or a lobby member — now
  fails with `WAIT_EXPIRED_REASON` ("nobody joined before the code expired", set from a
  `waitingInRoom` flag the `roomReady` projections raise and `beginPairing` clears) and FailedScreen
  says "Your words expired" / "Your link expired" / "The room expired" with "Nobody joined in time";
  a joiner of a dead code keeps "Room not found or code expired" (`SessionController.waitExpired.test.ts`).
  The mismatch hard stop keeps its title and names the cause THIS side saw: "Your peer said the phrases
  don't match" (the peer's reject — the A4b picker who never confirmed anything), "The phrases didn't
  match" (our own reject), "The words didn't match on both sides — a mistyped word, or someone
  intercepting" (words key-confirmation), and otherwise "The check that proves you reached your peer
  failed" — no side is told about a phrase it never confirmed, and words / link have none. F7's plan
  text is corrected in TESTPLAN. Scenes `failed-sas-peer`, `failed-words-expired`,
  `failed-link-expired` are new; `failed-compromised` was re-recorded for the new description. Before
  that — two fixed 2026-09-28 (live the same day): a refusal just over a
  limit now prints both sizes in bytes when they would round alike, and the SAS hard-stop eyebrow
  ("numbers didn't match") is gone with every eyebrow. Still open: the creator's 4010 wording and
  F7's plan text, below. The original list: a refusal just over the cap reads "This file is 1.0 GB —
  larger than the 1.0 GB this browser can save" (same with 512 MB: both sizes round to the cap); the SAS hard-stop kicker says "numbers didn't match"
  (they are words); the CREATOR of an expired words/4-digit room sees "Room not found or code
  expired" (the joiner's wording) after its own 4010; TESTPLAN F7's "4002" is reachable only while the
  first pair is still pairing — after connect the token room is already gone and a second joiner gets
  the dead-link copy instead (correct behaviour, plan text to adjust). New 2026-09-28 (A4b on the live
  build): when the READER stops after confirming, the picker's hard stop tells someone who never
  confirmed anything "The phrase you confirmed doesn't match your peer's".
- ✅ **A link pasted into an already-open hushsend tab does nothing — FIXED 2026-09-29, LIVE the same day
  (`8c9ea59`; checked live: an open home tab given the link as its fragment joined in 608 ms with no
  reload).** `App.tsx` `LinkFragmentJoin` listens to `hashchange` too: the fragment is scrubbed at once, the link
  joins from the home screen and from a finished (failed) session, and a session in progress or a
  live channel is never torn down for it (the link is dropped). e2e `link.spec.ts`: home tab joins
  with no reload (a marker survives), a failed tab starts over and joins, a connected tab ignores a
  second link. The report (found 2026-09-26): Only the
  fragment differs, so the browser does a same-document navigation and `App.tsx` reads
  `location.hash` at load only. Either listen to `hashchange` (join if idle) or document that the
  link must be opened in a fresh tab. Test-drivers hit this too: always load `/health` first.
  Also seen on iPadOS Safari (simulator, 2026-09-27): a link opened into the tab that shows hushsend
  did nothing, for the same reason.
- ✅ **A relayed session is labelled "relayed through the server" — DONE 2026-09-28, LIVE the same day
  (`90fdc15`).** New verdict `relayed` from the selected pair's candidate types (`relax.selectedPairRelayed`,
  unit-tested), decided before the address check; the muted row replaces the sr-only "direct path
  confirmed". Phase C (cross-network, Reliable) is where a real relay shows it. The report:
  **"direct path confirmed" labels a RELAYED Reliable session — CONFIRMED 2026-09-27.** `localCandidateAddresses`
  attests every local candidate including `relay`, so a peer relaying through coturn attests its
  relay address, the selected remote address matches, verdict `ok`, label "direct path confirmed"
  (`i18n` `pathOk`). First suspected on a Brave↔Brave Reliable session; **proven on Chrome 154 ↔ the
  Android emulator's Chrome 149 in Reliable: `getStats()` on both sides selected `relay udp
  94.46.199.61` ↔ `relay udp 94.46.199.61` (coturn), and both pages rendered verdict `ok`.** Since the
  2026-09-26 redesign the `ok` state has no visible row — the text is sr-only — so a relayed session
  looks exactly like a verified direct one, and a screen reader says "direct path confirmed". Fix:
  exclude relay candidates from the attested set, or give a relayed path its own verdict/label.
- ✅ **Multi-file sends are one `hushsend-files.zip` (stored) — DOCUMENTED 2026-09-27.** Owner's decision:
  keep the behaviour (design since `1082b7d`), describe it. TESTPLAN A7 was reworded and re-ticked (three
  members unzip byte-identical), CLAUDE.md § File transfer and README now say so.
- ✅(code) **The Safari SENDER's memory grows during a very large send (found 2026-09-27, TESTPLAN B10) — ROOT
  CAUSE FOUND AND FIXED 2026-10-03: WebKit's `File.stream()` yields the WHOLE file as ONE chunk** (a 1 GiB
  File → a single 1 GiB read, measured on Safari 26.6), so the "stream" was the file in memory; Chrome and
  Firefox chunk finely. The sender now reads in 4 MiB windows via `slice().arrayBuffer()` (`readInWindows`,
  also fed to client-zip per entry) and re-chunks without copying (CLAUDE.md § File transfer). Before /
  after numbers on real Safari below.
  **Before** (live `a4bc62a`, Safari 26.6 → Chrome on the Mac, 2 GiB from a Blob of shared parts, `ps` every
  3 s): WebContent 250 → **394 MiB peak** (+144) at 28.8 MB/s. **After** (live `816046f`): the same synthetic
  blob is noisy — any Blob read allocates, so WebKit's lazy GC lets a few hundred MiB pile up and fall back
  whichever way the file is read (per-PID peaks 544 / 397 MiB, 54 MB/s — faster, not smaller). The test that
  matters is a REAL file: the owner picked a 2 GiB random file in his own Safari (file dialog) and sent it to
  Chrome on the Mac — **40.5 s = 53 MB/s, SHA-256 equal, progress steady, every WebContent process's memory a
  transient spike that fell back within seconds (peaks 390–780 MiB), nothing growing with the file**. Two
  earlier attempts of that run died with "ICE failed" at 1.0–1.2 GB on a swap-bound Mac (4.4 GB of 6 GB swap
  in use, ~60 MB free) — the stand, not the product: the third run on the unloaded Mac passed. What the fix
  provably removes is the one-chunk `stream()` read (the 1 GiB probe); a same-stand old-code baseline on a
  real file does not exist. A phone-side real-file send is still worth one by-hand run. The original note follows for the record.**
  Sending 5 GiB from Safari 26.6 to Chrome, its WebContent process grew from ~300 MiB to ~940 MiB by
  the end and fell back afterwards; Chrome and Firefox senders stayed flat. The source was a Blob built
  from shared parts, so the growth is in the read path (`File.stream()` → chunking → DataChannel), not
  the file. Harmless on an 8 GiB Mac, a likely tab kill on an iPhone. Measure a real-file 5 GiB send from
  iOS before deciding anything; if it reproduces, look for retained `Uint8Array`s in the pump/rechunker.
  **Code read 2026-09-29 (no change made):** the pump retains nothing — each piece is referenced only
  until its `put` resolves, the rechunker holds at most one source chunk plus one piece — and the
  growth fell back after the send, which reads as WebKit collecting lazily rather than a leak. What the
  read path DOES do is allocate: `Rechunker.pull` copies every piece into a fresh `Uint8Array`
  (~20 000 × 256 KiB for 5 GiB) even when one source chunk already covers it. If the iOS measurement
  shows the growth, the first thing to try is a zero-copy `pull` (return `head.subarray(…)` when the
  head alone satisfies the request, copy only to coalesce small chunks), measured before and after on
  the same device.
- ✅ **STUN cross-check: a cold Firefox can miss the 4 s probe window — window raised to 12 s
  2026-09-29, live the same day (`8c9ea59`); unverifiable until a second STUN operator exists** (with one configured
  STUN the probe does not run at all — `probeStunViews` needs two). The report (TESTPLAN B7):
  On a fresh profile Firefox's first srflx from the live STUN took 9.8 s (a 4 s probe got nothing);
  warm probes take 0.26 s. `PROBE_TIMEOUT_MS` is 4 s, so a cold Firefox reads `unknown`. Harmless while
  one STUN operator exists (the check says nothing then anyway); revisit with the second operator.
- ✅(code) **QR decoding never uses the native `BarcodeDetector` (found 2026-09-27, TESTPLAN B3) — DECIDED
  2026-10-03 (owner: "where we can, do not download the extra megabyte"): the native detector where it exists
  and lists `qr_code` (Chrome desktop / Android), the self-hosted zxing ponyfill elsewhere, and a runtime
  fallback native → zxing on the first native `detect()` that throws (`withZxingFallback`, CLAUDE.md § QR).
  The original note follows.**
  Verified before deploy in real Chrome 154 with the harness's fake camera against the local build: the DEV log
  said "QR: native BarcodeDetector", the QR was decoded and the page went to `joining` (its token-room socket
  opened on the live signaling, which then refused the 127.0.0.1 origin — a stand limit, not the scanner);
  **Live, `b73651d` (2026-10-03):** Chrome 154 with the fake camera scanned a QR from the live site and connected
  1.1 s after the scan tap ("one-time secret verified"); after the tap it requested one font and NOTHING of
  zxing — no `ponyfill-*.js`, no `.wasm`. Control in a fresh profile with `BarcodeDetector` hidden: the same
  1.1 s, and it fetched `ponyfill-BuxwROcg.js` + `zxing_reader-BxB2YfIY.wasm` from our origin — so the check
  sees the WASM when it is fetched, and the fallback path works live. **Owner, by hand after reloading (2026-10-03): scanning
  works on the Pixel 5 (Chrome) and the iPhone 15 (Safari).** Which decoder ran on the Pixel was not observed
  (no cable); a broken native one would have fallen back to zxing. The app
  imports `barcode-detector/ponyfill`, which is always zxing-wasm; desktop Chrome, which has a native
  detector, still fetched the 1 MB WASM. The docs claimed "native where available" (corrected in
  CLAUDE.md § QR and TESTPLAN). Decide: keep one decoder everywhere (simpler, current) or prefer the
  native one when present (no WASM fetch on Chromium/Android). Not a bug either way.
- ✅ **iPad — SUPERSEDED 2026-09-28 by the disk path:** every device, iPad included, now receives to
  site storage (OPFS), and the RAM-only fallback is ONE 200 MiB cap for all (owner's rule for RAM), so
  the iPad-specific 512 MB and the `isMobileUA` detection below were removed again. Kept for the record:
- (history) **iPad gets the MOBILE cap — DONE 2026-09-27, never shipped (superseded before the deploy;
  owner: 512 MB, "a gigabyte of RAM is too much"; no real iPad to measure).** `isMobileUA` also treats a Macintosh UA with
  `maxTouchPoints > 1` as a tablet (no Mac has a multi-touch screen); unit-tested both ways. The
  report: **iPad gets the DESKTOP receive cap — CONFIRMED 2026-09-27 (iPad (A16) simulator, iPadOS 27.0).**
  `isMobileUA` looks for `Android|iPhone|iPad|iPod|Mobile`; iPadOS Safari requests desktop sites by
  default and sends a UA without those words. Measured: a 1 GiB + 1 B offer was refused naming "the
  1.0 GB this browser can save" (an iPhone names 512 MB), a 512 MiB + 1 B offer was OFFERED (Accept
  shown), and the iPad's coarse label in `peer-joined` was `Desktop` (same regex family in
  `coarseDeviceLabel`). So a tablet holds up to 1 GiB in RAM on the Blob path. Whether that is safe on a
  real iPad (6–16 GB RAM, but per-tab limits) is a real-device question; the detection itself can use
  `navigator.maxTouchPoints > 1` on a Macintosh UA.

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
