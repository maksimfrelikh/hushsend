# hushsend — real-device test pass (step 6e)

Everything that can be verified without physical devices is done (unit + integration + Playwright
e2e across four engine projects, feature-detection review, self-hosted QR WASM); what remains is
**behaviour on real browsers, real networks, and real NAT**.

**Status (2026-10-03): DONE — 47 of 47 cases ticked or closed with a reason.** The runs are recorded one
file per day in [docs/test-runs/](docs/test-runs/README.md), together with how the pass progressed. The
ticks in [docs/test-setup.md](docs/test-setup.md) § 0.1 are PRECONDITIONS, not cases; do not read them as
progress.

- **Target:** the live deploy — `https://hushsend.frelikh.dev` (production build).
- **Scope:** the real-device half of step 6e — in-browser P2P / SAS / transfer on two devices and the
  cross-network TURN relay ([step6-hardening.md](docs/history/step6-hardening.md) has what came before).
- **Out of scope:** the open security items ([BACKLOG.md](BACKLOG.md) § Security — open). Reconnect is
  codeless since 2026-09-25 — there is no reconnect code to mix with a plain room join any more.

> **Plan currency.** Cases B7, B8, C6 and E6 were added on 2026-09-18 for behaviour that landed
> after this plan was first written (STUN cross-check, the network-exposure disclosure, volume
> padding, and the reconnect early-frame fix); Phase E was rewritten on 2026-09-25 for the codeless
> reconnect (E3/E4 changed meaning, E7 added). If you are reading this after further changes, check
> `git log --oneline -- src/` against the date above before trusting the coverage: a device pass that
> silently skips a new feature is worse than one that has not run.

**Before you start** — the preconditions, how to observe, the reference numbers, the device inventory and
how the pass is run (its section 0) — read [docs/test-setup.md](docs/test-setup.md).

## Phase A — same-network happy path (all 4 methods) · mostly T1; A2 needs the camera

Both peers on the home Wi-Fi, default **Max-privacy**. Baseline: if these fail, nothing below matters.

- [x] **A1 · link** *(AND-1 half ✅ 2026-10-02 — Pixel 5 Chrome ×3; IPH half ✅ 2026-10-03 — iPhone 15 Safari, 2.0 / 1.7 s, host↔host)* — MBP-A (Chrome) creates a one-time link → send it to IPH (Safari) out of band →
      IPH opens it. Expected: auto-join, pairing, `connected` with **no SAS screen** (link/QR
      authenticate over the link secret), URL fragment scrubbed from the address bar.
