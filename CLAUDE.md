# hushsend — project guide for Claude Code

Privacy-first P2P file transfer. Browser-to-browser over WebRTC/DTLS (end-to-end); the
server only does **signaling** (rendezvous + relaying opaque SDP/ICE). The signaling server
is **untrusted** — all confidentiality and authenticity are established client-side
(PAKE / SAS + DTLS), with TOFU key pinning.

Repo layout: the Vite frontend is at the repo root; the signaling server lives in `server/`
(own `package.json`, dep `ws`) so it can be split into its own repo later. Keep it
self-contained; do **not** create a shared types package between client and server —
duplicate the small signaling protocol instead.

## Keep this file in sync (read this first)
This file + the repo are the ONLY context a fresh session has — sessions do not remember prior
work. So whenever a change alters the app's actual state, update this file in the SAME pass:
- completing or advancing a build step → update **Build order** and **Current state** markers;
- adding / removing / renaming a core module → update the file lists in **Current state**;
- changing a protocol, constant, or invariant → update the relevant **Crypto** / method section;
- deferring something → note it under **Known residuals / deferred**.
- **THREATMODEL.md** answers "what is protected, from whom, and is this ready for at-risk users".
  It is the file to check when a claim about safety is about to be made or changed — and the one to
  correct in the same pass when a defence lands or is found wanting.
- forward-looking / deferred work (step 6, follow-ups, nice-to-haves) lives in **BACKLOG.md** —
  read it when picking the next task, and update it in the SAME pass as this file when items land.
- **recorded numbers are claims too** — test counts (README § Status, BACKLOG's per-engine matrix),
  measured ceilings, live-host specifics. Re-run the thing and refresh the number, do not copy it
  forward.
- **the signaling server is a SIBLING REPO** (`hush-signaling-server`, next to this one; `server/`
  here is the local-dev copy) and the running checkout is `/var/www/hush-signaling-server`. A change
  to any of the three has to reach the other two's docs in the same pass — `.env.example` there is
  the env-var reference and must list every var the code reads.
Stale markers (e.g. a finished step still marked 🚧, or a built module missing from the
inventory) cause real rework for the next session. Treat doc drift as a bug.

## Stack (locked — do not swap)
- React + TypeScript, **Vite** — static SPA, **no SSR** (SSR contradicts the threat model).
- **Redux Toolkit** slices. **No RTK Query** (no REST surface; signaling is WebSocket,
  everything else is P2P DataChannel).
- No router — screens are driven by connection state.
- Raw `RTCPeerConnection` + `RTCDataChannel` (NOT PeerJS/simple-peer — we need control of
  SDP and the DTLS fingerprint for channel binding).
- Crypto: `@noble/curves` (+ `@noble/hashes`); WebCrypto where available.
- `zod` for validating inbound signaling frames.
- ESLint + Prettier; **Vitest** (unit) and **Playwright** (e2e, Chromium) — keep both suites green.

## Architecture — the one rule
All non-serializable, live objects (`RTCPeerConnection`, `RTCDataChannel`, `WebSocket`,
`CryptoKey`) live ONLY in the imperative core (`src/core/`, in `SessionController` and its
sub-modules). They never enter the Redux store and React never holds them. One-way flow:

`UI → SessionController method → work + dispatch → store → useSelector → UI`

The store holds only serializable projections (status, peer label, words to display,
transfer progress, error). RTK's serializability check stays ON.

## Connection state machine
`src/store/connectionSlice.ts` is the FSM: a single `status` field + an `ALLOWED` transition
map + a `canGo` guard. States: `idle | creating | awaitingPeer | joining | pairing |
awaitingSas | confirming | connected | failed`. Illegal transitions are ignored (warn in dev).
(Identity enrollment is an action on `connected`, not a state; SAS timeouts lead to `failed`
without adding states. **Reconnect re-auth (4b-ii) adds NO states** — it reuses `pairing →
confirming → connected | failed`, and `pairing → awaitingSas` when it falls back to SAS.)

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
  can no longer tear down a SAS pair where both humans already confirmed. (The **reconnect** branch
  still uses `!this.established` — it is a separate deferred scenario, reconnect-in-lobby; see BACKLOG.)
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
  by channel-open (the SAS gate above). **Reconnect** runs over its own fresh socket (method `room`,
  `sas` + `reconnect` set) and since 2026-09-12 is **INCLUDED** like every other method — the old
  `this.reconnect != null` guard in `closeSignalingAfterConnect` is GONE, so the function now gates on
  the method alone. Keeping the socket was itself a signal ("this pair has met before" + the session
  duration); `settleReconnect` calls the close, and the reconnect `onPeerLeft` branch moved to the
  `peerLeftAbortsPairing` gate so our own close cannot abort a peer mid-settle. **Failure paths**
  (`failDirect`, `failLink`, `failSas`, `failReconnect`, words retry) are untouched: the close is gated
  on the `connected` success branch only. Unit: `SessionController.sasPeerLeft.test.ts` (the
  channel-open race fix + the room per-pair close + reconnect, included since 2026-09-12). e2e:
  `tests/e2e/ws-close.spec.ts` (link + words: connect → socket closes → peer-left doesn't drop P2P /
  count a guess → transfer AFTER close intact); room/SAS + lobby behaviour stays green in
  `room-sas.spec.ts` / `lobby.spec.ts`.

## Connection methods (4)
All four resolve to the same FSM and the same DataChannel transfer; they differ only in how
peers rendezvous + authenticate.

### Per-pairing role (initiator/responder) — by readable-id order
`this.role` (the transport/crypto initiator|responder) is fixed **PER-PAIRING from the two readable
ids** — the lexicographically **smaller id is the `initiator`**, the larger the `responder`
(`src/core/pairingRole.ts` `pairingRoleFor`, unit-tested in `pairingRole.test.ts`) — **NOT** from
create/join. **Since the 2026-09-12 audit this is the TRANSPORT/crypto role only** — the SAS
reader/picker split no longer shares it (see below: it comes from the SAS material, because the ids
come from the untrusted server). **Why:** the room is a mesh lobby, so a 1:1
pair can be creator↔joiner OR joiner↔joiner; under the old "creator = initiator" rule two joiners were
**both `responder`** → nobody sent the WebRTC offer and the SAS commit-reveal (responder commits
first) deadlocked. Fixing the role from the ids guarantees exactly one initiator + one responder for
ANY pair; both peers compute it identically (ids are unique in a room) → opposite roles. It is
assigned once at pairing start (`SessionController.beginPairing`, both ids known) and drives: the
**WebRTC offer/answer** direction (initiator offers — sent by the smaller id, by EITHER side, not
"always the creator"), **CPace** init/respond (words), the **SAS** nonce order + commit-reveal (room,
mirrored into `sas.role`), and the **`lv(role)`** label in the **key-confirmation** (words/link/qr)
and **enrollment** transcripts. **For a 1:1 creator↔joiner pair the OUTCOME is unchanged** — same
connection, same authentication; only WHICH side offers/reveals first is now id-ordered. **Fail
closed**: an unresolved role (missing/equal id) hard-fails the pairing rather than defaulting a side
(a default could land both on the same role and deadlock). **Exception — reconnect:** the reconnect
PROTOCOL role (who announces the pairingId / who proves first / `lv(role)` in the reconnect
transcript) **stays create/join** (creator = reconnect initiator), independent of `this.role`, so the
verifier-first side is fixed and a key change is caught before a forger can settle; reconnect is 1:1
creator↔joiner (mesh reconnect is a later step). This per-pairing-role pass is the foundation for the
**Room lobby** (below), which is now built (step 6): the room method no longer auto-pairs — the human
picks whom to pair with, and the per-pairing role lets ANY pair (incl. joiner↔joiner) raise a correct
1:1 channel. words/link/qr still auto-pair 1:1 with the single peer.

### Room lobby (mesh — roster + pick) — done (step 6)
The 4-digit room is a **mesh LOBBY**, and the client now exposes it: the room method NO LONGER
auto-pairs. **Both the creator AND every joiner land in `awaitingPeer`** (a joiner takes the new
`joining → awaitingPeer` transition — no new FSM state) and see the same `LobbyScreen`: the shareable
4-digit code + a **roster** of everyone else in the room, each with a **Connect** button. The human
PICKS whom to raise a 1:1 channel with.
- **Roster projection**: `connection.roster: PeerInfo[]` (`{id, device, joinedAt}`), maintained by the
  core from signaling — `welcome` (set the existing peers) / `peer-joined` (add) / `peer-left` (remove,
  also clearing a stale busy notice). Serializable; the live objects stay in the core. (Seeded for all
  methods, but only the room `LobbyScreen` renders it.)
- **Pick → connect handshake** (room only, over the signaling relay; carries no secret — the SAS
  authenticates). On a pick the client sends the target a **`pair-request`** and engages via
  `beginPairing`, where the **per-pairing role decides who offers**: the **smaller id (initiator) sends
  the WebRTC offer** — on its own pick OR on a `pair-request` from the responder — while the larger id
  (responder) readies its answerer, sends its SAS commit, and waits. The `pair-request` readies the
  counterpart before the offer arrives. **Glare** (both pick each other) resolves naturally — only the
  smaller id offers; **dedup** is by `this.peerId`/`this.peer` (a duplicate pick, or a pair-request from
  the peer we already engaged, is ignored). Then the normal pairing → SAS (reader/picker by id) →
  `connected` → transfer runs, for ANY pair including **joiner↔joiner**.
- **Busy-reject**: a `pair-request` from a peer while we are already pairing/connected with a DIFFERENT
  peer → we send that peer **`busy`**. The picker receiving `busy` tears down its half-started attempt
  and **returns to the lobby** (`pairing → awaitingPeer`, room + roster intact) with a clear "X is busy"
  notice (`connection.notice`) — a clean rejection, never a hang; it can pick someone else. The busy
  peer's own session is undisturbed (it drops the stray offer/commit via the `from !== peerId` gate).
- **Lobby control frames** (`pair-request` / `busy`) are handled in `onSignal` BEFORE the 1:1
  `from !== peerId` gate (a pick can come from a peer we are not yet paired with). `LobbyScreen` is
  gated on the plain SAS room (`dev.reconnect.active` false); **reconnect** keeps the simple code screen
  (`RoomCreateScreen`) and **auto-pairs** 1:1 (reconnect-in-lobby is deferred). **words/link/qr are NOT
  lobbies** — they auto-pair 1:1 with the single peer (only `peers[0].id` is read from the new welcome
  form). `LobbyScreen` (`src/ui/screens/`) + `pickPeer`/`onPairRequest`/`onBusy` in `SessionController`;
  e2e in `tests/e2e/lobby.spec.ts` (joiner↔joiner + busy).

- **link** — high-entropy one-time secret S in the URL **fragment** (`#…`), scrubbed via
  `history.replaceState` immediately after read (never sent to the server). No PAKE, no SAS —
  S authenticates the channel itself via key-confirmation. *(done — 5b; see below)*
- **qr** — same as link; the same link is shown/scanned as a QR. *(done — 5b; see below)*
- **room** — server allocates a 4-digit code (public, not secret) that names a **mesh LOBBY**
  (up to `maxPeers`, default 8). Several peers can sit in the same room; the client shows a **roster +
  Connect button per peer** and the human PICKS whom to raise a 1:1 DataChannel with — any pair,
  INCLUDING joiner↔joiner — and that pair runs its own SAS + transfer (see **Room lobby** below). After
  a pair connects the two humans compare a **SAS** (3 words from EFF short #2) out-of-band. SAS is
  mandatory and unskippable; the key-changed / mismatch path is a hard stop, not a dismissable toast.
  **link/qr do NOT share this 4-digit lobby** — they rendezvous via their own high-entropy **token**
  (`codeType=token`, strictly 1:1), so a stray peer can't reach the room. *(SAS done — 4a;
  lobby UI done — 6c; lobby seat cap codeType-dependent — see below.)*
- **words** — PAKE-authenticated, **no SAS**. See below.

### words method (finalized)
A reads a phrase aloud (voice OOB), B reproduces it by **selecting**, not free-typing. PAKE
makes the low-entropy spoken phrase safe (attacker limited to online guessing; the
untrusted-server transcript is not offline-attackable).

- Wordlist: **EFF short list #2 (1296 words)** — each word has a unique 3-character prefix
  (fast autocomplete) and the list is misread-resistant (good for a voice channel). Generate
  with a **CSPRNG**, uniform, rejection-sampled (no modulo bias). Never user-chosen.
- Phrase = **5 words = 1 rendezvous + 4 secret** (~41-bit secret).
  - **rendezvous word** = room id. PUBLIC, server-allocated, from the same EFF short #2 list.
  - **4 secret words** = the CPace password. Client-generated, **never sent to the server**.
- A-side: `create=1&codeType=word` → server allocates rendezvous word from EFF short #2 →
  client generates 4 secret words → shows all 5 in order → A reads them aloud → waits
  (`awaitingPeer`).
- B-side picker: 5 positions, each its own **autocomplete** input over the **full** wordlist
  (type ≥3 chars → unique word → tap). The per-position list MUST be the full list — never a
  short "correct + decoys" set (B can't know the answer; transmitting candidates would leak
  the set to the server and collapse entropy).
- On all 5 selected: split → word 1 = rendezvous → `room=<word1>` join; words 2–5 = CPace
  password (PRS), canonical join format: `utf8ToBytes(secret.map(w => w.toLowerCase()).join('\n'))`.
- Pairing: **CPace** (draft-irtf-cfrg-cpace-21, CPACE-RISTRETTO255-SHA512) over signaling
  new `{kind:'cpace', sid?, msg}` frames (sid = 16-byte session nonce, initiator generates
  and sends on first frame; responder echoes). → shared key K. The CPace initiator/responder is the
  **per-pairing role** (smaller readable id = initiator, see **Per-pairing role**) — for words the
  rendezvous is strictly 1:1 so it is always creator+joiner, but which of the two is the initiator
  is id-ordered, not create/join. Exchange offer/answer/ICE → DTLS. **Key-confirmation:** each side MACs the negotiated DTLS fingerprint (the one from
  received SDP, that DTLS validates) + role label under K via HKDF-SHA512 derivation, exchanges
  it over a DataChannel control message `{kind:'confirm', role?, tag}`; verify with
  `equalBytes` → `connected`; mismatch (wrong words or MITM) → `failed`, no data. **No SAS** —
  successful CPace + key-confirmation IS the authentication.
- **Rate-limit / TTL**: word-room windows are bounded by **MAX_PAIRING_ATTEMPTS = 10**
  (failed CPace/confirmation/peer-drop/transport-abort counts as an attempt). A **signaling
  `peer-left` counts an attempt ONLY before the DataChannel transport is up** (the gate
  `peerLeftAbortsPairing` — pre-transport the rendezvous is the liveness authority); once the
  channel is open a guess is counted by the confirmation-mismatch / channel-close paths instead, and
  a post-connect `peer-left` (the client's own close-on-`connected`, or the peer's) is ignored. This
  does NOT weaken the bound — every actual guess (tag comparison) is still counted. See **§ Signaling
  WS lifecycle**. On reaching the
  cap or if a server-side TTL (**WORD_ROOM_TTL_MS = 180000**, ~3 min) expires **before**
  `connected`, the word-room is invalidated → invalidates the rendezvous. After `connected`,
  TTL does NOT tear down the already-authenticated P2P connection; the client closes signaling
  itself on `connected` (1:1 privacy — server learns no duration) and the DataChannel persists,
  allowing long transfers (10GB+ at typical speeds may exceed 3 min).
  A counts attempts and can manually regenerate (fresh 5 words, new room). This bounds online
  guessing: ≤10 tries × ~2 per guess ≈ 2^4 vs 2^41 secret space.
- Server: word-rooms cap at **2 peers max** (creator + one joiner; 3rd joiner bounced with
  `4002 'room full'`). This serializes guesses and ensures the room is 1:1.

### room method (SAS) — done
Server allocates a 4-digit public code that names a **mesh LOBBY** (see **Room lobby** above): peers
join, see each other on a roster, and the human PICKS whom to raise a 1:1 channel with (any pair,
incl. joiner↔joiner). Once a pair connects, the two humans compare a short string (SAS) **out-of-band**
(voice/QR/etc.) — the MITM check.

**SAS design (commit-before-reveal, per ZRTP / Vaudenay)**: to prevent a MITM-server from
grinding certs to match SAS on both sides, reveal the SAS only after committing to random
nonces:
  (Roles below are the PER-PAIRING transport/crypto roles — initiator = the lexicographically
  SMALLER readable id, responder = the larger — NOT create/join. See **Per-pairing role** above; the
  SAS responder commits first regardless of who created the room, so a joiner↔joiner pair never has
  both sides committing.)
- Responder sends `{kind:'sas-commit', c}` where `c = SHA-256("hushsend/sas/commit"
  || nonceR)`, nonceR = 16 random bytes. Initiator sends `{kind:'sas-nonce', nonce: nonceI}`.
- Responder reveals `{kind:'sas-nonce', nonce: nonceR}`. The initiator verifies `c = SHA-256(...)`
  with `equalBytes` (abort on mismatch). Order is critical: the responder is committed before the
  initiator's nonce is revealed. Both derive (HKDF-SHA512, same KDF as the words key-confirmation;
  `nonceA`/`nonceB` below = initiator's/responder's nonce, bound in fixed role order):
