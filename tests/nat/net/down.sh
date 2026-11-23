#!/usr/bin/env bash
# Remove the NAT lab: every process in its namespaces, the coturn container, the namespaces.
# Safe to run when nothing is up (up.sh starts with it).
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

for ns in "${ALL_NS[@]}"; do
  [ -e "/run/netns/$ns" ] || continue
  [ "$ns" = "$NS_TURN" ] || ip netns pids "$ns" 2>/dev/null | xargs -r kill -9 2>/dev/null
done
docker rm -f "$COTURN_CONTAINER" >/dev/null 2>&1
[ -e "/run/netns/$NS_TURN" ] && ip netns pids "$NS_TURN" 2>/dev/null | xargs -r kill -9 2>/dev/null
for ns in "${ALL_NS[@]}"; do
  [ -e "/run/netns/$ns" ] && ip netns del "$ns" 2>/dev/null
done
rm -rf "$NAT_STATE_DIR"
exit 0
