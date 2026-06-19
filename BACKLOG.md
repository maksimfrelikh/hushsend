# hushsend — backlog (remaining & deferred work)

Forward-looking work only. Current built state + implementation caveats live in CLAUDE.md
(§ Current state, § Known residuals). Update this file in the same pass as CLAUDE.md when items land.

## Step 6 — Hardening (main remaining chunk)
- **Server cap/TTL/rate-limit for 4-digit rooms** — anti-farming + 1:1 hygiene; parallels the
  word-room cap/TTL. SAS already defeats a MITM regardless; this is abuse hygiene.
- **TURN relay + Reliable / Max-privacy mode** — the home toggle is currently disabled. Needs an
  ICE-policy switch (direct-only vs relay-allowed), a TURN server to deploy, and the
  "couldn't connect privately / relax privacy & retry" UX. (Current build is direct-only =
  effectively "max privacy"; the relay/Reliable mode is the new part.)
- **Cross-browser pass** — iOS Safari / Firefox: transport, FSA→Blob fallback + caps, QR scan
  (barcode-detector zxing-wasm fallback), camera permissions.
- **Deployment behind nginx** — X-Real-IP header, WS proxy to 127.0.0.1:8080, TLS certs.

## Security / correctness follow-ups (small)
- **SAS fail-closed on unset role** — the SAS role (sessionRole) defaults to blind picker, which is
  safe from phrase-leak; but if BOTH sides end up unset (e.g. a mid-SAS reload loses the UI role),
  there is no reader and a guessing human could false-accept (~1/9) under a MITM. Make an unset role
  render an explicit "restart verification" error instead of a functional blind picker. Low severity.
- **High-entropy rendezvous for link/QR** — replace the 4-digit room with a high-entropy token in the
  URL fragment (the link already carries the rendezvous, so no UX cost). Eliminates 4-digit
  squatting for link/QR. Requires a server change (accept token rooms for link/QR). Overlaps step 6.

## Nice-to-have / future
- **stark-ui-kit componentization** — once a 2nd consumer exists (or the screen set is final),
  promote the generic primitives (button, input, toggle, pill, hairline-card, sheet) from the app's
  `.hs-*` layer into the kit as real React components (props + a11y + tests). Domain pieces (SAS
  cards, word slots, code display, transfer, key-changed banner) stay app-local. Don't extract
  prematurely.
- **Transfer-history privacy** — file names are kept in localStorage history by default; for a
  privacy tool consider opt-in or omitting names (history is already clearable via "forget").

## Caveats (not scheduled — see CLAUDE.md § Known residuals)
pairingId relay-linkability · dual-pin if a keystore is wiped · pre-SAS pairing deadline untested
in the firing direction.
