# Pre-launch fixes

Work that came out of the 2026-10-03 pre-launch review ([BACKLOG.md](../../BACKLOG.md) § Pre-launch review
holds what is still open). Append-only and dated, like the rest of [docs/history/](README.md).

## 2026-10-11 — a stalled 1:1 pairing, a browser without WebRTC, Safari's download question, the VPN advice

The owner decided three open questions the same day ("2 yes, 3 yes, fix the bug too"); the bug was found
while answering the third ([the 2026-10-11 run log](../test-runs/2026-10-11.md): a joiner without WebRTC
left both sides on "Agreeing on keys…" for ~165 s, then both read "Room not found … Check the digits").

- **A 1:1 pairing has a client deadline from its start.** The 120 s deadline of the words / link / QR
  methods armed only once the DataChannel was open, so a peer that never answered the offer left the
  other side waiting for the untrusted server's room TTL. It now arms in `beginPairing` and covers the
  bring-up as well as the confirmation; a stall before the channel ends as "the connection did not come
  up in time". ([methods.md](../architecture/methods.md) § link / qr method.)
- **A PeerConnection that cannot be brought up fails the pairing visibly.** `startPeer` was called with
  `void`, so a throw inside it was an unhandled rejection with nothing on screen; every bring-up now goes
  through `launchPeer`, and a failure ends the pairing through the method's own teardown.
  `SessionController.pairingDeadline.test.ts` — all six cases fail against the previous controller.
- **A browser without WebRTC is told so before anything starts.** `core/webrtc/available.ts` is asked
  once; without WebRTC the app shows "This browser can't send files" instead of the home screen, and a
  link opened there is scrubbed but not followed. e2e `link.spec.ts`; visual scene `no-webrtc`.
- **A room answer on a link or words pairing no longer says "Check the digits".** The failure screen's
  gone / expired / full copy names the method: "This link expired or was already used", "These words
  don't work any more"; the 4-digit room keeps its own. Visual scene `failed-link-gone`.
- **Safari's download question is announced.** On Safari the finished receive row says to answer it —
  iOS asks before every download, macOS once per site — because until then the file is not saved
  ([transfer.md](../architecture/transfer.md)). Owner's decision: Safari only, other browsers unchanged.
- **The network-exposure advice names a VPN, not Tor** (owner: Tor users are not the audience —
  [decisions.md](../decisions.md)). The same in THREATMODEL.md.
