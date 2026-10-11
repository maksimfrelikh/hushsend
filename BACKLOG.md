# hushsend — backlog (open work only)

What is still to do or deliberately deferred — nothing else. When an item lands, move it in the same pass
to the history file of its topic ([docs/history/](docs/history/README.md)); when the owner decides not to
do something, it goes to [docs/decisions.md](docs/decisions.md). Known limitations that are not
scheduled are in [COMPATIBILITY.md](COMPATIBILITY.md) (platforms) and [THREATMODEL.md](THREATMODEL.md) (security).

## Pre-launch review — 2026-10-03, with the owner's decisions

A review made after the device pass closed: what to check, fix or polish before the launch, and what
the owner decided on each. Not repeated here: the independent audit, other languages and verifiable
delivery (THREATMODEL.md § The road to "yes"); path attestation and the STUN operator (§ Security — open).

**Finding that changes Phase C (measured 2026-10-03).** Every cross-network Max-privacy run (C1, the
Max side of C3) had the desktop on the server's own LAN, and there the STUN reply is the ROUTER's LAN
address: Chrome on the Mac at 192.168.1.38 gathered `srflx 192.168.1.1` from
`stun:turn.hushsend.frelikh.dev:3478`. The home side never advertised its public mapping, so those
failures say nothing about users elsewhere — **direct connectivity across networks is untested.**
TESTPLAN C1 carries the caveat and the way to test it.

**Re-measured 2026-10-11 against the LIVE bundle's STUN** (`stun:stun.hushsend.frelikh.dev:3479`, in the
bundle since `bf15fd6`, 2026-10-10). From 192.168.1.19 on the same Wi-Fi, ONE UDP socket, a STUN binding
request to four destinations: `:3479`, `stun.cloudflare.com:3478` and `stun.l.google.com:19302` all
mapped **94.46.199.61:55497** — the public IP, the local port preserved, the mapping endpoint-independent.
Only the TURN listener `:3478` (what the 2026-10-03 measurement used) answers `192.168.1.1`; both coturn
templates set `external-ip`, so why the two listeners differ is unexplained. So since 2026-10-10 the home
LAN DOES advertise a usable public mapping and the caveat above no longer explains a failure. The owner's
run that day — phone on cellular ↔ laptop on the home Wi-Fi, Max ↔ Max — still did not connect; no
candidate pairs were captured ([the 2026-10-11 run log](docs/test-runs/2026-10-11.md)). What is left is
the phone side: a symmetric carrier NAT is reachable through STUN alone only if the other side filters
by address at most, and the probe measured the home router's MAPPING, not its filtering. No IPv6 at home
(the STUN host has no AAAA either), so there is no NAT-free path to fall back on.

