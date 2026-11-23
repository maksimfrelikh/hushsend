/**
 * Can Max privacy work from THIS network? An advisory check, run when a pairing starts.
 *
 * WHY. Max privacy connects two browsers directly, and that needs each side to be reachable on the
 * address STUN reports for it. A symmetric NAT — mobile carriers, many VPNs — hands out a NEW port
 * for every destination, so the peer is told one port and is then reached from another: the pairing
 * runs 18–48 s into the direct-failure screen (README § Platform limits, measured 2026-11-22). The
 * mapping is visible from inside the browser, so the user can be told before the wait, not after.
 *
 * HOW. ONE socket asks TWO destinations what our address is. Under an endpoint-independent NAT both
 * answers are the same and ICE prunes the duplicate — a single `srflx` candidate; under a symmetric
 * NAT they differ and BOTH candidates are reported, with one foundation (same base, same type).
 * Measured 2026-11-22 against two local STUN servers that answer one socket with two different ports
 * (a symmetric NAT cannot be had on demand; what the browser receives is the same), Chromium 158,
 * WebKit 27.2, Firefox 159: two `srflx` with one foundation and two ports in all three; one `srflx`
 * when the answers agree, and also when one server stays silent.
 *
 * TWO THINGS THAT MEASUREMENT RULED OUT:
 *  - **"Two `srflx` on one foundation" alone is not a symmetric NAT.** WebKit re-gathers on fresh
 *    sockets when several connections start in one page: one connection then reported three host
 *    candidates and three `srflx` on ONE foundation, every answer honest. A foundation names the base
 *    ADDRESS, not the socket, and no engine says which socket a `srflx` belongs to (`raddr` is
 *    `0.0.0.0`). So the mappings are counted against the sockets: more mappings than the connection
 *    has UDP sockets on any one address cannot come from an honest NAT; anything else is `unknown`.
 *  - **One `srflx` does not say that both servers answered.** Chromium and WebKit name the answering
 *    server on the candidate (`url`), Firefox does not. Each server is therefore also asked from its
 *    own connection (`stunCheck.probeOne`), and `direct` needs both of those answers.
 *
 * AND ONE IT COULD NOT: Safari in the iOS Simulator (26.5) sends to each destination from its OWN local
 * port — two local servers with no NAT in between saw two source ports, neither the host candidate's
 * — so there this reads `symmetric` on every network. Safari on macOS (26.5.2) and on an iPhone
 * (27.2, measured 2026-11-23) uses one port, as Chromium and Firefox do (README § Network check).
 *
 * DELIBERATE LIMITS, stated rather than discovered later:
 *  - **Advisory.** Nothing is refused and the mode never changes by itself — the same rule as
 *    `pathAttest` and `stunCheck`, for the same reason: this reads the network through two servers
 *    we do not control the honesty of, and a false verdict must cost a line of copy, not a transfer.
 *  - **It reads THIS side only.** `direct` here says nothing about the peer's network; a pair fails
 *    when either side is behind a symmetric NAT.
 *  - **Two destinations on one address.** The deployment's two servers share an IP and differ in
 *    port, so this sees a mapping that depends on the destination PORT (the carrier measured
 *    2026-11-22 does). A NAT that keys its mapping on the destination ADDRESS alone would read
 *    `direct`; telling those apart needs a second server on another address.
 *  - **`unknown` is benign.** No answer, one answer, UDP blocked, an engine that reports nothing:
 *    all of them mean "could not tell", never "will fail".
 *  - **IPv6 is noted, not judged.** A global IPv6 address has no mapping to compare. It is reported
 *    because a pair with IPv6 on both sides can connect directly whatever the IPv4 NAT does.
 */
import { probeOne } from './stunCheck';

export type NatVerdict =
  /** One mapping for both destinations, and both servers answered: this side is reachable. */
  | 'direct'
  /** One socket was given two different mappings: a peer cannot reach the address it is told. */
  | 'symmetric'
  /** Not enough answers to tell. Not a failure. */
  | 'unknown';

/** A local UDP candidate of the joint connection — the three fields the verdict needs. */
export interface Candidate {
  type: 'host' | 'srflx';
  foundation: string;
  address: string;
  port: number;
}

export interface NatCheckResult {
  verdict: NatVerdict;
  /** A STUN server answered over IPv6 with a global address: this device has usable IPv6. */
  ipv6: boolean;
}

/**
 * Parse an ICE candidate line; null for anything that is not a UDP `host` or `srflx` candidate. The
 * line is read rather than `RTCIceCandidate.address` / `.port` / `.foundation`: it is the one form
 * every engine fills in.
 */
export function parseCandidate(line: string | null | undefined): Candidate | null {
  if (typeof line !== 'string') return null;
  const m = /^(?:a=)?candidate:(\S+)\s+\d+\s+(\S+)\s+\d+\s+(\S+)\s+(\d+)\s+typ\s+(host|srflx)\b/i.exec(line.trim());
  if (!m || m[2].toLowerCase() !== 'udp') return null;
  return {
    type: m[5].toLowerCase() as Candidate['type'],
    foundation: m[1],
    address: m[3].toLowerCase(),
    port: Number(m[4]),
  };
}

/** Global unicast (2000::/3): link-local, unique-local and loopback are not reachable from outside. */
function isGlobalIpv6(address: string): boolean {
  return address.includes(':') && /^[23]/.test(address);
}

/** The largest number of distinct values any one foundation holds. */
function busiest(candidates: readonly Candidate[], value: (c: Candidate) => string): number {
  const groups = new Map<string, Set<string>>();
  for (const c of candidates) {
    const seen = groups.get(c.foundation) ?? new Set<string>();
    seen.add(value(c));
    groups.set(c.foundation, seen);
  }
  return Math.max(0, ...[...groups.values()].map((g) => g.size));
}

