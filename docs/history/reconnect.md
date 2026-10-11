# Reconnect — from the by-code design to the codeless one (2026-09)

Dated records, moved out of BACKLOG.md on 2026-10-11 when it became a list of open work only. Each entry
was true on its date; the current state is in the living documents (see [README.md](README.md)).

## Reconnect UX — DONE 2026-09-25 by removing the code (codeless reconnect)

**What changed.** Reconnect used to rendezvous over a plain 4-digit room: one side pressed Start and
read a code, the other typed it. That entry-point split produced every failure mode listed in the
history below, and the code itself was the security weak spot (an enumerable room, auto-pairing with
whoever won the race, which is what forced the blinded announcement on 2026-09-18). The rendezvous
is now **derived**: both devices hold the `pairingId` (16 secret bytes minted at enrollment), so each
computes `HMAC(pairingId, time-bucket)` → a 22-char token of exactly the link/QR shape and asks the
server for that token room **join-or-create**. Tap Reconnect on both devices, in either order; they
meet. Server-side, token rooms became join-or-create (the running `hush-signaling-server` was
updated the same day) and the link/QR creator now draws its own token too, so the server cannot
tell a reconnect from a first link meeting, nor which side initiated. Before any identity key is
shown, each side proves it holds the pairing secret with a MAC (`reconnect-hello`); the proof under
the pinned key follows, the responder first, and the initiator settles only on the responder's
`reconnect-ok` so the two sides never disagree about the outcome. Roles come from the DTLS
fingerprints, not create/join (there is no creator) and not the server's ids. No SAS is primed
underneath any more: a device without the pin cannot derive the token, never arrives, and the
waiting side ends with "the other device did not show up" (10-min cap; the room is re-taken every
2 min and at every bucket boundary meanwhile). `crypto/reconnect.ts` (rendezvous, role, hello,
schemas — unit-tested), `SessionController` (`reconnectTo`, the wait/refresh/rejoin logic —
`SessionController.reconnectRendezvous.test.ts`), `ReconnectWaitScreen`, `room-server.test.ts`
(join-or-create + TTL on a joined token), `tests/e2e/reconnect.spec.ts` (happy, stall, key-changed,
held hello, wire hygiene incl. the socket URL, order independence, no-show), `link.spec.ts` (dead
link still fails at once). See CLAUDE.md § Crypto / Reconnect and § Known residuals.

**What this closed:** both failure modes below; the "reconnect + plain room join" mismatch (a plain
join lands in a lobby, a reconnect never enters one — nothing to mix); the `pairingId` disclosure to
a code-guesser (nothing is announced); `RoomCreateScreen`, the reconnect code input, the split-hint
copy, `blindPairingId`, `reconnect-init`/`reconnect-fallback`, the SAS-fallback hold in
`trySasReady` — all deleted, not gated.

**What it did NOT do:** return-to-lobby (unrelated, still deferred below); keystore GC / pin-merge
(the dual-pin caveat stands — a wiped side pairs afresh and the other side gains a second pin).

**New residuals, small, recorded in CLAUDE.md § Known residuals:** the token repeats within one
10-minute bucket; clock skew delays the meeting by up to the skew.

### History (the by-code design, kept for the record)

Expands the deferred **reconnect-in-lobby** item (Step 6 / 6c follow-ups). The manual cross-browser
pass confirmed reconnect worked via its intended path (one side `reconnect` [create], the other
`reconnect-by-code`), and surfaced two concrete failure modes from how the entry points combined.
The two LOW-RISK parts were done first (interim liveness deadline + entry-point ergonomics); the
SECURITY-SENSITIVE parts (lobby-pick reconnect + reconnect role create/join → id-order) stayed
deferred (post-audit) until the code was removed altogether.

The two failure modes (both now gone with the code):

- ✅ **Mismatched entry → permanent "agreeing on keys" hang — FIXED (verified 2026-09-17, the text
  below had gone stale).** If one side takes the **reconnect** path (pin-based auto-pair, role
  create/join, NO SAS) while the other joins the same code via the **regular room join** (→ lobby →
  manual pick → a fresh SAS, role by id-order), the two run *different* handshakes over the same
  channel: one sends `reconnect-init` and waits for `reconnect-proof`, the other sends
  `pair-request` / `sas-commit`. SDP/DTLS negotiate fine, but the app-level key step never converges.
  This entry used to end "there is **no timeout-to-failed in this combination** … so the mismatch
  hangs forever instead of failing" — that is no longer true. `armReconnectTimeout` is armed in
  `beginPairing` for **either** side that is on the reconnect path (`SessionController`, guarded by
  `this.reconnect && !this.reconnect.fellBack`), independently of the pre-SAS timer, and the plain-SAS
  side is covered by `armSasTimeout`. A stalled re-auth ends in `failed` at 120 s. Covered by
  `reconnect.spec.ts:107` ("reconnect liveness deadline FIRES"), whose own comment names this residual
  as the thing it closes. The remaining UX complaint — that the two entry points are easy to mix up —
  is real and is the item below, but it is no longer a hang.