- [x] **A2 · QR** *(AND-1 half ✅ 2026-10-02 on the fixed live build `9bdda44` — the Pixel 5 decoded the QR off the Mac's screen and connected in 8.5 s; before the fix the scanner was dead on every engine, [the 2026-10-02 run log](docs/test-runs/2026-10-02.md). IPH ✅ 2026-10-03: the iPhone's camera read the QR off the Mac's screen, connected in 29 s)* — MBP-A shows the QR, IPH scans it with the in-app scanner. Expected: same as A1.
      Note which decoder ran (§ B3).
- [x] **A3 · words** *(AND-1 half ✅ 2026-10-02; IPH ✅ 2026-10-03)* — MBP-A creates, IPH enters the rendezvous + the 4 secret words. Expected: `connected`
      after CPace + key confirmation, no SAS screen.
- [x] **A4 · room / SAS** *(AND-1 half ✅ 2026-10-02, 8 rooms, reader 5× creator / 3× phone; IPH ✅ 2026-10-03, 2 rooms, roles both ways)* — MBP-A creates a 4-digit room, IPH joins → both land in the **lobby**, MBP-A
      presses Connect on the IPH row. Expected: **SAS screen is asymmetric** — one side shows its
      phrase (reader), the other picks blind among 3 (real + 2 decoys). **Which side reads is not
      predictable and must not be** (changed 2026-09-12): it is derived from the SAS material, not
      from the creator and no longer from the id order, precisely so the untrusted server cannot make
      BOTH peers the blind picker. Just check that **exactly one** side reads and the other picks —
      re-pair a few times and expect the roles to land differently. Correct pick → `connected`.
- [x] **A4a · the SAS refusal is reachable and equal-weight** — on the picker screen confirm
      "None of these match — stop" is a full-width pill of the same size as the confirm, not a faint
      label (the 2026-09-12 audit decision; the 2026-09-26 redesign briefly made it a label and that
      was reverted the same day), and on the reader screen that "Stop — they don't have this phrase"
      is the same, and that the sentence "Only continue once you have HEARD your peer say these words
      back." sits directly above the confirm pill and is legible on a phone. Tap the picker's
      refusal: expected **both** sides end in the "channel may be compromised" hard stop, no transfer
      UI on either.
- [x] **A4b · the reader can still stop after confirming** — reader taps "They read it back correctly"
      BEFORE the picker answers, then taps the abort on the waiting screen. Expected: the session
      fails closed. (A reject is accepted even after our own approval, up to settle — a reader who
      clicked too early must not be trapped.) *(PASS on the live build 2026-09-28 — the "Stop" pill on
      "Verifying…" ends both sides in the hard stop; [the run log](docs/test-runs/README.md).)*
- [x] **A5 · transfer both ways** *(AND-1 half ✅ 2026-10-02: site storage on the phone, the stream path on the Mac, both verified; IPH ✅ 2026-10-03: site storage on the phone, the stream path on the Mac, both verified)* — over the A1 connection send a small file (≈5 MB) MBP-A → IPH, then
      IPH → MBP-A. Expected: progress advances monotonically, file arrives intact (**check the size and
      open it**), receiver's terminal plaque shows a **"New transfer"** button.
- [x] **A6 · WS closes on connect** — in devtools Network → WS, confirm the signaling socket **closes
      shortly after `connected`** for all of A1–A4 **and for reconnect (Phase E)**, while the transfer
      keeps working afterwards. This is the per-pair privacy close: the server must not observe the
      session duration. Reconnect was the last exemption and was folded in on 2026-09-12 — if its
      socket stays open, that regression is the whole point of checking it here.
- [x] **A6a · path attestation never blocks a transfer** *(✅ 2026-10-03: Chrome ↔ iPhone Safari read `mismatch` on the Mac and the 3 MB send completed — [the 2026-10-03 run log](docs/test-runs/2026-10-03.md))* — it is ADVISORY. On every pair, especially
      a Safari↔non-Safari one, confirm the transfer completes regardless of the verdict. A `mismatch`
      here is EXPECTED between engines (see § Phase B) and must stay cosmetic; if a transfer is ever
      refused or torn down because of it, that is a bug, not a detection.
- [x] **A7 · multi-file** — send 3 files at once. Expected (wording fixed 2026-09-27 to the behaviour
      shipped since `1082b7d`): the sender lists the three files and sends them as ONE store-mode
      `hushsend-files.zip` with one progress bar; the receiver is offered that zip, and every member
      unzips byte-identical; after "New transfer" the next offer shows ITS own name, never the zip's.

## Phase B — browser capability matrix · mixed: B7/B9 are T1, the camera and phone-RAM cases are T2

The point of 6e: every fallback path on a real engine, not a polyfilled test env.

> **Record the path-attestation verdict on EVERY pair you make in this pass.** The DEV diagnostics
> strip shows `path-verdict` / `path-selected` / `path-peer-addrs` (they are dev-only, so read them
> against `npm run dev`, not the live host). Attestation is ADVISORY precisely because we do not yet
> know what real engines report: a firefox↔webkit pair on one LAN says `mismatch` with no attacker
> present, because WebKit cannot attest to the address it was reached on. What this pass needs is the
> table — for each pair (same-network and cross-network, each engine combination): the verdict, what
> each side selected, and what each side attested. That decides whether the check can become a
> control, and in which direction. See [security-audits.md](docs/history/security-audits.md) § Security audit / Path attestation.

> **The phone-shaped half is pre-covered too** by `tests/e2e/mobile.spec.ts` (WebKit + an iPhone
> device descriptor): the phone's real receive path completes (on that build site storage cannot
> write, so it is the RAM fallback — the probe and the fall-back are what that proves), a forced RAM
> receive over 200 MiB is refused before any byte, the layout holds at 390 px, and the QR paste
> fallback works. So on a real
> handset those are re-confirmations; what only the handset can answer is **memory pressure at the
> cap, background-tab suspension (§ F1), camera permissions (B4) and cellular NAT (Phase C)**.
>
> **Already pre-covered headlessly** by `tests/e2e/interop.spec.ts` (chrome ↔ firefox ↔ webkit, both
> directions, link pairing + a hashed 200 KB transfer): cross-engine SDP/ICE/DTLS/SCTP interop and the
> Blob receive path. So B1–B2 below are confirming on real hardware rather than discovering; **B3–B5
> are the ones that can only be answered here** — a headless box has no camera, and Playwright's
> WebKit on Linux is not Safari on iOS.

- [x] **B1 · straight into Downloads, no dialog (Chrome desktop)** — receive on MBP-A Chrome.
      Expected: **no save dialog**; the download starts at Accept and the browser writes the file as it
      arrives (the download worker, `dl/sw.js`) — **nothing in site storage**, RAM flat on a ≈2 GB file,
      the saved file intact. Cancel one in Chrome's downloads list mid-transfer: both sides end
      (receiver "error · the browser stopped the download", sender "cancelled") and no partial file is
      left. Pause one there: the sender's progress stops (flow control) and resumes with the download;
      RAM stays flat. *(Reworded twice on 2026-09-28: the morning's tick proved the site-storage path
      — a disk file, no dialog, the dialog only past the quota, all PASS on the live build
      ([the 2026-09-28 run log](docs/test-runs/2026-09-28.md)) — which desktop Chrome no longer takes; Firefox and Safari do, so those checks moved to
      B2/B10. PASS on the live `c5a51c4` the same day — [the run log](docs/test-runs/README.md).)*