**Agreed — to do:**
- Settle Max privacy across networks: the home side's srflx is public since 2026-10-10 (above), so
  capture the candidate pairs of a phone-on-cellular ↔ home-Wi-Fi pair (chrome://webrtc-internals on
  the laptop, the phone's STUN mapping) — the open question is the carrier NAT. Then decide on
  a one-tap "retry with relay" on the direct-fail screen and copy for the Reliable side of a mixed pair
  ("ask your peer to switch to Reliable too"); today it reads "channel closed during pairing".
- Relay capacity: coturn's 49160–49200 range is ~41 allocations (a fully relayed pair takes two).
  Widen it (and the router forwarding), add a total cap (`bps-capacity`) and monitoring. No VPS for now.
- Rate limits vs carrier NAT — to think through: `IP_RL_MAX` (60 create/join per minute per IP) and the
  per-IP connection cap hit many mobile users behind one carrier IP; IPv6 is not grouped by /64. What
  the limit protects is JOIN-scanning of the 4-digit rooms and the word rendezvous (10 000 codes /
  1 296 words); a token join (link, QR, reconnect) cannot be enumerated.
- A large SEND from a phone: 2–4 GB from the iPhone, picked from Files AND from Photos (compare size
  and hash with the original — the Photos picker may hand over a prepared copy of a video), and from
  Android. The windowed reader was measured on Safari on the Mac only.
- Re-run C6 on real LTE with the Mac on `chrome-pubif` (the iPhone side by the owner).
- "No logs" end to end: nginx's error.log (client IPs), journald of the signaling service, fail2ban,
  the router — what is written and for how long. (coturn — the TURN relay and the STUN server — writes
  none since 2026-10-10: both templates set `log-file=/dev/null`, both installers check it.)
- Chromium: a closed SENDER tab is noticed by the receiver only after ~16 s (others < 1 s) — find why.
- Path attestation: an honest Mac ↔ iPhone pair on one Wi-Fi reads "route did not match". Candidate
  rule: a PRIVATE selected remote address that the peer did not attest (WebKit hides its private
  addresses behind mDNS) → `unknown`, not `mismatch`; a remote server cannot sit at a private address.
- Transfer screen: speed and time left, in whole minutes, "less than a minute" at the end.
- QR scanner that throws on every frame looks alive (ScanScreen's `catch {}`): after N consecutive
  errors show "scanner unavailable — paste the link"; plus an e2e through Chromium's fake camera (y4m).
- Units: the RAM cap is 200 MB = 200 000 000 bytes, and sizes are shown in decimal MB / GB (today MiB
  values carry an "MB" label: the cap was 209 715 200 B, a 250 000 000 B file read "238 MB").
- `/.well-known/security.txt` — the owner fills it in before the release (today that path is answered
  by the app's HTML with a 200).

**Waiting for the owner's decision:** the Android save dialog past the site quota (a dialog left open
~10–20 s killed the connection on the emulator and left a 0-byte file — keep it, replace it with a
refusal, or warn before it); a line warning about the browser's own download prompts (Safari on macOS
"allow downloads from this site", iOS "Download?", Brave holding the download — the site-storage copy
waits 10 minutes for the answer); the in-app advice "use Tor or a VPN on BOTH sides" (Tor users are not
the audience, and Tor Browser restricts WebRTC) and an up-front "WebRTC is disabled in this browser"
message — today `new RTCPeerConnection` runs unguarded.

**Ideas to think about (owner, 2026-10-03; not planned):** resume after a drop (look at what the code
allows — the receiver already writes to site storage), a persistent QR / link "inbox" without storage, a
"no traces" source mode, folders, a personal AirDrop between one's own devices.

## Security — open

- [ ] **Path attestation over the authenticated channel — BUILT, but ADVISORY ONLY (2026-09-12).**
  The mechanism is in the tree and working; what is NOT done is making it a control, and the blocker
  is measured rather than guessed. **It fails on honest Safari.** With the gate in place (`mismatch`
  → teardown, bytes gated) an `interop · firefox → webkit` pair on ONE LAN failed reproducibly with
  no attacker present: WebKit cannot disable mDNS obfuscation, so it offers only `<uuid>.local` host
  candidates, its peer learns the real address peer-reflexively, and WebKit therefore cannot attest
  to the address it was reached on. Removing the gate: 9/9 interop and 96/96 engine tests pass. Since
  that is exactly what real Safari/iOS does, failing closed there would break honest transfers on a
  primary target platform — worse than the leak it closes.
  **Enforcement was RE-TESTED after the "wait for ICE to select a pair" fix and still fails.** The
  first removal happened before that fix, so the obvious theory was that the failure had been a race.
  It is not: with the gate back on, `interop · firefox → webkit` failed **intermittently — one run in
  two**, while advisory mode passed 3/3. Intermittent is worse than consistent here: a spurious
  "someone is in between" destroys an honest transfer at a random moment AND teaches the user to
  dismiss the one warning that matters. Root cause is structural, not a race: a peer behind NAT does
  not reliably know the address its peer reaches it on (mDNS host candidates, peer-reflexive
  learning), so "the address I selected is not one you named" is not by itself evidence of an
  attacker. **Do not flip this on from a loopback run.**
  **Also note what enforcement would NOT buy even if it were stable:** the srflx address a peer
  attests to comes from the STUN server's reply. In the current deployment STUN and signaling are the
  SAME host, so one operator can both inject a candidate and tell the peer to attest the attacker's
  address — the check passes. Enforcement is only worth something once STUN is not the signaling
  operator (ideally 2+ independent STUN servers cross-checked, so a single lying one is caught).
  **Next step, and the reason the verdict is now projected:** the real-device pass should record
  `path-verdict` / `path-selected` / `path-peer-addrs` on each engine, which is the input needed to
  choose between (a) inverting the check — each side attests the address it SELECTED, and the peer
  checks that against its OWN local addresses, so the side that must know the address is the side
  that does know it; (b) gating only when both sides report a usable set; or (c) leaving it advisory.
  Details of what IS built below.
- ℹ️ **What was built (the mechanism).** A hostile server can put
  itself ON THE PATH in Max privacy and no candidate filter can stop it: ICE credentials ride the SDP
  it relays, so it can answer connectivity checks, and a client cannot tell an attacker's `typ host`
  from the peer's — the peer's real address is only ever learned FROM the server. Confidentiality was
  never affected (DTLS is end-to-end; a forwarding attacker sees ciphertext), but the Max-privacy PATH
  promise was not verifiable. **Built:** `src/core/pathAttest.ts` (pure) +
  `SessionController.startPathAttestation` / `onPathAttest` / `verifyPath` / `failPath`. On
  `established` each side sends `{kind:'path-attest', addrs}` over the AUTHENTICATED DataChannel and
  checks that the remote address ICE actually selected (`PeerConnection.selectedRemoteAddress`, via
  `getStats()`) is one the peer named. In principle a forwarding attacker's two moves are both
  visible: pass the real addresses through → `mismatch`; drop the frame → nothing arrives within
  15 s. Today both outcomes are RECORDED, not enforced — see the blocker above. `unknown` (an engine
  that cannot enumerate candidates, or no selected pair yet) is benign by design, which is precisely
  why `tests/e2e/privacy.spec.ts` asserts a real same-engine pair reaches `ok` on chromium, firefox
  AND webkit: `unknown` everywhere would make a broken implementation indistinguishable from a
  working one. The verdict is polled until ICE has actually selected a pair (the attestation frame
  can beat the selection — measured on firefox↔webkit). **Residual, stated plainly:** the comparison is address-only (honest
  NATs vary the port, so comparing ports would reject working connections), and it rests on the peer's
  own view of its addresses, which for srflx comes from STUN — the same operator. An operator that
  both lies over STUN *and* sits on the path can still make the two sides agree; removing that means
  not being the STUN provider. Unit: `pathAttest.test.ts`. (See [privacy-and-ice.md](docs/architecture/privacy-and-ice.md) § Path attestation.)

- [ ] **STUN under a different operator** *(post-release — owner, 2026-09-18)*. The attestation above is
  defeated by one adversary holding signaling AND STUN, so this is the precondition for it ever becoming
  a control. Since 2026-10-10 clients take STUN from [hushsend-stun-server](https://github.com/maksimfrelikh/hushsend-stun-server)
  (`stun:stun.hushsend.frelikh.dev:3479`: `stun-only`, no relay, no logs) — but it runs on the same box
  and under the same operator as signaling, which buys no separation of control yet (THREATMODEL § 3).
  The property starts to exist only when STUN runs under a DIFFERENT party — ideally several
  independent servers, cross-checked by the client (built: [security-audits.md](docs/history/security-audits.md)).

## Deferred

- **return-to-lobby (general)** *(deferred)* — after a FINISHED or aborted 1:1 session (transfer done,
  SAS mismatch, peer left), return to the lobby to pick another peer without re-joining. Only the
  narrow busy-bounce return is built (pre-connection); a post-`connected` return needs channel/transfer
  teardown + a fresh SAS state and is not wired.

- **keystore GC / pin-merge** *(deferred)* — if one side loses its keystore and the pair re-pairs, the other
  side keeps the dead pin next to the new one (two pins for one human). The recent-devices list dedupes for
  display only (`recentDevices.ts`); collapsing the redundant pins in the keystore itself is not done.

- **coturn `turns:` (TURN over TLS on :5349)** *(deferred — agreed at deploy 2026-06-20)*. Reliable mode
  offers `turn:` on 3478 only, so a strict network that allows nothing but outbound 443/TLS cannot reach
  the relay. The relay's config lives in hush-signaling-server `deploy/turn/` since 2026-10-03 (rendered
  into `/etc/turnserver.conf` by its installer since 2026-10-10): `turns:` needs a certificate for
  `turn.hushsend.frelikh.dev` configured there (`cert` / `pkey`, readable by the `turnserver` user),
  `5349/tcp` open in ufw and forwarded by the router, and the `turns:` URI appended to the signaling
  `TURN_URLS`. No client change — the client uses whatever URIs the signaling server hands out.

- **Russian copy — DEFERRED (owner, 2026-09-26; reaffirmed 2026-10-03: English only until the release, other
  languages after it).** English only for now. `i18n.ts` keeps an optional
  `ru` column with an `en` fallback (`translate`), new strings are added with `en` only, and the header
  shows no language switch (`prefs.tsx` still holds `lang` / `setLang`). When the Russian copy is
  written: fill the `ru` column for every key (the redesign added `modeMax` / `modeReliable` and their
  descriptions, `aboutMaxBoth`, `aboutReconnect*`, `mLinkQr*`, `shareTitle`, `scan*`, the transfer
  container labels, the failure kickers…), add `@fontsource-variable/onest` (the Cyrillic companion
  `theme-mono.css` names) to `main.tsx`, and bring the switch back in `TopBar` on the kit's
  `lang-switch.css` (`aria-pressed` on the active button).

- **stark-ui-kit componentization — DEFERRED by the owner (2026-09-26).** hushsend and frelikh now
  share `controls.css`, `theme-toggle.css` and `layout.css`, so the kit's two-consumer rule is met for
  the pill / toggle / layout primitives — the remaining app-local candidates and where each lives in
  `src/ui/app.css`: the pill GEOMETRY layered on `.pill` (`.hs-pill`, `--primary`, `--sm`, `--block`,
  the disabled state, the wash fill); the text input / code input with the on-edge focus ring
  (`.hs-input`, `.hs-input--code`); the word field + listbox (`.hs-field*`, `.hs-listbox`,
  `.hs-option`); the disclosure row (`.hs-disc*`) and the collapsible `<details>` item (`.hs-fold*`);
  the notice / alert line (`.hs-alert`); also the tertiary label (`.hs-tlink`), the 44px icon button
  (`.hs-iconbtn`), the method / peer row (`.hs-row*`) and the `--fg`-at-4 %/9 % wash (`--hs-wash` —
  a kit `--wash` token would let hosts stop re-deriving it). Domain pieces (the hero code, the
  phrase, the phrase cards, the transfer container, the viewport inversion) stay app-local. **Not to
  be done until the owner asks**; when it is, follow the kit's `CLAUDE.md` (additive, one stylesheet
  per component, bump both consumers, frelikh `verify` + `visual`, regenerate the Stark system).

