# hushsend — deployment checklist (step 6f) — ✅ LIVE (hushsend.frelikh.dev)

Live-instance bring-up for **hushsend.frelikh.dev**. The app is feature-complete (6a–6d done);
this is the ops runbook + the artifacts it needs. The signaling server is **untrusted** — all
confidentiality/authenticity is client-side (SAS / PAKE / DTLS) — so the steps below are transport
security (TLS), routing (nginx), and abuse hygiene (X-Real-IP, rate-limits, coturn quotas), **not**
auth.

Artifacts referenced here: [`nginx.conf.example`](nginx.conf.example) ·
[`../server/.env.example`](../server/.env.example) · [`coturn.conf.example`](coturn.conf.example).
Config cross-reference: **CLAUDE.md § Deployment / configuration**.

Topology: one web host (nginx + static `dist/` + the loopback Node signaling server) plus coturn —
generically a **separate** host, though the live deploy runs coturn on the SAME box (see § 0).
nginx terminates TLS, serves the SPA, and reverse-proxies the WebSocket to `127.0.0.1:8080`.

---

## 0. Live instance — as deployed (hushsend.frelikh.dev)

✅ **LIVE and externally verified.** History in one line: first bring-up **2026-06-20** on a VPS
(`frelikhmax.fvds.ru`); the live instance **moved to the owner's home server on 2026-08-16** and that
is what serves hushsend today. Everything below was re-verified on the box on **2026-09-12**. The
realized layout differs from the generic topology above in three ways, plus the pinned specifics
table:

- **A home server behind a residential NAT**, not a VPS. The router must forward **80/443 tcp**,
  **3478 tcp+udp**, and the coturn **relay range 49160–49200/udp** to the box (ufw allows the same
  set), and coturn MUST set `external-ip=<public-ip>/<lan-ip>` — without it the relay advertises the
  private address and no remote peer can ever use it.
- **coturn on the SAME host** as nginx (not a separate host), `turn:`-only on **:3478**, **no
  `turns:`/TLS** (no 5349, no extra cert). STUN and TURN both come from this one coturn; STUN and the
  full relay path were verified with `turnutils_stunclient` / `turnutils_uclient` (0% packet loss).
- **Signaling = its own repo** (`hush-signaling-server`, the universal multi-app server — NOT the
  `server/` dir in this repo). The repo clone is at `~/projects/hush-signaling-server`; the **running
  copy is `/var/www/hush-signaling-server`**, which is what the unit points at.

Pinned specifics (ssh-verified 2026-09-12):

| | |
|---|---|
| OS / nginx / Node | Ubuntu 26.04.1 LTS · nginx 1.28.3 (apt) · Node **v22.22.1, system** (`/usr/bin/node` — not nvm, so no absolute nvm path to maintain in the unit) |
| Frontend | repo `~/projects/hushsend`, built on-server → published to `/var/www/hushsend/dist` |
| Signaling | systemd `hushsend-signaling.service` on `127.0.0.1:8080` (unit below) |
| TLS | **wildcard `*.frelikh.dev`** (`/etc/letsencrypt/live/frelikh.dev/`, certbot **DNS-01** via the cloudflare plugin), shared with the box's other sites — NOT a per-host webroot cert |
| Build-time env | `VITE_SIGNALING_URL=wss://hushsend.frelikh.dev/ws` · `VITE_STUN_URLS=stun:turn.hushsend.frelikh.dev:3478` (both confirmed present in the deployed bundle) |
| Server env | `HOST=127.0.0.1` · `PORT=8080` · **`TRUST_PROXY=1`** · `TURN_URLS=turn:turn.hushsend.frelikh.dev:3478` · `TURN_CRED_TTL_S=3600` · `FILETRANSFER_MAX_PEERS=8` · `IP_RL_MAX=60` |
| DNS | `hushsend.frelikh.dev` → the box · `turn.hushsend.frelikh.dev` → the same box (coturn) |

- **HTTP/2 is ON** — corrected 2026-09-12. The earlier note here said it was off, read off the plain
  `listen 443 ssl;` line while missing the standalone `http2 on;` directive on the next line; `curl`
  against the live host negotiates HTTP/2. (The old template caveat — `http2 on;` needs nginx ≥1.25.1
  and the first host ran 1.24 — no longer applies: nginx is 1.28 and both forms work.)
- **Security headers do NOT reach `/assets/` or `.wasm`.** Verified 2026-09-12: the HTML carries all
  five (CSP, HSTS, nosniff, Referrer-Policy, X-Frame-Options), the JS bundle carries only
  `cache-control`. nginx applies inherited `add_header` directives only when the current level defines
  none, and both of those locations define their own `add_header Cache-Control`. Low impact — the
  DOCUMENT's CSP is what governs script execution and it is intact — but `nosniff` is lost there and
  the next server-level header anyone adds will vanish the same way. See BACKLOG § Ops.
