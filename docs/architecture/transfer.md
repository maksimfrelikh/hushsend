# File transfer

Part of the architecture reference — [README.md](README.md) is the index.

- DataChannel with chunking + **backpressure** (`bufferedAmount` /
  `bufferedAmountLowThreshold`).
- **Several files in one send travel as ONE store-mode zip, `hushsend-files.zip`** (`client-zip`
  `makeZip`, streamed; `predictLength` gives the exact size for the offer), so the receiver sees one
  offer and one progress bar. By design since `1082b7d`; documented 2026-09-27 (TESTPLAN A7).
- **Receive to DISK wherever possible — owner's rules, 2026-09-27 and -28** ("write to disk whenever
  it is possible; a dialog only if disk needs one; a RAM-only receive capped at 200 MB"; then "a
  short-lived copy beats RAM — and where it can be done without RAM, save straight into Downloads with
  no copy in site storage"). `planReceive` (in `fileTransfer.ts`) decides per offer, BEFORE the offer
  reaches the screen, in this order:
  1. **Straight into Downloads** (`transfer/streamDownload.ts` + the download worker
     `public/dl/sw.js`) — a service worker answers a hidden iframe's navigation to `/dl/<32 hex>` with a
     streaming `Content-Disposition: attachment` Response fed by a TRANSFERRED ReadableStream, so the
     browser's download manager writes the file as it arrives: no copy, no RAM, no dialog, no quota
     (disk space is the limit). **Desktop Chromium only** (Chrome, Edge, Brave), detected by User-Agent
     Client Hints (`userAgentData` with a "Chromium" brand and `mobile: false`) plus a transferable-
     streams check. Measured 2026-09-28: Chrome 154 wrote 1 GiB through it (SHA-256 right, memory
     flat); a stream the page aborts, and a worker killed mid-download (CDP `stopAllWorkers`), both end
     the download FAILED — never a short file marked complete. **Firefox 156 is excluded although it
     streams:** an aborted stream leaves its download "in progress" for good (`.part` + an empty file
     under the real name), and once the worker is gone Firefox COMPLETES the download with the bytes it
     had — a truncated file that looks whole. **Safari 26.6** cannot transfer a stream
     (`DataCloneError`) and, fed chunk by chunk, writes 0 bytes. Mobile Chromium: unproven until a
     handset runs it (TESTPLAN B2/B10). The worker is registered when an offer is planned, keeps alive
     by a ping every 10 s while streaming, is unregistered 60 s after the last download (or after a
     declined offer), and `sweepDownloadWorker` at startup removes one a closed tab left.
  2. **OPFS** (`transfer/opfs.ts`) — the site's private on-disk folder, written with NO dialog, then
     handed over as an ordinary download read from disk. Used when a one-time write probe succeeds
     (`opfsUsable`, memoized per session), the site quota holds the file (`opfsRoom`, 64 MiB headroom)
     AND a **reservation** succeeds (`opfsCanHold`: `truncate(size)` on a fresh writable, aborted at
     once; at accept `createIncoming(size)` reserves for real). The estimate alone lied: incognito
     Chrome reports its normal profile's 10 GiB while holding ~430 MiB, and a 600 MiB file planned by
     the estimate was accepted and died at 74 % (TESTPLAN 2026-09-28). `truncate` costs 1–2 ms for
     5 GiB on Chrome, Firefox and Safari (sparse, counted in the quota at once) and fails fast in
     incognito. Measured on the live origin: quotas 10 / 76.8 / 10 GiB (Chrome / Safari / Firefox on
     the Mac); 3 GiB of incompressible data went to disk (no WebKit process above 31 MiB, Firefox
     flat). Playwright's WebKit 26.5 HAS the API and fails the first write (`UnknownError`) — hence the
     probe, not a feature check. This is the path of Firefox, Safari, every mobile browser, and the
     fallback when the download worker cannot come up.
  3. **File System Access** (`showSaveFilePicker`) — disk through the save dialog; only when neither
     of the above can take the file. The dialog is inside the accept gesture, as before.
  4. **RAM (Blob)** — `MAX_BYTES_BLOB` = **200 MiB on every device** (the UA split 1 GiB desktop / 512
     MiB mobile and `isMobileUA` are gone; iPad's 512 answer is moot now that it receives to disk).
  Else the offer is refused before accept, naming the largest thing that would have fitted (in bytes
  when both sizes would print the same; never an estimate a failed reservation just disproved — and
  when the file would fit but for the copies of files just received (`opfsHeldBytes`), the refusal says
  so and to try again in a couple of minutes, instead of "free up disk space"; measured on Firefox's 10
  GiB quota: 6 GiB received, a 5 GiB offer 4 s later). A new receive that needs the room first drops this
  tab's delivered copies whose hold began ≥ `OPFS_EVICT_AFTER_MS` (2 min) ago (`evictHeld`, owner's
  decision 2026-09-28: someone receiving several files with the site open has let the earlier downloads
  through by then; the accepted risk is a download still waiting on a browser prompt), then re-checks
  with the reservation alone (Safari reports freed space late). If
  the planned path still fails to open at accept (worker gone, reservation refused), `openReceive`
  takes the next path (`nextPlan`); `acceptIncoming` sends the sender the real reason (a dismissed
  dialog — `AbortError` — stays "recipient cancelled"); a QuotaExceededError reads "not enough space in
  this browser's storage…". OPFS housekeeping: each file lives under `incoming/<time>-<random>` held
  by a Web Lock; a failed / cancelled / never-saved file is removed at once, a delivered one after
  `OPFS_HOLD_MS` = 10 min (the download may still be reading it — and its blob URL now lives as long,
  `triggerDownload(…, holdMs)`, since a browser that asks "allow downloads?" fetches only after the
  answer), and `sweepIncoming` at startup removes what a closed tab left (never a file another tab
  holds).
