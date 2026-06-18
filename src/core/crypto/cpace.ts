/**
 * CPace — balanced PAKE for the "words" method. To be built on @noble/curves
 * (ristretto255 + hash-to-curve) and @noble/hashes (SHA-512), implemented against
 * the CFRG test vectors (draft-irtf-cfrg-cpace). Single round trip; yields a
 * shared session key used for key-confirmation / channel binding.
 *
 * The PAKE password is the SECRET words only — the rendezvous word is excluded
 * (it's public routing, not part of the secret).
 */
export interface CPaceState {
  /** opaque ephemeral state kept on this side between the two messages */
  ephemeral: unknown;
  /** the message to send to the peer */
  outgoing: Uint8Array;
}

export function cpaceStart(_password: string, _sessionId: Uint8Array): CPaceState {
  // TODO: map (password, sid) to a ristretto255 generator, pick an ephemeral scalar,
  //       output our public point.
  throw new Error('cpaceStart not implemented');
}

/** Combine with the peer's message and derive the shared session key (ISK). */
export function cpaceFinish(_state: CPaceState, _incoming: Uint8Array): Uint8Array {
  throw new Error('cpaceFinish not implemented');
}
