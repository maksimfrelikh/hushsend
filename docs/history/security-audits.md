# Security audits — the internal passes (2026-09-12 onwards)

Dated records, moved out of BACKLOG.md on 2026-10-11 when it became a list of open work only. Each entry
was true on its date; the current state is in the living documents (see [README.md](README.md)).

## Security audit — scrutinize before public launch

Surface area for an independent security audit before the public launch — pointers to the
security-sensitive decisions already made, gathered in one place (not a restatement; each links to
where the design + rationale live).

**First internal pass done 2026-09-12** (code review + reasoning, no devices): (a) and (b) hold as
designed — with a sharper argument than the docs carried; **(c) does NOT hold as claimed** — see the
finding below. Three actionable items came out of the pass and are listed after the three checks.
An INDEPENDENT audit is still wanted; this pass only removes the known-unknowns.

- [x] **(a) Reconnect role create/join → id-order (deferred) — REVIEWED 2026-09-12: keep create/join.**
  The safety property itself is role-INDEPENDENT: both branches of `onReconnectProof` run the
  two-check verify BEFORE `settleReconnect`, so no side can reach `established` under an unpinned key
  whatever the roles are. What create/join actually buys is **disclosure ordering**: the initiator
  verifies first and only then sends its own proof, while the responder proves FIRST (it reveals its
  long-term Ed25519 public key + a channel-bound signature before it has verified anything — gated
  only on holding a pin for the announced `pairingId`). Create/join pins the *creator* — the side that
  opened the reconnect room — to the verifier-first seat, so a stranger who reaches the channel never
  extracts the creator's identity key. Under id-order the seat is decided by **server-assigned ids**,
  so ~half the time the creator would prove first to whoever won the join race.
  **The concrete blocker for a move, though, is not crypto but plumbing:** the reconnect initiator is
  also *the side that knows WHICH `pairingId` to reconnect under* (chosen in the UI —
  `createReconnectSession(pairingId?)` reads it from the recent-devices row; the joiner only types a
  code). `pairingRoleFor` would hand the initiator seat to whichever id sorts smaller, which may be
  the side that has no pairingId to announce. So a lobby-pick reconnect needs an **announcer role
  separate from the transcript role**, not a reuse of `pairingRoleFor`. Recorded here so the next
  attempt does not rediscover it.
  **MOVED 2026-09-25 — the role now comes from the DTLS fingerprints (`reconnectRoleFor`), and the
  argument above is satisfied differently.** The disclosure-ordering property ("a stranger who reaches
  the channel never extracts an identity key") no longer rests on WHICH side proves first: it rests on
  the `reconnect-hello` MAC under the pairing secret, which every side must verify before it sends a
  proof — so the responder discloses its key only to a peer that has already proven it holds the
  pairing (i.e. already holds that key). Fingerprint order is not the server's to choose (the ids
  were), and a MITM that presents its own certificates fails the channel binding whatever role it
  lands in. The plumbing blocker is gone too: nobody announces a pairingId — both sides derived the
  rendezvous from it. The key-changed-before-settle ordering was re-checked under the new roles:
  both branches still run the two-check verify BEFORE any settle, and the initiator now settles only
  on the responder's `reconnect-ok`, which is stronger than before (no half-connected pair).
  (→ [reconnect.md](reconnect.md) § Reconnect UX + CLAUDE.md [methods.md](../architecture/methods.md) § Per-pairing role + [crypto.md](../architecture/crypto.md) § Crypto / Reconnect.)
- [x] **(b) Guess-narrowing of `peerLeftAbortsPairing` (WS-close) — REVIEWED 2026-09-12: CONFIRMED, the
  bound is intact.** The docs' argument (the authoritative counters are confirmation-mismatch and
  channel-close, both untouched) is correct but not the load-bearing one. The bound actually rests on
  a structural invariant that is stronger and easier to check: **the creator returns to "accept another
  joiner" ONLY through `onWordsPairingFailure`, which increments the counter** (one-shot per attempt via
  `attemptResolved`), **and `onPeerJoined` refuses to engage a newcomer while `this.peer || this.role`
  is set**. So an attacker cannot park an unresolved attempt (channel open, signaling socket closed —
  the `peer-left` the narrowing now ignores) and start a second one beside it: the creator is simply
  not accepting anyone until the current attempt resolves, and every resolution counts. Independently,
  the words room TTL is armed from CREATE and never re-armed (`WORD_ROOM_TTL_MS`, 180 s) → `closeRoom`
  → 4010 → `onSignalingClose` fails the client, so wall-clock bounds the attempt count too. Every
  *informative* guess needs the DataChannel (the confirmation tag rides it), and both of its outcomes —
  tag mismatch, or channel close before `established` — are counted regardless of signaling presence.
  (→ [connection.md](../architecture/connection.md) § Signaling WS lifecycle.)