- **Scheduled CI expires on a quiet repo.** GitHub disables `schedule:` workflows after 60 days with
  no commits, which would silently stop the nightly engine matrix — the only thing that exercises
  firefox/webkit/interop, since that job is skipped on push. The rule applies here: the repository is
  PUBLIC (anonymous `git ls-remote` works, checked 2026-09-29), and GitHub's 60-day auto-disable is a
  public-repository rule: **the nightly stops 60 days after the last commit** (on 2026-10-11 that meant
  around 2026-12-10). Re-enable it (or run the matrix from the Actions tab) before any release.

- **TESTPLAN.md's case entries still carry their results.** Most cases end in an annotation of what each
  run found (dates, devices, numbers, rewordings) — the same facts as [docs/test-runs/](docs/test-runs/README.md).
  The 2026-10-11 restructuring moved the run logs out but left these, so the two can drift. Reduce each
  case to its procedure, its expectation and a one-line dated status that links the run file.
- **Two documentation checks are not built yet** (part of the 2026-10-03 plan): status words only with a
  date, and documented numbers against the code's constants (`docs/test-setup.md` § 0.3 lists dozens). The
  design files in docs/architecture/ came over from CLAUDE.md with their "(this pass)" / "— done (step 6)"
  markers; date or drop them first, then add both checks to `scripts/check-docs.mjs`.
