#!/usr/bin/env bash
# ============================================================================
# Set the NAT behaviour of one lab router:   nat-mode.sh <r1|r2> <cone|symmetric>
#
#   cone       `masquerade` — the kernel keeps the source port when it can and reuses one
#              mapping for every destination: endpoint-independent MAPPING. Filtering is
#              conntrack's: only the exact remote address:port that was sent to gets back in
#              (port-restricted). An ordinary home router.
#   symmetric  `masquerade fully-random` — a fresh random port for every destination:
#              address-and-port-dependent mapping. The carrier NAT measured on 2026-11-22.
#
# Only the one `masquerade` statement differs between the two. The filter chains are the same
# in both, and the input drop matters: without it an unsolicited packet to the router's own
# address is confirmed in conntrack, the next outgoing flow from the same port then collides
# with that entry and the kernel remaps it to another port — a cone NAT that stops being one
# the moment the peer's packet arrives first.
#
# Conntrack is flushed, so no mapping survives a switch. Nothing here is trusted by the
# suite: probe.ts measures what the router really does before any browser starts.
# ============================================================================
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

case "${1:-}" in
  r1) ns=$NS_R1 ;;
  r2) ns=$NS_R2 ;;
  *) nat_fail 'nat-mode' "usage: nat-mode.sh <r1|r2> <cone|symmetric> (router: '${1:-}')" ;;
esac
case "${2:-}" in
  cone) masq='masquerade' ;;
  symmetric) masq='masquerade fully-random' ;;
  *) nat_fail 'nat-mode' "usage: nat-mode.sh <r1|r2> <cone|symmetric> (mode: '${2:-}')" ;;
esac

ip netns exec "$ns" nft -f - <<EOF || nat_fail 'nat-mode' "nft refused the $2 ruleset in $ns"
table ip natlab
delete table ip natlab
table ip natlab {
  chain postrouting {
    type nat hook postrouting priority srcnat; policy accept;
    oifname "wan" $masq
  }
  chain input {
    type filter hook input priority filter; policy accept;
    iifname "wan" ct state established,related accept
    iifname "wan" drop
  }
  chain forward {
    type filter hook forward priority filter; policy drop;
    iifname "lan" oifname "wan" accept
    iifname "wan" oifname "lan" ct state established,related accept
  }
}
EOF
ip netns exec "$ns" conntrack -F >/dev/null 2>&1 || nat_fail 'nat-mode' "conntrack -F failed in $ns"
