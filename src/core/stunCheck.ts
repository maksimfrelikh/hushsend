/**
 * Cross-check what several STUN servers say our public address is.
 *
 * WHY. Path attestation (`pathAttest.ts`) rests on each peer naming the addresses it can be reached
 * at — and for a peer behind NAT that address comes from STUN. So an operator that runs BOTH the
 * signaling server and the STUN server can lie twice consistently: inject its own candidate onto the
 * path, and tell the peer to attest that same address. The check then passes with an attacker in the
 * middle. Removing that needs more than one STUN operator, and a client that notices when they
 * disagree — which is this file.
 *
 * MEASURED FIRST, BECAUSE THE OBVIOUS DESIGN DOES NOT WORK (2026-09-17). Putting several STUN URLs in
 * one `iceServers` entry and reading the candidates back does NOT give one result per server: ICE
 * prunes redundant candidates before the application sees them, so chromium and webkit both yield a
 * SINGLE srflx candidate attributed to the first server, and a disagreement would be invisible. The
 * working shape is one throwaway `RTCPeerConnection` PER server, each configured with exactly that
 * one URL — verified to yield that server's own view, with `url` attribution, on chromium and webkit.
 *
 * DELIBERATE LIMITS, stated rather than discovered later:
 *  - **Address only, never the port.** Each probe uses its own socket, so even an honest NAT hands
 *    out a different port per probe. Ports carry no signal here.
 *  - **A multi-WAN or CGNAT client can disagree honestly.** Two providers, two public addresses, no
 *    liar. So a disagreement is evidence to SHOW, never grounds to refuse a connection — the same
 *    rule `pathAttest` follows, and for the same reason: a false accusation at the wrong moment is
 *    worse than the leak it would close.
 *  - **`unknown` is benign.** Firefox reported no srflx candidate at all in the loopback measurement
 *    and exposes no `url` field on local candidates, so on some engines this simply cannot run. An
 *    engine that cannot answer must not be treated as an engine that answered badly.
 *  - **It says nothing while only ONE server is configured** — which is the deployment today. This is
 *    the client half of a property that does not exist until the servers are run by different people.
 */

/** One server's answer: the public address it told us we have. `address: null` = it did not say. */
export interface StunView {
  url: string;
  address: string | null;
}

export type StunVerdict =
  /** Two or more servers answered and every answer agrees. */
  | 'agree'
  /** Two or more servers answered and they do NOT all agree — show it, do not act on it. */
  | 'disagree'
  /** Fewer than two servers answered: nothing to compare. Not a failure. */
  | 'unknown';

export interface StunCheckResult {
  verdict: StunVerdict;
  /** Distinct addresses seen, normalised, in first-seen order. */
  addresses: string[];
  /** The views that actually answered, for the diagnostics strip. */
  answered: StunView[];
}

/** Same normalisation as pathAttest: IPv6 hex casing is not significant. */
function norm(a: string): string {
  return a.trim().toLowerCase();
}

function usable(a: string | null): a is string {
  if (typeof a !== 'string') return false;
  const v = a.trim();
  if (v === '') return false;
  if (v.toLowerCase().endsWith('.local')) return false; // mDNS name, not a routable answer
  return v.includes('.') || v.includes(':');
}

/**
 * Compare what the servers said. Pure, so the policy is testable without a browser — the part that
 * talks to WebRTC is {@link probeStunViews}.
 */
export function compareStunViews(views: readonly StunView[]): StunCheckResult {
  const answered = views.filter((v) => usable(v.address));
  const addresses: string[] = [];
  for (const v of answered) {
    const a = norm(v.address as string);
    if (!addresses.includes(a)) addresses.push(a);
  }
  if (answered.length < 2) return { verdict: 'unknown', addresses, answered };
  return { verdict: addresses.length === 1 ? 'agree' : 'disagree', addresses, answered };
}

/** How long one server gets to answer before we record it as silent. */
const PROBE_TIMEOUT_MS = 4000;

/**
 * Ask ONE STUN server what our public address is, using a throwaway PeerConnection configured with
 * only that server. Resolves with `address: null` when the engine reports no server-reflexive
 * candidate — which is a real outcome (see the header: Firefox did exactly that in the measurement),
 * not an error.
 *
 * The connection is never used for anything: no offer is exchanged, no peer exists, it is closed as
 * soon as gathering finishes. It contacts ONLY the URL passed in, so this adds no third party.
 */
async function probeOne(url: string): Promise<StunView> {
  let pc: RTCPeerConnection | null = null;
  try {
    pc = new RTCPeerConnection({ iceServers: [{ urls: [url] }] });
    const done = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, PROBE_TIMEOUT_MS);
      pc!.onicegatheringstatechange = () => {
        if (pc?.iceGatheringState === 'complete') {
          clearTimeout(timer);
          resolve();
        }
      };
    });
    pc.createDataChannel('stun-probe'); // a media-less PC gathers nothing without one
    await pc.setLocalDescription(await pc.createOffer());
    await done;
    const report = await pc.getStats();
    let address: string | null = null;
    report.forEach((raw: unknown) => {
      const e = raw as Record<string, unknown>;
      if (address !== null) return;
      if (e.type !== 'local-candidate' || e.candidateType !== 'srflx') return;
      // Attribute to THIS server when the engine says so; with one URL configured it cannot be
      // another one anyway, which is exactly why the probes are separate.
      const a = (e.address ?? e.ip) as unknown;
      if (typeof a === 'string' && a !== '') address = a;
    });
    return { url, address };
  } catch {
    return { url, address: null }; // no WebRTC, blocked, or the engine refused — silent, not wrong
  } finally {
    try {
      pc?.close();
    } catch {
      /* already gone */
    }
  }
}

/**
 * Ask every configured STUN server in parallel and compare. Returns `unknown` immediately when fewer
 * than two are configured — there is nothing to cross-check against a single operator, which is the
 * deployment today.
 */
export async function probeStunViews(urls: readonly string[]): Promise<StunCheckResult> {
  if (urls.length < 2) return { verdict: 'unknown', addresses: [], answered: [] };
  const views = await Promise.all(urls.map((u) => probeOne(u)));
  return compareStunViews(views);
}
