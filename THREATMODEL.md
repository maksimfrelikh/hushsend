# hushsend — threat model, and whether it is ready for at-risk users

## Start here

If you are a new session and the question is **"is Max privacy finished — can independent
journalists and activists in authoritarian states rely on this?"**, the answer is:

> **Not yet.** The cryptography is in good shape and was hardened substantially on 2026-09-12. What
> is not finished is everything *around* it — and for this particular audience the unfinished parts
> are the ones that matter most. The single biggest gap is not in the protocol at all: **the server
> that the threat model declares untrusted is the same server that delivers the JavaScript.**

Read this file, then `BACKLOG.md` § Security audit for the live list. `CLAUDE.md` § Path attestation
and § Crypto carry the mechanisms. Do not answer the readiness question from `README.md` alone — it
is written for a general audience, not for someone whose safety depends on the details.

**Do not trust this file over the code.** Claims below were verified on 2026-09-12 and re-verified
against the LIVE HOST and the SERVED bundle on 2026-09-13; the repo rule is that docs which drift are
bugs. If you are about to rely on something here, re-check it — the audits that produced this document
found three complete breaks in claims that had been written down confidently, and the 2026-09-13 pass
found three more (F1/F2/F4, all fixed — `BACKLOG.md` § Third pass) plus one unlisted exposure (F3,
below). The pattern is stable enough to plan around: **the breaks are where the prose is most
confident**, and twice now the false sentence was inside the code's own comments.

One thing that pass established is worth carrying forward, because it changes the cost of item 1
below: **the production build is byte-for-byte reproducible.** A fresh `vite build` with the deploy
script's environment reproduced all eight files of the served tree exactly, JS included. The hard half
of "verifiable delivery" already works; what is missing is only publishing hashes from somewhere the
app server cannot silently change.

---

## The model

**The signaling server is a fully malicious active attacker.** It may forge, drop, reorder and replay
any frame, join as a peer itself, and present the two peers different realities. It is also — in the
current deployment — the same host that serves the app and answers STUN.

**The two humans trust each other** and neither endpoint is compromised. If a journalist's or a
source's own device is compromised, nothing here helps, and no file-transfer tool can.

**The rendezvous is not hidden.** That two parties met is visible to the server by construction; this
is not something the architecture attempts to conceal.

---

## What IS protected (verified 2026-09-12)

- **File contents, against a fully malicious server.** DTLS is end-to-end between the two real
  browsers, and the SAS / CPace / link-secret key confirmation is MAC'd over the negotiated DTLS
  fingerprints. A server that terminates DTLS to get in the middle presents different fingerprints on
  each leg and the check fails before a byte moves. A server that merely forwards sees ciphertext.
- **No file bytes before authentication**, both directions, enforced in the core rather than the UI.
- **The signaling socket closes the moment a pair authenticates**, for every method including
  reconnect. A server that stays off the path therefore learns no session duration.
- **Max privacy never requests a TURN relay**, and unsolicited TURN credentials are inert. Verified
  2026-09-13 against the SERVED bundle, not the source: the ICE-server builder pushes the TURN entry
  only when `mode === "reliable"`.
- **Max privacy opens a channel only on a path it positively established is direct** (since
  2026-09-13). The channel-open gate used to treat "ICE has not published a selection yet" as "no
  relay" and open anyway — finding F1, see `BACKLOG.md` § Third pass. It now polls for a judgement and
  refuses anything still undetermined at the deadline, down the same terminal path as a relay.
- **A detected interposer is now visible to the user** (since 2026-09-13). It was not: the three-way
  attestation verdict was projected two-way, so `mismatch` rendered exactly like the everyday "this
  browser cannot tell" state, under copy blaming the browser — finding F2. It is still ADVISORY (see
  below); what changed is that the detection now has somewhere to appear.
- **CPace is a faithful implementation** — byte-exact against the published CFRG draft-21 vectors.
  One online guess per session against ~41 bits, capped at 10 attempts.
- **No third-party network contact at all.** The app makes zero HTTP requests: no analytics, no error
  reporter, no CDN, no fonts. The QR decoder's WASM is genuinely self-hosted (hash-verified).
- **Three complete MITM breaks were found and fixed on 2026-09-12**: SAS certificate grinding
  (reproduced in 4.25 s), server-chosen pairing roles, and a re-entrant `welcome` that turned key
  confirmation into a tag-reflection oracle. Each has a regression test that fails against the old
  code.

---

## What is NOT protected — ranked by danger to this audience

### 1. Code delivery — the dominant risk, and it is not a bug to fix

nginx on one host serves the SPA **and** proxies the signaling WebSocket on the same origin. An
operator under legal compulsion does not need to break CPace, SAS or DTLS: they serve a modified
bundle — to one IP, if they like — and every other guarantee on this page becomes theatre. CSP does
not help (the same server emits the header), SRI does not help (the same server would publish the
hash), and CSP does not govern WebRTC at all, so a hostile bundle can exfiltrate over an
`RTCPeerConnection` outside any policy.

