# hushsend — guide for Claude Code

Privacy-first P2P file transfer: browser to browser over WebRTC/DTLS, end to end. The server only does
**signaling** and is **untrusted**. This repo is the CLIENT (the Vite SPA at the root) plus its nginx
vhost and the frontend deploy; signaling, the TURN relay and STUN are sibling repositories.

## One document

[README.md](README.md) is the only living document — for visitors at the top, then the threat model,
compatibility, architecture, deploy, the test plan, the backlog and the decisions. Do not create
another Markdown file for the current state: a fact stated twice drifts. Where a new fact goes and how
it is kept true: README § About this document. The dated records stay in `docs/history/` and
`docs/test-runs/`.

Before touching `src/`, read README § The one rule, § Stack and § Invariants. Before making or changing
any claim about safety, read README § Threat model. A change in behaviour updates its README section in
the same pass; then grep the repository for the old claim, code comments and test headers included.

## Done means green

README § Before a change is done: typecheck, lint, vitest, `npm run docs:check` when README changed,
the e2e, and for a UI change the axe and screenshot gates.

## Deploy

README § Deploy. The frontend goes out with `bash deploy/deploy-frontend.sh` on the deploy host; check
it from another machine with `bash deploy/verify-bundle.sh --attest`. The signaling server and the
relays deploy from their own repositories.
