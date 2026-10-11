# CLAUDE.md sections retired on 2026-10-11

Moved out of CLAUDE.md on 2026-10-11, when it became a short guide pointing at one file per topic.
Dated records, not maintained — the current state is in the living documents (see [README.md](README.md)).
They duplicated documents that own the subject: the signaling server's internals are hush-signaling-server's
(its README, `.env.example` and the header comments of `signaling-server.js`); the deployment knobs are
[deploy/DEPLOY.md](../../deploy/DEPLOY.md); the known limits are [COMPATIBILITY.md](../../COMPATIBILITY.md)
and [THREATMODEL.md](../../THREATMODEL.md) § 6.

## The old "Keep this file in sync" rules
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
- **the signaling server is a SIBLING REPO** (`hush-signaling-server`, next to this one — the only
  copy) and its running checkout is `/var/www/hush-signaling-server`. A protocol change lands in both
  repos in the same pass, the devDependency pin here is bumped so the e2e runs against it, and the
  deploy order goes in the commit message. `.env.example` there lists every var the code reads; its
  README / CLAUDE.md / `deploy/DEPLOY.md` are the source of truth for server internals, the TURN relay
  (`deploy/turn/`) and their tests — § Signaling server below is the client-facing summary. STUN is
  the third repo, `hushsend-stun-server`.
Stale markers (e.g. a finished step still marked 🚧, or a built module missing from the
inventory) cause real rework for the next session. Treat doc drift as a bug.

## Signaling server (sibling repo `hush-signaling-server`)
Self-contained Node + `ws`; PURE signaling, never carries file data. Already corrected:
`clientIp()` reads `X-Real-IP` (set by nginx), not the client-controllable leftmost
X-Forwarded-For; binds to `127.0.0.1` (only the local nginx reaches it). Run with
`TRUST_PROXY=1` behind nginx.
- Frontend (static `dist/`) and the WS share one host behind nginx; nginx must set
  `proxy_set_header X-Real-IP $remote_addr;` and proxy the WS (e.g. `location /ws`) to
  `127.0.0.1:8080`. Client connects to `wss://<host>/ws?app=filetransfer&…`.