**Status: partly addressed since 2026-09-13 — the detection half exists, the prevention half does
not.** The build is reproducible and CI enforces that; an independent machine publishes and signs the
expected hashes; `deploy/verify-bundle.sh` checks a live deployment against them from any network.
A compelled operator can therefore no longer change the delivered client *silently*. They can still
change it — and a browser that has already loaded the modified bundle has already lost, so this helps
a watchdog, not the person being targeted at that moment. Prevention needs a client the server does
not deliver at all: a browser extension, a desktop build, or an independent mirror. Until one of those
exists the honest statement is unchanged in substance — hushsend protects against a *compromised or
curious relay*, and against a *compelled publisher* only to the extent that somebody is looking.

Moving the frontend to a CDN in a friendlier jurisdiction lowers the probability of compulsion but
**adds** a party that can tamper, and still gives the user no way to detect it.

### 2. Path interposition — the server can see volume and duration

A malicious signaling server can put itself on the network path in Max privacy. ICE credentials ride
the SDP it relays, so it can answer connectivity checks itself and inject its own `typ host`
candidate; the relay filter only refuses `typ relay`, and a client cannot tell an attacker's host
candidate from the peer's because the peer's real address is only ever learned *from the server*.
Contents stay unreadable. **Byte volume, exact session duration and per-file timing do not.**

**Status: detection built, SHOWN, not enforced.** `core/pathAttest.ts` has the two peers attest, over
the authenticated channel, to the addresses they can be reached at. Since 2026-09-13 a `mismatch` is
displayed as its own state with its own copy (finding F2 — before that it was indistinguishable from
"this browser cannot tell", which is what Safari always reports). It still gates no bytes. Enforcing it was tried twice and
withdrawn both times: it fails on honest Firefox↔Safari pairs — intermittently, one run in two —
because WebKit cannot disable mDNS obfuscation and so cannot name the address it was reached on. An
occasional false "someone is in between" destroys a transfer at random and teaches the user to
dismiss the warning that matters.

Two things must land before this can become a control: a **real-device pass** measuring the
false-positive rate on real networks (`TESTPLAN.md` § Phase B collects exactly this), and **STUN run
by a different party** — see below.

### 3. STUN is the same operator

Path attestation has a dependency: a peer behind NAT learns its own public address from the STUN
server's reply. An adversary holding **both** signaling and STUN can inject a candidate *and* tell
the peer to attest that same address, and the check passes. Today both are the same host.

