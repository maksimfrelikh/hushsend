#!/usr/bin/env bash
# ============================================================================
# The NAT suite, start to finish, on a Linux machine:
#
#   sudo env "PATH=$PATH" bash tests/nat/run.sh
#
# Builds the app FOR THE LAB into dist/ (the signaling and STUN addresses are compiled in, so
# this is not a deployable build — deploy/deploy-frontend.sh makes its own), raises the lab,
# checks the NAT rules, runs the five cases and removes the lab again. Needs root (network
# namespaces), docker (coturn), nftables, conntrack, and `npx playwright install chromium`.
# CI runs the same steps one by one: .github/workflows/nat.yml.
# ============================================================================
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$HERE/../.."
. "$HERE/net/lib.sh"

[ "$(uname -s)" = Linux ] || nat_fail 'NAT suite' 'network namespaces need Linux — on other systems run it in CI (.github/workflows/nat.yml)'
[ "$(id -u)" = 0 ] || nat_fail 'NAT suite' 'run as root: sudo env "PATH=$PATH" bash tests/nat/run.sh'

# Build as the invoking user where there is one, so dist/ and the caches stay theirs.
as_user=()
[ -n "${SUDO_USER:-}" ] && as_user=(sudo -u "$SUDO_USER")
"${as_user[@]}" env "PATH=$PATH" \
  VITE_SIGNALING_URL="ws://127.0.0.1:$SIGNALING_PORT" VITE_STUN_URLS="stun:$TURN_IP:$TURN_PORT" \
  VITE_NAT_CHECK_STUN_URL="stun:$TURN_IP:$NAT_CHECK_PORT" \
  npm run build

trap 'bash "$HERE/net/down.sh"' EXIT
bash "$HERE/net/up.sh"
bash "$HERE/net/check.sh"
if [ -n "${SUDO_USER:-}" ] && [ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" ]; then
  export PLAYWRIGHT_BROWSERS_PATH="$(getent passwd "$SUDO_USER" | cut -d: -f6)/.cache/ms-playwright"
fi
npx playwright test -c tests/nat/playwright.config.ts