- **Lobby roster protocol (step 6c)**: `welcome.peers` and `peer-joined` carry the room roster as
  `{id, joinedAt}` (was a bare id / `{peerId}`); the server **stamps `joinedAt` on its own clock**.
  `peer-left` is unchanged (`{peerId}`). The client validates the shape with zod (`peerInfoSchema`)
  before it reaches the store. Used only for the room mesh-lobby roster UI. **No `device` label any
  more (removed 2026-09-27, owner's decision):** it was a coarse `Desktop`/`Mobile` the client sent as
  `?device=` and the server capped and relayed — and since the 2026-09-26 redesign no screen showed
  it, so it was metadata handed to the untrusted server for nobody. The client no longer sends it; the
  server neither reads nor relays it (an old client's `?device=` is ignored); a not-yet-updated server
  that still sends `device` is harmless — zod strips the unknown key. Same change in
  `hush-signaling-server`.
- **codeType allocation (`codeSpec`)**: the server resolves a per-connection `codeType` to a
  validator + allocator. THREE codeTypes for `filetransfer`: **''** (default, 4-digit `code`/`allocate`
  — the ROOM method); **`word`** (server keeps its own EFF short #2 copy, allocates a rendezvous word
  via the same collision-retry loop, validates membership on join — the WORDS method); **`token`** (a
  128-bit base64url token, 22 chars, validated by `TOKEN_RE` strict format/length — the link/QR
  method AND the codeless reconnect). **Token rooms are JOIN-OR-CREATE** (`tokenCode.joinMayCreate`,
  since 2026-09-25): the client takes a token (`room=<token>&codeType=token`) and the first arrival
  opens the room, exactly like the second finds it — so the server cannot tell a link/QR meeting from
  a reconnect, nor which side initiated. (`create=1&codeType=token` still allocates one server-side,
  compatibility only.) The client selects via `?codeType=word` / `?codeType=token`. Word/token rooms
  expire on TTL or cap-reached; freed words return to the pool.
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
    closes their sockets (**4010**), and FREES the code (a later 4-digit/word join → **4009 `'room not
    found'`**; a token is simply taken again), via the extracted `makeTtlTimer(key, ttlMs)` (unref'd).
    Armed whenever a managed room COMES INTO BEING (`created` — a CREATE, or the first arrival at a
    join-or-create token). The **4-digit lobby uses an IDLE timeout** (`ROOM_TTL_MS`, default
    **180000** ~3 min): **re-armed on every JOIN** (only when `cfg.managed && !is1to1`), so an
    actively-joined lobby lives while a stale one expires. The **1:1 words AND token rooms arm their
    TTL once and NEVER re-arm** (`WORD_ROOM_TTL_MS` / `TOKEN_ROOM_TTL_MS`, default 180000) — a re-arm
    would let an attacker keep a 1:1 room alive by rejoining (for words it would also defeat the
    guessing bound). A reconnecting client waiting alone re-takes its token every 2 min itself. All env-overridable. The creator may
    also tear down early via `{type:'destroy'}`
    (reason `'destroyed'`). After `connected`, closing signaling does NOT drop the live P2P channel —
    the TTL only bounds the pre-connection rendezvous window (client treats the close as benign once
    `established`).
  - **Per-IP create/join rate-limit** — UNCHANGED. Fixed window keyed on `clientIp()`: `IP_RL_MAX =
    60` attempts per `IP_RL_WINDOW_MS = 60000` (both env-overridable). Over budget → close **4011 `'too
    many attempts'`** (counts failed joins too, so it bounds enumeration of the 10k space). **Loopback
    is EXEMPT** (`127.0.0.1` / `::1`) — behind nginx a real client always arrives via `X-Real-IP` and
    never looks like loopback, so the local proxy / dev / e2e are never throttled. Defense-in-depth
    only; SAS / key-confirmation are what actually stop a MITM. (hush-signaling-server `tests/room-server.test.ts`.)
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
    (`MAX_CONNS_PER_IP` 4006, `IP_RL_MAX` 4011). (hush-signaling-server `tests/room-server.test.ts`.)
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
  `total-quota` / `max-bps`, anti-SSRF `no-multicast-peers` + `denied-peer-ip` on 0.0.0.0/8, loopback,
  RFC1918, link-local and IPv6 ULA, UDP relays only (`no-tcp-relay`), `fingerprint`, `no-cli`, logging
  off) in hush-signaling-server
  **`deploy/turn/turnserver.conf.template`**, rendered by its `deploy/turn/install.sh` with the secret
  taken FROM the signaling `.env` (so the two copies cannot drift). The client
  side (the functional toggle, `requestTurnCredentials`, feeding `iceServers`, Max-privacy never
  requests) is **done** — see **Privacy mode + ICE** §. **Max-privacy is STRICT** — a live Max-privacy
  ICE failure does NOT escalate to relay; it fails terminally with a switch-to-Reliable hint (see
  **Max-privacy strict model** there). (hush-signaling-server `tests/turn-credentials.test.ts` for the mint;
  `tests/turn-relay.test.ts` there for the mint ACTUALLY opening a relay on a real coturn —
  the `TURN_SECRET` == `static-auth-secret` invariant, with a wrong-secret negative control.)

## Deployment / configuration (step 6f — LIVE at hushsend.frelikh.dev, deployed 2026-06-20)
One place that ties together every knob needed to run a live instance. The **artifacts** are built
and committed — `deploy/nginx.conf.example` and the step-by-step `deploy/DEPLOY.md` here; the server
env (`.env.example`) and the TURN relay (`deploy/turn/`) in hush-signaling-server; the STUN server in
hushsend-stun-server; the only code change for 6f is an **additive startup
`[config]` summary log** (no secrets) in `signaling-server.js`. The live deploy itself (nginx/coturn/
DNS/TLS on real hosts) is ops — these are what it consumes. Config lives in three layers:
- **Client build-time (`VITE_*`, baked by Vite — no runtime client config):** `VITE_SIGNALING_URL`
  (the `wss://hushsend.frelikh.dev/ws` the client opens — nginx proxies `/ws` → Node) and
  **`VITE_STUN_URLS`** (coturn STUN endpoint(s)). **`VITE_STUN_URLS` is REQUIRED for a real deploy** —
  Max-privacy (the default) is STUN-only, so with it empty two cross-network peers have no ICE server
  and never connect (loopback tabs hide this in dev). Changing either means a **rebuild**, not an
  nginx edit; `VITE_SIGNALING_URL`'s host must match the CSP `connect-src` in the nginx template.
- **Server env (hush-signaling-server `.env.example`):** `HOST`/`PORT` (loopback `127.0.0.1:8080` behind nginx),
  **`TRUST_PROXY=1` (mandatory behind nginx)**, TURN (`TURN_SECRET` / `TURN_URLS` / `TURN_CRED_TTL_S`),
  and the tunable caps/TTLs/rate-limits (`MAX_CONNS_*`, `FILETRANSFER_MAX_PEERS`, `ROOM_TTL_MS` /
  `WORD_ROOM_TTL_MS` / `TOKEN_ROOM_TTL_MS`, `IP_RL_MAX` / `IP_RL_WINDOW_MS`, message-rate knobs). **`TRUST_PROXY=1` +
  nginx `proxy_set_header X-Real-IP $remote_addr;` are a pair and the #1 footgun:** without both,
  `clientIp()` sees only loopback → per-IP caps collapse onto one bucket and the 4011 rate-limit
  (loopback-exempt) silently disables. **Shared-NAT note:** clients behind one public IP divide
  `IP_RL_MAX` per window → raise it for office/CGNAT deploys (defense-in-depth only — SAS stops a
  MITM). The startup `[config]` log echoes the effective values (TRUST_PROXY, TURN configured/count,
  caps, TTLs, IP_RL_MAX) **without secrets** — eyeball it after each restart.
- **coturn as TURN (hush-signaling-server `deploy/turn/`; MAY be a separate host — the live deploy runs it on the
  SAME host, `turn:`-only on `:3478`, no `turns:`/5349):** `static-auth-secret` **MUST EQUAL** the
  server's `TURN_SECRET` (the one shared secret; coturn recomputes the HMAC offline). Empty
  `TURN_SECRET` ⇒ relay disabled ⇒ clients stay direct-only (a valid config). Open the firewall for
  3478 udp/tcp (5349 tls only if you enable `turns:`) and the relay-port range.
- **Cross-dependencies:** `TURN_SECRET` == coturn `static-auth-secret`; `VITE_STUN_URLS` names
  hushsend-stun-server (`stun.hushsend.frelikh.dev:3479`, since 2026-10-10) and `TURN_URLS` the TURN
  relay's coturn — two coturn instances, still on the same host (DNS: `hushsend.frelikh.dev` → web
  host, `turn.hushsend.frelikh.dev` → the TURN coturn, `stun.hushsend.frelikh.dev` → the STUN coturn). **CSP must be verified against the built app — especially the QR-scan path** (zxing WASM
  needs `'wasm-unsafe-eval'` to COMPILE on iOS/Firefox; the WASM itself is **self-hosted** since step
  6e — vendored into `dist/assets`, served from `'self'` — so `connect-src` is `'self' wss://<host>`
  only, **no CDN**; camera needs `Permissions-Policy: camera=(self)`); see the CSP comment block in
  `deploy/nginx.conf.example` and the smoke-test gotcha in `deploy/DEPLOY.md`. **See `deploy/` for the
  templates + runbook.**

## Known residuals / deferred
- **iOS Safari ends the WebRTC connection when the screen locks (measured 2026-10-03, iPhone 15 / iOS
  26.6, TESTPLAN F1).** An 800 MB receive stopped at 14 % the moment the phone locked; ICE went
  `disconnected` in ~7 s and `failed` ~10 s later, and both sides showed "Connection lost" — the loss
  path works, but a receive on an iPhone survives only while the screen stays on (the Pixel 5 ran on
  under its lock). Mitigated for the idle-timer case by the Screen Wake Lock requested inside the
  Accept / Send tap ([transfer.md](../architecture/transfer.md) § File transfer, live `bf485ae`, verified: 3 GiB with Auto-Lock 30 s). **Not mitigable:
  a deliberate lock, or switching apps — measured 2026-10-03, Home for 30 s ended the connection within
  ~15 s** — so the transfer screen says to keep the screen on and stay on the page. Recorded here so it does
  not quietly disappear (owner, 2026-10-03).
- **`pairingId` — the pairing secret (restated 2026-09-25).** Earlier text called it "an identifier,
  not a secret"; that stopped being true on 2026-09-18 (the blinded announcement was keyed by it) and
  is the opposite of true now: the codeless reconnect derives the rendezvous token and the hello MAC
  from it. It is 16 CSPRNG bytes minted over the authenticated channel at enrollment, lives only in
  the two keystores (IndexedDB — see the private-key storage limitation in `keystore/types.ts`; an
  XSS or a hostile extension that can read pins can read it), reaches no signaling schema, and is
  never announced: the old code-guesser residual ("whoever wins the 4-digit race learns the
  pairingId") is **closed structurally** — there is no 4-digit reconnect room and nothing on the
  channel carries the id. Two small residuals remain, both stated in `crypto/reconnect.ts`:
  - **Within one 10-minute bucket the token is the same**, so two reconnect attempts in the same
    bucket show the server the same room name (it already sees the same IPs and timing). Across
    buckets nothing links.
  - **Clock skew between the two devices delays the meeting** by up to the skew (each side re-takes
    the rendezvous at its own boundary); skew of more than a bucket needs the 10-minute wait to
    absorb it. Not a security property — a stranger cannot compute a token for any bucket.
- **Dual-pin under different pairingIds if one side loses its keystore** (reconnect). If a peer
  clears storage (or the keystore is wiped) it no longer holds the pin, so it cannot derive the
  rendezvous: a Reconnect tap on the other side ends in "did not show up" (there is no in-band SAS
  fallback any more — the copy says to pair afresh by any method). That fresh pairing runs a FRESH
  enrollment → a NEW pairingId; the other side keeps the stale pin AND gains the new one (two pins
  for the same human). Benign (the fresh enrollment is itself human-verified), but the keystore
  accumulates a dead pin, and the recent-devices row keeps pointing at the freshest one, which is
  the one both sides share. Not fixed (no GC / pin-merge yet).
  (Server cap/TTL/rate-limit for 4-digit rooms is **done — step 6a**; see Signaling server §
  *Managed-room hardening*.)
- **A received file stays briefly in the site's private storage (OPFS path, 2026-09-27) — since
  2026-09-28 only where the stream path does not apply** (Firefox, Safari, mobile browsers, a worker
  that would not come up). It has to: the download reads it from there. A delivered file is removed
  `OPFS_HOLD_MS` (10 min) after the download started; a failed, cancelled or never-saved one at once;
  one whose tab closed first stays until hushsend is next opened (`sweepIncoming`). It is the same bytes
  the user was just given, in a folder only this site can read — but it is a copy on disk that outlives
  the tab by up to that long, where the RAM path left nothing. The owner chose it over RAM
  (2026-09-28). Stated in THREATMODEL.
- **A service worker exists on the origin while a file is received on desktop Chromium (2026-09-28).**
  The download worker (`public/dl/sw.js`): scope `/dl/` only, so it can never control or intercept the
  app's pages or assets; it answers only `/dl/<id>` for a stream a same-origin page registered, holds
  nothing and fetches nothing; registered per offer, unregistered 60 s after the download, swept at
  start. A compromised server could ship a hostile `sw.js` — as it could a hostile bundle, from the
  same origin; the added risk (persistence) is bounded by the scope and by the unregistration. The
  bundle manifest and the attestation cover `dl/sw.js` like every other file in `dist/`.
- **Firefox gets no stream path until its download failure is safe (2026-09-28).** See File transfer:
  an aborted stream stalls its download, a dead worker completes a truncated file. Re-measure on a
  new Firefox before enabling it — abort a stream mid-download, and stop the worker mid-download, and
  check what the downloads folder is left with (TESTPLAN, 2026-09-28 entry).
- **A lost channel ends the session — nothing resumes it (2026-09-27).** A drop the engine does not
  recover from by itself (Chrome goes `failed` ~10 s after `disconnected`) is terminal: there is no ICE
  restart (it would need the signaling socket, which is closed on connect by design) and no transfer
  resume. The user reconnects and sends again. Two measured edges of the loss path: on Chromium a
  SENDER that closes its tab mid-send is noticed only after ~16 s, the ICE timeout, although its
  `pagehide` goodbye runs (a closing receiver is noticed in 41 ms; Firefox and WebKit notice both in
  under a second) — likely the goodbye queues behind the data still in flight, not established; and on
  the File System Access path an
  aborted receive can leave an EMPTY file where the save picker pointed — seen on Android 2026-09-27
  (0 bytes, twice, after the connection died under the picker); desktop Chrome not checked. The partial
  data is discarded (`writable.abort()`); deleting the file itself was ruled out — the picker may have
  pointed at an existing file the user meant to replace.
