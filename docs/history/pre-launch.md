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

## 2026-11-22 — the network check: Max privacy says up front when this network cannot do it

A phone on the carrier measured above waited 18–48 s for a failure the browser could have predicted.
Since this day a Max-privacy pairing asks, as it starts, whether its own network keeps one mapping
for two destinations ([README § Network check](../../README.md#network-check-srccorenatcheckts--can-max-privacy-work-from-this-network)).

- **Checked in three engines before it was built on** — against two local STUN servers that answer one
  socket with two ports, since a symmetric NAT cannot be had on demand. Chromium 158, WebKit 27.2 and
  Firefox 159 all report two `srflx` candidates on one foundation then, and one when the answers agree.
- **The first rule was wrong, and WebKit showed it.** "Two `srflx` on one foundation ⇒ symmetric" read
  an honest pair of servers as symmetric: WebKit gathers again on fresh sockets when several
  connections start in one page (three sockets, three mappings, one foundation). The rule that
  shipped counts mappings against the connection's UDP sockets.
- **Shown only when it has something to say:** a warning on the invite / waiting screens, and the
  reason on the direct-failure screen. `direct` and `unknown` are silent.
- **What it costs in privacy:** a Max-privacy client now sends STUN at the START of a pairing, and one
  Binding request to the relay host's STUN port — [README § Risk 3](../../README.md#risk-3-stun-is-the-same-operator).
- **Safari in the iOS Simulator reads `symmetric` on an honest network**: it sends to each STUN
  destination from its own local port. Safari on macOS does not. A real iPhone was not at hand that
  day; the 2026-11-23 entry below has it — one socket, as on macOS.
- **Not verified:** the carrier itself, and a real iPhone. Test plan case C7 is the owner's to run.

## 2026-11-22 — "Retry with relay", and what the Reliable side of a mixed pair is told

The second half of the backlog item on Max privacy across networks
([README § Max-privacy strict model](../../README.md#max-privacy-strict-model-done--completes-6d)).

- **The direct-failure screen has "Retry with relay".** One tap ends the failed Max-privacy session
  and starts over in Reliable: the side that made the invite gets a new one, a reconnect is tried
  again, a joiner lands on the home screen with Reliable selected. Nothing of the failed session is
  reused, so Max privacy still never relays.
- **The tap stores nothing.** Reliable holds for the visit; a reload is back on the stored mode. Max
  privacy is the default, and one bad network is not a decision to relay everywhere.
- **The copy names the half one tap cannot do:** the peer has to be in Reliable too — a mixed pair
  does not relay.
- **The Reliable side of a mixed pair** no longer reads "channel closed during pairing": with a relay
  in hand and ICE failing before any channel it reads "No path worked, not even through the relay … if
  your peer is in Max privacy, ask them to switch to Reliable too."
- **Not verified on real networks** — both were driven by simulated ICE failures; test plan case C8.

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

## 2026-11-23 — the carrier-NAT measurement holds on an iPhone

The 2026-11-22 measurement assumed a browser asks STUN and TURN from one socket, with Chrome as the
control; the phones were iPhones. Safari in the iOS Simulator asks each STUN server from its own port,
which would have explained the phones' two ports without any NAT. Checked on the home line, whose NAT
keeps the port: Safari on an iPhone (27.2) and on macOS (26.5.2) use one socket for three servers, the
Simulator (26.5) one per server ([2026-11-23 run](../test-runs/2026-11-23.md)). The verdict stands; the
Simulator is noted in the [test plan](../../README.md#test-plan--the-real-device-pass-step-6e) as unfit
for anything about a NAT.

## 2026-11-23 — "Retry with relay" continues the same pairing

The owner passed C8 on the carrier and remarked that after "Retry with relay" the code had to be
scanned again. Decided the same day: the retry continues the pairing that was started — for every
method, not only link and QR ([README § Decisions](../../README.md#decisions),
[§ Max-privacy strict model](../../README.md#max-privacy-strict-model-done--completes-6d)). The rule
changed from "Max privacy never relays a session" to "never unless both users ask for it in that
session".

- **Both tap.** Each side's own tap is its consent; the frame that tells the peer "I tapped" comes
  through the untrusted server and can only put a line on the peer's failure screen.
- **They meet at a new rendezvous, derived from the failed attempt's two DTLS fingerprints** — not in
  the old room. A room on the server lives 3 minutes, and continuing on the old socket would have
  fallen back to "scan again" whenever the two people were slower than that. A reconnect meets there
  too: at its own rendezvous the first side to tap paired with the other's failed socket — found by
  the unit test, before any browser.
- **The retried channel is authenticated in full**: the link secret again, the CPace key of the
  failed attempt (no second CPace — that would be a second guess at the words), a SAS from scratch,
  the pin under fresh challenges.
- **Tapped first, a side waits** (150 s as built; 120 s after the review below), then offers "Start
  over" — the behaviour of the day before.
- **A limit the invariant "strict until both tapped" ran into:** a side learns that its peer came
  only from the server. A server that fakes it makes a side that already tapped ask for TURN
  credentials and gather relay candidates for a pairing that then fails its check; a side that did
  not tap cannot be moved.
- **Changed along the way:** in Reliable, "no path even through the relay" is now terminal for a
  words creator as well (it used to count as a wrong guess and return to the words), and that screen
  offers "Try again", which continues the pairing like the Max side's button.
- **Not verified:** real networks (test plan C9, C10); the NAT suite's case was written on a Mac and
  has not run; the screenshot baselines of the six new screens are to be recorded on the deploy host.

### Reviewed the same day — what an independent read found, and what changed

Nothing in it let anyone relay a byte, authenticate or get a second guess at the words; the retry
itself broke in two cases, and a failed session still listened to the server.

- **Words: the retry died once the word room expired** (3 minutes after the words were made): the
  room's teardown ran on a session that had already failed and took the CPace key. A failed session
  now ignores the server altogether, bar the peer's "I tapped" notice.
- **Room: the retry room could expire in the middle of the comparison** (150 s of waiting inside a
  180 s room). The wait is 120 s, and from the open channel on a closed socket no longer ends a
  pairing on any method — it had no job left there.
- **A forged `busy` and `pair-request` restarted a failed room pairing** with nobody tapping, in
  Reliable with a relay configured. Closed with the same rule; a pick by another lobby member is
  answered `busy`.
- **Smaller:** a retry that found no path left its socket in the room and its secret in memory; the
  "peer has tapped" line outlived the peer it was about; a second tap during the retry started over;
  a socket closed by the server mid-pairing failed the screen but left the connection alive.
- **Tests said more than they checked** in nine places; each now asserts what its name says, and
  every finding has its case ([README § Max-privacy strict model](../../README.md#max-privacy-strict-model-done--completes-6d), Tests).

## 2026-11-23 — one certificate per description

The authentication of every method is bound to the peer's DTLS fingerprint, read from its
description. A description can carry several fingerprint lines; Firefox accepts a certificate under
any of them, and the code read the first. For two Firefox browsers that was a way in for the server
that relays the descriptions ([security-audits.md](security-audits.md),
[README § Crypto](../../README.md#crypto)).

- **Fixed:** a description that does not name exactly one certificate is refused before the browser
  engine sees it; a connection takes one description and no later one can replace its fingerprint;
  when the channel opens, the certificate DTLS accepted is compared with the one that was named.
- **What the user sees** when it fires: the existing "compromised" failure screen. No screen changed.
- **Measured** in Chromium, Firefox and WebKit; the attack itself was not carried out
  ([2026-11-23 run](../test-runs/2026-11-23.md)).
- **Left:** the same measurement in Safari on a Mac and on an iPhone, and in Firefox on Android — the
  rule does not depend on the answer, since a description with two lines is refused everywhere.