- [x] **B2 · disk receive on the phone + the RAM fallback's cap** *(IPH disk half ✅ 2026-10-03: 1 GiB and 2 GiB into Safari's site storage, verified; RAM rung ✅ 2026-10-03 in a private Safari tab: 250 MB refused before Accept naming the 200 MB cap and the private window, 200 MiB accepted via RAM and delivered)* — receive on IPH Safari and on MBP-A
      Firefox (both keep site storage — neither may stream, see [transfer.md](docs/architecture/transfer.md) § File transfer). Expected:
      no save dialog; the file goes to site storage and lands via a download at the end — a file well
      past 200 MiB (say 1 GiB) must complete on the PHONE, which is what the disk path is for. Then in a **private window** (where site storage may be unusable → the RAM path)
      offer a file **over 200 MiB**: the receiver must **refuse before accepting**, naming the limit —
      never accept and then die of OOM mid-transfer. *(Reworded 2026-09-28 for the disk-first path; the
      old caps were 512 MiB phone / 1 GiB desktop.)* **2026-09-28, desktop Chrome incognito: FAILS this
      rung** — there site storage IS usable but holds only ~430 MiB while `navigator.storage.estimate()`
      reports the normal profile's 10 GiB, so a 600 MiB file was accepted on the disk path and died at
      74 % ([the run log](docs/test-runs/README.md), [ux-fixes.md](docs/history/ux-fixes.md) § UX bugs). Re-run after the fix: Chrome incognito now streams into
      Downloads (expect a 1 GiB file to complete there, nothing in site storage); Firefox private has no
      site storage (`getDirectory()` → SecurityError, measured) — expect the RAM path, a refusal before
      accept above 200 MiB; Safari private — by hand (safaridriver cannot open one).
