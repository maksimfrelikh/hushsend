#!/usr/bin/env bash
# ============================================================================
# Do the two NAT rules really produce the two behaviours? Measured with probe.ts before any
# browser is involved, so a kernel that treats `masquerade` differently fails HERE, by name,
# instead of as four confusing browser results.
#
#   sudo env "PATH=$PATH" bash tests/nat/net/check.sh      # after up.sh
#
#   cone       one public port for every destination, and only an endpoint that was sent to
#              gets back in (endpoint-independent mapping, port-restricted filtering);
#   symmetric  a different public port per destination.
#
# Leaves both routers as cone. The spec measures again before each case.
# ============================================================================
set -Eeuo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$HERE/lib.sh"
NODE=$(command -v node)

measured=
measure() { # namespace expected-mapping → the probe's JSON in $measured, fails when it differs
  measured=$(ip netns exec "$1" "$NODE" "$HERE/../tools/probe.ts" "$SVC_IP" "$REFLECT_IP2" "$TURN_IP:$TURN_PORT" \
    --expect-mapping "$2" --expect-filtering address-and-port-dependent 2>&1) ||
    nat_fail 'NAT probe' "$1 should be behind a NAT with $2 mapping and port-restricted filtering, measured: $measured"
}

for r in r1 r2; do
  c=nat-c${r#r}
  bash "$HERE/nat-mode.sh" "$r" cone
  measure "$c" endpoint-independent
  cone=$measured
  bash "$HERE/nat-mode.sh" "$r" symmetric
  measure "$c" address-and-port-dependent
  symmetric=$measured
  bash "$HERE/nat-mode.sh" "$r" cone
  measure "$c" endpoint-independent
  again=$measured
  nat_annotate notice "NAT probe: nat-$r" "cone: $cone
symmetric: $symmetric
cone again: $again"
done
