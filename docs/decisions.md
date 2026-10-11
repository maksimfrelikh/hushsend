# Decisions

The calls that settle a question — mostly the owner's — with their date. A decision stays here until it is
reversed; reversing one means editing its entry (with the new date), not adding a contradicting one
elsewhere. Open questions waiting for a decision are in [BACKLOG.md](../BACKLOG.md).

## Pre-launch review, 2026-10-03 (owner)

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
