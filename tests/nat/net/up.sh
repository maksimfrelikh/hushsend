#!/usr/bin/env bash
# ============================================================================
# Build the NAT lab (the map is in lib.sh) and start what runs in it:
#
#   sudo env "PATH=$PATH" bash tests/nat/net/up.sh      # Linux, root, after `npm run build`
#
#   - five network namespaces wired with veth pairs, two of them routers that NAT (nat-mode.sh);
#   - coturn — the image the relay runs in production, pinned in hush-signaling-server's
#     deploy/turn/lib.sh, with that repository's turnserver.conf.template rendered for the lab —
#     as STUN and TURN, in a namespace of its own;
#   - the signaling server from node_modules and the BUILT app (`vite preview` over dist/) on the
#     lab's public address;
#   - in each client namespace a port-forward, so its browser loads http://localhost:5173.
#
# The build must have been made for the lab:
#   VITE_SIGNALING_URL=ws://127.0.0.1:8080 VITE_STUN_URLS=stun:192.0.2.10:3478 npm run build
#
# Every check below fails with one line that says what is wrong, as an ::error:: annotation on
# GitHub Actions — the job log of a public repository is not readable without signing in, the
# annotations are. down.sh removes everything.
# ============================================================================
set -Eeuo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
. "$HERE/lib.sh"

[ "$(uname -s)" = Linux ] || nat_fail 'NAT lab' 'network namespaces need Linux'
[ "$(id -u)" = 0 ] || nat_fail 'NAT lab' 'run as root: sudo env "PATH=$PATH" bash tests/nat/net/up.sh'
for tool in ip nft conntrack docker node curl ping openssl tar; do
  command -v "$tool" >/dev/null || nat_fail 'NAT lab' "missing tool: $tool (apt-get install nftables conntrack iproute2 iputils-ping)"
done
NODE=$(command -v node)
[ -f "$REPO/dist/index.html" ] || nat_fail 'NAT lab' 'dist/ is missing — build the app for the lab first (see the header of up.sh)'
grep -rqF "stun:$TURN_IP:$TURN_PORT" "$REPO/dist/assets" ||
  nat_fail 'NAT lab' "dist/ was not built for the lab: stun:$TURN_IP:$TURN_PORT is not in the bundle (VITE_STUN_URLS)"

stage='start'
tail_of() { [ -f "$1" ] && tail -n 8 "$1" 2>/dev/null || true; }
# Fail with the reason AND what the lab's processes last said: there is no other way to see them.
lab_fail() { # message
  nat_fail "NAT lab: $stage" "$1
--- signaling.log
$(tail_of "$NAT_STATE_DIR/signaling.log")
--- app.log
$(tail_of "$NAT_STATE_DIR/app.log")
--- forward-$NS_C1.log
$(tail_of "$NAT_STATE_DIR/forward-$NS_C1.log")
--- coturn
$(docker logs --tail 12 "$COTURN_CONTAINER" 2>&1 || true)"
}
trap 'lab_fail "up.sh stopped at line $LINENO: $BASH_COMMAND"' ERR

bash "$HERE/down.sh"
mkdir -p "$NAT_STATE_DIR/coturn"
chmod 755 "$NAT_STATE_DIR" "$NAT_STATE_DIR/coturn"

in_ns() { local ns=$1; shift; ip netns exec "$ns" "$@"; }
# A long-running process inside a namespace, logging to the state directory.
spawn() { # name namespace command…
  local name=$1 ns=$2
  shift 2
  setsid ip netns exec "$ns" "$@" >"$NAT_STATE_DIR/$name.log" 2>&1 </dev/null &
}
wait_for() { # seconds description command…
  local deadline=$((SECONDS + $1)) what=$2
  shift 2
  until "$@" >/dev/null 2>&1; do
    [ "$SECONDS" -lt "$deadline" ] || lab_fail "$what"
    sleep 0.25
  done
}

# ── 1. namespaces and links ─────────────────────────────────────────────────
stage='namespaces'
for ns in "$NS_INET" "$NS_R1" "$NS_R2" "$NS_C1" "$NS_C2"; do
  ip netns add "$ns"
  # IPv4 only: the two NATs are the subject, and a link-local IPv6 path would be a way around them.
  in_ns "$ns" sysctl -qw net.ipv6.conf.all.disable_ipv6=1 net.ipv6.conf.default.disable_ipv6=1
  ip -n "$ns" link set lo up
done

ip link add to-r1 netns "$NS_INET" type veth peer name wan netns "$NS_R1"
ip link add to-r2 netns "$NS_INET" type veth peer name wan netns "$NS_R2"
ip link add lan netns "$NS_R1" type veth peer name eth0 netns "$NS_C1"
ip link add lan netns "$NS_R2" type veth peer name eth0 netns "$NS_C2"