```
  SAS = HKDF-SHA512(IKM = lv(nonceA) || lv(nonceB) || lv(fp_min) || lv(fp_max),
                    salt = ∅, info = "hushsend/sas")
```
  where `fp_min/fp_max` = sorted DTLS fingerprints (lexicographic order, same canonicalization
  as words key-confirmation), `lv` = length-prefix. The commitment `c` stays SHA-256 (a hash is
  the right primitive for a binding commitment). Then render SAS as **3 words from EFF short #2**
  (≈31 bits, readable aloud); each word index is a bias-free 8-byte reduction of the HKDF output.
  Both sides must derive the same triple.
- **NO NONCE REVEAL BEFORE THE FINGERPRINTS ARE PINNED** (`SessionController.maybeRevealSasNonce`) —
  **added 2026-09-12, and it is load-bearing.** The commitment covers the two NONCES; the IKM above
  has FOUR inputs. The fingerprints used to be free at reveal time, and the nonces ride SIGNALING, so
  an untrusted relay controlling delivery order could finish both commit-reveal exchanges while its
  own certificate on each leg was still unchosen — then grind ~2^16 certificates per leg, meet in the
  middle, and make BOTH humans read the SAME phrase. Reproduced against `computeSasWords` in ~4 s,
  against a 120 s deadline, with the certificate pool precomputable offline: a silent, complete MITM
  of the room method that also pinned the attacker's identity key via the enrollment that follows.
  Every reveal is now held until `sas.fps` is set, so the attacker's certificate is inside our
  transcript before it learns our nonce. Regression: `SessionController.auditFixes.test.ts` §1.
- **Exchange over DataChannel**: each side sends `{kind:'sas-confirm', ok: <bool>}` after the
  human either confirms (both SAS match) or denies (mismatch). Both must confirm → `connected`;
  any deny/timeout/abort → `failed`. This is not a cryptographic boundary (SAS already
  authenticated the channel via fingerprint binding), but a **coordination gate** ensuring both
  sides agree on authenticity before allowing data transfer.
- **UI confirmation — ASYMMETRIC "pick from 3 phrases" (crypto unchanged)**: `sas.ts` and
  the `sas-confirm{ok}` protocol are untouched. The screen is split by role so the pick actually
  defends against a MITM:
  - the **READER** is shown its phrase (`sas-words`), reads the 3 words aloud, then confirms (or aborts);
  - the **BLIND PICKER** is NEVER shown the phrase on its own, only 3 indistinguishable options (the
    REAL phrase + **2 LOCAL display-only decoys**: same EFF short #2 list, same 3-word format, distinct
    from the real one and each other, randomised order, never sent), and must identify the phrase by
    LISTENING to the reader.

  This split is the whole point: a picker that could see its own phrase would click it without
  listening, giving no protection. Blind, the picker catches a MITM (which makes the two sides derive
  DIFFERENT phrases) — the read phrase is not among the picker's options → "none of these match" →
  `confirmSas(false)` → both abort. `confirmSas(true)` fires only when the picker selects the real
  phrase (the reader confirms its peer found it). Entropy is preserved (full phrase vs full phrase);
  the decoys are pure UI. The decoy build + pick scoring is isolated in `sasOptions.ts` and
  unit-tested (`sasOptions.test.ts`).
  - **SAS role is PER-PAIRING, from the SAS MATERIAL (was: readable-id order) — changed 2026-09-12.**
    Since the room is a mesh lobby, a pair can be creator↔joiner OR joiner↔joiner, so "creator reads"
    would make two joiners both pickers (no reader). The split used to come from the two readable ids
    (smaller id reads). **The audit broke that:** the ids are assigned by the UNTRUSTED SERVER,
    independently to each peer, so a malicious server could tell BOTH peers they held the smaller id
    → both blind pickers, nobody reads, and the ceremony degrades from ~2^-31 to two humans each
    guessing 1-in-3. (The mirror case, both readers, is caught by the humans hearing two different
    phrases; both-pickers is silent.) The split is now `sasReaderIsFpMin` (`crypto/sas.ts`): one HKDF
    bit over the SAME IKM as the words — both nonces + both fingerprints — under its own
    `hushsend/sas/role` label, turned into our own role by `sasRoleFrom` (`src/core/sasRole.ts`,
    unit-tested in `sasRole.test.ts`). Each peer asks whether its OWN fingerprint is fp_min and
    compares that to the bit, so the two roles are always opposite. The server cannot choose it (no id
    is an input) and a MITM cannot steer it either: the nonces are revealed only AFTER the
    fingerprints are pinned, so the bit is decided after the attacker has committed to its
    certificate. Computed in `trySasReady` — the first moment both nonces and both fingerprints exist
    — and projected as `connection.sasRole`; `SasScreen` reads it. **Fail closed**: an unresolved role
    (`null` — missing/degenerate fingerprints) renders the "restart verification" screen, NEVER a
    functional blind picker. Note the consequence: reader↔initiator no longer line up, by design.
- **Timeouts**: one reused timer bounds the coordination phases, default **120000 ms** (~2 min).
  It arms at pairing-start (`beginPairing`) to bound the pre-SAS pairing window (peer sent commit but
  withheld its nonce → no longer hangs), then re-arms at SAS-display to bound the comparison + confirm
  window. **Both phases are PROD-fixed at the 120 s default** but each reads its duration through a
  SEPARATE DEV-only override so e2e can drive each timeout branch in ~hundreds of ms / a few seconds
  instead of a real 120 s wait, both gated behind `import.meta.env.DEV` (dead-code / tree-shaken in
  prod): the pre-SAS window via **`preSasTimeoutMs()`** (`?preSasTimeoutMs=N` /
  `window.__HUSHSEND_PRE_SAS_TIMEOUT_MS__`) and the comparison window via **`sasConfirmTimeoutMs()`**
  (`?sasTimeoutMs=N` / `window.__HUSHSEND_SAS_TIMEOUT_MS__`). They are kept SEPARATE deliberately —
  shrinking one must not pre-empt the other's state under test (the comparison-timeout e2e relies on
  the pre-SAS window keeping its default while only the comparison one shrinks). On expiry → `failSas`
  → `failed` + close, same path as deny/abort. The pre-SAS deadline's **FIRING direction is e2e-tested**
  (`?stallSasNonce=1` makes a peer reach the SAS
  but withhold its nonce reveal → the other side fails at the shrunk pre-SAS deadline, not hangs —
  `tests/e2e/room-sas.spec.ts`).
- **Inbound validation**: `sas-commit` / `sas-nonce` frames are zod-validated to exact decoded
  lengths (commit = 32 bytes, nonce = 16 bytes); malformed / short / odd-hex frames are rejected
  before any crypto (untrusted relay).
- **Server cap / TTL / rate-limit (done — 6a, lobby cap added later)**: the 4-digit room is a
  **`managed`** room, which governs the TTL + per-IP rate-limit. The **seat cap is codeType-dependent,
  NOT the `managed` flag**: the 4-digit **room** rendezvous is a **LOBBY** up to **`maxPeers`**
  (`FILETRANSFER_MAX_PEERS`, default **8**); the **words** AND the link/qr **token** rendezvous are
  strictly 1:1 (`ONE_TO_ONE_MAX_PEERS = 2`) — words to serialize secret-word guessing, token because a
  one-time link/qr has a single receiver. A joiner past the cap is bounced with **4002 `'room full'`**.
  The room self-destructs after a short TTL **before `connected`**, freeing the code (a later join →
  **4009 `'room not found'`**; after `connected`, closing signaling does NOT drop the live P2P
  channel). The **4-digit lobby TTL is an IDLE timeout** (`ROOM_TTL_MS = 180000`, ~3 min): every JOIN
  re-arms it, so an actively-joined lobby lives while a stale one expires. The **words AND token TTLs
  stay armed from CREATE** (`WORD_ROOM_TTL_MS` / `TOKEN_ROOM_TTL_MS`, both 180000) and do NOT re-arm (a
  re-arm would let an attacker keep a 1:1 room alive by rejoining). **Per-IP create/join attempts are
  rate-limited** (`IP_RL_MAX =
  60` / `IP_RL_WINDOW_MS = 60000`; over → **4011 `'too many attempts'`**) to slow enumeration of the
  small 10k space; loopback is EXEMPT (behind nginx a real client always arrives via `X-Real-IP`, never
  loopback). SAS still defeats a MITM regardless — this is abuse hygiene. See **Signaling server**
  below; tested in `tests/integration/room-server.test.ts`.

### link / qr method (finalized — 5b)
A high-entropy ONE-TIME secret in the URL fragment authenticates the channel directly — **no PAKE,
no SAS, no human comparison, no reader/picker**. (The full-entropy secret is not offline-guessable,
so a PAKE is unnecessary; the secret authenticates by itself, so a SAS is unnecessary.) link and qr
are the SAME path — qr only renders/scans the same link. Lives in `src/core/link/link.ts` (pure:
generate / build / parse) + the link/qr branches in `SessionController`; no new FSM states.

- **Secret S**: `LINK_SECRET_BYTES = 16` CSPRNG bytes (128 bits), base64url-encoded, never
  user-chosen. It is the key-confirmation IKM and **never reaches the server**.
- **Rendezvous**: a **high-entropy token** (`codeType=token`) — the server allocates a 128-bit
  CSPRNG, base64url, 22-char token (`server/signaling-server.js` `tokenCode`, `TOKEN_ROOM_BYTES=16`),
  NOT the 4-digit room. The link already carries the rendezvous, so a high-entropy token costs nothing
  in UX while making the rendezvous **unguessable**: a stranger can't enumerate/squat a token room the
  way the 10k 4-digit space can be scanned, so interloper-resistance is **structural** (the old
  link/qr lobby-race is closed by construction, not just by rate-limit). Public routing only. The
  **room method keeps the 4-digit code; words keeps its word**; only link/qr moved to the token.
- **Link shape**: `<origin>/#<token>.<S>` (`buildLinkUrl`). The token is PUBLIC (routing); S rides in
  the **fragment**, which browsers never send to the server. Both halves are base64url with no
  padding, so neither contains `.` and `parseLink` splits cleanly on the first `.`.
- **Authentication = channel-bound key-confirmation over S** (reuses `keyConfirmation.ts`, the same
  primitive + lv-canonicalisation as words/SAS, under the **`LINK_CONFIRM_DOMAIN`** domain —
  `confKey = HKDF-SHA512(S, salt=∅, info="hushsend/link/confirm")`, `tag = HMAC-SHA256(confKey,
  lv(label) || lv(fp_min) || lv(fp_max) || lv(role))`). Tags exchanged over the existing
  `{kind:'confirm', tag}` DataChannel control message; verify with `equalBytes` → `connected`;
  mismatch (no S / wrong S / MITM with different certs) → `failed`, **no byte**. The words domain
  is unchanged — `makeConfirmation`/`verifyConfirmation` gained an optional trailing `domain` arg
  that defaults to `CPACE_CONFIRM_DOMAIN`, so the words call sites are byte-for-byte identical.
