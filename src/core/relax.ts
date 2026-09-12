/**
 * Max-privacy STRICT relay filter (step 6d). Pure + framework-free so it unit-tests without a browser.
 *
 * Max-privacy = NEVER relayed. Period — no consent escalation, no relay-retry. Two mechanisms enforce
 * that, and they are ALWAYS on in Max-privacy:
 *   1. We request NO local TURN (the iceServers builder, step 6d) → we never offer a relay candidate.
 *   2. We DROP the peer's relay candidates (`isRelayCandidate`/`shouldDropCandidate`) → a relay address
 *      the peer SIGNALS is never added on our side.
 *
 * KNOWN GAP (audit 2026-09-12): mechanism 2 covers candidates we ADD, not the ones ICE LEARNS. A peer
 * relaying through TURN sends its connectivity checks FROM the relayed address, so per RFC 8445
 * §7.3.1.3 our agent can learn that same address as a PEER-REFLEXIVE candidate and pair with it —
 * which matters precisely when the direct path fails (otherwise the direct pair wins on priority) and
 * only in a mixed-privacy pair (Max ↔ Reliable). Confidentiality is unaffected; the privacy promise is.
 * The fix (record dropped relay addresses, then reject a selected pair that matches one, at
 * channel-open before `established`) is tracked in BACKLOG.md § Security audit / Findings.
 *
 * So a Max-privacy pair that cannot connect directly simply FAILS (the SessionController routes the ICE
 * failure to a terminal `failed`, with a hint to switch to Reliable); it is never offered a relay. The
 * relay path exists only in Reliable mode (STUN + TURN, where this filter is OFF). This module is just the candidate predicate; the live PeerConnection wiring (where the filter
 * runs) lives in PeerConnection, which owns the non-serializable objects.
 */

/**
 * STRICT-model predicate: is this inbound ICE candidate a TURN RELAY candidate? Matches the SDP
 * candidate attribute's `typ relay` field (e.g. `candidate:… typ relay raddr …`). Used to drop the
 * peer's relay candidates in Max-privacy, so we are never relayed.
 */
export function isRelayCandidate(candidate: { candidate?: string | null } | null | undefined): boolean {
  const s = candidate?.candidate;
  return typeof s === 'string' && /\btyp\s+relay\b/i.test(s);
}

/** Drop a peer ICE candidate iff we are currently filtering (Max-privacy) AND it is a relay candidate.
 *  Off (Reliable) → never drops; non-relay candidates → never dropped. */
export function shouldDropCandidate(
  filtering: boolean,
  candidate: { candidate?: string | null } | null | undefined,
): boolean {
  return filtering && isRelayCandidate(candidate);
}
