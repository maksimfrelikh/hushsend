/**
 * Relax-retry (step 6d) — the Max-privacy STRICT model, pure + framework-free so it unit-tests
 * without a browser.
 *
 * Max-privacy = NEVER relayed without consent. Two mechanisms enforce that bilaterally:
 *   1. We request NO local TURN (the iceServers builder, step 6d B1) → we never offer a relay candidate.
 *   2. We DROP the peer's relay candidates (`isRelayCandidate`/`shouldDropCandidate`) until WE relax →
 *      even if the peer added TURN, no relay path can complete on our side without consent.
 *
 * On an ICE failure (Max-privacy, not relaxed) we surface a relay ESCALATION to the human instead of
 * hard-failing. The relay path comes up only once BOTH sides relax — self-enforcing bilateral: until a
 * side relaxes it is still filtering the other's relay candidates, so a one-sided relax can never open
 * a relay. The ICE restart that brings the relay up is done on the EXISTING PeerConnection (no
 * teardown, no new certificate), so the DTLS fingerprint — and therefore the SAS/key-confirmation
 * channel binding — survives the restart untouched.
 *
 * This module is just the state shape + transitions + the candidate predicate; the live PeerConnection
 * + signaling wiring live in SessionController (which owns the non-serializable objects).
 */

import type { ConfirmationRole } from './crypto/keyConfirmation';

export interface RelaxState {
  /** the relay escalation is being OFFERED to the human (our ICE failed, or the peer relaxed). */
  available: boolean;
  /** our human accepted relay → we fetched TURN, stopped filtering, and signalled the peer. */
  localRelaxed: boolean;
  /** the paired peer signalled it relaxed. */
  peerRelaxed: boolean;
  /** our own ICE actually failed (vs. only the peer having relaxed) — informational. */
  iceFailed: boolean;
  /** one-shot guard so the ICE restart over the relay fires at most once. */
  restarted: boolean;
}

export function newRelaxState(): RelaxState {
  return { available: false, localRelaxed: false, peerRelaxed: false, iceFailed: false, restarted: false };
}

/**
 * Our ICE could not connect (only reached in Max-privacy + not relaxed — the peer's relay candidates
 * are being dropped, so nothing relayed silently). Offer the relay escalation. No-op once we relaxed.
 */
export function relaxOnIceFail(s: RelaxState): RelaxState {
  if (s.localRelaxed) return s;
  if (s.iceFailed && s.available) return s;
  return { ...s, iceFailed: true, available: true };
}

/** The human accepted the relay escalation. Idempotent. */
export function relaxOnLocal(s: RelaxState): RelaxState {
  if (s.localRelaxed) return s;
  return { ...s, localRelaxed: true, available: true };
}

/**
 * The paired peer signalled it relaxed. Record it; if we have NOT relaxed, surface the offer to us too
 * (a peer-initiated relax still asks our consent — we never relay silently). Idempotent.
 */
export function relaxOnPeer(s: RelaxState): RelaxState {
  if (s.peerRelaxed) return s;
  return { ...s, peerRelaxed: true, available: s.available || !s.localRelaxed };
}

/**
 * Restart ICE over the relay ONLY when BOTH sides have relaxed AND we are the per-pairing INITIATOR
 * (the side that owns the WebRTC offer). A one-sided relax is useless — the other side is still
 * filtering relay candidates — so the restart must wait for both. One-shot (guards on `restarted`).
 */
export function shouldRestartForRelay(s: RelaxState, role: ConfirmationRole | null): boolean {
  return s.localRelaxed && s.peerRelaxed && !s.restarted && role === 'initiator';
}

/**
 * STRICT-model predicate: is this inbound ICE candidate a TURN RELAY candidate? Matches the SDP
 * candidate attribute's `typ relay` field (e.g. `candidate:… typ relay raddr …`). Used to drop the
 * peer's relay candidates while we are filtering, so we are never relayed without consent.
 */
export function isRelayCandidate(candidate: { candidate?: string | null } | null | undefined): boolean {
  const s = candidate?.candidate;
  return typeof s === 'string' && /\btyp\s+relay\b/i.test(s);
}

/** Drop a peer ICE candidate iff we are currently filtering (Max-privacy, not relaxed) AND it is a
 *  relay candidate. Off (Reliable, or after relax) → never drops; non-relay candidates → never dropped. */
export function shouldDropCandidate(
  filtering: boolean,
  candidate: { candidate?: string | null } | null | undefined,
): boolean {
  return filtering && isRelayCandidate(candidate);
}