- [x] **(c) Strict relay filter — REVIEWED 2026-09-12: did NOT hold as claimed → FIXED the same day.**
  The filter is correct for what it does — it drops every SIGNALLED `typ relay` candidate and never
  requests TURN — but that is not the same as "no relay path can complete on our side", because ICE
  also learns candidates it was never told about. Closed by verifying the path we actually got (see
  the finding below, now DONE). (→ [privacy-and-ice.md](../architecture/privacy-and-ice.md) § Privacy mode + ICE / Max-privacy strict model.)

- [x] **SAS refusals carry the same weight as the confirms — decided 2026-09-12, RESTORED 2026-09-26.**
  The refusal used to be a faint text link, which made the safe action the quietest element on the
  screen of a ceremony whose entire purpose is for a human to refuse; the audit made it a full-width
  button of the confirm's size. The first cut of the Claude Design redesign (2026-09-26) followed the
  boards and composed it as the tertiary uppercase label again; the owner reverted that the same day:
  both refusals ("Stop — they don't have this phrase", "None of these match — stop") are quiet pills
  with the confirm's geometry (the kit's `.pill`, 52px, full width) directly under it. Rationale: a
  small "stop" biases the human toward confirming, and the confirm is the only gate on the reader
  side. This is the one place the boards are overruled ([ui.md](../architecture/ui.md) § UI / styling; TESTPLAN A4a).

### Findings from the 2026-09-12 pass (actionable)

- ✅ **Max-privacy can still be relayed via a PEER-REFLEXIVE candidate (broke the STRICT claim) —
  FIXED 2026-09-12.**
  `shouldDropCandidate` filters candidates we ADD (`PeerConnection.addIce`); it cannot filter the ones
  ICE **learns**. Per RFC 8445 §7.3.1.3 an agent that receives a STUN binding request from a transport
  address matching no known remote candidate creates a **peer-reflexive remote candidate** and runs a
  triggered check against it. A **Reliable** peer relaying through coturn sends its checks FROM the
  relayed address (its TURN permission covers our signalled host/srflx), so our Max-privacy side
  learns that relayed address as `prflx`, pairs with it, and can nominate it — **after** we dropped the
  very same address as `typ relay`. When the direct path works this is harmless (the direct pair has
  higher priority); it bites exactly in the case the strict model exists for — **direct fails, so the
  relayed prflx pair is the only valid one → we connect through the relay instead of failing closed.**
  Reachable in the supported **mixed-privacy** configuration (Max ↔ Reliable); a Max ↔ Max pair has no
  relay anywhere and is unaffected. **Impact is the privacy promise, not confidentiality** — DTLS +
  SAS/PAKE are untouched and no MITM is enabled; what breaks is "Max privacy ⇒ your traffic never
  transits a relay", since the relay (our own coturn, which the threat model treats as UNTRUSTED) then
  sees both IPs, timing and volume, and the user was told that could not happen.
  **Fix as built:** `PeerConnection.addIce` now records the endpoint of every candidate the filter
  drops (`relayCandidateEndpoint` → `endpointKey`, `address|port` — `|` because IPv6 is full of
  colons), and `openChannelUnlessRelayed` runs at DataChannel open **before `onOpen` reaches the
  SessionController**: it reads `pc.getStats()`, resolves the selected pair with
  `selectedRemoteCandidate` (transport `selectedCandidatePairId` → Firefox `selected` →
  nominated+succeeded → succeeded) and refuses via `isForbiddenRemoteCandidate` when the remote is
  typed `relay` OR sits on a dropped endpoint. A refusal reuses the terminal direct-failure path
  (`onIceFailure` → `onIceFailed` → `failDirect` + switch-to-Reliable hint) and `onOpen` never fires,
  so **no byte crosses a relayed path**. Deliberately NOT blanket-rejecting `prflx` (legitimate NAT
  mappings produce it on direct paths). **Unavailable/empty stats used to read as "unknown, never
  relay" — that was finding F1, fixed 2026-09-13: see the F1 entry below.** Unit tests in `relax.test.ts` cover both
  pure halves (including the IPv6 and Firefox-`ip` shapes). **The REFUSAL branch now has direct e2e
  coverage too (2026-09-12):** `?forceRelayPath=1` (DEV-only, tree-shaken) stubs the gate's VERDICT and
  nothing else, so the refusal, teardown and the reason the user sees are all production code —
  reproducing it for real would need a relaying peer AND a failed direct path, which no loopback test
  can build. `tests/e2e/relax.spec.ts` asserts the refusing side reaches the terminal `failed` with the
  switch-to-Reliable hint, that the peer does not hang, and that NO transfer UI ever renders (no byte
  crossed) — beside a CONTROL case where the same pairing without the knob still authenticates, since
  a gate that refused everything would pass the first test.
  **Still to confirm on real devices (TESTPLAN § C4):** Max ↔ Reliable with the direct path forced to
  fail — the Max side must now land on `failed` + the hint, and `chrome://webrtc-internals` must show
  no relayed selected pair.
  **Residual (open):** the check runs at channel-open only. A mid-session ICE **re-nomination** onto a
  learned relay path (the direct path dies later, the relayed prflx pair takes over) is not re-checked.
  Re-running the check on `iceconnectionstatechange` would cover it, but tearing down a live transfer
  on a stats read needs its own care — left deliberate and documented rather than half-done.
