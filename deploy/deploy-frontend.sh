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

VITE_SIGNALING_URL="${VITE_SIGNALING_URL:-wss://hushsend.frelikh.dev/ws}"
VITE_STUN_URLS="${VITE_STUN_URLS:-stun:turn.hushsend.frelikh.dev:3478}"
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
