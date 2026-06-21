/**
 * Max-privacy STRICT relay filter (step 6d). Pure + framework-free so it unit-tests without a browser.
 *
 * Max-privacy = NEVER relayed. Period — no consent escalation, no relay-retry. Two mechanisms enforce
 * that, and they are ALWAYS on in Max-privacy:
 *   1. We request NO local TURN (the iceServers builder, step 6d) → we never offer a relay candidate.
 *   2. We DROP the peer's relay candidates (`isRelayCandidate`/`shouldDropCandidate`) → even if the peer
 *      added TURN, no relay path can complete on our side.
 *
 * So a Max-privacy pair that cannot connect directly simply FAILS (the SessionController routes the ICE
 * failure to a terminal `failed`, with a hint to switch to Reliable); it is never silently relayed and
 * is never offered a relay. The relay path exists only in Reliable mode (STUN + TURN, where this filter
 * is OFF). This module is just the candidate predicate; the live PeerConnection wiring (where the filter
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