- [x] **No client-side liveness deadline on the words / link / qr key-confirmation path — FIXED
  2026-09-12.** `armConfirmTimeout` / `clearConfirmTimeout` (`SessionController`) arm a 120 s deadline
  in `runKeyConfirmation` — the moment the channel is open and our own tag has gone out — and disarm
  it on settle, on every failure and on every teardown. Expiry routes to the existing
  `onConfirmFailure`, so words counts the attempt and link/qr hard-stops, exactly as a bad tag does.
  Fail-closed, liveness only: no crypto, transcript or guessing budget changes. Original text below.
  - **(original)** `room`/SAS
  has `armSasTimeout` (pre-SAS + comparison, 120 s) and reconnect has `armReconnectTimeout` (120 s),
  but the 1:1 confirm path has **none**: a peer that opens the DataChannel and then simply goes silent
  (never sends its `confirm` tag) leaves us in `confirming` until the SERVER's from-create room TTL
  (`WORD_ROOM_TTL_MS` / `TOKEN_ROOM_TTL_MS`, 180 s) closes the socket and `onSignalingClose` fails us.
  So liveness on this path is **delegated to the untrusted server** — a server that simply never
  expires the room hangs the client indefinitely, which is precisely the failure mode the reconnect
  deadline was added to remove. Same shape, same fix: arm a 120 s deadline at pairing start on the
  words/link/qr path, cleared on settle/failure. Fail-closed, liveness only — no crypto change.
  (Note this does NOT affect the guessing bound above: it is the *creator* who hangs, and a hung
  creator accepts no further attempts.)
- ✅ **`pairingId` disclosure to whoever wins the reconnect join race — FIXED 2026-09-18.**
  A reconnect rendezvous is a plain 4-digit room (`createReconnectSession` → `connect({create:true})`,
  no codeType), NOT a lobby, so it auto-pairs with the first peer that joins. 10⁴ is enumerable —
  bounded only by `IP_RL_MAX` — so a code-guesser that won the race and reached the open channel
  received the initiator's `reconnect-init` carrying the raw **`pairingId`**, a stable per-pair
  identifier, before any authentication. It could never forge a proof, which is exactly why this sat
  as "linkability + nuisance, not an auth break" through two audits; for this product's users,
  something that links two anonymous rendezvous to one relationship is not a nuisance.
  **Fix:** the initiator now announces `HMAC(key = pairingId, DOMAIN ‖ fp_min ‖ fp_max)` truncated to
  the id's own length (`blindPairingId`, `crypto/reconnect.ts`). Keyed by the secret both peers
  already share and bound to THIS session's DTLS fingerprints, so a peer holding the pin recognises
  it by RECOMPUTING (`matchBlindedPairingId` scans its pins — there is no way to invert it), while a
  stranger sees 16 bytes that differ every session and correlate with nothing. Nothing in the crypto
  changed: the signature transcript still binds the REAL pairingId, which both sides know.
  **Truncation is about compatibility, not size.** Keeping the wire field the same length means a
  peer on an older bundle still PARSES the frame, fails to match, and sends `reconnect-fallback` — so
  a mixed pair degrades to the SAS comparison instead of failing schema validation and hanging until
  the 120 s deadline. Verified by accident and then on purpose: reverting only the sender produced
  exactly that fallback, not a hang.
  9 unit tests (`reconnect.test.ts`) pin the properties that matter — same length, both sides derive
  it, DIFFERENT every session, channel-bound, unknown pin → null. An e2e reads the frames the
  DataChannel actually sent and asserts the pinned id appears in none of them, because unit tests
  prove the tag differs from the id and not that the tag is what goes out. **Negative control run:
  with both halves reverted the e2e fails on precisely that assertion while the reconnect itself
  still succeeds**, so the test isolates the leak rather than the feature.
  **Superseded 2026-09-25:** `blindPairingId` / `matchBlindedPairingId` and the `reconnect-init` frame
  are deleted — the codeless reconnect announces nothing at all (the rendezvous is derived from the
  pairingId, the hello is a MAC under it). The e2e that read the wire now asserts the hello carries
  only `{challenge, mac}` and that the socket URL's room name is a link-shaped token, not the id.
