# Connection — the state machine, the signaling socket, early frames

Part of the architecture reference — [README.md](README.md) is the index.

## Connection state machine
`src/store/connectionSlice.ts` is the FSM: a single `status` field + an `ALLOWED` transition
map + a `canGo` guard. States: `idle | creating | awaitingPeer | joining | pairing |
awaitingSas | confirming | connected | failed`. Illegal transitions are ignored (warn in dev).
(Identity enrollment is an action on `connected`, not a state; SAS timeouts lead to `failed`
without adding states. **Reconnect re-auth (4b-ii) adds NO states** — it reuses `joining →
awaitingPeer` (waiting for the other device at the derived rendezvous) `→ pairing → confirming →
connected | failed`; there is no SAS fallback any more.) **An authenticated channel that dies** — the
DataChannel closes, the connection closes, ICE fails, or it sits in `disconnected` past the backstop —
ends as `connected → failed` with `connection lost: <signal>` (`CONNECTION_LOST_PREFIX`), again no
new state (see [transfer.md](transfer.md) § File transfer → *Liveness after connect*).

**Hard invariant:** no file bytes flow unless the connection is authenticated (status reaches
`connected` / the `established` gate, i.e. after key-confirmation or mutual SAS-confirm). Keep
this as a single gate check.

## Signaling WS lifecycle (per-pair close-on-connect — presence decoupled from P2P liveness)
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

## Early frames and the channel-open window

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
night in 5 — see [security-audits.md](../history/security-audits.md) ("Reconnect stalled at `pairing` for 120 s") for the full chain, including how it was finally proved with the
DEV-only `?gateDelayMs=N` knob that makes the window deterministic.

**Corollary, learned the hard way: no branch on these paths may return silently.** A frame dropped for
a good reason and a frame never sent look identical from the outside, and both end in a deadline with
an empty log. Log which guard fired; fail closed on states that should be unreachable.