- **Flow** (maps onto existing states, no new ones): A `create=1` → `awaitingPeer` shows the link
  (creator only; surfaced as `credential[0]`, same as words surfaces its secret words) → `peer-joined`
  → at pairing start the WebRTC **initiator is the smaller readable id** (see **Per-pairing role**;
  either side may offer, not necessarily the creator) → DTLS → key-confirmation over S → `connected`.
  (`creating`/`joining` → `pairing`[DTLS] → `confirming`[S key-confirm] → `connected`|`failed`.)
- **One-time / replay**: the link/QR is for ONE connection; the token room is session-scoped (TTL +
  per-IP rate-limit — the managed-room hardening — see room/SAS § *Server cap / TTL / rate-limit*).
  The token room is **strictly 1:1** (`ONE_TO_ONE_MAX_PEERS = 2`, like words), NOT the 4-digit lobby:
  the unguessable token keeps strangers OUT structurally, and the cap-2 guarantees a **single
  receiver** even if the link is forwarded (a 2nd joiner is bounced **4002 `'room full'`**; S would
  also fail key-confirmation for it — defense in depth). Its TTL is armed **from CREATE** and never
  re-armed (`TOKEN_ROOM_TTL_MS = 180000`, the natural pre-connect wait of a 1:1 link). Replay is closed
  by a fresh DTLS cert per session **plus** S being single-use (scrubbed after read).
- **Fragment scrub**: the joiner reads `location.hash` on page load, extracts the token + S, **scrubs
  the fragment immediately** via `history.replaceState` (before any await — see `LinkFragmentJoin`
  in `App.tsx`), and sends only the token to the server (`join`, `codeType=token`). A malformed/absent
  fragment is a no-op (stay home); a valid-but-dead room surfaces later as the "room not found"
  failure. `parseLink` validates strictly (token = `RENDEZVOUS_TOKEN_LEN`=22 base64url chars, S decodes
  to exactly 16 bytes) — the input is attacker-influenced; an old 4-digit-style code is now rejected.
- **qr**: the SAME link, rendered to an SVG QR locally (`src/ui/qr.ts`, `qrcode`); the joiner SCANS
  it with the camera (`getUserMedia` + the `barcode-detector` ponyfill — native `BarcodeDetector`,
  else **self-hosted** zxing-wasm via `src/ui/zxingWasm.ts`, lazily imported) → decodes to the link →
  same join path. Camera denial/absence falls back to a **paste-the-link** input (also the
  deterministic e2e injection point). The zxing WASM is served from our own origin, not a CDN — see § QR.
- **Enrollment**: TOFU pinning runs after `connected` exactly as for words/room (method-agnostic),
  so link/qr pairs can later reconnect.

## Crypto
- **CPace** (balanced PAKE) for the words method — over `@noble/curves` ristretto255
  (+ hash-to-curve) and `@noble/hashes` SHA-512, against the CFRG test vectors
  (draft-irtf-cfrg-cpace-21, April 2026). Password = secret words only (rendezvous excluded).
  - Specifics: sid = fresh 16-byte nonce per session, generated by initiator and sent with
    first CPace message; both sides use it in ISK derivation. Abort conditions (per draft-21):
    invalid point, point = identity. Scalar sampling: uniform ≤ 2^252 < ristretto255 order,
    rejection-sample for nonzero (negligible bias; ~2^-127).
- **Ed25519 identity key** (TOFU pinning + reconnect signatures): prefer WebCrypto
  non-extractable Ed25519 (private key never in the JS heap; the non-extractable `CryptoKey` is
  stored in IndexedDB and cannot be read back); fall back to `@noble/curves` Ed25519 (stores the
  32-byte seed) where unsupported. Signatures interoperate across both paths — verify uses noble
  unconditionally (Ed25519 is RFC 8032, signature format is canonical).
- **Identity enrollment (TOFU, done)**: runs ONLY after `connected` — i.e. over the already
  SAS/words-authenticated channel, where the MITM is already defeated, so exchanging public keys
  is trustworthy (this is the trust-on-first-use moment). **Both directions are gated on
  `this.established`, and that gate is new (2026-09-12).** It used to hold only for the SEND path:
  the RECEIVE path (`onEnrollFrame`) checked `isAuthenticatedMethod()` — a check on the METHOD, true
  from the first moment of every real session — so any peer that reached an open DataChannel could
  send `enroll-init`, have its key verified against ITSELF (pure TOFU), written into the keystore as
  a pin, and receive our long-term identity key in the ack: a planted "known device" that later
  reconnects with no SAS and no human step, plus the strongest cross-session tracker in the system
  handed to a stranger. A frame that arrives in the short window before WE settle is HELD
  (`pendingEnrollFrame`) and replayed by `startEnrollment`, so an honest early arrival is not lost.
  A `pairingId` we already hold under a DIFFERENT key is refused rather than overwritten
  (first-write-wins) — an upsert there would silently erase the key-change hard stop.
  Regression: `SessionController.auditFixes.test.ts` §3. It is an action on `connected`, NOT an
  FSM state, and does NOT gate `connected` or transfer; a bad enrollment signature only skips the
  pin + warns, never tears down the human/PAKE-authenticated session. The initiator (the
  **per-pairing role** — the smaller readable id, NOT necessarily the creator) generates a
  key-independent random `pairingId` (16 bytes) — key-independent so a swapped key under the same
  id is detectable on reconnect; `lv(role)` below is that per-pairing role. Each side signs its OWN
  public key:
```
  sign( lv("hushsend/identity/enroll") || lv(pairingId) || lv(ownPubKey) || lv(fp_min) || lv(fp_max) || lv(role) )
```
  (same `lv` + sorted-fingerprint canonicalization as key-confirmation / SAS; fingerprints from
  the parsed SDP — channel binding). The verifier reconstructs with the received key as the
  signer's `ownPubKey`, the peer's role, the shared `pairingId`, and its own fingerprints. On
  success each side pins `pairingId → peerPublicKey`. Frames (`enroll-init {pairingId, pubKey,
  sig}`, `enroll-ack {pubKey, sig}`) are zod-validated to exact lengths (pairingId 16B, pubKey
  32B, sig 64B).
- **Reconnect (TOFU re-auth, done — 4b-ii)**: when both sides ALREADY hold a pin for the same
  `pairingId` (from a prior enrollment), they reconnect with **NO human step** — a mutual signature
  under the pinned keys replaces SAS/words. It reuses the room rendezvous and rides on top of the
  SAS state, which stays primed as the fallback. Path selection: the initiator announces the
  pairingId (`reconnect-init`); both look up their pin.
  **What is actually announced is a BLINDED tag, not the pairingId (since 2026-09-18).** The
  rendezvous is a plain 4-digit room and auto-pairs, so a code-guesser can reach the open channel
  before any authentication and used to be handed a stable per-pair identifier. The initiator now
  sends `HMAC(key = pairingId, DOMAIN ‖ fp_min ‖ fp_max)` truncated to the id's own length
  (`blindPairingId`); the responder recognises it by RECOMPUTING it against each pin it holds
  (`matchBlindedPairingId`) rather than looking it up. The wire field keeps its historical name and
  length on purpose — an older peer still parses the frame, matches nothing and falls back to SAS,
  instead of failing validation and hanging. The signing transcript below is UNCHANGED: it still
  binds the real pairingId, which both sides know. Both-have-pin → reconnect-auth; a pin
  missing on either side → `reconnect-fallback` → the normal first connect (SAS + enrollment).
  **Reconnect's `role` is the EXCEPTION to the per-pairing rule: it stays create/join** (creator =
  reconnect initiator = the side that announces the pairingId and is the verifier-first), NOT the
  id-derived `this.role`. This is deliberate — the verifier-first side must be fixed so a key change
  is caught before a forger can settle; reconnect is 1:1 creator↔joiner (mesh reconnect is a later
  step). `lv(role)` in the transcript below uses this reconnect role.
  Each side proves possession of its pinned private key over a fresh, channel-bound transcript:
