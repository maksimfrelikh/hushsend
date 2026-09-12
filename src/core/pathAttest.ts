/**
 * Path attestation — "are we actually talking to the peer, or to something in between?"
 *
 * WHY THIS EXISTS. The 2026-09-12 audit established that no candidate filter can answer that
 * question. The ICE credentials (`ice-ufrag`/`ice-pwd`) ride the SDP, which the UNTRUSTED signaling
 * server relays, so that server can answer our connectivity checks itself; and it can withhold the
 * peer's real candidates and inject its own, typed `host`, at its own address. A client cannot tell
 * an attacker's `typ host` from the peer's, because the peer's real address is only ever learned
 * FROM the server. The relay filter (`relax.ts`) refuses `typ relay`, which stops an honest peer's
 * TURN path; it cannot stop a server that never offers a relay candidate at all. Result: DTLS keeps
 * the bytes confidential (a forwarding attacker sees ciphertext, and a TERMINATING one is caught by
 * the fingerprint binding in SAS / CPace / link key-confirmation), but the Max-privacy PATH promise —
 * "direct only, nothing else carries your traffic" — was not verifiable.
 *
 * WHAT IT DOES. Exactly what the fingerprint binding already does for identity: move the claim onto
 * a channel the attacker does not control. Once the pair is AUTHENTICATED, the DataChannel is
 * DTLS-protected and the server can neither read nor forge it. So each side sends the set of
 * addresses it can actually be reached at, and each side checks that the remote address ICE selected
 * for it appears in the peer's set. An interposer's address is in neither peer's set, so it is
 * named by the very peer it is impersonating.
 *
 *   we selected 203.0.113.7   ·   peer attests {192.168.1.19, 203.0.113.7}   → ok
 *   we selected 198.51.100.9  ·   peer attests {192.168.1.19, 203.0.113.7}   → MISMATCH: on-path
 *
 * DELIBERATE LIMITS, stated rather than hidden:
 *  - **Address only, never the port.** Plenty of NATs keep the IP and vary the port per destination,
 *    so comparing ports would reject working, honest connections. An attacker sharing the peer's IP
 *    (same LAN, same NAT) is therefore not caught — a different threat from a remote interposer.
 *  - **It rests on the peer's own view of its addresses**, which for srflx comes from STUN — the same
 *    operator. An operator that both lies over STUN *and* sits on the path can still make the two
 *    sides agree. That is strictly harder than today's attack (which needs neither), and it is the
 *    residual to close by not being the STUN provider.
 *  - **Absence of evidence is not evidence.** An engine that reports no usable candidate addresses
 *    yields `unknown`, never `mismatch`: a missing API must not tear down a working connection. What
 *    it must not do is silently pass, so a peer that sends NO attestation at all is a failure at the
 *    deadline (see SessionController) — otherwise dropping one frame would be a free downgrade.
 */

/** A `getStats()` record — same defensive shape as relax.ts. */
export type StatsEntry = Record<string, unknown>;

/** Addresses we refuse to attest or compare. mDNS host candidates (`<uuid>.local`) are not routable
 *  identifiers and differ per peer, so they carry no information here; empty strings likewise. */
function isComparableAddress(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v === '') return false;
  if (v.toLowerCase().endsWith('.local')) return false; // mDNS-obfuscated host candidate
  return v.includes('.') || v.includes(':'); // IPv4 or IPv6 shaped
}

/** Canonical comparison form: lower-cased (IPv6 hex casing is not significant) and trimmed. */
export function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Every address WE can be reached at, read from our own local ICE candidates — host and
 * server-reflexive alike, since the peer may have selected either. Engines disagree on the field
 * name (`address` vs Firefox's `ip`), so both are read. Deduped, capped, and free of mDNS noise.
 */
export function localCandidateAddresses(entries: readonly StatsEntry[], cap = 16): string[] {
  const out = new Set<string>();
  for (const e of entries) {
    if (e.type !== 'local-candidate') continue;
    const raw = isComparableAddress(e.address) ? e.address : isComparableAddress(e.ip) ? e.ip : null;
    if (raw) out.add(normalizeAddress(raw));
    if (out.size >= cap) break;
  }
  return [...out];
}

export type PathVerdict = 'ok' | 'mismatch' | 'unknown';

/**
 * The verdict for one side: does the remote address we actually selected appear among the addresses
 * the peer attested to?
 *
 * `unknown` whenever we cannot judge — no selected address yet, or the peer could not name any of
 * its own. `mismatch` ONLY on positive evidence: we know what we selected, the peer named a
 * non-empty set, and ours is not in it.
 */
export function pathVerdict(
  selectedRemoteAddress: string | null | undefined,
  peerAddresses: readonly string[] | null | undefined,
): PathVerdict {
  if (!isComparableAddress(selectedRemoteAddress)) return 'unknown';
  if (!peerAddresses || peerAddresses.length === 0) return 'unknown';
  const attested = new Set(peerAddresses.filter(isComparableAddress).map(normalizeAddress));
  if (attested.size === 0) return 'unknown';
  return attested.has(normalizeAddress(selectedRemoteAddress)) ? 'ok' : 'mismatch';
}
