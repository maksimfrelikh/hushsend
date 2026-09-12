# hushsend

Privacy-first peer-to-peer file transfer in the browser. Files move **directly between two
browsers** over WebRTC/DTLS — by default never through a server — and the pairing is authenticated by
the two humans, not by an account.

**Live:** [hushsend.frelikh.dev](https://hushsend.frelikh.dev) · no sign-up, no upload, nothing to install.

## The threat model in one paragraph

The signaling server is **untrusted**. It does rendezvous only: it relays opaque SDP/ICE between two
browsers and never sees a file byte, a secret word, or a link secret. Confidentiality and
authenticity are established **client-side** — a PAKE (CPace) or a short authentication string
compared by the two humans, MAC'd over the negotiated **DTLS fingerprints** (channel binding), with
TOFU key pinning for later reconnects. A server that lies, a relay that re-terminates DTLS, or a
network attacker in the middle all produce a mismatch and a hard stop **before any byte flows** —
file transfer is gated on an authenticated `connected` state.

What the server can still observe: that two IPs rendezvoused, and how long the *pairing* took — each
peer closes its own signaling socket the moment the authenticated connection is up, so the session
duration is not the server's to know. (One exception today: a **reconnect** session keeps its socket
open, which tells the server the pair has met before. Tracked in the backlog.) Known residuals are
listed in [CLAUDE.md](CLAUDE.md) § Known residuals; nothing is swept under the rug.

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

> **Honest caveat.** An internal audit (2026-09-12) found the Max-privacy guarantee is enforced
> against relay candidates the peer *signals*, but ICE can still **learn** a peer's relay address as
> a peer-reflexive candidate — so in a **mixed** pair (Max ↔ Reliable) where the direct path fails, a
> relayed path can complete. Confidentiality is unaffected (DTLS + PAKE/SAS are untouched); the
> privacy promise is. The fix is tracked in [BACKLOG.md](BACKLOG.md) § Security audit / Findings.

## Status

**Feature-complete and deployed.** All four methods, reconnect, the mesh lobby, TURN, i18n (EN/RU),
light/dark, and the deployment are built and live. 184 unit + integration tests and a Playwright e2e
suite cover the protocol paths.

Before a public launch, two things remain and neither is code:

1. **A real-device pass** — transport, file-save fallbacks, QR scanning and camera permissions on
   actual iOS Safari / Firefox / Android, plus a cross-network TURN relay check. The plan is
   [TESTPLAN.md](TESTPLAN.md).
2. **An independent security audit.** A first internal pass is done (see BACKLOG § Security audit);
   the open findings are listed there rather than in a footnote.

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
| [CLAUDE.md](CLAUDE.md) | the working guide — architecture, every protocol, invariants, current state |
| [BACKLOG.md](BACKLOG.md) | remaining and deferred work, the done-log, the security-audit surface |
| [TESTPLAN.md](TESTPLAN.md) | the real-device test pass |
| [deploy/DEPLOY.md](deploy/DEPLOY.md) | the deployment runbook, and § 0 the live instance as realized |

## License

MIT — see [LICENSE](LICENSE).