- **`/ws` and `/` use nginx's default `combined` access log**, which writes the client IP, the full
  User-Agent and the rendezvous code for every connection. That works against the coarse-device-label
  design; `access_log off;` (or a stripped `log_format`) on both locations closes it. See BACKLOG § Ops.
- **Ops source of truth for the box itself** — network, firewall, the other services sharing it,
  secrets, deploy history — lives OUTSIDE this repo, in the owner's `laptop-server/` notes. This file
  covers only what hushsend needs.

systemd unit actually in use:

```ini
# /etc/systemd/system/hushsend-signaling.service
[Unit]
Description=hushsend signaling server
After=network.target

[Service]
Type=simple
User=frelikh
Group=frelikh
WorkingDirectory=/var/www/hush-signaling-server
EnvironmentFile=/var/www/hush-signaling-server/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node signaling-server.js
Restart=on-failure
RestartSec=2

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

External smoke — all green: security headers (HSTS/CSP/Permissions-Policy/nosniff/Referrer/X-Frame);
`GET /health` → `ok`; `http` → `301 https`; `/assets/*.js|css` immutable-cached; **`/assets/*.wasm`
→ `application/wasm`** (the QR-scan compile path); `/ws` → `426 Upgrade Required` (reaches Node, not
served as static); unknown deep-link → `200` (SPA fallback). Re-checked 2026-09-12: `/` → 200,
`/health` → `ok`, all three units (`nginx`, `hushsend-signaling`, `coturn`) active. **Still pending:**
the in-browser P2P/SAS/transfer test on two devices, and a cross-network TURN relay check (only
provable across different networks).

**Repeat frontend-only redeploys** (new SPA build, signaling/nginx unchanged) are wrapped in
[`deploy-frontend.sh`](deploy-frontend.sh): `bash ~/projects/hushsend/deploy/deploy-frontend.sh`
pulls, `npm ci`, builds with the live `VITE_*` baked in, and publishes `dist/` to
`/var/www/hushsend/dist`. It does NOT restart the signaling service or reload nginx (a static-asset
swap needs neither).

**No password on this host:** `/var/www/hushsend` belongs to the deploy user, so the script uses
`sudo` only if it finds the web root unwritable (which it is not here). And it does not delete the
live directory first — the build is staged beside it and swapped in with a rename, so nobody gets a
404 mid-deploy, and the previous build stays as `dist.old` until the smoke check passes. Rolling back
is therefore a rename, not a rebuild:
`mv dist dist.bad && mv dist.old dist`. The numbered steps below are the full generic runbook; the live deploy followed
them with the deltas above.

---

## 1. Build the SPA (with production env)

Vite bakes `VITE_*` in at **build time** — there is no runtime client config.

```sh
# In the repo root. The two values live in deploy/build-env.sh — the SAME file the CI build job
# sources, so the hashes CI publishes describe the bytes you produce. Override from the environment
# for a fork or a staging host; do not fork the file.
. ./deploy/build-env.sh
npm run build            # = tsc --noEmit && vite build → emits dist/
```

> **Do not inline the VITE_* values here again.** They are compiled INTO the bundle, so they are part
> of its identity: a bundle built with a different signaling URL is a different bundle with a
> different hash. Two copies that agree today drift tomorrow, and the drift looks exactly like
> tampering to anyone verifying the site.

The build is **byte-for-byte reproducible**, and that is load-bearing rather than a nicety — see
§ *Verifying a deploy* below. `deploy/deploy-frontend.sh` does all of the above plus the publish and
prints the hashes it deployed.

> **GOTCHA — STUN is not optional cross-network.** Default privacy mode is **Max-privacy**, which is
> **STUN-only** (never contacts TURN). With `VITE_STUN_URLS` empty, Max-privacy has *no* ICE server
> at all → two peers on different networks can't discover routable candidates and **never connect**
> (loopback tabs work on host candidates, masking this in dev). Always set `VITE_STUN_URLS` to your
> coturn STUN for a real deploy.
>
> **GOTCHA — rebuild on host change.** `VITE_SIGNALING_URL` is compiled in; if you move hosts you
> must rebuild, not just edit nginx. It must match the nginx server_name in the CSP `connect-src`.

Deploy the resulting `dist/` to the nginx `root` (e.g. `/var/www/hushsend/dist`).

### Verifying a deploy (and why it is not optional)

THREATMODEL.md § 1 ranks code delivery as the dominant risk: this host serves both the app and the
signaling WebSocket, so whoever controls it can serve a modified bundle and every other guarantee in
the product stops meaning anything. CSP does not help — this host emits the CSP header too.

The counterweight is that a **different party** states what the bytes should be. Every push runs the
CI job *reproducible build · publish + attest hashes*, which builds on a GitHub runner, refuses to
pass unless two builds of the commit are byte-identical, publishes a SHA-256 manifest in the public
run summary, and signs a provenance attestation into a public transparency log.

```sh
# From ANY machine — ideally not this one, and ideally more than one network.
bash deploy/verify-bundle.sh --manifest <manifest from the CI run for the deployed commit>

# Or, with no manifest, just print what the live site is serving:
bash deploy/verify-bundle.sh
```

`deploy-frontend.sh` writes the hashes it published to `MANIFEST.sha256` in the repo root — **outside
`dist/`** on purpose: a file inside the published tree that CI does not build would make the deployed
tree differ from the attested one, manufacturing the very mismatch this is meant to detect.

Running the verifier **on this host** is nearly worthless — it would be the suspect checking itself.
Its value is someone else running it from somewhere else. Read the header of
`deploy/verify-bundle.sh` for what the check does and does not prove before relying on it.

---

## 2. Run the signaling server (loopback, under a process manager)

```sh
cd server
npm ci --omit=dev                       # installs `ws`
cp .env.example .env && $EDITOR .env    # fill in — esp. TRUST_PROXY=1, TURN_SECRET, TURN_URLS
```

Run `node signaling-server.js` under **systemd** or **pm2** (auto-restart, boot-start), with the
env from `.env`, bound to `127.0.0.1:8080`.

- **`TRUST_PROXY=1` is mandatory behind nginx** (see step 4 — without the paired `X-Real-IP` header
  every client looks like loopback).
- **Verify the startup log.** The server prints a one-line `[config]` summary on boot — confirm it at
  a glance:
  ```
  Mesh signaling server listening on 127.0.0.1:8080
  [config] env=production trustProxy=on turn=configured(2 urls) maxConnsTotal=5000 maxPerIpPerRoom=2 filetransferMaxPeers=8 roomTtlMs=180000 wordRoomTtlMs=180000 tokenRoomTtlMs=180000 ipRlMax=60/60000ms
  ```
  `trustProxy=on` and (if you deployed coturn) `turn=configured(N urls)` are the two to eyeball. A
  `trustProxy=OFF` warning line means caps/rate-limit will be loopback-blind — fix before going live.
  The secret itself is **never** logged.

> **GOTCHA.** `npm ci` in `server/` not the repo root — the server is self-contained with its own
> `package.json` (only `ws`).

---

## 3. Deploy coturn (separate host)

Use [`coturn.conf.example`](coturn.conf.example) → `/etc/turnserver.conf`:

- **`static-auth-secret` MUST EQUAL the signaling server's `TURN_SECRET`** (the one shared secret;
  coturn recomputes the same HMAC offline — no signaling↔coturn round-trip).
- Set `realm` + `external-ip` (behind 1:1 NAT) + TLS cert for `turns:`.
- **Open the firewall:** `3478/udp`, `3478/tcp`, `5349/tcp` (TLS), **and the relay-port range**
  (`min-port`–`max-port`, default `49160-49200/udp`) — relay allocation fails silently without it.
- Keep the anti-SSRF denies (`no-multicast-peers`, `no-loopback-peers`, RFC1918/link-local
  `denied-peer-ip`) and quotas (`user-quota`, `total-quota`, `max-bps`).

> Leaving coturn undeployed is a valid config: leave `TURN_SECRET` empty → the server reports relay
> unavailable and every client stays direct-only (Max-privacy). Reliable mode just has nothing to
> fall back to.

---

## 4. nginx (TLS + SPA + WS proxy)

Use [`nginx.conf.example`](nginx.conf.example) → `/etc/nginx/sites-available/`, symlink into
`sites-enabled/`, fill `<PLACEHOLDERS>`, then `nginx -t && systemctl reload nginx`.

- **TLS:** `certbot certonly --webroot -w /var/www/certbot -d hushsend.frelikh.dev`; point
  `ssl_certificate{,_key}` at the issued files; the `:80` block keeps the ACME path servable for
  renewals.
- **`proxy_set_header X-Real-IP $remote_addr;` in `location /ws` is the #1 footgun** — pair it with
  `TRUST_PROXY=1`. Without it `clientIp()` falls back to `socket.remoteAddress` = loopback for *all*
  clients: `MAX_CONNS_PER_IP` becomes a single global cap and the 4011 rate-limit (loopback-exempt)
  silently never fires.
- **`proxy_read_timeout` must be well above the 30s WS heartbeat** (template uses `3600s`) or nginx
  severs idle-but-alive signaling sockets mid-rendezvous.
- The WS `Upgrade`/`Connection` headers + `proxy_http_version 1.1` are required for the handshake.
- **`.wasm` must be served as `application/wasm`** — the template pins it with a defensive
  `location ~* \.wasm$ { default_type application/wasm; … }`. The QR-scan fallback (iOS/Firefox, no
  native `BarcodeDetector`) compiles the self-hosted zxing `.wasm` via
  `WebAssembly.instantiateStreaming()`, which **rejects** any Content-Type other than
  `application/wasm`. A stock/modern `mime.types` already maps it, but an old or trimmed one serves it
  as `application/octet-stream` and the streaming compile silently degrades (or errors). Confirm with
  `curl -sI https://hushsend.frelikh.dev/assets/<zxing>.wasm | grep -i content-type` → `application/wasm`.
- The security headers (HSTS / **CSP** / Permissions-Policy / nosniff / Referrer-Policy) are in the
  template — **see the CSP gotcha in step 6.**
- **HTTP/2 syntax is nginx-version-sensitive.** The template enables HTTP/2 via the `http2` PARAMETER
  on `listen 443 ssl http2;` — portable across nginx 1.9.5+ (incl. the 1.24 on Ubuntu 24.04). The
  standalone `http2 on;` directive is **nginx ≥ 1.25.1 ONLY** and errors as `unknown directive
  "http2"` on 1.24; if you hit that, your template predates this fix.

---

## 5. DNS

- `hushsend.frelikh.dev` → the **web host** (nginx).
- `turn.hushsend.frelikh.dev` (whatever host appears in `TURN_URLS` / `VITE_STUN_URLS`) → the
  **coturn host**.

---

## 6. Smoke test

1. **Health:** `curl https://hushsend.frelikh.dev/health` → `ok` (proxied to Node).
2. **SPA:** load `https://hushsend.frelikh.dev` over HTTPS; it renders; HTTP redirects to HTTPS.
3. **WS:** open it in two browsers — DevTools → Network → WS shows a `101 Switching Protocols` to
   `/ws` and `welcome` frames.
4. **Transfer (Max-privacy / direct):** create on one browser, join on the other, complete the SAS,
   send a file. This exercises STUN + direct P2P (no relay).
5. **Reliable / relay:** flip the toggle to Reliable. The client fetches creds (`turn-request` →
   `turn-credentials`) and adds the TURN iceServer.
   > **GOTCHA — a relay path can't be proven on one network.** Two peers on the *same* LAN connect
   > directly even in Reliable (relay is only used when direct fails). To actually verify bytes flow
   > through coturn you need two peers on **different networks** (e.g. one on mobile data) or a forced
   > relay (`forceIceFail` is DEV-only and not in the prod build). Confirm coturn separately via
   > `turnutils_uclient`/`trickle-ice` against your `static-auth-secret`.
6. **Per-IP accounting works (not loopback-collapsed):** the step-2 `[config]` line shows
   `trustProxy=on`; confirm distinct clients are counted per-IP (the caps/4011 limiter act
   per-client, not as one global loopback bucket).

> **GOTCHA — CSP must be verified against the built app, especially the QR-scan path.** The CSP in
> the nginx template is tuned to the current Vite build (external module script + external
> stylesheet, no inline script). Walk **every screen with the DevTools console open** and watch for
> `Refused to …` violations — **above all the QR-scan screen on a non-Chromium browser** (iOS
> Safari / Firefox), where the `barcode-detector` ponyfill compiles zxing **WASM**. The WASM is now
> **self-hosted** (vendored into `dist/assets/` via a Vite asset import — `src/ui/zxingWasm.ts`
> overrides zxing's `locateFile`), so it loads from `'self'` and the CSP needs **no CDN**:
> `connect-src` is `'self' wss://<host>` only, and `'wasm-unsafe-eval'` stays (it permits compiling
> the self-hosted WASM, not fetching it). A QR scan therefore never reaches `fastly.jsdelivr.net`
> (verify in the DevTools Network panel — no jsdelivr request) and `camera=(self)` in
> Permissions-Policy must be present; if the scanner or camera breaks, the console error names the
> directive to adjust. This dovetails with the 6e cross-browser pass (real-device test post-deploy).

---

## Notes

- **Shared-NAT / office networks:** clients behind one public IP divide `IP_RL_MAX` per window. A
  busy network can hit a spurious `4011 too many attempts`. Raise `IP_RL_MAX` in `server/.env` for
  such deploys — it's defense-in-depth only (worst case is a retry; SAS stops a MITM). See
  BACKLOG.md § Deployment behind nginx (6f).
- **Second app (hushclip):** the same signaling server serves it (distinguished by `?app=`); add an
  analogous nginx site (own cert + `dist/`, same `/ws` proxy) when its frontend exists — see the
  footer of `nginx.conf.example`.
- **Secrets:** `server/.env` and the real coturn `static-auth-secret` are git-ignored / never
  committed. Only `server/.env.example` and `coturn.conf.example` (placeholders) are in the repo.
