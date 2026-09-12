# hushsend — real-device test pass (step 6e)

The last open item before the security audit. Everything that can be verified without physical
devices is done (unit + integration + Playwright e2e, feature-detection review, self-hosted QR WASM);
what remains is **behaviour on real browsers, real networks, and real NAT**.

- **Target:** the live deploy — `https://hushsend.frelikh.dev` (production build).
- **Scope closes:** BACKLOG § Step 6 / 6e "Remaining (real devices, post-deploy)" and DEPLOY.md § 0
  "Still pending" (in-browser P2P/SAS/transfer on two devices + cross-network TURN relay).
- **Out of scope:** the three deferred security-audit items and lobby-pick reconnect (BACKLOG
  § Security audit). Do not mix reconnect with a plain room join except where a case says so.

## 0. Read this before starting

**The production build has no in-app diagnostics.** `Diagnostics` is `import.meta.env.DEV`-gated and
the DEV query knobs (`?forceIceFail=1`, `?stallSasNonce=1`, `?preSasTimeoutMs=N`,
`?reconnectTimeoutMs=N`, `?stallReconnect=1`, `?maxAttempts=N`, `?forceBlob=1`, `__HUSHSEND_*__`
globals) are tree-shaken out. **Verify this rather than assume it** — the 2026-09-12 audit found
three of them (`maxAttempts`, `forceBlob`, `__HUSHSEND_MAX_BYTES__`) shipping live in the deployed
bundle because they lacked the gate their siblings had, and this very paragraph asserted otherwise.
The check is one command against the SERVED bundle, not the source:

```bash
grep -roE 'maxAttempts|forceBlob|__HUSHSEND_[A-Z_]+__|forceIceFail|stall[A-Z][a-zA-Z]*' /var/www/hushsend/dist/assets/ | sort -u
```

It must print nothing. So:

- **Failure injection is NOT available on prod** — those paths are covered by e2e. This pass observes
  *real* behaviour only. If a fault path needs driving deliberately, do it against `npm run dev`
  locally, not against the live host.
- Observation comes from browser devtools + server logs (§ 0.2).

### 0.1 Preconditions

- [x] Frontend redeployed from current `main` (`bash ~/projects/hushsend/deploy/deploy-frontend.sh`)
      — done 2026-09-12 10:50; `/var/www/hushsend/dist` is byte-identical to the local build.
      **Re-run it if `main` has moved since**, and re-tick.
- [x] **Verify the new bundle is live:** `grep -r 'stun.l.google' /var/www/hushsend/dist` returns
      nothing — confirmed 2026-09-12 (the pre-2026-09-12 bundle matched; this was the BACKLOG
      "verify after redeploy" item).
- [ ] Hard-refresh every test device (Ctrl/Cmd+Shift+R; on iOS: close the tab and reopen) so no
      device runs the cached old bundle. Confirm the asset hash in devtools matches the deployed one.
- [ ] `curl -s https://hushsend.frelikh.dev/health` → `ok`; nginx / hushsend-signaling / coturn all
      `active`.
- [ ] **Hairpin NAT check** — the box is behind a residential NAT, so LAN devices reach the public
      hostname only if the router hairpins. Open the site on one LAN device and one LTE device before
      starting; if a LAN device cannot load it, that is a router issue, not an app bug.

### 0.2 How to observe

| What | Where |
|---|---|
| Selected ICE candidate pair (`host` / `srflx` / **`relay`**) | Chrome: `chrome://webrtc-internals` · Firefox: `about:webrtc` |
| iPhone Safari console/network | macOS Safari Web Inspector over USB (iPhone: Settings → Safari → Advanced → Web Inspector) |
| Android Chrome console/network | `chrome://inspect` from a MacBook over USB |
| Signaling frames + WS lifecycle | devtools → Network → WS → Messages |
| Server side | `sudo journalctl -u hushsend-signaling -f` |
| Relay actually used | `sudo journalctl -u coturn -f` (if coturn logs to a file instead, see `log-file` in `/etc/turnserver.conf`) **plus** the `relay` candidate pair in webrtc-internals |

### 0.3 Reference numbers (from the code, for judging "expected")