**Status: started.** The deployment lives in
[`hushsend-stun-server`](https://github.com/maksimfrelikh/hushsend-stun-server) — not wired in yet,
and during development all three services share one machine, which buys nothing. The strong form is
**several independent STUN servers cross-checked by the client**, because it requires trusting no
single operator; `VITE_STUN_URLS` is already a list, the comparison is not written.

### 3b. That you used hushsend at all is visible to your network (new, 2026-09-13)

There is no Encrypted Client Hello on this deployment, so the TLS handshake carries
`hushsend.frelikh.dev` in **cleartext SNI** on every visit. An ISP or a state-level observer therefore
learns "this person opened a privacy file-transfer tool" from **one side alone**, with no cooperation
from anyone and without decrypting anything. For this audience that fact is frequently the one that
is actually acted on — it is upstream of §4, which needs the transfer to happen at all.

It is also one name and one IP, so it is trivially blockable, and the subdomain is public in
Certificate Transparency logs. Note that the app, the signaling WebSocket and STUN/TURN all resolve to
the **same address** (verified 2026-09-13: `hushsend.frelikh.dev` and `turn.hushsend.frelikh.dev` both
→ 94.46.199.61), so that single name covers every service.

**Status: SAID OUT LOUD 2026-09-13; the exposure itself is open.** The landing screen now carries a
collapsed "What your network can still see" disclosure (`NetworkExposure`, testid
`network-exposure`) stating this and § 4 in both languages, with the one action that helps — Tor or a
VPN, on **both** sides. Collapsed on purpose: these are permanent properties of a direct transfer, not
events, and a standing banner would be dismissed within a day and would train people to ignore the
badges that DO report events.

That changes what users are told, not what the network sees. Removing the exposure needs an onion
service, a mirror on a domain that is not obviously this tool, or ECH — none of which exist here.

### 4. The social graph, to the network

This one is inherent and often the most dangerous for this audience. Direct P2P means the two peers'
IPs connect **directly**: the journalist's ISP sees a connection to the source's address, and the
source's ISP sees the reverse. Establishing that two people communicated needs data from **one** side
only, with no cooperation from the other. Content can be denied; a connection record cannot.

Note the trade: Max privacy protects content from the relay operator at the cost of making the link
between the two people visible to the network. **Volume is padded since 2026-09-17** — the byte count
lands on a bucket edge rather than naming the file (`core/transfer/padding.ts`) — but duration, the
fact of a transfer, and how many there were are all still visible.

**Status: not addressable inside the app.** The honest mitigation is Tor or a VPN on both sides, and
users for whom this matters should be told so plainly rather than reassured.

### 5. No independent audit, and the device pass has not started

Two internal audits have run. The second one — modelling an actively malicious server rather than a
lying one — found three complete breaks in a system the first pass had already reviewed. That is the
argument for an external audit, not against it: the failure mode here is confident documentation, and
it has already happened twice.

`TESTPLAN.md` holds 45 cases, of which 2 are ticked — and those two are deployment preconditions
verified on the server, not device tests. **No testing on a real device has happened at all.** Safari
and iOS behaviour — the file-save
fallbacks, QR scanning, camera permissions, cross-network TURN, and the attestation verdict per
engine — is essentially unverified outside a headless Linux box.

### 6. Smaller, tracked

`pairingId` is disclosed to whoever wins a reconnect join race (linkability, not an auth break); the
identity key falls back to a raw seed in IndexedDB on engines without WebCrypto Ed25519 (older
Safari/Firefox); the path check runs once at channel-open and is not re-run on mid-session
re-nomination. All in `BACKLOG.md`.

---

## What can honestly be told to users today

> Nobody — including us — can read your files. Our server cannot decrypt them and does not store
> them. After the connection is established our signaling server disconnects and learns neither the
> duration nor the size of the transfer.
>
> **But:** if our server is compromised or we are compelled, it can place itself on the network path
> and observe the size and duration of a transfer — not its contents — and we cannot yet reliably
> detect that. It also delivers the app itself, so a compelled operator could serve you a modified
> version. And your internet provider can see that you connected directly to your correspondent.
>
> If those matter to you, use Tor or a VPN on both sides.

Do not promise "nothing can be tracked". It is not true today, and for this audience an overstated
guarantee is worse than an honest limitation: people calibrate their behaviour to what they are told.

---

## The road to "yes", in order

0. **Done 2026-09-13** — F1 (the strict gate no longer opens on an unverified path), F2 (a detected
   interposer is no longer displayed as an ordinary Safari) and F4 (comments claiming controls that do
   not exist). Hours of work, listed first because they were bugs rather than roadmap.
1. **Verifiable delivery** — **FIRST STEP BUILT 2026-09-13; the rest is open.**
   *Built:* CI now builds the bundle on a GitHub runner (a machine the site operator does not own),
   **fails if the build stops being byte-for-byte reproducible**, publishes a SHA-256 manifest in the
   public run summary and attaches a signed provenance attestation to a public transparency log.
   `deploy/verify-bundle.sh --attest` checks a live deployment against those signatures from anywhere
   **with no account and nothing obtained from the operator** — verified end to end against
   production on 2026-09-13, all eight served files signed, from a named commit, which also
   demonstrates the build reproduces across machines. The deploy script records the hashes it
   published.
   *What that does and does not buy:* it does NOT help a browser that has already been served a
   hostile bundle, and selective tampering aimed at one IP is caught only by someone checking from
   that vantage point. It removes **"silently"**: the delivered client can no longer be changed
   without the change being detectable by anyone who looks.
   *Still open:* nobody checks on a schedule from an unrelated network; there is no independent
   mirror; and there is no pre-delivered client (extension or desktop build) — which is the only form
   that protects the person at the moment they load the page. Those remain the real answer, and each
   of them needs the reference hash that now exists.
2. **STUN under a different party**, ideally several cross-checked in the client. Precondition for
   path attestation ever becoming a control. Nothing exists until the services actually run on
   separate machines under separate operators: today all three resolve to one IP.
2b. ✅ **Done 2026-09-13 — the SNI exposure (§3b) and the direct-connection exposure (§4) are now
   stated in the interface**, not only in this file, with the Tor/VPN-on-both-sides advice. Cheapest
   honesty available, and it was missing: the privacy toggle only ever said the PEER sees your IP,
   which is a far smaller claim than either of these.
3. **The real-device pass** — `TESTPLAN.md`, all 43 cases, with the attestation verdict recorded per
   engine pair.
4. **Path attestation as a control**, decided from that data rather than from a loopback run.
5. **An independent security audit.**
6. ✅ **Done 2026-09-17 — volume padding.** Was listed as optional; it is now on in Max privacy.
   Transfers are padded to a bucket edge, so the byte count an observer reads names a RANGE rather
   than the file: powers of two below 1 MiB, then ≤12.5% overhead above it. It does NOT hide
   duration, that a transfer happened, or how many there were — see `core/transfer/padding.ts` for
   the ladder and the full list of what it does not buy.
