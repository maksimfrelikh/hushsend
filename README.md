# hushsend

Privacy-first peer-to-peer file transfer in the browser. Files move **directly between two
browsers** over WebRTC/DTLS — by default never through a server — and the pairing is authenticated by
the two humans, not by an account.

**Live:** [hushsend.frelikh.dev](https://hushsend.frelikh.dev) · no sign-up, no upload, nothing to install.

This file is the project's only living document. For a visitor: the sections down to
[Run it](#run-it). For anyone relying on it for their safety: [Threat model](#threat-model--and-whether-it-is-ready-for-at-risk-users).
Reference: [Compatibility](#compatibility--browsers-devices-platform-limits) ·
[Architecture](#architecture) · [Deploy](#deploy--the-frontend-and-nginx) ·
[Test plan](#test-plan--the-real-device-pass-step-6e) · [Backlog](#backlog--open-work-only) ·
[Decisions](#decisions) · [About this document](#about-this-document).

## The threat model in one paragraph

The signaling server is **untrusted**. It does rendezvous only: it relays opaque SDP/ICE between two
browsers and never sees a file byte, a secret word, or a link secret. Two limits stated up front,
because they bound everything below. First, **the app is delivered by the same origin** that runs the
signaling server: an operator who tampers with the bundle defeats any protocol, so "untrusted server"
means untrusted *as a relay*, not untrusted as a publisher — a pre-delivered client (extension,
desktop build, verified reproducible bundle) is what would close that. Second, a hostile server can
put itself on the network **path**; it still reads nothing, but it learns who talks to whom. Confidentiality and
authenticity are established **client-side** — a PAKE (CPace) or a short authentication string
compared by the two humans, MAC'd over the negotiated **DTLS fingerprints** (channel binding), with
TOFU key pinning for later reconnects. A server that lies, a relay that re-terminates DTLS, or a
network attacker in the middle all produce a mismatch and a hard stop **before any byte flows** —
file transfer is gated on an authenticated `connected` state.

What the server can still observe: that two IPs rendezvoused, and how long the *pairing* took — each
peer closes its own signaling socket the moment the authenticated connection is up, so the session
duration is not the server's to know, for every method including reconnect. The residual risks are in
§ What is NOT protected and the platform limits in § Platform limits; nothing is swept under the rug.

## Four ways to pair

| Method | Rendezvous | Authentication | Good for |
|---|---|---|---|
| **Link** | 128-bit token in the URL | key-confirmation over the link secret (in the URL **fragment** — never sent to the server) | sending to someone you can message |
| **QR** | the same link, as a QR code | same | phone ↔ laptop, in person |
| **Words** | one public word from the EFF short list | **CPace PAKE** over 4 secret words (~41 bits), ≤10 attempts | reading a phrase aloud, over a call |
| **Room** | 4-digit code → a **mesh lobby** (up to 8 peers, pick who to pair with) | **SAS** — asymmetric pick-from-3: one side reads its phrase, the other picks blind | a room of people, any pair including joiner↔joiner |

Paired once, two devices can **reconnect with no human step and no code**: tap *Reconnect* on both,
in either order, and they meet at a rendezvous derived from the pairing secret they share. Each then
proves it holds that secret before showing any identity key, and proves possession of the pinned
Ed25519 identity key, channel-bound to the fresh DTLS fingerprints. To the server a reconnect is
indistinguishable from a first link meeting. A key that changed under a known pairing is an SSH-style
hard stop, never a dismissable toast.

Several files picked at once travel as **one uncompressed zip, `hushsend-files.zip`**, so the receiver
accepts one offer and sees one progress bar. A received file goes to disk, not memory — straight into
Downloads on desktop Chromium, through the site's private storage elsewhere
(§ Where a received file goes). A file no path can take is refused before anything is sent.

## Privacy modes

- **Max privacy (default)** — direct only. Your own STUN, never a relay; the peer learns your IP,
  nothing else carries your traffic. If a direct path cannot come up, the connection **fails** rather
  than quietly relaying; the failure screen offers "Retry with relay" — when both people tap it, the
  pairing they started continues through the relay for that visit, with nothing scanned or typed
  again. Transfers are **padded** so the byte count on the wire shows a
  range rather than the exact file (≤12.5% extra above 1 MiB; see `core/transfer/padding.ts` for what
  that does and does not hide — duration and the fact of a transfer are still visible).
- **Reliable** — adds a TURN relay (short-lived HMAC credentials minted per session; the shared
  secret never leaves the server) so a pair behind hostile NATs still connects.

On a Mac (macOS 15 and later), Max privacy between two devices on the SAME network needs the
browser's Local Network permission — § Platform limits.

Some networks — mobile data, many VPNs — cannot take a direct connection at all. When a pairing starts
in Max privacy, hushsend checks its own side and says so before the wait instead of after it
(§ Network check).

> **Honest caveat — what Max privacy does and does not promise.** Nothing on the path can read your
> files, and a relay is refused — but a hostile signaling server can put itself on the path and learn
> who is talking to whom, and the check that would expose it is advisory, not enforced. Why, and what
> would change that: § Risk 2.

## Verifying what you were served

The server that this threat model calls **untrusted** is also the server that hands you the
JavaScript. That is the largest open risk in the product (§ Risk 1) and neither CSP nor SRI touches
it, because the same server emits both.

What exists today is a second opinion about what the bytes should be. Every push runs the CI job
*reproducible build · publish + attest hashes*: it builds the bundle on a GitHub runner — a machine the
site operator does not control — refuses to pass unless two builds of the commit are byte-identical,
publishes the SHA-256 of every file in the public run summary, and signs a provenance attestation into
a public transparency log. The reproducibility is load-bearing: without it, "the live site does not
match CI" would be the ordinary outcome and nobody would investigate a real one.

So anyone can check the live deployment against an independent build — **with no account, no token
and nothing to obtain from us** — from ANY machine, ideally not the web host and ideally from more than
one network:

```bash
# asks GitHub's PUBLIC attestation API whether the bytes you were served carry a signed provenance statement
bash deploy/verify-bundle.sh --attest

# pin to a specific CI run's manifest instead
bash deploy/verify-bundle.sh --manifest <manifest from the CI run for the deployed commit>

# or, with no manifest, just print what the live site is serving
bash deploy/verify-bundle.sh
```

`--attest` takes the bytes you were actually served and checks each one. Verified against production on
2026-09-13: all eight files, signed, from a named commit — which also demonstrated the reproducibility:
the operator built those bytes on their own machine and a GitHub runner independently produced the same
ones. It discovers the files from `index.html`, which does not name the lazily-fetched QR decoder
`.wasm` (its path lives inside the JS); combine the two flags to cover the whole tree:
`--attest --manifest MANIFEST.sha256`. It spends one request of GitHub's anonymous API per file — 60 an
hour per public IP, shared by every machine behind it; when they run out the files read `?` (not
checked) and the exit status is 2, never the ✗ and 1 of a real mismatch (until 2026-10-10 a spent limit
printed ✗ for every file).

`deploy/deploy-frontend.sh` writes the hashes it published to `MANIFEST.sha256` in the repo root —
**outside `dist/`** on purpose: a file inside the published tree that CI does not build would make the
deployed tree differ from the attested one, manufacturing the very mismatch this is meant to detect.

**Read the limits before relying on it** — they are in the header of
[`deploy/verify-bundle.sh`](deploy/verify-bundle.sh), and they matter:

- It does nothing for a browser that has **already** been served a hostile bundle. Checking afterwards
  from the same machine is shutting the door behind you.
- A bundle can be served selectively, to one IP. That is caught only by someone checking **from that
  vantage point** — an argument for several people checking from several networks, not for checking
  once.
- It verifies that the bytes match a build of a given commit. It says nothing about whether that
  commit is honest; for that, read the source.
- Run on the web host itself it is nearly worthless — the suspect checking itself.

What it removes is *silently*. An operator can no longer change the delivered client without the
change being detectable by anyone who looks — and it is the precondition for the stronger answers
(an extension or desktop build shipped through a store, or an independent mirror), none of which can
be verified without a reference hash.

## Status

**Feature-complete and deployed.** All four methods, the codeless reconnect, the mesh lobby, TURN,
light/dark, the designed screen set (English only for now; the RU table is kept, the switch
hidden), and the deployment are built and live. **507 vitest tests** (the client; the signaling
server's 28 run in its own repository) and a
Playwright e2e suite — **69 cases per engine: 68 run on chromium, 64 on firefox, 63 on webkit** (2026-11-23) (the
silent-peer case needs CDP, and the two straight-into-Downloads cases apply only where the stream path
does — desktop Chromium; the two site-storage cases skip on Playwright's WebKit, whose storage cannot
write; plus 2 opt-in cases everywhere, the size ladder and the two-STUN cross-check), plus a 4-case
phone profile and 5 cross-engine pairs — cover the protocol paths; the axe
gate (`npm run test:a11y`, 152 checks) and the screenshot gate (`npm run visual`, 207 checks — on the
deploy host, whose renders the baselines are) cover the screens. The counts were re-run 2026-11-23
on the owner's Mac, on the Vite 8 / Vitest 5 / Playwright 1.65 toolchain, with the one-fingerprint
rule, the in-place "Retry with relay" and the fixes of its two reviews in (vitest 507 of 507; e2e 204
passed, 12 skipped, none failed; axe 152 of 152). The screenshot gate ran the same day on the deploy
host: 207 of 207 with the rule and the first review's fixes in, the 12 baselines of the retry's six
scenes recorded there; the second review's fixes touch no screen.
Refresh them here whenever the suite grows.

A second internal audit on **2026-09-12**, modelling a fully malicious signaling server rather than a
passive one, found and fixed three complete MITM breaks plus a pre-authentication enrollment hole; every
pass and what it found is in [docs/history/security-audits.md](docs/history/security-audits.md). The
real-device pass closed on 2026-10-03 (§ Verified on real devices).

**Before anyone whose safety depends on it relies on this**, read § Threat model: what still has to
happen, in order, is § The road to "yes" — above all an independent audit, STUN under a different
operator (the precondition for path attestation becoming a control), and verifiable delivery beyond
the first step described above.

## Run it

```bash
npm install
npm run dev        # vite dev server
npm run typecheck  # tsc --noEmit — TypeScript 7 (native); see the note below
npx vitest run     # unit tests (the signaling server's own tests run in its repository)
npm run test:e2e   # playwright (drives two real browser tabs through a live DataChannel)
npm run build      # typecheck + vite build
```

Two TypeScripts are installed on purpose, the layout Microsoft recommends for the 6 → 7
transition: `tsc` comes from `@typescript/native` (an npm alias of `typescript@7`, the native
compiler), while the package named `typescript` is `@typescript/typescript6`, the 6.0
compatibility build, because typescript-eslint needs the programmatic compiler API and TypeScript
7.0 ships none (7.1 brings a new one). Vite strips types itself, so the bundle does not depend on
either. When typescript-eslint supports the 7.1 API, both aliases collapse into `typescript@^7`.

CI runs the cheap checks (typecheck, lint, unit, `npm run docs:check`) on every push and the Chromium
e2e alongside them; the full engine matrix — Firefox, WebKit, the phone profile and the cross-engine
pairs — runs nightly or on demand, because it takes ~12 minutes.
See [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

hushsend runs as three services, each in its own repository with its own tests and runbook:

| Repository | What |
|---|---|
| **hushsend** (this) | the client (the Vite SPA at the root), the nginx vhost, the frontend deploy — § Deploy |
| [hush-signaling-server](https://github.com/maksimfrelikh/hush-signaling-server) | signaling + the TURN relay for Reliable mode; its README is the protocol reference — frames, room types, close codes — and the header of `signaling-server.js` explains the managed rooms |
| [hushsend-stun-server](https://github.com/maksimfrelikh/hushsend-stun-server) | STUN for clients, meant to be run by a different operator |

Client and server share **no code** on purpose — there is no shared types package. A protocol change
lands in both repositories in the same pass (`src/types/protocol.ts` and `src/core/signaling/` here),
the pin below is bumped so the e2e runs against it, and the deploy order goes in the commit message.
The signaling server is a devDependency pinned by commit, so `npm ci` installs it and the e2e suite
runs exactly that version; for local work start it with `node node_modules/hush-signaling-server/signaling-server.js`
(127.0.0.1:8080; `NODE_ENV≠production` allows `http://localhost:5173`).

The build-time values (`VITE_SIGNALING_URL`, `VITE_STUN_URLS`, `VITE_NAT_CHECK_STUN_URL` — Vite bakes them
in, there is no runtime client config) and what each must be for a real deploy: § Build the SPA.

### Before a change is done

- `npm run typecheck && npm run lint && npx vitest run`, and `npm run docs:check` when this file changed;
- the e2e: `npx playwright test`. `reuseExistingServer` means the suite silently attaches to whatever
  already listens on 8080 / 5173 — on a box that also runs a signaling server (laptop-server did until
  the 2026-10-17 move to netcup) run it as `E2E_SIGNALING_PORT=8191 E2E_VITE_PORT=5291 npx playwright test`.
  The engine projects (firefox / webkit / interop / mobile-webkit) also need `E2E_STUN_URLS` with two
  loopback STUN servers — the recipe is in the test plan, case B7 (ports 3480/3481 there, clear of the
  3478 / 3479 a live TURN relay and STUN server take);
- for a UI change also `npm run test:a11y` (axe over every screen state × both themes, plus the
  keyboard contracts) and `npm run visual` (screenshots, tokens, geometry). Both drive the states
  through the DEV-only `window.__hsStore` / `__hsKeystore` hooks — no peer, no server. The screenshot
  baselines are the deploy host's renders: compare there, and re-record (`npm run visual:update`) only
  with a reviewed reason (§ UI). There the gate runs in Playwright's own container image, the tag of
  the `@playwright/test` version in the lockfile, over a copy of the build clone with `npm ci` done —
  `docker run --rm --ipc=host -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.65.0-noble npm run visual`
  — so the renders do not depend on what the host has installed ([2026-11-23 run](docs/test-runs/2026-11-23.md)).

### The NAT suite

The e2e pairs two tabs on loopback, so it never meets a NAT. `tests/nat/` does: two Chromiums run the
BUILT app, each in its own Linux network namespace behind its own NAT router (nftables), with the
signaling server, the app and coturn — STUN and TURN, the image and config template the relay runs in
production, taken from the hush-signaling-server commit pinned in `package.json` — on the lab's public
side, and beside coturn a second STUN port (`tests/nat/tools/stun.ts`), the network check's other
destination. The map is in `tests/nat/net/lib.sh`. Each case first measures what its two routers
really do (`tests/nat/tools/probe.ts`: mapping and filtering); the first four then pair by one-time
link and read the candidate pair ICE selected. Six cases, `tests/nat/nat.spec.ts`:

- **Max ↔ Max, both NATs endpoint-independent** → connects, the selected pair is not a relay, a file
  arrives intact;
- **Max ↔ Max, symmetric ↔ port-restricted** → both sides end on the failure screen with
  `direct-fail-hint` within 60 s (about 15 s on the CI runner, 2026-11-22) — a session that neither
  connects nor fails is a failure of the test;
- **Reliable ↔ Reliable, the same two NATs** → connects, the selected pair is a relay, the client
  shows "relayed through the server", a file arrives intact;
- **control** — that lab with the one rule switched from symmetric back to endpoint-independent →
  connects. Without it a lab where nothing can connect would pass the second case.
- **the network check** (§ Network check) — an invite behind each NAT of the second case, nobody
  joins. Behind the symmetric NAT the Share screen shows `nat-warning`, and the check's connection
  was given two mappings on its router's address by the two STUN ports. Behind the
  endpoint-independent NAT there is no warning, that connection has one mapping, and each port
  answered a connection of its own — what the verdict `direct` is made of; the build is the production
  one, so the verdict itself is not on the screen. First run 2026-11-23 on the CI runner: the warning
  270 ms after the Share screen ([2026-11-23 run](docs/test-runs/2026-11-23.md)).
- **"Retry with relay"** (§ Max-privacy strict model) — the second case, and then both tap. After one
  tap that side waits, the other is told, and neither page holds a connection configured with a
  relay. After the second the SAME pairing connects: on each page the failed connection and the
  retried one, the retried pair a relay, "relayed through the server" on the screen, a file intact,
  and no second link. First run 2026-11-23 on the CI runner: connected 375 ms after the first tap
  ([2026-11-23 run](docs/test-runs/2026-11-23.md)).

It needs Linux, root, docker, nftables and conntrack, so it is not part of the list above:

```bash
sudo env "PATH=$PATH" bash tests/nat/run.sh   # builds dist/ FOR THE LAB, raises it, runs, removes it
```

CI runs it nightly and on demand ([`.github/workflows/nat.yml`](.github/workflows/nat.yml)), not per
push. Run it after a change to ICE, the privacy modes, the network check or the relay credentials, and
after a bump of the hush-signaling-server pin. Its limits: Chromium only, IPv4 only, TURN over UDP
only, and the NAT is Linux netfilter — port-restricted filtering in both rules, no hairpinning, no
second NAT layer.

## About this document

**One fact lives in one place; every other place links to it.** A fact stated twice drifts — the next
reader then hunts for a guard that no longer exists. That is why this README is the only living
document: it describes the CURRENT state and is corrected in the same pass as the change that makes it
wrong. The records are dated and never rewritten:

- [docs/history/](docs/history/README.md) — what landed and when: finished work, the security audits;
- [docs/test-runs/](docs/test-runs/README.md) — the real-device runs, one file per day.

Where a new fact goes, and how it is kept true:

- **A change in behaviour** updates its section under § Architecture in the same pass. Then grep the
  repository for the old claim — code comments and test headers included — and fix every hit.
- **An item that lands** leaves § Backlog for the history file of its topic; a decision not to do
  something goes to § Decisions.
- **Numbers are claims.** Test counts live only in § Status; measured figures carry their date.
  Re-run the thing and refresh the number — never copy one forward. "Today", "now", "live" carry a date
  too.
- **The server side is documented in its repository.** About signaling, the TURN relay or STUN, write
  there and link from here.
- **`npm run docs:check`** (also in CI) fails on a dead link, a `§ Section` pointer to a heading that
  does not exist, a code path quoted here that does not exist, and a record over 500 lines. A bare
  `§ Section` means a heading of this file.

## Threat model — and whether it is ready for at-risk users

### Start here

If you are a new session and the question is **"is Max privacy finished — can independent
journalists and activists in authoritarian states rely on this?"**, the answer is:

> **Not yet.** The cryptography is in good shape and was hardened substantially on 2026-09-12. What
> is not finished is everything *around* it — and for this particular audience the unfinished parts
> are the ones that matter most. The single biggest gap is not in the protocol at all: **the server
> that the threat model declares untrusted is the same server that delivers the JavaScript.**

Read this section, then § Security — open for what is still open and
[docs/history/security-audits.md](docs/history/security-audits.md) for what each audit pass found.
§ Path attestation and § Crypto carry the mechanisms. Do not answer the readiness question from the
visitor sections at the top of this file alone — they are written for a general audience, not for
someone whose safety depends on the details.

**Do not trust this section over the code.** Claims below were verified on 2026-09-12, re-verified
against the LIVE HOST and the SERVED bundle on 2026-09-13, reviewed again on 2026-09-18 (when
volume padding, the STUN cross-check and the `pairingId` blinding landed) and on 2026-09-25 (the
codeless reconnect, which replaced that blinding); the repo rule is that docs
which drift are bugs. If you are about to rely on something here, re-check it — the audits that produced this document
found three complete breaks in claims that had been written down confidently, and the 2026-09-13 pass
found three more (F1/F2/F4, all fixed — [docs/history/security-audits.md](docs/history/security-audits.md), the F-items) plus one unlisted exposure (F3,
below). The pattern is stable enough to plan around: **the breaks are where the prose is most
confident**, and twice now the false sentence was inside the code's own comments.

---

### The model

**The signaling server is a fully malicious active attacker.** It may forge, drop, reorder and replay
any frame, join as a peer itself, and present the two peers different realities. It is also — in the
current deployment — the same host that serves the app and answers STUN.

**The two humans trust each other** and neither endpoint is compromised. If a journalist's or a
source's own device is compromised, nothing here helps, and no file-transfer tool can.

**The rendezvous is not hidden.** That two parties met is visible to the server by construction; this
is not something the architecture attempts to conceal.

---

### What IS protected (verified 2026-09-12)

- **File contents, against a fully malicious server.** DTLS is end-to-end between the two real
  browsers, and the SAS / CPace / link-secret key confirmation is MAC'd over the negotiated DTLS
  fingerprints. A server that terminates DTLS to get in the middle presents different fingerprints on
  each leg and the check fails before a byte moves. A server that merely forwards sees ciphertext.
  The fingerprint that is MAC'd is the one certificate the peer's description names — a description
  naming more than one is refused — and the certificate DTLS accepted is checked against it when the
  channel opens (since 2026-11-23, § Crypto).
- **No file bytes before authentication**, both directions, enforced in the core rather than the UI.
- **The signaling socket closes the moment a pair authenticates**, for every method including
  reconnect. A server that stays off the path therefore learns no session duration.
- **A reconnect looks like a first meeting to the server** (since 2026-09-25). Two paired devices
  meet at a room name derived from their pairing secret — the same 128-bit token shape a link/QR
  meeting uses, taken the same join-or-create way — and prove they belong there with a MAC under that
  secret before either shows its identity key. The server sees a token room like any other: not
  "these two have met before", not which side initiated, and nothing that links one day's token to
  the next (the token changes every 10 minutes). No code is shown or typed on either device.
- **Max privacy never requests a TURN relay**, and unsolicited TURN credentials are inert. Verified
  2026-09-13 against the SERVED bundle, not the source: the ICE-server builder pushes the TURN entry
  only when `mode === "reliable"`.
- **Max privacy opens a channel only on a path it positively established is direct** (since
  2026-09-13). The channel-open gate used to treat "ICE has not published a selection yet" as "no
  relay" and open anyway — finding F1, see [docs/history/security-audits.md](docs/history/security-audits.md). It now polls for a judgement and
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
- **A fourth was found and fixed on 2026-11-23: a description with two fingerprints.** Firefox
  accepts a certificate that matches ANY `a=fingerprint` line of the peer's description and keeps
  them all, and hushsend bound its authentication to the first line of that text. A server between
  two Firefox browsers could have listed each honest fingerprint first and its own second, ended
  both DTLS legs itself, and both sides would have authenticated the honest pair — on every method.
  Its two preconditions were measured; the interposition itself was not carried out
  ([2026-11-23 run](docs/test-runs/2026-11-23.md), [security-audits.md](docs/history/security-audits.md)).
  Chromium and WebKit keep one effective line and were not exposed. The regression tests fail
  against the old code: in Firefox a pair given such a description connected.

---

### What is NOT protected — ranked by danger to this audience

#### Risk 1. Code delivery — the dominant risk, and it is not a bug to fix

nginx on one host serves the SPA **and** proxies the signaling WebSocket on the same origin. An
operator under legal compulsion does not need to break CPace, SAS or DTLS: they serve a modified
bundle — to one IP, if they like — and every other guarantee on this page becomes theatre. CSP does
not help (the same server emits the header), SRI does not help (the same server would publish the
hash), and CSP does not govern WebRTC at all, so a hostile bundle can exfiltrate over an
`RTCPeerConnection` outside any policy.

**Status: partly addressed since 2026-09-13 — the detection half exists, the prevention half does
not.** The build is reproducible and CI enforces that; an independent machine publishes and signs the
expected hashes; `deploy/verify-bundle.sh` checks a live deployment against them from any network
(§ Verifying what you were served). A compelled operator can therefore no longer change the delivered client *silently*. They can still
change it — and a browser that has already loaded the modified bundle has already lost, so this helps
a watchdog, not the person being targeted at that moment. Prevention needs a client the server does
not deliver at all: a browser extension, a desktop build, or an independent mirror. Until one of those
exists the honest statement is unchanged in substance — hushsend protects against a *compromised or
curious relay*, and against a *compelled publisher* only to the extent that somebody is looking.

Moving the frontend to a CDN in a friendlier jurisdiction lowers the probability of compulsion but
**adds** a party that can tamper, and still gives the user no way to detect it.

#### Risk 2. Path interposition — the server can see volume and duration

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

Two things must land before this can become a control. The **false-positive rate on real networks**
must allow it: the real-device pass (closed 2026-10-03) recorded the verdicts, and an honest Mac ↔
iPhone pair on one Wi-Fi read "route did not match" — a candidate rule for private addresses is in
§ Pre-launch review. And **STUN must be run by a different party** — see below.

#### Risk 3. STUN is the same operator

Path attestation has a dependency: a peer behind NAT learns its own public address from the STUN
server's reply. An adversary holding **both** signaling and STUN can inject a candidate *and* tell
the peer to attest that same address, and the check passes. Today both are the same host.

**Status: started.** Since 2026-10-10 clients take STUN from
[`hushsend-stun-server`](https://github.com/maksimfrelikh/hushsend-stun-server)
(`stun:stun.hushsend.frelikh.dev:3479`) — but it runs on the same box as signaling, under the same
operator (§ Live instance), and one operator on one machine buys nothing. The strong form is
**several independent STUN servers cross-checked by the client**, because it requires trusting no
single operator: `VITE_STUN_URLS` is a list and the comparison is built (`core/stunCheck.ts`,
2026-09-17), but it says nothing until two different operators answer.

**New 2026-11-22: a Max-privacy pairing asks STUN at its start, and asks the relay's host too.** The
network check (§ Network check) sends a STUN Binding request to the STUN server and one to the STUN
port of the TURN relay's coturn when a pairing STARTS — an invite made, a code entered, a link opened —
and one more to each when the first two answers agree. Before, a Max-privacy client reached STUN only
once a peer had joined, and never sent the relay's host a packet. The request carries no room, no
token and no identity; no credential is requested, nothing is allocated, nothing is relayed. What the
operator learns is the client's address and the moment, also for an invitation nobody answered —
which signaling sees at that same moment anyway, and today all three are one operator on one address
(§ Risk 3b). It starts to matter with STUN under a different party: that party then hears of every
Max-privacy pairing attempt, not only of the pairs that met. Reliable does not run the check.

The check also TRUSTS the two answers. Whoever runs both servers can make an honest network read
"direct connections will fail here" and so point the user at its own relay — the lever a hostile
signaling server already has by dropping candidates, and with the same bound: the mode never changes
by itself, and a relay carries only what it cannot read (§ Risk 2 for what it does see).

#### Risk 3b. That you used hushsend at all is visible to your network (new, 2026-09-13)

There is no Encrypted Client Hello on this deployment, so the TLS handshake carries
`hushsend.frelikh.dev` in **cleartext SNI** on every visit. An ISP or a state-level observer therefore
learns "this person opened a privacy file-transfer tool" from **one side alone**, with no cooperation
from anyone and without decrypting anything. For this audience that fact is frequently the one that
is actually acted on — it is upstream of § Risk 4, which needs the transfer to happen at all.

It is also one name and one IP, so it is trivially blockable, and the subdomain is public in
Certificate Transparency logs. Note that the app, the signaling WebSocket and STUN/TURN all resolve to
the **same address** (verified 2026-09-13 on the home server; since 2026-10-17 all of them run on
one VPS — § Live instance), so that single name covers every service.

**Status: SAID OUT LOUD 2026-09-13; the exposure itself is open.** The landing screen carries a
collapsed "What your network can still see" item (under "About privacy and security", testid
`network-exposure`) stating this and § Risk 4, with the one action that helps — a VPN, on **both** sides
(English; the Russian copy is kept in the table for later). It said "Tor or a VPN" until 2026-10-11: Tor
users are not the audience (§ Decisions), and whether hushsend runs in Tor Browser at all was
never checked. Collapsed on purpose: these are
permanent properties of a direct transfer, not events, and a standing banner would be dismissed within
a day and would train people to ignore the transfer path rows that DO report events.

That changes what users are told, not what the network sees. Removing the exposure needs an onion
service, a mirror on a domain that is not obviously this tool, or ECH — none of which exist here.

#### Risk 4. The social graph, to the network

This one is inherent and often the most dangerous for this audience. Direct P2P means the two peers'
IPs connect **directly**: the journalist's ISP sees a connection to the source's address, and the
source's ISP sees the reverse. Establishing that two people communicated needs data from **one** side
only, with no cooperation from the other. Content can be denied; a connection record cannot.

Note the trade: Max privacy protects content from the relay operator at the cost of making the link
between the two people visible to the network. **Volume is padded since 2026-09-17** — the byte count
lands on a bucket edge rather than naming the file (`core/transfer/padding.ts`) — but duration, the
fact of a transfer, and how many there were are all still visible.

**Status: not addressable inside the app.** The honest mitigation is a VPN on both sides, and users for
whom this matters should be told so plainly rather than reassured.

#### Risk 5. No independent audit (the device pass is done)

Two internal audits have run. The second one — modelling an actively malicious server rather than a
lying one — found three complete breaks in a system the first pass had already reviewed. That is the
argument for an external audit, not against it: the failure mode here is confident documentation, and
it has already happened twice.

The real-device pass is DONE (corrected 2026-10-03 — this paragraph used to say no device had been
tested at all): the test plan's 47 cases are ticked or closed with a reason, on the devices in
§ Verified on real devices — file-save paths, QR scanning, camera permissions, cross-network TURN over
LTE. What it did NOT settle: what that section lists as not tested, and the attestation verdict, which
is thin.
On one LAN the desktop pairs read `unknown` (mDNS hides the addresses), Chrome ↔ Android Chrome read
`ok` / `unknown`, and Chrome ↔ iOS Safari read a FALSE `mismatch` (WebKit attests only its mDNS
names); no cross-network pair connected directly in Max privacy — in the pass because the desktop sat
on the server's own LAN and advertised the router's LAN address, and since 2026-11-22 for a measured
reason: the phone's carrier NAT is symmetric (§ Platform limits). So road item 4 still lacks its data.

#### Risk 6. Smaller, tracked

The identity key falls back to a raw seed in IndexedDB on engines without WebCrypto Ed25519 (older
Safari/Firefox); the path check runs once at channel-open and is not re-run on mid-session
re-nomination. The mechanisms: § Crypto and § Path attestation.

**New 2026-09-27: a received file is briefly on disk in the site's private storage.** Big files are
now received into the browser's origin-private file system (OPFS) instead of RAM, and handed to the
user as a download read from there. That copy is removed at once when a receive fails, is cancelled or
is never saved, and 10 minutes after the download starts when it is delivered (sooner — from 2 minutes —
when a new big file needs its room); if the tab closes
first it stays until hushsend is next opened, which removes it. Only this site can read that folder,
and it holds the same bytes the user was just handed — but it is a copy on disk that can outlive the
tab, where the old in-memory path left nothing behind. Someone who seizes the device inside that
window finds the file in the browser profile as well as in Downloads. **Since 2026-09-28** desktop
Chromium receives straight into Downloads instead (below) and makes no such copy; Firefox, Safari and
mobile browsers still do — the owner prefers a short-lived copy on disk to holding the file in RAM.

**New 2026-09-28: a service worker exists on the origin while desktop Chromium receives a file.** The
only way to stream a download with no copy and no dialog is a service worker that answers a
navigation with a streaming response, so hushsend registers one — `dl/sw.js` — when a file is offered
and unregisters it a minute after the download (a closed tab's leftover is removed at the next start).
A service worker is code the browser keeps between visits, which is why this one is boxed in: its
scope is `/dl/`, so it can never control or intercept the app's pages or assets; it answers only
`/dl/<random id>` for a stream a same-origin page registered moments before, once; it has no cache,
no storage and no network access of its own. What it changes against § Risk 1 (code delivery): a
compromised server could ship a hostile `sw.js` exactly as it could ship a hostile bundle — same
origin, same delivery, the same manifest and attestation covering it — and the extra it would buy,
persistence past a fix, is bounded by that scope and by the unregistration after every download.

**Closed 2026-09-18, then removed 2026-09-25:** the `pairingId` disclosure that used to sit here. A
code-guesser winning the 4-digit reconnect race was handed a stable per-pair identifier before any
authentication — never an auth break, but a link between two anonymous rendezvous and one
relationship, which for this audience is not the small thing the old wording implied. First the
announcement was blinded; then the 4-digit reconnect room was removed altogether with the code, and
nothing is announced any more (the rendezvous is derived, the hello is a MAC). What the pairingId
now IS: the pairing secret. It lives in the same IndexedDB as the pins and, unlike the identity key,
has no non-extractable protection — an XSS or a hostile extension that can read the pins can read
it, and could then compute the pair's rendezvous and pass the hello. It could still not forge the
proof under the identity key, so the outcome is a hard stop, not a silent impostor; but the wait
screen on the honest side would end in "the other side does not know this pairing" rather than a
clean meeting. Same exposure class as the pins themselves; tracked with them.

---

### What can honestly be told to users today

> Nobody — including us — can read your files. Our server cannot decrypt them and does not store
> them. After the connection is established our signaling server disconnects and learns neither the
> duration nor the size of the transfer.
>
> **But:** if our server is compromised or we are compelled, it can place itself on the network path
> and observe the size and duration of a transfer — not its contents — and we cannot yet reliably
> detect that. It also delivers the app itself, so a compelled operator could serve you a modified
> version. And your internet provider can see that you connected directly to your correspondent.
>
> If those matter to you, use a VPN on both sides.

Do not promise "nothing can be tracked". It is not true today, and for this audience an overstated
guarantee is worse than an honest limitation: people calibrate their behaviour to what they are told.

---

### The road to "yes", in order

0. **Done 2026-09-13** — F1 (the strict gate no longer opens on an unverified path), F2 (a detected
   interposer is no longer displayed as an ordinary Safari) and F4 (comments claiming controls that do
   not exist). Hours of work, listed first because they were bugs rather than roadmap.
1. **Verifiable delivery** — **FIRST STEP BUILT 2026-09-13; the rest is open.**
   *Built:* the byte-for-byte reproducible build, the hashes a GitHub runner publishes and signs, and
   `deploy/verify-bundle.sh --attest` — what each does and does not buy is § Verifying what you were
   served. It removes **"silently"**, nothing more.
   *Still open:* nobody checks on a schedule from an unrelated network; there is no independent
   mirror; and there is no pre-delivered client (extension or desktop build) — which is the only form
   that protects the person at the moment they load the page. Those remain the real answer, and each
   of them needs the reference hash that now exists.
2. **STUN under a different party**, ideally several cross-checked in the client. Precondition for
   path attestation ever becoming a control. Nothing exists until the services actually run on
   separate machines under separate operators: today all three resolve to one IP.
2b. ✅ **Done 2026-09-13 — the SNI exposure (§ Risk 3b) and the direct-connection exposure (§ Risk 4)
   are now stated in the interface**, not only here, with the advice to use a VPN on both sides. Cheapest
   honesty available, and it was missing: the privacy toggle only ever said the PEER sees your IP,
   which is a far smaller claim than either of these.
3. ✅ **Done 2026-10-03 — the real-device pass** — the test plan, 47 of 47 cases ticked or closed
   with a reason. The attestation verdict was recorded on the pairs it met; § Risk 5 says how little
   that settles for item 4.
4. **Path attestation as a control**, decided from that data rather than from a loopback run.
5. **An independent security audit.**
6. ✅ **Done 2026-09-17 — volume padding.** Was listed as optional; it is now on in Max privacy.
   Transfers are padded to a bucket edge, so the byte count an observer reads names a RANGE rather
   than the file: powers of two below 1 MiB, then ≤12.5% overhead above it. It does NOT hide
   duration, that a transfer happened, or how many there were — see `core/transfer/padding.ts` for
   the ladder and the full list of what it does not buy.

## Compatibility — browsers, devices, platform limits

Which platform does what, what was verified on it and when, and the limits that belong to the
platform rather than to hushsend. Only the current browser versions are supported
([Decisions](#decisions)). How each mechanism works is in
[Architecture](#architecture); the evidence is in [docs/test-runs/](docs/test-runs/README.md).

### Verified on real devices

The real-device pass ([Test plan](#test-plan--the-real-device-pass-step-6e)) closed on 2026-10-03 with all 47 cases ticked or closed
with a reason.

| Platform | Versions tested | Runs |
|---|---|---|
| macOS — Chrome, Brave | Chrome 154, Brave 154 | [2026-09-26](docs/test-runs/2026-09-26.md), [2026-09-27](docs/test-runs/2026-09-27.md), [2026-09-28](docs/test-runs/2026-09-28.md) |
| macOS — Firefox | 156 | [2026-09-27](docs/test-runs/2026-09-27.md), [2026-09-28](docs/test-runs/2026-09-28.md) |
| macOS — Safari | 26.6 | [2026-09-27](docs/test-runs/2026-09-27.md), [2026-09-28](docs/test-runs/2026-09-28.md) |
| Android — Chrome (Pixel 5, Android 14) | Chrome 152 | [2026-10-02](docs/test-runs/2026-10-02.md) — the LAN, and across networks behind a VPN |
| iOS — Safari (iPhone 15) | iOS 26.6 | [2026-10-03](docs/test-runs/2026-10-03.md) — the LAN, and LTE |

**Not tested:** Windows (no Windows machine — [Decisions](#decisions)), Android Firefox
(dropped by the owner as too rare a combination), a real iPad (simulator rehearsals only), Linux
desktop browsers outside Playwright. **Max privacy across networks** has connected nowhere yet: the
only pairs tried had a phone on a carrier with a symmetric NAT (§ Platform limits); two ordinary Wi-Fi
networks in different places, another carrier, and a pair with IPv6 on both sides were not tried.

### Where a received file goes

Chosen per offer, before it reaches the screen — the order and the reasons are in
§ File transfer.

| Platform | Path |
|---|---|
| Desktop Chromium (Chrome, Edge, Brave) | straight into Downloads through the download worker — no copy in site storage, no dialog |
| Firefox, Safari, every mobile browser | the site's private storage (OPFS), then an ordinary download read from it — no dialog |
| Any, when neither can take the file | the save dialog where the browser has one, else memory up to `MAX_BYTES_BLOB`, else refused before accept |

### Platform limits

- **iOS Safari ends the connection when the screen locks or the user switches apps.** A transfer keeps
  the screen awake (Screen Wake Lock, requested inside the Accept / Send tap), which stops only the
  idle-timer lock; a deliberate lock or an app switch still ends the session — within ~15 s, measured
  2026-10-03 ([File transfer](#file-transfer); [2026-10-03 run](docs/test-runs/2026-10-03.md)).
  The transfer screen tells phone users to keep the screen on.
- **macOS 15 and later: Max privacy on ONE network needs the browser's "Local Network" permission**
  (System Settings → Privacy & Security → Local Network). Without it two devices on the same Wi-Fi
  cannot reach each other directly; the failure screen on a desktop Mac says so
  ([ux-fixes.md](docs/history/ux-fixes.md)).
- **Safari / WebKit hides its private addresses behind mDNS names**, so path attestation can read
  `mismatch` or `unknown` on an honest pair that includes Safari — the reason it stays advisory
  ([Privacy modes, ICE and path attestation](#privacy-modes-ice-and-path-attestation); § Security — open).
- **Firefox gets no straight-into-Downloads path**: an aborted stream leaves its download in progress
  for good, and a stopped worker completes a truncated file. Re-measure on a new Firefox before
  enabling it ([File transfer](#file-transfer)).
- **A lost channel ends the session; nothing resumes it.** There is no ICE restart (the signaling
  socket is closed on connect by design) and no transfer resume: the user reconnects and sends again
  (§ File transfer). Two measured edges — on Chromium a
  SENDER that closes its tab mid-send is noticed only after ~16 s (others: under a second; open in
  [Backlog](#backlog--open-work-only)); and on the save-dialog path an aborted receive can leave an EMPTY file where
  the picker pointed (seen on Android 2026-09-27, 0 bytes twice; desktop Chrome not checked). The partial
  data is discarded; the file itself is not deleted, because the picker may have pointed at a file the
  user meant to replace.
- **Safari asks before it saves a received file** — on iOS before every download, on macOS once per
  site until it is allowed. Until it is answered the file is not saved, while hushsend already says
  "Received"; since 2026-10-11 the finished row on Safari says to answer it
  ([File transfer](#file-transfer)). Chrome, Firefox and Android Chrome save without asking.
- **A browser with WebRTC switched off cannot send or receive** (some privacy browsers and hardening
  settings do that). Since 2026-10-11 hushsend says so up front instead of starting; before, a joiner
  in such a browser left both sides waiting until the server expired the room
  ([2026-10-11 run](docs/test-runs/2026-10-11.md)). Whether Tor Browser runs hushsend was not checked.
- **Max privacy does not connect from a network behind a symmetric NAT** — one that maps each
  destination to a new port, as mobile carriers and many VPNs do: the peer learns one port from STUN
  and is then reached from another. Measured 2026-11-22 on a mobile carrier (Epic, Cyprus): a phone
  there connected neither to another such phone nor to a computer behind an ordinary home router, and
  the carrier gives no IPv6 to fall back on ([2026-11-22 run](docs/test-runs/2026-11-22.md)). The
  phones were iPhones; that their Safari asks every server from one socket, which the measurement
  rests on, was checked the next day ([2026-11-23 run](docs/test-runs/2026-11-23.md)). STUN
  answers over IPv6 since that day, for a pair that has IPv6 on both sides — not yet seen in use.
  Reliable connects such pairs through the relay. Since 2026-11-22 the app checks its own side when a
  Max-privacy pairing starts and warns before the wait (§ Network check) — seen on that carrier
  2026-11-23, with no warning on the home line (test plan case C7).
- **Playwright's WebKit does not resolve a STUN host name**: against
  `stun:stun.hushsend.frelikh.dev:3479` it gathered no `srflx` candidate, against the same server by
  IP address it did (measured 2026-11-22, WebKit 27.2). Safari does resolve it (the iOS Simulator's
  Safari 26.5 got its answers from the live servers by name that day). So nothing about the live STUN
  can be read off that build by name.

## Architecture

How hushsend works, one subsection per topic. Read § The one rule before touching `src/`.

### The one rule

Every non-serializable, live object — `RTCPeerConnection`, `RTCDataChannel`, `WebSocket`, `CryptoKey` —
lives **only** in the imperative core (`src/core/`, in `SessionController` and its sub-modules). It never
enters the Redux store, and React never holds one. Data flows one way:

```
UI  --(method call)-->  SessionController  --(work + dispatch)-->  store  --(useSelector)-->  UI
```

The store holds serializable projections only (status, peer label, words to display, transfer progress,
error), so RTK's serializability check stays ON. `src/store/connectionSlice.ts` is a **finite state
machine** — one `status` field plus a guarded transition map — which reduces the central invariant to a
status check: **no file bytes flow unless the connection is authenticated** ([Connection](#connection--the-state-machine-the-signaling-socket-early-frames)).

### Where the code is

```
src/
├── core/                       # imperative, framework-agnostic; owns ALL live objects
│   ├── SessionController.ts    # the boundary: UI → methods; core → dispatch
│   ├── signaling/              # WebSocket client — signaling only, every inbound frame zod-validated
│   ├── webrtc/                 # RTCPeerConnection + DataChannel, DTLS fingerprints, backpressure
│   ├── crypto/                 # cpace · sas · keyConfirmation · identity · enrollment · reconnect
│   ├── keystore/               # IndexedDB: own identity key + pinned peer keys (TOFU)
│   ├── words/  link/           # the words credential · the link token + secret
│   ├── transfer/               # chunking, flow control, volume padding, the receive paths
│   ├── iceServers.ts relax.ts stunCheck.ts pathAttest.ts   # privacy mode → ICE; relay filter; STUN cross-check; path check
│   ├── natCheck.ts             # can Max privacy work from this network (advisory)
│   └── pairingRole.ts sasRole.ts livenessGate.ts           # pure per-pairing decisions
├── store/                      # serializable projections only — the FSM lives here
├── types/protocol.ts           # zod schemas for the UNTRUSTED inbound signaling frames
└── ui/                         # React screens; reads the store, calls the core; stark-ui-kit
```

### Stack (locked — do not swap)
- React + TypeScript, **Vite** — static SPA, **no SSR** (SSR contradicts the threat model).
- **Redux Toolkit** slices. **No RTK Query** (no REST surface; signaling is WebSocket, everything else
  is the P2P DataChannel).
- No router — screens are driven by the connection state.
- Raw `RTCPeerConnection` + `RTCDataChannel` (NOT PeerJS/simple-peer — we need control of the SDP and
  the DTLS fingerprint for channel binding).
- Crypto: `@noble/curves` (+ `@noble/hashes`); WebCrypto where available.
- `zod` for validating inbound signaling frames.
- ESLint + Prettier; **Vitest** (unit) and **Playwright** (e2e) — keep both green.

### Invariants

Each is enforced in code and covered by tests; the linked section has the mechanism.
- No file bytes before the connection is authenticated (`connected` / `established`) — one gate check
  (§ Connection state machine). Path attestation is advisory and deliberately does NOT extend this gate
  (§ Path attestation).
- Every inbound signaling frame is validated with the zod schemas — the server is untrusted.
- Secret words and link secrets never reach the server; a link secret lives in the URL fragment and is
  scrubbed after it is read (§ link / qr method).
- All credential material comes from a CSPRNG, never from the user.
- Once `connected`, every method closes its own signaling socket, so the untrusted server never learns
  how long the session runs; liveness is the DataChannel and ICE, never room presence
  (§ Signaling WS lifecycle).
- Max privacy never relays unless both users ask for it in that session, each by a tap on "Retry with
  relay" after a direct failure — no automatic fallback, nothing the peer or the server can trigger.
  The retried transport is authenticated again by the method's own secret (§ Max-privacy strict model).

### Connection — the state machine, the signaling socket, early frames

#### Connection state machine
`src/store/connectionSlice.ts` is the FSM: a single `status` field + an `ALLOWED` transition
map + a `canGo` guard. States: `idle | creating | awaitingPeer | joining | pairing |
awaitingSas | confirming | connected | failed`. Illegal transitions are ignored (warn in dev).
(Identity enrollment is an action on `connected`, not a state; SAS timeouts lead to `failed`
without adding states. **Reconnect re-auth (4b-ii) adds NO states** — it reuses `joining →
awaitingPeer` (waiting for the other device at the derived rendezvous) `→ pairing → confirming →
connected | failed`; there is no SAS fallback any more.) **An authenticated channel that dies** — the
DataChannel closes, the connection closes, ICE fails, or it sits in `disconnected` past the backstop —
ends as `connected → failed` with `connection lost: <signal>` (`CONNECTION_LOST_PREFIX`), again no
new state (see § File transfer → *Liveness after connect*).

**Hard invariant:** no file bytes flow unless the connection is authenticated (status reaches
`connected` / the `established` gate, i.e. after key-confirmation or mutual SAS-confirm). Keep
this as a single gate check.

#### Signaling WS lifecycle (per-pair close-on-connect — presence decoupled from P2P liveness)
For the **1:1 methods (`words` / `link` / `qr`)** AND a connected **room/SAS pair**, the signaling
socket is **CLOSED the instant the side reaches an authenticated `connected`** — a side-effect on
entering `connected`, NOT a new FSM state (`SessionController.closeSignalingAfterConnect`, called from
`tryVerifyConfirmation`'s success branch for 1:1 key-confirmation, and from `trySasSettle`'s success
branch — `localApproved && peerApproved` — for room/SAS, both after `startEnrollment`). By that point
signaling has no further job: ICE/SDP are exchanged, key-confirmation (words/link/qr) or the SAS
commit-reveal + `sas-confirm` (room) rode the DataChannel, and TOFU enrollment rides the DataChannel
too — so the close costs the session nothing while denying the **untrusted server** any knowledge of
**how long the P2P session runs** (it sees only the short pairing window, then both peers vanish). Each
side closes **independently** — no coordinating signal: key-confirmation / SAS-confirm is mutual, so by
the time one side closes the peer has already sent its tag/confirm and will complete over the reliable
DataChannel. Our own `SignalingClient.close()` sets its `closed` flag, so it never fires
`onSignalingClose` — only the PEER observes a `peer-left`. The close is a **WS close ONLY** — there is
**NO room-destroy / leave frame** (`close()` just closes the socket; `destroyRoom()` is a separate
method used only by the words attempt-cap path).
- **Liveness is the DataChannel/ICE, NOT room presence.** Each close makes the OTHER side observe a
  `peer-left`; that must NEVER drop / fail / bounce a connected (or about-to-be-connected) peer. This
  is enforced by **`src/core/livenessGate.ts` `peerLeftAbortsPairing(established, channelOpen)`**: a
  signaling `peer-left` aborts a pairing ONLY **before the DataChannel transport is up**
  (`!established && !channelOpen`). Once the channel is open the DataChannel + ICE are the sole
  liveness authority — a `peer-left` then is the benign post-connect close (ours or the peer's; the two
  can connect-then-close a hair apart, a cross-channel race), and a REAL abort after channel-open is
  caught by `onChannelClose` instead. `this.channelOpen` is set in `onChannelOpen` **for every method
  (incl. SAS)**, reset on a words retry / lobby reset / `dispose`. **The `onPeerLeft` `words`, `link/qr`
  AND `room/SAS` branches all go through this gate** — the SAS branch was migrated off a bare
  `!this.established` to the same `peerLeftAbortsPairing(...)` as part of the room per-pair close, so the
  cross-channel race (a peer's post-connect `peer-left` arriving before its DataChannel `sas-confirm`)
  can no longer tear down a SAS pair where both humans already confirmed. The **reconnect** branch
  goes through the same gate (since 2026-09-12).
- **Guess-protection (words anti-bruteforce) is NOT weakened.** A guess is COUNTED whenever
  key-confirmation actually fails (tag mismatch → `onConfirmFailure`) or the transport collapses
  (`onChannelClose`) — both independent of signaling presence, both unchanged. `peer-left` is the SOLE
  counter only **before the channel ever opens** (a peer abandoning the rendezvous / CPace), which the
  gate still catches. After `established` a `peer-left` can no longer be a guess (the attacker would
  have had to pass key-confirmation, impossible without the secret). `livenessGate.test.ts` pins the
  exact arm (pre-transport → counts) / disarm (channel-open or established → ignored) boundary. **SAS
  has no online-guessing budget at all** (unlike words/CPace — the MITM defence is the human
  fingerprint comparison, not a guess counter), so gating the SAS branch on channel-open weakens
  nothing: a real pre-transport abort is still caught here, and a real abort after channel-open is
  caught by `onChannelClose`.
- **Scope: per-pair — EVERY method, reconnect included (since 2026-09-12).** Research confirmed per-pair
  WS-close is sound for the **room** mesh LOBBY without a "seal room" step: a room is **N independent
  1:1 pairs** over a shared socket and **re-pairing on the fly is not a thing** — once two peers raise
  their 1:1 channel the socket has no further job *for them*. So a connected room/SAS pair closes its
  OWN socket like the 1:1 methods. The server then runs `peers.delete(self)` + broadcasts a benign
  `peer-left` to the **remaining** lobby members (`signaling-server.js:422-436`); the **room survives**
  (deleted only when empty), **unrelated pairs are untouched** (their liveness is their own
  DataChannel/ICE — and `onPeerLeft` returns early for any `peer-left` whose id ≠ `this.peerId`, after
  the roster update), and the **other peer in our own pair** observes our `peer-left` already gated away
  by channel-open (the SAS gate above). **Reconnect** runs over its own fresh socket (method
  `reconnect`, a derived token room, no `sas`) and since 2026-09-12 is **INCLUDED** like every other
  method — `closeSignalingAfterConnect` gates on the method alone. Keeping the socket was itself a signal ("this pair has met before" + the session
  duration); `settleReconnect` calls the close, and the reconnect `onPeerLeft` branch moved to the
  `peerLeftAbortsPairing` gate so our own close cannot abort a peer mid-settle. **Failure paths**
  (`failDirect`, `failLink`, `failSas`, `failReconnect`, words retry) are untouched: the close is gated
  on the `connected` success branch only. Unit: `SessionController.sasPeerLeft.test.ts` (the
  channel-open race fix + the room per-pair close + reconnect, included since 2026-09-12). e2e:
  `tests/e2e/ws-close.spec.ts` (link + words: connect → socket closes → peer-left doesn't drop P2P /
  count a guess → transfer AFTER close intact); room/SAS + lobby behaviour stays green in
  `room-sas.spec.ts` / `lobby.spec.ts`.
- **A socket the SERVER closes, before `connected` (rewritten 2026-11-23).** Three cases
  (`onSignalingClose`). *The channel is not open yet*: signaling is still carrying the offer, the
  answer and the candidates, so the pairing fails — and `fail()` closes the PeerConnection with it
  (it used to leave it: a channel that opened afterwards could still authenticate, and the core then
  held `established` under a screen that said failed). *The channel is open*: signaling has no job
  left — the key-confirmation, the SAS verdicts and the reconnect hello / proof / ok ride the channel
  — so the close is ignored and the pairing's own deadline goes on bounding it. The one exception is
  a room pairing whose two SAS nonces are not both out, since those ride signaling. Until that day
  only reconnect had this rule, and a 3-minute room expiring under a slow SAS comparison ended it.
  The close is remembered, though (`signalingGone`): a pairing that then fails and would go BACK to
  waiting in the room — a words creator after a wrong guess or a silent joiner — ends the session
  with the socket's own reason instead. Nobody can arrive in a room this side has left, and no
  expiry would ever end that wait (the first version of the rule left the creator on its words for
  good). *The session has already failed*: nothing happens (below).
- **A failed session takes nothing from the server (2026-11-23).** `fail()` is the one way into
  `failed`: it closes the PeerConnection, disarms the pairing deadlines and sets `ended`, after which
  a welcome, a join, a leave, an offer, a candidate, a room-closed and a socket close all do
  nothing. Two frames are still read on a socket `failDirect` left open: the peer's `relay-retry`
  notice while a retry is offered (a line of copy — § Max-privacy strict model), and another lobby
  member's `pair-request`, answered with `busy` so that member is not left waiting. Before this a
  forged `busy` then `pair-request` from the failed pairing's own peer walked a failed room session
  into a NEW pairing with nobody having tapped anything — in Reliable with a relay in its
  configuration. Each socket's and each PeerConnection's handlers also answer only while it is still
  the session's own (`openSignaling`, `startPeer`), so nothing from one the controller has let go
  lands in the next session. The same holds for a step that awaited something: every entry point
  reads the session's `epoch` before its `connect()` and fails only that session (`failSession`),
  and `fail()` does nothing on a controller with no session — a rejected `connect()` of a session
  that was disposed while its socket was opening used to mark the idle controller `ended`, after
  which the next invite sat on `creating` for good.

#### Early frames and the channel-open window

The DataChannel starts delivering peer frames BEFORE this controller has processed channel-open:
`PeerConnection.setupChannel` wires `onmessage` synchronously, while `onopen` runs the Max-privacy
relay gate, which awaits `getStats()` (and, since 2026-09-13, polls it for up to
`SELECTED_PAIR_TIMEOUT_MS`). Anything the peer sends in that window arrives while our per-method state
is still half-built.

**Every control frame that can arrive early must be HELD and replayed — never dropped.** A dropped
frame is unrecoverable: no sender in this protocol resends, so the pair simply waits out its deadline.
Three paths now do this, and they are the pattern to copy for a fourth:

| frame | held in | replayed by |
|---|---|---|
| `enroll-*` | `pendingEnrollFrame` | `startEnrollment` (at settle) |
| `path-attest` | `pendingPathAttest` | `startPathAttestation` |
| `reconnect-*` | `pendingReconnectFrames` | `onReconnectChannelOpen` (right after it sends our own hello) |

The reconnect one was missing until 2026-09-17 and cost a 120 s stall on roughly 1 CI engine-matrix
night in 5 — see [security-audits.md](docs/history/security-audits.md) ("Reconnect stalled at `pairing` for 120 s") for the full chain, including how it was finally proved with the
DEV-only `?gateDelayMs=N` knob that makes the window deterministic.

**Corollary, learned the hard way: no branch on these paths may return silently.** A frame dropped for
a good reason and a frame never sent look identical from the outside, and both end in a deadline with
an empty log. Log which guard fired; fail closed on states that should be unreachable.

### Connection methods (4)

All four resolve to the same FSM and the same DataChannel transfer; they differ only in how
peers rendezvous + authenticate.

#### Per-pairing role (initiator/responder) — by readable-id order
`this.role` (the transport/crypto initiator|responder) is fixed **PER-PAIRING from the two readable
ids** — the lexicographically **smaller id is the `initiator`**, the larger the `responder`
(`src/core/pairingRole.ts` `pairingRoleFor`, unit-tested in `pairingRole.test.ts`) — **NOT** from
create/join. **Since the 2026-09-12 audit this is the TRANSPORT/crypto role only** — the SAS
reader/picker split no longer shares it (see below: it comes from the SAS material, because the ids
come from the untrusted server). **Why:** the room is a mesh lobby, so a 1:1
pair can be creator↔joiner OR joiner↔joiner; under the old "creator = initiator" rule two joiners were
**both `responder`** → nobody sent the WebRTC offer and the SAS commit-reveal (responder commits
first) deadlocked. Fixing the role from the ids guarantees exactly one initiator + one responder for
ANY pair; both peers compute it identically (ids are unique in a room) → opposite roles. It is
assigned once at pairing start (`SessionController.beginPairing`, both ids known) and drives: the
**WebRTC offer/answer** direction (initiator offers — sent by the smaller id, by EITHER side, not
"always the creator"), **CPace** init/respond (words), the **SAS** nonce order + commit-reveal (room,
mirrored into `sas.role`), and the **`lv(role)`** label in the **key-confirmation** (words/link/qr)
and **enrollment** transcripts. **For a 1:1 creator↔joiner pair the OUTCOME is unchanged** — same
connection, same authentication; only WHICH side offers/reveals first is now id-ordered. **Fail
closed**: an unresolved role (missing/equal id) hard-fails the pairing rather than defaulting a side
(a default could land both on the same role and deadlock). **Exception — reconnect:** the reconnect
PROTOCOL role (who proves first / `lv(role)` in the reconnect transcript) is derived from the **DTLS
fingerprints** (`crypto/reconnect.ts` `reconnectRoleFor`: the smaller fingerprint is the initiator =
the verifier-first side), independent of `this.role` — there is no creator any more (the codeless
reconnect is symmetric), and the readable ids are the server's to choose; the fingerprints are not
(a MITM presenting its own fails the channel binding regardless). Changed 2026-09-25, from
create/join. This per-pairing-role pass is the foundation for the
**Room lobby** (below), which is now built (step 6): the room method no longer auto-pairs — the human
picks whom to pair with, and the per-pairing role lets ANY pair (incl. joiner↔joiner) raise a correct
1:1 channel. words/link/qr still auto-pair 1:1 with the single peer.

#### Room lobby (mesh — roster + pick) — done (step 6)
The 4-digit room is a **mesh LOBBY**, and the client now exposes it: the room method NO LONGER
auto-pairs. **Both the creator AND every joiner land in `awaitingPeer`** (a joiner takes the new
`joining → awaitingPeer` transition — no new FSM state) and see the same `LobbyScreen`: the shareable
4-digit code + a **roster** of everyone else in the room, each with a **Connect** button. The human
PICKS whom to raise a 1:1 channel with.
- **Roster projection**: `connection.roster: PeerInfo[]` (`{id, joinedAt}` — the coarse `device` label
  was removed from the protocol 2026-09-27, see [the retired sections](docs/history/retired-sections.md) § Signaling server), maintained by the
  core from signaling — `welcome` (set the existing peers) / `peer-joined` (add) / `peer-left` (remove,
  also clearing a stale busy notice). Serializable; the live objects stay in the core. (Seeded for all
  methods, but only the room `LobbyScreen` renders it.)
- **Pick → connect handshake** (room only, over the signaling relay; carries no secret — the SAS
  authenticates). On a pick the client sends the target a **`pair-request`** and engages via
  `beginPairing`, where the **per-pairing role decides who offers**: the **smaller id (initiator) sends
  the WebRTC offer** — on its own pick OR on a `pair-request` from the responder — while the larger id
  (responder) readies its answerer, sends its SAS commit, and waits. The `pair-request` readies the
  counterpart before the offer arrives. **Glare** (both pick each other) resolves naturally — only the
  smaller id offers; **dedup** is by `this.peerId`/`this.peer` (a duplicate pick, or a pair-request from
  the peer we already engaged, is ignored). Then the normal pairing → SAS (reader/picker by id) →
  `connected` → transfer runs, for ANY pair including **joiner↔joiner**.
- **Busy-reject**: a `pair-request` from a peer while we are already pairing/connected with a DIFFERENT
  peer → we send that peer **`busy`**. The picker receiving `busy` tears down its half-started attempt
  and **returns to the lobby** (`pairing → awaitingPeer`, room + roster intact) with a clear "X is busy"
  notice (`connection.notice`) — a clean rejection, never a hang; it can pick someone else. The busy
  peer's own session is undisturbed (it drops the stray offer/commit via the `from !== peerId` gate).
- **Lobby control frames** (`pair-request` / `busy`) are handled in `onSignal` BEFORE the 1:1
  `from !== peerId` gate (a pick can come from a peer we are not yet paired with). `LobbyScreen` is
  the `awaitingPeer` view of the room method only; **reconnect** is its own method (`ReconnectWaitScreen`)
  and **auto-pairs** 1:1 at a derived token room — it never touches the lobby, so "reconnect-in-lobby"
  is moot (superseded 2026-09-25). **words/link/qr are NOT lobbies** — they auto-pair 1:1 with the single peer (only `peers[0].id` is read from the new welcome
  form). `LobbyScreen` (`src/ui/screens/`) + `pickPeer`/`onPairRequest`/`onBusy` in `SessionController`;
  e2e in `tests/e2e/lobby.spec.ts` (joiner↔joiner + busy).

- **link** — high-entropy one-time secret S in the URL **fragment** (`#…`), scrubbed via
  `history.replaceState` immediately after read (never sent to the server). No PAKE, no SAS —
  S authenticates the channel itself via key-confirmation. *(done — 5b; see below)*
- **qr** — same as link; the same link is shown/scanned as a QR. *(done — 5b; see below)*
- **room** — server allocates a 4-digit code (public, not secret) that names a **mesh LOBBY**
  (up to `maxPeers`, default 8). Several peers can sit in the same room; the client shows a **roster +
  Connect button per peer** and the human PICKS whom to raise a 1:1 DataChannel with — any pair,
  INCLUDING joiner↔joiner — and that pair runs its own SAS + transfer (see **Room lobby** below). After
  a pair connects the two humans compare a **SAS** (3 words from EFF short #2) out-of-band. SAS is
  mandatory and unskippable; the key-changed / mismatch path is a hard stop, not a dismissable toast.
  **link/qr do NOT share this 4-digit lobby** — they rendezvous via their own high-entropy **token**
  (`codeType=token`, strictly 1:1), so a stray peer can't reach the room. *(SAS done — 4a;
  lobby UI done — 6c; lobby seat cap codeType-dependent — see below.)*
- **words** — PAKE-authenticated, **no SAS**. See below.

#### words method (finalized)
A reads a phrase aloud (voice OOB), B reproduces it by **selecting**, not free-typing. PAKE
makes the low-entropy spoken phrase safe (attacker limited to online guessing; the
untrusted-server transcript is not offline-attackable).

- Wordlist: **EFF short list #2 (1296 words)** — each word has a unique 3-character prefix
  (fast autocomplete) and the list is misread-resistant (good for a voice channel). Generate
  with a **CSPRNG**, uniform, rejection-sampled (no modulo bias). Never user-chosen.
- Phrase = **5 words = 1 rendezvous + 4 secret** (~41-bit secret).
  - **rendezvous word** = room id. PUBLIC, server-allocated, from the same EFF short #2 list.
  - **4 secret words** = the CPace password. Client-generated, **never sent to the server**.
- A-side: `create=1&codeType=word` → server allocates rendezvous word from EFF short #2 →
  client generates 4 secret words → shows all 5 in order → A reads them aloud → waits
  (`awaitingPeer`).
- B-side picker: 5 positions, each its own **autocomplete** input over the **full** wordlist
  (type ≥3 chars → unique word → tap). The per-position list MUST be the full list — never a
  short "correct + decoys" set (B can't know the answer; transmitting candidates would leak
  the set to the server and collapse entropy).
- On all 5 selected: split → word 1 = rendezvous → `room=<word1>` join; words 2–5 = CPace
  password (PRS), canonical join format: `utf8ToBytes(secret.map(w => w.toLowerCase()).join('\n'))`.
- Pairing: **CPace** (draft-irtf-cfrg-cpace-21, CPACE-RISTRETTO255-SHA512) over signaling
  new `{kind:'cpace', sid?, msg}` frames (sid = 16-byte session nonce, initiator generates
  and sends on first frame; responder echoes). → shared key K. The CPace initiator/responder is the
  **per-pairing role** (smaller readable id = initiator, see **Per-pairing role**) — for words the
  rendezvous is strictly 1:1 so it is always creator+joiner, but which of the two is the initiator
  is id-ordered, not create/join. Exchange offer/answer/ICE → DTLS. **Key-confirmation:** each side MACs the negotiated DTLS fingerprint (the one from
  received SDP, that DTLS validates) + role label under K via HKDF-SHA512 derivation, exchanges
  it over a DataChannel control message `{kind:'confirm', role?, tag}`; verify with
  `equalBytes` → `connected`; mismatch (wrong words or MITM) → `failed`, no data. **No SAS** —
  successful CPace + key-confirmation IS the authentication.
- **Rate-limit / TTL**: word-room windows are bounded by **MAX_PAIRING_ATTEMPTS = 10**
  (failed CPace/confirmation/peer-drop/transport-abort counts as an attempt). A **signaling
  `peer-left` counts an attempt ONLY before the DataChannel transport is up** (the gate
  `peerLeftAbortsPairing` — pre-transport the rendezvous is the liveness authority); once the
  channel is open a guess is counted by the confirmation-mismatch / channel-close paths instead, and
  a post-connect `peer-left` (the client's own close-on-`connected`, or the peer's) is ignored. This
  does NOT weaken the bound — every actual guess (tag comparison) is still counted. See § Signaling
  WS lifecycle. On reaching the
  cap or if a server-side TTL (**WORD_ROOM_TTL_MS = 180000**, ~3 min) expires **before**
  `connected`, the word-room is invalidated → invalidates the rendezvous. After `connected`,
  TTL does NOT tear down the already-authenticated P2P connection; the client closes signaling
  itself on `connected` (1:1 privacy — server learns no duration) and the DataChannel persists,
  allowing long transfers (10GB+ at typical speeds may exceed 3 min).
  A counts attempts and can manually regenerate (fresh 5 words, new room). This bounds online
  guessing: ≤10 tries × ~2 per guess ≈ 2^4 vs 2^41 secret space.
- Server: word-rooms cap at **2 peers max** (creator + one joiner; 3rd joiner bounced with
  `4002 'room full'`). This serializes guesses and ensures the room is 1:1.

#### room method (SAS) — done
Server allocates a 4-digit public code that names a **mesh LOBBY** (see **Room lobby** above): peers
join, see each other on a roster, and the human PICKS whom to raise a 1:1 channel with (any pair,
incl. joiner↔joiner). Once a pair connects, the two humans compare a short string (SAS) **out-of-band**
(voice/QR/etc.) — the MITM check.

**SAS design (commit-before-reveal, per ZRTP / Vaudenay)**: to prevent a MITM-server from
grinding certs to match SAS on both sides, reveal the SAS only after committing to random
nonces:
  (Roles below are the PER-PAIRING transport/crypto roles — initiator = the lexicographically
  SMALLER readable id, responder = the larger — NOT create/join. See **Per-pairing role** above; the
  SAS responder commits first regardless of who created the room, so a joiner↔joiner pair never has
  both sides committing.)
- Responder sends `{kind:'sas-commit', c}` where `c = SHA-256("hushsend/sas/commit"
  || nonceR)`, nonceR = 16 random bytes. Initiator sends `{kind:'sas-nonce', nonce: nonceI}`.
- Responder reveals `{kind:'sas-nonce', nonce: nonceR}`. The initiator verifies `c = SHA-256(...)`
  with `equalBytes` (abort on mismatch). Order is critical: the responder is committed before the
  initiator's nonce is revealed. Both derive (HKDF-SHA512, same KDF as the words key-confirmation;
  `nonceA`/`nonceB` below = initiator's/responder's nonce, bound in fixed role order):
```
  SAS = HKDF-SHA512(IKM = lv(nonceA) || lv(nonceB) || lv(fp_min) || lv(fp_max),
                    salt = ∅, info = "hushsend/sas")
```
  where `fp_min/fp_max` = sorted DTLS fingerprints (lexicographic order, same canonicalization
  as words key-confirmation), `lv` = length-prefix. The commitment `c` stays SHA-256 (a hash is
  the right primitive for a binding commitment). Then render SAS as **3 words from EFF short #2**
  (≈31 bits, readable aloud); each word index is a bias-free 8-byte reduction of the HKDF output.
  Both sides must derive the same triple.
- **NO NONCE REVEAL BEFORE THE FINGERPRINTS ARE PINNED** (`SessionController.maybeRevealSasNonce`) —
  **added 2026-09-12, and it is load-bearing.** The commitment covers the two NONCES; the IKM above
  has FOUR inputs. The fingerprints used to be free at reveal time, and the nonces ride SIGNALING, so
  an untrusted relay controlling delivery order could finish both commit-reveal exchanges while its
  own certificate on each leg was still unchosen — then grind ~2^16 certificates per leg, meet in the
  middle, and make BOTH humans read the SAME phrase. Reproduced against `computeSasWords` in ~4 s,
  against a 120 s deadline, with the certificate pool precomputable offline: a silent, complete MITM
  of the room method that also pinned the attacker's identity key via the enrollment that follows.
  Every reveal is now held until `sas.fps` is set, so the attacker's certificate is inside our
  transcript before it learns our nonce. Regression: `SessionController.auditFixes.test.ts` §1.
- **Exchange over DataChannel**: each side sends `{kind:'sas-confirm', ok: <bool>}` after the
  human either confirms (both SAS match) or denies (mismatch). Both must confirm → `connected`;
  any deny/timeout/abort → `failed`. This is not a cryptographic boundary (SAS already
  authenticated the channel via fingerprint binding), but a **coordination gate** ensuring both
  sides agree on authenticity before allowing data transfer.
- **UI confirmation — ASYMMETRIC "pick from 3 phrases" (crypto unchanged)**: `sas.ts` and
  the `sas-confirm{ok}` protocol are untouched. The screen is split by role so the pick actually
  defends against a MITM:
  - the **READER** is shown its phrase (`sas-words`), reads the 3 words aloud, then confirms (or aborts);
  - the **BLIND PICKER** is NEVER shown the phrase on its own, only 3 indistinguishable options (the
    REAL phrase + **2 LOCAL display-only decoys**: same EFF short #2 list, same 3-word format, distinct
    from the real one and each other, randomised order, never sent), and must identify the phrase by
    LISTENING to the reader.

  This split is the whole point: a picker that could see its own phrase would click it without
  listening, giving no protection. Blind, the picker catches a MITM (which makes the two sides derive
  DIFFERENT phrases) — the read phrase is not among the picker's options → "none of these match" →
  `confirmSas(false)` → both abort. `confirmSas(true)` fires only when the picker selects the real
  phrase (the reader confirms its peer found it). Entropy is preserved (full phrase vs full phrase);
  the decoys are pure UI. The decoy build + pick scoring is isolated in `sasOptions.ts` and
  unit-tested (`sasOptions.test.ts`).
  - **SAS role is PER-PAIRING, from the SAS MATERIAL (was: readable-id order) — changed 2026-09-12.**
    Since the room is a mesh lobby, a pair can be creator↔joiner OR joiner↔joiner, so "creator reads"
    would make two joiners both pickers (no reader). The split used to come from the two readable ids
    (smaller id reads). **The audit broke that:** the ids are assigned by the UNTRUSTED SERVER,
    independently to each peer, so a malicious server could tell BOTH peers they held the smaller id
    → both blind pickers, nobody reads, and the ceremony degrades from ~2^-31 to two humans each
    guessing 1-in-3. (The mirror case, both readers, is caught by the humans hearing two different
    phrases; both-pickers is silent.) The split is now `sasReaderIsFpMin` (`crypto/sas.ts`): one HKDF
    bit over the SAME IKM as the words — both nonces + both fingerprints — under its own
    `hushsend/sas/role` label, turned into our own role by `sasRoleFrom` (`src/core/sasRole.ts`,
    unit-tested in `sasRole.test.ts`). Each peer asks whether its OWN fingerprint is fp_min and
    compares that to the bit, so the two roles are always opposite. The server cannot choose it (no id
    is an input) and a MITM cannot steer it either: the nonces are revealed only AFTER the
    fingerprints are pinned, so the bit is decided after the attacker has committed to its
    certificate. Computed in `trySasReady` — the first moment both nonces and both fingerprints exist
    — and projected as `connection.sasRole`; `SasScreen` reads it. **Fail closed**: an unresolved role
    (`null` — missing/degenerate fingerprints) renders the "restart verification" screen, NEVER a
    functional blind picker. Note the consequence: reader↔initiator no longer line up, by design.
- **Timeouts**: one reused timer bounds the coordination phases, default **120000 ms** (~2 min).
  It arms at pairing-start (`beginPairing`) to bound the pre-SAS pairing window (peer sent commit but
  withheld its nonce → no longer hangs), then re-arms at SAS-display to bound the comparison + confirm
  window. **Both phases are PROD-fixed at the 120 s default** but each reads its duration through a
  SEPARATE DEV-only override so e2e can drive each timeout branch in ~hundreds of ms / a few seconds
  instead of a real 120 s wait, both gated behind `import.meta.env.DEV` (dead-code / tree-shaken in
  prod): the pre-SAS window via **`preSasTimeoutMs()`** (`?preSasTimeoutMs=N` /
  `window.__HUSHSEND_PRE_SAS_TIMEOUT_MS__`) and the comparison window via **`sasConfirmTimeoutMs()`**
  (`?sasTimeoutMs=N` / `window.__HUSHSEND_SAS_TIMEOUT_MS__`). They are kept SEPARATE deliberately —
  shrinking one must not pre-empt the other's state under test (the comparison-timeout e2e relies on
  the pre-SAS window keeping its default while only the comparison one shrinks). On expiry → `failSas`
  → `failed` + close, same path as deny/abort. The pre-SAS deadline's **FIRING direction is e2e-tested**
  (`?stallSasNonce=1` makes a peer reach the SAS
  but withhold its nonce reveal → the other side fails at the shrunk pre-SAS deadline, not hangs —
  `tests/e2e/room-sas.spec.ts`).
- **Inbound validation**: `sas-commit` / `sas-nonce` frames are zod-validated to exact decoded
  lengths (commit = 32 bytes, nonce = 16 bytes); malformed / short / odd-hex frames are rejected
  before any crypto (untrusted relay).
- **Server cap / TTL / rate-limit (done — 6a, lobby cap added later)**: the 4-digit room is a
  **`managed`** room, which governs the TTL + per-IP rate-limit. The **seat cap is codeType-dependent,
  NOT the `managed` flag**: the 4-digit **room** rendezvous is a **LOBBY** up to **`maxPeers`**
  (`FILETRANSFER_MAX_PEERS`, default **8**); the **words** AND the link/qr **token** rendezvous are
  strictly 1:1 (`ONE_TO_ONE_MAX_PEERS = 2`) — words to serialize secret-word guessing, token because a
  one-time link/qr has a single receiver. A joiner past the cap is bounced with **4002 `'room full'`**.
  The room self-destructs after a short TTL **before `connected`**, freeing the code (a later join →
  **4009 `'room not found'`**; after `connected`, closing signaling does NOT drop the live P2P
  channel). The **4-digit lobby TTL is an IDLE timeout** (`ROOM_TTL_MS = 180000`, ~3 min): every JOIN
  re-arms it, so an actively-joined lobby lives while a stale one expires. The **words AND token TTLs
  stay armed from CREATE** (`WORD_ROOM_TTL_MS` / `TOKEN_ROOM_TTL_MS`, both 180000) and do NOT re-arm (a
  re-arm would let an attacker keep a 1:1 room alive by rejoining). **Per-IP create/join attempts are
  rate-limited** (`IP_RL_MAX =
  60` / `IP_RL_WINDOW_MS = 60000`; over → **4011 `'too many attempts'`**) to slow enumeration of the
  small 10k space; loopback is EXEMPT (behind nginx a real client always arrives via `X-Real-IP`, never
  loopback). SAS still defeats a MITM regardless — this is abuse hygiene. See **Signaling server**
  below; tested in hush-signaling-server `tests/room-server.test.ts`.

#### link / qr method (finalized — 5b)
A high-entropy ONE-TIME secret in the URL fragment authenticates the channel directly — **no PAKE,
no SAS, no human comparison, no reader/picker**. (The full-entropy secret is not offline-guessable,
so a PAKE is unnecessary; the secret authenticates by itself, so a SAS is unnecessary.) link and qr
are the SAME path — qr only renders/scans the same link. Lives in `src/core/link/link.ts` (pure:
generate / build / parse) + the link/qr branches in `SessionController`; no new FSM states.

- **Secret S**: `LINK_SECRET_BYTES = 16` CSPRNG bytes (128 bits), base64url-encoded, never
  user-chosen. It is the key-confirmation IKM and **never reaches the server**.
- **Rendezvous**: a **high-entropy token** (`codeType=token`) — the CLIENT draws a 128-bit CSPRNG,
  base64url, 22-char token (`link.ts` `generateRendezvousToken`) and TAKES that room on the server
  (**token rooms are join-or-create since 2026-09-25** — the first arrival opens the room; the
  server-side `create=1` allocator, `tokenCode.allocate`, is kept only for compatibility), NOT the
  4-digit room. The link already carries the rendezvous, so a high-entropy token costs nothing in UX
  while making the rendezvous **unguessable**: a stranger can't enumerate/squat a token room the way
  the 10k 4-digit space can be scanned, so interloper-resistance is **structural** (the old link/qr
  lobby-race is closed by construction, not just by rate-limit). Public routing only. The **room
  method keeps the 4-digit code; words keeps its word**. The codeless reconnect uses the SAME shape
  (a token derived from the pairing secret, taken join-or-create), so the server cannot tell a
  reconnect from a link/QR meeting, nor which side of a link initiated.
- **Link shape**: `<origin>/#<token>.<S>` (`buildLinkUrl`). The token is PUBLIC (routing); S rides in
  the **fragment**, which browsers never send to the server. Both halves are base64url with no
  padding, so neither contains `.` and `parseLink` splits cleanly on the first `.`.
- **Authentication = channel-bound key-confirmation over S** (reuses `keyConfirmation.ts`, the same
  primitive + lv-canonicalisation as words/SAS, under the **`LINK_CONFIRM_DOMAIN`** domain —
  `confKey = HKDF-SHA512(S, salt=∅, info="hushsend/link/confirm")`, `tag = HMAC-SHA256(confKey,
  lv(label) || lv(fp_min) || lv(fp_max) || lv(role))`). Tags exchanged over the existing
  `{kind:'confirm', tag}` DataChannel control message; verify with `equalBytes` → `connected`;
  mismatch (no S / wrong S / MITM with different certs) → `failed`, **no byte**. The words domain
  is unchanged — `makeConfirmation`/`verifyConfirmation` gained an optional trailing `domain` arg
  that defaults to `CPACE_CONFIRM_DOMAIN`, so the words call sites are byte-for-byte identical.
- **Flow** (maps onto existing states, no new ones): A takes its token → `awaitingPeer` shows the link
  (creator only; surfaced as `credential[0]`, same as words surfaces its secret words) → `peer-joined`
  → at pairing start the WebRTC **initiator is the smaller readable id** (see **Per-pairing role**;
  either side may offer, not necessarily the creator) → DTLS → key-confirmation over S → `connected`.
  (`creating`/`joining` → `pairing`[DTLS] → `confirming`[S key-confirm] → `connected`|`failed`.)
- **Liveness (link, QR and words alike)**: ONE client deadline, 120 s (`preSasTimeoutMs()`, the same
  DEV override as the SAS window), runs from pairing start through key-confirmation —
  `SessionController.armConfirmTimeout`, armed in `beginPairing`. Until 2026-10-11 it armed only once
  the DataChannel was open, so a peer that never answered the offer left the other side waiting for the
  untrusted server's room TTL (measured: ~165 s on "Agreeing on keys…", docs/test-runs/2026-10-11.md).
  A stall before the channel ends as "the connection did not come up in time"; after it, as "peer did
  not complete key confirmation in time". A PeerConnection that cannot be brought up fails the pairing
  at once (`launchPeer` → `onPeerStartFailure`, through the method's own teardown); without WebRTC in
  the browser the reason is `WEBRTC_UNAVAILABLE_REASON` — and the app does not get that far, it shows
  "This browser can't send files" up front (`core/webrtc/available.ts`, App.tsx).
  `SessionController.pairingDeadline.test.ts`; e2e `link.spec.ts` (the no-WebRTC joiner).
- **One-time / replay**: the link/QR is for ONE connection; the token room is session-scoped (TTL +
  per-IP rate-limit — the managed-room hardening — see § room method → *Server cap / TTL / rate-limit*).
  The token room is **strictly 1:1** (`ONE_TO_ONE_MAX_PEERS = 2`, like words), NOT the 4-digit lobby:
  the unguessable token keeps strangers OUT structurally, and the cap-2 guarantees a **single
  receiver** even if the link is forwarded (a 2nd joiner is bounced **4002 `'room full'`**; S would
  also fail key-confirmation for it — defense in depth). Its TTL is armed **from CREATE** and never
  re-armed (`TOKEN_ROOM_TTL_MS = 180000`, the natural pre-connect wait of a 1:1 link). Replay is closed
  by a fresh DTLS cert per session **plus** S being single-use (scrubbed after read).
- **Fragment scrub**: the joiner reads `location.hash` on page load, extracts the token + S, **scrubs
  the fragment immediately** via `history.replaceState` (before any await — see `LinkFragmentJoin`
  in `App.tsx`), and sends only the token to the server (`join`, `codeType=token`). A link opened into
  a tab that ALREADY shows hushsend is a same-document navigation (only the fragment differs), so
  `LinkFragmentJoin` also listens to `hashchange` (since 2026-09-29): scrub at once whatever the state,
  join from `idle` or a finished `failed` session, and never tear down a session in progress or a live
  channel for it — there the link is dropped (`link.spec.ts`, three cases). A malformed/absent
  fragment is a no-op (stay home); a valid-but-dead link surfaces as the "room not found" failure the
  moment the joiner finds the token room EMPTY (`onWelcome`: token rooms are join-or-create, so the
  server no longer says 4009 — but the sender always opens the room before the link exists, so
  "nobody here" means expired/used; `link.spec.ts` "dead link"). `parseLink` validates strictly (token = `RENDEZVOUS_TOKEN_LEN`=22 base64url chars, S decodes
  to exactly 16 bytes) — the input is attacker-influenced; an old 4-digit-style code is now rejected.
- **qr**: the SAME link, rendered to an SVG QR locally (`src/ui/qr.ts`, `qrcode`); the joiner SCANS
  it with the camera (`getUserMedia` + the `barcode-detector` ponyfill — always the **self-hosted**
  zxing-wasm via `src/ui/zxingWasm.ts`, lazily imported — since 2026-10-03 only where the browser has no
  native `BarcodeDetector` for QR; Chrome uses its own, with a runtime fallback to zxing, § QR) → decodes to the link →
  same join path. Camera denial/absence falls back to a **paste-the-link** input (also the
  deterministic e2e injection point). The zxing WASM is served from our own origin, not a CDN — see § QR.
- **Enrollment**: TOFU pinning runs after `connected` exactly as for words/room (method-agnostic),
  so link/qr pairs can later reconnect.

### Crypto

- **CPace** (balanced PAKE) for the words method — over `@noble/curves` ristretto255
  (+ hash-to-curve) and `@noble/hashes` SHA-512, against the CFRG test vectors
  (draft-irtf-cfrg-cpace-21, April 2026). Password = secret words only (rendezvous excluded).
  - Specifics: sid = fresh 16-byte nonce per session, generated by initiator and sent with
    first CPace message; both sides use it in ISK derivation. Abort conditions (per draft-21):
    invalid point, point = identity. Scalar sampling: uniform ≤ 2^252 < ristretto255 order,
    rejection-sample for nonzero (negligible bias; ~2^-127).
- **Ed25519 identity key** (TOFU pinning + reconnect signatures): prefer WebCrypto
  non-extractable Ed25519 (private key never in the JS heap; the non-extractable `CryptoKey` is
  stored in IndexedDB and cannot be read back); fall back to `@noble/curves` Ed25519 (stores the
  32-byte seed) where unsupported. Signatures interoperate across both paths — verify uses noble
  unconditionally (Ed25519 is RFC 8032, signature format is canonical).
- **Identity enrollment (TOFU, done)**: runs ONLY after `connected` — i.e. over the already
  SAS/words-authenticated channel, where the MITM is already defeated, so exchanging public keys
  is trustworthy (this is the trust-on-first-use moment). **Both directions are gated on
  `this.established`, and that gate is new (2026-09-12).** It used to hold only for the SEND path:
  the RECEIVE path (`onEnrollFrame`) checked `isAuthenticatedMethod()` — a check on the METHOD, true
  from the first moment of every real session — so any peer that reached an open DataChannel could
  send `enroll-init`, have its key verified against ITSELF (pure TOFU), written into the keystore as
  a pin, and receive our long-term identity key in the ack: a planted "known device" that later
  reconnects with no SAS and no human step, plus the strongest cross-session tracker in the system
  handed to a stranger. A frame that arrives in the short window before WE settle is HELD
  (`pendingEnrollFrame`) and replayed by `startEnrollment`, so an honest early arrival is not lost.
  A `pairingId` we already hold under a DIFFERENT key is refused rather than overwritten
  (first-write-wins) — an upsert there would silently erase the key-change hard stop.
  Regression: `SessionController.auditFixes.test.ts` §3. It is an action on `connected`, NOT an
  FSM state, and does NOT gate `connected` or transfer; a bad enrollment signature only skips the
  pin + warns, never tears down the human/PAKE-authenticated session. The initiator (the
  **per-pairing role** — the smaller readable id, NOT necessarily the creator) generates a
  key-independent random `pairingId` (16 bytes) — key-independent so a swapped key under the same
  id is detectable on reconnect; `lv(role)` below is that per-pairing role. Each side signs its OWN
  public key:
```
  sign( lv("hushsend/identity/enroll") || lv(pairingId) || lv(ownPubKey) || lv(fp_min) || lv(fp_max) || lv(role) )
```
  (same `lv` + sorted-fingerprint canonicalization as key-confirmation / SAS; fingerprints from
  the parsed SDP — channel binding). The verifier reconstructs with the received key as the
  signer's `ownPubKey`, the peer's role, the shared `pairingId`, and its own fingerprints. On
  success each side pins `pairingId → peerPublicKey`. Frames (`enroll-init {pairingId, pubKey,
  sig}`, `enroll-ack {pubKey, sig}`) are zod-validated to exact lengths (pairingId 16B, pubKey
  32B, sig 64B).
- **Reconnect (TOFU re-auth, done — 4b-ii; CODELESS since 2026-09-25)**: when both sides ALREADY
  hold a pin for the same `pairingId` (from a prior enrollment), they reconnect with **NO human step
  and NO code** — each taps **Reconnect** on the other's recent-devices row, and the pin does the
  rest. The `pairingId` (16 CSPRNG bytes minted at enrollment over the authenticated channel, held
  only in the two keystores, in no signaling schema) is the **pairing SECRET** three things are keyed
  by (`crypto/reconnect.ts`, all pure + unit-tested):
  1. **Rendezvous — WHERE.** `reconnectRendezvous(pairingId, bucket)` =
     `HMAC(pairingId, lv("hushsend/identity/reconnect-rendezvous") ‖ lv(bucket))[0..16]`, base64url →
     a 22-char token of exactly the link/QR shape. `bucket = floor(now / RECONNECT_BUCKET_MS)` (10 min).
     Each side asks the server for that token room **join-or-create** (`{join: token, codeType:
     'token'}`, never `create`) — whoever taps first opens it, the other finds it, order is irrelevant.
     The server sees a token room indistinguishable from a link/QR one, cannot tell "these two have
     met before", and cannot link one bucket's token to the next. A side waiting alone
     (`ReconnectWaitScreen`, `awaitingPeer`) **re-takes the rendezvous** at every bucket boundary (so
     two clocks that disagree by less than a bucket still meet, at worst after the skew has elapsed)
     and every `RECONNECT_REFRESH_MS` (2 min, well inside the server's 3-min token TTL — a fresh room
     for a late peer), answers a `room-closed`/server close with another take (bounded by
     `RECONNECT_MAX_REJOINS` = 8), answers a socket that cannot even OPEN (the network changed under
     the wait — a phone leaving its Wi-Fi; the old socket died with a 1006 a moment earlier) with a
     retry after `RECONNECT_RETRY_MS` (3 s) inside the same cap instead of ending the wait, re-takes
     at once on the browser's `online` event (neither counts against the cap; both since 2026-10-03,
     test plan E7 on the Pixel 5), **returns to waiting when the engaged peer vanishes BEFORE any
     transport** — its `peer-left`, or the re-auth deadline with the channel never opened —
     (`resumeReconnectWait`: tear the half-pairing down, `pairing → awaitingPeer` via the lobby's
     `returnToLobby`, re-take the rendezvous; the ORIGINAL wait cap is kept via `rc.waitUntil`; since
     2026-10-03 — after a network blip the first socket that opens meets the device's OWN previous
     socket in the token room, because the server needs ~25 s to notice a dead one; a peer that DID
     raise a channel and then stalled still fails), and gives up at `reconnectWaitMs()` (10 min; DEV knob
     `?reconnectWaitMs=N` / `__HUSHSEND_RECONNECT_WAIT_MS__`) with the stable
     `RECONNECT_NO_SHOW_REASON` ("did not show up" — its own FailedScreen variant). Nothing about the
     token is projected to the store. `SessionController.reconnectRendezvous.test.ts`.
  2. **Hello — WHO.** Meeting at the token is not authentication: the untrusted server can put
     anyone into any room. At channel-open both sides derive the **role from the DTLS fingerprints**
     (`reconnectRoleFor`: fp_min = initiator; equal/missing → fail closed) and send
     `reconnect-hello {challenge, mac}` with `mac = HMAC(pairingId, lv(domain) ‖ lv(challenge) ‖
     lv(fp_min) ‖ lv(fp_max) ‖ lv(role))`. A verified hello is the ONLY thing that unlocks the next
     step, so the long-term identity key is disclosed to a proven pin-holder alone — a stranger cannot
     produce one and learns nothing from ours (128-bit secret; channel-bound; role-bound, so our own
     hello reflected back fails). Mismatch → hard stop `RECONNECT_STRANGER_REASON`.
  3. **Proof — the pinned key.** Verifier-first ordering: the **responder proves first** (after the
     initiator's hello verified), the initiator verifies, proves, and **settles only on the responder's
     `reconnect-ok`** — so the two sides never disagree about the outcome (a responder that hard-stops
     on the initiator's proof never leaves the initiator connected to nobody). Each proof is the
     channel-bound signature under the pinned identity:
```
  sign( lv("hushsend/identity/reconnect") || lv(pairingId) || lv(challengeInitiator) || lv(challengeResponder) || lv(fp_min) || lv(fp_max) || lv(role) )
```
  (same `lv` + sorted-fingerprint canonicalization as enroll/SAS/key-confirmation; fingerprints
  from the parsed SDP — channel binding. Each side draws a fresh 16-byte CSPRNG challenge; both are
  bound in fixed role order.) **Verification is TWO separate checks** so a key change is told apart
  from a MITM: (1) does the PRESENTED key equal the PINNED key for this pairingId? No → **key
  changed** hard stop (SSH-style — the peer under this id is using a different key; a visible stop,
  never a toast, no bytes). (2) does the signature verify under the PINNED key over the transcript
  rebuilt with OUR fingerprints + the peer's role? No (key matched) → channel-binding / **MITM**
  hard stop, no bytes. Both pass → authenticated reconnect (`connected`, no re-enrollment; path
  attestation starts like every method). **Replay** is closed by the channel binding (a fresh DTLS
  cert per session) AND the explicit challenges. Frames (`reconnect-hello {challenge, mac}`,
  `reconnect-proof {challenge, pubKey, sig}`, `reconnect-ok {}`) are zod-validated to exact lengths
  (challenge 16B, mac 32B, pubKey 32B, sig 64B); the old `reconnect-init` / `reconnect-fallback` are
  gone. DEV/TEST knob `?forgeReconnectKey=1` makes a side present a fresh key under the real
  pairingId, driving the key-changed e2e.
  **No SAS fallback.** A device that lacks the pin cannot derive the token, so it never arrives; the
  other side's wait ends in "did not show up" and the copy says to pair afresh by any method (which
  pins again). Nothing rides on top of `this.sas` any more.
  **Liveness deadline (fail-closed):** once a peer is engaged at the rendezvous the hello → proof →
  ok exchange has a deadline **prod-fixed at 120 s** (`reconnectTimeoutMs()`, DEV override
  `?reconnectTimeoutMs=N` / `window.__HUSHSEND_RECONNECT_TIMEOUT_MS__`, tree-shaken in prod). Armed at
  pairing start (`beginPairing`, reconnect path only, which also disarms the wait/refresh timers);
  cleared on settle/fail/dispose (a Max-privacy ICE failure also clears it via `failDirect`); expiry
  → `failReconnect` (→ `failed` + close), the SAME terminal path as a key-change / MITM. A liveness
  bound, not a security one. DEV knob `?stallReconnect=1` (withholds the reconnect-proof) drives the
  firing e2e (`tests/e2e/reconnect.spec.ts`).
- **Keystore** (IndexedDB, behind a `KeystoreBackend` port — an IndexedDB impl for the app, an
  in-memory impl for unit tests): stores own identity (non-extractable `CryptoKey` or noble seed)
  and pinned peer keys (`pairingId → { peerPublicKey, firstSeen, label? }`). Pinning on first
  successful connect (enrollment, above) and the **"key changed" hard stop on reconnect** (presented
  key ≠ pin → abort, never silent — `presentedKeyMatchesPin`) are both **done** (4b-i / 4b-ii).
- **Key-confirmation / channel binding**: each side derives `confKey = HKDF-SHA512(secret,
  info=domain)`, then `tag = HMAC-SHA256(confKey, lv(label) || lv(fp_min) || lv(fp_max) ||
  lv(role))`, where `fp_min/fp_max` are the DTLS fingerprints (lexicographically sorted) from the
  local cert and the received SDP; `lv` = length-prefixed encoding (same as in CPace); role = the
  **per-pairing** initiator/responder (smaller readable id = initiator, see **Per-pairing role**).
  Exchange `tag` over a DataChannel control message; verify with `equalBytes`
  (constant-time). This binds both the shared secret AND the actual DTLS channel (via fingerprints)
  — a MITM with different certs on each leg produces mismatched tags. The construction is
  **Which fingerprint that is — the one-fingerprint rule (since 2026-11-23,
  `src/core/webrtc/fingerprint.ts`).** The peer's description arrives through the untrusted server,
  and a description may carry several `a=fingerprint` lines, on which the engines disagree: Chromium
  158 and WebKit 27.2 keep ONE (the last at the level in force, media over session) and serialize
  only that one back; Firefox 159 accepts a certificate matching ANY line at the level in force and
  keeps them all ([2026-11-23 run](docs/test-runs/2026-11-23.md)). The first line of
  `remoteDescription.sdp`, which the code read until that day, is therefore not always the
  certificate DTLS accepted. Three locks, all in `PeerConnection`: (1) `sdpFingerprint` reads the
  description AS IT ARRIVED, before `setRemoteDescription` — every fingerprint line at any level,
  hash name and hex case folded — and anything but exactly one distinct value refuses it (two hash
  functions count as two; a line that mentions a fingerprint and cannot be read refuses it too,
  rather than being skipped); the same rule reads our own description. (2) A connection takes ONE
  remote description, of the kind it is waiting for — the answerer one offer, the offerer one answer
  — and the value is stored before the engine is handed it, so no later or racing description can
  replace what `remoteFingerprint()` returns; what the engine then serializes back has to name the
  same certificate. hushsend never renegotiates and never restarts ICE, and a reconnect is a new
  connection, so nothing honest sends a second one. (3) At channel-open, before the channel is
  handed to the session, the certificate DTLS actually accepted (`getRemoteCertificates()`, present
  and correct in all three engines that day) is hashed and compared with the stored value; an
  engine without the call gives no second opinion and lock 1 stands alone. A refusal reaches the
  session as `onTampered` → `failPairing` → the method's own teardown with
  `DESCRIPTION_TAMPERED_REASON`, which `FailedScreen` shows as "compromised"; no channel is ever
  handed over. What an honest browser could trip over: one that lists two different fingerprints
  for itself — two hash functions of one certificate, or a second certificate. None of the three
  engines does (each writes one `sha-256` line, repeated per media section at most), and such a
  browser would now fail to pair, visibly. Tests: `fingerprint.test.ts`,
  `PeerConnection.description.test.ts` (the wrapper against a stand-in engine: refused before the
  engine, the second and the racing description, the wrong kind, the engine keeping another value,
  the certificate check), `tests/e2e/fingerprint.spec.ts` (each engine, a second line added to what
  one tab sends: link in three arrangements and room — refused as compromised with no DataChannel
  ever open; against the code before the fix the Firefox pair given "the honest line, then
  another" connected, and in a room both sides were shown the three words).
  The construction is
  **domain-parameterised** (`makeConfirmation`/`verifyConfirmation` take a `ConfirmationDomain`
  defaulting to `CPACE_CONFIRM_DOMAIN`): the **words** method feeds the CPace ISK under
  `info="hushsend/cpace/confirm"`; the **link/qr** methods feed the URL-fragment secret S under
  `LINK_CONFIRM_DOMAIN` (`info="hushsend/link/confirm"`). Same primitive + lv-canonicalisation; the
  distinct domains keep the two methods' tags independent and the words tags byte-for-byte unchanged.

### File transfer

- DataChannel with chunking + **backpressure** (`bufferedAmount` /
  `bufferedAmountLowThreshold`).
- **Several files in one send travel as ONE store-mode zip, `hushsend-files.zip`** (`client-zip`
  `makeZip`, streamed; `predictLength` gives the exact size for the offer), so the receiver sees one
  offer and one progress bar. By design since `1082b7d`; documented 2026-09-27 (test plan A7).
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
     handset runs it (test plan B2/B10). The worker is registered when an offer is planned, keeps alive
     by a ping every 10 s while streaming, is unregistered 60 s after the last download (or after a
     declined offer), and `sweepDownloadWorker` at startup removes one a closed tab left.
  2. **OPFS** (`transfer/opfs.ts`) — the site's private on-disk folder, written with NO dialog, then
     handed over as an ordinary download read from disk. Used when a one-time write probe succeeds
     (`opfsUsable`, memoized per session), the site quota holds the file (`opfsRoom`, 64 MiB headroom)
     AND a **reservation** succeeds (`opfsCanHold`: `truncate(size)` on a fresh writable, aborted at
     once; at accept `createIncoming(size)` reserves for real). The estimate alone lied: incognito
     Chrome reports its normal profile's 10 GiB while holding ~430 MiB, and a 600 MiB file planned by
     the estimate was accepted and died at 74 % (test plan 2026-09-28). `truncate` costs 1–2 ms for
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
  allowed (both measured: § Platform limits). Until it is answered the file is not saved, while the
  screen already says "Received". On Safari the finished receive row therefore says to answer it
  (`download-prompt-hint`, shown once the hand-off happened — at once, or after the Save file tap);
  `ui/platform.ts` `downloadPromptFor` decides from the UA (`platform.test.ts`; e2e `mobile.spec.ts`
  under the iPhone profile; visual scene `transfer-received-ios`). Other browsers save without asking
  and show nothing.
- **Screen Wake Lock while a transfer is in flight (2026-10-03, owner's choice "option c").** iOS Safari
  tears the WebRTC connection down the moment the screen locks (test plan F1 on the iPhone 15: an 800 MB
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
  drop the connection. Unit: `wakeLock.test.ts`. Verified on the iPhone 15 (2026-10-03, test plan F1): a 3 GiB receive with
  Auto-Lock at 30 s ran to Delivered with the phone untouched; the first build, which asked from the effect
  alone, was refused and the screen locked. An app switch still ends the connection within ~15 s (measured).
- **The sender reads the file in windows, never through `File.stream()` (2026-10-03).** WebKit's Blob
  stream hands the WHOLE file over as ONE chunk (measured on Safari 26.6: a 1 GiB File → a single 1 GiB
  read, WebContent +130 MiB even on a blob of shared parts), which is why a 5 GiB send from Safari grew the
  process to ~940 MiB (test plan B10) and would kill a tab on a phone; Chrome and Firefox chunk finely.
  `readInWindows(blob)` (`fileTransfer.ts`) pulls `blob.slice(off, off + READ_WINDOW).arrayBuffer()` one
  window at a time (`READ_WINDOW` = 4 MiB = 16 wire chunks), for single files AND for every zip entry
  (client-zip is given `{ input: readInWindows(f), name, lastModified, size }` instead of the File, or it
  would call `file.stream()` itself). `Rechunker.pull` is zero-copy when the head window covers the
  request (it returns a VIEW — callers never mutate pieces) and copies only to coalesce. Memory on the
  send side is thus one window + the wire's high-water mark, on every engine. Unit:
  `fileTransfer.test.ts` ("reading the file for the wire"). Measured on real Safari 26.6 (2026-10-03): a real 2 GiB file from the owner's own Safari to Chrome in
  40.5 s (53 MB/s), SHA-256 equal, WebContent memory spiking and falling back within seconds, never growing
  with the file — [ux-fixes.md](docs/history/ux-fixes.md) § UX bugs has the numbers and the two stand-caused ICE failures on a swap-bound Mac.
- **"Finishing" — the 100 % that is not the end (2026-10-03, owner's choice "option 1").** Once every
  declared byte has crossed, the sender still pushes the volume padding (Max privacy, up to 12.5 % of
  the file — 512 MiB at 2^32 + 1 B, ~137 s at the Pixel 5's 3.9 MB/s, test plan B10) and then waits for
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
- **Liveness after connect (2026-09-27 — test plan F2 / F3).** Until then nothing after `established`
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
    closing mid-send — still takes ~16 s (see § Platform limits).
  - `acceptIncoming` survives the session ending under an open save picker (Android's picker left
    ~20 s took ICE down with it — § Decisions): the offer is gone by then, so whatever the picker returns is
    `discard()`ed silently and nothing overwrites the row.
  - Unit: `SessionController.connectionLost.test.ts`, `transfer/fileTransfer.lost.test.ts`. e2e:
    `tests/e2e/connection-lost.spec.ts` (512 MB sparse file, each tab its own context: the receiver
    closes mid-transfer → the sender ends "not delivered"; the sender closes → the receiver ends "not
    received" with no download; Chromium only — the receiver's renderer crashed via CDP `Page.crash` →
    the sender shows `interrupted`, then ends lost). Screens: `visual/scenes.ts` `transfer-interrupted`,
    `failed-lost`, `failed-lost-delivered`, `failed-lost-idle` (axe-checked; screenshot baselines recorded on the deploy host,
    2026-09-27).

### Privacy modes, ICE and path attestation

#### Privacy mode + ICE (Max-privacy / Reliable — step 6d, DONE)
*(Separate privacy lever — server learns no session duration: for the 1:1 methods the client closes its
signaling socket on `connected`. See **§ Signaling WS lifecycle**. The toggle below is unrelated — it
only governs `iceServers`.)*

The home **"Max privacy" toggle is FUNCTIONAL** and drives the WebRTC `iceServers` (the only transport
behaviour behind it). It is a persisted UI pref (`prefs.tsx`, `hushsend.privacy`, **default `max`**;
"Retry with relay" switches it for the visit without storing it — § Max-privacy strict model),
pushed into the core via `<PrivacyModeSync>` (App) → `SessionController.setPrivacyMode`. The mode is
**read at pairing start** (when `iceServers` are assembled), so flipping it mid-session affects the
**NEXT** connection, NOT the live one. **Max-privacy is STRICT — it NEVER relays** (no consent
escalation): a live Max-privacy ICE failure is **terminal** (→ `failed` + a switch-to-Reliable hint),
see **Max-privacy strict model** below.
- **Builder** (`src/core/iceServers.ts`, pure + unit-tested in `iceServers.test.ts`):
  `buildIceServers({mode, stunUrls, turn})`.
  - **Max-privacy (`max`, default)**: `iceServers = [{urls: <STUN>}]` (or `[]` if no STUN) — **STUN
    only, NO TURN, and creds are NEVER requested** (nothing is allocated on the relay; its STUN port gets
    the network check's one Binding request — § Network check; the peer sees your IP).
  - **Reliable (`reliable`)**: `[{urls: <STUN>}, {urls: <TURN urls>, username, credential}]` — STUN +
    TURN, so a pair that can't connect directly relays through coturn (the relay carries only
    E2E-encrypted bytes). It does NOT hide your IP from the PEER — we signal our srflx candidate in
    every mode, so the peer learns the address whichever pair ICE selects; the relay moves the ROUTE
    (the peer's ISP sees coturn, not us — § Risk 4), not what the peer is told. TURN is added **ONLY when the fetched `urls` is
    non-empty** — empty urls (TURN undeployed) ⇒ STUN-only (we IGNORE username/credential then; relay
    availability is keyed off `urls.length`, never off a credential being present).
- **STUN config**: build-time `VITE_STUN_URLS` (comma-separated → array; `parseStunUrls`). Empty in
  dev/test = no STUN (two loopback tabs use host candidates).
- **NO built-in / third-party ICE fallback (invariant).** `PeerConfig.iceServers` is **required** and
  `PeerConnection` has **no default** — `buildIceServers()` is the ONLY source. A built-in public STUN
  would leak the client's public IP to a host we don't control on every connection, contradicting the
  threat model, so there is nothing to fall back to; `[]` (no ICE servers at all — dev/loopback, or
  Max-privacy with no STUN configured) is a legitimate value and is passed explicitly. (A dead
  `DEFAULT_ICE_SERVERS = stun:stun.l.google.com` fallback lived in `PeerConnection.ts` until it was
  removed: unreachable in the app, but it still shipped as a string in `dist/` — found in a bundle
  audit at deploy. Never reintroduce an implicit default.)
- **Cred fetch (Reliable only)**: `SignalingClient.requestTurnCredentials()` sends `{type:'turn-request'}`
  and awaits the zod-validated `{type:'turn-credentials', urls, username, credential, ttl}` reply (the
  untrusted relay — validated before use). Fetched **after** the WS is up (`welcome` arrived) and
  **before** the PeerConnection is created, so TURN is in `iceServers` from the first ICE candidate:
  `SessionController.ensureTurnReady()` is kicked off at the START of `beginPairing` (runs in parallel
  with CPace/SAS) and `startPeer` awaits the SAME memoized fetch before building the PC. Never throws —
  a closed socket / timeout / absent relay resolves to **NO_TURN (empty urls)** → direct-only. Creds are
  reset per session (`openSignaling`) since they are bound to the live socket.
  **Empty urls is now PROJECTED to the user** (`connection.relayUnavailable`, set from
  `ensureTurnReady`; added 2026-09-19): Reliable silently degrading to direct-only was visible ONLY in
  the DEV diagnostics log, which is tree-shaken out of production — so a user who picked Reliable FOR
  the fallback got Max-privacy connectivity with no indication, and the failure that followed read as
  ordinary bad luck. `FailedScreen` renders `relayUnavailableHint` (EN/RU, testid
  `relay-unavailable-hint`) so the failure names the missing fallback. Always false in Max privacy,
  which never requests creds. `SessionController.relayUnavailable.test.ts` pins it, with both negative
  controls (a relay that IS there, and Max privacy). The built ICE config is
  published to the DEV diagnostics (`dev.iceConfig` — mode/relay/urls/username/credential) for the e2e.
- **Pre-PC WebRTC-signal buffer (mixed-privacy / link-qr deadlock fix)**: because `startPeer` `await`s
  `ensureTurnReady()` BEFORE building the PeerConnection, a **Reliable-mode answerer** is still fetching
  coturn creds when a **Max-privacy offerer**'s offer arrives — so `this.peer` is null and the offer used
  to hit the `this.peer?.handleSignal` no-op in `onSignal` and be **silently dropped** (deadlock). Fix:
  `SessionController.pendingPeerSignals` buffers WebRTC offer/answer/ICE that arrive for the ACTIVE
  pairing (past the `from === this.peerId` gate) while `this.peer` is null, and `startPeer` REPLAYS the
  queue in arrival order right after building the PC (`flushPendingPeerSignals`); ICE that races ahead of
  the offer is re-buffered by the PC's own `pendingIce`, and `setRemoteDescription` doesn't depend on
  `iceServers`, so the "TURN in iceServers from the first candidate" invariant is intact. The buffer is a
  level ABOVE `pendingIce` (whole signals, not just ICE) and is **method-agnostic** — it lives in the
  shared WebRTC tail of `onSignal`, so it closes BOTH the room and the latent link/qr race (words is
  unaffected: its offer is serialized behind the CPace gate, so the PC is already up). CLEARED
  (`clearPendingPeerSignals`) on EVERY teardown/reset/retry — `resetPairingToLobby`, `teardownPeerOnly`
  (words retry), `failLink`, `failSas`, `failReconnect`, `failDirect`, `dispose` — so a stale signal from
  a finished attempt can never replay into the next attempt's PC. Unit-tested deterministically in
  `SessionController.pendingPeerSignals.test.ts` (controllable `ensureTurnReady` + mock PeerConnection:
  offer-while-`peer===null` is buffered → creds resolve → PC built → offer replayed → answer emitted; and
  `resetPairingToLobby` empties the queue).
- **The pairing can END during that fetch, and then nothing is built (fixed 2026-11-23).** `startPeer`
  used to build its PeerConnection whatever had happened while it awaited the credentials — in
  Reliable a real round trip. A words creator whose joiner came and went in that time was left with
  a stale `this.peer` and ignored every later joiner; a lobby member whose pick was answered `busy`
  then answered `busy` to everyone; a session that failed meanwhile held an open connection and got
  "no relay" projected onto its failure screen; a disposed controller carried a connection built
  without the relay filter into its next session (nothing pairs over it — strictness held, the
  session did not). `beginPairing` now counts pairings (`attempt`), and `startPeer`, its error path
  and the credentials reply all check that the pairing — and the socket the credentials were minted
  on — are still the ones (`pairingIsStill`). Unit: `SessionController.relayRetryInPlace.test.ts`, the
  four cases with a TURN reply held back; each fails against the code before the fix.
- **Tests**: `iceServers.test.ts` (builder: max→STUN-only/empty, max ignores TURN, reliable+creds→STUN+TURN,
  reliable+empty-urls→STUN-only, default=max never relays); `tests/e2e/privacy.spec.ts` (toggle renders +
  flips + default max; Max-privacy still connects directly with no TURN; Reliable fetches creds via
  `turn-request` and assembles a correct TURN iceServer — the relay itself is not run, both modes connect
  over loopback). Server `turn-credentials` minting is **done (6d server side)** — see Signaling server §.

##### Max-privacy strict model (done — completes 6d)
**Max privacy never relays unless both users ask for it in that session** — each by their own tap on
"Retry with relay" after a direct failure (below; the owner's decision of 2026-11-23, § Decisions).
No timer, no automatic fallback, nothing the peer or the signaling server can send moves it. Until
then these always-on mechanisms keep a Max-privacy pairing direct, and a direct failure is **terminal**:
- **No local TURN** — Max-privacy never requests coturn creds, so we never offer a relay candidate
  (`ensureTurnReady` is a no-op off Reliable).
- **Strict relay-candidate filter** — the PeerConnection **DROPS the peer's incoming `typ relay` ICE
  candidates** (`PeerConnection.addIce` → `shouldDropCandidate` / `isRelayCandidate`, the only thing
  left in **`src/core/relax.ts`**), so a relay candidate the peer SIGNALS is never added on our side.
  The filter is **fixed at construction** (`filterRelay = privacyMode === 'max'`) — Max-privacy never
  flips it. In Reliable the filter is off (relay allowed).
- **Selected-path check at channel-open (added 2026-09-12 — closes the audit finding).** Mechanisms 1+2
  are NOT sufficient alone: they cover candidates we ADD, not the ones ICE **learns**. A peer relaying
  through coturn sends its connectivity checks FROM the relayed address, and RFC 8445 §7.3.1.3 has our
  agent learn that address as a **peer-reflexive** candidate and pair with it — the same address we
  just dropped as `typ relay`. It bites only when the direct path fails (otherwise the direct pair wins
  on priority), i.e. exactly the case this model exists for, and only in a **mixed-privacy** pair
  (Max ↔ Reliable; Max ↔ Max has no relay anywhere). So the PeerConnection now **verifies the path it
  actually got**: every dropped relay candidate's endpoint is remembered (`relayCandidateEndpoint` →
  `droppedRelayEndpoints`), and at DataChannel open — **BEFORE `onOpen` reaches the SessionController**
  — `openChannelUnlessRelayed` reads `pc.getStats()`, resolves the selected pair
  (`selectedRemoteCandidate`, engine-agnostic: transport `selectedCandidatePairId` → Firefox
  `selected` → nominated+succeeded → succeeded) and refuses via `isForbiddenRemoteCandidate` when the
  remote is typed `relay` OR sits on a dropped endpoint. A refusal takes the SAME terminal path as a
  direct ICE failure (`onIceFailure` → `onIceFailed` → `failDirect` + hint) and `onOpen` never fires,
  so **no byte can cross a relayed path**. A `prflx` remote we never dropped is ALLOWED — legitimate
  NAT mappings produce those on genuinely direct paths.
  **Unavailable/empty stats ⇒ REFUSE (changed 2026-09-13, finding F1).** This used to read "unknown,
  not relay — we never tear down a working connection over a missing API", and that was the hole:
  `selectedRemoteCandidate` returns null until ICE publishes a selection, so the gate waved through
  every path it had simply not looked at yet. Its own docstring already said a caller must read null
  as unknown NEVER as safe, and the condition is real — `SessionController.verifyPath` needed a 5 s
  poll for exactly this, and runs LATER in the session than the gate. So the rule is now POSITIVE:
  **open only on a path established to be direct.** `relax.classifySelectedPath` polls for a
  judgement (`SELECTED_PAIR_TIMEOUT_MS` 15 s — it shipped as 5 s, the constant's comment says why it
  was raised to match `PATH_ATTEST_TIMEOUT_MS` / `SELECTED_PAIR_POLL_MS` 100 ms), retrying on a null read
  so a transient `getStats()` rejection does not decide the session, and anything still
  `undetermined` at the deadline is refused down the same terminal path as a relay. Measured
  2026-09-13: chromium, firefox and webkit each report a selected pair on the FIRST read at
  channel-open (0–1 ms, 3/3 runs per engine), so a healthy connection never waits and the deadline is
  insurance, not latency. `relax.test.ts` covers both pure halves **and the policy** (including the
  reproduction of the old wave-through); the browser-side confirmation is **§ C4** of the test plan.
  - **Residual:** the check runs at channel-open. A mid-session ICE **re-nomination** onto a learned
    relay path (e.g. the direct path dies later) is not re-checked — noted in [security-audits.md](docs/history/security-audits.md) § Security audit.
- **ICE-fail → terminal `failed` + hint**: an ICE failure (`iceconnectionstatechange` /
  `connectionstatechange` → `failed`) while filtering routes to `onIceFailed` (one-shot), which calls
  `failDirect(DIRECT_FAIL_REASON)` → close + `fail()` → the **existing `failed` state** (no new FSM
  state). The `FailedScreen` classifies the reason from its text (like the MITM / room-not-found cases)
  and renders **"Couldn't connect directly"** with the hint that "Retry with relay" continues the
  pairing in Reliable once both sides tap it (i18n `directFailHint`, or `directFailStartOver` where
  nothing can be continued; testid `direct-fail-hint`), and the button itself (below). In Reliable an
  ICE failure with a relay in hand ends the same way under its own reason (the mixed pair, below).
  `DIRECT_FAIL_REASON` (`"couldn't connect directly (Max privacy)"`) is the stable marker the screen
  keys off (`/connect directly|max privacy/`).
- **A pre-transport `peer-left` during a Max-privacy direct attempt ALSO ends as the direct failure
  (since 2026-10-03).** In a Max ↔ Reliable pair across two NATs both ICE agents time out ~15 s after
  `connecting`; when the PEER's gives up first its socket closes and its `peer-left` reaches us before
  our own `failed`, and the Max side used to read "peer left during pairing" — fail-closed, but without
  the one actionable line (test plan C3 on the Pixel 5, 2026-10-02: the hint showed or not depending on
  who lost the race). `SessionController.peerLeftWhileDirectAttempt()` (Max privacy + a PeerConnection
  in flight + channel not open + not established) routes the link/qr, room/SAS and reconnect
  `onPeerLeft` branches through `failDirect(DIRECT_FAIL_REASON)`; **words is excluded** (its peer-left
  is a counted guess with its own retry copy). Unit: `SessionController.sasPeerLeft.test.ts`.
- **"Retry with relay" — the SAME pairing continues through the relay once both users tap it
  (since 2026-11-23; from 2026-11-22 it started a new pairing, which meant a second scan or a second
  code).** After a direct failure each side holds what the retry needs: `failDirect` closed the
  PeerConnection and left the method's secret in place. The direct-failure screen's primary action
  (testid `retry-relay-btn`; "Back home" stays under it) calls `SessionController.retryWithRelay()`.
  - **Consent is each side's own tap, and nothing else.** `retryWithRelay()` is called only from that
    button. The tap also sends the peer one frame over the old signaling socket, `{ kind:
    'relay-retry' }` — a courtesy, so that the peer's failure screen can say "your peer is waiting".
    The frame comes through the untrusted server, so that line is ALL it can do: a forged, repeated or
    late one starts nothing and requests nothing (`connection.peerAsksRelay` is a projection only,
    and it belongs to the engaged peer — it is dropped when a words creator goes back to its words or
    a lobby pairing is reset). No other frame moves a failed side either (§ Signaling WS lifecycle).
  - **Where the two meet: a rendezvous derived from the failed attempt, not the old room.** A room
    on the signaling server lives 3 minutes (words and token rooms from creation, a 4-digit room
    since its last join), and a failed direct attempt has usually spent most of that. So the retry
    never depends on the old socket: both sides compute the same 128-bit token from the two DTLS
    fingerprints of the failed attempt (`relayRetryToken`, `src/core/relayRetry.ts`: SHA-256 under
    its own label, the fingerprints in sorted order) and take that token room, join-or-create — the
    side that taps first waits in it. The fingerprints crossed the server inside the SDP, so the
    token is not a secret and does not need to be: like every rendezvous here it is routing, and the
    server could always put anyone into any room. What authenticates is the next point. A reconnect
    meets there too, not at its own bucket rendezvous: the peer's failed socket still sits in that
    room, and a side arriving there would pair with it — and ask for a relay — before the peer tapped.
  - **Authentication covers the retried transport — what is reused and what is agreed again.** The
    retry builds new PeerConnections, so the DTLS certificates, the fingerprints, the offer and the
    answer are all new, and every method runs its full check over them:

    | Method | Reused from the failed attempt | Agreed again |
    |---|---|---|
    | link / QR | the link secret S | key-confirmation over the new fingerprints |
    | words | the CPace key of the failed attempt | key-confirmation over the new fingerprints |
    | room | nothing | nonces, commit–reveal and the SAS; the two people compare the three words |
    | reconnect | the pin and the pairing secret | fresh challenges; hello → proof → ok |

    **S** is reused because it never left the two devices, has 128 bits, and the confirmation tag is
    a MAC bound to the fingerprints and the role — a second tag under S, over other fingerprints,
    tells an observer nothing about the first. **The CPace key** is reused, and CPace is NOT run
    again, because every CPace run is one guess at the four words: a second run would hand a peer
    who guessed wrong a second guess for the price of one failed connection. The key exists on both
    sides by the time ICE can fail (the initiator starts WebRTC only after CPace). A mismatch in
    the retry ends the pairing; it does not return to the words screen for another joiner. **The
    room** has nothing to reuse — its 4-digit code is public — so the SAS runs from scratch over the
    new fingerprints, and the people compare words for the first time: the failed attempt never
    showed any, the nonce reveal waits for the channel (§ room method). **Nothing secret is sent through
    signaling**, and no new secret is made. The retry's PeerConnection is a new one and takes its one
    description under the one-fingerprint rule like any other (§ Crypto); a description refused there
    ends the retry for good, socket closed, through the method's own teardown (`onPeerTampered`). The
    rendezvous token is derived from the fingerprints that rule validated, and `relayRetryToken`
    folds their case, so the spelling a side holds them in does not move the room.
  - **Strict until both have tapped.** A side that has not tapped stays where the failure left it:
    no PeerConnection, no TURN request. The side that tapped first sits alone in the retry room and
    asks for TURN credentials only when a peer arrives there (`beginPairing` → `ensureTurnReady`, as
    in any Reliable pairing). **The limit this leaves:** "a peer arrived" is the server's word. A
    server that fakes the arrival makes a side that DID tap request credentials and gather relay
    candidates for a pairing that then fails its authentication; it cannot move a side that did not
    tap, and it gains no relayed byte of a transfer.
  - **One retry per pairing.** A retry that fails is terminal, with the ordinary Reliable copy.
    However it ends, the link secret or the CPace key is dropped at once (`fail()`), and one that
    finds no path either closes its socket (`failDirect`). Whichever side's ICE gives up first, the
    other reads "no path" too, not "peer left" (`peerLeftWhileDirectAttempt`) — where a relay was in
    hand: a retry that ran with no relay to use says nothing about one, and its two sides read
    "channel closed" and "peer left" beside the missing-relay hint. A second tap while the retry runs, or after it failed, does
    nothing — starting over is `startOverWithRelay()`, behind its own button.
    The screens read it from `connection.relayRetry`: `offered` (set by `failDirect` when the retry
    was armed — the button continues), `active` (this side tapped: the session is the retry, and its
    failure offers no other), `none` (the button, where there is one, starts over).
  - **Waiting, and when continuing is impossible.** Alone in the retry room the screen says so
    (`RelayWaitScreen`, testid `relay-waiting`: ask your peer to tap "Retry with relay" too; nothing
    is scanned or typed again) for `RELAY_RETRY_WAIT_MS` (120 s). The retry room is closed by the
    server 3 minutes after the FIRST side arrived, never re-armed, so a peer that taps at the end of
    the wait has a minute of signaling left for the offer, the answer, the candidates and (room) the
    two SAS nonces; from the open channel on the socket is not needed (§ Signaling WS lifecycle), so
    two people may take their time over the three words. Then, or at once from "Start over instead",
    comes the fallback, which is the behaviour of 2026-11-22: `startOverWithRelay()` — whoever made
    the invite gets a fresh one in Reliable (a new link, new words, a new room), a reconnect is tried
    again, a joiner lands on the home screen with Reliable selected. The no-show failure
    (`RELAY_RETRY_NO_SHOW_REASON`, variant `retryNoShow`) says that this is what "Start over" does.
    The same wait is what a peer who left, a peer whose page is closed and a peer on a client from
    before 2026-11-23 all look like; the retry itself survives a dead signaling socket and an
    expired room, since it uses neither — a failed session ignores what the server does to its old
    room (§ Signaling WS lifecycle; before that fix an expiring word room took the CPace key with it,
    and the retry of a words pairing died 3 minutes after the words were made). Where the failed
    attempt left no two fingerprints to derive from, the button starts over directly and the copy
    says "starts over". **One edge is left to the fallback:** a room that expires while one side's
    ICE is still trying. That side loses its socket before the channel exists and ends on "expired"
    (words) or "lost the connection to the server", with no retry to offer, while the side whose ICE
    had already given up is offered one that nobody joins. Keeping the first side going would mean
    finishing ICE without the socket that carries its candidates, and failing a room pairing later
    for want of its nonces — a different change, not made here.
  - **What the tap stores: nothing.** The mode changes for the visit (`setPrivacyMode('reliable',
    false)` in `prefs.tsx`): a reload is back on the stored choice. Max privacy is the default
    (§ Privacy modes), and a retry on one bad network is not the user deciding to relay everywhere
    from now on; choosing Reliable on the home screen still stores it.
  - **The Reliable side of a mixed pair** — its ICE fails although it holds a relay, because the Max
    peer drops relay candidates and refuses a relayed path. `onChannelClose('ICE failed')` before any
    channel, with relay URLs in hand, ends every method through `failDirect(NO_RELAY_PATH_REASON)`:
    terminal, socket left open, the retry armed exactly as on the Max side. `FailedScreen` (variant
    `noRelayPath`, testid `no-relay-path-hint`) says that no path worked even through the relay and
    that, if the peer is in Max privacy, they should tap "Retry with relay"; this side's button reads
    "Try again" (same testid `retry-relay-btn`, same `retryWithRelay()`) and takes it to the same
    retry room. It still taps: a session is restarted by its user, never by a frame from the server.
    The copy does not claim to know the peer's mode — the same reason fits a network that blocks UDP
    altogether. For a words creator this is a change: such a failure used to count as a wrong guess
    and return to the words screen; it is now the end of that code, like every other "no path".
    Without relay URLs the reason stays as it was and the missing-relay hint explains it.
    **Two edges fall back instead of continuing.** Where the relay DID reach the Max side — its
    network lets unsolicited packets in — the channel opens, the Max side's selected-path check
    refuses it, and the Reliable side sees a channel close before authentication: "channel closed
    during pairing", which is also what a peer that detected a mismatch looks like, so no retry is
    offered there. And a Max peer that leaves its failure screen before the Reliable side's own ICE
    gives up reaches it as "peer left during pairing". In both the Max side's tap finds nobody, and
    its no-show screen offers "Start over".
- **No escalation of a live connection**: a PeerConnection built in Max privacy is never relaxed.
  The `connection.relax` projection, the `relax` signaling frame, `relaxConnection`/`declineRelax`, and
  the `pc.setConfiguration`/`restartIce` ICE-restart-over-relay were all **removed** and stay removed —
  with them went the whole class of asymmetric relax bugs (incl. the suspected Firefox mixed-privacy
  hang: a Max-privacy side that can't go direct fails fast instead of half-relaxing). "Retry with
  relay" is not that mechanism: it runs after the failure, on new PeerConnections, in a new room.
- **DEV/TEST knobs**: `?forceIceFail=1` (DEV-gated, like `forgeReconnectKey`) makes the PeerConnection
  treat ICE as failed AND suppress its own candidates, driving the Max-privacy-direct-failure path in
  e2e without a real network failure; `?relayRetryWaitMs=N` shrinks the wait at the retry rendezvous.
- **Tests**: `relax.test.ts` (the relay-candidate filter: drops `typ relay` only while filtering, off
  in Reliable, safe on null/empty); `tests/e2e/relax.spec.ts` (`forceIceFail` Max-privacy → both sides
  reach `failed` with the `direct-fail-hint`, no hang; the relayed-path gate, both ways).
  **The retry**: `relayRetry.test.ts` (the rendezvous token); `SessionController.relayRetryInPlace.test.ts`
  — two real controllers against a signaling hub that records every room, frame and TURN request:
  one tap waits and requests nothing; both taps connect link, words (no second CPace frame), room
  (a fresh nonce, the SAS on both sides) and reconnect; a `relay-retry` frame forged, repeated, early,
  from a stranger or late only ever sets the prompt; a peer without the secret, and a joiner that
  guessed the words wrong, fail the confirmation in the retry; the wait runs out into the no-show
  reason and "Start over"; a failed retry offers no second one and leaves no socket, secret or
  timer; a second tap does nothing; the mixed pair; no fingerprints, no offer. From the review of
  2026-11-23: nothing secret reaches the hub in any encoding, as a frame or as a room name; a
  reflected tag, a tag of the failed attempt, a reflected reconnect hello and a replayed CPace frame
  are all refused or unanswered; an approval of the failed attempt's SAS does not carry over; a word
  room expiring under the failure screens leaves the retry working; the retry room expiring in the
  middle of the comparison, or after a link's channel opened, does not end it, and before the channel
  it ends it with the connection closed; a forged join, offer, candidate, `busy` or `pair-request`
  at an untapped failed side — Max or Reliable — starts nothing; frames of a socket that was let go
  reach no later session; the next pairing in Max privacy is strict again; from the second review:
  a words creator whose socket closed under an attempt that then fails (wrong words, or the
  deadline) ends instead of waiting on its words, and connects when the words were right; an entry
  point disposed while its socket was opening fails nothing and the next invite works, also when it
  has already started; a retry without a relay names none; a refused description in
  the retry of a link, words or room pairing fails it closed with no second retry.
  `SessionController.retryWithRelay.test.ts` (the fallback: what each role restarts; the
  Reliable-side reason and its three negative controls). `tests/e2e/relay-retry.spec.ts`, each engine:
  link — both tap, connected in Reliable with a TURN entry, a file arrives, no second link, nothing
  stored; one tap only — no PeerConnection built, the other side still Max, the wait ends, "Start
  over" makes a new link; words; room (straight to the SAS, both confirm); reconnect; the mixed pair
  ("Try again"); a second fingerprint line added to the retry's description — refused as compromised,
  nothing offered again. The e2e has no relay to connect through — that the retried path IS the relay is the
  NAT suite's sixth case (§ The NAT suite). Visual and axe scenes: `failed-direct-retry`,
  `failed-direct-peer-asks`, `failed-no-relay-path-retry`, `failed-no-relay-path-after-retry`,
  `relay-wait`, `failed-retry-no-show`. Reliable's relay actually
  carrying bytes is hush-signaling-server's **`tests/turn-relay.test.ts`** (2026-09-19): it spawns a real coturn
  in the production `use-auth-secret` mode, spawns the signaling server with the SAME secret, mints
  over the WebSocket exactly as the client does and drives `turnutils_uclient` with the reply, so the
  one cross-service invariant — `TURN_SECRET` == coturn `static-auth-secret` — is checked rather than
  assumed. Its NEGATIVE CONTROL mints under a different secret and requires the same relay to refuse
  it (coturn answers `Cannot complete Allocation`), which is what stops the check from passing against
  a relay with authentication switched off. CI installs coturn on every push and sets
  `REQUIRE_RELAY_TEST=1`, which turns "coturn missing" from a skip into a hard failure.
  The measured relay throughput, the live relay limits and its capacity are in § Reference numbers.

#### Network check (`src/core/natCheck.ts`) — can Max privacy work from this network
Max privacy needs each side to be reachable on the address STUN reports for it. A symmetric NAT gives
every destination a new port, so the peer is told one port and reached from another, and the pairing
ends on the direct-failure screen 18–48 s later (§ Platform limits). The mapping is visible from inside
the browser, so since 2026-11-22 the user is told when the pairing STARTS. Advisory, like path
attestation: it refuses nothing and never changes the mode.

- **Mechanism.** One throwaway `RTCPeerConnection` is configured with two STUN destinations — the first
  of `VITE_STUN_URLS` and `VITE_NAT_CHECK_STUN_URL` — so ONE socket asks both for its address. Equal
  answers are pruned by ICE into a single `srflx` candidate; different answers are both reported, on
  one foundation. Nothing is offered to anyone and the connection is closed when gathering ends.
- **Measured before it was built on, 2026-11-22.** A symmetric NAT cannot be had on demand, so two
  local STUN servers answered one socket with two different ports — to the browser that is the same
  thing. Chromium 158, WebKit 27.2 and Firefox 159 each reported two `srflx` on one foundation with two
  ports; one `srflx` when the answers agreed, and one when a server stayed silent. Chromium and WebKit
  name the answering server on the candidate (`url`), Firefox does not; every engine hides the base
  (`raddr 0.0.0.0`). All three also report an IPv6 `srflx` when STUN answers over IPv6.
  The numbers are in the [2026-11-22 run](docs/test-runs/2026-11-22.md).
- **"Two `srflx` on one foundation" alone is NOT the rule** — it was the first one, and WebKit broke
  it: when several connections start in one page it gathers again on fresh sockets, and one connection
  then showed three host candidates and three `srflx` on one foundation with both servers honest. A
  foundation names the base address, not the socket. So mappings are counted against sockets
  (`judgeNat`): the UDP host candidates of the connection, from its candidate events and from
  `getStats()`, give the number of sockets per base address; **more IPv4 mappings on one base than
  the connection has sockets on any base ⇒ `symmetric`**. One socket, one mapping, and both servers
  answering a connection of their own (`stunCheck.probeOne`, asked only then) ⇒ **`direct`**.
  Everything else — a silent server, re-gathered sockets, no host candidate to count against, no
  WebRTC — is **`unknown`**, which is benign and shown nowhere.
- **When.** `SessionController.startNatCheck`, called from `openSignaling`: once per session, on the
  user's action that starts a pairing (an invite, a code, Reconnect, a link opened), in Max privacy
  only, in parallel with the rendezvous. Never on page load. Measured from the home network against
  the live servers: `direct` after 0.4–0.5 s in Chromium and Firefox. A result that arrives after its
  session ended is dropped. Reliable does not ask: its relay covers the case.
- **Projection.** `connection.nat` (`{ verdict, ipv6 }`). Only `symmetric` reaches the screen:
  `NatWarning` (testid `nat-warning`) under the title of the Share, code-words, lobby and reconnect-wait
  screens and on the Connecting screen's key-agreement stage — the joiner's only screen before the
  failure; and `FailedScreen`'s direct variant then names this network as the reason
  (`directFailSymmetric`) and drops the Mac Local Network hint, which is about another cause. `ipv6`
  adds one sentence to the warning: a pair with IPv6 on both sides can connect whatever the IPv4 NAT does.
- **The second destination** is a build-time value from [`build-env.sh`](deploy/build-env.sh), today the
  STUN port of the TURN relay's coturn (`stun:turn.hushsend.frelikh.dev:3478`) — the only other STUN
  listener the deployment has. An empty value, or no STUN at all (dev, tests), switches the check off.
  What asking it means for a mode that promises no relay: § Risk 3.
- **Limits.** It reads THIS side: `direct` says nothing about the peer's network, and a pair fails when
  either side is symmetric. The two destinations share one address and differ in port, so a NAT whose
  mapping depends on the destination ADDRESS only would read `direct`; that needs a second server on
  another address. WebKit can read `unknown` where it should warn, when the pairing's own connection
  starts while it gathers (a joiner). The verdict rests on what two servers answer (§ Risk 3). And the
  warning is about a peer on ANOTHER network: two devices on one network connect on their local
  addresses whatever the NAT does, which the copy says and the check cannot know.
- **Safari.** On an iPhone (Safari 27.2) and on macOS (26.5.2) Safari asks every STUN server from one
  socket, as Chromium and Firefox do — measured 2026-11-23 on a line whose NAT keeps the port
  ([2026-11-23 run](docs/test-runs/2026-11-23.md)) — so the check reads the network there, not the
  browser. The iOS Simulator is the exception: the check reads `symmetric` in it on every network
  (the [test plan](#test-plan--the-real-device-pass-step-6e) says why), so it is not judged there.
- **Verified on a real symmetric NAT** twice (2026-11-23): the NAT suite's case behind a symmetric
  router — Linux netfilter, Chromium (§ The NAT suite) — and an iPhone on a carrier, test plan case C7.
  The decision itself is unit-tested on the candidate lines the engines produced, and the e2e runs the
  whole check in each engine against the two-port servers.
- **Tests**: `natCheck.test.ts` (the parser and the verdict, including WebKit's re-gathered sockets in
  both directions); `tests/e2e/nat-check.spec.ts` (two STUN servers run by the spec, pointed at with
  the DEV-only `?natCheck=<url>,<url>`: nothing asked on page load; a symmetric answer warns on the
  invite screen and is named on the failure screen of both sides; equal answers read `direct` and
  show nothing; a silent server reads `unknown`; Reliable asks nothing); the fifth case of
  `tests/nat/nat.spec.ts` (§ The NAT suite). Visual scenes `share-nat`, `connecting-nat`,
  `failed-direct-nat`.

#### Path attestation (`src/core/pathAttest.ts`) — who is actually on the wire
Authentication answers "is this my peer?"; attestation answers **"is the traffic going to them?"**.
The audit established that no candidate filter can answer the second one: ICE credentials ride the
SDP the untrusted server relays, so it can answer our connectivity checks itself and inject its own
`typ host` candidate at its own address — and a client cannot tell that from the peer's, because the
peer's real address is only ever learned FROM the server. The relay filter (`relax.ts`) refuses
`typ relay`, which stops an honest peer's TURN path, not a server that never offers one.

So the claim moves onto a channel the attacker does not control, exactly as the DTLS fingerprint
binding already does for identity. On `established` each side sends
`{kind:'path-attest', addrs}` over the **authenticated** DataChannel (`startPathAttestation`) and
checks that the remote address ICE actually selected for it (`PeerConnection.selectedRemoteAddress`,
from `getStats()`) appears in the peer's set (`pathVerdict`). An interposer's address is in neither
peer's set, so it is named by the very peer it is impersonating. A forwarding attacker has two moves
and both are caught: pass the real addresses through (→ `mismatch`) or drop the frame (→ nothing
arrives → the 15 s deadline fails the session). A TERMINATING attacker never reaches here — the
fingerprint binding stops it at the SAS / key-confirmation step.

- **Verdicts.** `ok` (selected address attested), `unknown` (nothing to judge on — no selected
  address, or an engine that reports no usable candidates), `mismatch` (checked, and the address we
  selected is in neither of the peer's), and since 2026-09-27 **`relayed`** — decided BEFORE the address
  check from the selected pair's candidate types (`relax.selectedPairRelayed`: our local candidate or
  the peer's remote one is `relay`). Through a TURN relay the address check passes honestly (the
  relayed peer names its relay address), so `ok` used to say "direct path confirmed" about a relayed
  session — proven on Chrome ↔ the Android emulator. Reliable mode only (Max privacy refuses a relayed
  path at channel-open); shown as the muted row "relayed through the server". **All four are advisory:
  none tears anything down.** This
  bullet used to end "`mismatch` → terminal, same teardown as an authenticity failure", which the code
  has never done — and two audits read past it because it was phrased as a specification. Corrected
  2026-09-13 (finding F4) together with the two call-site comments that claimed the attestation
  "gates file bytes".
- **Projection (changed 2026-09-13, finding F2).** The verdict now reaches the USER three-way as
  `connection.pathCheck`, not two-way. It used to be collapsed to `pathConfirmed: 'yes' | 'no'`, so
  `mismatch` — the only positive evidence of an interposer this system can produce — rendered
  identically to `unknown`, the everyday outcome on Safari, under a hint whose stated cause ("this
  browser does not expose enough to check it") is false on a mismatch. Since the DEV diagnostics that
  hold the real verdict are tree-shaken out of production, that left the detection with no
  representation anywhere a user could see it. `mismatch` now has its own label
  (`⚠ route did not match`), its own weight (`hs-badge--alert`) and its own copy, which names BOTH
  causes — honest NAT/Safari quirk, or someone carrying the connection — and gives an action, rather
  than accusing. Still projected DEV-only in full as `dev.pathVerdict` / `dev.pathSelected`
  (`path-verdict` / `path-selected` testids); the user-facing badge carries `data-path-verdict`.
- ⚠️ **ADVISORY — it does NOT tear down and does NOT gate bytes.** It was built as a control (fail
  closed on `mismatch`, gate `sendFiles`/`acceptIncoming`) and the gate was REMOVED after a
  firefox↔webkit pair on one LAN failed it reproducibly **with no attacker present**. The cause is
  structural, not a bug: WebKit cannot disable mDNS obfuscation of host candidates, so it only ever
  offers `<uuid>.local`, its peer learns its real address peer-reflexively, and WebKit therefore
  **cannot attest to the address it was actually reached on**. That is what real Safari does,
  including iOS. A control that fails closed there breaks honest transfers on a primary target
  platform — worse than the leak it closes. Measured, not assumed: with the gate in place
  `interop · firefox → webkit` failed reproducibly, and on the RE-TEST after the "wait for ICE to
  select a pair" fix it failed **intermittently, one run in two** — which is worse, not better, since
  a spurious "someone is in between" both destroys an honest transfer at random and trains the user
  to dismiss the warning that matters. Without the gate, 9/9 interop + 96/96 engine tests pass.
- **What it buys today: evidence.** The verdict is logged and projected, so the real-device pass can
  record what each engine actually reports — precisely the input needed to decide whether this can
  become a control (e.g. by having each side attest the address it SELECTED and checking that against
  our own, which inverts who needs to know what). Tracked in [security-audits.md](docs/history/security-audits.md) § Security audit.
- **Other limits, stated not hidden.** Address only, never the port — plenty of honest NATs vary
  the port per destination, so comparing ports would reject working connections; an attacker sharing
  the peer's IP is therefore not caught. And it rests on the peer's own view of its addresses, which
  for srflx comes from STUN — **the same operator**. An operator that both lies over STUN *and* sits
  on the path can still make the two sides agree; the way to remove that is to stop being the STUN
  provider.
- Pure halves unit-tested in `pathAttest.test.ts`; `tests/e2e/privacy.spec.ts` asserts a real pair
  reaches `ok` on every engine — `unknown` is allowed, so a broken implementation would otherwise
  look exactly like a working one.

### QR (built — step 5b; WASM self-hosted — step 6e)

`barcode-detector` + `qrcode` are installed. Generation: `qrcode` → an SVG QR rendered locally
(`src/ui/qr.ts`, dark-on-light so it scans in either theme). Scanning: `getUserMedia` for the
camera + a detector chosen at scan time (`createQrDetector`, since 2026-10-03 — owner's decision: no WASM
download where the platform decodes QR itself): the browser's own **native `BarcodeDetector`** where it
exists and lists `qr_code` (Chrome on the desktop and on Android), the **`barcode-detector` ponyfill** (the
self-hosted zxing-wasm decoder) everywhere else (iOS Safari, Firefox) — the ponyfill never delegates to a
native detector itself, so the choice is ours (measured 2026-09-27). **Runtime fallback inside the detector**
(`withZxingFallback`): the first native `detect()` that THROWS (an empty frame is not a throw) loads the
ponyfill, switches to it for the session and retries that frame — on Android the native detector lives in
Google Play Services and can be absent or broken, and ScanScreen swallows per-frame errors, so the fallback
cannot live there. The ponyfill is **lazily imported**: its WASM never loads unless a scan needs it. Unit:
`zxingWasm.test.ts` (the choice + the fallback with fakes, next to the ABI gate). **Verified live** (`b73651d`, Chrome
154, fake camera): native detector, connected 1.1 s after the scan tap, no ponyfill chunk and no `.wasm`
requested; with `BarcodeDetector` hidden the ponyfill + the self-hosted `.wasm` loaded and it connected the same. The
owner then scanned by hand on the Pixel 5 and the iPhone 15: works on both (which decoder ran on the Pixel
was not observed). Camera denial/absence falls back to a paste-the-link
input (`src/ui/screens/ScanScreen.tsx`).
- **Self-hosted WASM (no CDN — step 6e):** the zxing reader `.wasm` (the decoder on every engine)
  is **vendored into the build** and served from our OWN origin — it is NEVER fetched
  from a third-party CDN. `barcode-detector@3.2.0`'s default Emscripten `locateFile` would pull
  `zxing_reader.wasm` from `fastly.jsdelivr.net` at scan time (leaking the client IP + executing
  WASM from a host we don't control — a privacy + supply-chain risk). `src/ui/zxingWasm.ts`
  (`createQrDetector`) overrides it: it `import`s the `.wasm` as a Vite **`?url` asset**
  (`zxing-wasm/reader/zxing_reader.wasm?url` → fingerprinted into `dist/assets/`, same-origin) and
  calls `setZXingModuleOverrides({ locateFile })` to point the loader at that asset **before** the
  detector instantiates. Lazy loading is preserved (only the URL string is in the bundle; the
  ponyfill JS + WASM still load only on a real scan, now from `'self'`). **`zxing-wasm@3.1.6`** is pinned
  as a direct dep (exact, matching the copy `barcode-detector@3.2.3` inlines — since 2026-10-25; it was
  3.1.3 / 3.2.2 from 2026-10-02 and 3.1.0 / 3.2.0 before) so the import resolves independent of hoisting. `zxingWasm.test.ts` tests the
  wired `locateFile` (resolves to a same-origin asset, never jsdelivr/fastly) AND, since 2026-10-02, is
  the **ABI gate**: it instantiates the ponyfill's glue with the vendored `zxing_reader.wasm` in Node and
  decodes a real hushsend-link QR, so a glue/wasm version drift fails `vitest` instead of production. ScanScreen calls `createQrDetector()` instead of
  constructing the ponyfill detector directly. **CSP consequence:** `connect-src` no longer lists any
  CDN (see [Deploy](#deploy--the-frontend-and-nginx)).
- **⚠️ Version-coupling — re-check the `zxing-wasm` pin on every `barcode-detector` bump. THIS BIT ON
  2026-10-01:** a dependency refresh (`c5f6e94`) moved `barcode-detector` to 3.2.2 within its `^` range —
  glue zxing-wasm 3.1.3, 78 imports — while the exact pin kept vendoring the 3.1.0 reader (80 imports);
  the live site's scanner then died on every frame with `LinkError: Import #78 "a" "ya": function import
  requires a callable`, swallowed by ScanScreen's per-frame `catch`, on desktop Chrome and on a Pixel 5
  alike, with `tsc` / `vite build` / the e2e all green (found by the 2026-10-02 handset pass, test plan
  A2/B3). The vitest ABI gate above now catches it; the rule still stands. Our direct
  `zxing-wasm` pin MUST stay equal to the version `barcode-detector` inlines internally: at scan
  time the ponyfill's JS expects a `zxing_reader.wasm` whose ABI matches ITS inlined copy, but
  `locateFile` now points the loader at OUR vendored asset. If a future `barcode-detector` upgrade
  silently inlines a DIFFERENT zxing-wasm version, our vendored `.wasm` would be ABI-mismatched against
  the loader JS → QR scanning breaks **at runtime on every engine** (the `.wasm` import still
  resolves and the build still passes — the mismatch is invisible to `tsc`/`vite build`; no native
  `BarcodeDetector` path masks it, since the ponyfill never takes one). So when bumping `barcode-detector`, re-verify
  the exact zxing-wasm version it inlines (e.g. inspect its `package.json`/lockfile entry) and move our
  direct `zxing-wasm` pin to match in the SAME pass, then re-run `zxingWasm.test.ts` and a real
  non-Chromium scan. Keep both pins EXACT (no `^`/`~`).

### UI / styling — stark-ui-kit (required)

Dependency: `"stark-ui-kit": "github:maksimfrelikh/stark-ui-kit#<sha>"` — a public GitHub repo, pinned by
commit (NOT on the npm registry: `npm install stark-ui-kit` fetches an unrelated package). **Current pin:
`f9d9250` = kit 0.3.2** (since 2026-10-03 — quiet touch feedback, § UI → *Touch press*); every consumer's
pin is in the consumers table of the kit's own notes. Bumping the pin needs `npm install`
with the TPM SSH agent (`SSH_AUTH_SOCK=/run/user/1000/ssh-tpm-agent.sock` in a non-interactive shell) —
npm caches a git dep by sha, so the bump IS the install. The rules for changing the kit and how a change
travels live in the kit's own notes; its `README.md` is the consumer contract.
- **The reference is the design canvas** (the owner's, not public; implemented 2026-09-26).
  Its `project/canvas.json` places the boards,
  `project/<Name>.dc.html` is one board (Main, HomeEmpty, Method, Share, Scan*, WordsRead*, WordsEnter*,
  Lobby*, SasReader*, SasPicker, Connecting, ReconnectWait, Transfer*, Failed*, KeyChanged; Dark /
  Desktop / Tablet / Stress / Zoom suffixes are the same screens at other themes and widths),
  `Components` names the kit token for every element, `Checks` is the per-screen WCAG 2.2 AA table.
  **Take composition, hierarchy, states and copy from the boards; take every VALUE (colour, type,
  spacing rhythm, radius, motion) from the kit's tokens, never from the artboards** (kit rule 6).
  The old HTML prototype that used to live under `uploads/design-reference/` was DELETED on
  2026-09-26 (with its drifted `_ds/` token copy) — the canvas is the only reference.
- **Design language = "Stark"**, kept as a design system generated from the reference site
  frelikh.com (the owner's, not public: brand book, tokens, kit + site components). Values come from the kit, never from there either.
- **Imports, in this order, once, at the app root (`src/main.tsx`):** the two webfonts
  (`@fontsource-variable/archivo/wght.css`, `@fontsource/ibm-plex-mono/{400,500,600}.css` — the
  families `theme-mono.css` names, self-hosted through the bundle because the CSP allows `font-src
  'self'` only), `stark-ui-kit/styles.css` (tokens + a11y base), `stark-ui-kit/theme-mono.css` (the house
  palette — the ONLY source of every `--brand-*` value; **this app declares none of its own**), the
  three kit component stylesheets the screens adopt — `controls.css` (`.pill`: the lozenge and its ink
  inversion on hover / press; the app's `.hs-pill` adds the boards' geometry on top), `theme-toggle.css`
  (`.theme-toggle`, the half-filled circle; `app.css` sets `--theme-toggle-flip: 180deg` on
  `[data-theme="light"]` and the button keeps `aria-pressed` = light active), `layout.css` (`.wrap`: the
  column — its `padding-inline: var(--gut)` IS the design's 20 / 34 / 72 gutter at 375 / 680 / 1440;
  `.hs-main` sets `--maxw` to `calc(520px + 2 * var(--gut))` — the design's 520px column of CONTENT with the
  gutter outside it; `.wrap` is a border-box, so a bare `520px` had put the gutters inside and left 376px at
  1440 / 452px at 680 until 2026-10-03) — then `src/ui/app.css` (the app
  component layer). A colour or font value is changed in the kit and arrives here by a pin bump, never
  by an override in this repo. `links.css`, `lang-switch.css`, `prose.css`, `command-palette.css` are
  not imported (nothing renders them). Nothing was promoted INTO the kit (kit rule 5: two consumers).
- **Strictly MONOCHROME — there is NO accent colour, no shadow, no gradient, no illustration.**
  Emphasis / selected / danger is the single ink-INVERSION language: `--ink` on `--ink-fg`. The
  key-changed hard stop inverts the WHOLE viewport (`.hs-app--inverted` re-reads every semantic token
  from a swapped set). Do not add any colour/accent token, ever.
- **Theme is switched via `[data-theme]` on `<html>`.** `index.html` ships `data-theme="light"` on
  `<html>` so the first paint is light; `prefs.tsx` then reflects the stored choice (`hushsend.theme`,
  default light) from an effect. The attribute must stay in `index.html`: `theme-mono.css` follows
  `prefers-color-scheme` only when the attribute is ABSENT, and without it a dark-OS browser would paint
  the pre-hydration frame dark and then cut to light. The switch itself is a CUT — `prefs.tsx` sets
  `data-theme-switching` around the flip and the kit zeroes all transitions for that frame (asserted by
  `visual/tokens.spec.ts`). An OS-following default would need an inline script before the bundle,
  which the CSP (`script-src 'self'`, no inline) forbids — not planned.
- **Values: kit tokens only.** Semantic colours `--bg` / `--fg` / `--muted` / `--faint` / `--line` /
  `--line-2` / `--ink` / `--ink-fg` (+ `--scrim` / `--tap-highlight` / `--scroll-shadow`); radii `--r-*`;
  the fluid type roles `--t-h1/h2/h3/lead/body/meta` — with the two display roles CAPPED for this
  app's ~520px column (`--hs-t-h1: min(var(--t-h1), 3rem)`, `--hs-t-h2: min(var(--t-h2), 2rem)` in
  `app.css`: `--t-h1` is sized for a full-width hero and reaches 73.6px at 1440 where the boards show
  48, so the h1 keeps the role's own 38.4px at 375 and stops at 48px from 1200px up; the h2 stops at
  32px; the rule is "the kit role is the source, the cap says where its curve stops here"), weights
  `--w-*` + the label system `--label-*`; fonts
  `--font-grotesk` / `--font-mono`; rhythm `--gut` / `--maxw`; motion `--ease-*` / `--dur-*`.
  Derived, not invented: the wash behind quiet pills / rows / the file zone is `--fg` at 4 % light /
  9 % dark (`--hs-wash`, the same mixes the kit uses for its focus tint and active row), the inactive
  mode title is `--fg` at 45 %. Three literal display caps are the owner's decisions for 200 % text
  zoom: room code `min(132px, 35vw)`, code words `min(44px, 11.7vw)`, phrase `min(56px, 15vw)`. The
  mode titles are weight **700** (the one weight outside the kit's 600 — the board asks for it, and axe
  counts 19px text as large only when bold). Control geometry (heights, paddings, gaps) is literal px
  following the boards — the kit has no spacing scale. `prefers-contrast: more` is the kit's palette;
  the app carries no contrast overrides.
- **Touch press (2026-10-03, kit 0.3.2):** the KIT owns it — `theme-mono.css` sets the house
  `--brand-tap-highlight: transparent` (iOS painted the fg-10 % highlight across whole rows), and
  `controls.css` gives `.pill` / `.btn` a quiet fg-10 % press with no transition under `(hover: none)` instead
  of the ink inversion (the hover language; on a finger it was a black flash). This app adds nothing of its
  own for touch — the first fix (`ff862a4`, app-level) was folded into the kit the same day. Owner's option (b).
- **Control edges:** `--fg` at rest where the edge alone identifies the control (text inputs, the room
  code input, the five word fields, phrase cards, the file zone); `--line-2` where a label identifies it
  (pills, method / device / peer rows). Focus is the kit's 2px ring; on fields it sits ON the edge
  (offset −1) so the field reads as one thicker line.
- **Screen pacing (owner, 2026-09-28 — do not relitigate):** the four pre-connection states never flash
  a screen. `screens/pacing.ts` (pure, unit-tested) + `usePacedScreen` (in the `Shell`, so the
  key-changed inversion follows the SHOWN screen): when the FSM leaves a screen for `creating` /
  `joining` / `pairing` / `confirming`, that screen is HELD `HOLD_MS` (400) — `<Screen>` gets `inert`
  from the `ScreenBusy` context and every control on it takes the disabled-pill look (app.css "held
  screen"; the pressed SAS card and the checked mode keep their state) — the owner's marker that the
  tap registered and something is happening; if the FSM settles within the hold, the next screen
  replaces it directly. Only a stage that outlasts the hold brings up `ConnectingScreen`, whose stage
  titles stay (owner) but paced: each title ≥ `TITLE_MIN_MS` (500), the screen leaves only after its
  title had that long, a stage over within `STAGE_SETTLE_MS` (150) never gets its title. A hold before
  the app's first frame (a link opened straight into `joining`) is an empty column, not the unseen
  Home. Measured on the live build before the change (2026-09-28, real Chrome, a MutationObserver
  recorder on both sides): a direct pair ran through every stage in 30–215 ms and a relayed one in
  0.3–1.5 s. Live with `273e9e7` (2026-09-29, a LAN that night at ~60 ms to the server, so every
  stage took 2–5× longer): nothing flashed — a run under the hold went from the held screen straight
  to the next one, a longer one showed the Connecting screen for 500–650 ms, and "Verifying…" (2–20 ms
  stages) never appeared. Only the DISPLAY lags: the FSM,
  the store and `data-testid="status"` are untouched, and `connected` is shown only while the status
  is `connected`. Visual scenes that end in a stage wait for the Connecting screen; the held looks are
  the `method-held` / `share-held` / `sas-picker-held` scenes (DEV knob `__HUSHSEND_SCREEN_HOLD_MS__`).
- **Screen set (the decisions taken with the owner — do not relitigate):** base width 375, breakpoints
  680 (top bar 56 → 64, gutter 20 → 34) and 1440 (gutter 72). Link and QR are ONE screen (Share: QR +
  link + Copy + Share); no "Waiting for your peer…" copy anywhere, waiting is implied — the one line a
  waiting screen can gain is the network check's warning (§ Network check). Home: h1, the
  Max privacy / Reliable two-word radio group with a one-line description, Invite someone, the room
  code form, Enter code words / Scan a QR code, a Reconnect section (paired devices, per-device
  Reconnect + a per-device × that forgets every pin of that peer — `recentDevices.forgetDevice` — and
  the global "Forget pinned devices"), then "About privacy and security" as collapsible details. Room
  lobby: the 4-digit code is the hero, Copy code, the roster ROWS are the tap targets, the busy reply is
  a one-time notice line above the roster (role=alert). Code words: read = five numbered mono words,
  the attempt line after a wrong guess, NO copy button (spoken, never pasted); enter = five fields with
  a listbox of up to three prefix matches on touch and inline completion (Enter / Tab) on pointer,
  "No matching word" under the active field, Connect enabled at five words. SAS reader: the phrase is
  the largest text in the app and the sentence "Only continue once you have HEARD your peer say these
  words back." sits directly above the confirm button (the only gate on this side); picker: three
  phrase cards as buttons with aria-pressed, selected = inversion. Transfer: the only happy-path status
  is the heading "Secure channel open" (the verified text stays in the DOM as sr-only `auth-state`);
  the path check renders as disclosure rows ONLY in the non-ok states ("direct path not confirmed"
  muted, "route did not match" and "address servers disagree" fg + glyph, each opening its hint); one
  transfer = one row, one progress bar, one Cancel; delivered / declined / cancelled / error in the same
  container, then "New transfer" — on Safari a received file's row also says to answer Safari's own
  download question (`download-prompt-hint`, since 2026-10-11 — transfer.md). Failed is ONE screen with
  variants (compromised, room not found — or, since 2026-10-11, "this link expired or was already used" /
  "these words don't work any more" for those methods, which have no digits to check — nobody came,
  verification interrupted with "Restart verification", direct failed (± this network named as the
  reason — § Network check) with "Retry with relay" (± "your peer has tapped it"), no path even through
  the relay (with "Try again" while the pairing can continue), the peer did not join the retry (with
  "Start over"), ± relay hint, this browser can't send files (no WebRTC), generic, words with "New
  words"). "Retry with relay" — "Try again" on a side already in Reliable — is the one retry there
  is, because it changes what failed: the mode. Tapped first, it waits on `RelayWaitScreen` for the
  peer's tap (§ Max-privacy strict model). A browser without WebRTC
  never reaches the app: App.tsx shows the same "This browser can't send files" page instead
  (`NoWebRtcScreen`) and a link opened there is scrubbed but not followed. Header: the existing Wordmark + the kit toggle.
  **SAS refusals — EQUAL WEIGHT (the 2026-09-12 audit decision, restored the same day the redesign
  briefly composed them as a tertiary label):** "Stop — they don't have this phrase" and "None of these
  match — stop" are quiet pills with the SAME geometry as the confirm (the kit's `.pill`, 52px, full
  width) directly under it. A small "stop" biases the human toward confirming, and the confirm is the
  only gate on the reader side — this is the one place the boards are overruled.
- **Language: ENGLISH ONLY for now.** `i18n.ts` keeps the table, `ru` is optional with a fallback to
  `en`, new strings get `en` only, and the header shows no EN|RU switch until the Russian half is
  complete (§ Deferred). Copy is the owner's placeholder, taken from the boards as-is.
- For focus-trap, scroll-lock, and copy-to-clipboard use the kit's hooks/utilities — do not reimplement.
  `copyToClipboard` imports from the root `stark-ui-kit` entry (the only kit JS this app uses today);
  `useFocusTrap` / `useScrollLock` live on `stark-ui-kit/react` — import them from there when a screen
  needs them (no dialog exists in the app today).
- **Gates** before a UI change is done — the e2e, the axe gate (`tests/a11y/`) and the screenshot gate
  (`visual/`): § Before a change is done.

## Deploy — the frontend and nginx

This section is the runbook for this repository's part: the static SPA and the nginx vhost (TLS, the
`/ws` proxy, security headers). Signaling, the TURN relay and STUN deploy from their own repositories
(§ Run it has the three).

The signaling server is **untrusted** — all confidentiality/authenticity is client-side (SAS / PAKE /
DTLS) — so what is deployed here is transport security (TLS), routing (nginx) and the bundle whose
integrity anyone can check (§ Verifying what you were served). Artifacts: [`nginx.conf.example`](deploy/nginx.conf.example),
[`build-env.sh`](deploy/build-env.sh), [`deploy-frontend.sh`](deploy/deploy-frontend.sh), [`verify-bundle.sh`](deploy/verify-bundle.sh).

---

### Live instance — as deployed (hushsend.frelikh.dev)

First bring-up **2026-06-20** on a VPS; **2026-08-16 … 2026-10-17** on the owner's home server
(laptop-server, behind a residential NAT); since **2026-10-17** on the owner's VPS **netcup**
(`62.83.23.26` + IPv6, the public address is on the interface — no NAT, no router). The box itself —
network, firewall, other services, secrets, deploy history — is described in the owner's private
`netcup/` notes, not here.

| | |
|---|---|
| OS / nginx / Node | Ubuntu 26.04.1 · nginx 1.28.3 · Node 26 LTS from NodeSource's `node_26.x` apt repo (`/usr/bin/node`; unattended-upgrades applies its releases — v26.13.0 on 2026-10-28; 24 before, 22 at the move) |
| Frontend | build clone `/opt/hushsend` (root), built on the server by `bash /opt/hushsend/deploy/deploy-frontend.sh` → `/var/www/hushsend/dist` |
| nginx vhost | `/etc/nginx/sites-available/hushsend` from [`nginx.conf.example`](deploy/nginx.conf.example): static `dist/`, SPA fallback, `/ws` + `/health` → `127.0.0.1:8080` with `X-Real-IP`; security headers repeated in every location (verified 6/6 on HTML, JS and `.wasm`, 2026-09-17); `access_log off` everywhere; HTTP/2 on |
| What the box records about a visitor (audited 2026-11-22) | nginx: no access line for this vhost, port 80 included (the redirect block logged until that day); a FAILED request lands in the shared `error.log` with the client address, kept 14 days. The signaling service prints its start-up line only (journald, one month). Both coturn containers run with Docker's log driver `none`. ufw logs BLOCKED packets with their source address (four weeks) — nothing a client sends to an open port. fail2ban reads nginx's access log, where this vhost writes nothing. |
| TLS | the box's wildcard `*.frelikh.dev` (certbot DNS-01, Cloudflare plugin; issued on netcup 2026-10-17) |
| Build-time env | [`build-env.sh`](deploy/build-env.sh): `VITE_SIGNALING_URL=wss://hushsend.frelikh.dev/ws`, `VITE_STUN_URLS=stun:stun.hushsend.frelikh.dev:3479`, `VITE_NAT_CHECK_STUN_URL=stun:turn.hushsend.frelikh.dev:3478` (§ Network check) |
| Signaling + TURN | `hushsend-signaling.service` + `coturn.service` — see section 0 of hush-signaling-server's `deploy/DEPLOY.md` |
| STUN | hushsend-stun-server since 2026-10-10 (on netcup since 2026-10-17): `stun.hushsend.frelikh.dev:3479` on this same box (`hushsend-stun.service`, STUN only, no relay, no logs) — section 0 of its `DEPLOY.md`. The TURN relay's coturn still answers STUN on 3478 (a TURN server cannot switch that off); the client asks it one thing only, as the second destination of the network check (§ Network check) |
| ufw | 80/443 tcp (nginx), 3478 tcp+udp and 49160–49200 udp (TURN), 3479 udp (STUN); no router — the public address is on the interface. DNS (Cloudflare, DNS only): explicit records, A+AAAA for `hushsend` and `stun.hushsend`, **A only** for `turn.hushsend` — the TURN relay listens on IPv4 only |

**Repeat frontend redeploys** (signaling/nginx unchanged): `bash /opt/hushsend/deploy/deploy-frontend.sh`
(as root) pulls and starts itself again — so the script and the `build-env.sh` it reads are the pulled
ones — then `npm ci`, builds with the live `VITE_*` baked in, and publishes `dist/` to
`/var/www/hushsend/dist`. It restarts nothing (a static-asset swap needs no restart), runs as root so `sudo` never enters
the picture, and swaps the new build in with a rename: the
previous one stays as `dist.old` until the smoke check passes, so a rollback is
`mv dist dist.bad && mv dist.old dist`.

---

### Build the SPA (with production env)

Vite bakes `VITE_*` in at **build time** — there is no runtime client config.

```sh
# In the repo root. The values live in deploy/build-env.sh — the SAME file the CI build job
# sources, so the hashes CI publishes describe the bytes you produce. Override from the environment
# for a fork or a staging host; do not fork the file.
. ./deploy/build-env.sh
npm run build            # = tsc --noEmit && vite build → emits dist/
```

> **Do not inline the VITE_* values here again.** They are compiled INTO the bundle, so they are part
> of its identity: a bundle built with a different signaling URL is a different bundle with a
> different hash. Two copies that agree today drift tomorrow, and the drift looks exactly like
> tampering to anyone verifying the site.

The build is **byte-for-byte reproducible**, and that is load-bearing rather than a nicety — see
§ Verifying what you were served. `deploy/deploy-frontend.sh` does all of the above plus the publish and
prints the hashes it deployed.

> **GOTCHA — STUN is not optional cross-network.** Default privacy mode is **Max-privacy**, which is
> **STUN-only** (no TURN). With `VITE_STUN_URLS` empty, Max-privacy has *no* ICE server
> at all → two peers on different networks can't discover routable candidates and **never connect**
> (loopback tabs work on host candidates, masking this in dev). Always set `VITE_STUN_URLS` to your
> coturn STUN for a real deploy.
>
> **GOTCHA — rebuild on host change.** `VITE_SIGNALING_URL` is compiled in; if you move hosts you
> must rebuild, not just edit nginx. It must match the nginx server_name in the CSP `connect-src`.
>
> **`VITE_NAT_CHECK_STUN_URL` is the network check's second STUN destination** (§ Network check): any
> STUN listener other than the first of `VITE_STUN_URLS`. Empty switches the check off; nothing else
> depends on it.

Deploy the resulting `dist/` to the nginx `root` (e.g. `/var/www/hushsend/dist`).

---

### Signaling server and TURN relay

Both live in [hush-signaling-server](https://github.com/maksimfrelikh/hush-signaling-server) — install,
updates (`deploy/deploy.sh`), the TURN config (`deploy/turn/install.sh`, which renders coturn's
`static-auth-secret` from the signaling `TURN_SECRET` so the two cannot drift) and the relay check
(`deploy/turn/verify-relay.sh`). Until 2026-10-03 this repo carried a copy of the server in `server/`
and the coturn template in `deploy/`; both had drifted from what ran and were removed.

What this side has to get right is the pairing with nginx: `TRUST_PROXY=1` in the signaling `.env`
needs `proxy_set_header X-Real-IP $remote_addr;` in `location /ws` (§ nginx), or every client looks like
127.0.0.1 and the per-IP limits collapse.

### STUN

[hushsend-stun-server](https://github.com/maksimfrelikh/hushsend-stun-server): coturn with `stun-only`,
its own unit and installer, meant to end up under a different operator than signaling. Clients are
pointed at it by `VITE_STUN_URLS` in [`build-env.sh`](deploy/build-env.sh) — a build-time value, so switching
means a rebuild and a frontend redeploy.

---

### nginx (TLS + SPA + WS proxy)

Use [`nginx.conf.example`](deploy/nginx.conf.example) → `/etc/nginx/sites-available/`, symlink into
`sites-enabled/`, fill `<PLACEHOLDERS>`, then `nginx -t && systemctl reload nginx`.

- **TLS:** `certbot certonly --webroot -w /var/www/certbot -d hushsend.frelikh.dev`; point
  `ssl_certificate{,_key}` at the issued files; the `:80` block keeps the ACME path servable for
  renewals.
- **`proxy_set_header X-Real-IP $remote_addr;` in `location /ws` is the #1 footgun** — pair it with
  `TRUST_PROXY=1`. Without it `clientIp()` falls back to `socket.remoteAddress` = loopback for *all*
  clients: `MAX_CONNS_PER_IP` becomes a single global cap and the 4011 rate-limit (loopback-exempt)
  silently never fires.
- **`proxy_read_timeout` must be well above the 30s WS heartbeat** (template uses `3600s`) or nginx
  severs idle-but-alive signaling sockets mid-rendezvous.
- The WS `Upgrade`/`Connection` headers + `proxy_http_version 1.1` are required for the handshake.
- **`.wasm` must be served as `application/wasm`** — the template pins it with a defensive
  `location ~* \.wasm$ { default_type application/wasm; … }`. The QR-scan fallback (iOS/Firefox, no
  native `BarcodeDetector`) compiles the self-hosted zxing `.wasm` via
  `WebAssembly.instantiateStreaming()`, which **rejects** any Content-Type other than
  `application/wasm`. A stock/modern `mime.types` already maps it, but an old or trimmed one serves it
  as `application/octet-stream` and the streaming compile silently degrades (or errors). Confirm with
  `curl -sI https://hushsend.frelikh.dev/assets/<zxing>.wasm | grep -i content-type` → `application/wasm`.
- The security headers (HSTS / **CSP** / Permissions-Policy / nosniff / Referrer-Policy) are in the
  template — **see the CSP gotcha in step 6.**
- **HTTP/2 syntax is nginx-version-sensitive.** The template enables HTTP/2 via the `http2` PARAMETER
  on `listen 443 ssl http2;` — portable across nginx 1.9.5+ (incl. the 1.24 on Ubuntu 24.04). The
  standalone `http2 on;` directive is **nginx ≥ 1.25.1 ONLY** and errors as `unknown directive
  "http2"` on 1.24; if you hit that, your template predates this fix.

---

### DNS

- `hushsend.frelikh.dev` → the **web host** (nginx).
- `turn.hushsend.frelikh.dev` → the **TURN relay** (the host in the signaling `TURN_URLS`).
- `stun.hushsend.frelikh.dev` → the **STUN server** (the host in `VITE_STUN_URLS`).
  DNS only, no Cloudflare proxy: the proxy carries HTTP, not UDP.

---

### Smoke test

1. **Health:** `curl https://hushsend.frelikh.dev/health` → `ok` (proxied to Node).
2. **SPA:** load `https://hushsend.frelikh.dev` over HTTPS; it renders; HTTP redirects to HTTPS.
3. **WS:** open it in two browsers — DevTools → Network → WS shows a `101 Switching Protocols` to
   `/ws` and `welcome` frames.
4. **Transfer (Max-privacy / direct):** create on one browser, join on the other, complete the SAS,
   send a file. This exercises STUN + direct P2P (no relay).
5. **Reliable / relay:** flip the toggle to Reliable. The client fetches creds (`turn-request` →
   `turn-credentials`) and adds the TURN iceServer.
   > **GOTCHA — a relay path can't be proven on one network.** Two peers on the *same* LAN connect
   > directly even in Reliable (relay is only used when direct fails). To actually verify bytes flow
   > through coturn you need two peers on **different networks** (e.g. one on mobile data) or a forced
   > relay (`forceIceFail` is DEV-only and not in the prod build).
   >
   > **So confirm the relay itself, separately — one command, and it is not optional:**
   >
   > ```bash
   > bash /var/www/hush-signaling-server/deploy/turn/verify-relay.sh
   > ```
   >
   > It mints a credential from the LIVE signaling server exactly as a browser does, opens a real
   > allocation on the coturn that `TURN_URLS` advertises, and requires bytes to come back. This is
   > the only check that catches `TURN_SECRET` drifting from coturn's `static-auth-secret` — a drift
   > that leaves every visible symptom green (the mint succeeds, the client builds a TURN iceServer,
   > the UI still says Reliable) and breaks the relay only for the users whose direct path already
   > failed. Run it after every deploy and after touching either config. It never reads or prints the
   > secret. (The same invariant is pinned in hush-signaling-server's CI by `tests/turn-relay.test.ts`,
   > against a coturn it spawns itself — but CI cannot see THIS host's config.)
6. **Per-IP accounting works (not loopback-collapsed):** the signaling server's `[config]` line shows
   `trustProxy=on`; confirm distinct clients are counted per-IP (the caps/4011 limiter act
   per-client, not as one global loopback bucket).

> **GOTCHA — CSP must be verified against the built app, especially the QR-scan path.** The CSP in
> the nginx template is tuned to the current Vite build (external module script + external
> stylesheet, no inline script). Walk **every screen with the DevTools console open** and watch for
> `Refused to …` violations — **above all the QR-scan screen on a non-Chromium browser** (iOS
> Safari / Firefox), where the `barcode-detector` ponyfill compiles zxing **WASM**. The WASM is now
> **self-hosted** (vendored into `dist/assets/` via a Vite asset import — `src/ui/zxingWasm.ts`
> overrides zxing's `locateFile`), so it loads from `'self'` and the CSP needs **no CDN**:
> `connect-src` is `'self' wss://<host>` only, and `'wasm-unsafe-eval'` stays (it permits compiling
> the self-hosted WASM, not fetching it). A QR scan therefore never reaches `fastly.jsdelivr.net`
> (verify in the DevTools Network panel — no jsdelivr request) and `camera=(self)` in
> Permissions-Policy must be present; if the scanner or camera breaks, the console error names the
> directive to adjust. This dovetails with the 6e cross-browser pass (real-device test post-deploy).

---

### Deploy notes

- **Shared-NAT / office / mobile networks:** clients behind one public IP divide `IP_RL_MAX` per
  window and can hit a spurious `4011 too many attempts`. The knob is in the signaling `.env`
  (hush-signaling-server); § Pre-launch review has the open question.
- **Second app (hushclip):** the same signaling server serves it (distinguished by `?app=`); add an
  analogous nginx site (own cert + `dist/`, same `/ws` proxy) when its frontend exists — see the
  footer of `nginx.conf.example`.
- **Secrets:** none in this repository. The signaling `.env` (with `TURN_SECRET`) lives in the
  signaling checkout on the host; coturn's copy is rendered from it there.

## Test plan — the real-device pass (step 6e)

Everything that can be verified without physical devices is done (unit + integration + Playwright
e2e across four engine projects, feature-detection review, self-hosted QR WASM); what remains is
**behaviour on real browsers, real networks, and real NAT**.

**Status (2026-10-03): DONE — 47 of 47 cases ticked or closed with a reason.** The runs are recorded one
file per day in [docs/test-runs/](docs/test-runs/README.md), together with how the pass progressed. The
ticks in § Preconditions are PRECONDITIONS, not cases; do not read them as
progress.

- **Target:** the live deploy — `https://hushsend.frelikh.dev` (production build).
- **Scope:** the real-device half of step 6e — in-browser P2P / SAS / transfer on two devices and the
  cross-network TURN relay ([step6-hardening.md](docs/history/step6-hardening.md) has what came before).
- **Out of scope:** the open security items (§ Security — open). Reconnect is
  codeless since 2026-09-25 — there is no reconnect code to mix with a plain room join any more.

> **Plan currency.** Cases B7, B8, C6 and E6 were added on 2026-09-18 for behaviour that landed
> after this plan was first written (STUN cross-check, the network-exposure disclosure, volume
> padding, and the reconnect early-frame fix); Phase E was rewritten on 2026-09-25 for the codeless
> reconnect (E3/E4 changed meaning, E7 added). If you are reading this after further changes, check
> `git log --oneline -- src/` against the date above before trusting the coverage: a device pass that
> silently skips a new feature is worse than one that has not run.

### Before you start

The preconditions, how to observe, the reference numbers to judge "expected" by, the device inventory
and how the pass is run. The cases themselves (A1 … F9) follow in the phases below; the runs are
recorded in [docs/test-runs/](docs/test-runs/README.md).

#### No diagnostics in production

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

Last run 2026-10-13 against the bundle fetched over HTTPS from the live host (`index-DMFBuANo.js` + the lazy `ponyfill-DUnUwklG.js`, `afaabd4`): no globals, and 1 + 1, both in the entry chunk. (The ponyfill chunk does contain the string `fastly.jsdelivr.net` — its default `locateFile`, overridden at runtime; B3 is where it must never be requested.) **Re-run it after any deploy** — do not trust this line. Every build renames the bundle, so naming a hash here only guarantees the note goes stale; what the host is serving right now is
`grep -o 'index-[^"]*\.js' /var/www/hushsend/dist/index.html`. So:

- **Failure injection is NOT available on prod** — those paths are covered by e2e. This pass observes
  *real* behaviour only. If a fault path needs driving deliberately, do it against `npm run dev`
  locally, not against the live host.
- Observation comes from browser devtools + server logs (§ How to observe).

#### Preconditions

- [x] Frontend redeployed from current `main` (`bash ~/projects/hushsend/deploy/deploy-frontend.sh`)
      — 2026-10-13 ~18:56 UTC, commit `afaabd4` (the 2026-10-11 pre-launch fixes —
      [history](docs/history/pre-launch.md)). `/var/www/hushsend/dist` is byte-identical to a clean local
      build of `afaabd4` (42 files, equal sha256 manifests) and the public URL serves
      `index-DMFBuANo.js`. Checked live the same evening in a Chromium browser: the home page carries
      the VPN advice; a well-formed link whose token room nobody holds fails at once as "This link
      expired or was already used", fragment scrubbed; with `RTCPeerConnection` deleted and the served
      entry module evaluated again, the page is "This browser can't send files", a link fragment is
      scrubbed and no WebSocket is opened. The signaling server's running copy is unchanged at
      `112c37f`. **Re-run it if `main` has moved since**, and re-tick — this tick is only worth the
      date next to it (it went stale twice: ticked 2026-09-12 and 2026-10-03, `main` moved, nobody
      re-ticked). The earlier redeploys and what each was checked with:
      [followups-and-ops.md](docs/history/followups-and-ops.md) § Frontend redeploys checked live.
- [x] **Verify the new bundle is live:** `grep -r 'stun.l.google' /var/www/hushsend/dist` returns
      nothing — re-confirmed 2026-10-13 for `index-DMFBuANo.js` (on the clean build the live dist is
      byte-identical to, and on the served chunks) (the pre-2026-09-12 bundle matched; this was the
      backlog's "verify after redeploy" item). The only STUN in the served bundle is
      `stun:stun.hushsend.frelikh.dev:3479` — hushsend-stun-server since 2026-10-10, on the same box, so
      one operator still holds app, signaling and STUN (§ Security — open).
- [ ] Hard-refresh every test device (Ctrl/Cmd+Shift+R; on iOS: close the tab and reopen) so no
      device runs the cached old bundle. Confirm the asset hash in devtools matches the deployed one.
- [x] `curl -s https://hushsend.frelikh.dev/health` → `ok`; nginx / hushsend-signaling / coturn /
      hushsend-stun all `active` — 2026-10-13 (`/health` from the Mac; `systemctl is-active` over SSH).
      Worth the date only.
- [x] **The relay actually relays:** `bash /var/www/hush-signaling-server/deploy/turn/verify-relay.sh` (the script lived in this repo's `deploy/` until 2026-10-03) → OK — 2026-09-27 on the server:
      16 messages relayed, 0 lost, average RTT 30 ms. Worth the date only. `coturn` being `active` does
      NOT mean Reliable mode works — if its `static-auth-secret` and the signaling server's
      `TURN_SECRET` have drifted, the mint still succeeds and only the allocation fails, so case C5
      (cross-network relay) would fail for a reason that has nothing to do with the devices in front
      of you. First verified 2026-09-19 (the same 16 / 0).
- [ ] **Hairpin NAT check** — the box is behind a residential NAT, so LAN devices reach the public
      hostname only if the router hairpins. Open the site on one LAN device and one LTE device before
      starting; if a LAN device cannot load it, that is a router issue, not an app bug.

#### How to observe

| What | Where |
|---|---|
| Selected ICE candidate pair (`host` / `srflx` / **`relay`**) | Chrome: `chrome://webrtc-internals` · Firefox: `about:webrtc` |
| iPhone Safari console/network | macOS Safari Web Inspector over USB (iPhone: Settings → Safari → Advanced → Web Inspector) |
| Android Chrome console/network | `chrome://inspect` from a MacBook over USB (phone: Developer options → USB debugging) |
| **Android Firefox** console/network | `about:debugging` → *This Firefox* → *Setup* in DESKTOP Firefox — **not** `chrome://inspect`, which only sees Chromium. Slot AND-2 is Firefox and B3/B5 name it, so without this those two have no way to be observed at all |
| Signaling frames + WS lifecycle | devtools → Network → WS → Messages |
| Server side | `sudo journalctl -u hushsend-signaling -f` |
| Relay actually used | **The `relay` candidate pair in webrtc-internals is the primary evidence.** `sudo journalctl -u coturn -f` does NOT work here — the live config sets `no-stdout-log` with no `log-file=`, so journalctl carries only service start/stop (checked 2026-09-19). Sudo-free corroboration during a relayed transfer: `ss -uan` filtered to ports 49160-49200 shows coturn's relay ports bound on 192.168.1.19 — verified against a live allocation. Real session logs need a `log-file=` + `verbose` added and coturn restarted |

#### Reference numbers (from the code, for judging "expected")

- Receive path (since 2026-09-28 — owner's rule "disk wherever possible"; § File transfer):
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
  handshake** (words / link / QR — added 2026-09-12 for the key-confirmation wait; armed from pairing
  start since 2026-10-11, so it bounds the WebRTC bring-up too —
  § link / qr method). Before 2026-09-12 that path had no client
  deadline at all and depended on the untrusted server's room TTL to rescue it.
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

  So on a fast path the binding constraint was coturn's own **`max-bps=5000000`** (confirmed in
  `/etc/turnserver.conf` then), not the WebRTC stack — the uncapped control is ~6.5× faster. The hairpin
  halved it again because every byte crossed the home router twice (client→coturn, coturn→client).
  **Since 2026-11-22** the live relay runs `max-bps=2000000` under a server-wide
  `bps-capacity=20000000`, so 2 MB/s per allocation is the ceiling of a relayed transfer (the Capacity
  section of hush-signaling-server's runbook). C5 is a CROSS-NETWORK case, so neither number is the
  one you will see there: expect the slower peer's uplink to bind before the relay does. Use these to tell "the relay is slow" apart from "this
  link is slow". At the loopback figure 1 GiB takes ~4.7 min end to end.
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
  2026-09-19), and a relayed pair where BOTH sides relay costs two. Since 2026-11-22 `bps-capacity`
  caps it further: coturn reserves `max-bps` per allocation against it, so at most ten allocations run
  at once and the eleventh is refused (486). Since the same day the signaling
  server mints a unique username per credential (`<expiry>:<id>`), so `user-quota=2` counts per
  credential; before, the username was the bare expiry second and the quota was a per-second bucket.
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

#### Device inventory (fill in)

| Slot | Device | OS version | Browser + version | Engine | Driven by | Expected receive path | Expected QR decoder |
|---|---|---|---|---|---|---|---|
| MBP-A | MacBook | macOS 26 | Chrome 154 | Blink | **Playwright** driving the installed Chrome (`channel:'chrome'`, persistent profiles, since 2026-09-27) | straight into Downloads through the download worker (since 2026-09-28, live since `c5a51c4`); site storage only if the worker cannot come up | native `BarcodeDetector` since 2026-10-03 (`b73651d`), zxing ponyfill on its first throw — see B3 |
| MBP-A | MacBook | | Brave 154 (shields up) | Blink | a browser extension that drives the page | the stream path expected (desktop Chromium; not probed — shields may block the worker, then site storage) — Brave ships no `showSaveFilePicker`, so no dialog fallback | zxing ponyfill |
| MBP-A | MacBook | macOS 26 | Safari 26.6 | **WebKit (the real one)** | **WebDriver** (`safaridriver`, since 2026-09-27 — see § How this pass is actually run) | OPFS (probed 2026-09-27: writes to disk, quota 76.8 GiB) | zxing ponyfill |
| MBP-A | MacBook | macOS 26 | Firefox 156 | Gecko | **WebDriver** (`geckodriver`, since 2026-09-27) | OPFS (probed 2026-09-27: writes to disk, quota 10 GiB) — never the stream path: Firefox fails a streamed download unsafely (2026-09-28) | zxing ponyfill |
| MBP-A | MacBook | macOS 26 | the driver's own Chromium 152 | Blink | driven directly — a SECOND profile next to Brave, so E-cases are honest | the stream path expected (desktop Chromium); before 2026-09-28 its FSA dialog could not be shown in the pane | zxing ponyfill |
| MBP-B | MacBook | | Chrome | Blink | Playwright | straight into Downloads (the stream path) | zxing ponyfill |
| IPH | iPhone | | Safari (WebKit) | WebKit + phone limits | Safari Web Inspector (USB) | OPFS expected (not yet probed on a device); Save file if the screen was locked | zxing ponyfill |
| AND-1 | **Google Pixel 5** (the owner's; attached 2026-10-02) | Android 14, patch 2023-11-05 (EOL) | Chrome 152 | Blink | CDP via USB (`adb forward … chrome_devtools_remote`) + `adb` for native UI; no SIM — "LTE" is a second Wi-Fi with a VPN exit in France | OPFS expected (mobile Chromium does not stream until a handset proves it — B2/B10) — no dialog while the connection is live; the save dialog only past the quota (Chrome 149 HAS `showSaveFilePicker`, and a dialog left open ~20 s killed the connection — why disk-without-dialog is now first) | native `BarcodeDetector` since 2026-10-03, zxing ponyfill on its first throw (the 2026-10-02 scan ran zxing) |
| SIM-iOS | iPhone 17 **simulator** (rehearsal only) | iOS 27.0 | Safari | WebKit, but the Mac's RAM and network | simulator taps + screenshots (safaridriver cannot reach it) | OPFS expected (not probed on the simulator) | zxing ponyfill |
| SIM-iPad | iPad (A16) **simulator** (rehearsal only) | iPadOS 27.0 | Safari | WebKit | as SIM-iOS | OPFS expected; the UA no longer matters (it sent a desktop UA, which picked the 1 GiB cap until 2026-09-27) | zxing ponyfill |
| EMU-AND | Pixel 9 Pro **emulator** (rehearsal only) | Android 17 (user build) | Chrome 149 | Blink | CDP (`adb forward … localabstract:chrome_devtools_remote`) + `adb` for native UI | OPFS expected — no dialog any more (it was FSA through the system save dialog) | zxing ponyfill |
| AND-2 | Android | | Firefox | Gecko | `about:debugging` (USB) | OPFS expected | zxing ponyfill |

Three engines, not four browsers: Blink (Chrome, Brave, Android Chrome), Gecko (Firefox ×2), WebKit
(Safari ×2). Brave earns its row for hardening (B9), MBP-B for a second disk endpoint (F4).

#### How this pass is actually run — three tracks

This plan was written for a human holding the devices. It is now run mostly **by automation**:
desktop browsers it drives directly, plus **real handsets attached over USB** — iPhone through Safari
Web Inspector, Android through `chrome://inspect` (both already in § How to observe). A real handset is the point:
an iOS Simulator would give real WebKit but the Mac's RAM, no camera and the Mac's network, which
silently falsifies B2, B3/B4 and the whole of Phase C. Its Safari also asks each STUN server from a
port of its own, so on any network it looks like a host behind a symmetric NAT
([2026-11-23 run](docs/test-runs/2026-11-23.md)).

So the useful split is not "automated vs manual" but **who has to be physically present for the
evidence to exist**:

- **T1 — automation alone, across ALL THREE desktop engines.** Chrome, Brave, Firefox and Safari
  are driven over MCP, so this track is not "a browser" — it is the real engine matrix:
  **Blink** (Chrome, Brave), **Gecko** (Firefox), **WebKit** (Safari). The automation opens the pages, drives
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
- **T2 — real device attached; the automation drives and observes, you perform ONE named physical act.**
  Point the camera, toggle a radio, lock the screen, tap an OS permission prompt, click a native save
  dialog. Everything after that act is the automation's to drive and read.
- **T3 — your eyes.** What Web Inspector cannot see or judge at all: OS-level UI (the native share
  sheet) and ergonomics (are tap targets truly reachable, is anything clipped on a real 390 px screen).

| Track | Cases | Count |
|---|---|---|
| **T1** — automation alone, closes the case outright | A4a, A4b, A6, A7 · B7, B9 · D1–D5 · E1–E5 · F3, F5, F6, F7 | 20 |
| **T1 + T2** — T1 closes the DESKTOP half on real engines; the handset half is a separate tick | A1, A3, A4, A5, A6a · B2, B8, B10 · E6, E7 · F2, F8 | 12 |
| **T2** — needs one physical act from you | A2 · B1, B3, B4 · C1–C10 · F1, F4, F9 | 17 |
| **T1 + T3** — T1 closes the desktop half; the rest is your eyes | B5 (native share sheet) · B6 (phone ergonomics) | 2 |

**Two ticks, not one, for every case in the split rows.** A1 says "MBP-A Chrome → IPH Safari". With
desktop Safari on MCP there is now a second, genuinely valuable run of the same case —
**Chrome ↔ Safari on the Mac, Blink against real WebKit** — which Playwright covers only through
WebKitGTK. That run is worth doing and worth recording, and it does not tick the handset half. Log
both: `A1 · T1 · Chrome↔Safari desktop · PASS` and later `A1 · T2 · MBP-A Chrome↔IPH Safari · PASS`.

The case this reshapes most is **A6a (path attestation per engine pair)**. Its whole purpose is the
table § Security — open needs to decide whether attestation can ever become a control, and the only real-engine
datum so far is "firefox↔webkit on one LAN says `mismatch` with no attacker present". Three real
desktop engines in six pairings, all drivable by automation in one sitting, is most of that table.

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
   nothing, and § Reference numbers's measured numbers are only comparable against a stated setup.
3. **T1 is a rehearsal as much as a result.** Run it first: it costs minutes, it closes 18 cases
   outright, and it means the handset session is spent on what only a handset can answer instead of on
   discovering a broken build.

---

### Phase A — same-network happy path (all 4 methods) · mostly T1; A2 needs the camera

Both peers on the home Wi-Fi, default **Max-privacy**. Baseline: if these fail, nothing below matters.

- [x] **A1 · link** *(AND-1 half ✅ 2026-10-02 — Pixel 5 Chrome ×3; IPH half ✅ 2026-10-03 — iPhone 15 Safari, 2.0 / 1.7 s, host↔host)* — MBP-A (Chrome) creates a one-time link → send it to IPH (Safari) out of band →
      IPH opens it. Expected: auto-join, pairing, `connected` with **no SAS screen** (link/QR
      authenticate over the link secret), URL fragment scrubbed from the address bar.
- [x] **A2 · QR** *(AND-1 half ✅ 2026-10-02 on the fixed live build `9bdda44` — the Pixel 5 decoded the QR off the Mac's screen and connected in 8.5 s; before the fix the scanner was dead on every engine, [the 2026-10-02 run log](docs/test-runs/2026-10-02.md). IPH ✅ 2026-10-03: the iPhone's camera read the QR off the Mac's screen, connected in 29 s)* — MBP-A shows the QR, IPH scans it with the in-app scanner. Expected: same as A1.
      Note which decoder ran (§ B3).
- [x] **A3 · words** *(AND-1 half ✅ 2026-10-02; IPH ✅ 2026-10-03)* — MBP-A creates, IPH enters the rendezvous + the 4 secret words. Expected: `connected`
      after CPace + key confirmation, no SAS screen.
- [x] **A4 · room / SAS** *(AND-1 half ✅ 2026-10-02, 8 rooms, reader 5× creator / 3× phone; IPH ✅ 2026-10-03, 2 rooms, roles both ways)* — MBP-A creates a 4-digit room, IPH joins → both land in the **lobby**, MBP-A
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
      "Verifying…" ends both sides in the hard stop; [the run log](docs/test-runs/README.md).)*
- [x] **A5 · transfer both ways** *(AND-1 half ✅ 2026-10-02: site storage on the phone, the stream path on the Mac, both verified; IPH ✅ 2026-10-03: site storage on the phone, the stream path on the Mac, both verified)* — over the A1 connection send a small file (≈5 MB) MBP-A → IPH, then
      IPH → MBP-A. Expected: progress advances monotonically, file arrives intact (**check the size and
      open it**), receiver's terminal plaque shows a **"New transfer"** button.
- [x] **A6 · WS closes on connect** — in devtools Network → WS, confirm the signaling socket **closes
      shortly after `connected`** for all of A1–A4 **and for reconnect (Phase E)**, while the transfer
      keeps working afterwards. This is the per-pair privacy close: the server must not observe the
      session duration. Reconnect was the last exemption and was folded in on 2026-09-12 — if its
      socket stays open, that regression is the whole point of checking it here.
- [x] **A6a · path attestation never blocks a transfer** *(✅ 2026-10-03: Chrome ↔ iPhone Safari read `mismatch` on the Mac and the 3 MB send completed — [the 2026-10-03 run log](docs/test-runs/2026-10-03.md))* — it is ADVISORY. On every pair, especially
      a Safari↔non-Safari one, confirm the transfer completes regardless of the verdict. A `mismatch`
      here is EXPECTED between engines (see § Phase B) and must stay cosmetic; if a transfer is ever
      refused or torn down because of it, that is a bug, not a detection.
- [x] **A7 · multi-file** — send 3 files at once. Expected (wording fixed 2026-09-27 to the behaviour
      shipped since `1082b7d`): the sender lists the three files and sends them as ONE store-mode
      `hushsend-files.zip` with one progress bar; the receiver is offered that zip, and every member
      unzips byte-identical; after "New transfer" the next offer shows ITS own name, never the zip's.

### Phase B — browser capability matrix · mixed: B7/B9 are T1, the camera and phone-RAM cases are T2

The point of 6e: every fallback path on a real engine, not a polyfilled test env.

> **Record the path-attestation verdict on EVERY pair you make in this pass.** The DEV diagnostics
> strip shows `path-verdict` / `path-selected` / `path-peer-addrs` (they are dev-only, so read them
> against `npm run dev`, not the live host). Attestation is ADVISORY precisely because we do not yet
> know what real engines report: a firefox↔webkit pair on one LAN says `mismatch` with no attacker
> present, because WebKit cannot attest to the address it was reached on. What this pass needs is the
> table — for each pair (same-network and cross-network, each engine combination): the verdict, what
> each side selected, and what each side attested. That decides whether the check can become a
> control, and in which direction. See [security-audits.md](docs/history/security-audits.md) § Security audit / Path attestation.

> **The phone-shaped half is pre-covered too** by `tests/e2e/mobile.spec.ts` (WebKit + an iPhone
> device descriptor): the phone's real receive path completes (on that build site storage cannot
> write, so it is the RAM fallback — the probe and the fall-back are what that proves), a forced RAM
> receive over 200 MiB is refused before any byte, the layout holds at 390 px, and the QR paste
> fallback works. So on a real
> handset those are re-confirmations; what only the handset can answer is **memory pressure at the
> cap, background-tab suspension (§ F1), camera permissions (B4) and cellular NAT (Phase C)**.
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
      — a disk file, no dialog, the dialog only past the quota, all PASS on the live build
      ([the 2026-09-28 run log](docs/test-runs/2026-09-28.md)) — which desktop Chrome no longer takes; Firefox and Safari do, so those checks moved to
      B2/B10. PASS on the live `c5a51c4` the same day — [the run log](docs/test-runs/README.md).)*
- [x] **B2 · disk receive on the phone + the RAM fallback's cap** *(IPH disk half ✅ 2026-10-03: 1 GiB and 2 GiB into Safari's site storage, verified; RAM rung ✅ 2026-10-03 in a private Safari tab: 250 MB refused before Accept naming the 200 MB cap and the private window, 200 MiB accepted via RAM and delivered)* — receive on IPH Safari and on MBP-A
      Firefox (both keep site storage — neither may stream, see § File transfer). Expected:
      no save dialog; the file goes to site storage and lands via a download at the end — a file well
      past 200 MiB (say 1 GiB) must complete on the PHONE, which is what the disk path is for. Then in a **private window** (where site storage may be unusable → the RAM path)
      offer a file **over 200 MiB**: the receiver must **refuse before accepting**, naming the limit —
      never accept and then die of OOM mid-transfer. *(Reworded 2026-09-28 for the disk-first path; the
      old caps were 512 MiB phone / 1 GiB desktop.)* **2026-09-28, desktop Chrome incognito: FAILS this
      rung** — there site storage IS usable but holds only ~430 MiB while `navigator.storage.estimate()`
      reports the normal profile's 10 GiB, so a 600 MiB file was accepted on the disk path and died at
      74 % ([the run log](docs/test-runs/README.md), [ux-fixes.md](docs/history/ux-fixes.md) § UX bugs). Re-run after the fix: Chrome incognito now streams into
      Downloads (expect a 1 GiB file to complete there, nothing in site storage); Firefox private has no
      site storage (`getDirectory()` → SecurityError, measured) — expect the RAM path, a refusal before
      accept above 200 MiB; Safari private — by hand (safaridriver cannot open one).
- [x] **B3 · QR scan + self-hosted WASM** *(AND-1 half ✅ 2026-10-02 on `9bdda44`: the scan fetched the ponyfill + `zxing_reader-BxB2YfIY.wasm` from our origin only and decoded; IPH ✅ 2026-10-03; AND-2 Firefox half DROPPED by the owner 2026-10-03 — too rare a combination to hold the case open)* — scan on IPH Safari and AND-2 Firefox (the ponyfill path).
      Expected: scanning works, and in Network the WASM is fetched from
      `https://hushsend.frelikh.dev/assets/zxing_reader-*.wasm` with `Content-Type: application/wasm`.
      **Nothing may be requested from `jsdelivr` / `fastly` / any third-party host** — that is the whole
      point of the 6e vendoring. Also scan on AND-1 Chrome — it fetches the SAME WASM: the app imports
      `barcode-detector/ponyfill` where the browser has no native QR detector (iOS Safari, Firefox); since
      2026-10-03 Chrome desktop / Android use their own `BarcodeDetector` with a runtime fallback to zxing
      (owner's decision, § QR). The ponyfill itself never delegates to a native detector
      (measured 2026-09-27 on desktop Chrome, which has one; corrected from
      "native; no WASM fetch at all").
- [x] **B4 · camera permission denied** *(Android half ✅ 2026-10-02: Block → paste fallback, no crash; re-allow is via the site-settings sheet because Chrome offers "Never allow"; IPH ✅ 2026-10-03: deny → "Camera unavailable — paste the link below instead")* — on IPH, deny the camera prompt. Expected: a clean
      **paste-the-link fallback**, no crash, no dead screen. Re-allow and confirm the scanner recovers.
- [x] **B5 · share / copy** *(AND-1 half ✅ 2026-10-02 — the system share sheet opened on a real tap; IPH ✅ 2026-10-03 (the share sheet opened); Firefox half ✅ 2026-10-03: no `navigator.share` → no Share button, Copy link → "Copied", the clipboard holds exactly the link)* — on IPH and AND-1 the **Share** button uses the native sheet; on MBP-A
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
      # 1. two loopback STUN servers (NOT 3478 or 3479 — the TURN relay and hushsend-stun own those
      #    here; the recipe used 3479/3480 until hushsend-stun took 3479 on 2026-10-10)
      for P in 3480 3481; do
        turnserver -n --listening-ip=127.0.0.1 --listening-port=$P \
          --no-auth --no-tls --no-dtls --no-cli --pidfile= --log-file=stdout &
      done
      # 2. a LOCAL signaling server that trusts the dev origin
      NODE_ENV=development HOST=127.0.0.1 PORT=8191 DEV_ORIGINS=http://localhost:5291 \
        node node_modules/hush-signaling-server/signaling-server.js &
      # 3. the dev build, pointed at BOTH of the above
      VITE_SIGNALING_URL=ws://127.0.0.1:8191 \
      VITE_STUN_URLS=stun:127.0.0.1:3480,stun:127.0.0.1:3481 \
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
      VPN-on-both-sides advice (it said "Tor or a VPN" until 2026-10-11). Check the text is not clipped at 390 px — it is the longest prose
      in the app.
- [x] **B6 · theme / language / layout** *(Android half ✅ 2026-10-02 — both themes, no clipping, 44 px targets; iPhone ✅ 2026-10-03: both themes, 44 px targets, no overflow at 393 px)* — check the app in light+dark and EN+RU on the iPhone and on a
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
- [x] **B10 · size ladder up to 5 GB — every receive path, every engine as sender — NEW 2026-09-27
      (owner's request).** *(Handset half of the site-storage row ✅ 2026-10-02: Pixel 5 Chrome, 1 / 2 / 3 / 4 GiB + 1 B / 5 GiB all PASS at 3.0–5.5 MB/s, Chrome PSS flat 201–264 MB — [the 2026-10-02 run log](docs/test-runs/2026-10-02.md). IPH site-storage rungs ✅ 2026-10-03: 1 and 2 GiB block-verified at 12.6 / 29.4 MB/s, 4 GiB + 1 B and 5 GiB by hand in the owner's tab — "Delivered" = the receiver confirmed every declared byte, 11.6 / 12.8 MB/s over Wi-Fi, no block verify on the phone; the RAM rung ✅ in a private tab (B2); past-the-quota on a phone not attempted — the iPhone reports 41 GB free.)* Limits differ by OS, browser and device, and § Reference numbers's ceilings come from
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
      | *(2026-09-28, the live `c5a51c4`: the stream rungs PASS on Chrome, the site-storage rungs PASS on Firefox with the over-quota refusal and on Safari to 5 GiB, the RAM rung PASS on Firefox private — [the 2026-09-28 run log](docs/test-runs/2026-09-28.md). The desktop half of B10 is done; the handset half is what is left.)* | | |

      **Build the files so they cost the page nothing and still prove every byte:** 1 MiB blocks, each
      a unique 16-byte header plus one shared body, assembled from Blob parts that REFERENCE that body.
      A 5 GiB `File` then holds ~1 MiB of RAM on the sender, and the receiver checks every block, so
      reordering, duplication and truncation all fail. For an unattended FSA run the save dialog can be
      replaced in-page by an OPFS file handle (the same `createWritable()` stream); the dialog itself is
      B1's T2 step. Let the Blob path's final download really happen, because that hand-off is where
      the engines died in § Reference numbers, and hash the saved file. Record per run: pair, size, MB/s, outcome,
      verify result, and the peak RSS of the sender's and the receiver's process trees (`ps` every 5 s).
      A phone-sized receiver is the case this ladder exists for; a simulator or emulator run is a
      rehearsal, not the tick.

### Phase C — cross-network + privacy modes (the part only real networks can prove) · entirely T2

IPH (or AND-1) on **LTE with Wi-Fi off**, MacBook on the home Wi-Fi.

- [x] **C1 · Max-privacy direct across networks** *(PASS 2026-10-02, outcome (b): Mac Chrome ↔ Pixel 5 on a VPN Wi-Fi, both sides terminal `failed` with the hint in 18–48 s — [the 2026-10-02 run log](docs/test-runs/2026-10-02.md))* — both sides default Max-privacy, link method.
      **⚠️ The outcome does not generalise** (found 2026-10-03): in every C1 run (and on the Max side
      of C3) the desktop sat on the server's own LAN and advertised the router's LAN address. What
      was measured after that is § Platform limits (a symmetric carrier NAT, 2026-11-22).
      Expected either (a) `connected` via a `srflx` candidate pair — confirm in webrtc-internals that
      the selected pair is **not `relay`** — or (b) if the NATs won't traverse, a **terminal `failed`
      screen with the "switch to Reliable" hint**. Both are correct; a **hang is not**. Record which.
- [x] **C2 · Reliable relay** *(PASS 2026-10-02: `relay ↔ relay` on our coturn, 50 MB in 165 s = 0.3 MB/s with the phone behind a VPN — [the 2026-10-02 run log](docs/test-runs/2026-10-02.md))* — both sides switch to **Reliable**, repeat. Expected: `connected`; in
      webrtc-internals the selected candidate pair is **`relay`**, and coturn logs show an allocation
      from both peers. Then **transfer a ≈50 MB file over the relay** and note throughput — this is the
      only test that proves coturn's `external-ip` / port-forwarding config is actually right.
- [x] **C3 · mixed privacy (regression)** *(PASS 2026-10-02: both directions × link + room, all terminal in 16–19 s, no deadlock; the Max side's hint is lost when the peer gives up first — [ux-fixes.md](docs/history/ux-fixes.md) § UX bugs)* — one side **Max-privacy**, the other **Reliable**. Run it in
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
      table and reopen [security-audits.md](docs/history/security-audits.md) § Security audit / Findings.
      Worth pairing with a control: the same Max ↔ Reliable run where the direct path DOES work must
      still connect normally (the gate must not reject a legitimate `prflx` from a NAT mapping).
- [x] **C6 · volume padding, and what it costs on a real link — NEW 2026-09-17.** *(✅ 2026-10-03 on the iPhone: 300 KiB → 524 371 B on the wire (+70.7 %), 50 MB → +0.7 % at 4.0 MB/s, files the real size — but the path was not recorded and was probably the USB cable, not LTE, so the cellular cost is still unmeasured; [the 2026-10-03 run log](docs/test-runs/2026-10-03.md), the C6 caveat)* In Max privacy the
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
- [x] **C7 · the network check on a symmetric NAT — NEW 2026-11-22** *(PASS 2026-11-23: an iPhone, Safari, on Epic cellular and on the home Wi-Fi, all five steps as written by the owner's report — [the 2026-11-23 run](docs/test-runs/2026-11-23.md))* — The check
      (§ Network check) was built against two local STUN servers that imitate a symmetric NAT; a real
      one is the carrier measured that day. On the live build, phone on **cellular with Wi-Fi off**,
      **Max privacy**: (1) Invite someone → Link or QR code. Expected within a second or two, under
      "Share this link": **"Max privacy will very likely not reach a device on another network from
      here…"**. (2) Open that link on the Mac (home Wi-Fi, Max privacy): the Mac shows NO warning while
      it connects; both sides end on "Couldn't connect directly", and the phone's screen names its
      network as the reason ("…a different address for every destination…"), the Mac's does not.
      (3) **The control:** the same phone on the **home Wi-Fi** shows NO warning on the Share screen.
      Safari on an iPhone asks every STUN server from one socket
      ([2026-11-23 run](docs/test-runs/2026-11-23.md)), so a warning there is a fault of the check, not
      of the phone: record it with a screenshot. (4) Phone on cellular as the
      JOINER (scan the Mac's QR): the warning appears under "Agreeing on keys…" — on iOS Safari it may
      be missing there (§ Network check, Limits); record which. (5) Switch the phone to Reliable and
      make a link: no warning. Record phone, browser and carrier, and for any step that disagrees a
      screenshot. A network with IPv6 adds "It can still work if your peer's network has IPv6…".
- [x] **C8 · "Retry with relay" across real networks — NEW 2026-11-22** *(PASS 2026-11-23: the same iPhone on Epic cellular ↔ the Mac on the home Wi-Fi, all five steps as written by the owner's report — [the 2026-11-23 run](docs/test-runs/2026-11-23.md); steps 2–3 describe the retry as it was until that day, a NEW invite — it has continued the same pairing since, case C9)* — Phone on **cellular**, Mac on
      the home Wi-Fi, both **Max privacy**. (1) Mac: Invite someone → Link or QR code; phone: scan it.
      Both end on "Couldn't connect directly" with "Retry with relay". (2) Tap it on the Mac: a NEW QR
      code. Tap it on the phone: the home screen, **Reliable** selected. (3) Scan the new code:
      connected, and the transfer screen shows the row "relayed through the server"; send a file.
      (4) Reload the page on both: Max privacy is selected again — the retry stored nothing. (5) The
      mixed pair: Mac in **Reliable**, phone in Max privacy, a new link. Expected: the phone ends on
      "Couldn't connect directly"; the Mac on "Couldn't connect" with "…if your peer is in Max
      privacy, ask them to switch to Reliable too" — not "channel closed during pairing". If the Mac
      reads "peer left during pairing", note whether the phone's screen was left before the Mac's
      changed (§ Max-privacy strict model, the one edge).
- [x] **C9 · "Retry with relay" continues the same pairing — NEW 2026-11-23** *(PASS 2026-11-23 by the owner's report: an iPhone, Safari, on Epic cellular ↔ the Mac on the home Wi-Fi, steps 1–5 as written; steps 6–8 were offered as optional and the report does not say whether they were run — [the 2026-11-23 run](docs/test-runs/2026-11-23.md))* (it replaces what C8
      tested: since that day the retry needs no second scan). iPhone on **cellular with Wi-Fi off**,
      Mac on the home Wi-Fi, both **Max privacy**. (1) Mac: Invite someone → Link or QR code; iPhone:
      scan it. Both end on "Couldn't connect directly"; the text under it says "Retry with relay
      continues this pairing in Reliable … Both of you have to tap it". (2) Tap "Retry with relay" on
      the **Mac**: "Waiting for your peer", no QR code. The iPhone's failure screen now also says
      "Your peer has tapped it and is waiting for you" — and nothing else on it has changed. (3) Tap
      "Retry with relay" on the **iPhone**: within a few seconds both show the transfer screen with the
      row "relayed through the server". Nothing was scanned again. Send a file each way. (4) Reload
      both: Max privacy is selected again. (5) Repeat with the taps in the other order (iPhone first).
      (6) **One tap only**: fail again, tap on the Mac, leave the iPhone alone: after two
      minutes the Mac reads "Your peer did not join the retry" with "Start over", which makes a new QR
      code; the iPhone still shows its failure screen. (7) **Slow hands**: fail again and wait four
      minutes before either tap, so that the first room has expired on the server; then tap on both —
      it must still connect. (8) **The mixed pair**: Mac in **Reliable**, iPhone in Max privacy, a new
      QR code. The iPhone ends on "Couldn't connect directly", the Mac on "Couldn't connect" with "…ask
      them to tap “Retry with relay”, then tap Try again here". Tap "Retry with relay" on the iPhone,
      "Try again" on the Mac: connected, relayed. Record the times from the second tap to the transfer
      screen, and for any step that disagrees a screenshot of both screens.
- [x] **C10 · the same for a 4-digit room and for words — NEW 2026-11-23** *(PASS 2026-11-23 by the owner's report: room, words and reconnect, once each; the two slow variants were not asked for — [the 2026-11-23 run](docs/test-runs/2026-11-23.md))* — iPhone on cellular, Mac
      on the home Wi-Fi, both Max privacy. (1) **Room**: Mac creates a room, the iPhone enters the four
      digits, one side picks the other. Both end on "Couldn't connect directly". Tap "Retry with
      relay" on both: no code is asked for and nobody is picked again — the three-word comparison
      appears; read, pick, confirm on both; connected, "relayed through the server". Once more with
      a slow comparison: tap on the Mac, wait a minute and a half, tap on the iPhone, and let the
      three words stand for another two minutes before confirming — it must still connect (the retry
      room has expired on the server by then). (2) **Words**:
      Mac creates words, the iPhone enters them; after the failure tap "Retry with relay" on both:
      connected without the words being entered again. Once more with slow hands: wait until four
      minutes have passed since the words were made, then tap on both — it must still connect. (3) **Reconnect**: with the two devices paired
      (after step 1 or 2), go home on both, tap Reconnect on each other's row in Max privacy; after
      the failure tap "Retry with relay" on both: connected, no code.
- [x] **C5 · mobile-to-mobile** *(DROPPED by the owner 2026-10-03: both handsets have each been paired with the Mac across networks — Max fails closed, Reliable relays — and a phone↔phone pair would add only a second carrier NAT on the same relay)* — IPH (LTE) ↔ AND-1 (different LTE / other Wi-Fi), Reliable. The
      carrier-NAT-to-carrier-NAT case the desktop pair never exercises.

### Phase D — room lobby (mesh) · entirely T1

- [x] **D1 · roster** — MBP-A creates a room; IPH, AND-1, AND-2 join. Expected: every member sees the
      others by readable id and join time, in join order; leaving a device removes its row. *(Reworded
      2026-09-27: the coarse device label the plan used to expect is gone from the protocol — owner's
      decision, [ux-fixes.md](docs/history/ux-fixes.md) § UX bugs — after the redesign had already stopped rendering it. The 2026-09-27
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

### Phase E — reconnect (codeless since 2026-09-25: tap Reconnect on both, no code) · T1, except E6/E7 on real devices

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
- [x] **E6 · reconnect over a SLOW link** *(PASS 2026-10-02: 5/5 in 5.4–6.7 s, Pixel 5 behind a VPN in France ↔ Mac, relay both ways — the link is slow but not cellular; [the 2026-10-02 run log](docs/test-runs/2026-10-02.md))* — the case the 2026-09-17 race lived in.** An early reconnect
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
- [x] **E7 · clock skew — NEW 2026-09-25.** *(PASS 2026-10-02 on the Pixel 5: +4 min met in 4.1 s; +15 min never met, both sides "did not show up" at 603 s with six rendezvous takes each — [the 2026-10-02 run log](docs/test-runs/2026-10-02.md))* The rendezvous is derived from each device's OWN clock in
      10-minute buckets. Set IPH's clock **+4 minutes** by hand (disable automatic time), then E2.
      Expected: they still meet — at worst after a delay of up to the skew (each side re-derives at
      its own bucket boundary), never a failure. Then set it **+15 minutes** (more than a bucket):
      expected: they meet only once the wait has absorbed the skew, or MBP-A ends in "did not show
      up" at 10 minutes — record which, this is the stated limit. Restore automatic time.

### Phase F — real-world robustness · mixed: F3/F5/F6/F7 are T1, the rest need a radio or a dialog

- [x] **F1 · phone screen lock / app switch mid-transfer** *(Android half ✅ 2026-10-02/03 on the Pixel 5: the 200 MB receive ran on under the locked screen, the finished row showed "arrived in the background — Save file", one tap landed it in Downloads with the right SHA-256; IPH ❌→✅ 2026-10-03: iOS Safari tears the connection down on screen lock (both sides "Connection lost" within 17 s); MITIGATED the same day by a Screen Wake Lock requested inside the Accept / Send tap (`bf485ae`) — a 3 GiB receive with Auto-Lock at 30 s ran to Delivered with the phone untouched; a deliberate lock or an app switch still ends it (measured), and the transfer screen says so)* — start a ≈200 MB transfer to IPH, then lock
      the screen / switch apps for ~30 s and come back. Expected: either it keeps going or it fails
      visibly with a recoverable state — **iOS suspends background tabs**, so record exactly what
      happens; this is the single most likely real-world surprise. **Since 2026-09-28:** if the file
      completed while the screen was locked, the finished row must show **Save file** (the download was
      held, not lost — the simulator rehearsal lost it silently); tap it and check the file.
- [x] **F2 · network drop** *(PASS 2026-10-02: Pixel 5's Wi-Fi off 20 s mid-600 MB — both sides "Connection lost" 19 s after the cut; an ~8 s cut with nothing in flight recovered by itself — [the 2026-10-02 run log](docs/test-runs/2026-10-02.md))* — mid-transfer, disable Wi-Fi on one side for ~20 s and re-enable.
      Expected: a visible failure or a recovery, never a frozen progress bar that claims to be alive.
- [x] **F3 · tab close** — close the receiver's tab mid-transfer. Expected: the sender notices and shows
      a failure.
- [x] **F4 · large transfer** *(DROPPED by the owner 2026-10-03: no second computer; the 2 GB-class transfers ran Mac↔phone instead — B10, [the 2026-10-03 run log](docs/test-runs/2026-10-03.md))* — ≈2 GB MBP-A Chrome → MBP-B Chrome (the receiver streams straight into
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
- [x] **F8 · silent peer on the 1:1 confirm path** *(Android half ✅ 2026-10-03: Pixel 5 on a VPN Wi-Fi, Reliable, Wi-Fi cut right after `welcome` — the sender ended in 25 s, the server's `peer-left` beat the 120 s deadline; [the 2026-10-03 run log](docs/test-runs/2026-10-03.md). IPH half CLOSED AS A TOOLING LIMIT 2026-10-03: the "silent peer" needs a hook installed before the page loads, which Safari WebDriver cannot do; the mechanism is proven on the Pixel and headlessly)* — open a link on the receiving device and, the
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

## Backlog — open work only

What is still to do or deliberately deferred — nothing else. When an item lands, move it in the same pass
to the history file of its topic ([docs/history/](docs/history/README.md)); when the owner decides not to
do something, it goes to [Decisions](#decisions). Known limitations that are not
scheduled are in [Compatibility](#compatibility--browsers-devices-platform-limits) (platforms) and [Threat model](#threat-model--and-whether-it-is-ready-for-at-risk-users) (security).

### Pre-launch review — 2026-10-03, with the owner's decisions

A review made after the device pass closed: what to check, fix or polish before the launch, and what
the owner decided on each. Not repeated here: the independent audit, other languages and verifiable
delivery (§ The road to "yes"); path attestation and the STUN operator (§ Security — open).

**Agreed — to do:**
- Max privacy across networks, what is left after 2026-11-22 (§ Platform limits has what was
  measured; the history is in [pre-launch.md](docs/history/pre-launch.md)): try two ordinary Wi-Fi
  networks in different places, another carrier, and a pair with IPv6 on both sides.
- "Retry with relay" in place (2026-11-23), what is not confirmed on the carrier: one tap only, slow
  hands and the mixed pair (test plan C9, steps 6–8), and the slow variants of the room and the words
  (C10). The lab and the unit tests cover them; the main paths passed on the carrier that day.
- Relay capacity: coturn's 49160–49200 range is ~41 allocations (a fully relayed pair takes two).
  A total cap (`bps-capacity`, 20 MB/s = ten allocations at 2 MB/s), two allocations per credential and
  a per-IP mint limit landed 2026-11-22 (the Capacity section of hush-signaling-server's runbook). Left: widen the
  range (the owner: not now) and monitoring of allocations and relay traffic.
- Rate limits vs carrier NAT — to think through: `IP_RL_MAX` (60 create/join per minute per IP) and the
  per-IP connection cap hit many mobile users behind one carrier IP; IPv6 is not grouped by /64. What
  the limit protects is JOIN-scanning of the 4-digit rooms and the word rendezvous (10 000 codes /
  1 296 words); a token join (link, QR, reconnect) cannot be enumerated.
- A large SEND from a phone: 2–4 GB from the iPhone, picked from Files AND from Photos (compare size
  and hash with the original — the Photos picker may hand over a prepared copy of a video), and from
  Android. The windowed reader was measured on Safari on the Mac only.
- Re-run C6 on real LTE with the Mac on `chrome-pubif` (the iPhone side by the owner).
- "No logs", what is left after the 2026-11-22 audit (§ Live instance has what is written and for how
  long): nginx's shared `error.log` names the client address when a request to this vhost fails —
  decide whether the vhost gets its own `error_log` at `crit` or none.
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

**Ideas to think about (owner, 2026-10-03; not planned):** resume after a drop (look at what the code
allows — the receiver already writes to site storage), a persistent QR / link "inbox" without storage, a
"no traces" source mode, folders, a personal AirDrop between one's own devices.

### Security — open

- [ ] **Path attestation as a control.** Built and shown since 2026-09-12/13, but ADVISORY: enforcing
  it failed honest firefox → webkit pairs twice, the second time intermittently, one run in two, while
  advisory mode passed 3/3 — the mechanism, the measurements and the limits are § Path attestation.
  **Do not flip it on from a loopback run.** The real-device pass recorded the verdicts on the pairs it
  met (§ Risk 5: thin data, and a FALSE `mismatch` on Chrome ↔ iOS Safari); the candidate rule for
  private addresses is under § Pre-launch review. Choose between (a) inverting the check — each side
  attests the address it SELECTED, and the peer checks that against its OWN local addresses, so the
  side that must know the address is the side that does know it; (b) gating only when both sides
  report a usable set; or (c) leaving it advisory. Even a stable control buys nothing while STUN and
  signaling share an operator (next item).

- [ ] **STUN under a different operator** *(post-release — owner, 2026-09-18)*. The attestation above is
  defeated by one adversary holding signaling AND STUN, so this is the precondition for it ever becoming
  a control. Since 2026-10-10 clients take STUN from [hushsend-stun-server](https://github.com/maksimfrelikh/hushsend-stun-server)
  (`stun:stun.hushsend.frelikh.dev:3479`: `stun-only`, no relay, no logs) — but it runs on the same box
  and under the same operator as signaling, which buys no separation of control yet (§ Risk 3).
  The property starts to exist only when STUN runs under a DIFFERENT party — ideally several
  independent servers, cross-checked by the client (built: [security-audits.md](docs/history/security-audits.md)).

### Deferred

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
  be done until the owner asks**; when it is, follow the kit's own notes (additive, one stylesheet
  per component, bump both consumers, frelikh `verify` + `visual`, regenerate the Stark system).

- **Scheduled CI expires on a quiet repo.** GitHub disables `schedule:` workflows after 60 days with
  no commits, which would silently stop the nightly engine matrix — the only thing that exercises
  firefox/webkit/interop, since that job is skipped on push. The rule applies here: the repository is
  PUBLIC (anonymous `git ls-remote` works, checked 2026-09-29), and GitHub's 60-day auto-disable is a
  public-repository rule: **the nightly stops 60 days after the last commit** (on 2026-10-11 that meant
  around 2026-12-10). Re-enable it (or run the matrix from the Actions tab) before any release.

- **The test plan's case entries still carry their results.** Most cases end in an annotation of what each
  run found (dates, devices, numbers, rewordings) — the same facts as [docs/test-runs/](docs/test-runs/README.md).
  The 2026-10-11 restructuring moved the run logs out but left these, so the two can drift. Reduce each
  case to its procedure, its expectation and a one-line dated status that links the run file.
- **Two documentation checks are not built yet** (part of the 2026-10-03 plan): status words only with a
  date, and documented numbers against the code's constants (§ Reference numbers lists dozens). The
  § Architecture sections came over from the old notes file with their "(this pass)" / "— done (step 6)"
  markers; date or drop them first, then add both checks to `scripts/check-docs.mjs`.

## Decisions

The calls that settle a question — mostly the owner's — with their date. A decision stays here until it is
reversed; reversing one means editing its entry (with the new date), not adding a contradicting one
elsewhere. Open questions waiting for a decision are in [Backlog](#backlog--open-work-only).

### Owner's decisions at the pre-launch review, 2026-10-03

- `index.html` keeps its caching: no urgent hotfixes after the release; a stable version plus a
  development version without cache.
- Audience: people who care a great deal about privacy but cannot use Tor right now. Tor users are not
  the target.
- Phone ↔ phone: later, only if it becomes meaningful; phone ↔ computer covers the scenarios.
- Only the current browser versions are supported — no minimum-version work.
- Windows: no Windows machine available — an untested gap, stated.
- Legal pages and an FAQ: not now.
- The in-app network-exposure advice names a VPN on both sides, not Tor (2026-10-11), following the
  audience decision above.
- The Android save dialog for a file past the site-storage quota stays as it is (2026-10-11): the case
  is rare, and the measured risk — a dialog left open ~10–20 s killed the connection on the emulator and
  left a 0-byte file — is accepted rather than replaced by a refusal or a warning.
- Product ideas rejected: a relay-only "hide my IP" mode (everything through the server), any
  store-and-forward (the server never stores files), metadata stripping, a file fingerprint, an offline
  mode via QR signaling, blocking resistance / a self-host kit, text messages, one-to-many sends.
- "Retry with relay" continues the same pairing (2026-11-23), for every method: after a direct
  failure, when both users tap it, the pairing they started goes on through the relay with nothing
  scanned, pasted or typed again. This reverses "Max privacy never relays a session — a retry is a new
  pairing" (2026-11-22), which the owner met on the carrier as a second QR scan. The rule is now:
  Max privacy never relays unless both users ask for it in that session (§ Max-privacy strict model).
- No port prediction for symmetric NATs (2026-11-22): adding the neighbours of a peer's announced port
  connected a phone on the owner's carrier in a prototype ([2026-11-22 run](docs/test-runs/2026-11-22.md)),
  but it rests on how one carrier numbers its ports and can break with the next one.

## License

MIT — see [LICENSE](LICENSE).
