# Connection methods (4)

Part of the architecture reference — [README.md](README.md) is the index.

All four resolve to the same FSM and the same DataChannel transfer; they differ only in how
peers rendezvous + authenticate.

## Per-pairing role (initiator/responder) — by readable-id order
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
PROTOCOL role (who proves first / `lv(role)` in the reconnect transcript) is derived from the **DTLS
fingerprints** (`crypto/reconnect.ts` `reconnectRoleFor`: the smaller fingerprint is the initiator =
the verifier-first side), independent of `this.role` — there is no creator any more (the codeless
reconnect is symmetric), and the readable ids are the server's to choose; the fingerprints are not
(a MITM presenting its own fails the channel binding regardless). Changed 2026-09-25, from
create/join. This per-pairing-role pass is the foundation for the
**Room lobby** (below), which is now built (step 6): the room method no longer auto-pairs — the human
picks whom to pair with, and the per-pairing role lets ANY pair (incl. joiner↔joiner) raise a correct
1:1 channel. words/link/qr still auto-pair 1:1 with the single peer.

## Room lobby (mesh — roster + pick) — done (step 6)
The 4-digit room is a **mesh LOBBY**, and the client now exposes it: the room method NO LONGER
auto-pairs. **Both the creator AND every joiner land in `awaitingPeer`** (a joiner takes the new
`joining → awaitingPeer` transition — no new FSM state) and see the same `LobbyScreen`: the shareable
4-digit code + a **roster** of everyone else in the room, each with a **Connect** button. The human
PICKS whom to raise a 1:1 channel with.
- **Roster projection**: `connection.roster: PeerInfo[]` (`{id, joinedAt}` — the coarse `device` label
  was removed from the protocol 2026-09-27, see [claude-md-retired-sections.md](../history/claude-md-retired-sections.md) § Signaling server), maintained by the
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
  the `awaitingPeer` view of the room method only; **reconnect** is its own method (`ReconnectWaitScreen`)
  and **auto-pairs** 1:1 at a derived token room — it never touches the lobby, so "reconnect-in-lobby"
  is moot (superseded 2026-09-25). **words/link/qr are NOT lobbies** — they auto-pair 1:1 with the single peer (only `peers[0].id` is read from the new welcome
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

## words method (finalized)
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
  does NOT weaken the bound — every actual guess (tag comparison) is still counted. See [connection.md](connection.md) § Signaling
  WS lifecycle. On reaching the
  cap or if a server-side TTL (**WORD_ROOM_TTL_MS = 180000**, ~3 min) expires **before**
  `connected`, the word-room is invalidated → invalidates the rendezvous. After `connected`,
  TTL does NOT tear down the already-authenticated P2P connection; the client closes signaling
  itself on `connected` (1:1 privacy — server learns no duration) and the DataChannel persists,
  allowing long transfers (10GB+ at typical speeds may exceed 3 min).
  A counts attempts and can manually regenerate (fresh 5 words, new room). This bounds online
  guessing: ≤10 tries × ~2 per guess ≈ 2^4 vs 2^41 secret space.
- Server: word-rooms cap at **2 peers max** (creator + one joiner; 3rd joiner bounced with
  `4002 'room full'`). This serializes guesses and ensures the room is 1:1.

## room method (SAS) — done
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
  below; tested in hush-signaling-server `tests/room-server.test.ts`.

## link / qr method (finalized — 5b)
A high-entropy ONE-TIME secret in the URL fragment authenticates the channel directly — **no PAKE,
no SAS, no human comparison, no reader/picker**. (The full-entropy secret is not offline-guessable,
so a PAKE is unnecessary; the secret authenticates by itself, so a SAS is unnecessary.) link and qr
are the SAME path — qr only renders/scans the same link. Lives in `src/core/link/link.ts` (pure:
generate / build / parse) + the link/qr branches in `SessionController`; no new FSM states.

- **Secret S**: `LINK_SECRET_BYTES = 16` CSPRNG bytes (128 bits), base64url-encoded, never
  user-chosen. It is the key-confirmation IKM and **never reaches the server**.
- **Rendezvous**: a **high-entropy token** (`codeType=token`) — the CLIENT draws a 128-bit CSPRNG,
  base64url, 22-char token (`link.ts` `generateRendezvousToken`) and TAKES that room on the server
  (**token rooms are join-or-create since 2026-09-25** — the first arrival opens the room; the
  server-side `create=1` allocator, `tokenCode.allocate`, is kept only for compatibility), NOT the
  4-digit room. The link already carries the rendezvous, so a high-entropy token costs nothing in UX
  while making the rendezvous **unguessable**: a stranger can't enumerate/squat a token room the way
  the 10k 4-digit space can be scanned, so interloper-resistance is **structural** (the old link/qr
  lobby-race is closed by construction, not just by rate-limit). Public routing only. The **room
  method keeps the 4-digit code; words keeps its word**. The codeless reconnect uses the SAME shape
  (a token derived from the pairing secret, taken join-or-create), so the server cannot tell a
  reconnect from a link/QR meeting, nor which side of a link initiated.
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
- **Flow** (maps onto existing states, no new ones): A takes its token → `awaitingPeer` shows the link
  (creator only; surfaced as `credential[0]`, same as words surfaces its secret words) → `peer-joined`
  → at pairing start the WebRTC **initiator is the smaller readable id** (see **Per-pairing role**;
  either side may offer, not necessarily the creator) → DTLS → key-confirmation over S → `connected`.
  (`creating`/`joining` → `pairing`[DTLS] → `confirming`[S key-confirm] → `connected`|`failed`.)
- **Liveness (link, QR and words alike)**: ONE client deadline, 120 s (`preSasTimeoutMs()`, the same
  DEV override as the SAS window), runs from pairing start through key-confirmation —
  `SessionController.armConfirmTimeout`, armed in `beginPairing`. Until 2026-10-11 it armed only once
  the DataChannel was open, so a peer that never answered the offer left the other side waiting for the
  untrusted server's room TTL (measured: ~165 s on "Agreeing on keys…", docs/test-runs/2026-10-11.md).
  A stall before the channel ends as "the connection did not come up in time"; after it, as "peer did
  not complete key confirmation in time". A PeerConnection that cannot be brought up fails the pairing
  at once (`launchPeer` → `onPeerStartFailure`, through the method's own teardown); without WebRTC in
  the browser the reason is `WEBRTC_UNAVAILABLE_REASON` — and the app does not get that far, it shows
  "This browser can't send files" up front (`core/webrtc/available.ts`, App.tsx).
  `SessionController.pairingDeadline.test.ts`; e2e `link.spec.ts` (the no-WebRTC joiner).
- **One-time / replay**: the link/QR is for ONE connection; the token room is session-scoped (TTL +
  per-IP rate-limit — the managed-room hardening — see § room method → *Server cap / TTL / rate-limit*).
  The token room is **strictly 1:1** (`ONE_TO_ONE_MAX_PEERS = 2`, like words), NOT the 4-digit lobby:
  the unguessable token keeps strangers OUT structurally, and the cap-2 guarantees a **single
  receiver** even if the link is forwarded (a 2nd joiner is bounced **4002 `'room full'`**; S would
  also fail key-confirmation for it — defense in depth). Its TTL is armed **from CREATE** and never
  re-armed (`TOKEN_ROOM_TTL_MS = 180000`, the natural pre-connect wait of a 1:1 link). Replay is closed
  by a fresh DTLS cert per session **plus** S being single-use (scrubbed after read).
- **Fragment scrub**: the joiner reads `location.hash` on page load, extracts the token + S, **scrubs
  the fragment immediately** via `history.replaceState` (before any await — see `LinkFragmentJoin`
  in `App.tsx`), and sends only the token to the server (`join`, `codeType=token`). A link opened into
  a tab that ALREADY shows hushsend is a same-document navigation (only the fragment differs), so
  `LinkFragmentJoin` also listens to `hashchange` (since 2026-09-29): scrub at once whatever the state,
  join from `idle` or a finished `failed` session, and never tear down a session in progress or a live
  channel for it — there the link is dropped (`link.spec.ts`, three cases). A malformed/absent
  fragment is a no-op (stay home); a valid-but-dead link surfaces as the "room not found" failure the
  moment the joiner finds the token room EMPTY (`onWelcome`: token rooms are join-or-create, so the
  server no longer says 4009 — but the sender always opens the room before the link exists, so
  "nobody here" means expired/used; `link.spec.ts` "dead link"). `parseLink` validates strictly (token = `RENDEZVOUS_TOKEN_LEN`=22 base64url chars, S decodes
  to exactly 16 bytes) — the input is attacker-influenced; an old 4-digit-style code is now rejected.
- **qr**: the SAME link, rendered to an SVG QR locally (`src/ui/qr.ts`, `qrcode`); the joiner SCANS
  it with the camera (`getUserMedia` + the `barcode-detector` ponyfill — always the **self-hosted**
  zxing-wasm via `src/ui/zxingWasm.ts`, lazily imported — since 2026-10-03 only where the browser has no
  native `BarcodeDetector` for QR; Chrome uses its own, with a runtime fallback to zxing, [qr.md](qr.md) § QR) → decodes to the link →
  same join path. Camera denial/absence falls back to a **paste-the-link** input (also the
  deterministic e2e injection point). The zxing WASM is served from our own origin, not a CDN — see [qr.md](qr.md) § QR.
- **Enrollment**: TOFU pinning runs after `connected` exactly as for words/room (method-agnostic),
  so link/qr pairs can later reconnect.
