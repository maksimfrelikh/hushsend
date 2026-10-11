# hushsend — guide for Claude Code

Privacy-first P2P file transfer: browser to browser over WebRTC/DTLS, end to end. The server only does
**signaling** (rendezvous + relaying opaque SDP/ICE) and is **untrusted** — confidentiality and
authenticity are established client-side (a PAKE, a SAS two humans compare, or a link secret, each
bound to the DTLS fingerprints), with TOFU key pinning.

This repo is the CLIENT (the Vite SPA at the root) plus its nginx vhost and the frontend deploy
(`deploy/`). The two other services are sibling repositories:
- **hush-signaling-server** — signaling AND the TURN relay for Reliable mode, with their tests and
  deploy. Pinned here by commit as a devDependency, so the e2e suite runs exactly that server from
  `node_modules/hush-signaling-server/`.
- **hushsend-stun-server** — STUN for clients (`VITE_STUN_URLS`), meant for a different operator.

Client and server share **no code** on purpose — do not create a shared types package. A protocol
change lands in both repositories in the same pass (`src/types/protocol.ts` here), the pin is bumped so
the e2e runs against it, and the deploy order goes in the commit message.

## Documents — what each holds, and where a new fact goes

**One fact lives in one document; every other place links to it.** A fact stated twice drifts — the
next session then hunts for a guard that no longer exists. Living documents describe the CURRENT state
and are corrected in the same pass as the change that makes them wrong; records are dated and never
rewritten.

| Document | Holds | Kind |
|---|---|---|
| [README.md](README.md) | what hushsend is, for a visitor; the status and the test counts; how to run it | living |
| [THREATMODEL.md](THREATMODEL.md) | what is and is not protected, from whom, and the residual risks — check it before making or changing any claim about safety | living |
| [COMPATIBILITY.md](COMPATIBILITY.md) | which browser or device does what, what was verified where, the platform limits | living |
| [docs/architecture/](docs/architecture/README.md) | how each part works, one file per topic — the one rule and the code map are its first page | living |
| [BACKLOG.md](BACKLOG.md) | open and deferred work — nothing else | living |
| [docs/decisions.md](docs/decisions.md) | the owner's decisions, with their dates | living |
| [TESTPLAN.md](TESTPLAN.md) | the real-device test cases; preparing and running the pass is [docs/test-setup.md](docs/test-setup.md) | living |
| [deploy/DEPLOY.md](deploy/DEPLOY.md) | deploying the frontend and nginx; DEPLOY.md § 0 is the live instance as deployed | living |
| [docs/history/](docs/history/README.md) | what landed and when — finished work, the security audits | record |
| [docs/test-runs/](docs/test-runs/README.md) | the real-device runs, one file per day | record |

- **A change in behaviour** updates the architecture file of its topic in the same pass. Then grep all
  documents for the old claim — code comments and test headers included — and fix every hit.
- **An item that lands** leaves BACKLOG.md for the history file of its topic; a decision not to do
  something goes to docs/decisions.md.
- **Numbers are claims.** Test counts live only in README.md § Status; measured figures carry their
  date. Re-run the thing and refresh the number — never copy one forward. "Today", "now", "live" carry a
  date too.
- **The server side is documented in its repository.** About signaling, the TURN relay or STUN, write
  there and link from here.
- **`npm run docs:check`** (also in CI) fails on a document over 500 lines, a dead link, a `§ Section`
  pointer to a heading that does not exist, and a code path in a living document that does not exist.
  A file that outgrows the limit is two topics: split it.

## Stack (locked — do not swap)
- React + TypeScript, **Vite** — static SPA, **no SSR** (SSR contradicts the threat model).
- **Redux Toolkit** slices. **No RTK Query** (no REST surface; signaling is WebSocket, everything else
  is the P2P DataChannel).
- No router — screens are driven by the connection state.
- Raw `RTCPeerConnection` + `RTCDataChannel` (NOT PeerJS/simple-peer — we need control of the SDP and
  the DTLS fingerprint for channel binding).
- Crypto: `@noble/curves` (+ `@noble/hashes`); WebCrypto where available.
- `zod` for validating inbound signaling frames.
- ESLint + Prettier; **Vitest** (unit) and **Playwright** (e2e) — keep both green.

## Architecture

Read [docs/architecture/README.md](docs/architecture/README.md) § The one rule before touching `src/`:
live objects stay in `src/core/`, the store holds serializable projections only, and the connection
state machine gates every file byte.

## Invariants

Each is enforced in code and covered by tests; the linked file has the mechanism.
- No file bytes before the connection is authenticated (`connected` / `established`) — one gate check
  ([connection.md](docs/architecture/connection.md)). Path attestation is advisory and deliberately does
  NOT extend this gate ([privacy-and-ice.md](docs/architecture/privacy-and-ice.md)).
- Every inbound signaling frame is validated with the zod schemas — the server is untrusted.
- Secret words and link secrets never reach the server; a link secret lives in the URL fragment and is
  scrubbed after it is read ([methods.md](docs/architecture/methods.md)).
- All credential material comes from a CSPRNG, never from the user.
- Once `connected`, every method closes its own signaling socket, so the untrusted server never learns
  how long the session runs; liveness is the DataChannel and ICE, never room presence
  ([connection.md](docs/architecture/connection.md) § Signaling WS lifecycle).
- Max privacy never relays — no fallback, no consent prompt
  ([privacy-and-ice.md](docs/architecture/privacy-and-ice.md)).

## Done means green

Commands are in [README.md](README.md) § Run it. Before a change is done:
- `npm run typecheck && npm run lint && npx vitest run`, and `npm run docs:check` when a document changed;
- the e2e: `npx playwright test`. **On the deploy host (laptop-server) both default ports are live
  services** — run it as `E2E_SIGNALING_PORT=8191 E2E_VITE_PORT=5291 npx playwright test`, never on the
  defaults (`reuseExistingServer` would attach the suite to the production signaling server). The engine
  projects (firefox / webkit / interop / mobile-webkit) also need `E2E_STUN_URLS` with two loopback STUN
  servers — the recipe is in TESTPLAN.md, case B7 (ports 3480/3481 there: 3478 and 3479 are the live
  TURN relay and STUN server);
- for a UI change also `npm run test:a11y` (axe over every screen state × both themes, plus the
  keyboard contracts) and `npm run visual` (screenshots, tokens, geometry). Both drive the states
  through the DEV-only `window.__hsStore` / `__hsKeystore` hooks — no peer, no server. The screenshot
  baselines are the deploy host's renders: compare there, and re-record (`npm run visual:update`) only
  with a reviewed reason ([ui.md](docs/architecture/ui.md)).

## Deploy

[deploy/DEPLOY.md](deploy/DEPLOY.md). The frontend goes out with `bash deploy/deploy-frontend.sh` from
the dev clone on the deploy host (no password needed); check it from another machine with
`bash deploy/verify-bundle.sh --attest`. The signaling server and the relays deploy from their own
repositories.
