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
close on 2026-09-12. Known residuals are listed in [CLAUDE.md](CLAUDE.md) § Known residuals; nothing is
swept under the rug.

## Four ways to pair

| Method | Rendezvous | Authentication | Good for |
|---|---|---|---|
| **Link** | 128-bit token in the URL | key-confirmation over the link secret (in the URL **fragment** — never sent to the server) | sending to someone you can message |
| **QR** | the same link, as a QR code | same | phone ↔ laptop, in person |
| **Words** | one public word from the EFF short list | **CPace PAKE** over 4 secret words (~41 bits), ≤10 attempts | reading a phrase aloud, over a call |
| **Room** | 4-digit code → a **mesh lobby** (up to 8 peers, pick who to pair with) | **SAS** — asymmetric pick-from-3: one side reads its phrase, the other picks blind | a room of people, any pair including joiner↔joiner |

Paired once, two devices can **reconnect with no human step**: each proves possession of the pinned
Ed25519 identity key, channel-bound to the fresh DTLS fingerprints. A key that changed under a known
pairing is an SSH-style hard stop, never a dismissable toast.

## Privacy modes

- **Max privacy (default)** — direct only. Your own STUN, never a relay; the peer learns your IP,
  nothing else carries your traffic. If a direct path cannot come up, the connection **fails** with a
  hint rather than quietly relaying.
- **Reliable** — adds a TURN relay (short-lived HMAC credentials minted per session; the shared
  secret never leaves the server) so a pair behind hostile NATs still connects.

> **Honest caveat — what Max privacy does and does not promise.** Confidentiality is solid: DTLS is
> end-to-end between the two real peers and the fingerprint binding defeats any MITM that terminates
> it, so nothing on the path reads a byte. The *path* promise cannot rest on candidate filtering — an
> untrusted server relays the SDP, which carries the ICE credentials, so it can answer connectivity
> checks itself and a filter cannot tell its `typ host` from a real peer's. So the claim is
> **verified instead of assumed**: once the pair is authenticated, each side attests over the
> DataChannel to the addresses it can be reached at, and each checks that the address ICE actually
> selected is one the peer named. **That check is ADVISORY today, not enforced** — and the reason is
> worth stating rather than burying: enforcing it broke an honest Firefox↔Safari pair on one LAN,
> because WebKit cannot disable mDNS obfuscation of its host candidates and so cannot attest to the
> address its peer actually reached it on. Failing closed there would break real Safari users, which
> is worse than the leak it closes. So the verdict is recorded while the real-device pass establishes
> what each engine reports; the open item is in [BACKLOG.md](BACKLOG.md) § Security audit. Until then,
> the honest statement is: **nothing on the path can read your files, and a relay is refused — but a
> hostile server can be on the path and learn who is talking to whom.**

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
those bytes on their own machine and a GitHub runner independently produced the same ones.

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

**Feature-complete and deployed.** All four methods, reconnect, the mesh lobby, TURN, i18n (EN/RU),
light/dark, and the deployment are built and live. **243 vitest tests** and a Playwright e2e suite —
**34 per engine** across chromium / firefox / webkit, plus a phone profile and 5 cross-engine pairs —
cover the protocol paths. Counts verified 2026-09-13; refresh them here whenever the suite grows.

A second internal audit on **2026-09-12** (modelling a fully malicious signaling server, not just a
passive one) found and fixed three complete breaks — SAS certificate grinding, server-chosen pairing
roles, and a re-entrant `welcome` that flipped the key-confirmation role mid-handshake — plus a
pre-authentication enrollment hole. All are closed with regression tests; the findings and what
remains are in [BACKLOG.md](BACKLOG.md) § Security audit.

Before a public launch, and **especially before anyone whose safety depends on it relies on this**,
several things remain — they are set out with their consequences in
**[THREATMODEL.md](THREATMODEL.md)**, which is the file to read before making any promise to such a
user. In short:

1. **Verifiable delivery.** The server this model declares untrusted is the same server that ships
   the JavaScript. That is the largest single gap and it is not a protocol change — it needs a
   reproducible build with published hashes, an independent mirror, or a pre-delivered client.