- **Both sides press `reconnect` → two separate rooms, no rendezvous.** `reconnect` is
  reconnect-**create** (allocates its own room/code); pressing it on both peers makes two independent
  rooms that never meet. Same create/join asymmetry as every method, but the single "reconnect" label
  reads like "reconnect to my peer" rather than "open a reconnect room" — the create-vs-join split for
  reconnect is non-obvious.

**What "done" looks like:**
- A **lobby pick** should detect that the target peer is already pinned (`pairingId → key` present on
  both sides) and route that pair through **reconnect-auth (no SAS)** instead of a fresh SAS — i.e.
  reconnect becomes reachable *from the mesh lobby*, not only via the separate by-code path. (This is
  the original reconnect-in-lobby goal.) ***(still deferred — see "Deferred (post-audit)" below.)***
- **The reconnect PROTOCOL role must move from create/join to id-order.** ***(still deferred — see
  "Deferred (post-audit)" below.)***
- ✅ **Interim hardening — liveness deadline on the reconnect wait — DONE (this pass).** The reconnect
  re-auth wait (reconnect-init → reconnect-proof/fallback) now has its OWN liveness deadline,
  INDEPENDENT of the SAS pre-timer (which guards the SAS commit-reveal, not a stalled reconnect). A
  mismatched-entry pair — one side on reconnect, the other on the plain-SAS lobby path (a fresh SAS,
  never a reconnect response) — now ends in **`failed`** instead of an infinite "agreeing on keys".
  Prod-fixed at the same **120 s** default as the pre-SAS deadline, read through a DEV-only override
  (`reconnectTimeoutMs()` ← `?reconnectTimeoutMs=N` / `window.__HUSHSEND_RECONNECT_TIMEOUT_MS__`,
  tree-shaken in prod) for cheap e2e. Armed at pairing start (`SessionController.beginPairing`,
  reconnect path only); cleared on settle (`settleReconnect`) / fallback (`reconnectFallback`) / fail
  (`failReconnect`) / dispose (and a Max-privacy ICE failure clears it via `failDirect`; `failSas`
  also cross-closes it, so a parallel reconnect timer can't fire a second teardown when reconnect
  falls back to SAS); expiry
  → `failReconnect` (→ `failed` + close), the SAME terminal path as a key-change / MITM. **Fail-closed,
  liveness only — the two-check verify, the reconnect role (create/join), the wire frames, and the
  crypto are UNTOUCHED.** DEV knob `?stallReconnect=1` (withholds the reconnect-proof) drives the
  firing e2e (`tests/e2e/reconnect.spec.ts` — "reconnect liveness deadline FIRES"). The optional
  fail-fast/hint on the OTHER side (an already-pinned peer joining via the fresh-SAS lobby path) was
  NOT done — it is nontrivial (the plain-SAS side has no reconnect state to key off) and the deadline
  already removes the hang. (See CLAUDE.md § Crypto / Reconnect.)
- ✅ **Entry-point ergonomics — DONE (this pass).** The reconnect create-vs-join split is now explicit
  on the home screen: a **"Reconnect a device"** section with a one-line split hint ("one side starts +
  shares the code, the other joins with it; both starting opens two rooms"), then two clearly-labelled
  affordances — **Start** (tap a recent device → `createReconnectSession` opens a room + shows a code)
  vs **Join — enter the code the other side is showing** (`joinReconnectSession`). EN/RU. UI-only — the
  reconnect protocol / roles / wire format are unchanged; testids (`create-reconnect-btn` /
  `reconnect-input` / `join-reconnect-btn`) are stable. This makes "reconnect on both" and "reconnect +
  regular join" no longer easy mistakes.

**Deferred (post-audit) — security-sensitive, NOT in this pass** *(resolved 2026-09-25: the code was
removed instead; the role moved to fingerprint order behind the hello gate — see the top of this
section and § Security audit (a))*: lobby-pick reconnect AND moving the
reconnect PROTOCOL role from create/join to id-order. The role move changes the **verifier-first
ordering** the two-check **key-changed-vs-MITM** verify depends on (today create/join fixes the
verifier-first side so a key change is caught before a forger can settle); re-deriving it from the
readable ids needs the key-changed-before-settle ordering re-verified under id-roles first. Until that
audit lands, the lobby keeps doing a fresh SAS, reconnect stays the separate by-code auto-pair path,
and the two **must not be mixed** — but the mix no longer HANGS (it now fails closed, per the liveness
deadline above), and the entry-point ergonomics make the mix far less likely.
