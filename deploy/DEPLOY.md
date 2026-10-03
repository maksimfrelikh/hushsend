# hushsend — deployment runbook (frontend + nginx) — ✅ LIVE (hushsend.frelikh.dev)

hushsend runs as three services, and each lives in its own repository with its own runbook:

| Service | Repository | Runbook |
|---|---|---|
| the static SPA + the nginx vhost (TLS, `/ws` proxy, security headers) | **hushsend** (this) | this file |
| signaling (Node, loopback `:8080`) + the TURN relay for Reliable mode (coturn) | [hush-signaling-server](https://github.com/maksimfrelikh/hush-signaling-server) | its `deploy/DEPLOY.md` |
| STUN for clients (coturn, `stun-only`, meant for a different operator) | [hushsend-stun-server](https://github.com/maksimfrelikh/hushsend-stun-server) | its `DEPLOY.md` |

The signaling server is **untrusted** — all confidentiality/authenticity is client-side (SAS / PAKE /
DTLS) — so what is deployed here is transport security (TLS), routing (nginx) and the bundle whose
integrity anyone can check (§ *Verifying a deploy*). Artifacts: [`nginx.conf.example`](nginx.conf.example),
[`build-env.sh`](build-env.sh), [`deploy-frontend.sh`](deploy-frontend.sh), [`verify-bundle.sh`](verify-bundle.sh).

---

## 0. Live instance — as deployed (hushsend.frelikh.dev)

First bring-up **2026-06-20** on a VPS; since **2026-08-16** everything runs on the owner's home server
(laptop-server), behind a residential NAT. The box itself — network, firewall, other services,
secrets, deploy history — is described in the owner's private `laptop-server/` notes, not here.

| | |
|---|---|
| OS / nginx / Node | Ubuntu 26.04.1 · nginx 1.28.3 · Node v22 (system `/usr/bin/node`) |
| Frontend | dev clone `~/projects/hushsend`, built on the server by `deploy-frontend.sh` → `/var/www/hushsend/dist` |
| nginx vhost | `/etc/nginx/sites-available/hushsend` from [`nginx.conf.example`](nginx.conf.example): static `dist/`, SPA fallback, `/ws` + `/health` → `127.0.0.1:8080` with `X-Real-IP`; security headers repeated in every location (verified 6/6 on HTML, JS and `.wasm`, 2026-09-17); `access_log off` everywhere; HTTP/2 on |
| TLS | the box's wildcard `*.frelikh.dev` (certbot DNS-01, Cloudflare plugin) |
| Build-time env | [`build-env.sh`](build-env.sh): `VITE_SIGNALING_URL=wss://hushsend.frelikh.dev/ws`, `VITE_STUN_URLS=stun:turn.hushsend.frelikh.dev:3478` |
| Signaling + TURN | `hushsend-signaling.service` + `coturn.service` — see hush-signaling-server `deploy/DEPLOY.md` § 0 |
| STUN | today the TURN relay's coturn answers it (`turn.hushsend.frelikh.dev:3478`); the separate server (`stun.hushsend.frelikh.dev:3479`) is prepared — hushsend-stun-server `DEPLOY.md` § 6 |
| Router + ufw | 80/443 tcp (nginx), 3478 tcp+udp and 49160–49200 udp (TURN) |

**Repeat frontend redeploys** (signaling/nginx unchanged): `bash ~/projects/hushsend/deploy/deploy-frontend.sh`
pulls, `npm ci`, builds with the live `VITE_*` baked in, and publishes `dist/` to
`/var/www/hushsend/dist`. It restarts nothing (a static-asset swap needs no restart), uses `sudo`
only if the web root were unwritable (it is not), and swaps the new build in with a rename: the
previous one stays as `dist.old` until the smoke check passes, so a rollback is
`mv dist dist.bad && mv dist.old dist`.

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
# Needs nothing but curl: asks GitHub's PUBLIC attestation API whether the bytes you were served
# carry a signed provenance statement. No account, no token, no manifest to obtain from anyone.
bash deploy/verify-bundle.sh --attest

# Pin to a specific CI run's manifest instead:
bash deploy/verify-bundle.sh --manifest <manifest from the CI run for the deployed commit>

# Or, with no manifest, just print what the live site is serving:
bash deploy/verify-bundle.sh
```

`--attest` discovers the files from `index.html`, which does not name the lazily-fetched QR decoder
`.wasm` (its path lives inside the JS). Combine the two flags to cover the whole tree:
`--attest --manifest MANIFEST.sha256`.

`deploy-frontend.sh` writes the hashes it published to `MANIFEST.sha256` in the repo root — **outside
`dist/`** on purpose: a file inside the published tree that CI does not build would make the deployed
tree differ from the attested one, manufacturing the very mismatch this is meant to detect.

Running the verifier **on this host** is nearly worthless — it would be the suspect checking itself.
Its value is someone else running it from somewhere else. Read the header of
`deploy/verify-bundle.sh` for what the check does and does not prove before relying on it.

---

## 2. Signaling server and TURN relay

Both live in [hush-signaling-server](https://github.com/maksimfrelikh/hush-signaling-server) — install,
updates (`deploy/deploy.sh`), the TURN config (`deploy/turn/install.sh`, which renders coturn's
`static-auth-secret` from the signaling `TURN_SECRET` so the two cannot drift) and the relay check
(`deploy/turn/verify-relay.sh`). Until 2026-10-03 this repo carried a copy of the server in `server/`
and the coturn template in `deploy/`; both had drifted from what ran and were removed.

What this side has to get right is the pairing with nginx: `TRUST_PROXY=1` in the signaling `.env`
needs `proxy_set_header X-Real-IP $remote_addr;` in `location /ws` (§ 4), or every client looks like
127.0.0.1 and the per-IP limits collapse.

## 3. STUN

[hushsend-stun-server](https://github.com/maksimfrelikh/hushsend-stun-server): coturn with `stun-only`,
its own unit and installer, meant to end up under a different operator than signaling. Clients are
pointed at it by `VITE_STUN_URLS` in [`build-env.sh`](build-env.sh) — a build-time value, so switching
means a rebuild and a frontend redeploy.

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
- `turn.hushsend.frelikh.dev` → the **TURN relay** (the host in the signaling `TURN_URLS`).
- `stun.hushsend.frelikh.dev` → the **STUN server** (the host in `VITE_STUN_URLS`), once it runs.
  DNS only, no Cloudflare proxy: the proxy carries HTTP, not UDP.

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
   > relay (`forceIceFail` is DEV-only and not in the prod build).
   >
   > **So confirm the relay itself, separately — one command, and it is not optional:**
   >
   > ```bash
   > bash /var/www/hush-signaling-server/deploy/turn/verify-relay.sh
   > ```
   >
   > It mints a credential from the LIVE signaling server exactly as a browser does, opens a real
   > allocation on the coturn that `TURN_URLS` advertises, and requires bytes to come back. This is
   > the only check that catches `TURN_SECRET` drifting from coturn's `static-auth-secret` — a drift
   > that leaves every visible symptom green (the mint succeeds, the client builds a TURN iceServer,
   > the UI still says Reliable) and breaks the relay only for the users whose direct path already
   > failed. Run it after every deploy and after touching either config. It never reads or prints the
   > secret. (The same invariant is pinned in hush-signaling-server's CI by `tests/turn-relay.test.ts`,
   > against a coturn it spawns itself — but CI cannot see THIS host's config.)
6. **Per-IP accounting works (not loopback-collapsed):** the signaling server's `[config]` line shows
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

- **Shared-NAT / office / mobile networks:** clients behind one public IP divide `IP_RL_MAX` per
  window and can hit a spurious `4011 too many attempts`. The knob is in the signaling `.env`
  (hush-signaling-server); BACKLOG § Pre-launch review has the open question.
- **Second app (hushclip):** the same signaling server serves it (distinguished by `?app=`); add an
  analogous nginx site (own cert + `dist/`, same `/ws` proxy) when its frontend exists — see the
  footer of `nginx.conf.example`.
- **Secrets:** none in this repository. The signaling `.env` (with `TURN_SECRET`) lives in the
  signaling checkout on the host; coturn's copy is rendered from it there.