- ✅ **(F1) The Max-privacy channel-open gate read "cannot tell" as "no relay" — FIXED 2026-09-13.**
  `openChannelUnlessRelayed` asked `selectedPathIsRelayed()`, which took `isForbiddenRemoteCandidate`'s
  `!remote → false` branch for an answer. But `selectedRemoteCandidate` returns null until ICE
  publishes a selection, and **its own docstring already said the caller must read that as unknown,
  NEVER as safe** — so the gate whose entire purpose is to make STRICT true could open a channel on a
  path it had not looked at. Not theoretical: this codebase's other consumer of the same resolver,
  `SessionController.verifyPath`, needed a 20×250 ms poll for exactly this condition, and it runs
  LATER in the session than the gate does. Same class as the peer-reflexive finding above — a control
  that is silently inert — and reachable in the live deployment, where `TURN_SECRET`/`TURN_URLS` are
  configured and Max ↔ Reliable pairs therefore exist.
  **Fix as built:** the policy moved into `relax.classifySelectedPath` (pure, injected clock/sleep/
  stats-reader, so it is unit-testable without a browser) and returns `direct` | `relayed` |
  `undetermined`. The gate now opens ONLY on `direct`; `undetermined` takes the same terminal refusal
  path as `relayed`. A null read CONTINUES the poll rather than ending it, so a transient `getStats()`
  rejection does not decide the session, while an engine with no `getStats()` at all never yields a
  judgement and is refused — the honest outcome, since the Max-privacy promise cannot be kept on an
  engine that cannot report its own path.
  **Measured before changing the policy** (the point being not to repeat the mistake of deciding from
  a loopback intuition): chromium, firefox and webkit each report a selected pair on the **first** read
  after DataChannel open — 0–1 ms, 3/3 runs per engine — so a healthy connection never waits and the
  5 s deadline is insurance, not latency. 9 unit tests in `relax.test.ts`, one of which reproduces the
  old wave-through against the old expression. Full suites after the change: 243 unit,
  firefox e2e 33/33, webkit+interop 38/38.
- ✅ **(F2) A detected interposer was displayed identically to an ordinary Safari — FIXED 2026-09-13.**
  `pathSettled` took `{ confirmed: boolean }` and stored `'yes' | 'no'`, so `mismatch` — the only
  positive evidence this system can produce — collapsed onto `unknown`, which is the ORDINARY outcome
  on Safari/iOS. Same badge, same class, same hint; and that hint states the cause as *"this browser
  does not expose enough to check it. Safari never does"*, which on a mismatch is simply untrue — the
  browsers exposed plenty, the check ran and disagreed. Because `Diagnostics` (which holds the real
  verdict) is tree-shaken out of production — verified against the served bundle: `path-verdict`
  appears 0 times — the detection had **no representation anywhere a user could see it**, while the
  benign state it hid behind is common enough to train people to ignore it.
  The original reasoning for collapsing — that a `mismatch` is not reliable enough to accuse anyone
  with, since honest firefox↔webkit pairs produce it — is still right, and nothing here turns it into
  an accusation. What was wrong was the consequence. **Fix as built:** `connection.pathCheck` carries
  the verdict three-way; `mismatch` gets its own label (`⚠ route did not match`), its own weight
  (`hs-badge--alert`, the inverted fill the design language already uses for danger) and its own copy,
  which names BOTH causes and ends with something to do. `ok` shows no hint at all. Regression tests:
  3 in `connectionSlice.test.ts` (the reducer could not even represent the difference before) and an
  e2e in `privacy.spec.ts` driven by a new DEV-only `?forcePathMismatch=1` that stubs the VERDICT
  only — badge, class, hint and the absence of a teardown are all production code — asserting the
  mismatch side is distinct from both other states while the honest side stays `ok` with no hint.