/**
 * The verdict. Pure, so the policy is testable without a browser — the part that talks to WebRTC is
 * {@link checkNat}.
 *
 * `candidates` is what ONE connection configured with both servers gathered, hosts included;
 * `answered` says, per server, whether it answered a connection of its own. Only IPv4 mappings are
 * compared: an IPv6 address is not behind a mapping, and the second server may not listen on IPv6.
 */
export function judgeNat(candidates: readonly Candidate[], answered: readonly boolean[]): NatCheckResult {
  const srflx = candidates.filter((c) => c.type === 'srflx');
  const ipv6 = srflx.some((c) => isGlobalIpv6(c.address));
  // Sockets on the busiest base address (a host foundation is one address; each socket is a port).
  const sockets = busiest(
    candidates.filter((c) => c.type === 'host'),
    (c) => String(c.port),
  );
  const mappings = busiest(
    srflx.filter((c) => !c.address.includes(':')),
    (c) => `${c.address}|${c.port}`,
  );
  // An honest NAT gives each socket ONE mapping, so a base cannot show more mappings than sockets.
  // More is positive evidence on its own: both servers evidently answered. No visible socket at all
  // (an engine or a policy that reports no host candidate) leaves nothing to count against.
  if (sockets > 0 && mappings > sockets) return { verdict: 'symmetric', ipv6 };
  // One socket, one mapping means "the answers agreed" only when there were two answers.
  const allAnswered = answered.length >= 2 && answered.every(Boolean);
  return { verdict: sockets === 1 && mappings === 1 && allAnswered ? 'direct' : 'unknown', ipv6 };
}

/**
 * How long the joint connection gathers before it is judged on what it has. Matches
 * `stunCheck.PROBE_TIMEOUT_MS`: a cold Firefox took 9.8 s to its first `srflx` (README § B7).
 */
const GATHER_TIMEOUT_MS = 12_000;
/**
 * Gathering can outlive its answers by seconds — WebKit kept `gathering` for 9 s over a socket that
 * could not reach the server. So a second mapping on one base ends the wait this long after it
 * arrives: enough for a re-gathered socket to show up beside it, short enough to be on screen in time.
 */
const SETTLE_MS = 300;

/**
 * Gather on ONE throwaway PeerConnection configured with both servers and return its UDP host and
 * `srflx` candidates — from the candidate events and from `getStats()`, which lists a host candidate
 * as soon as its socket exists (WebKit announces the `.local` name later, or not in time). Never
 * used for anything else: no offer leaves the page, and it is closed when done.
 */
async function gather(urls: readonly string[]): Promise<Candidate[]> {
  let pc: RTCPeerConnection | null = null;
  const found: Candidate[] = [];
  try {
    pc = new RTCPeerConnection({ iceServers: [{ urls: [...urls] }] });
    const conn = pc;
    const done = new Promise<void>((resolve) => {
      let settle: ReturnType<typeof setTimeout> | null = null;
      const timer = setTimeout(resolve, GATHER_TIMEOUT_MS);
      const finish = (): void => {
        clearTimeout(timer);
        if (settle != null) clearTimeout(settle);
        resolve();
      };
      conn.onicecandidate = (e) => {
        if (!e.candidate) return finish(); // end of candidates
        const c = parseCandidate(e.candidate.candidate);
        if (!c) return;
        found.push(c);
        const srflx = found.filter((f) => f.type === 'srflx' && !f.address.includes(':'));
        if (settle == null && busiest(srflx, (f) => `${f.address}|${f.port}`) > 1) settle = setTimeout(finish, SETTLE_MS);
      };
      conn.onicegatheringstatechange = () => {
        if (conn.iceGatheringState === 'complete') finish();
      };
    });
    pc.createDataChannel('nat-check'); // a media-less PC gathers nothing without one
    await pc.setLocalDescription(await pc.createOffer());
    await done;
    (await pc.getStats()).forEach((raw: unknown) => {
      const e = raw as Record<string, unknown>;
      if (e.type !== 'local-candidate' || e.candidateType !== 'host' || e.protocol !== 'udp') return;
      if (typeof e.foundation !== 'string' || typeof e.port !== 'number') return;
      found.push({ type: 'host', foundation: e.foundation, address: '', port: e.port });
    });
  } catch {
    /* no WebRTC, blocked, or the engine refused — judged on what was gathered, i.e. unknown */
  } finally {
    try {
      pc?.close();
    } catch {
      /* already gone */
    }
  }
  return found;
}

/**
 * Run the check against two STUN destinations. First ONE connection that asks both — alone, because
 * a second connection starting beside it is what makes WebKit re-gather. A symmetric NAT is decided
 * there. Only a result that could be `direct` then asks each server from its own connection, to
 * learn that both answered. Contacts ONLY the two URLs passed in. Returns `unknown` at once when
 * either is missing — a build without the second destination has nothing to compare.
 */
export async function checkNat(urls: readonly string[]): Promise<NatCheckResult> {
  if (urls.length < 2 || urls.some((u) => !u)) return { verdict: 'unknown', ipv6: false };
  const pair = urls.slice(0, 2);
  const candidates = await gather(pair);
  if (judgeNat(candidates, [true, true]).verdict !== 'direct') return judgeNat(candidates, []);
  const views = await Promise.all(pair.map((u) => probeOne(u)));
  return judgeNat(
    candidates,
    views.map((v) => v.address !== null),
  );
}