```
  sign( lv("hushsend/identity/reconnect") || lv(pairingId) || lv(challengeInitiator) || lv(challengeResponder) || lv(fp_min) || lv(fp_max) || lv(role) )
```
  (same `lv` + sorted-fingerprint canonicalization as enroll/SAS/key-confirmation; fingerprints
  from the parsed SDP — channel binding. Each side draws a fresh 16-byte CSPRNG challenge; both are
  bound in fixed role order.) **Verification is TWO separate checks** so a key change is told apart
  from a MITM: (1) does the PRESENTED key equal the PINNED key for this pairingId? No → **key
  changed** hard stop (SSH-style — the peer under this id is using a different key; a visible stop,
  never a toast, no bytes). (2) does the signature verify under the PINNED key over the transcript
  rebuilt with OUR fingerprints + the peer's role? No (key matched) → channel-binding / **MITM**
  hard stop, no bytes. Both pass → authenticated reconnect (`connected`, no re-enrollment).
  **Replay** is closed by the channel binding (a fresh DTLS cert per session) AND the explicit
  challenges (so freshness does not rely on assuming the cert is fresh). Frames (`reconnect-init
  {pairingId, challenge}`, `reconnect-proof {challenge, pubKey, sig}`, `reconnect-fallback {}`) are
  zod-validated to exact lengths (pairingId 16B, challenge 16B, pubKey 32B, sig 64B). DEV/TEST knob
  `?forgeReconnectKey=1` makes a side present a fresh key under the real pairingId, driving the
  key-changed e2e.
  **Liveness deadline (the reconnect wait has a timeout — fail-closed):** the re-auth wait
  (reconnect-init → reconnect-proof/fallback) has its OWN deadline, **INDEPENDENT of the SAS timers**.
  The reconnect path keeps `this.sas` primed as the fallback, so the SAS pre-timer is also armed — but
  that guards the SAS commit-reveal, NOT a stalled reconnect-init/-proof. Without this, a **mismatched
  entry** (one side on the reconnect path while the peer joined via the plain-SAS lobby → a fresh SAS,
  never a reconnect response) would hang in `pairing` ("agreeing on keys") forever. The deadline is
  **prod-fixed at 120 s** (same as the pre-SAS default; reconnect is automatic, so the exact value is
  not critical — only that a stalled re-auth fails closed) and read through a **DEV-only override**
  `reconnectTimeoutMs()` (`?reconnectTimeoutMs=N` / `window.__HUSHSEND_RECONNECT_TIMEOUT_MS__`,
  `import.meta.env.DEV`-gated → tree-shaken in prod, kept SEPARATE from the SAS knobs). Armed at
  pairing start (`beginPairing`, reconnect path only); cleared on settle/fallback/fail/dispose (a
  Max-privacy ICE failure also clears it via `failDirect`; `failSas` cross-closes it too, so a
  parallel reconnect timer can't fire a second teardown on a reconnect→SAS fallback); expiry →
  `failReconnect` (→ `failed` +
  close), the SAME
  terminal path as a key-change / MITM. This is a **LIVENESS bound, not a security one** — the two-check
  verify, the reconnect **role (stays create/join)**, the wire frames, and the crypto are UNCHANGED;
  it only turns the mismatched-entry hang into a clean `failed`. DEV knob `?stallReconnect=1` (withholds
  the reconnect-proof) drives the firing e2e (`tests/e2e/reconnect.spec.ts`).
- **Keystore** (IndexedDB, behind a `KeystoreBackend` port — an IndexedDB impl for the app, an
  in-memory impl for unit tests): stores own identity (non-extractable `CryptoKey` or noble seed)
  and pinned peer keys (`pairingId → { peerPublicKey, firstSeen, label? }`). Pinning on first
  successful connect (enrollment, above) and the **"key changed" hard stop on reconnect** (presented
  key ≠ pin → abort, never silent — `presentedKeyMatchesPin`) are both **done** (4b-i / 4b-ii).
- **Key-confirmation / channel binding**: each side derives `confKey = HKDF-SHA512(secret,
  info=domain)`, then `tag = HMAC-SHA256(confKey, lv(label) || lv(fp_min) || lv(fp_max) ||
  lv(role))`, where `fp_min/fp_max` are the DTLS fingerprints (lexicographically sorted) from the
  local cert and the received SDP; `lv` = length-prefixed encoding (same as in CPace); role = the
  **per-pairing** initiator/responder (smaller readable id = initiator, see **Per-pairing role**).
  Exchange `tag` over a DataChannel control message; verify with `equalBytes`
  (constant-time). This binds both the shared secret AND the actual DTLS channel (via fingerprints)
  — a MITM with different certs on each leg produces mismatched tags. The construction is
  **domain-parameterised** (`makeConfirmation`/`verifyConfirmation` take a `ConfirmationDomain`
  defaulting to `CPACE_CONFIRM_DOMAIN`): the **words** method feeds the CPace ISK under
  `info="hushsend/cpace/confirm"`; the **link/qr** methods feed the URL-fragment secret S under
  `LINK_CONFIRM_DOMAIN` (`info="hushsend/link/confirm"`). Same primitive + lv-canonicalisation; the
  distinct domains keep the two methods' tags independent and the words tags byte-for-byte unchanged.

## File transfer
- DataChannel with chunking + **backpressure** (`bufferedAmount` /
  `bufferedAmountLowThreshold`).
- Save-to-disk: **File System Access** (`showSaveFilePicker`) to stream to disk where
  available (Chromium); fall back to in-memory **Blob** on iOS Safari / Firefox (RAM-bound).
  Cap very large files on the Blob path — multi-GB streaming-to-disk is unreliable on iOS
  (platform limit). The transfer itself works on all browsers.

## Privacy mode + ICE (Max-privacy / Reliable — step 6d, DONE)
*(Separate privacy lever — server learns no session duration: for the 1:1 methods the client closes its
signaling socket on `connected`. See **§ Signaling WS lifecycle**. The toggle below is unrelated — it
only governs `iceServers`.)*

The home **"Max privacy" toggle is FUNCTIONAL** and drives the WebRTC `iceServers` (the only transport
behaviour behind it). It is a persisted UI pref (`prefs.tsx`, `hushsend.privacy`, **default `max`**),
pushed into the core via `<PrivacyModeSync>` (App) → `SessionController.setPrivacyMode`. The mode is
**read at pairing start** (when `iceServers` are assembled), so flipping it mid-session affects the
**NEXT** connection, NOT the live one. **Max-privacy is STRICT — it NEVER relays** (no consent
escalation): a live Max-privacy ICE failure is **terminal** (→ `failed` + a switch-to-Reliable hint),
see **Max-privacy strict model** below.
- **Builder** (`src/core/iceServers.ts`, pure + unit-tested in `iceServers.test.ts`):
  `buildIceServers({mode, stunUrls, turn})`.
  - **Max-privacy (`max`, default)**: `iceServers = [{urls: <STUN>}]` (or `[]` if no STUN) — **STUN
    only, NO TURN, and creds are NEVER requested** (the relay is never contacted; the peer sees your IP).
  - **Reliable (`reliable`)**: `[{urls: <STUN>}, {urls: <TURN urls>, username, credential}]` — STUN +
    TURN, so a pair that can't connect directly relays through coturn (the relay carries only
    E2E-encrypted bytes). It does NOT hide your IP from the PEER — we signal our srflx candidate in
    every mode, so the peer learns the address whichever pair ICE selects; the relay moves the ROUTE
    (the peer's ISP sees coturn, not us — THREATMODEL § 4), not what the peer is told. TURN is added **ONLY when the fetched `urls` is
    non-empty** — empty urls (TURN undeployed) ⇒ STUN-only (we IGNORE username/credential then; relay
    availability is keyed off `urls.length`, never off a credential being present).
- **STUN config**: build-time `VITE_STUN_URLS` (comma-separated → array; `parseStunUrls`). Empty in
  dev/test = no STUN (two loopback tabs use host candidates).
- **NO built-in / third-party ICE fallback (invariant).** `PeerConfig.iceServers` is **required** and
  `PeerConnection` has **no default** — `buildIceServers()` is the ONLY source. A built-in public STUN
  would leak the client's public IP to a host we don't control on every connection, contradicting the
  threat model, so there is nothing to fall back to; `[]` (no ICE servers at all — dev/loopback, or
  Max-privacy with no STUN configured) is a legitimate value and is passed explicitly. (A dead
  `DEFAULT_ICE_SERVERS = stun:stun.l.google.com` fallback lived in `PeerConnection.ts` until it was
  removed: unreachable in the app, but it still shipped as a string in `dist/` — found in a bundle
  audit at deploy. Never reintroduce an implicit default.)
- **Cred fetch (Reliable only)**: `SignalingClient.requestTurnCredentials()` sends `{type:'turn-request'}`
  and awaits the zod-validated `{type:'turn-credentials', urls, username, credential, ttl}` reply (the
  untrusted relay — validated before use). Fetched **after** the WS is up (`welcome` arrived) and
  **before** the PeerConnection is created, so TURN is in `iceServers` from the first ICE candidate:
  `SessionController.ensureTurnReady()` is kicked off at the START of `beginPairing` (runs in parallel
  with CPace/SAS) and `startPeer` awaits the SAME memoized fetch before building the PC. Never throws —
  a closed socket / timeout / absent relay resolves to **NO_TURN (empty urls)** → direct-only. Creds are
  reset per session (`openSignaling`) since they are bound to the live socket.
  **Empty urls is now PROJECTED to the user** (`connection.relayUnavailable`, set from
  `ensureTurnReady`; added 2026-09-19): Reliable silently degrading to direct-only was visible ONLY in
  the DEV diagnostics log, which is tree-shaken out of production — so a user who picked Reliable FOR
  the fallback got Max-privacy connectivity with no indication, and the failure that followed read as
  ordinary bad luck. `FailedScreen` renders `relayUnavailableHint` (EN/RU, testid
  `relay-unavailable-hint`) so the failure names the missing fallback. Always false in Max privacy,
  which never requests creds. `SessionController.relayUnavailable.test.ts` pins it, with both negative
  controls (a relay that IS there, and Max privacy). The built ICE config is
  published to the DEV diagnostics (`dev.iceConfig` — mode/relay/urls/username/credential) for the e2e.
- **Pre-PC WebRTC-signal buffer (mixed-privacy / link-qr deadlock fix)**: because `startPeer` `await`s
  `ensureTurnReady()` BEFORE building the PeerConnection, a **Reliable-mode answerer** is still fetching
  coturn creds when a **Max-privacy offerer**'s offer arrives — so `this.peer` is null and the offer used
  to hit the `this.peer?.handleSignal` no-op in `onSignal` and be **silently dropped** (deadlock). Fix:
  `SessionController.pendingPeerSignals` buffers WebRTC offer/answer/ICE that arrive for the ACTIVE
  pairing (past the `from === this.peerId` gate) while `this.peer` is null, and `startPeer` REPLAYS the
  queue in arrival order right after building the PC (`flushPendingPeerSignals`); ICE that races ahead of
  the offer is re-buffered by the PC's own `pendingIce`, and `setRemoteDescription` doesn't depend on
  `iceServers`, so the "TURN in iceServers from the first candidate" invariant is intact. The buffer is a
  level ABOVE `pendingIce` (whole signals, not just ICE) and is **method-agnostic** — it lives in the
  shared WebRTC tail of `onSignal`, so it closes BOTH the room and the latent link/qr race (words is
  unaffected: its offer is serialized behind the CPace gate, so the PC is already up). CLEARED
  (`clearPendingPeerSignals`) on EVERY teardown/reset/retry — `resetPairingToLobby`, `teardownPeerOnly`
  (words retry), `failLink`, `failSas`, `failReconnect`, `failDirect`, `dispose` — so a stale signal from
  a finished attempt can never replay into the next attempt's PC. Unit-tested deterministically in
  `SessionController.pendingPeerSignals.test.ts` (controllable `ensureTurnReady` + mock PeerConnection:
  offer-while-`peer===null` is buffered → creds resolve → PC built → offer replayed → answer emitted; and
  `resetPairingToLobby` empties the queue).
- **Tests**: `iceServers.test.ts` (builder: max→STUN-only/empty, max ignores TURN, reliable+creds→STUN+TURN,
  reliable+empty-urls→STUN-only, default=max never relays); `tests/e2e/privacy.spec.ts` (toggle renders +
  flips + default max; Max-privacy still connects directly with no TURN; Reliable fetches creds via
  `turn-request` and assembles a correct TURN iceServer — the relay itself is not run, both modes connect
  over loopback). Server `turn-credentials` minting is **done (6d server side)** — see Signaling server §.

### Max-privacy strict model (done — completes 6d)
**Max-privacy NEVER relays. Period — no consent escalation, no relay-retry.** Two always-on mechanisms
enforce it in Max-privacy, then a direct failure is **terminal**:
- **No local TURN** — Max-privacy never requests coturn creds, so we never offer a relay candidate
  (`ensureTurnReady` is a no-op off Reliable).
- **Strict relay-candidate filter** — the PeerConnection **DROPS the peer's incoming `typ relay` ICE
  candidates** (`PeerConnection.addIce` → `shouldDropCandidate` / `isRelayCandidate`, the only thing
  left in **`src/core/relax.ts`**), so a relay candidate the peer SIGNALS is never added on our side.
  The filter is **fixed at construction** (`filterRelay = privacyMode === 'max'`) — Max-privacy never
  flips it. In Reliable the filter is off (relay allowed).
- **Selected-path check at channel-open (added 2026-09-12 — closes the audit finding).** Mechanisms 1+2
  are NOT sufficient alone: they cover candidates we ADD, not the ones ICE **learns**. A peer relaying
  through coturn sends its connectivity checks FROM the relayed address, and RFC 8445 §7.3.1.3 has our
  agent learn that address as a **peer-reflexive** candidate and pair with it — the same address we
  just dropped as `typ relay`. It bites only when the direct path fails (otherwise the direct pair wins
  on priority), i.e. exactly the case this model exists for, and only in a **mixed-privacy** pair
  (Max ↔ Reliable; Max ↔ Max has no relay anywhere). So the PeerConnection now **verifies the path it
  actually got**: every dropped relay candidate's endpoint is remembered (`relayCandidateEndpoint` →
  `droppedRelayEndpoints`), and at DataChannel open — **BEFORE `onOpen` reaches the SessionController**
  — `openChannelUnlessRelayed` reads `pc.getStats()`, resolves the selected pair
  (`selectedRemoteCandidate`, engine-agnostic: transport `selectedCandidatePairId` → Firefox
  `selected` → nominated+succeeded → succeeded) and refuses via `isForbiddenRemoteCandidate` when the
  remote is typed `relay` OR sits on a dropped endpoint. A refusal takes the SAME terminal path as a
  direct ICE failure (`onIceFailure` → `onIceFailed` → `failDirect` + hint) and `onOpen` never fires,
  so **no byte can cross a relayed path**. A `prflx` remote we never dropped is ALLOWED — legitimate
  NAT mappings produce those on genuinely direct paths.
  **Unavailable/empty stats ⇒ REFUSE (changed 2026-09-13, finding F1).** This used to read "unknown,
  not relay — we never tear down a working connection over a missing API", and that was the hole:
  `selectedRemoteCandidate` returns null until ICE publishes a selection, so the gate waved through
  every path it had simply not looked at yet. Its own docstring already said a caller must read null
  as unknown NEVER as safe, and the condition is real — `SessionController.verifyPath` needed a 5 s
  poll for exactly this, and runs LATER in the session than the gate. So the rule is now POSITIVE:
  **open only on a path established to be direct.** `relax.classifySelectedPath` polls for a
  judgement (`SELECTED_PAIR_TIMEOUT_MS` 5 s / `SELECTED_PAIR_POLL_MS` 100 ms), retrying on a null read
  so a transient `getStats()` rejection does not decide the session, and anything still
  `undetermined` at the deadline is refused down the same terminal path as a relay. Measured
  2026-09-13: chromium, firefox and webkit each report a selected pair on the FIRST read at
  channel-open (0–1 ms, 3/3 runs per engine), so a healthy connection never waits and the deadline is
  insurance, not latency. `relax.test.ts` covers both pure halves **and the policy** (including the
  reproduction of the old wave-through); the browser-side confirmation is **TESTPLAN § C4**.
  - **Residual:** the check runs at channel-open. A mid-session ICE **re-nomination** onto a learned
    relay path (e.g. the direct path dies later) is not re-checked — noted in BACKLOG § Security audit.