addr() { # namespace device address/prefix
  ip -n "$1" addr add "$3" dev "$2"
  ip -n "$1" link set "$2" up
}
addr "$NS_INET" lo "$SVC_IP/32"
addr "$NS_INET" lo "$REFLECT_IP2/32"
addr "$NS_INET" lo "$REFLECT_IP3/32"
addr "$NS_INET" to-r1 "$INET_R1_IP/24"
addr "$NS_INET" to-r2 "$INET_R2_IP/24"
addr "$NS_R1" wan "$R1_WAN_IP/24"
addr "$NS_R1" lan "$R1_LAN_IP/24"
addr "$NS_R2" wan "$R2_WAN_IP/24"
addr "$NS_R2" lan "$R2_LAN_IP/24"
addr "$NS_C1" eth0 "$C1_IP/24"
addr "$NS_C2" eth0 "$C2_IP/24"

ip -n "$NS_R1" route add default via "$INET_R1_IP"
ip -n "$NS_R2" route add default via "$INET_R2_IP"
ip -n "$NS_C1" route add default via "$R1_LAN_IP"
ip -n "$NS_C2" route add default via "$R2_LAN_IP"
for ns in "$NS_INET" "$NS_R1" "$NS_R2"; do
  in_ns "$ns" sysctl -qw net.ipv4.ip_forward=1
done

bash "$HERE/nat-mode.sh" r1 cone
bash "$HERE/nat-mode.sh" r2 cone

# ── 2. coturn: the production image and template ────────────────────────────
stage='coturn'
sig_ref=$("$NODE" -p "require('$REPO/package.json').devDependencies['hush-signaling-server'].split('#')[1]")
[[ "$sig_ref" =~ ^[0-9a-f]{40}$ ]] || nat_fail 'NAT lab: coturn' "package.json does not pin hush-signaling-server by commit (got '$sig_ref')"
turn_src=$NAT_STATE_DIR/turn-src
mkdir -p "$turn_src"
# The npm package ships neither the template nor the image pin, so they come from the same commit
# package.json installs the server from.
curl -fsSL --retry 3 "https://codeload.github.com/maksimfrelikh/hush-signaling-server/tar.gz/$sig_ref" |
  tar -xz -C "$turn_src" --strip-components=3 --wildcards '*/deploy/turn/*'
for f in lib.sh render.sh turnserver.conf.template relay-probe.mjs; do
  [ -s "$turn_src/$f" ] || nat_fail 'NAT lab: coturn' "hush-signaling-server@$sig_ref has no deploy/turn/$f"
done
image=$(sed -n 's/^COTURN_IMAGE=//p' "$turn_src/lib.sh")
[ -n "$image" ] || nat_fail 'NAT lab: coturn' "no COTURN_IMAGE in hush-signaling-server@$sig_ref deploy/turn/lib.sh"

# Room for the lab, not the production figures: the relay must never be the reason a case fails.
# user-quota counts allocations per credential (each browser mints its own); the bps limits are off.
cat >"$NAT_STATE_DIR/coturn/turn.env" <<EOF
REALM=turn.nat.test
LISTEN_PORT=$TURN_PORT
TLS_LISTEN_PORT=5349
RELAY_IP=$TURN_IP
EXTERNAL_IP=
MIN_PORT=49160
MAX_PORT=49400
USER_QUOTA=8
TOTAL_QUOTA=100
MAX_BPS=0
BPS_CAPACITY=0
EOF
# The template sends coturn's log to /dev/null (a relay log is a record of who used it). The lab
# wants it back: it is the only account of why an allocation was refused.
STATIC_AUTH_SECRET=$TURN_SECRET bash "$turn_src/render.sh" "$NAT_STATE_DIR/coturn/turn.env" "$turn_src/turnserver.conf.template" |
  grep -vxE 'no-stdout-log|log-file=/dev/null' >"$NAT_STATE_DIR/coturn/turnserver.conf"
chmod 644 "$NAT_STATE_DIR/coturn/turnserver.conf"

docker pull -q "$image" >/dev/null
# The container starts with no network at all; its namespace is then named and wired like the
# others, and only after that is coturn let go — it binds its addresses once, at start.
docker run -d --name "$COTURN_CONTAINER" --network none \
  --mount "type=bind,source=$NAT_STATE_DIR/coturn,target=/nat,readonly" \
  --entrypoint sh "$image" \
  -c 'until [ -e /nat/go ]; do sleep 0.2; done; exec turnserver -c /nat/turnserver.conf --use-auth-secret --pidfile= --log-file=stdout' >/dev/null
ip netns attach "$NS_TURN" "$(docker inspect -f '{{.State.Pid}}' "$COTURN_CONTAINER")"
in_ns "$NS_TURN" sysctl -qw net.ipv6.conf.all.disable_ipv6=1 net.ipv6.conf.default.disable_ipv6=1
ip link add to-turn netns "$NS_INET" type veth peer name eth0 netns "$NS_TURN"
addr "$NS_INET" to-turn "$INET_TURN_IP/30"
addr "$NS_TURN" eth0 "$TURN_IP/30"
ip -n "$NS_TURN" route add default via "$INET_TURN_IP"
touch "$NAT_STATE_DIR/coturn/go"

