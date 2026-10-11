# Compatibility — browsers, devices, platform limits

Which platform does what, what was verified on it and when, and the limits that belong to the
platform rather than to hushsend. Only the current browser versions are supported
([docs/decisions.md](docs/decisions.md)). How each mechanism works is in
[docs/architecture/](docs/architecture/README.md); the evidence is in [docs/test-runs/](docs/test-runs/README.md).

## Verified on real devices

The real-device pass ([TESTPLAN.md](TESTPLAN.md)) closed on 2026-10-03 with all 47 cases ticked or closed
with a reason.

| Platform | Versions tested | Runs |
|---|---|---|
| macOS — Chrome, Brave | Chrome 154, Brave 154 | [2026-09-26](docs/test-runs/2026-09-26.md), [2026-09-27](docs/test-runs/2026-09-27.md), [2026-09-28](docs/test-runs/2026-09-28.md) |
| macOS — Firefox | 156 | [2026-09-27](docs/test-runs/2026-09-27.md), [2026-09-28](docs/test-runs/2026-09-28.md) |
| macOS — Safari | 26.6 | [2026-09-27](docs/test-runs/2026-09-27.md), [2026-09-28](docs/test-runs/2026-09-28.md) |
| Android — Chrome (Pixel 5, Android 14) | Chrome 152 | [2026-10-02](docs/test-runs/2026-10-02.md) — the LAN, and across networks behind a VPN |
| iOS — Safari (iPhone 15) | iOS 26.6 | [2026-10-03](docs/test-runs/2026-10-03.md) — the LAN, and LTE |

**Not tested:** Windows (no Windows machine — [docs/decisions.md](docs/decisions.md)), Android Firefox
(dropped by the owner as too rare a combination), a real iPad (simulator rehearsals only), Linux
desktop browsers outside Playwright. **Direct connectivity across networks** has not been shown from a
desktop that is NOT on the server's own LAN — open in [BACKLOG.md](BACKLOG.md).

## Where a received file goes

Chosen per offer, before it reaches the screen — the order and the reasons are in
[transfer.md](docs/architecture/transfer.md) § File transfer.

| Platform | Path |
|---|---|
| Desktop Chromium (Chrome, Edge, Brave) | straight into Downloads through the download worker — no copy in site storage, no dialog |
| Firefox, Safari, every mobile browser | the site's private storage (OPFS), then an ordinary download read from it — no dialog |
| Any, when neither can take the file | the save dialog where the browser has one, else memory up to `MAX_BYTES_BLOB`, else refused before accept |

## Platform limits

- **iOS Safari ends the connection when the screen locks or the user switches apps.** A transfer keeps
  the screen awake (Screen Wake Lock, requested inside the Accept / Send tap), which stops only the
  idle-timer lock; a deliberate lock or an app switch still ends the session — within ~15 s, measured
  2026-10-03 ([transfer.md](docs/architecture/transfer.md); [2026-10-03 run](docs/test-runs/2026-10-03.md)).
  The transfer screen tells phone users to keep the screen on.
- **macOS 15 and later: Max privacy on ONE network needs the browser's "Local Network" permission**
  (System Settings → Privacy & Security → Local Network). Without it two devices on the same Wi-Fi
  cannot reach each other directly; the failure screen on a desktop Mac says so
  ([ux-fixes.md](docs/history/ux-fixes.md)).
- **Safari / WebKit hides its private addresses behind mDNS names**, so path attestation can read
  `mismatch` or `unknown` on an honest pair that includes Safari — the reason it stays advisory
  ([privacy-and-ice.md](docs/architecture/privacy-and-ice.md); [BACKLOG.md](BACKLOG.md) § Security — open).
- **Firefox gets no straight-into-Downloads path**: an aborted stream leaves its download in progress
  for good, and a stopped worker completes a truncated file. Re-measure on a new Firefox before
  enabling it ([transfer.md](docs/architecture/transfer.md)).
- **A lost channel ends the session; nothing resumes it.** There is no ICE restart (the signaling
  socket is closed on connect by design) and no transfer resume: the user reconnects and sends again
  ([transfer.md](docs/architecture/transfer.md) § File transfer). Two measured edges — on Chromium a
  SENDER that closes its tab mid-send is noticed only after ~16 s (others: under a second; open in
  [BACKLOG.md](BACKLOG.md)); and on the save-dialog path an aborted receive can leave an EMPTY file where
  the picker pointed (seen on Android 2026-09-27, 0 bytes twice; desktop Chrome not checked). The partial
  data is discarded; the file itself is not deleted, because the picker may have pointed at a file the
  user meant to replace.
- **Testing from the server's own LAN proves nothing about other networks:** there the STUN reply
  names the router's LAN address (the router hairpins), so a home-side peer never advertises its public
  mapping ([BACKLOG.md](BACKLOG.md) § Pre-launch review).