- **ICE-fail → terminal `failed` + hint**: an ICE failure (`iceconnectionstatechange` /
  `connectionstatechange` → `failed`) while filtering routes to `onIceFailed` (one-shot), which calls
  `failDirect(DIRECT_FAIL_REASON)` → close + `fail()` → the **existing `failed` state** (no new FSM
  state). The `FailedScreen` classifies the reason from its text (like the MITM / room-not-found cases)
  and renders the hint **"Couldn't connect directly. Switch to Reliable to allow relaying through a
  server."** (i18n `directFailHint`, EN/RU; testid `direct-fail-hint`). In Reliable an ICE failure is a
  genuine `onClose` → `failed` (relay was available and still couldn't save it — no hint).
  `DIRECT_FAIL_REASON` (`"couldn't connect directly (Max privacy)"`) is the stable marker the screen
  keys off (`/connect directly|max privacy/`).
- **No relax-offer / bilateral / relax signal**: there is NO consent-gated relay escalation. The
  `connection.relax` projection, the `relax` signaling frame, `relaxConnection`/`declineRelax`, and the
  `pc.setConfiguration`/`restartIce` ICE-restart-over-relay were all **removed**. This also removes the
  whole class of asymmetric relax bugs (incl. the suspected Firefox mixed-privacy hang — the failure
  mode is gone by design: a Max-privacy side that can't go direct fails fast instead of half-relaxing).
- **DEV/TEST knob**: `?forceIceFail=1` (DEV-gated, like `forgeReconnectKey`) makes the PeerConnection
  treat ICE as failed AND suppress its own candidates, driving the Max-privacy-direct-failure path in
  e2e without a real network failure.
- **Tests**: `relax.test.ts` (the relay-candidate filter: drops `typ relay` only while filtering, off
  in Reliable, safe on null/empty); `tests/e2e/relax.spec.ts` (`forceIceFail` Max-privacy → both sides
  reach `failed` with the `direct-fail-hint`, no relay offer, no hang). Reliable's relay actually
  carrying bytes is **`tests/integration/turn-relay.test.ts`** (2026-09-19): it spawns a real coturn
  in the production `use-auth-secret` mode, spawns the signaling server with the SAME secret, mints
  over the WebSocket exactly as the client does and drives `turnutils_uclient` with the reply, so the
  one cross-service invariant — `TURN_SECRET` == coturn `static-auth-secret` — is checked rather than
  assumed. Its NEGATIVE CONTROL mints under a different secret and requires the same relay to refuse
  it (coturn answers `Cannot complete Allocation`), which is what stops the check from passing against
  a relay with authentication switched off. CI installs coturn on every push and sets
  `REQUIRE_RELAY_TEST=1`, which turns "coturn missing" from a skip into a hard failure.
  **Measured ceiling (2026-09-19)** — a real relay-only `RTCPeerConnection` pair through the LIVE
  coturn, selected pair confirmed `relay`/`relay`, hushsend's own chunking + backpressure: **3.84 MB/s**
  of payload reached on loopback, **1.86 MB/s** via the public name (the home router hairpins BOTH
  legs, so every byte crosses it twice), against **24.81 MB/s** for the same benchmark on a local
  coturn with `max-bps=0`. So coturn's `max-bps=5000000` is what binds on a fast path, deliberately —
  it is still far above a residential uplink, which is what will bind a real cross-network pair.
  Numbers + the capacity note (~41 concurrent allocations from the 49160-49200 port range, NOT the
  1200 `total-quota` advertises) are in TESTPLAN § 0.3.

## QR (built — step 5b; WASM self-hosted — step 6e)
`barcode-detector` + `qrcode` are installed. Generation: `qrcode` → an SVG QR rendered locally
(`src/ui/qr.ts`, dark-on-light so it scans in either theme). Scanning: `getUserMedia` for the
camera + the **`barcode-detector` ponyfill** (native `BarcodeDetector` where available, zxing-wasm
fallback) so one path works on iOS/Firefox/everywhere; the ponyfill is **lazily imported** so its
WASM never loads unless the user actually scans. Camera denial/absence falls back to a paste-the-link
input (`src/ui/screens/ScanScreen.tsx`).
- **Self-hosted WASM (no CDN — step 6e):** the zxing reader `.wasm` (the fallback decoder on
  iOS/Firefox) is **vendored into the build** and served from our OWN origin — it is NEVER fetched
  from a third-party CDN. `barcode-detector@3.2.0`'s default Emscripten `locateFile` would pull
  `zxing_reader.wasm` from `fastly.jsdelivr.net` at scan time (leaking the client IP + executing
  WASM from a host we don't control — a privacy + supply-chain risk). `src/ui/zxingWasm.ts`
  (`createQrDetector`) overrides it: it `import`s the `.wasm` as a Vite **`?url` asset**
  (`zxing-wasm/reader/zxing_reader.wasm?url` → fingerprinted into `dist/assets/`, same-origin) and
  calls `setZXingModuleOverrides({ locateFile })` to point the loader at that asset **before** the
  detector instantiates. Lazy loading is preserved (only the URL string is in the bundle; the
  ponyfill JS + WASM still load only on a real scan, now from `'self'`). `zxing-wasm@3.1.0` is pinned
  as a direct dep (exact, matching barcode-detector's inlined copy) so the import resolves
  independent of hoisting. The wired `locateFile` is unit-tested in `zxingWasm.test.ts` (resolves to
  a same-origin asset, never jsdelivr/fastly). ScanScreen calls `createQrDetector()` instead of
  constructing the ponyfill detector directly. **CSP consequence:** `connect-src` no longer lists any
  CDN (see § Deployment).
- **⚠️ Version-coupling — re-check the `zxing-wasm` pin on every `barcode-detector` bump.** Our direct
  `zxing-wasm@3.1.0` pin MUST stay equal to the version `barcode-detector` inlines internally: at scan
  time the ponyfill's JS expects a `zxing_reader.wasm` whose ABI matches ITS inlined copy, but
  `locateFile` now points the loader at OUR vendored asset. If a future `barcode-detector` upgrade
  silently inlines a DIFFERENT zxing-wasm version, our vendored `.wasm` would be ABI-mismatched against
  the loader JS → the QR-scan FALLBACK breaks **at runtime on iOS/Firefox** (the `.wasm` import still
  resolves and the build still passes — the mismatch is invisible to `tsc`/`vite build`, and Chromium's
  native `BarcodeDetector` path masks it in most dev/CI). So when bumping `barcode-detector`, re-verify
  the exact zxing-wasm version it inlines (e.g. inspect its `package.json`/lockfile entry) and move our
  direct `zxing-wasm` pin to match in the SAME pass, then re-run `zxingWasm.test.ts` and a real
  non-Chromium scan. Keep both pins EXACT (no `^`/`~`).

## UI / styling — stark-ui-kit (required)
Dependency: `"stark-ui-kit": "github:maksimfrelikh/stark-ui-kit#<sha>"` — a private GitHub repo, pinned by
commit (NOT on the npm registry: `npm install stark-ui-kit` fetches an unrelated package). **Current pin:
`b23a2e5` = kit 0.1.0, the first cut.** The kit has moved on since (0.2.0 `59914b0`: the React hooks moved
to `stark-ui-kit/react`, root entry framework-free; 0.3.0 `2a3f7ec`: `theme-mono.css` house palette,
`controls.css` / `links.css` / `layout.css`). Bumping the pin is a small MIGRATION, not a refresh — see
BACKLOG § Nice-to-have "stark-ui-kit 0.3.0 migration". Everything below describes the pinned 0.1.0.
- **Design language = "Stark"**, published as a Claude Design system generated from the reference site
  frelikh.com: https://claude.ai/artifact/Da7if9WhD7hxZjf5sL6m2F (brand book, tokens, kit + site
  components, reference screenshots). The rules for changing the kit and how a change travels live in
  the kit's own `CLAUDE.md`. `uploads/design-reference/_ds/` is an OLDER extracted copy of the same
  language and drifts from it (its high-contrast hairline `#c4c4c4` is 1.74:1 on white, under the 3:1 of
  SC 1.4.11; `src/ui/theme.css` still carries that set) — values come from the kit, never from there.
- Import `stark-ui-kit/styles.css` once, at the app root (`src/main.tsx`).
- **Strictly MONOCHROME — there is NO accent colour.** Emphasis / selected / danger is the single
  ink-INVERSION language: `--ink` (the strong ink) on `--ink-fg` (text on ink). Do not add any
  colour/accent token, ever.
- **Theme is switched via `[data-theme]` on `<html>`** (light is the default; `[data-theme="dark"]`
  is opt-in — `prefs.tsx` reflects the choice). The monochrome light/dark palette lives in
  `src/ui/theme.css` and is consumed by the kit; the app never introduces new colour/spacing/radius
  scales.
- **Build ALL styling on the kit's real tokens** (do not invent scales): semantic colours
  `--bg` / `--fg` / `--muted` / `--faint` / `--line` / `--line-2` / `--ink` / `--ink-fg`;
  radii `--r-*`; typography `--t-*` + weight / label tokens; fonts `--font-grotesk` / `--font-mono`;
  spacing `--gut` / `--maxw` / `--scale`; motion `--ease-*` / `--dur-*`. (These are the ACTUAL kit
  names — NOT the prototype's `--line2` / `--inkfg` / `--sans`.)
- For focus-trap, scroll-lock, and copy-to-clipboard use the kit's hooks/utilities —
  `useFocusTrap`, `useScrollLock`, `copyToClipboard` — do not reimplement. (On the pinned 0.1.0 all three
  import from `stark-ui-kit`; from 0.2.0 the two hooks import from `stark-ui-kit/react`.)
- The kit ships **tokens + a11y base CSS + headless hooks ONLY (no React components).** Screens are
  composed from the app component layer in `src/ui/app.css` (classes prefixed `.hs-*`, all built on
  the kit tokens above), imported in `src/main.tsx` AFTER the kit base + `theme.css`.
- Build screens against the Claude Design mockups in `uploads/design-reference/` (HTML prototype
  + screenshots; bilingual EN/RU). Design priority: **the kit is the source of truth**; mockups are
  reference for layout/flow/copy — where they conflict with kit components/tokens, the kit wins.

## Signaling server (`server/signaling-server.js`)
Self-contained Node + `ws`; PURE signaling, never carries file data. Already corrected:
`clientIp()` reads `X-Real-IP` (set by nginx), not the client-controllable leftmost
X-Forwarded-For; binds to `127.0.0.1` (only the local nginx reaches it). Run with
`TRUST_PROXY=1` behind nginx.
- Frontend (static `dist/`) and the WS share one host behind nginx; nginx must set
  `proxy_set_header X-Real-IP $remote_addr;` and proxy the WS (e.g. `location /ws`) to
  `127.0.0.1:8080`. Client connects to `wss://<host>/ws?app=filetransfer&…`.
- **Lobby roster protocol (step 6c)**: `welcome.peers` and `peer-joined` now carry the room roster as
  `{id, device, joinedAt}` (was a bare id / `{peerId}`). `device` is a COARSE cosmetic label the client
  sends on connect (query `?device=` — e.g. `Desktop`/`Mobile`, never a full UA); the server strips
  control chars + **caps it ≤32** (untrusted, cosmetic — the SAS authenticates) and **stamps `joinedAt`
  on its own clock**. `peer-left` is unchanged (`{peerId}`). The client validates the new shape with
  zod (`peerInfoSchema`) before it reaches the store. Used only for the room mesh-lobby roster UI.
- **codeType allocation (`codeSpec`)**: the server resolves a per-connection `codeType` to a
  validator + allocator. THREE codeTypes for `filetransfer`: **''** (default, 4-digit `code`/`allocate`
  — the ROOM method); **`word`** (server keeps its own EFF short #2 copy, allocates a rendezvous word
  via the same collision-retry loop, validates membership on join — the WORDS method); **`token`** (a
  128-bit CSPRNG base64url token, `TOKEN_ROOM_BYTES=16` → 22 chars, allocated via `randomBytes` +
  `allocateCode`, validated by `TOKEN_RE` strict format/length on join — the link/QR method). The
  client selects via `?codeType=word` / `?codeType=token`. Word/token rooms expire on TTL or
  cap-reached; freed words return to the pool.
- **Managed-room hardening (all codeTypes — done in 6a; token added pre-deploy)**: the `filetransfer`
  app is flagged **`managed: true`**, which governs the TTL + per-IP rate-limit for ALL its rooms
  (4-digit, word, token). The **seat cap is a SEPARATE, codeType-dependent decision** (`managed` ≠ 1:1):
  - **Seat cap (codeType-dependent)** — `const maxPeers = is1to1 ? ONE_TO_ONE_MAX_PEERS : cfg.maxPeers`,
    where `is1to1 = isWordRoom || isTokenRoom` (`isWordRoom = codeType==='word' && !!cfg.wordCode`;
    `isTokenRoom = codeType==='token' && !!cfg.tokenCode`). The 4-digit ROOM rendezvous is a **LOBBY**
    of `cfg.maxPeers` (`FILETRANSFER_MAX_PEERS`, default **8**) — several peers see each other and each
    picks whom to open a 1:1 channel with; the **words AND link/QR token** rendezvous are strictly 1:1
    (`ONE_TO_ONE_MAX_PEERS = 2`) — words so secret-word guessing stays serialized, token so a forwarded
    one-time link still reaches a SINGLE receiver. A joiner past the cap is bounced with close
    **4002 `'room full'`** (the room-full check runs before the per-IP-per-room cap). (The `clipboard`
    mesh has no `wordCode`/`tokenCode` → `is1to1` is always false → it keeps its own `cfg.maxPeers`
    lobby, unchanged.)
  - **TTL until connected** — `closeRoom(key,'expired')` notifies members (`{type:'room-closed'}`),
    closes their sockets (**4010**), and FREES the code (a later join → **4009 `'room not found'`**),
    via the extracted `makeTtlTimer(key, ttlMs)` (unref'd). The **4-digit lobby uses an IDLE timeout**
    (`ROOM_TTL_MS`, default **180000** ~3 min): armed on CREATE and **re-armed on every JOIN** (only
    when `cfg.managed && !is1to1`), so an actively-joined lobby lives while a stale one expires.
    The **1:1 words AND token rooms arm their TTL once at CREATE and NEVER re-arm** (`WORD_ROOM_TTL_MS`
    / `TOKEN_ROOM_TTL_MS`, default 180000) — a re-arm would let an attacker keep a 1:1 room alive by
    rejoining (for words it would also defeat the guessing bound). All env-overridable. The creator may
    also tear down early via `{type:'destroy'}`
    (reason `'destroyed'`). After `connected`, closing signaling does NOT drop the live P2P channel —
    the TTL only bounds the pre-connection rendezvous window (client treats the close as benign once
    `established`).
  - **Per-IP create/join rate-limit** — UNCHANGED. Fixed window keyed on `clientIp()`: `IP_RL_MAX =
    60` attempts per `IP_RL_WINDOW_MS = 60000` (both env-overridable). Over budget → close **4011 `'too
    many attempts'`** (counts failed joins too, so it bounds enumeration of the 10k space). **Loopback
    is EXEMPT** (`127.0.0.1` / `::1`) — behind nginx a real client always arrives via `X-Real-IP` and
    never looks like loopback, so the local proxy / dev / e2e are never throttled. Defense-in-depth
    only; SAS / key-confirmation are what actually stop a MITM. (`tests/integration/room-server.test.ts`.)
  - **Per-IP-per-room cap — DEFAULTS TO THE ROOM CAP (not a hardcoded 2)**. The per-room anti-squat
    check (`sameIp >= perIpPerRoomCap` → close **4007 `'too many from your network'`**) uses
    `perIpPerRoomCap = MAX_PER_IP_PER_ROOM || maxPeers` — i.e. with `MAX_PER_IP_PER_ROOM` unset it is
    the room's OWN seat cap (`maxPeers`: 8 for the 4-digit lobby, 2 for the 1:1 words/token rooms). So
    by default the **room cap is the binding per-room limit**: ONE IP may fill a room up to the cap, and
    a peer past it hits the seat-cap **4002** (which runs first), never 4007. This is deliberate — a
    room is a shared code for a group up to `FILETRANSFER_MAX_PEERS` (8) that then pairs 1:1, and the
    natural such group (a meeting/class/office behind one NAT = one shared public IP) must not be
    throttled by a small per-IP cap. Set `MAX_PER_IP_PER_ROOM` to a value **below** the room cap to
    RE-tighten anti-domination (one IP can't fill a room → 4007 fires before the room is full) at the
    cost of co-located groups gathering past that value. Global per-IP limits are untouched
    (`MAX_CONNS_PER_IP` 4006, `IP_RL_MAX` 4011). (`tests/integration/room-server.test.ts`.)
  - The `clipboard` mesh app is NOT `managed` — it keeps its shared-code mesh (`maxPeers` lobby, no
    TTL, no rate-limit), since those are one user's own devices typing the same code on purpose.
- **TURN credentials for Reliable mode (server side — done; client side — done; Max-privacy is STRICT
  / never relays, see Privacy mode + ICE §)**: the server
  answers a **`turn-request`** frame with short-lived, HMAC-derived **coturn** credentials
  (`use-auth-secret` / "REST API" scheme) so a 1:1 pair that can't connect directly can fall back to
  a relay. Gated on **`cfg.managed`** (the `filetransfer` rendezvous only; `clipboard` has no server
  fallback). The reply is `{type:'turn-credentials', urls, username, credential, ttl}` where
  `username = String(floor(now/1000) + TURN_CRED_TTL_S)` (a FUTURE unix-expiry) and
  `credential = base64(HMAC-SHA1(TURN_SECRET, username))`. **coturn recomputes the same HMAC and
  enforces the embedded expiry**, so there is NO signaling↔coturn round-trip. The **`TURN_SECRET` is
  shared with coturn's `static-auth-secret` and lives ONLY on the server — it is NEVER sent to the
  client**; only the derived per-session credential leaves the process. **Graceful when unconfigured**:
  empty `TURN_SECRET` (or a non-managed app) → reply with **empty `urls`** (`{urls:[], username:'',
  credential:'', ttl:0}`) → the client treats relay as unavailable and stays **direct-only**
  (= Max-privacy). The handler is bounded by the **existing per-socket message rate-limit** (no
  separate limiter). Env: `TURN_SECRET` (server-only shared secret), `TURN_URLS` (comma-separated
  `turn:`/`turns:` URIs → array), `TURN_CRED_TTL_S` (default **3600**). **coturn is deployed
  SEPARATELY** — template + line-by-line hardening (open relay-port range + firewall, `user-quota` /
  `total-quota` / `max-bps`, anti-SSRF `no-multicast-peers` / `no-loopback-peers` / `denied-peer-ip`
  on RFC1918 + link-local, `fingerprint`, `no-cli`) in **`deploy/coturn.conf.example`**. The client
  side (the functional toggle, `requestTurnCredentials`, feeding `iceServers`, Max-privacy never
  requests) is **done** — see **Privacy mode + ICE** §. **Max-privacy is STRICT** — a live Max-privacy
  ICE failure does NOT escalate to relay; it fails terminally with a switch-to-Reliable hint (see
  **Max-privacy strict model** there). (`tests/integration/turn-credentials.test.ts` for the mint;
  `tests/integration/turn-relay.test.ts` for the mint ACTUALLY opening a relay on a real coturn —
  the `TURN_SECRET` == `static-auth-secret` invariant, with a wrong-secret negative control.)

## Deployment / configuration (step 6f — LIVE at hushsend.frelikh.dev, deployed 2026-06-20)
One place that ties together every knob needed to run a live instance. The **artifacts** are built
and committed — `deploy/nginx.conf.example`, `server/.env.example`, `deploy/coturn.conf.example`,
and the step-by-step `deploy/DEPLOY.md`; the only code change for 6f is an **additive startup
`[config]` summary log** (no secrets) in `signaling-server.js`. The live deploy itself (nginx/coturn/
DNS/TLS on real hosts) is ops — these are what it consumes. Config lives in three layers:
- **Client build-time (`VITE_*`, baked by Vite — no runtime client config):** `VITE_SIGNALING_URL`
  (the `wss://hushsend.frelikh.dev/ws` the client opens — nginx proxies `/ws` → Node) and
  **`VITE_STUN_URLS`** (coturn STUN endpoint(s)). **`VITE_STUN_URLS` is REQUIRED for a real deploy** —
  Max-privacy (the default) is STUN-only, so with it empty two cross-network peers have no ICE server
  and never connect (loopback tabs hide this in dev). Changing either means a **rebuild**, not an
  nginx edit; `VITE_SIGNALING_URL`'s host must match the CSP `connect-src` in the nginx template.
- **Server env (`server/.env.example`):** `HOST`/`PORT` (loopback `127.0.0.1:8080` behind nginx),
  **`TRUST_PROXY=1` (mandatory behind nginx)**, TURN (`TURN_SECRET` / `TURN_URLS` / `TURN_CRED_TTL_S`),
  and the tunable caps/TTLs/rate-limits (`MAX_CONNS_*`, `FILETRANSFER_MAX_PEERS`, `ROOM_TTL_MS` /
  `WORD_ROOM_TTL_MS` / `TOKEN_ROOM_TTL_MS`, `IP_RL_MAX` / `IP_RL_WINDOW_MS`, message-rate knobs). **`TRUST_PROXY=1` +
  nginx `proxy_set_header X-Real-IP $remote_addr;` are a pair and the #1 footgun:** without both,
  `clientIp()` sees only loopback → per-IP caps collapse onto one bucket and the 4011 rate-limit
  (loopback-exempt) silently disables. **Shared-NAT note:** clients behind one public IP divide
  `IP_RL_MAX` per window → raise it for office/CGNAT deploys (defense-in-depth only — SAS stops a
  MITM). The startup `[config]` log echoes the effective values (TRUST_PROXY, TURN configured/count,
  caps, TTLs, IP_RL_MAX) **without secrets** — eyeball it after each restart.
- **coturn (`deploy/coturn.conf.example`; MAY be a separate host — the live deploy runs it on the
  SAME host, `turn:`-only on `:3478`, no `turns:`/5349):** `static-auth-secret` **MUST EQUAL** the
  server's `TURN_SECRET` (the one shared secret; coturn recomputes the HMAC offline). Empty
  `TURN_SECRET` ⇒ relay disabled ⇒ clients stay direct-only (a valid config). Open the firewall for
  3478 udp/tcp (5349 tls only if you enable `turns:`) and the relay-port range.
- **Cross-dependencies:** `TURN_SECRET` == coturn `static-auth-secret`; `VITE_STUN_URLS` + `TURN_URLS`
  both name the **coturn host** (DNS: `hushsend.frelikh.dev` → web host, `turn.hushsend.frelikh.dev`
  → coturn). **CSP must be verified against the built app — especially the QR-scan path** (zxing WASM
  needs `'wasm-unsafe-eval'` to COMPILE on iOS/Firefox; the WASM itself is **self-hosted** since step
  6e — vendored into `dist/assets`, served from `'self'` — so `connect-src` is `'self' wss://<host>`
  only, **no CDN**; camera needs `Permissions-Policy: camera=(self)`); see the CSP comment block in
  `deploy/nginx.conf.example` and the smoke-test gotcha in `deploy/DEPLOY.md`. **See `deploy/` for the
  templates + runbook.**

## Build order (completed / in progress / planned)
1. ✅ **Transport** — `SignalingClient`, `PeerConnection`, core DataChannel backbone.
2. ✅ **File transfer** — chunking, backpressure, FSA/Blob caps.
3. ✅ **words path** — wordlist (EFF short #2, programmatic), `generateWords` (CSPRNG);
   `cpace` (CFRG draft-21 vectors, ristretto255+SHA512); `keyConfirmation` (ISK→HMAC, channel
   binding); rate-limit (≤10 attempts); TTL (3 min, does not tear down live P2P).
4. **room + SAS, then Identity + TOFU**:
   - ✅ **4a — room + SAS** — 4-digit code, commit-before-reveal, SAS = 3 words, fingerprint
     binding, mutual confirmation over DataChannel, pre-SAS + comparison timeouts, zod length
     checks. (Server cap/TTL/rate-limit for 4-digit rooms is **done — step 6a**, below.)
   - ✅ **4b — Identity + TOFU** — two parts:
     - **4b-i** — Ed25519 identity key + IndexedDB keystore + TOFU **enrollment** (pin peer key
       on first successful connect, channel-bound).
     - **4b-ii** — **reconnect**: mutual challenge-response signatures (channel-bound, replay-
       resistant) under the pinned keys; two-check verify (key-changed vs MITM) + "key changed" hard
       stop; falls back to SAS + enrollment when a pin is missing. `reconnect.ts` + e2e (happy +
       key-changed).
5. **Real UI screens** — kit-based, status-driven screens (no router), persistent state across
   tabs / reload.
   - ✅ **5a (this step)** — real screens for the existing methods: home (method select + recent
     devices), room create/join, words create/join (5-slot autocomplete picker), **SAS as an
     ASYMMETRIC "pick from 3 phrases"** (per-pairing by id: the smaller-id side reads its phrase, the
     other is the blind picker), reconnect (pinned-key → no SAS; visible key-changed hard stop),
     transfer (progress / backpressure / FSA-Blob / cancel), failed/error screens, light-dark +
     EN/RU. Dev harness removed; a DEV-only diagnostics strip (tree-shaken from prod) carries the
     test-observable projections. **Recent devices are read from the keystore** (`recentDevices.ts`
     → `listPins()`) — the single source of pins/keys; localStorage holds ONLY prefs (`prefs.tsx`,
     lang/theme/**privacy mode**) — no peer keys, no pairingIds, no secrets, **no transfer history**
     (history is SESSION-ONLY: in-memory Redux `historySlice`, gone on reload — see § Build order 6 /
     transfer-history privacy); "forget" clears the keystore pins AND the in-memory history. The SAS
     pick-from-3 display logic is isolated + unit-tested in `sasOptions.ts` (`sasOptions.test.ts`).
     (The Privacy/Reliable toggle was rendered disabled here in 5a; it is now FUNCTIONAL — step 6d
     client side, see **Privacy mode + ICE** §.)
   - ✅ **5b** — link + QR methods. High-entropy one-time secret S in the URL fragment
     (scrub-after-read), token rendezvous (`codeType=token` — initially a 4-digit room; replaced
     with a high-entropy token rendezvous pre-deploy, see § link/qr method), channel-bound key-confirmation over S
     (`LINK_CONFIRM_DOMAIN`) — no PAKE, no SAS. qr = the same link via `qrcode` (generate) +
     `barcode-detector` ponyfill + `getUserMedia` (scan, with a paste fallback). `src/core/link/` +
     link/qr screens + `src/ui/qr.ts` + e2e (link happy / link wrong-secret / qr post-scan).
6. **Hardening**:
   - ✅ **6a — server cap/TTL/rate-limit for `filetransfer` rooms** — `managed: true` (TTL +
     per-IP rate-limit). TTL-until-connected freeing the code (4010 close / 4009 on a later join),
     per-IP create/join rate-limit (4011, loopback-exempt). Server-only change;
     `tests/integration/room-server.test.ts`. **Correction (later pass):** the seat cap is
     codeType-dependent, NOT the `managed` flag — the 4-digit **room** rendezvous is a **mesh LOBBY**
     (`FILETRANSFER_MAX_PEERS`, default 8); the **words** AND (pre-deploy) the link/qr **token**
     rendezvous are strictly 1:1 (`ONE_TO_ONE_MAX_PEERS = 2`). The 4-digit lobby TTL is an **idle
     timeout** (re-armed on each join); the 1:1 words/token TTLs stay armed from CREATE. Also: **SAS UI
     role is now per-pairing by readable-id order**
     (`src/core/sasRole.ts`, projected as `connection.sasRole`, fail-closed restart on a missing id)
     so the lobby's joiner↔joiner pairs still get one reader + one picker. See **Signaling server**
     § *Managed-room hardening* and room/SAS § *Server cap / TTL / rate-limit* + *SAS role*.
   - ✅ **6b — per-pairing transport/crypto role** — `this.role` (initiator/responder) is now fixed
     **PER-PAIRING from the readable ids** (`src/core/pairingRole.ts` `pairingRoleFor`, same id order
     as the SAS reader/picker; unit-tested in `pairingRole.test.ts`), NOT create/join. This breaks the
     joiner↔joiner deadlock (both `responder` → no WebRTC offer + SAS commit-reveal stall) for the
     mesh lobby: the WebRTC offer, CPace init, SAS nonce/commit order, and key-confirmation/enrollment
     `lv(role)` all follow it; reconnect's protocol role stays create/join (the exception). 1:1 outcome
     unchanged. Foundation for the lobby-UI (next). See **Per-pairing role** §.
   - ✅ **6c — Room lobby UI (mesh roster + pick→connect)** — the room method no longer auto-pairs:
     creator AND joiners land in `awaitingPeer` (`joining → awaitingPeer`, no new state) and see a
     `LobbyScreen` — the 4-digit code + a roster (`connection.roster` = `{id, device, joinedAt}` from
     welcome/peer-joined) + a Connect button per peer. Pick → `pair-request`; the smaller id offers
     (per-pairing role 6b), glare/dedup handled, **busy-reject** returns the picker to the lobby with a
     clear notice (no hang). Works for ANY pair incl. **joiner↔joiner**. Signaling protocol grew:
     `welcome.peers` + `peer-joined` now carry `{id, device, joinedAt}` (coarse device label sent by
     the client, server-capped ≤32 + server-stamped joinedAt). words/link/qr are NOT lobbies (auto-pair
     with one peer); reconnect keeps the simple code screen + auto-pairs. `LobbyScreen` +
     `pickPeer`/`onPairRequest`/`onBusy`; `tests/e2e/lobby.spec.ts` (joiner↔joiner + busy),
     `connectionSlice.test.ts` (roster), `room-server.test.ts` (roster protocol). See **Room lobby** §.
     **Deferred:** reconnect-in-lobby (lobby picks always do a fresh SAS; reconnect stays a separate
     by-code path — when it gains lobby support its reconnect role must move to id-order too),
     return-to-lobby after a finished/aborted session, and link/qr lobby-race resistance — see BACKLOG.
   - ✅ **6d — TURN relay + Reliable / Max-privacy (STRICT) mode** *(DONE)* —
     **server side**: the signaling server mints short-lived HMAC coturn credentials on a
     `turn-request` frame (`use-auth-secret` scheme, `TURN_SECRET` shared with coturn + never sent to
     clients, empty-urls when unconfigured → direct-only); env `TURN_SECRET` / `TURN_URLS` /
     `TURN_CRED_TTL_S`; coturn deploy template `deploy/coturn.conf.example`;
     `tests/integration/turn-credentials.test.ts`. **Client side:** the home
     **PrivacyToggle is functional** (persisted pref, default Max-privacy) and drives `iceServers` —
     **Max-privacy = STUN-only, never requests creds; Reliable = STUN + TURN**, creds fetched via
     `requestTurnCredentials` (`turn-request`) after `welcome` + before the PC, empty-urls → direct-only.
     `src/core/iceServers.ts` (builder, `VITE_STUN_URLS` STUN config) + `iceServers.test.ts`;
     `prefs.tsx` pref + `<PrivacyModeSync>` (App) → `setPrivacyMode`; `tests/e2e/privacy.spec.ts`.
     **Max-privacy strict model (this pass — was relax-retry, now strict):** Max-privacy NEVER relays —
     no consent escalation. The PeerConnection always drops the peer's `typ relay` candidates
     (`src/core/relax.ts` filter) and never requests TURN, so a live Max-privacy ICE failure is
     **terminal**: `onIceFailed` → `failDirect` → the existing `failed` state with a switch-to-Reliable
     hint (`directFailHint`, EN/RU; `direct-fail-hint` testid). The relax-offer / `connection.relax` /
     `relax` signaling frame / bilateral `relaxConnection`/`declineRelax` / `setConfiguration`+`restartIce`
     escalation were all **REMOVED** (this also removes the asymmetric-relax bug class, incl. the
     suspected Firefox mixed-privacy hang — gone by design). `src/core/relax.ts` (filter only,
     `relax.test.ts`), `FailedScreen` hint, `?forceIceFail=1` DEV knob, `tests/e2e/relax.spec.ts`. See
     **Privacy mode + ICE / Max-privacy strict model** §.
   - 🚧 **6e — cross-browser pass** — the **no-device parts are DONE** (this pass): (1) the QR-scan
     WASM is **self-hosted** (vendored, served from `'self'`, no CDN — `src/ui/zxingWasm.ts`
     `createQrDetector` + `setZXingModuleOverrides` over a Vite `?url` asset; `zxingWasm.test.ts`;
     CSP CDN dropped), and (2) a **feature-detection / graceful-degradation review** confirmed every
     browser-API path degrades cleanly with a fallback/message: QR-scan (no `BarcodeDetector` →
     self-hosted zxing; camera denied/absent → paste fallback — added an explicit
     `navigator.mediaDevices?.getUserMedia` guard), file save (no FSA `showSaveFilePicker` → Blob
     fallback + size cap, rejected pre-accept), `navigator.locks` (cross-tab keystore lock → degrade
     to direct call), `navigator.share`/`crypto.subtle`/`indexedDB` (all guarded with fallbacks).
     **Remaining (after deploy, real devices):** transport + FSA→Blob + QR scan + camera permissions
     verified on actual iOS Safari / Firefox.
   - ✅ **6f — nginx deployment — LIVE at hushsend.frelikh.dev** — the config
     templates + runbook are built and committed: `deploy/nginx.conf.example` (TLS, 80→443, SPA
     `try_files $uri /index.html`, the `/ws` proxy with `proxy_set_header X-Real-IP $remote_addr;` +
     WS-upgrade + raised `proxy_read_timeout`, and security headers — HSTS / a build-tuned **CSP**
     [`'wasm-unsafe-eval'` for the QR-scan WASM, now **self-hosted** so `connect-src` lists no CDN —
     step 6e] / `Permissions-Policy camera=(self)`),
     `server/.env.example` (all server env in one place), `deploy/coturn.conf.example` (from 6d), and
     `deploy/DEPLOY.md` (step-by-step + inline gotchas). The only code change was an **additive startup
     `[config]` summary log** (no secrets) in `signaling-server.js`. Consolidated env reference:
     **§ Deployment / configuration** above. **LIVE — first bring-up 2026-06-20 on a VPS
     (`frelikhmax.fvds.ru`), MOVED to the owner's home server 2026-08-16**, which is what serves it
     today (facts re-verified on the box 2026-09-12; **DEPLOY.md § 0 is the as-realized source of
     truth** — do not cite the old VPS): Ubuntu 26.04.1, nginx 1.28.3, **Node v22.22.1 system
     `/usr/bin/node`** (not nvm); frontend built on-server → `/var/www/hushsend/dist`; signaling = the
     SEPARATE universal repo `hush-signaling-server` (clone `~/projects/…`, **running copy
     `/var/www/hush-signaling-server`**) under systemd `hushsend-signaling` (`127.0.0.1:8080`,
     `User=frelikh`); **coturn on the SAME host, `turn:`-only on `:3478`** (no `turns:`/TLS); TLS =
     the box's **wildcard `*.frelikh.dev`** cert (certbot DNS-01), not a per-host webroot cert. The
     host is behind a **residential NAT**, so the router forwards 80/443 tcp + 3478 tcp/udp + the
     relay range 49160–49200/udp, and coturn needs `external-ip=<public>/<lan>` or the relay
     advertises a private address. The old `http2 on;` → `listen … ssl http2;` template fix was for
     the VPS's nginx 1.24 and no longer applies (1.28 accepts both; HTTP/2 is currently OFF on the
     vhost — a free win, not a fix). External smoke ALL green (security headers/CSP, `/health`,
     `.wasm` as `application/wasm`, `/ws`→426 reaching Node, SPA fallback). **Remaining (ops, not
     code):** the in-browser P2P/SAS/transfer test on two devices + a cross-network TURN relay check
     (overlaps 6e real-device). (link/qr high-entropy rendezvous = codeType=token, done pre-deploy.)

## Current state
- ✅ `src/core/crypto/` — `cpace` (CFRG draft-21 vectors passing), `keyConfirmation` (channel
  binding + MITM tests), `sas` (commit-before-reveal, HKDF-SHA512, fingerprint binding, timeouts,
  zod length checks), `identity` (Ed25519, WebCrypto non-extractable + noble fallback),
  `enrollment` (TOFU exchange + pin, channel-bound), `reconnect` (TOFU re-auth: channel-bound
  signature under the pinned key + fresh challenges, two-check verify, key-change detection). Words
  wordlist (EFF short #2) programmatic.
- ✅ `src/core/keystore/` — IndexedDB (+ in-memory backend for unit tests) behind
  `KeystoreBackend`; own identity key + pinned peer keys (`pairingId → peer key`). Cross-tab
  identity-generation single-flight via `navigator.locks`; "key changed" detection on reconnect.
- ✅ `src/core/words/` — `generateWords` (CSPRNG, rejection-sampled), rate-limit counter (≤10
  attempts), TTL handling (does not kill live P2P).
- ✅ `src/core/link/` — `link.ts` (pure): `generateLinkSecret` (16 CSPRNG bytes, base64url),
  `buildLinkUrl` (`<origin>/#<token>.<S>`), `parseLink` (strict: 22-char base64url rendezvous TOKEN +
  16-byte S, no throw; rejects an old 4-digit code). The rendezvous is a high-entropy token
  (`RENDEZVOUS_TOKEN_BYTES = 16`), so link/qr can't be enumerated/squatted. Used by the link/qr
  methods; the secret never reaches the server. (`link.test.ts`.)
- ✅ `src/core/livenessGate.ts` — pure `peerLeftAbortsPairing(established, channelOpen)` predicate
  (+ `livenessGate.test.ts`): a signaling `peer-left` aborts a pairing ONLY before the DataChannel
  transport is up. Backs the per-pair close-signaling-on-`connected` privacy feature
  (`SessionController.closeSignalingAfterConnect` + `this.channelOpen`) — applied to the `words`,
  `link/qr` AND `room/SAS` `onPeerLeft` branches (`SessionController.sasPeerLeft.test.ts` covers the
  SAS branch + the room per-pair close + reconnect's own close and peer-left gate) — see
  **§ Signaling WS lifecycle**.
- ✅ `src/core/` — transport (SignalingClient, PeerConnection), file transfer, SessionController
  orchestration (incl. SAS + post-connect enrollment wiring + the link/qr key-confirmation-over-S
  path, step 5b; **per-pair signaling-socket close on `connected`** — 1:1 methods via
  `tryVerifyConfirmation` AND room/SAS pairs via `trySasSettle`, both through
  `closeSignalingAfterConnect` (ALL methods, reconnect included) — with `peer-left` decoupled from P2P liveness —
  `livenessGate`). FSM in store (status, transitions,
  invariants enforced). The per-pairing
  transport/crypto role is fixed from the readable ids in `SessionController.beginPairing` via
  `src/core/pairingRole.ts` `pairingRoleFor` (smaller id = initiator; same id order as
  `sasRole.ts`; `pairingRole.test.ts`) — drives the WebRTC offer, CPace init, SAS nonce/commit
  order, and key-confirmation/enrollment `lv(role)`; reconnect's protocol role stays create/join.
  Pre-PC WebRTC signals (offer/answer/ICE arriving for the active pairing while `this.peer` is null —
  e.g. a Reliable answerer still awaiting coturn creds in `startPeer`) are buffered in
  `pendingPeerSignals` and replayed by `flushPendingPeerSignals` after the PC is built, then cleared on
  every teardown — the **mixed-privacy / link-qr deadlock fix** (`SessionController.pendingPeerSignals.test.ts`;
  see **Privacy mode + ICE** §).
- ✅ `src/core/relax.ts` — Max-privacy STRICT relay enforcement (step 6d + the 2026-09-12 audit fix;
  pure + `relax.test.ts`): the relay-candidate predicate (`isRelayCandidate`/`shouldDropCandidate` —
  Max-privacy ALWAYS drops the peer's `typ relay` candidates, off in Reliable) AND the
  selected-path check that closes the peer-reflexive bypass (`relayCandidateEndpoint`/`endpointKey`
  record what was dropped; `selectedRemoteCandidate` reads the selected pair out of a `getStats()`
  report across engine shapes; `isForbiddenRemoteCandidate` is the verdict). The live wiring (filter +
  endpoint recording in `PeerConnection.addIce`; `openChannelUnlessRelayed` gating `onOpen` at
  channel-open; `onIceFailed` → `failDirect` → the existing `failed` state with a switch-to-Reliable
  hint) is in PeerConnection + SessionController. **Max-privacy never relays** — the relax-offer / `connection.relax`
  / `relax` signaling frame / `relaxConnection`/`declineRelax` / `restartIce`-over-relay machinery was
  removed (strict model, this pass).
- ✅ `src/ui/` — **real, status-driven screens (steps 5a + 5b)**, built on kit tokens (monochrome,
  inversion-as-emphasis, light/dark via `[data-theme]`, EN/RU). `ScreenRouter` picks a screen by
  FSM status (+ method/phase); `HomeScreen` (landing → method picker [link / qr / words / room] →
  words-receive + QR-scan-receive, **a "Reconnect a device" section with an EXPLICIT create-vs-join
  split** — a one-line hint + **Start** [tap a recent device → `createReconnectSession` opens a room +
  shows a code] vs **Join — enter the code the other side is showing** [`joinReconnectSession`], so
  "both start → two rooms" / "reconnect + plain join → handshake mismatch" stop being easy mistakes
  (UI-only; protocol/roles/wire unchanged), join-by-code, **functional "Max
  privacy" / Reliable toggle** — step 6d, drives `iceServers`), `RoomCreateScreen` (reconnect create
  path — code + waiting), `LobbyScreen` (step
  6c — the room mesh lobby: code + roster [`connection.roster` id/device/joinedAt] + a Connect button
  per peer → `pickPeer`), `WordsCreateScreen`, `LinkCreateScreen` (one-time link +
  copy/share), `QrCreateScreen` (the link as an SVG QR), `ScanScreen` (qr receive: camera +
  paste-link fallback), `ConnectingScreen` (creating/joining/pairing-lobby/confirming — a Max-privacy
  ICE failure routes to the FailedScreen with a switch-to-Reliable hint, NOT a relay offer; step 6d
  STRICT), `SasScreen`
  (**asymmetric pick-from-3**: reader shows its phrase; picker is blind among the real + 2 local
  decoys — **role per-pairing by readable-id order**, `src/core/sasRole.ts` → `connection.sasRole`,
  fail-closed "restart verification" on a missing id), `TransferScreen` (a finished/aborted transfer
  parks on its terminal plaque with an explicit **"New transfer"** button [`new-transfer-btn`] that
  `transferActions.reset()`s the per-transfer projection + clears the local pick → a CLEAN
  ready-to-send per send, no leftover progress/file-name from the prior transfer; the drop zone shows
  only in a clean `idle`. Does NOT touch the connection or clear the history records), `FailedScreen`
  (+ key-changed hard stop). The link fragment auto-join + scrub lives in `App.tsx`
  (`LinkFragmentJoin`). Shared `ui.tsx` (TopBar, StatusBeacon, PrivacyToggle, CopyButton,
  ShareButton, Eyebrow, …), `components/` (`WordPicker`, DEV-only `Diagnostics`), `qr.ts`
  (link→SVG QR via `qrcode`; `qr.test.ts`), `prefs.tsx` + `i18n.ts` (lang/theme/**privacy mode**, the
  last pushed into the core via `<PrivacyModeSync>` → `setPrivacyMode`), `sasOptions.ts`
  (+ `sasOptions.test.ts`: SAS pick-from-3 decoys + scoring) over `random.ts` (CSPRNG),
  `recentDevices.ts` (recent devices read from the keystore, **deduped by `peerPublicKey`** —
  `dedupeByPeerKey`, ONE row per distinct peer key keeping the most-recent pin; its `pairingId` drives
  the reconnect tap [`createReconnectSession(pairingId?)`], its `label`/`firstSeen` the row — so a peer
  that holds several pins under distinct pairingIds [fresh-enroll / dual-pin] shows once. Display-only:
  pins are NOT GC'd; reconnect wire protocol unchanged. `recentDevices.test.ts`). **Transfer history is
  SESSION-ONLY** — an in-memory Redux slice (`src/store/historySlice.ts`), NOT persisted (file names are
  a privacy trail; gone on reload), kept **bounded** (`HISTORY_CAP = 12`) + **clearable** (`forgotten`,
  via the home "forget"); the per-send transfer reset does NOT clear it (`transferSlice.test.ts` /
  `historySlice.test.ts`). localStorage now holds **only prefs** (lang/theme/privacy mode); there is no
  longer a `persistence.ts`. The `dev` store slice stays as the auxiliary projection
  feed (identity pubkey / pinned peer / public DTLS fingerprints / **ICE config: privacy mode + relay
  + TURN creds** / log) the SessionController publishes; all fields are serializable + non-sensitive
  (RTK `serializableCheck` stays ON), and the DEV-only `Diagnostics` is what surfaces them (display
  gated behind `import.meta.env.DEV`).
- ✅ Server — signaling, corrected `clientIp()`, word + token rendezvous allocation (`codeSpec`).
  **Managed-room hardening (done — 6a)** for ALL `filetransfer` rooms (`managed: true` → TTL + per-IP
  rate-limit). **Seat cap is codeType-dependent (NOT `managed`):** the 4-digit **room** rendezvous is a
  **mesh LOBBY** (`maxPeers` = `FILETRANSFER_MAX_PEERS`, default 8); the **words** AND link/qr **token**
  rendezvous are strictly 1:1 (`ONE_TO_ONE_MAX_PEERS = 2`); a joiner past the cap → 4002. The **token**
  codeType (`tokenCode`) allocates a 128-bit base64url token (`TOKEN_ROOM_BYTES=16`, `TOKEN_RE`
  validator) so link/qr rendezvous is unguessable. **TTL until connected** frees the code
  (4010 close / 4009 later): the 4-digit lobby TTL is an **idle timeout** (`ROOM_TTL_MS`, re-armed on
  each join via `makeTtlTimer`); the 1:1 words AND token TTLs stay from CREATE (`WORD_ROOM_TTL_MS` /
  `TOKEN_ROOM_TTL_MS`, no re-arm). Per-IP
  create/join rate-limit unchanged (`IP_RL_MAX` / `IP_RL_WINDOW_MS`, 4011, loopback-exempt), creator
  destroy. `clipboard` mesh opts out. **TURN creds (6d, server side — done):** `turn-request` →
  `turn-credentials` mints short-lived HMAC coturn creds (`use-auth-secret`; `TURN_SECRET` shared with
  coturn + never sent to clients; empty-urls when unconfigured → direct-only); env `TURN_SECRET` /
  `TURN_URLS` / `TURN_CRED_TTL_S`. Ready for deployment behind nginx + a separately-deployed coturn
  (`deploy/coturn.conf.example`).
  (`tests/integration/{room,word-room,turn-credentials}-server` — see `room-server.test.ts`,
  `word-room-server.test.ts`, `turn-credentials.test.ts`.)
- ✅ `src/ui/zxingWasm.ts` — self-hosted QR-scan WASM (step 6e): `createQrDetector` lazily imports
  the `barcode-detector` ponyfill and `setZXingModuleOverrides({ locateFile })` it to a Vite `?url`
  asset (`zxing-wasm/reader/zxing_reader.wasm?url`, fingerprinted into `dist/assets`, same-origin)
  so the fallback decoder never fetches from a CDN. `zxingWasm.test.ts` proves the wired `locateFile`
  resolves to `'self'`, never jsdelivr/fastly. ScanScreen consumes it.
- 📋 Pending: step 6 — **6d DONE**; **6e no-device parts DONE** (self-hosted QR WASM +
  feature-detection review + **cross-ENGINE e2e**: `tests/e2e/interop.spec.ts` launches two real
  browsers per test and runs link-pairing + a hashed transfer across chrome/firefox/webkit in both
  directions — run it with `E2E_SIGNALING_PORT=… npx playwright test`, engines absent from the host
  skip with a printed reason; the WHOLE suite also runs per engine as its own project —
  chromium/firefox/**webkit** 33/33 each (count as of 2026-09-12) — where **webkit needs
  `E2E_STUN_URLS` on a headless host**:
  it cannot disable mDNS obfuscation, so without a STUN server its only host candidate is
  `<uuid>.local` and two of its tabs never pair. plus a `mobile-webkit` project (WebKit + the iPhone device descriptor) that is the ONLY place the
  UA-selected mobile receive cap runs, and an opt-in size ladder, `tests/e2e/limits.spec.ts`); **6f LIVE** — deployed + externally verified at hushsend.frelikh.dev
  (coturn same-host `turn:`-only :3478; signaling = separate repo under systemd; see DEPLOY.md § 0);
  remaining: in-browser P2P/SAS/transfer on two devices + cross-network TURN relay (6e real-device,
  post-deploy) — the pass is planned case-by-case in **TESTPLAN.md** — plus nice-to-haves, tracked in
  **BACKLOG.md**.
- 🔒 **SECOND audit pass, 2026-09-12 — fully malicious server. Three complete breaks found and
  FIXED**, plus a persistent pre-auth hole: (1) SAS **certificate grinding** — the commit covered only
  the nonces, so a relay could grind its own certificates after both nonce exchanges and make both
  humans read the SAME phrase (reproduced in 4.25 s); fixed by holding every nonce reveal until the
  fingerprints are pinned (`maybeRevealSasNonce`). (2) **Server-chosen roles** — both `pairingRoleFor`
  and `sasRoleFor` ordered server-assigned ids that appear in no transcript, so the server could make
  both peers the blind picker; the SAS split now comes from the SAS material (`sasReaderIsFpMin`).
  (3) **Re-entrant `welcome`** flipped `this.role` mid-handshake, turning key-confirmation's role label
  into a tag-reflection oracle (words without the words, link/qr without S); `onWelcome` is now
  once-only. (4) **Enrollment ran pre-auth**, planting pins and leaking the long-term identity key;
  now gated on `established` with a held-and-replayed frame and first-write-wins pinning. Also: three
  DEV knobs that shipped live are gated, the RECEIVE side of the no-bytes gate is closed, SDP-embedded
  relay candidates are stripped, renegotiation after channel-open is refused, the step-1
  unauthenticated path is deleted, protocol strings are length-bounded, the 1:1 confirm path got its
  own liveness deadline, and the SAS refusals carry the same weight as the confirms. Regressions in
  `SessionController.auditFixes.test.ts` + `sasRole.test.ts` + `relax.test.ts`. Full write-up and the
  two items left open (path attestation; blinded `pairingId`) in **BACKLOG.md § Security audit /
  Second pass**.
- 🔍 **Internal security-audit pass done 2026-09-12** (reasoning + code review, no devices): the
  reconnect create/join role and the `peerLeftAbortsPairing` narrowing both hold (with sharper
  arguments now recorded); the **Max-privacy strict relay claim did NOT** — a peer-reflexive candidate
  could still complete a relayed path in a mixed-privacy pair, **now fixed** by the selected-path check
  above (§ Max-privacy strict model). Verdicts, the remaining findings, and the doc corrections they
  forced are in **BACKLOG.md § Security audit**. An INDEPENDENT audit is still wanted before a public
  launch.

## Known residuals / deferred
- **`pairingId` linkability** (reconnect) — **restated after the 2026-09-12 audit; the earlier text
  named the wrong mechanism.** The id is an identifier, not a secret, and it carries no key material
  (the signature under the pinned key is what authenticates). It does **NOT** reach the relay: every
  reconnect frame rides the **DataChannel** (`sendReconnect` → `this.peer.send`, DTLS-protected) and
  `pairingId` appears in no signaling schema (`src/types/protocol.ts`). Two real residuals remain:
  - ✅ **To the untrusted server — FIXED 2026-09-12.** A reconnect pair used to be the ONLY pair that
    kept its signaling socket open for the whole session, since every other method closes it on
    `connected`. That behavioural fingerprint told the server both "these two have paired before" and
    how long the session ran — the exact thing the close exists to deny. `settleReconnect` now calls
    `closeSignalingAfterConnect` like every other settle, and the reconnect `onPeerLeft` branch moved
    to the `peerLeftAbortsPairing` gate so the `peer-left` our own close provokes cannot tear down a
    peer that has not settled yet. (`SessionController.sasPeerLeft.test.ts`; e2e `ws-close.spec.ts`.)
  - **To a code-guesser:** a reconnect session rendezvous over a plain 4-digit code and auto-pairs with
    the first joiner, so whoever wins that race receives the `reconnect-init` and learns the raw
    `pairingId` before authenticating (it cannot forge a proof — hard stop / fallback). A blinded
    announcement (`HMAC(pairingId, fp_min‖fp_max)`) would fix it. Both tracked in
    **BACKLOG.md § Security audit / Findings**.
- **Dual-pin under different pairingIds if one side loses its keystore** (reconnect). If a peer
  clears storage (or the keystore is wiped) it no longer holds the pin, so the next connect falls
  back to SAS + a FRESH enrollment → a NEW pairingId. The other side keeps the stale pin AND gains
  the new one (two pins for the same human). Benign (the fresh enrollment is itself human-verified),
  but the keystore accumulates a dead pin. Not fixed (no GC / pin-merge yet).
  (Server cap/TTL/rate-limit for 4-digit rooms is **done — step 6a**; see Signaling server §
  *Managed-room hardening*.)

## Path attestation (`src/core/pathAttest.ts`) — who is actually on the wire
Authentication answers "is this my peer?"; attestation answers **"is the traffic going to them?"**.
The audit established that no candidate filter can answer the second one: ICE credentials ride the
SDP the untrusted server relays, so it can answer our connectivity checks itself and inject its own
`typ host` candidate at its own address — and a client cannot tell that from the peer's, because the
peer's real address is only ever learned FROM the server. The relay filter (`relax.ts`) refuses
`typ relay`, which stops an honest peer's TURN path, not a server that never offers one.

So the claim moves onto a channel the attacker does not control, exactly as the DTLS fingerprint
binding already does for identity. On `established` each side sends
`{kind:'path-attest', addrs}` over the **authenticated** DataChannel (`startPathAttestation`) and
checks that the remote address ICE actually selected for it (`PeerConnection.selectedRemoteAddress`,
from `getStats()`) appears in the peer's set (`pathVerdict`). An interposer's address is in neither
peer's set, so it is named by the very peer it is impersonating. A forwarding attacker has two moves
and both are caught: pass the real addresses through (→ `mismatch`) or drop the frame (→ nothing
arrives → the 15 s deadline fails the session). A TERMINATING attacker never reaches here — the
fingerprint binding stops it at the SAS / key-confirmation step.

- **Verdicts.** `ok` (selected address attested), `unknown` (nothing to judge on — no selected
  address, or an engine that reports no usable candidates), `mismatch` (checked, and the address we
  selected is in neither of the peer's). **All three are advisory: none tears anything down.** This
  bullet used to end "`mismatch` → terminal, same teardown as an authenticity failure", which the code
  has never done — and two audits read past it because it was phrased as a specification. Corrected
  2026-09-13 (finding F4) together with the two call-site comments that claimed the attestation
  "gates file bytes".
- **Projection (changed 2026-09-13, finding F2).** The verdict now reaches the USER three-way as
  `connection.pathCheck`, not two-way. It used to be collapsed to `pathConfirmed: 'yes' | 'no'`, so
  `mismatch` — the only positive evidence of an interposer this system can produce — rendered
  identically to `unknown`, the everyday outcome on Safari, under a hint whose stated cause ("this
  browser does not expose enough to check it") is false on a mismatch. Since the DEV diagnostics that
  hold the real verdict are tree-shaken out of production, that left the detection with no
  representation anywhere a user could see it. `mismatch` now has its own label
  (`⚠ route did not match`), its own weight (`hs-badge--alert`) and its own copy, which names BOTH
  causes — honest NAT/Safari quirk, or someone carrying the connection — and gives an action, rather
  than accusing. Still projected DEV-only in full as `dev.pathVerdict` / `dev.pathSelected`
  (`path-verdict` / `path-selected` testids); the user-facing badge carries `data-path-verdict`.
- ⚠️ **ADVISORY — it does NOT tear down and does NOT gate bytes.** It was built as a control (fail
  closed on `mismatch`, gate `sendFiles`/`acceptIncoming`) and the gate was REMOVED after a
  firefox↔webkit pair on one LAN failed it reproducibly **with no attacker present**. The cause is
  structural, not a bug: WebKit cannot disable mDNS obfuscation of host candidates, so it only ever
  offers `<uuid>.local`, its peer learns its real address peer-reflexively, and WebKit therefore
  **cannot attest to the address it was actually reached on**. That is what real Safari does,
  including iOS. A control that fails closed there breaks honest transfers on a primary target
  platform — worse than the leak it closes. Measured, not assumed: with the gate in place
  `interop · firefox → webkit` failed reproducibly, and on the RE-TEST after the "wait for ICE to
  select a pair" fix it failed **intermittently, one run in two** — which is worse, not better, since
  a spurious "someone is in between" both destroys an honest transfer at random and trains the user
  to dismiss the warning that matters. Without the gate, 9/9 interop + 96/96 engine tests pass.
- **What it buys today: evidence.** The verdict is logged and projected, so the real-device pass can
  record what each engine actually reports — precisely the input needed to decide whether this can
  become a control (e.g. by having each side attest the address it SELECTED and checking that against
  our own, which inverts who needs to know what). Tracked in BACKLOG § Security audit.
- **Other limits, stated not hidden.** Address only, never the port — plenty of honest NATs vary
  the port per destination, so comparing ports would reject working connections; an attacker sharing
  the peer's IP is therefore not caught. And it rests on the peer's own view of its addresses, which
  for srflx comes from STUN — **the same operator**. An operator that both lies over STUN *and* sits
  on the path can still make the two sides agree; the way to remove that is to stop being the STUN
  provider.
- Pure halves unit-tested in `pathAttest.test.ts`; `tests/e2e/privacy.spec.ts` asserts a real pair
  reaches `ok` on every engine — `unknown` is allowed, so a broken implementation would otherwise
  look exactly like a working one.

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
| `reconnect-*` | `pendingReconnectFrame` | `onReconnectChannelOpen` (before it decides to send or wait) |

The reconnect one was missing until 2026-09-17 and cost a 120 s stall on roughly 1 CI engine-matrix
night in 5 — see BACKLOG § Third pass for the full chain, including how it was finally proved with the
DEV-only `?gateDelayMs=N` knob that makes the window deterministic.

**Corollary, learned the hard way: no branch on these paths may return silently.** A frame dropped for
a good reason and a frame never sent look identical from the outside, and both end in a deadline with
an empty log. Log which guard fired; fail closed on states that should be unreachable.

## Cross-cutting invariants
- No file bytes before the connection is authenticated (`connected` / `established`). Path
  attestation is ADVISORY and deliberately does NOT extend this gate — see § Path attestation.
- Validate every inbound signaling frame with the zod schemas (the server is untrusted).
- Secret words / link secrets never go to the server; link secrets live in the URL fragment
  and are scrubbed after read.
- All random credential material from a CSPRNG, never user-chosen.
- After `connected`, signaling closure does not tear down the live P2P connection (enables
  long transfers and future reconnect). The client goes further and **closes its own signaling socket
  on `connected`** — for the **1:1 methods AND a connected room/SAS pair** (per-pair, no "seal room"
  needed: a room is N independent 1:1 pairs and the close is WS-only, so the room survives + unrelated
  pairs are untouched) — so the untrusted server never learns the session duration; room presence is
  decoupled from P2P liveness — a post-connect `peer-left` is ignored (liveness = DataChannel/ICE).
  See **§ Signaling WS lifecycle**. Reconnect closes its socket too (since 2026-09-12) — no method is
  exempt any more.
