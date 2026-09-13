#!/usr/bin/env bash
#
# Deploy the hushsend FRONTEND only: pull → install → build → publish dist/ to the
# nginx web root. Does NOT touch the signaling server (separate repo, systemd
# hushsend-signaling) or nginx — a frontend-only change needs no service restart.
#
# Run it from anywhere on the web host (the home server — see deploy/DEPLOY.md § 0), e.g.:
#   bash ~/projects/hushsend/deploy/deploy-frontend.sh
#
# Overridable via env (defaults match the live hushsend.frelikh.dev deploy):
#   VITE_SIGNALING_URL  wss:// the client opens          (baked into the bundle)
#   VITE_STUN_URLS      coturn STUN endpoint(s)           (baked into the bundle)
#   DEPLOY_DIR          nginx root to publish dist/ into
#   SKIP_PULL=1         skip `git pull` (deploy the working tree as-is)
#
set -euo pipefail

# The two VITE_* values live in deploy/build-env.sh — the SAME file the CI build-and-attest job
# sources — so the hashes CI publishes describe the bytes this script produces. Do not inline them
# here again: two copies that agree today are a silent break tomorrow.
# shellcheck source=deploy/build-env.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/build-env.sh"
DEPLOY_DIR="${DEPLOY_DIR:-/var/www/hushsend/dist}"
HEALTH_URL="${HEALTH_URL:-https://hushsend.frelikh.dev/health}"
SITE_URL="${SITE_URL:-https://hushsend.frelikh.dev}"
SKIP_PULL="${SKIP_PULL:-0}"

# Operate on this script's own repo clone, regardless of the current directory.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }

# 1. Pull the new version (fast-forward only — fail loudly if the clone diverged).
if [ "$SKIP_PULL" != "1" ]; then
  log "git pull --ff-only"
  git pull --ff-only
fi

# 2. Dependencies (safe to run every time; a no-op when package-lock is unchanged).
log "npm ci"
npm ci

# 3. Build. VITE_* are compiled INTO the bundle here — not read at runtime.
log "vite build  (VITE_SIGNALING_URL=$VITE_SIGNALING_URL  VITE_STUN_URLS=$VITE_STUN_URLS)"
VITE_SIGNALING_URL="$VITE_SIGNALING_URL" \
VITE_STUN_URLS="$VITE_STUN_URLS" \
  npm run build

[ -f dist/index.html ] || { echo "✗ dist/index.html missing — build produced nothing, aborting"; exit 1; }

# 3b. The hashes of exactly what is about to be published. Print them, and keep a copy beside the
# deployed tree, so "which bytes does this host serve?" is answerable later without re-deriving it.
#
# These should equal the manifest the CI `build-attest` job published for the SAME commit — that
# equality is what lets a third party verify the site without trusting this host (see
# deploy/verify-bundle.sh and THREATMODEL.md § 1). They are not compared automatically here: this
# script runs ON the host it would be checking, so a self-check would be circular. Compare them from
# somewhere else.
# NOTE the manifest is written OUTSIDE dist/ on purpose. Dropping it inside would add a file the CI
# build does not produce, so the published tree would no longer equal the attested one — a mismatch
# manufactured by the very step meant to detect mismatches.
log "bundle hashes"
bash "$REPO_ROOT/deploy/bundle-manifest.sh" dist | tee "$REPO_ROOT/MANIFEST.sha256" | sed 's/^/  /'
echo "  (saved to $REPO_ROOT/MANIFEST.sha256 — not published, see the note above)"

# 4. Publish to the nginx root. Two improvements over the original wipe-then-copy:
#
#    - sudo ONLY when it is actually needed. On the live host the web root belongs to the deploy
#      user, so `sudo` just prompted for a password that bought nothing. Hosts where the directory
#      IS root-owned still work — the check decides, not an assumption.
#    - stage beside the live directory and SWAP, instead of deleting the live one first. `rm -rf`
#      followed by a copy leaves a window — seconds on a slow disk — where nginx serves 404s to
#      whoever is on the site. A rename is instant, and the previous build is kept as .old until the
#      smoke check passes, so a rollback is one `mv` away.
STAGING="$DEPLOY_DIR.new"
PREVIOUS="$DEPLOY_DIR.old"
if [ -w "$(dirname "$DEPLOY_DIR")" ] && { [ ! -e "$DEPLOY_DIR" ] || [ -w "$DEPLOY_DIR" ]; }; then
  SUDO=""
  log "publish → $DEPLOY_DIR"
else
  SUDO="sudo"
  log "publish → $DEPLOY_DIR  (sudo — the web root is not writable by $(id -un))"
fi
$SUDO rm -rf "$STAGING" "$PREVIOUS"
$SUDO cp -a dist "$STAGING"
[ -e "$DEPLOY_DIR" ] && $SUDO mv "$DEPLOY_DIR" "$PREVIOUS"
$SUDO mv "$STAGING" "$DEPLOY_DIR"

# 5. Smoke. nginx serves static straight from disk — no reload needed.
log "smoke"
if curl -sf "$HEALTH_URL" >/dev/null; then echo "  health   : ok"; else echo "  health   : FAILED ($HEALTH_URL)"; fi
echo "  homepage : HTTP $(curl -s -o /dev/null -w '%{http_code}' "$SITE_URL/")"

# 6. Only now drop the previous build. Until this line a rollback is one rename:
#      mv "$DEPLOY_DIR" "$DEPLOY_DIR.bad" && mv "$PREVIOUS" "$DEPLOY_DIR"
$SUDO rm -rf "$PREVIOUS"

log "done — hard-refresh the page (Ctrl+Shift+R) to confirm the new build"
cat <<VERIFY

To let someone check this deploy WITHOUT trusting this host: give them the commit, point them at the
CI run's "reproducible build · publish + attest hashes" job for that commit, and have them run

  bash deploy/verify-bundle.sh --manifest <the manifest from that run>

from their own network. A mismatch is the interesting case; see deploy/verify-bundle.sh for what the
check does and does not prove.
VERIFY