- ✅ **(F4) Code comments asserting controls that do not exist — FIXED 2026-09-13.** Two call sites
  read `startPathAttestation(); // verify WHO is on the path — gates file bytes`, and `verifyPath`'s
  docstring opened with "`mismatch` is a HARD STOP on the same terminal path as a SAS mismatch". The
  body has never done either. [privacy-and-ice.md](../architecture/privacy-and-ice.md) § Path attestation carried the same claim
  ("`mismatch` → terminal, same teardown as an authenticity failure"). This is the repo's own
  documented failure mode — confident prose read as specification — having moved from the docs into
  the code, where two audits passed over it. All four corrected, and the advisory status is now stated
  at the top of the function that would have to implement the control.

- ✅ **Verifiable delivery, first step — BUILT 2026-09-13.** THREATMODEL § 1's top-ranked risk, and the
  pass found its hardest technical precondition already satisfied but unnoticed: **the production
  build is byte-for-byte reproducible.** A fresh `vite build` with the deploy script's environment
  reproduced all eight files of the served tree exactly, JS included. What was missing was only the
  attestation half — CI ran typecheck/lint/vitest/e2e but never built the bundle.
  **Built:** `.github/workflows/ci.yml` job `build-attest` builds on a GitHub runner, **builds twice
  and fails unless the two are byte-identical** (without that guard a published hash is meaningless,
  because "live ≠ CI" would become the ordinary outcome), publishes the SHA-256 manifest in the public
  run summary, uploads it as an artifact, and attaches a signed provenance attestation via
  `actions/attest-build-provenance` — verifiable with `gh attestation verify`, recorded in a public
  transparency log. `deploy/build-env.sh` is now the single source of the VITE_* values baked into the
  bundle (the deploy script and CI both source it — two copies that agree today would be a silent
  break tomorrow, and the break would look like tampering). `deploy/bundle-manifest.sh` generates the
  manifest for both sides; `deploy/verify-bundle.sh` checks a LIVE deployment against it.
  **Verified end-to-end, not just written:** the verifier was run against production and matched all
  8 files including the lazily-fetched `.wasm` whose path only appears inside the JS; both negative
  cases (one altered hash, one manifest entry the host does not serve) exit 1 loudly; the CI step
  sequence was executed locally and the two builds were byte-identical.
  **Stated limits** (in `deploy/verify-bundle.sh`'s header, README and THREATMODEL, because
  overclaiming here is the exact failure mode this repo keeps hitting): it does nothing for a browser
  already served a hostile bundle; selective tampering at one IP is caught only by someone checking
  from that vantage point; and it proves the bytes match a build of a commit, not that the commit is
  honest. It removes "silently" — nothing more, and that is worth having.
  **Still open:** no scheduled check from an unrelated network, no independent mirror, no
  pre-delivered client (extension / desktop). Those are the forms that protect the user at load time.

- ✅ **(F3, partial) The network exposures are now stated in the UI — 2026-09-13.** The pass found an
  exposure listed nowhere: there is no ECH on this deployment, so the TLS handshake carries
  `hushsend.frelikh.dev` in **cleartext SNI**, and an observer therefore learns "this person opened a
  privacy file-transfer tool" from ONE side, without decrypting anything and before any transfer
  happens. For this audience that fact is frequently the one acted on — it is upstream of the
  social-graph residual, which at least requires a transfer to occur. Neither it nor the social-graph
  residual appeared anywhere in the interface: the privacy toggle says only "your peer sees your IP",
  which is a much smaller claim than "your provider sees that you used this, and who with".
  **Built:** a collapsed `<details>` on the landing (`NetworkExposure`, testid `network-exposure`),
  EN + RU, naming both exposures and ending in the only action that helps — Tor or a VPN **on both
  sides**, since one side alone does not address the direct-connection point. Collapsed deliberately:
  both are permanent properties of the deployment rather than events, and a standing banner would be
  dismissed within a day AND would train users to dismiss the path-attestation badge, which does
  report an event. e2e in `smoke.spec.ts` asserts it is present, starts collapsed, is honest in the
  summary line alone, and carries all three points once opened.
  **Still open — this is disclosure, not mitigation.** Removing the exposure needs an onion service, a
  mirror on a domain that is not obviously this tool, or ECH. Also note the whole deployment is one
  name on one IP (app + signaling + STUN/TURN), so it is trivially blockable and public in CT logs.

**The e2e flake, chased to a cause rather than rerun away:**