- Receive path: **FSA streaming (`showSaveFilePicker`) = unbounded**; otherwise **Blob in RAM**, capped
  at **1 GiB desktop / 512 MiB mobile** (UA-based), and the cap is rejected **before** accept.
  **Measured engine ceilings** (2026-09-12, `limits.spec.ts` with the cap lifted, on a Mac):
  Chromium OK at 1 GB and 2 GB, **fails at 3 GB** (`download.saveAs: canceled`); WebKit OK to 1.5 GB,
  **fails at 1.75 GB** (freezes near 100%). Both die at the END — the chunks arrive, the single Blob
  does not — and **neither raises a catchable error**, so the desktop cap is deliberately far below.
  B2 below is what tells us whether the MOBILE cap is equally well placed; nothing else can.
- Chunk size: the SCTP-negotiated max clamped to **[16 KiB, 256 KiB]**; backpressure via `bufferedAmount`.
- Deadlines (all **120 s**): pre-SAS pairing, SAS confirmation, reconnect re-auth, **and the 1:1
  key-confirmation wait** (words / link / QR — added 2026-09-12; before it, that path had no client
  deadline at all and depended on the untrusted server's room TTL to rescue it).
- Path attestation: advisory, **15 s** to hear the peer's attestation. Never tears anything down.
- Words: **4 secret words** + 1 rendezvous word (~41 bits of secret), **≤10 pairing attempts**;
  the words room TTL runs **from create** and is never re-armed (`WORD_ROOM_TTL_MS`, 180 s).
- Lobby: 4-digit code, up to **8 peers** (`FILETRANSFER_MAX_PEERS`); words/link/QR rendezvous are
  strictly **1:1** (a second joiner is bounced with 4002).
- Room TTL: idle timeout, **re-armed on each join**; words/token TTL runs from create. Expiry → 4010
  close, a later join → 4009 `room not found`.
- Per-IP rate limit **60 create/join per minute** → 4011 `too many attempts`. Several test devices
  behind one public IP share that bucket — a spurious 4011 during a heavy session is the limiter, not
  a bug. Wait a minute.
- Transfer history is **session-only** (in-memory, max 12, gone on reload).

### 0.4 Device inventory (fill in)

| Slot | Device | OS version | Browser + version | Expected receive path | Expected QR decoder |
|---|---|---|---|---|---|
| MBP-A | MacBook | | Chrome | FSA streaming (unbounded) | native/ponyfill |
| MBP-A | MacBook | | Safari | Blob (1 GiB cap) | zxing ponyfill |
| MBP-A | MacBook | | Firefox | Blob (1 GiB cap) | zxing ponyfill |
| MBP-B | MacBook | | Chrome | FSA streaming | native/ponyfill |
| IPH | iPhone | | Safari (WebKit) | Blob (512 MiB cap) | zxing ponyfill |
| AND-1 | Android | | Chrome | Blob (512 MiB cap) | native BarcodeDetector |
| AND-2 | Android | | Firefox | Blob (512 MiB cap) | zxing ponyfill |

---

## Phase A — same-network happy path (all 4 methods)

Both peers on the home Wi-Fi, default **Max-privacy**. Baseline: if these fail, nothing below matters.

- [ ] **A1 · link** — MBP-A (Chrome) creates a one-time link → send it to IPH (Safari) out of band →
      IPH opens it. Expected: auto-join, pairing, `connected` with **no SAS screen** (link/QR
      authenticate over the link secret), URL fragment scrubbed from the address bar.
- [ ] **A2 · QR** — MBP-A shows the QR, IPH scans it with the in-app scanner. Expected: same as A1.
      Note which decoder ran (§ B3).
- [ ] **A3 · words** — MBP-A creates, IPH enters the rendezvous + the 4 secret words. Expected: `connected`
      after CPace + key confirmation, no SAS screen.
- [ ] **A4 · room / SAS** — MBP-A creates a 4-digit room, IPH joins → both land in the **lobby**, MBP-A
      presses Connect on the IPH row. Expected: **SAS screen is asymmetric** — one side shows its
      phrase (reader), the other picks blind among 3 (real + 2 decoys). **Which side reads is not
      predictable and must not be** (changed 2026-09-12): it is derived from the SAS material, not
      from the creator and no longer from the id order, precisely so the untrusted server cannot make
      BOTH peers the blind picker. Just check that **exactly one** side reads and the other picks —
      re-pair a few times and expect the roles to land differently. Correct pick → `connected`.
- [ ] **A4a · the SAS refusal is reachable and equal-weight** — on the picker screen confirm
      "None of these match — stop" is a full-width button, not a faint link, and on the reader screen
      that the warning ("only continue once you have HEARD your peer say these words back") is
      legible on a phone. Tap the picker's refusal: expected **both** sides end in the
      "channel may be compromised" hard stop, no transfer UI on either.
- [ ] **A4b · the reader can still stop after confirming** — reader taps "They read it back correctly"
      BEFORE the picker answers, then taps the abort on the waiting screen. Expected: the session
      fails closed. (A reject is accepted even after our own approval, up to settle — a reader who
      clicked too early must not be trapped.)
- [ ] **A5 · transfer both ways** — over the A1 connection send a small file (≈5 MB) MBP-A → IPH, then
      IPH → MBP-A. Expected: progress advances monotonically, file arrives intact (**check the size and
      open it**), receiver's terminal plaque shows a **"New transfer"** button.
- [ ] **A6 · WS closes on connect** — in devtools Network → WS, confirm the signaling socket **closes
      shortly after `connected`** for all of A1–A4 **and for reconnect (Phase E)**, while the transfer
      keeps working afterwards. This is the per-pair privacy close: the server must not observe the
      session duration. Reconnect was the last exemption and was folded in on 2026-09-12 — if its
      socket stays open, that regression is the whole point of checking it here.
- [ ] **A6a · path attestation never blocks a transfer** — it is ADVISORY. On every pair, especially
      a Safari↔non-Safari one, confirm the transfer completes regardless of the verdict. A `mismatch`
      here is EXPECTED between engines (see § Phase B) and must stay cosmetic; if a transfer is ever
      refused or torn down because of it, that is a bug, not a detection.
- [ ] **A7 · multi-file** — send 3 files at once. Expected: all arrive, progress is per-transfer, no
      stale filename from the previous send after "New transfer".

## Phase B — browser capability matrix

The point of 6e: every fallback path on a real engine, not a polyfilled test env.

> **Record the path-attestation verdict on EVERY pair you make in this pass.** The DEV diagnostics
> strip shows `path-verdict` / `path-selected` / `path-peer-addrs` (they are dev-only, so read them
> against `npm run dev`, not the live host). Attestation is ADVISORY precisely because we do not yet
> know what real engines report: a firefox↔webkit pair on one LAN says `mismatch` with no attacker
> present, because WebKit cannot attest to the address it was reached on. What this pass needs is the
> table — for each pair (same-network and cross-network, each engine combination): the verdict, what
> each side selected, and what each side attested. That decides whether the check can become a
> control, and in which direction. See BACKLOG § Security audit / Path attestation.

> **The phone-shaped half is pre-covered too** by `tests/e2e/mobile.spec.ts` (WebKit + an iPhone
> device descriptor): the 512 MB cap is genuinely selected by the phone UA and quoted in the refusal,
> the Blob path completes, the layout holds at 390 px, and the QR paste fallback works. So on a real
> handset those are re-confirmations; what only the handset can answer is **memory pressure at the
> cap, background-tab suspension (§ F1), camera permissions (B4) and cellular NAT (§ C)**.
>
> **Already pre-covered headlessly** by `tests/e2e/interop.spec.ts` (chrome ↔ firefox ↔ webkit, both
> directions, link pairing + a hashed 200 KB transfer): cross-engine SDP/ICE/DTLS/SCTP interop and the
> Blob receive path. So B1–B2 below are confirming on real hardware rather than discovering; **B3–B5
> are the ones that can only be answered here** — a headless box has no camera, and Playwright's
> WebKit on Linux is not Safari on iOS.

- [ ] **B1 · FSA streaming (Chrome desktop)** — receive on MBP-A Chrome. Expected: a **save dialog
      appears on accept** (inside the click gesture), bytes stream to disk, RAM does not grow with the
      file (watch Activity Monitor on a ≈2 GB file).
- [ ] **B2 · Blob fallback + cap** — receive on IPH Safari and on MBP-A Firefox. Expected: no save
      dialog; the file lands via a download at the end. Then offer a file **over the cap** (>512 MiB to
      IPH, >1 GiB to MBP-A Firefox): the receiver must **refuse before accepting**, with a clear
      message naming the limit — never accept and then die of OOM mid-transfer.
- [ ] **B3 · QR scan + self-hosted WASM** — scan on IPH Safari and AND-2 Firefox (the ponyfill path).
      Expected: scanning works, and in Network the WASM is fetched from
      `https://hushsend.frelikh.dev/assets/zxing_reader-*.wasm` with `Content-Type: application/wasm`.
      **Nothing may be requested from `jsdelivr` / `fastly` / any third-party host** — that is the whole
      point of the 6e vendoring. Also scan on AND-1 Chrome (native `BarcodeDetector`; no WASM fetch at all).
- [ ] **B4 · camera permission denied** — on IPH, deny the camera prompt. Expected: a clean
      **paste-the-link fallback**, no crash, no dead screen. Re-allow and confirm the scanner recovers.
- [ ] **B5 · share / copy** — on IPH and AND-1 the **Share** button uses the native sheet; on MBP-A
      Firefox (no `navigator.share`) it must be **absent**, with Copy still present and working.
- [ ] **B6 · theme / language / layout** — check the app in light+dark and EN+RU on the iPhone and on a
      MacBook: no clipped text, no horizontal scroll, tap targets reachable, the 4-digit code and word
      slots legible.

## Phase C — cross-network + privacy modes (the part only real networks can prove)

IPH (or AND-1) on **LTE with Wi-Fi off**, MacBook on the home Wi-Fi.

- [ ] **C1 · Max-privacy direct across networks** — both sides default Max-privacy, link method.
      Expected either (a) `connected` via a `srflx` candidate pair — confirm in webrtc-internals that
      the selected pair is **not `relay`** — or (b) if the NATs won't traverse, a **terminal `failed`
      screen with the "switch to Reliable" hint**. Both are correct; a **hang is not**. Record which.
- [ ] **C2 · Reliable relay** — both sides switch to **Reliable**, repeat. Expected: `connected`; in
      webrtc-internals the selected candidate pair is **`relay`**, and coturn logs show an allocation
      from both peers. Then **transfer a ≈50 MB file over the relay** and note throughput — this is the
      only test that proves coturn's `external-ip` / port-forwarding config is actually right.
- [ ] **C3 · mixed privacy (regression)** — one side **Max-privacy**, the other **Reliable**. Run it in
      **both directions** (swap which side creates, so each side gets to be the offerer) and on **both
      the room and the link method**. Expected: **no deadlock** — this is the `pendingPeerSignals` fix
      (a Reliable answerer still fetching TURN creds used to silently drop the offer). Either it
      connects directly, or the Max-privacy side fails closed with the hint — never a stuck "agreeing
      on keys".
- [ ] **C4 · Max-privacy never relays — verifies the 2026-09-12 audit fix.** During C3 confirm on the
      Max-privacy side that **no `turn-request` frame is sent** (devtools → WS → Messages). Then force the
      DIRECT path to fail while the peer stays Reliable (easiest: put both on mobile networks, or use a
      restrictive Wi-Fi) and read the Max side's **selected candidate pair** in `chrome://webrtc-internals`.
      Expected: **terminal `failed` + the switch-to-Reliable hint**, and no relayed selected pair. The
      audit found that ICE can LEARN the peer's relay address as a `prflx` candidate even though we drop
      the signalled `typ relay` one; the fix refuses such a path at channel-open, before any byte. So:
      **`failed` ⇒ the fix works**; a **connection whose selected remote candidate is `relay`, or `prflx`
      at the peer's TURN address, means the gate did not catch it** — capture the full candidate-pair
      table and reopen BACKLOG § Security audit / Findings.
      Worth pairing with a control: the same Max ↔ Reliable run where the direct path DOES work must
      still connect normally (the gate must not reject a legitimate `prflx` from a NAT mapping).
- [ ] **C5 · mobile-to-mobile** — IPH (LTE) ↔ AND-1 (different LTE / other Wi-Fi), Reliable. The
      carrier-NAT-to-carrier-NAT case the desktop pair never exercises.

## Phase D — room lobby (mesh)

- [ ] **D1 · roster** — MBP-A creates a room; IPH, AND-1, AND-2 join. Expected: every member sees the
      others with a sane device label and join order; leaving a device removes its row.
- [ ] **D2 · joiner ↔ joiner** — IPH connects to AND-1 (neither is the creator). Expected: it pairs and
      completes SAS normally. The TRANSPORT role (who offers) still comes from the id order, which is
      why this case exists; the SAS reader/picker split no longer does (see A4), so check here too
      that exactly one side reads.
- [ ] **D3 · busy reject** — while IPH↔AND-1 are paired, MBP-A presses Connect on IPH. Expected: MBP-A
      gets a clear **busy notice and returns to the lobby** — no hang, no silent failure.
- [ ] **D4 · two independent pairs** — pair IPH↔AND-1 and MBP-A↔AND-2 **in the same room**, then
      transfer on both at once. Expected: both work; neither pair's per-pair signaling close disturbs
      the other; the room survives.
- [ ] **D5 · SAS mismatch** — on a fresh pair, deliberately pick the **wrong** phrase. Expected: a hard
      failure with a clear message; no transfer possible afterwards.

## Phase E — reconnect (its own by-code path — do not route it through the lobby)

- [ ] **E1 · pin created** — after any successful fresh pairing (A1–A4), both devices list the peer
      under recent devices, **once** (the dedup-by-peer-key fix — pair the same two devices 3 times and
      confirm still exactly one row).
- [ ] **E2 · reconnect happy path** — on MBP-A press **Start** on the IPH row (it opens a room + shows a
      code); on IPH use **Join** and enter that code. Expected: `connected` **without any SAS screen**
      (pin-based re-auth), then transfer works.
- [ ] **E3 · both press Start** — expected: two separate rooms, no rendezvous, and the UI's split hint
      makes that obvious. Confirm it is understandable, not a mystery hang.
- [ ] **E4 · mismatched entry fails closed** — one side **Start (reconnect)**, the other joins the same
      code via the **regular room join**. Expected: the reconnect side ends in **`failed` within ~120 s**
      (the liveness deadline), NOT an endless "agreeing on keys". Time it.
- [ ] **E5 · key change** — on IPH press **forget** (clears pins), then reconnect from MBP-A using the
      stale pin. Expected: the key-changed hard stop on the pinned side, or a clean fall back to a fresh
      SAS — whichever the design says, but never a silent auto-accept.

## Phase F — real-world robustness

- [ ] **F1 · phone screen lock / app switch mid-transfer** — start a ≈200 MB transfer to IPH, then lock
      the screen / switch apps for ~30 s and come back. Expected: either it keeps going or it fails
      visibly with a recoverable state — **iOS suspends background tabs**, so record exactly what
      happens; this is the single most likely real-world surprise.
- [ ] **F2 · network drop** — mid-transfer, disable Wi-Fi on one side for ~20 s and re-enable.
      Expected: a visible failure or a recovery, never a frozen progress bar that claims to be alive.
- [ ] **F3 · tab close** — close the receiver's tab mid-transfer. Expected: the sender notices and shows
      a failure.
- [ ] **F4 · large transfer** — ≈2 GB MBP-A Chrome → MBP-B Chrome (FSA both ways). Expected: it
      completes, memory stays flat, and the signaling socket is long gone by then (A6).
- [ ] **F5 · code expiry** — create a words session and leave it untouched past its TTL, then try to
      join. Expected: the code is freed — the waiting side is closed out (4010) and a later join gets
      `room not found` (4009), with a readable message rather than a raw code.
- [ ] **F6 · history is session-only** — after a few transfers, reload the page. Expected: the transfer
      history is **empty** (in-memory only); `localStorage` holds only lang/theme/privacy prefs.
- [ ] **F7 · second joiner on a 1:1 method** — forward the same link/QR to a second device. Expected:
      the second joiner is rejected (4002) — the one-time link reaches exactly one receiver.
- [ ] **F8 · silent peer on the 1:1 confirm path** — open a link on the receiving device and, the
      instant the connection starts, put that browser in a state where it cannot answer (airplane mode
      works; force-quitting the tab does not — that raises a channel close instead, which is a
      different path). Expected: the SENDER ends in **`failed` within ~120 s**, not an endless
      "agreeing on keys". This deadline is new (2026-09-12); before it, this path had no client-side
      bound at all and only the untrusted server's room TTL ended the wait — a server that simply
      never expired the room hung the client forever. **Time it and write the number down.**
- [ ] **F9 · slow mobile network does NOT trip the new deadlines** — the mirror of F8 and the risk it
      carries. Repeat A3 (words) and A4 (room/SAS) on a **weak cellular** connection, not Wi-Fi. The
      SAS nonce reveal now waits for the DTLS fingerprints to be pinned, so the handshake has more
      serialised steps than before. Expected: still connects well inside 120 s. If a real phone on a
      real network gets anywhere near the deadline, the deadline is wrong, not the network.

---

## Result log

Record per case: `ID · device pair · browser versions · PASS/FAIL · notes`. For a failure capture:
the selected candidate pair (webrtc-internals / about:webrtc), the WS message trace, the console
output, and whether it reproduced on the other engine.

**When the pass is done:** fold the results into `BACKLOG.md` § Step 6 / **6e** (and its
"Remaining (real devices, post-deploy)" line) and `CLAUDE.md` § Current state / Build order in the
SAME pass — doc drift is a bug (CLAUDE.md § Keep this file in sync). Bugs found here become new
BACKLOG items under "UX bugs — found in the manual test pass"; anything security-shaped goes to
§ Security audit instead of being fixed ad hoc.
