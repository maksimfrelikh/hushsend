# Follow-ups, ops and housekeeping, 2026-09 – 2026-10

Dated records, moved out of BACKLOG.md on 2026-10-11 when it became a list of open work only. Each entry
was true on its date; the current state is in the living documents (see [README.md](README.md)).

## Security / correctness follow-ups (small)

- ✅ **Dead third-party STUN fallback removed from the bundle — DONE (2026-09-12).** `PeerConnection.ts`
  carried `DEFAULT_ICE_SERVERS = [{urls:'stun:stun.l.google.com:19302'}]` behind
  `this.config.iceServers ?? DEFAULT_ICE_SERVERS`. It was **unreachable** (the sole call site,
  `SessionController.startPeer`, always passes `buildIceServers()`'s array), but it still shipped as a
  literal string in `dist/assets/*.js` — spotted in a bundle audit during the home-server deploy
  (2026-08-16) and left as tech debt. Now `PeerConfig.iceServers` is **required**, the constant is gone,
  and the constructor's `config: PeerConfig = {}` default was dropped with it — so a missing ICE config
  is a compile error instead of a silent fall back to a third party. Behaviour is unchanged (the single
  call site already passed `buildIceServers()`'s array); the only observable difference is the Google
  host string no longer appearing in a built bundle. Verified on the box (Node 22, throwaway copy):
  `tsc --noEmit` clean, eslint clean, **184 vitest tests green** (159 unit + 25 integration).
  ✅ **Verified after the 2026-09-12 redeploy:** `grep -r 'stun.l.google' /var/www/hushsend/dist`
  returns nothing — the live bundle no longer carries the third-party host string.
- ✅ **Close the signaling socket on connect (per-pair: 1:1 methods + room/SAS) — DONE.** For `words` /
  `link` / `qr` AND a connected `room`/SAS pair the client closes its OWN signaling socket the instant it
  reaches an authenticated `connected` (`SessionController.closeSignalingAfterConnect` — from
  `tryVerifyConfirmation` for 1:1 key-confirmation, from `trySasSettle` for room/SAS; a side-effect on
  entering `connected` — no new FSM state, gated to the `connected` success branch so failure paths are
  untouched; **reconnect included since 2026-09-12** — it was the last exemption, see § Security
  audit). By then signaling has no job left (ICE/SDP exchanged, key-confirmation / SAS-confirm +
  enrollment ride the DataChannel), so the **untrusted server
  learns no session duration** — it sees only the short pairing window, then both peers vanish. The close
  is **WS-only** (no room-destroy / leave frame), so for the room mesh the server just drops the leaver +
  notifies the rest — the **room survives** and **unrelated pairs are untouched** (no "seal room" step
  needed: a room is N independent 1:1 pairs). Each side closes independently (no coordinating signal —
  key-confirmation / SAS-confirm is mutual). **Liveness was decoupled from room presence:** the
  `peer-left` each close generates on the other side must not drop / fail / bounce a connected (or
  about-to-be-connected) peer, so `src/core/livenessGate.ts`
  `peerLeftAbortsPairing(established, channelOpen)` aborts a pairing ONLY before the DataChannel transport
  is up (after that, liveness = DataChannel/ICE, and a real abort is caught by `onChannelClose`) — and the
  **SAS `onPeerLeft` branch now uses this same gate** (was a bare `!established`), closing the
  cross-channel `peer-left`-vs-`sas-confirm` race. **Guess-protection (words) is NOT weakened** — every
  actual guess is counted by the confirmation-mismatch / channel-close paths; `peer-left` is the sole
  counter only pre-transport, which the gate still catches; SAS has no guess budget at all. Unit:
  `livenessGate.test.ts` (arm/disarm boundary) + `SessionController.sasPeerLeft.test.ts` (SAS branch gate
  + room per-pair close + reconnect, included since 2026-09-12). e2e: `tests/e2e/ws-close.spec.ts`
  (link + words + reconnect —
  supersedes the old `words-ttl.spec.ts`), with `room-sas.spec.ts` / `lobby.spec.ts` confirming room/SAS
  + lobby behaviour under the per-pair close. See [connection.md](../architecture/connection.md) § Signaling WS lifecycle.
- ✅ **SAS fail-closed on unset role — DONE** (folded into the mesh-lobby fix). The SAS role is no
  longer a UI default — it is computed PER PAIRING from the two readable ids (`src/core/sasRole.ts`
  `sasRoleFor`: lexicographically smaller id reads), projected as `connection.sasRole`. When the role
  is unresolved (`null` — a missing id), `SasScreen` renders an explicit **"restart verification"**
  screen, NEVER a functional blind picker. This both fixes the joiner↔joiner "two pickers" lobby case
  and closes the original fail-closed concern. (`sasRole.test.ts`; e2e resolves the reader by id.)
- ✅ **High-entropy rendezvous for link/QR — DONE** (pre-deploy). The 4-digit room is replaced by a
  128-bit CSPRNG **token** (`codeType=token`) carried in the link (no UX cost — the link already
  carries the rendezvous). Server: third codeType beside the 4-digit room + word — `tokenCode`
  (allocator = `randomBytes(16)` → base64url, 22 chars; validator = strict `TOKEN_RE`), strictly 1:1
  (`ONE_TO_ONE_MAX_PEERS = 2`, like words), managed with a from-create TTL (`TOKEN_ROOM_TTL_MS`).
  Client: link/qr request `codeType=token`; `buildLinkUrl`/`parseLink` build/validate `<token>.<S>`
  (`RENDEZVOUS_TOKEN_BYTES`); S + the key-confirmation-over-S auth flow are UNCHANGED. Eliminates
  4-digit squatting/enumeration for link/QR — resistance is now structural. room stays 4-digit, words
  stays `word`. Tests: `room-server.test.ts` (token alloc / validator / 1:1 cap), `link.test.ts` +
  `qr.test.ts` (token round-trip), `link.spec.ts` (link/qr e2e over token rendezvous). This is the
  SAME fix as "link/qr lobby-race resistance" above. (See [methods.md](../architecture/methods.md) § link/qr method + [claude-md-retired-sections.md](claude-md-retired-sections.md) § Signaling server.)

(✅ **Pre-SAS pairing deadline firing-direction — now tested** (pre-deploy cleanup): `?stallSasNonce=1`
makes a peer reach the SAS but withhold its nonce reveal, `?preSasTimeoutMs=N` shrinks the pre-SAS
deadline (both DEV-only / tree-shaken), and `tests/e2e/room-sas.spec.ts` asserts the other side fails
at the deadline rather than hanging. See [methods.md](../architecture/methods.md) § room/SAS Timeouts.)

## Ops / housekeeping

- ✅ **Screenshot baselines for the 2026-09-28 screen changes are recorded — DONE 2026-09-28, on the
  deploy host.** 8 new (`sas-reader-waiting`, `home-forget-confirm`, `failed-server`,
  `transfer-path-relayed`, phone × 2 themes each) and 26 re-recorded (every failure variant lost its
  eyebrow and its repeated reason line: `failed-compromised`, `-direct` ×6, `-generic`, `-noshow`,
  `-relay`, `-room`, `-words`, `key-changed` ×6, `sas-restart`). A compare-only run at `673509d` failed
  exactly those 34 and nothing else — the lobby scenes did not move, since the device label had never
  been rendered, only carried. Recorded with `--update-snapshots=changed` (unlike `=missing`, it reports
  what it writes as passed) in a `cp -a` copy under `/tmp`; the whole gate then passed there,
  **167 / 167**. The review caught one scene that drew an impossible state: `failed-relay` combined the
  Max-privacy reason with `relayUnavailable`, which only Reliable sets, and so rendered "Switch to
  Reliable" to someone already in Reliable. In Reliable an ICE failure is a plain close
  (`filterRelay` is off), so the scene now uses that reason; the screen itself was right.
- ✅ **The 12 connection-lost screenshot baselines are recorded — DONE 2026-09-27, on the deploy host.**
  `transfer-interrupted` (phone × 2 themes), `failed-lost` (full matrix, 6), `failed-lost-delivered`
  and `failed-lost-idle` (phone × 2 each). The committed baselines are the deploy host's renders — on
  the Mac every scene differs from them by 1–2 % of pixels, on the untouched `93de6f5` too — so they
  were recorded there, in a throwaway `cp -a` copy under `/tmp` at `defe379` (the dev clone and the web
  root untouched), and the whole gate then passed there: **159 / 159**. Two traps for next time: a
  `node_modules` SYMLINK instead of a copy makes Vite refuse the webfonts (`server.fs.allow`), so every
  scene "fails" and new baselines come out in a fallback font; and `--update-snapshots=missing` reports
  each baseline it writes as a failure — the run after it is the check.
- ✅ **The visual gate's run artifacts are no longer tracked — DONE 2026-09-27.**
  `visual/.report/index.html` and `visual/.results/.last-run.json` had been committed with `783c0a6` /
  `efe8b29`, so every `npm run visual` left the tree dirty; they are `git rm --cached` now and both
  directories are in `.gitignore`.
- ✅ **The RUNNING signaling copy is back in sync — VERIFIED 2026-09-12.** `/var/www/hush-signaling-server`
  (what systemd runs) is at `3cfd00a`, the `DEV_ORIGINS` commit, and 0 behind its `origin/main`. Keep
  pulling it whenever the repo moves — drift in the other direction is what once hid a hardcoded dev
  origin for a whole test run. Check it with
  `git -C /var/www/hush-signaling-server rev-list --count HEAD..origin/main` (needs a `git fetch` first);
  a doc-only change needs no `systemctl restart`.
- ✅ **HTTP/2 is ON on the live vhost — CORRECTED 2026-09-12.** The earlier note (and DEPLOY.md § 0)
  claimed it was off, read off the plain `listen 443 ssl;` line while missing the standalone
  `http2 on;` directive below it. `curl` against the live host negotiates HTTP/2. Nothing to do.
- ✅ **Security headers were silently dropped on `/assets/` and `.wasm` — FIXED, re-verified live
  2026-09-17.** nginx applies inherited `add_header` directives ONLY when the current level defines
  none, and both locations defined their own `add_header Cache-Control`, so the server-level block
  vanished for them. The live site now repeats all six inside each block. Measured today against
  production: **6/6 on the HTML, 6/6 on the JS bundle, 6/6 on the `.wasm`** — and that is after an
  nginx package upgrade on 2026-09-15 (1.28.3-2ubuntu1.10 → .11), so the config survived it.
- ✅ **`/ws` and `/` were logged with nginx's default `combined` format — FIXED, re-verified live
  2026-09-17.** The default wrote the client IP, the full User-Agent and the rendezvous code
  (`?room=…`) to disk, quietly undoing the coarse-device-label design. `access_log off;` is now set in
  all six location blocks of the live vhost. Measured today: **0 hushsend lines in the current
  `access.log`** across four days of uptime.
  **Residual, small but worth naming rather than leaving implicit:** the ROTATED logs still hold 56
  pre-fix lines (03–10 Sep, 23 unique IPs with full User-Agents). Inspected: they are `POST /` 405
  bot noise matched by the *Referer* header — **no `?room=` rendezvous codes and no `/ws` lines** — so
  no rendezvous or pairing metadata was ever retained. They age out with logrotate. Nothing to do
  unless the retention itself is considered sensitive.
- ✅ **Stale 4th signaling copy deleted (2026-09-17).** `/var/www/hushsend/server/` held an old
  checkout that nothing ran — the systemd unit works out of `/var/www/hush-signaling-server` — but it
  was old enough to mislead someone reading it as live. Removed; services stayed up, and the three
  remaining copies (repo, `~/projects/hush-signaling-server`, the running one) all hash the same.
  Note for the next person: it did NOT need root, only the deploy user.
- ✅ **CI's relay test red from the 2026-10-01 nightly — fixed 2026-10-02.** The second credential mint in
  `tests/integration/turn-relay.test.ts` failed — on CI an 8 s "timeout waiting for turn-credentials",
  on laptop-server a close 1006 (`c5f6e94` noted it as a laptop-server failure; it was the same one) —
  on a commit that had been green the night before. Engine matrix green both
  nights; only the integration job. The cause was the test, not the server: the `/health` probe's
  `fetch` left an idle keep-alive socket in undici's pool, `relayAttempt` then blocks the event loop
  (`spawnSync`) for ~4–6.5 s, Node's HTTP server closes an idle socket at 5 s, and the blocked client
  never sees it go and hands the dead socket to the next WebSocket handshake. It bites only when the
  uclient run outlasts 5 s — most runs on laptop-server; on CI not until that night (what changed on
  the runner is unreadable: job logs need auth). The probe now sends `Connection: close`, and the mint
  rejects on the socket's `error`: Node 22.23's WebSocket reports a failed handshake with `error` and
  no `close`, which the old no-op handler turned into the misleading timeout. Checked on Node 22.22.1
  and on 22.23.3 (CI's): with an extra forced 6 s block it passes, and without the probe change it
  fails in under 40 ms naming the network error; 10/10 plain runs green, 8 of them with the relay step
  over 5 s; full vitest 367/367 on both.
- ✅ **OBSOLETE 2026-09-29 — no need to finish.** Since 2026-09-28 the RAM (Blob) receive path is capped
  at 200 MiB on every device (the disk paths carry everything bigger), far below both engines' measured
  Blob ceilings, so the unmeasured rungs describe a path no transfer takes any more. Kept for the record:
  **Two measurements were left half-finished** when the ladder ran on a Mac: WebKit's 1792 MB rung was
  interrupted by hand before the stall watchdog could name a percentage, and Chromium's ceiling is
  only bracketed as "2 GB OK, 3 GB fails" — the boundary between them is unmeasured. Neither blocks
  anything.
  **Do NOT run the remaining rungs on the deploy host** (checked 2026-09-17, and the earlier "a single
  ladder run away" was misleading). The Blob receive path is RAM-bound, so the rung that fails is a
  property of the MACHINE as much as the engine: this box has 6 GB plus 3 GB of swap, and the
  unmeasured rungs are 2304/2560/2816 MB held in a browser heap. It would either thrash or produce a
  ceiling that describes this server rather than the Mac the rest of the ladder was measured on —
  a number worse than no number. Finish it on the same class of machine as the original run, and
  record which machine beside the result.

## Nice-to-have / future — the ones that landed

- ✅ **Claude Design redesign of the screen set — DONE (2026-09-26).** Every screen rebuilt from the canvas
  https://claude.ai/artifact/XRjdVX5U8SC8m2cDSgzDSP on kit 0.3.0 ([ui.md](../architecture/ui.md) § UI / styling has the
  reference, the decisions and the rules). Adopted from the kit: `controls.css` (`.pill`),
  `theme-toggle.css`, `layout.css` (`.wrap` — its `--gut` IS the design's 20 / 34 / 72 gutter); the two
  webfonts the palette names are bundled through fontsource. Link and QR became ONE screen; the lobby
  rows are the tap targets; the word entry is five fields (listbox on touch, inline completion on
  pointer); the transfer path check is disclosure rows in the non-ok states only; Failed is one screen
  with variants; key changed inverts the whole viewport. **Per-device forget is REAL**, not a disabled ×:
  `recentDevices.forgetDevice(peerPublicKey)` removes every pin of that peer key (the row stands for a
  peer, and the display dedup hides its older pins). New gates: `npm run test:a11y` (axe + keyboard
  contracts, `tests/a11y/`) and `npm run visual` (screenshots × 375/680/1440 × both themes + the token
  and geometry snapshots, `visual/`, baselines committed). e2e contracts changed on purpose: `pickWords`
  fills a field and presses Enter, `createLink` clicks the single "Link or QR code" row, the mode is two
  radios (`privacy-toggle` = Max, `privacy-reliable`), `path-state` is a disclosure row carrying
  `data-path-verdict` (the `ok` verdict is an sr-only span, no visible row), the network-exposure
  summary is inside "About privacy and security". Conscious deviations from the boards, all documented
  in [ui.md](../architecture/ui.md) § UI / styling: the type sizes are the kit's fluid roles with the h1 / h2 capped at 48 /
  32px from 1200px up (follow-up, same day — the uncapped `--t-h1` reached 73.6px at 1440); the
  attempts line reads "N / MAX failed attempts" (the counter the e2e asserts); and the SAS refusals are
  quiet pills of the confirm's geometry, NOT the boards' tertiary label — the 2026-09-12 audit decision
  (a small "stop" biases toward confirming; the confirm is the only gate on the reader side), briefly
  lost in the first cut of the redesign and restored the same day. The old HTML prototype under
  `uploads/design-reference/` was deleted in that follow-up; the canvas is the only reference.
- ✅ **stark-ui-kit 0.3.0 migration — DONE (2026-09-25).** Pin `b23a2e5` (0.1.0) → `2a3f7ec` (0.3.0).
  `src/ui/theme.css` is DELETED, not trimmed: `stark-ui-kit/theme-mono.css` is imported in `main.tsx`
  between the base layer and `app.css`, and the font-role overrides the plan meant to keep turned out to
  differ from the kit's stacks only in fallback order (`system-ui` / `Consolas`), not worth a second copy.
  The old greys are gone from the bundle (light `--muted` is now `#666666`; `prefers-contrast: more`
  hairlines 3.45:1 light / 3.06:1 dark, both over SC 1.4.11's 3:1). The pre-hydration frame DID flash on
  a dark-OS browser (theme-mono's OS branch fires while `<html>` has no `data-theme`), so `index.html`
  now ships `data-theme="light"` on `<html>`; a browser check with `colorScheme: 'dark'` boots light,
  toggles to dark, and keeps dark across a reload. The theme flip uses the kit's `data-theme-switching`
  cut. `useFocusTrap` / `useScrollLock` were never imported here, so step (1) of the plan was moot —
  `copyToClipboard` stays on the root entry. Unit 290/290, e2e 129 passed / 6 skipped (the opt-in size
  ladder + engine-gated cases) on ports 8191/5291. The 0.3.0 component stylesheets (`controls.css`,
  `links.css`, `layout.css`, …) are NOT adopted — that is the componentization item above, after the
  Claude Design redesign of the screen set. [ui.md](../architecture/ui.md) § UI / styling rewritten for the new pin.
- ✅ **Transfer-history privacy — DONE** (pre-deploy). Transfer history is no longer persisted: it
  moved from a localStorage record (`persistence.ts`, now deleted) to a SESSION-ONLY in-memory Redux
  slice (`src/store/historySlice.ts`), so file names leave no local trail — the history is gone on
  reload / tab close. localStorage now holds ONLY prefs (lang/theme/privacy mode, `prefs.tsx`);
  keystore pins (IndexedDB) are untouched. "Forget" clears the pins + the in-memory history. (See
  [build-order.md](build-order.md) § Current state.)

## The repository split (2026-10-03)

**Done the same day — the repository split.** The signaling server and its tests, the coturn
config of the TURN relay and `verify-relay.sh` moved to `hush-signaling-server` (`tests/`,
`deploy/turn/`); hushsend's `server/` copy and `tests/integration/` are gone, and the e2e suite runs
the server from a devDependency pinned by commit. `hushsend-stun-server` got `stun-only`, an installer
with its own unit and a CI check. It runs on laptop-server since 2026-10-10 (port 3479,
`stun.hushsend.frelikh.dev`; `verify.sh` passed from a mobile network) and the client takes STUN
from it — its DEPLOY.md § 0. Older entries in
this file and in TESTPLAN still name the old paths; they describe what was true when written.

## The documentation restructuring (2026-10-11)

Approved by the owner on 2026-10-03, done on 2026-10-11: one topic per file, one fact in one place.
CLAUDE.md (1 757 lines), TESTPLAN.md (1 674) and BACKLOG.md (1 656) were split — the design reference
into docs/architecture/ (one file per topic), the run logs into docs/test-runs/, the done log into
docs/history/, the owner's decisions into docs/decisions.md, the platform matrix into COMPATIBILITY.md,
the test pass's section 0 into docs/test-setup.md; CLAUDE.md became a short guide with the table of
what goes where. Sections that only repeated another document's subject were retired to
[claude-md-retired-sections.md](claude-md-retired-sections.md). `scripts/check-docs.mjs` (`npm run
docs:check`, in CI) now fails on a file over 500 lines, a dead link, a `§` pointer to a missing heading
and a missing code path; its first run found pointers that had been dangling before the restructuring
too (`BACKLOG.md § Third pass` in THREATMODEL.md and five e2e specs — no such section ever existed).

## The full test run after the device pass (2026-10-11)

Asked for in the 2026-10-03 pre-launch review (BACKLOG.md § Pre-launch review): every suite again, on
the deploy host, on the new toolchain (Vite 8, Vitest 5, Playwright 1.64). Done 2026-10-11; the counts
are in [README.md](../../README.md) § Status, not here. The screenshot gate needed no re-record: a
separate compare-only run the same day, in a `/tmp` copy of `6cc4ec9` on the deploy host, passed 181 of
181. The signaling server's 28 tests run in hush-signaling-server's own CI since the 2026-10-03 split
(green at `112c37f`).

## Frontend redeploys checked live (2026-09-28 … 2026-10-03)

Until 2026-10-13 the "Frontend redeployed" tick of [test-setup.md](../test-setup.md) § 0.1 kept every
redeploy and what it was checked with, newest first; the tick now names the current deploy only, and the
list moved here as it stood.

- **2026-10-03 ~01:35 UTC — `981f8df`** (`index-DkYJ-hTt.js`): the reconnect wait returns to waiting
  when the engaged peer vanishes before any transport — the ghost at the rendezvous. Byte-identical to a
  clean local build; checked on the phone ([the 2026-10-02 run log](../test-runs/2026-10-02.md), end of
  the 2026-10-02 entry).
- **2026-10-03 ~00:55 UTC — `190151b`** (`index-CkRmiW5i.js`): the three UX fixes from the Pixel 5 pass
  — the Max hint under the peer-left race, the reconnect wait's retry, the Finishing line. Byte-identical
  to a clean local build (42 files), no `stun.l.google`; the three fixes were then checked on the live
  build (the same run log). The visual gate ran on the deploy host against this commit: 181 / 181 after
  recording `transfer-finishing` (and re-recording the sas-picker's seeded decoys, which had moved —
  see that commit).
- **2026-10-02 ~19:20 UTC — `9bdda44`** (`index-CL2avokU.js`, `zxing_reader-BxB2YfIY.wasm`): the QR
  scanner's zxing glue/wasm ABI fix (`zxing-wasm` 3.1.3), the vitest ABI gate and that pass's records.
  Byte-identical (42 files, equal sha256 manifests), no `stun.l.google`. Checked live the same minute
  with real Chrome 154 and its fake camera: the QR decoded and the pair connected in 0.5 s, the `.wasm`
  fetched from our origin only. A browser that had the site open keeps the OLD bundle until a hard
  refresh / cache clear (`index.html` is cached), so every test device needs one before re-testing.
- **2026-10-01 — `c5f6e94`** (`index-6QS8zIWA.js`), the owner's deploy: the build the scanner was found
  dead on.
- **2026-09-29 19:44 UTC — `8c9ea59`** (`index-C-42SlIP.js`): a link opened into an already-open tab
  joins via `hashchange`; honest failure copy — a waiting side's own expired room, the mismatch
  description by cause; the macOS Local Network hint; the STUN probe window 12 s. Byte-identical (42
  files, equal sha256 manifests). Checked live with real Chrome the same evening: a link set as the
  fragment of an open home tab joined in 608 ms with no reload (a marker in `window` survived) and the
  fragment was scrubbed; a link nobody opened failed on its creator exactly 180 s later (the live
  `TOKEN_ROOM_TTL_MS`) as "Your link expired — Nobody opened it in time" (`data-reason` `nobody joined
  before the code expired`). After it the signaling server's running copy
  (`/var/www/hush-signaling-server`) was unchanged at `3d96125`, `/health` ok, nginx /
  hushsend-signaling / coturn `active`.
- **2026-09-29 18:47 UTC — `273e9e7`** (`index-CwM5wm6M.js`): the screen pacing — a screen the FSM
  leaves for a pre-connection stage is held 400 ms with its controls quiet, the Connecting screen
  appears only when a stage outlasts that, each of its titles stays ≥ 500 ms
  ([ui.md](../architecture/ui.md), Screen pacing). Byte-identical (42 files, equal sha256 manifests).
  Checked live the same evening with real Chrome on both sides (link method, 5 direct + 3 relayed runs,
  on a LAN that was slow that night — 59 ms average ping to the server): no screen flashed; a run under
  400 ms went straight from the held Share screen / an empty column to Transfer, a longer one showed
  "Creating session…" / "Joining…" / "Agreeing on keys…" for 500–650 ms, and a confirming stage of
  2–20 ms never got its "Verifying…" title.
- **2026-09-28 — `1f2abab`** (app code `254c31b`, `index-Cs9XZg39.js`): a held copy gives way to the
  next big file after 2 min. Checked the same way — 42 files.
- **2026-09-28 — `c5a51c4`** (`index-B-Rj0zzX.js`): straight into Downloads on desktop Chromium, flow
  control, the site-storage reservation. Checked the same way — 42 files, `dl/sw.js` the download
  worker; `dl/sw.js` is served as `application/javascript`, and a `/dl/<id>` no worker answers falls
  back to the app page with `X-Frame-Options: DENY` (so a hidden iframe can never render it).