- **Flow control (2026-09-28).** A DataChannel cannot push back on its sender, so a sink that slowed
  down piled chunks up in the receiver's JS (the `tail` promise chain) — harmless on a fast disk,
  unbounded RAM once a download is paused in the browser. The receiver now sends
  `{t:'accept', window: RECEIVE_WINDOW}` (16 MiB) and `{t:'credit', bytes}` in `CREDIT_STEP` (1 MiB)
  steps as its sink TAKES the bytes (written, or dropped as padding); the sender's `Credit` gate spends
  the window on every byte it puts on the wire, filler included. Backward compatible both ways: an
  older sender strips `window` (zod) and drops `credit` (unknown control); an older receiver grants no
  window and the sender runs unthrottled. Tests: `transfer/fileTransfer.flow.test.ts`.
- **Hand-off and "Save file" (owner's decision, option A).** On the OPFS and RAM paths a finished
  receive is returned to the controller (`ReceiveEvent` `done` with a `Handoff`; the stream and dialog
  paths have nothing to hand off), which starts the download at once — unless the
  page is HIDDEN (`document.visibilityState`), because iOS drops a download a hidden page starts (the
  F1 rehearsal lost a whole file silently). Then it holds the file (`pendingSave`, on disk on the OPFS
  path) and `transfer.saveNeeded` shows **Save file** on the finished row (and in the connection-lost
  screen's file box); the tap — a real gesture — hands it over (`saveReceived`). "New transfer"
  (`resetTransfer`) and session end discard a file nobody saved. Tests: `transfer/opfs.test.ts` (in-memory
  OPFS + Web Locks: removal, hold, sweep), `fileTransfer.test.ts` (`planReceive` order, the probe, the
  one cap, the refusal text), `SessionController.handoff.test.ts` (visible / hidden / Save file / New
  transfer / dispose); e2e `tests/e2e/receive-disk.spec.ts` (Chromium: straight into Downloads — the
  download starts at Accept, bytes intact, nothing in site storage — and a download cancelled in the
  browser stops the transfer and tells the sender; site storage, forced with the DEV-only
  `?noStream=1`: no dialog, bytes intact; hidden page → Save file) and `connection-lost.spec.ts` (a
  started stream download must end FAILED) / `mobile.spec.ts`, which run on the real path.
- **Safari's own download question (2026-10-11, owner's decision).** Once the download is handed over,
  Safari asks before it saves — on iOS before every download, on macOS once per site until it is
  allowed (both measured: COMPATIBILITY.md). Until it is answered the file is not saved, while the
  screen already says "Received". On Safari the finished receive row therefore says to answer it
  (`download-prompt-hint`, shown once the hand-off happened — at once, or after the Save file tap);
  `ui/platform.ts` `downloadPromptFor` decides from the UA (`platform.test.ts`; e2e `mobile.spec.ts`
  under the iPhone profile; visual scene `transfer-received-ios`). Other browsers save without asking
  and show nothing.
- **Screen Wake Lock while a transfer is in flight (2026-10-03, owner's choice "option c").** iOS Safari
  tears the WebRTC connection down the moment the screen locks (TESTPLAN F1 on the iPhone 15: an 800 MB
  receive died at 14 %, both sides "Connection lost" within 17 s), and a phone left alone while a file
  arrives locks by its own idle timer. `src/ui/wakeLock.ts` (`createTransferWakeLock`, environment
  injected; `browserWakeLockEnv` for the app) holds `navigator.wakeLock.request('screen')` while
  `transferInFlight(phase)` (`offered` / `transferring`) and the page is visible, re-requests it when the
  page comes back into view (the browser releases it on hide), gives it back on done / cancel / fail, and
  treats a missing API or a refused request as nothing (no store field, no UI change — the live sentinel
  never leaves the lock object). ONE shared instance (`transferWakeLock()`): `App.tsx`
  `WakeLockDuringTransfer` says WHEN it is wanted from `transfer.phase`, and the Accept / Send handlers in
  `TransferScreen` call `poke()` synchronously inside the tap — **iOS Safari grants the lock only with user
  activation** (measured 2026-10-03: requested from the phase-change effect alone it was refused silently
  and the screen locked at 30 s; the gesture that starts the transfer is the one moment we have it). It
  prevents ONLY the idle-timer lock; a deliberate lock, an app switch or a closed tab still end the
  session, so `TransferScreen` adds the line `keepScreenOn` (testid `transfer-keep-on`) during
  `transferring` on coarse-pointer devices only (`platform.onCoarsePointer`) — desktops sleeping do not
  drop the connection. Unit: `wakeLock.test.ts`. Verified on the iPhone 15 (2026-10-03, TESTPLAN F1): a 3 GiB receive with
  Auto-Lock at 30 s ran to Delivered with the phone untouched; the first build, which asked from the effect
  alone, was refused and the screen locked. An app switch still ends the connection within ~15 s (measured).
- **The sender reads the file in windows, never through `File.stream()` (2026-10-03).** WebKit's Blob
  stream hands the WHOLE file over as ONE chunk (measured on Safari 26.6: a 1 GiB File → a single 1 GiB
  read, WebContent +130 MiB even on a blob of shared parts), which is why a 5 GiB send from Safari grew the
  process to ~940 MiB (TESTPLAN B10) and would kill a tab on a phone; Chrome and Firefox chunk finely.
  `readInWindows(blob)` (`fileTransfer.ts`) pulls `blob.slice(off, off + READ_WINDOW).arrayBuffer()` one
  window at a time (`READ_WINDOW` = 4 MiB = 16 wire chunks), for single files AND for every zip entry
  (client-zip is given `{ input: readInWindows(f), name, lastModified, size }` instead of the File, or it
  would call `file.stream()` itself). `Rechunker.pull` is zero-copy when the head window covers the
  request (it returns a VIEW — callers never mutate pieces) and copies only to coalesce. Memory on the
  send side is thus one window + the wire's high-water mark, on every engine. Unit:
  `fileTransfer.test.ts` ("reading the file for the wire"). Measured on real Safari 26.6 (2026-10-03): a real 2 GiB file from the owner's own Safari to Chrome in
  40.5 s (53 MB/s), SHA-256 equal, WebContent memory spiking and falling back within seconds, never growing
  with the file — [ux-fixes.md](../history/ux-fixes.md) § UX bugs has the numbers and the two stand-caused ICE failures on a swap-bound Mac.
- **"Finishing" — the 100 % that is not the end (2026-10-03, owner's choice "option 1").** Once every
  declared byte has crossed, the sender still pushes the volume padding (Max privacy, up to 12.5 % of
  the file — 512 MiB at 2^32 + 1 B, ~137 s at the Pixel 5's 3.9 MB/s, TESTPLAN B10) and then waits for
  `received`; the receiver drops that padding and closes its sink. No progress is emitted for any of it
  by design, so the bar sat at 100 % looking dead. `TransferScreen` now derives
  `finishing = transferring && transferredBytes >= totalBytes` (no core or protocol change): the title
  becomes "Finishing" and a `role=status` line (`transfer-finishing`) says why — in Max privacy
  "Hiding the file's size — a little extra data goes out / arrives after the file", otherwise
  "Waiting for the other side to confirm…" / "Saving the file." The padding ceiling (option 2) was NOT
  taken: the bucket ladder is unchanged. Visual/a11y scene `transfer-finishing`.
- **"Delivered" means the receiver confirmed (2026-09-27).** The receiver sends `{t:'received'}` after
  saving every DECLARED byte (an `eof` short of the declared size is an error + `cancel`); the sender's
  `done` waits for it (`confirming` phase, flipped BEFORE the eof send so a confirmation that overtakes a
  drain wait still counts). Before, "Delivered" fired once `eof` was in the send buffer. Control
  messages: `offer-file` / `accept` / `reject` / `eof` / `received` / `cancel` (fileTransfer.ts header).
- **Liveness after connect (2026-09-27 — TESTPLAN F2 / F3).** Until then nothing after `established`
  reacted to a dead channel: `onChannelClose` had no branch for it, `onIceFailed` returned early, and a
  sender blocked in `PeerConnection.waitForDrain` waited for a `bufferedamountlow` a closed channel never
  fires — so both screens kept saying "Secure channel open" / "Sending 46 %" to a peer that was gone.
  Now every loss signal (`onChannelClose` with `why`, `onIceFailed`, the backstop below) reaches
  **`SessionController.onConnectionLost`** (one-shot): it fails the in-flight transfer FIRST
  (`ActiveSend.fail` / `ActiveReceive.fail` → the row reads `connection lost`; a receive whose `eof`
  already arrived is let finish), marks a pending offer lost, drops the PeerConnection and goes
  `connected → failed` with `connection lost: <signal>` (`CONNECTION_LOST_PREFIX`). The transfer
  projection is **left in the store**: FailedScreen's `lost` variant (`data-variant="lost"`) is the
  title "Connection lost", the last file's outcome (`last-transfer`, `data-outcome`) and the signal as
  the mono line — no eyebrow, no description: they only repeated "lost" and could not honestly say
  WHOSE side dropped (after the owner's 2026-09-27 review: too many blocks, repeats, the app's name in
  the copy). A file delivered a moment before the other tab closed
  still says delivered. `waitForDrain` now REJECTS on the channel's `close` (and on our own
  `close()`, which fires no event), so the pump exits through its own error path.
  - ICE **`disconnected`** is transient — surfaced, not fatal: `PeerConnection.onInterrupted` →
    `connection.interrupted` (a projection, not a state) → TransferScreen's `interrupted` alert line;
    back to `connected` clears it. **`INTERRUPT_GRACE_MS` = 30 s** is a backstop only — the engines get
    to `failed` first (Chrome 154: `disconnected` 6.4 s and `failed` 16.3 s after the peer's renderer
    crashed, e2e 2026-09-27). Ignored before `established` (the pairing deadlines own that stall).
  - **`pagehide` goodbye**: `App.tsx` `PageHideGoodbye` → `closeOnPageHide()` closes the transport on a
    non-persisted `pagehide`. Without it a closed tab left the survivor waiting as long as for a crash
    (as if the tab went without any WebRTC teardown): the sender noticed a closed receiver after **16.5 s** before this,
    **41 ms** after (Chrome 154, e2e; Firefox 31 ms, WebKit 105 ms). The reverse on Chromium — a SENDER
    closing mid-send — still takes ~16 s (see [COMPATIBILITY.md](../../COMPATIBILITY.md) § Platform limits).
  - `acceptIncoming` survives the session ending under an open save picker (Android's picker left
    ~20 s took ICE down with it — BACKLOG): the offer is gone by then, so whatever the picker returns is
    `discard()`ed silently and nothing overwrites the row.
  - Unit: `SessionController.connectionLost.test.ts`, `transfer/fileTransfer.lost.test.ts`. e2e:
    `tests/e2e/connection-lost.spec.ts` (512 MB sparse file, each tab its own context: the receiver
    closes mid-transfer → the sender ends "not delivered"; the sender closes → the receiver ends "not
    received" with no download; Chromium only — the receiver's renderer crashed via CDP `Page.crash` →
    the sender shows `interrupted`, then ends lost). Screens: `visual/scenes.ts` `transfer-interrupted`,
    `failed-lost`, `failed-lost-delivered`, `failed-lost-idle` (axe-checked; screenshot baselines recorded on the deploy host,
    2026-09-27).
