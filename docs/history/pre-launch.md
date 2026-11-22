# Pre-launch fixes

Work that came out of the 2026-10-03 pre-launch review ([BACKLOG.md](../../README.md#backlog--open-work-only) § Pre-launch review
holds what is still open). Append-only and dated, like the rest of [docs/history/](README.md).

## 2026-10-11 — a stalled 1:1 pairing, a browser without WebRTC, Safari's download question, the VPN advice

The owner decided three open questions the same day ("2 yes, 3 yes, fix the bug too"); the bug was found
while answering the third ([the 2026-10-11 run log](../test-runs/2026-10-11.md): a joiner without WebRTC
left both sides on "Agreeing on keys…" for ~165 s, then both read "Room not found … Check the digits").

- **A 1:1 pairing has a client deadline from its start.** The 120 s deadline of the words / link / QR
  methods armed only once the DataChannel was open, so a peer that never answered the offer left the
  other side waiting for the untrusted server's room TTL. It now arms in `beginPairing` and covers the
  bring-up as well as the confirmation; a stall before the channel ends as "the connection did not come
  up in time". ([methods.md](../../README.md#connection-methods-4) § link / qr method.)
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
  ([transfer.md](../../README.md#file-transfer)). Owner's decision: Safari only, other browsers unchanged.
- **The network-exposure advice names a VPN, not Tor** (owner: Tor users are not the audience —
  [decisions.md](../../README.md#decisions)). The same in THREATMODEL.md.

## 2026-11-22 — Max privacy across networks: the carrier NAT measured

The open question of the review — why Max ↔ Max never connected across networks — is answered for the
owner's networks ([2026-11-22 run](../test-runs/2026-11-22.md)). The two earlier explanations are gone:
on 2026-10-03 the desktop sat on the server's LAN and advertised the router's LAN address as its
`srflx` (a STUN request to the TURN listener, hairpinned), and since 2026-10-10 the bundle asks the
STUN-only server, which returned the public mapping from the same LAN (2026-10-11); the servers left
that LAN for a VPS on 2026-10-17.

- **The carrier's NAT is symmetric.** One local socket reached the server's two ports from two
  different source ports on both phones; the home router used one. A phone there cannot be reached on
  the port STUN reports.
- **No IPv6 on that carrier**, so the IPv6 listener the STUN server got that day changes nothing for
  these pairs.
- **Port prediction was tried and rejected** — it connected once in a prototype; the owner's decision
  is in [Decisions](../../README.md#decisions).
- Left open in [Backlog](../../README.md#backlog--open-work-only): the pairs not tried, and the
  "retry with relay" on the failure screen.

## 2026-11-22 — "no logs" checked end to end

The review asked what the box writes about a visitor and for how long. Checked on the live host:

- **nginx.** Every location of the TLS vhost had `access_log off`; the port-80 redirect block did not,
  so a first visit over plain HTTP left a line (address, time, user agent) in the shared access log for
  14 days. `access_log off` is in that block now — on the host and in `deploy/nginx.conf.example` — and
  a request there no longer appears while one to a neighbouring site does. The shared `error.log`
  (14 days) still names the client address of a failed request; in the last 2000 lines none was this
  vhost's. Left in [Backlog](../../README.md#backlog--open-work-only).
- **The signaling service** logs its start-up configuration line and nothing per connection (three
  `console` calls in the file; 21 journal lines in 7 days, all start / stop).
- **coturn**, relay and STUN: Docker log driver `none`, `log-file=/dev/null`.
- **ufw** logs blocked packets with the source address for four weeks; a client's packets go to open
  ports and are not logged. **fail2ban** reads the nginx access log, where this vhost writes nothing,
  and keeps its own log of bans for four weeks.
- Not auditable from the box: what the hosting provider records about traffic to it.
