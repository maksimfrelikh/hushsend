# hushsend

Privacy-first peer-to-peer file transfer in the browser. Files move **directly between two
browsers** over WebRTC/DTLS — by default never through a server — and the pairing is authenticated by
the two humans, not by an account.

**Live:** [hushsend.frelikh.dev](https://hushsend.frelikh.dev) · no sign-up, no upload, nothing to install.

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
duration is not the server's to know. **No method is exempt** — reconnect was the last one keeping its
socket open (a fingerprint that told the server the pair had met before) and was folded into the same
close on 2026-09-12. The residual risks are in [THREATMODEL.md](THREATMODEL.md) and the platform limits in
[COMPATIBILITY.md](COMPATIBILITY.md); nothing is swept under the rug.

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
Downloads on desktop Chromium, through the site's private storage elsewhere; which browser takes which
path is in [COMPATIBILITY.md](COMPATIBILITY.md). A file no path can take is refused before anything is
sent.

## Privacy modes

- **Max privacy (default)** — direct only. Your own STUN, never a relay; the peer learns your IP,
  nothing else carries your traffic. If a direct path cannot come up, the connection **fails** with a
  hint rather than quietly relaying. Transfers are **padded** so the byte count on the wire shows a
  range rather than the exact file (≤12.5% extra above 1 MiB; see `core/transfer/padding.ts` for what
  that does and does not hide — duration and the fact of a transfer are still visible).
- **Reliable** — adds a TURN relay (short-lived HMAC credentials minted per session; the shared
  secret never leaves the server) so a pair behind hostile NATs still connects.

On a Mac (macOS 15 and later), Max privacy between two devices on the SAME network needs the
browser's Local Network permission — [COMPATIBILITY.md](COMPATIBILITY.md) § Platform limits.

> **Honest caveat — what Max privacy does and does not promise.** Nothing on the path can read your
> files, and a relay is refused — but a hostile signaling server can put itself on the path and learn
> who is talking to whom, and the check that would expose it is advisory, not enforced. Why, and what
> would change that: [THREATMODEL.md](THREATMODEL.md) § 2.

## Verifying what you were served

The server that this threat model calls **untrusted** is also the server that hands you the
JavaScript. That is the largest open risk in the product ([THREATMODEL.md](THREATMODEL.md) § 1) and
neither CSP nor SRI touches it, because the same server emits both.

What exists today is a second opinion about what the bytes should be. Every push builds the bundle on
a GitHub runner — a machine the site operator does not control — publishes the SHA-256 of every file
in the run summary, and attaches a signed provenance attestation recorded in a public transparency
log. The build is **byte-for-byte reproducible**, and CI fails if it ever stops being: without that,
"the live site does not match CI" would be the ordinary outcome and nobody would investigate a real
one.

So anyone can check the live deployment against an independent build — **with no account, no token
and nothing to obtain from us**:

```bash
bash deploy/verify-bundle.sh --attest
```

That takes the bytes you were actually served and asks GitHub's public attestation API whether each
one is covered by a signed provenance statement. Verified against production on 2026-09-13: all eight
files, signed, from a named commit. It also demonstrates the reproducibility — the operator built
those bytes on their own machine and a GitHub runner independently produced the same ones. It spends
one request of GitHub's anonymous API per file — 60 an hour per public IP; when they run out it says
"not checked" and exits 2, never "mismatch".

If you have a manifest from a specific CI run and want to pin to it:

```bash
bash deploy/verify-bundle.sh --manifest <manifest from the CI run for that commit>
```

**Read the limits before relying on it** — they are in the header of
[`deploy/verify-bundle.sh`](deploy/verify-bundle.sh), and they matter:

- It does nothing for a browser that has **already** been served a hostile bundle. Checking afterwards
  from the same machine is shutting the door behind you.
- A bundle can be served selectively, to one IP. That is caught only by someone checking **from that
  vantage point** — an argument for several people checking from several networks, not for checking
  once.
- It verifies that the bytes match a build of a given commit. It says nothing about whether that
  commit is honest; for that, read the source.

What it removes is *silently*. An operator can no longer change the delivered client without the
change being detectable by anyone who looks — and it is the precondition for the stronger answers
(an extension or desktop build shipped through a store, or an independent mirror), none of which can
be verified without a reference hash.

## Status

**Feature-complete and deployed.** All four methods, the codeless reconnect, the mesh lobby, TURN,
light/dark, the Claude Design screen set (English only for now; the RU table is kept, the switch
hidden), and the deployment are built and live. **378 vitest tests** (the client; the signaling
server's 28 run in its own repository) and a
Playwright e2e suite — **54 cases per engine: 53 run on chromium, 49 on firefox, 48 on webkit** (2026-10-11) (the
silent-peer case needs CDP, and the two straight-into-Downloads cases apply only where the stream path
does — desktop Chromium; the two site-storage cases skip on Playwright's WebKit, whose storage cannot
write; plus 2 opt-in cases everywhere, the size ladder and the two-STUN cross-check), plus a 4-case
phone profile and 5 cross-engine pairs — cover the protocol paths; the axe
gate (`npm run test:a11y`, 132 checks) and the screenshot gate (`npm run visual`, 187 checks — on the
deploy host, whose renders the baselines are) cover the screens. Every count here was re-run
2026-10-11 on the deploy host, on the Vite 8 / Vitest 5 / Playwright 1.64 toolchain, with the
pre-launch fixes of that day in (vitest 378 of 378; e2e 159 passed, 12 skipped, none failed).
Refresh them here whenever the suite grows.

A second internal audit on **2026-09-12**, modelling a fully malicious signaling server rather than a
passive one, found and fixed three complete MITM breaks plus a pre-authentication enrollment hole; every
pass and what it found is in [docs/history/security-audits.md](docs/history/security-audits.md). The real-device pass closed on
2026-10-03 ([COMPATIBILITY.md](COMPATIBILITY.md) has what was verified where).

**Before anyone whose safety depends on it relies on this**, read [THREATMODEL.md](THREATMODEL.md): what
still has to happen, in order, is THREATMODEL.md § The road to "yes" — above all an independent audit, STUN under a
different operator (the precondition for path attestation becoming a control), and verifiable delivery
beyond the first step described above.

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

CI runs the cheap checks (typecheck, lint, unit) on every push and the Chromium e2e alongside
them; the full engine matrix — Firefox, WebKit, the phone profile and the cross-engine
pairs — runs nightly or on demand, because it takes ~12 minutes.
See [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

hushsend runs as three services, each in its own repository:

| Repository | What |
|---|---|
| **hushsend** (this) | the client, the nginx vhost, the frontend deploy — [`deploy/DEPLOY.md`](deploy/DEPLOY.md) |
| [hush-signaling-server](https://github.com/maksimfrelikh/hush-signaling-server) | signaling + the TURN relay for Reliable mode, with their own tests and deploy |
| [hushsend-stun-server](https://github.com/maksimfrelikh/hushsend-stun-server) | STUN for clients, meant to be run by a different operator |

The signaling server is a devDependency pinned by commit, so `npm ci` installs it and the e2e suite
runs exactly that version; for local work start it with `node node_modules/hush-signaling-server/signaling-server.js`
(127.0.0.1:8080; `NODE_ENV≠production` allows `http://localhost:5173`).

The two build-time values (`VITE_SIGNALING_URL`, `VITE_STUN_URLS` — Vite bakes them in, there is no runtime
client config) and what each must be for a real deploy: [deploy/DEPLOY.md](deploy/DEPLOY.md) § 1.

## Architecture and documents

How it is built — the one rule every line of `src/` follows, the code map, and one file per topic — is
[docs/architecture/](docs/architecture/README.md). [CLAUDE.md](CLAUDE.md) § Documents lists every document
and what goes where. For a visitor the three that matter most: [THREATMODEL.md](THREATMODEL.md) (read it
before promising anything to anyone whose safety depends on it), [COMPATIBILITY.md](COMPATIBILITY.md), and
[deploy/DEPLOY.md](deploy/DEPLOY.md).

## License

MIT — see [LICENSE](LICENSE).