# ── 3. signaling, the built app, the probe's reflector, the forwards ────────
stage='services'
spawn signaling "$NS_INET" env NODE_ENV=development HOST="$SVC_IP" PORT="$SIGNALING_PORT" \
  DEV_ORIGINS="http://localhost:$APP_PORT" \
  TURN_SECRET="$TURN_SECRET" TURN_URLS="turn:$TURN_IP:$TURN_PORT?transport=udp" \
  TURN_RL_MAX=1000 IP_RL_MAX=10000 MAX_CONNS_PER_IP=200 \
  "$NODE" "$REPO/node_modules/hush-signaling-server/signaling-server.js"
(cd "$REPO" && spawn app "$NS_INET" "$NODE" node_modules/vite/bin/vite.js preview --host "$SVC_IP" --port "$APP_PORT" --strictPort)
spawn reflect "$NS_INET" "$NODE" "$HERE/../tools/reflect.ts" "$SVC_IP" "$REFLECT_IP2" "$REFLECT_IP3"
for c in "$NS_C1" "$NS_C2"; do
  spawn "forward-$c" "$c" "$NODE" "$HERE/../tools/forward.ts" "$APP_PORT=$SVC_IP:$APP_PORT" "$SIGNALING_PORT=$SVC_IP:$SIGNALING_PORT"
done

wait_for 20 "the signaling server does not answer /health on $SVC_IP:$SIGNALING_PORT" \
  in_ns "$NS_INET" curl -fsS -m 2 "http://$SVC_IP:$SIGNALING_PORT/health"
wait_for 30 "vite preview does not serve dist/ on $SVC_IP:$APP_PORT" \
  in_ns "$NS_INET" curl -fsS -m 2 "http://$SVC_IP:$APP_PORT/"

# ── 4. the lab is what the map says ─────────────────────────────────────────
stage='reachability'
for c in "$NS_C1" "$NS_C2"; do
  wait_for 10 "$c cannot reach the public address $SVC_IP through its router" in_ns "$c" ping -c1 -W1 "$SVC_IP"
  wait_for 10 "$c cannot reach coturn at $TURN_IP through its router" in_ns "$c" ping -c1 -W1 "$TURN_IP"
  wait_for 15 "$c: http://localhost:$APP_PORT does not serve the app through the port-forward" \
    in_ns "$c" curl -fsS -m 3 "http://localhost:$APP_PORT/"
  wait_for 10 "$c: the signaling server is not reachable on 127.0.0.1:$SIGNALING_PORT through the port-forward" \
    in_ns "$c" curl -fsS -m 3 "http://127.0.0.1:$SIGNALING_PORT/health"
done
# The two LANs must have no way to each other except through both NATs.
if in_ns "$NS_C1" ping -c1 -W1 "$C2_IP" >/dev/null 2>&1; then
  lab_fail "nat-c1 reaches nat-c2's private address $C2_IP — the LANs are not isolated, every case would connect on host candidates"
fi
if in_ns "$NS_INET" ping -c1 -W1 "$C1_IP" >/dev/null 2>&1; then
  lab_fail "the public side reaches nat-c1's private address $C1_IP — nat-r1 is routing, not translating"
fi

stage='stun and relay'
wait_for 30 "coturn does not answer STUN on $TURN_IP:$TURN_PORT from behind the NAT (or the reflector is down: $(tail_of "$NAT_STATE_DIR/reflect.log"))" \
  in_ns "$NS_C1" "$NODE" "$HERE/../tools/probe.ts" "$SVC_IP" "$REFLECT_IP2" "$TURN_IP:$TURN_PORT"
# A credential minted exactly as the signaling server mints one must open a relay and carry data,
# from behind the NAT: relay-probe.mjs is hush-signaling-server's own check.
turn_user="$(($(date +%s) + 600)):$(openssl rand -hex 8)"
turn_pass=$(printf '%s' "$turn_user" | openssl dgst -sha1 -hmac "$TURN_SECRET" -binary | base64)
relay=$(in_ns "$NS_C1" env TURN_USERNAME="$turn_user" TURN_CREDENTIAL="$turn_pass" timeout 40 "$NODE" "$turn_src/relay-probe.mjs" "$TURN_IP" "$TURN_PORT" 2>&1 || true)
case "$relay" in
  *'relayed 4 of 4 messages'*) ;;
  *) lab_fail "the relay did not carry data for a credential minted from TURN_SECRET: $relay" ;;
esac

trap - ERR
nat_annotate notice 'NAT lab' "up: coturn $image, template from hush-signaling-server@${sig_ref:0:7}; relay check: $relay"