2. **A real-device pass** — transport, file-save fallbacks, QR scanning and camera permissions on
   actual iOS Safari / Firefox / Android, plus a cross-network TURN relay check. The plan is
   [TESTPLAN.md](TESTPLAN.md); **none of its 49 cases has been run on a device yet.**
3. **STUN under a different operator**, which is the precondition for path attestation becoming an
   enforced control rather than an advisory one.
4. **An independent security audit.** Two internal passes are done; the second found three complete
   MITM breaks in a system the first had already reviewed, which is the argument for an external one.

## Run it

```bash
npm install
npm run dev        # vite dev server
npm run typecheck  # tsc --noEmit
npx vitest run     # unit + integration (integration needs `cd server && npm ci` for `ws`)
npm run test:e2e   # playwright (drives two real browser tabs through a live DataChannel)
npm run build      # typecheck + vite build
```

CI runs the cheap checks (typecheck, lint, unit + integration) on every push and the Chromium e2e
alongside them; the full engine matrix — Firefox, WebKit, the phone profile and the cross-engine
pairs — runs nightly or on demand, because it takes ~12 minutes.
See [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

The signaling server for local work lives in [`server/`](server/signaling-server.js)
(`node server/signaling-server.js`). Production uses the separate, multi-app
[`hush-signaling-server`](https://github.com/maksimfrelikh/hush-signaling-server) repo.

Build-time configuration (Vite bakes these in — there is no runtime client config):

| Variable | Meaning |
|---|---|
| `VITE_SIGNALING_URL` | the `wss://` the client opens |
| `VITE_STUN_URLS` | comma-separated STUN endpoints. **Not optional for a real deploy** — Max-privacy is STUN-only, so with none set two peers on different networks never connect |

## Architecture — the one rule

Every non-serializable, live object — `RTCPeerConnection`, `RTCDataChannel`, `WebSocket`,
`CryptoKey` — lives **only** in `src/core/`. They never enter the Redux store and React never holds
them. Data flows one way:

```
UI  --(method call)-->  SessionController  --(work + dispatch)-->  store  --(useSelector)-->  UI
```

The store holds serializable projections only (status, peer label, words to display, progress,
error), so RTK's serializability check stays on. `store/connectionSlice.ts` is a **finite state
machine**: one `status` field plus a guarded transition map, which reduces the central invariant to a
status check — **no file bytes flow unless the connection is authenticated.**

```
src/
├── core/                      # imperative, framework-agnostic; owns ALL live objects
│   ├── SessionController.ts   # the boundary: UI → methods; core → dispatch
│   ├── signaling/             # WebSocket client (signaling only; every frame zod-validated)
│   ├── webrtc/                # RTCPeerConnection + DataChannel, DTLS fingerprints, backpressure
│   ├── crypto/                # cpace · sas · keyConfirmation · identity · enrollment · reconnect
│   ├── keystore/              # IndexedDB: own identity key + pinned peer keys (TOFU)
│   ├── words/ link/           # EFF wordlist credential · link token + secret
│   ├── iceServers.ts relax.ts # privacy mode → ICE config · Max-privacy relay filter
│   ├── pairingRole.ts sasRole.ts livenessGate.ts   # pure per-pairing decisions
│   └── transfer/              # chunking + backpressure; stream-to-disk or Blob fallback
├── store/                     # serializable projections only — the FSM lives here
├── types/protocol.ts          # zod schemas for UNTRUSTED inbound signaling frames
└── ui/                        # React; reads the store, calls the core; stark-ui-kit tokens
```

## Documentation map

| File | What it is |
|---|---|
| [THREATMODEL.md](THREATMODEL.md) | **what is and is not protected, from whom** — read this before promising anything to anyone whose safety depends on it |
| [CLAUDE.md](CLAUDE.md) | the working guide — architecture, every protocol, invariants, current state |
| [BACKLOG.md](BACKLOG.md) | remaining and deferred work, the done-log, the security-audit surface |
| [TESTPLAN.md](TESTPLAN.md) | the real-device test pass |
| [deploy/DEPLOY.md](deploy/DEPLOY.md) | the deployment runbook, and § 0 the live instance as realized |

## License

MIT — see [LICENSE](LICENSE).
