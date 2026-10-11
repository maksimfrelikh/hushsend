# Real-device test runs

The procedure and the cases (A1 … F8) are in [TESTPLAN.md](../../TESTPLAN.md). This folder is the record of
what was run: one file per day, the entries in the order they ran. It is append-only — a run is not
rewritten afterwards; a later run that changes a verdict gets its own entry.

## How to record a run

Record per case: `ID · track (T1/T2/T3) · device pair · browser versions · PASS/FAIL · notes`. The
track belongs in the line because the same case can be run two ways: a T1 desktop rehearsal of A1
proves the mechanism, a T2 run on the named MBP↔iPhone pairing is what closes it, and a log that does
not say which produced the tick cannot tell them apart later. For a failure capture:
the selected candidate pair (webrtc-internals / about:webrtc), the WS message trace, the console
output, and whether it reproduced on the other engine.

## Runs

| Date | Entries |
|---|---|
| [2026-09-26](2026-09-26.md) | T1 rehearsal · Brave 154 (Chromium 154, macOS), two tabs of ONE profile |
| [2026-09-27](2026-09-27.md) | T1 on all three REAL desktop engines · Brave 154 ↔ Claude Chromium 152 ↔ Safari 26.6 ↔ Firefox 156<br>T1 + size ladder to 5 GiB + first iOS-Simulator rehearsal · Chrome 154 ↔ Safari 26.6 ↔ Firefox 156 ↔ iPhone 17 simulator (iOS 27.0)<br>iPhone + iPad simulators, Android emulator, B1/E4/E7 on desktop · Chrome 154 ↔ iPhone 17 sim (iOS 27.0) ↔ iPad (A16) sim (iPadOS 27.0) ↔ Pixel 9 Pro emulator (Android 17, Chrome 149)<br>the connection-lost fix, deployed · F3 on the live build · Chrome 154 ↔ Chrome 154 |
| [2026-09-28](2026-09-28.md) | the owner's decisions, deployed · A4b and B1 on the live build, Chrome incognito · Chrome 154 ↔ Chrome 154<br>the no-copy rule's engineering · a probe page and the LOCAL build · Chrome 154 ↔ Firefox 156 ↔ Safari 26.6 (the Mac)<br>the stream path and the ladders on the live build · Chrome 154 ↔ Firefox 156 ↔ Safari 26.6 (the Mac)<br>the owner's eviction rule on the live build · Chrome 154 → Firefox 156 (the Mac) |
| [2026-10-02](2026-10-02.md) | the FIRST real handset · Chrome 154 (the Mac, Playwright) ↔ **Pixel 5** (Android 14, Chrome 152) over USB — Phase A on the LAN, Phase C over a VPN Wi-Fi |
| [2026-10-03](2026-10-03.md) | the FIRST real iPhone · Chrome 154 (the Mac) ↔ **iPhone 15** (iOS 26.6, Safari 26.6) over USB — Phase A/B/E on the LAN, Phase C on LTE |

## How the pass progressed

The status snapshots TESTPLAN.md carried in its header while the pass ran, kept for the record. Each was
true on its date; the current status is the one line at the top of TESTPLAN.md.

This used to open "the last open item before the security audit" — the audit has since run twice
internally (2026-09-12 and 2026-09-13, [security-audits.md](../history/security-audits.md) § Security audit), so that ordering is gone: the
device pass was the last open item before a public launch, not before the audit — and **it is DONE:
47 of 47 cases ticked or closed with a reason on 2026-10-03** (§ Result log, the 2026-10-02 Pixel 5 and
2026-10-03 iPhone 15 entries). The rest of this paragraph is the 2026-09-28 snapshot, kept for the
record: **21 of the 47 A–F cases were closed (A4a, A4b, A6, A7, B1, B7, B9, D1–D5, E1–E5, F3, F5–F7 — see § Result log:
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
plan has 47 checkbox cases.) The ticks in [test setup](../test-setup.md) § 0.1 are PRECONDITIONS, not cases; do not read them as
progress.

> **2026-09-28: the owner's seven decisions are LIVE** — deployed by the owner at 04:32 UTC (frontend
> `90fdc15`, whose app code is `673509d`'s: the receiver's confirmation, the A4b stop, the forget
> confirmation, no device label, the disk-first receive path, "Save file", the failure screens, the
> relayed verdict; then signaling `3d96125`), verified the same hour — [test setup](../test-setup.md) § 0.1 re-ticked. Cases whose
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
> path — [ux-fixes.md](../history/ux-fixes.md) § UX bugs, first item; live since 19:58 UTC as `153addd`, [test setup](../test-setup.md) § 0.1 re-ticked). **F3 passes
> on the live build** (fourth 2026-09-27 entry). F2 stays unticked until re-run on a real phone.
> Expected: "Connection interrupted" within ~6 s of the cut, then the "Connection lost" screen when the
> engine gives up (Chrome ~16 s). The same change closes the transport on `pagehide`: in **F1**, if the
> session ends the instant the phone locks or switches apps (rather than when the network gives up),
> suspect that and write it down.