- [x] **B3 · QR scan + self-hosted WASM** *(AND-1 half ✅ 2026-10-02 on `9bdda44`: the scan fetched the ponyfill + `zxing_reader-BxB2YfIY.wasm` from our origin only and decoded; IPH ✅ 2026-10-03; AND-2 Firefox half DROPPED by the owner 2026-10-03 — too rare a combination to hold the case open)* — scan on IPH Safari and AND-2 Firefox (the ponyfill path).
      Expected: scanning works, and in Network the WASM is fetched from
      `https://hushsend.frelikh.dev/assets/zxing_reader-*.wasm` with `Content-Type: application/wasm`.
      **Nothing may be requested from `jsdelivr` / `fastly` / any third-party host** — that is the whole
      point of the 6e vendoring. Also scan on AND-1 Chrome — it fetches the SAME WASM: the app imports
      `barcode-detector/ponyfill` where the browser has no native QR detector (iOS Safari, Firefox); since
      2026-10-03 Chrome desktop / Android use their own `BarcodeDetector` with a runtime fallback to zxing
      (owner's decision, [qr.md](docs/architecture/qr.md) § QR). The ponyfill itself never delegates to a native detector
      (measured 2026-09-27 on desktop Chrome, which has one; corrected from
      "native; no WASM fetch at all").
- [x] **B4 · camera permission denied** *(Android half ✅ 2026-10-02: Block → paste fallback, no crash; re-allow is via the site-settings sheet because Chrome offers "Never allow"; IPH ✅ 2026-10-03: deny → "Camera unavailable — paste the link below instead")* — on IPH, deny the camera prompt. Expected: a clean
      **paste-the-link fallback**, no crash, no dead screen. Re-allow and confirm the scanner recovers.
- [x] **B5 · share / copy** *(AND-1 half ✅ 2026-10-02 — the system share sheet opened on a real tap; IPH ✅ 2026-10-03 (the share sheet opened); Firefox half ✅ 2026-10-03: no `navigator.share` → no Share button, Copy link → "Copied", the clipboard holds exactly the link)* — on IPH and AND-1 the **Share** button uses the native sheet; on MBP-A
      Firefox (no `navigator.share`) it must be **absent**, with Copy still present and working.
- [x] **B7 · STUN cross-check verdict per engine — NEW 2026-09-17, and the device pass is what
      decides it.** The client asks every configured STUN server what our public address is, using one
      throwaway PeerConnection per server, and compares (`core/stunCheck.ts`). Read `stun-verdict` /
      `stun-addresses` in the DEV strip on EVERY engine in the matrix. **This needs two STUN URLs in
      `VITE_STUN_URLS`** — with one it is `unknown` by design and the case proves nothing. Exact setup,
      worked out 2026-09-19 (two flags cost a while to find: coturn REFUSES to start with
      `--allow-loopback-peers` unless the admin CLI is secured, and its default pidfile is unwritable
      as a normal user):

      ```bash
      # 1. two loopback STUN servers (NOT 3478 or 3479 — the TURN relay and hushsend-stun own those
      #    here; the recipe used 3479/3480 until hushsend-stun took 3479 on 2026-10-10)
      for P in 3480 3481; do
        turnserver -n --listening-ip=127.0.0.1 --listening-port=$P \
          --no-auth --no-tls --no-dtls --no-cli --pidfile= --log-file=stdout &
      done
      # 2. a LOCAL signaling server that trusts the dev origin
      NODE_ENV=development HOST=127.0.0.1 PORT=8191 DEV_ORIGINS=http://localhost:5291 \
        node node_modules/hush-signaling-server/signaling-server.js &
      # 3. the dev build, pointed at BOTH of the above
      VITE_SIGNALING_URL=ws://127.0.0.1:8191 \
      VITE_STUN_URLS=stun:127.0.0.1:3480,stun:127.0.0.1:3481 \
        npx vite --port 5291 --strictPort
      ```

      Verified end to end 2026-09-19: the page loads, the DEV strip renders, and `stun-verdict` reads
      **`agree`** with no console errors — so a `unknown` in this case is a real result about the
      engine, not a broken harness.
      On the Mac (Homebrew coturn **4.18**) `--no-dtls` and `--no-cli` no longer exist and the command
      exits 255 with its help text; there use `turnserver -n -S -z --listening-ip=127.0.0.1
      --listening-port=$P --no-tls --pidfile /tmp/turn$P.pid --log-file stdout` (checked 2026-09-27).

      **`npm run dev` on this host does NOT work, and fails in a way that wastes an hour.** Vite's
      default 5173 is held by an unrelated app, so it silently moves to 5174; the client's dev default
      signaling URL is `ws://localhost:8080`, which is the **live production** signaling server; and
      production runs with an empty dev-origin allowlist, so every socket is closed with
      **4003 `origin not allowed`** and the app just never connects. Hence all three explicit ports
      above — the same host-safe pair the e2e suite uses (8191 / 5291).
      Expected on chromium and webkit: `agree`, with a real address. **Firefox measured `unknown`
      headlessly** — it reported no server-reflexive candidate and exposes no `url` on local
      candidates — but that was on LOOPBACK, where the reflexive address equals the host address and
      is legitimately pruned. **Whether Firefox can answer on a real network is an open question only
      this pass can settle**, and it decides whether the feature covers two engines or three. Record
      the verdict, not just pass/fail.
- [x] **B8 · the network-exposure disclosure renders** *(PASS 2026-10-02 on the Pixel 5: closed by default, opens on tap, nothing clipped at 392 px; RU not checked — English only by decision)* — — NEW 2026-09-13.** On the landing, the collapsed
      "What your network can still see" block (testid `network-exposure`) must be present, **closed by
      default**, readable in EN and RU, and open on tap on a phone. It states the two things
      cryptography does not hide (cleartext SNI; the direct connection to your correspondent) and the
      Tor/VPN-on-both-sides advice. Check the text is not clipped at 390 px — it is the longest prose
      in the app.
- [x] **B6 · theme / language / layout** *(Android half ✅ 2026-10-02 — both themes, no clipping, 44 px targets; iPhone ✅ 2026-10-03: both themes, 44 px targets, no overflow at 393 px)* — check the app in light+dark and EN+RU on the iPhone and on a
      MacBook: no clipped text, no horizontal scroll, tap targets reachable, the 4-digit code and word
      slots legible.
- [x] **B9 · privacy-hardened browser (Brave, shields up) — NEW 2026-09-19.** Brave is Blink, so it
      adds **no engine coverage** — it is here for its HARDENING. This product's users skew towards
      hardened browsers, and Brave ships WebRTC defaults Chrome does not: shields, fingerprint
      randomisation, and a **WebRTC IP-handling policy** that can withhold local and/or
      server-reflexive candidates. Since Max privacy is STUN-only and refuses to relay, a browser that
      withholds srflx has nothing left to pair on. Run **A1 (link) and A5 (transfer) with shields UP at
      the default setting, in BOTH privacy modes.** Expected: it connects, or it fails **visibly** with
      the switch-to-Reliable hint — a silent hang is the bug. Record the WebRTC policy setting and
      which candidate types were gathered (`chrome://webrtc-internals`). If Max privacy cannot gather
      an srflx there, that is a real-world limit to state in the README, not a defect to fix: the
      strict model is doing exactly what it promises.
- [x] **B10 · size ladder up to 5 GB — every receive path, every engine as sender — NEW 2026-09-27
      (owner's request).** *(Handset half of the site-storage row ✅ 2026-10-02: Pixel 5 Chrome, 1 / 2 / 3 / 4 GiB + 1 B / 5 GiB all PASS at 3.0–5.5 MB/s, Chrome PSS flat 201–264 MB — [the 2026-10-02 run log](docs/test-runs/2026-10-02.md). IPH site-storage rungs ✅ 2026-10-03: 1 and 2 GiB block-verified at 12.6 / 29.4 MB/s, 4 GiB + 1 B and 5 GiB by hand in the owner's tab — "Delivered" = the receiver confirmed every declared byte, 11.6 / 12.8 MB/s over Wi-Fi, no block verify on the phone; the RAM rung ✅ in a private tab (B2); past-the-quota on a phone not attempted — the iPhone reports 41 GB free.)* Limits differ by OS, browser and device, and [docs/test-setup.md](docs/test-setup.md) § 0.3's ceilings come from
      Playwright builds on one Mac (Chromium and WebKit only: no Gecko, no real Safari, no phone). So
      walk each receive path up its ladder on the REAL engines and devices:

      | receive path | sizes to offer | expected |
      |---|---|---|
      | *(2026-09-28: the paths changed — rows kept for the record of the 2026-09-27 run; the NEW rows below are what to walk next)* | | |
      | FSA streaming (Chrome desktop) | 1, 2, 3 GiB, **4 GiB + 1 B** (the 32-bit edge), **5 GiB** | completes, every byte verified, receiver memory flat |
      | Blob, desktop cap 1 GiB (Safari, Firefox, Brave, Chrome without FSA) | 1 GiB + 1 B, 5 GiB, then **exactly 1 GiB** | the first two refused BEFORE accept, naming the limit; 1 GiB completes AND the download lands on disk intact |
      | Blob, mobile cap 512 MiB (iOS Safari, Android Firefox; Android Chrome only where `showSaveFilePicker` is absent — Chrome 149 has it, so its default path is FSA, see AND-1) | 512 MiB + 1 B, 5 GiB, then **exactly 512 MiB** | the same; on a real handset this is also B2's memory-pressure datum |
      | every engine as SENDER | 5 GiB into an FSA receiver | completes; sender memory does not grow with the file |
      | **NEW 2026-09-28 · straight into Downloads (desktop Chrome, the default there)** | 1, 2, 3 GiB, 4 GiB + 1 B, 5 GiB | completes with NO dialog and nothing in site storage, the saved file's SHA-256 right, receiver memory flat |
      | same · the download PAUSED in Chrome's list mid-transfer, then resumed | 2 GiB | the sender stops at a window's worth (16 MiB) past the receiver, memory flat while paused, completes intact after resume |
      | same · the download CANCELLED in Chrome's list | 2 GiB | receiver "error · the browser stopped the download", sender "cancelled", no partial file |
      | **NEW · OPFS (Firefox, Safari, mobile — the default there)** | 1, 2, 3 GiB, 4 GiB + 1 B, 5 GiB — up to the site quota | completes with NO dialog, every byte verified, receiver memory flat, the download lands intact |
      | **NEW · past the quota** (Chrome: > 10 GiB here) | quota + 1 GiB | Chrome/Android: the save dialog appears (FSA); Safari/Firefox: refused before accept, naming the room |
      | **NEW · RAM fallback 200 MiB** (a private window without usable site storage) | 200 MiB + 1 B, then exactly 200 MiB | the first refused before accept; 200 MiB completes |
      | *(2026-09-28, the live `c5a51c4`: the stream rungs PASS on Chrome, the site-storage rungs PASS on Firefox with the over-quota refusal and on Safari to 5 GiB, the RAM rung PASS on Firefox private — [the 2026-09-28 run log](docs/test-runs/2026-09-28.md). The desktop half of B10 is done; the handset half is what is left.)* | | |

      **Build the files so they cost the page nothing and still prove every byte:** 1 MiB blocks, each
      a unique 16-byte header plus one shared body, assembled from Blob parts that REFERENCE that body.
      A 5 GiB `File` then holds ~1 MiB of RAM on the sender, and the receiver checks every block, so
      reordering, duplication and truncation all fail. For an unattended FSA run the save dialog can be
      replaced in-page by an OPFS file handle (the same `createWritable()` stream); the dialog itself is
      B1's T2 step. Let the Blob path's final download really happen, because that hand-off is where
      the engines died in [docs/test-setup.md](docs/test-setup.md) § 0.3, and hash the saved file. Record per run: pair, size, MB/s, outcome,
      verify result, and the peak RSS of the sender's and the receiver's process trees (`ps` every 5 s).
      A phone-sized receiver is the case this ladder exists for; a simulator or emulator run is a
      rehearsal, not the tick.

## Phase C — cross-network + privacy modes (the part only real networks can prove) · entirely T2

IPH (or AND-1) on **LTE with Wi-Fi off**, MacBook on the home Wi-Fi.

- [x] **C1 · Max-privacy direct across networks** *(PASS 2026-10-02, outcome (b): Mac Chrome ↔ Pixel 5 on a VPN Wi-Fi, both sides terminal `failed` with the hint in 18–48 s — [the 2026-10-02 run log](docs/test-runs/2026-10-02.md))* — both sides default Max-privacy, link method.
      **⚠️ Caveat found 2026-10-03 — the outcome does not generalise.** In every C1 run (and on the Max side of
      C3) the desktop sat on the SERVER'S OWN LAN, and from there the STUN reply is the ROUTER's LAN address:
      re-measured 2026-10-03, Chrome on the Mac at 192.168.1.38 gathered `srflx 192.168.1.1` from
      `stun:turn.hushsend.frelikh.dev:3478` (the router hairpins and rewrites the source). So the home side
      never advertised its public mapping and the remote peer had nothing to reach — a failure by
      construction, whatever the phone's NAT. **Direct connectivity across networks is untested for anyone
      not on the server's LAN.** To test it, put the desktop on any OTHER network (café, office, a friend's
      Wi-Fi) and pair it with the phone on LTE, both in Max privacy.
      **Re-measured 2026-10-11 against the live bundle's `:3479`:** from the server's LAN the mapping IS
      the public address, port preserved — only the TURN listener `:3478` answers `192.168.1.1`
      (BACKLOG § Pre-launch review, the finding). The owner's cellular ↔ home-Wi-Fi Max↔Max pair failed the
      same day with no candidate pairs captured, so the carrier NAT is the open question — [the
      2026-10-11 run log](docs/test-runs/2026-10-11.md).
      Expected either (a) `connected` via a `srflx` candidate pair — confirm in webrtc-internals that
      the selected pair is **not `relay`** — or (b) if the NATs won't traverse, a **terminal `failed`
      screen with the "switch to Reliable" hint**. Both are correct; a **hang is not**. Record which.