- ✅ **Reconnect stalled at `pairing` for 120 s — ROOT CAUSE FOUND AND FIXED 2026-09-17.** Took three
  sessions, two wrong theories and one broken experiment, so the whole chain is recorded here rather
  than the conclusion alone.

  **The bug.** `PeerConnection.setupChannel` wires `onmessage` SYNCHRONOUSLY, while `onopen` runs the
  Max-privacy relay gate, which AWAITS `getStats()` before handing the channel to the
  SessionController. Between those two moments the channel already delivers peer frames but
  `rc.fps` is not set yet — so the initiator's `reconnect-init`, landing in that window, hit
  `if (!rc.fps) return` in `onReconnectFrame` and was discarded **permanently**. The sender never
  resends (it considers itself announced), so both sides sat in `pairing` until the 120 s deadline,
  with NOTHING written to the dev log. Confidentiality was never affected; what broke was
  reconnecting to an already-known device — roughly 1 CI engine-matrix night in 5, and 4 of 8 local
  webkit runs.

  **Fix:** hold the early frame and replay it once `rc.fps` is set (`pendingReconnectFrame`). Not an
  invention — `pendingEnrollFrame` and `pendingPathAttest` already do exactly this for the same class
  of race; reconnect was the one path without the guard.

  **How it was proved, after hunting failed.** Chasing the flake did not work: with instrumentation in
  place it went 6 full webkit runs without reproducing. So the window was made controllable instead —
  `?gateDelayMs=N` (DEV-only, tree-shaken, verified `function aA(){return 0}` in the built bundle)
  holds the channel back from the owner on ONE side. It stubs nothing else: the drop/hold decision,
  the deadline and the state machine are all production code. With the window widened and the fix
  removed, the failure is **deterministic — 5 of 5** — and its signature is the production one
  verbatim: `Expected: "connected", Received: "pairing"`, 123 polls. Regression test:
  `reconnect.spec.ts` "reconnect-init arriving before channel-open is held, not dropped".

  **A wrong experiment worth recording.** The first old-vs-new comparison showed the OLD code passing,
  which nearly produced the conclusion "hypothesis refuted". The flaw was in the experiment: removing
  the fix by stashing `SessionController.ts` also removed the `gateDelayMs` wiring declared in the
  same file, so the "old code" ran with no delay at all and had no race to lose to. Revert the
  BEHAVIOUR under test, never the instrument that creates the condition.

  **Evidence for the fix, at its real strength.** Full webkit suite after: **0 failures in 6 runs**,
  against 4 in 8 before. All engines green afterwards (79 passed, chromium/firefox/interop/mobile).
  That is strong, not conclusive: in the wild the window is a few event-loop turns rather than 3 s, so
  whether this accounts for EVERY nightly failure is for the nightly matrix to say over the coming
  days. Watch it.

  **Contributing, and stated plainly: the F1 gate widened the window.** `SELECTED_PAIR_TIMEOUT_MS`
  turned the await into a bounded poll of up to 15 s, so a change made for Max-privacy correctness
  very likely made this pre-existing race more frequent. The race predates it (baseline `6d11d1c`
  failed identically), but the honest statement is that the two interacted.

  **Related fix in the same pass: the silent branches now speak.** Every drop on the reconnect path
  logs which guard did it, channel-open logs what it decided, and the unreachable
  "initiator without a pairingId" now fails closed with a reason instead of 120 s of silence. That
  ambiguity is what made this expensive to find: a dropped frame and a never-sent frame looked
  identical from outside.

  **Earlier contributor, fixed separately (2026-09-13) and still worth keeping:** browser processes
  accumulated across a run because `reconnect.spec.ts` was the only spec closing its contexts —
  measured 31 at peak and climbing, now 12 and flat. That closed the chromium half; it was never the
  whole cause, and this entry is the rest of it.

