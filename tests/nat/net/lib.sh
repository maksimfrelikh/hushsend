# shellcheck shell=bash
# ============================================================================
# The NAT lab's names and addresses — sourced by up.sh, down.sh and nat-mode.sh.
# The same values are repeated in ../lab.ts for the spec; keep the two in step.
#
#                         nat-inet  ("the internet": a plain router, no NAT)
#                         lo: 192.0.2.1  signaling :8080 · the built app :5173 · reflector
#                             192.0.2.2 / 192.0.2.3  the reflector's other addresses
#            ┌───────────────────┼─────────────────────┐
#        nat-turn             nat-r1                 nat-r2
#        coturn (STUN+TURN)   wan 198.51.100.2       wan 203.0.113.2     ← NAT (nftables)
#        192.0.2.10           lan 192.168.1.1        lan 192.168.2.1
#                                │                      │
#                             nat-c1                 nat-c2
#                             192.168.1.2            192.168.2.2         ← one browser each
#
# Public addresses are the three documentation ranges (RFC 5737): nothing in the
# TURN template's denied-peer-ip list, nothing that routes anywhere real.
# ============================================================================

NS_INET=nat-inet
NS_TURN=nat-turn
NS_R1=nat-r1
NS_R2=nat-r2
NS_C1=nat-c1
NS_C2=nat-c2
ALL_NS=("$NS_C1" "$NS_C2" "$NS_R1" "$NS_R2" "$NS_TURN" "$NS_INET")

SVC_IP=192.0.2.1
REFLECT_IP2=192.0.2.2
REFLECT_IP3=192.0.2.3
INET_TURN_IP=192.0.2.9
TURN_IP=192.0.2.10
INET_R1_IP=198.51.100.1
R1_WAN_IP=198.51.100.2
INET_R2_IP=203.0.113.1
R2_WAN_IP=203.0.113.2
R1_LAN_IP=192.168.1.1
C1_IP=192.168.1.2
R2_LAN_IP=192.168.2.1
C2_IP=192.168.2.2

SIGNALING_PORT=8080
APP_PORT=5173
TURN_PORT=3478
TURN_SECRET=nat-lab-turn-shared-secret
COTURN_CONTAINER=nat-coturn

# Everything the lab writes at run time: logs, pid files, the rendered coturn config.
NAT_STATE_DIR=${NAT_STATE_DIR:-/tmp/hushsend-nat}

# One line a person (or the public check-runs API) can read without the job log: on GitHub Actions
# an ::error:: annotation, elsewhere stderr. Newlines are encoded the way workflow commands want.
nat_annotate() { # level title message
  local msg=$3
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    msg=${msg//'%'/%25}
    msg=${msg//$'\r'/%0D}
    msg=${msg//$'\n'/%0A}
    printf '::%s title=%s::%s\n' "$1" "$2" "$msg"
  else
    printf '[%s] %s: %s\n' "$1" "$2" "$msg" >&2
  fi
}
nat_fail() { # title message
  nat_annotate error "$1" "$2"
  exit 1
}