- [x] **C2 · Reliable relay** *(PASS 2026-10-02: `relay ↔ relay` on our coturn, 50 MB in 165 s = 0.3 MB/s with the phone behind a VPN — [the 2026-10-02 run log](docs/test-runs/2026-10-02.md))* — both sides switch to **Reliable**, repeat. Expected: `connected`; in
      webrtc-internals the selected candidate pair is **`relay`**, and coturn logs show an allocation
      from both peers. Then **transfer a ≈50 MB file over the relay** and note throughput — this is the
      only test that proves coturn's `external-ip` / port-forwarding config is actually right.
- [x] **C3 · mixed privacy (regression)** *(PASS 2026-10-02: both directions × link + room, all terminal in 16–19 s, no deadlock; the Max side's hint is lost when the peer gives up first — [ux-fixes.md](docs/history/ux-fixes.md) § UX bugs)* — one side **Max-privacy**, the other **Reliable**. Run it in
      **both directions** (swap which side creates, so each side gets to be the offerer) and on **both
      the room and the link method**. Expected: **no deadlock** — this is the `pendingPeerSignals` fix
      (a Reliable answerer still fetching TURN creds used to silently drop the offer). Either it
      connects directly, or the Max-privacy side fails closed with the hint — never a stuck "agreeing
      on keys".
- [x] **C4 · Max-privacy never relays** *(PASS 2026-10-02: no `turn-request` from the Max side in any of 4 runs, nothing relayed; control = the LAN runs that connected direct)* — — verifies the 2026-09-12 audit fix.** During C3 confirm on the
      Max-privacy side that **no `turn-request` frame is sent** (devtools → WS → Messages). Then force the
      DIRECT path to fail while the peer stays Reliable (easiest: put both on mobile networks, or use a
      restrictive Wi-Fi) and read the Max side's **selected candidate pair** in `chrome://webrtc-internals`.
      Expected: **terminal `failed` + the switch-to-Reliable hint**, and no relayed selected pair. The
      audit found that ICE can LEARN the peer's relay address as a `prflx` candidate even though we drop
      the signalled `typ relay` one; the fix refuses such a path at channel-open, before any byte. So:
      **`failed` ⇒ the fix works**; a **connection whose selected remote candidate is `relay`, or `prflx`
      at the peer's TURN address, means the gate did not catch it** — capture the full candidate-pair
      table and reopen [security-audits.md](docs/history/security-audits.md) § Security audit / Findings.
      Worth pairing with a control: the same Max ↔ Reliable run where the direct path DOES work must
      still connect normally (the gate must not reject a legitimate `prflx` from a NAT mapping).
- [x] **C6 · volume padding, and what it costs on a real link — NEW 2026-09-17.** *(✅ 2026-10-03 on the iPhone: 300 KiB → 524 371 B on the wire (+70.7 %), 50 MB → +0.7 % at 4.0 MB/s, files the real size — but the path was not recorded and was probably the USB cable, not LTE, so the cellular cost is still unmeasured; [the 2026-10-03 run log](docs/test-runs/2026-10-03.md), the C6 caveat)* In Max privacy the
      transfer is padded so its byte count lands on a bucket edge instead of naming the file
      (`core/transfer/padding.ts`): powers of two below 1 MiB, then ≤12.5% overhead. Send a **300 KiB**
      file (ladder: → 512 KiB, a 70% jump no chunking accident could produce) and a **~50 MB** file
      over **LTE**, in Max privacy. Expected: both arrive byte-identical, and the received file is the
      REAL size — the filler is never written. In `chrome://webrtc-internals` the data-channel
      `bytesSent` should show the padded volume, not the file size.
      **What this case is really for is the cost.** Headless tests prove the arithmetic; only a real
      cellular link shows whether the overhead is acceptable to someone paying per megabyte. Record
      the wall-clock and the byte counts for both sizes, padded vs the file. If the small-file case
      feels slow on LTE, `PAD_FLOOR` / `BUCKETS_PER_OCTAVE` are the two constants to reconsider — that
      is a product decision the numbers should inform.
- [x] **C5 · mobile-to-mobile** *(DROPPED by the owner 2026-10-03: both handsets have each been paired with the Mac across networks — Max fails closed, Reliable relays — and a phone↔phone pair would add only a second carrier NAT on the same relay)* — IPH (LTE) ↔ AND-1 (different LTE / other Wi-Fi), Reliable. The
      carrier-NAT-to-carrier-NAT case the desktop pair never exercises.

## Phase D — room lobby (mesh) · entirely T1

- [x] **D1 · roster** — MBP-A creates a room; IPH, AND-1, AND-2 join. Expected: every member sees the
      others by readable id and join time, in join order; leaving a device removes its row. *(Reworded
      2026-09-27: the coarse device label the plan used to expect is gone from the protocol — owner's
      decision, [ux-fixes.md](docs/history/ux-fixes.md) § UX bugs — after the redesign had already stopped rendering it. The 2026-09-27
      tick checked exactly the id + join time.)*
- [x] **D2 · joiner ↔ joiner** — IPH connects to AND-1 (neither is the creator). Expected: it pairs and
      completes SAS normally. The TRANSPORT role (who offers) still comes from the id order, which is
      why this case exists; the SAS reader/picker split no longer does (see A4), so check here too
      that exactly one side reads.
- [x] **D3 · busy reject** — while IPH↔AND-1 are paired, MBP-A presses Connect on IPH. Expected: MBP-A
      gets a clear **busy notice and returns to the lobby** — no hang, no silent failure.
- [x] **D4 · two independent pairs** — pair IPH↔AND-1 and MBP-A↔AND-2 **in the same room**, then
      transfer on both at once. Expected: both work; neither pair's per-pair signaling close disturbs
      the other; the room survives.
- [x] **D5 · SAS mismatch** — on a fresh pair, deliberately pick the **wrong** phrase. Expected: a hard
      failure with a clear message; no transfer possible afterwards.

## Phase E — reconnect (codeless since 2026-09-25: tap Reconnect on both, no code) · T1, except E6/E7 on real devices

- [x] **E1 · pin created** — after any successful fresh pairing (A1–A4), both devices list the peer
      under recent devices, **once** (the dedup-by-peer-key fix — pair the same two devices 3 times and
      confirm still exactly one row).
- [x] **E2 · reconnect happy path** — on MBP-A tap **Reconnect** on the IPH row; MBP-A shows "Waiting
      for the other device" with **no code anywhere**. On IPH tap **Reconnect** on the MBP-A row.
      Expected: `connected` **without any SAS screen** (pin-based re-auth), then transfer works. In
      devtools → WS on either side: the socket URL carries `room=<22-char token>&codeType=token` and
      no `create=1` — the same shape as a link (this is the "server cannot tell a reconnect from a
      first meeting" claim; record it).
- [x] **E3 · order does not matter** — repeat E2 with IPH tapping first and MBP-A a minute later, and
      once more tapping both within a second of each other. Expected: `connected` every time. (Under
      the old by-code design "both press Start" opened two rooms that never met; that is the bug this
      case now proves gone.)
- [x] **E4 · nobody came** — tap Reconnect on MBP-A only. Expected: the wait screen, then after
      **10 minutes** a clear "The other device did not show up" failure — never a silent spinner.
      Meanwhile in devtools → WS: the socket is re-taken every ~2 minutes (a fresh room, same token
      within the 10-minute bucket; a new token at a bucket boundary). Also try: MBP-A on Reconnect
      while IPH does a **plain room join** with any 4-digit code — expected: nothing meets, MBP-A ends
      the same way; no hang, no handshake mismatch (there is no shared room to mismatch in).
- [x] **E6 · reconnect over a SLOW link** *(PASS 2026-10-02: 5/5 in 5.4–6.7 s, Pixel 5 behind a VPN in France ↔ Mac, relay both ways — the link is slow but not cellular; [the 2026-10-02 run log](docs/test-runs/2026-10-02.md))* — the case the 2026-09-17 race lived in.** An early reconnect
      frame (today the `reconnect-hello` both sides send at channel-open) used to be dropped for good
      when it arrived before the receiving side had processed channel-open, leaving both peers in
      "agreeing on keys" until the 120 s deadline. It is fixed (held and replayed), and the window
      widens when the channel-open path is slow — which is exactly what a phone on a weak cellular
      signal produces. So: reconnect **IPH on LTE with one bar (or with the Network Link Conditioner on
      a bad profile) ↔ MBP-A**, five times. Expected: `connected` without a SAS screen, every time. Any
      run that sits in "agreeing on keys" and then fails at ~120 s is the same bug returning — capture
      the DEV log, which names which guard dropped what (`reconnect: dropped …` / `holding …` /
      `replaying held …`).
- [x] **E5 · the other side forgot the pairing** — on IPH press **forget** (clears pins), then tap
      Reconnect on MBP-A using the stale row. Expected: IPH has no row to tap and cannot derive the
      rendezvous; MBP-A waits and ends in "did not show up" (E4), whose copy says to pair afresh. Then
      pair afresh by any method (A1–A4): expected `connected`, and afterwards MBP-A lists IPH **once**
      (the dedup) — a reconnect from that new row works. **Never a silent auto-accept.** (The
      key-changed hard stop itself — a peer presenting a DIFFERENT key under the SAME pairing — cannot
      be produced on real devices without the DEV forge knob; it is covered by the e2e.)
- [x] **E7 · clock skew — NEW 2026-09-25.** *(PASS 2026-10-02 on the Pixel 5: +4 min met in 4.1 s; +15 min never met, both sides "did not show up" at 603 s with six rendezvous takes each — [the 2026-10-02 run log](docs/test-runs/2026-10-02.md))* The rendezvous is derived from each device's OWN clock in
      10-minute buckets. Set IPH's clock **+4 minutes** by hand (disable automatic time), then E2.
      Expected: they still meet — at worst after a delay of up to the skew (each side re-derives at
      its own bucket boundary), never a failure. Then set it **+15 minutes** (more than a bucket):
      expected: they meet only once the wait has absorbed the skew, or MBP-A ends in "did not show
      up" at 10 minutes — record which, this is the stated limit. Restore automatic time.

## Phase F — real-world robustness · mixed: F3/F5/F6/F7 are T1, the rest need a radio or a dialog

- [x] **F1 · phone screen lock / app switch mid-transfer** *(Android half ✅ 2026-10-02/03 on the Pixel 5: the 200 MB receive ran on under the locked screen, the finished row showed "arrived in the background — Save file", one tap landed it in Downloads with the right SHA-256; IPH ❌→✅ 2026-10-03: iOS Safari tears the connection down on screen lock (both sides "Connection lost" within 17 s); MITIGATED the same day by a Screen Wake Lock requested inside the Accept / Send tap (`bf485ae`) — a 3 GiB receive with Auto-Lock at 30 s ran to Delivered with the phone untouched; a deliberate lock or an app switch still ends it (measured), and the transfer screen says so)* — start a ≈200 MB transfer to IPH, then lock
      the screen / switch apps for ~30 s and come back. Expected: either it keeps going or it fails
      visibly with a recoverable state — **iOS suspends background tabs**, so record exactly what
      happens; this is the single most likely real-world surprise. **Since 2026-09-28:** if the file
      completed while the screen was locked, the finished row must show **Save file** (the download was
      held, not lost — the simulator rehearsal lost it silently); tap it and check the file.
- [x] **F2 · network drop** *(PASS 2026-10-02: Pixel 5's Wi-Fi off 20 s mid-600 MB — both sides "Connection lost" 19 s after the cut; an ~8 s cut with nothing in flight recovered by itself — [the 2026-10-02 run log](docs/test-runs/2026-10-02.md))* — mid-transfer, disable Wi-Fi on one side for ~20 s and re-enable.
      Expected: a visible failure or a recovery, never a frozen progress bar that claims to be alive.
- [x] **F3 · tab close** — close the receiver's tab mid-transfer. Expected: the sender notices and shows
      a failure.
- [x] **F4 · large transfer** *(DROPPED by the owner 2026-10-03: no second computer; the 2 GB-class transfers ran Mac↔phone instead — B10, [the 2026-10-03 run log](docs/test-runs/2026-10-03.md))* — ≈2 GB MBP-A Chrome → MBP-B Chrome (the receiver streams straight into
      Downloads, no dialog — since 2026-09-28). Expected: it completes, memory stays flat, and the
      signaling socket is long gone by then (A6).
- [x] **F5 · code expiry** — create a words session and leave it untouched past its TTL, then try to
      join. Expected: the code is freed — the waiting side is closed out (4010) and a later join gets
      `room not found` (4009), with a readable message rather than a raw code.
- [x] **F6 · history is session-only** — after a few transfers, reload the page. Expected: the transfer
      history is **empty** (in-memory only); `localStorage` holds only lang/theme/privacy prefs.
- [x] **F7 · second joiner on a 1:1 method** — forward the same link/QR to a second device. Expected:
      the one-time link reaches exactly one receiver. Which refusal the second joiner sees depends on
      timing: after the first pair connects, both sockets close and the token room is gone, so the
      second joiner gets the dead-link failure ("the link has expired or was already used") at once;
      the 4002 "room full" bounce is reachable only while the first two are still pairing.
- [x] **F8 · silent peer on the 1:1 confirm path** *(Android half ✅ 2026-10-03: Pixel 5 on a VPN Wi-Fi, Reliable, Wi-Fi cut right after `welcome` — the sender ended in 25 s, the server's `peer-left` beat the 120 s deadline; [the 2026-10-03 run log](docs/test-runs/2026-10-03.md). IPH half CLOSED AS A TOOLING LIMIT 2026-10-03: the "silent peer" needs a hook installed before the page loads, which Safari WebDriver cannot do; the mechanism is proven on the Pixel and headlessly)* — open a link on the receiving device and, the
      instant the connection starts, put that browser in a state where it cannot answer (airplane mode
      works; force-quitting the tab does not — that raises a channel close instead, which is a
      different path). Expected: the SENDER ends in **`failed` within ~120 s**, not an endless
      "agreeing on keys". This deadline is new (2026-09-12); before it, this path had no client-side
      bound at all and only the untrusted server's room TTL ended the wait — a server that simply
      never expired the room hung the client forever. **Time it and write the number down.**
- [x] **F9 · slow mobile network does NOT trip the new deadlines** *(PASS 2026-10-02 on the slow link available — Pixel 5 behind a VPN, relayed: words 5.5 s, room/SAS ×2 — no cellular, the phone has no SIM)* — the mirror of F8 and the risk it
      carries. Repeat A3 (words) and A4 (room/SAS) on a **weak cellular** connection, not Wi-Fi. The
      SAS nonce reveal now waits for the DTLS fingerprints to be pinned, so the handshake has more
      serialised steps than before. Expected: still connects well inside 120 s. If a real phone on a
      real network gets anywhere near the deadline, the deadline is wrong, not the network.

---