- ✅ **CONFIRM the reconnect fix on the nightly matrix (opened 2026-09-17) — CLOSED 2026-09-29.** The root cause is
  proved and its regression test is deterministic, but in the wild the window is a few event-loop
  turns rather than the 3 s the test forces — so whether it accounts for EVERY nightly failure is
  still open. Baseline to beat: the engine matrix failed 1 night in 5 (13–16 Sep green, 17 Sep red,
  all on the same commit). **Watch `e2e (firefox · webkit · interop · phone profile)` for ~5 nights
  from 18 Sep.** Green throughout ⇒ close it. A failure ⇒ read the dev log in the report, which now
  names which guard dropped what; that is exactly what the logging in this commit was for.
  **Night 1 of ~5 — 18 Sep, GREEN** (commit `9b42ccad`, engine matrix 5.6 min). Worth almost nothing
  on its own, and recorded as such: the matrix was green 4 nights in 5 BEFORE the fix, so one green
  night is the expected outcome about 80% of the time either way. The load-bearing evidence is still
  the deterministic reproduction (5/5 failures without the fix, passes with it) and 0-in-6 webkit
  suite runs after. This is corroboration accumulating, not a result.
  **Closed 2026-09-29: 12 green nights in a row, 18–29 Sep** (read from the public Actions API: every
  scheduled run `success`, and in each of the 12 the `e2e (firefox · webkit · interop · phone profile)`
  job itself ran and passed — not skipped), across `9b42cca`, `1fac03a` ×7, `35e813a`, `79e3624`,
  `c5a51c4` and `273e9e7`. With the old rate (red 1 night in 5) twelve greens by chance is 0.8¹² ≈ 7 %,
  and the deterministic reproduction still carries the weight. The only red scheduled run between
  2026-09-13 and the closure is 17 Sep, the night that opened this item. (The red nights of 1–2 Oct
  are the integration job's relay test, not the engine matrix — [followups-and-ops.md](followups-and-ops.md) § Ops / housekeeping.)
- ✅ **Reconnect spec's patience raised above the app's own deadline (2026-09-17).** The app fails a
  stalled re-auth at 120 s (`DEFAULT_RECONNECT_TIMEOUT_MS`) while the spec waited 60 s, so the test
  gave up first and "the app stalled" was indistinguishable from "the app failed correctly" — the
  ambiguity that cost three debugging sessions. Now 140 s, with the per-test budget at 300 s to fit.
  Deliberately not done while the stall was unexplained; safe once the cause was found.

- **Path attestation, and separating STUN from signaling** — still open: their current state is in [[BACKLOG.md](../../BACKLOG.md) § Security — open](../../BACKLOG.md#security--open).

- ✅ **Cross-check several independent STUN servers in the client — BUILT 2026-09-17.**
  `core/stunCheck.ts`: one throwaway `RTCPeerConnection` per configured STUN URL, each with only that
  URL, then compare the public addresses they report. `agree` / `disagree` / `unknown`, projected to
  the DEV strip always and to the USER only on `disagree` — a badge that is always green is a badge
  people stop reading (the F2 lesson). Advisory: nothing is gated on it.
  **The obvious design does not work, which is why this was measured before it was written.** Putting
  several STUN URLs in ONE `iceServers` entry does not give one result per server: ICE prunes
  redundant candidates before the application sees them, so chromium and webkit both yield a SINGLE
  srflx candidate attributed to the first URL, and a disagreement is invisible. Separate probe
  connections were verified to give per-server views with `url` attribution on chromium and webkit.
  **Firefox reported no srflx candidate at all** in that measurement and exposes no `url` field on
  local candidates — on loopback, where the reflexive address equals the host address and is
  legitimately pruned, so this is not yet evidence about Firefox on a real network. `unknown` is
  benign by design, so the feature degrades rather than breaks there. Worth recording properly in the
  real-device pass.
  **Limits, stated up front:** address only, never the port (each probe uses its own socket, so even
  an honest NAT varies the port); a multi-WAN or CGNAT client can disagree HONESTLY, so a
  disagreement is shown and never acted on; and it says nothing at all while one server is
  configured — which is today's deployment.
  8 unit tests (`stunCheck.test.ts`) pin the policy, including that `unknown` and `disagree` stay
  distinct. e2e in `privacy.spec.ts` asserts a real verdict is reached with two servers rather than
  silently sitting at `unknown`; the nightly CI matrix now starts a SECOND coturn so it actually runs
  there instead of skipping forever.
  **Still open, and it is the operational half:** this is the client side of a property that only
  starts to exist when the STUN servers are run by DIFFERENT people. Today app, signaling and STUN
  are one IP (the repos are separate, the machines are not).
- **`pairingId` disclosure to whoever wins the reconnect join race** — closed twice: blinded on
  2026-09-18 (the entry under the first pass above), then made moot on 2026-09-25 when the 4-digit
  reconnect room was removed with the code — nothing is announced any more ([reconnect.md](reconnect.md) § Reconnect UX).

### Codeless reconnect (2026-09-25)

- ✅ **The reconnect code is gone — see [reconnect.md](reconnect.md) § Reconnect UX for the design and what it closed.** From the
  audit's point of view, what moved: (1) the reconnect rendezvous went from an enumerable 4-digit room
  to a 128-bit token derived from the pairing secret, taken join-or-create, indistinguishable on the
  wire from link/QR (link/QR creators draw their own token now, so `create=1` is no longer a signal of
  who initiated either); (2) a `reconnect-hello` MAC under the pairing secret gates every proof, so
  the long-term identity key is disclosed only to a proven pin-holder — this is what let the role move
  off create/join (item (a) above); (3) the initiator settles only on `reconnect-ok`; (4) the SAS
  fallback that ran UNDER the reconnect is gone, which also removes the "mismatched entry" class
  entirely. **Open for the independent audit:** the pairingId is now load-bearing as a secret — its
  storage is the same IndexedDB as the pins (readable by an XSS or a hostile extension; the identity
  key has the non-extractable WebCrypto protection, the pairingId does not), and the derivations
  (rendezvous, hello) should be read with that in mind. The 10-min bucket is a stated linkability
  trade (same-bucket retries show the same token); the time input is the client's own clock, never
  the server's.
- **Server-side, `hush-signaling-server`:** token rooms are join-or-create and the managed TTL is
  armed whenever a room comes into being (`created`), not only on `create=1`. Integration-tested
  (`room-server.test.ts`: first arrival opens, second finds, third bounced 4002, TTL fires on a
  joined token, the 4-digit shape still says 4009). Deployed to the running copy the same day.

### Volume padding + a receiver bound (2026-09-17)

- ✅ **Volume padding — BUILT, on in Max privacy.** THREATMODEL road-map item 6, previously marked
  optional. Without it the contents are unreadable but the VOLUME is not hidden: chunks are
  16–256 KiB and the total is ≈ the file size, so anyone on the path reads "4,723,811 bytes in 12 s",
  and against a known candidate set an exact byte count identifies a document about as well as its
  name would. `core/transfer/padding.ts` sends filler after the real bytes so the total lands on a
  bucket edge: powers of two below 1 MiB (small files are the most identifiable and the cheapest to
  hide), then steps of an eighth of the leading power of two above it.
  **The ladder is a stated trade, not a default that happened.** Powers of two throughout would hide
  the most and cost up to 2× bandwidth — unacceptable for people on metered and slow links, which is
  this product's audience. The ceiling is therefore 12.5%, and the cost is resolution: above 1 MiB an
  observer still learns the size to within 12.5%, which against a SMALL candidate set may still
  identify a document. `BUCKETS_PER_OCTAVE` is the one constant to change if that trade should go the
  other way.
  **What it does NOT hide, in the module header so nobody reads more into it:** duration and timing,
  the fact that a transfer happened or between whom, and the number of transfers.
  **Max privacy only.** That mode already refuses to connect rather than relay, so trading bandwidth
  for privacy is the same bargain; Reliable was chosen for convenience and relays anyway.
  No wire-protocol field was added — both sides derive the bucket from the declared size, and the
  receiver simply stops writing at it. 8 unit tests pin the ladder (monotonic, never truncating,
  overhead capped); an e2e counts the bytes the DataChannel actually put on the wire and hashes what
  arrived, because unit tests prove arithmetic and not that the filler is sent, dropped and harmless.
- ✅ **The receiver now writes at most the size the sender DECLARED.** Found while building the above.
  The size guard ran BEFORE accept, against the declared size, and nothing enforced it afterwards — so
  on the streaming path (Chromium File System Access, which has no RAM ceiling to stop it) a sender
  could declare 2 MB and write whatever it liked to the user's disk. The peer is authenticated and the
  two humans trust each other, so this was never a stranger attack; but "you accepted 2 MB" must not
  be able to become 50 GB on disk, and the bound is what makes padding invisible anyway.

### Doc corrections made in the same pass

- **[claude-md-retired-sections.md](claude-md-retired-sections.md) § Known residuals overstated the `pairingId` leak.** It said reconnect "announces it over
  signaling-routed setup, so the untrusted relay can observe 'these two have paired before'". It does
  not: every reconnect frame rides the **DataChannel** (`sendReconnect` → `this.peer.send`), which is
  DTLS-protected, and `pairingId` appears in **no** signaling schema (`src/types/protocol.ts`). The
  relay never sees it. The linkability residual is real but arrives by a **different** route — see the
  next item — and the text has been corrected to say so.
- **The actual reconnect fingerprint the relay CAN see: the post-connect socket close.** Every other
  method closes its own signaling socket the instant it reaches `connected`
  (`closeSignalingAfterConnect`), and **reconnect WAS explicitly excluded** — so a reconnect pair was the
  one pair that *kept its socket open for the whole session*. That handed the untrusted server both
  "this pair is a reconnect (they have paired before)" AND the session duration the close was designed
  to hide. ✅ **FIXED the same day** — reconnect was folded into the per-pair close together with the
  `peerLeftAbortsPairing` gate it required (see residual (a) under [connection.md](../architecture/connection.md) § Signaling WS lifecycle).
