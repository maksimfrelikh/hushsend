/**
 * TOFU reconnect re-authentication (step 4b-ii) — re-establish trust between two peers that
 * ALREADY pinned each other's long-term Ed25519 identity (in a prior {@link ./enrollment}), with
 * NO human step (no SAS, no spoken words). The pin replaces the human: each side proves possession
 * of the private key behind the pinned public key, bound to THIS session's DTLS channel.
 *
 * Trust model: reconnect-auth runs INSTEAD of SAS/words when both sides hold a pin for the same
 * `pairingId`. Its entire strength is the mutual signature under the pinned keys, channel-bound to
 * the negotiated DTLS fingerprints (exactly as {@link ./enrollment}) and made replay-resistant by
 * a fresh per-side challenge. A relay/MITM that re-terminates DTLS presents different fingerprints
 * → the reconstructed transcript differs → the signature fails to verify → hard stop, no bytes.
 *
 * Each side signs a transcript bound to:
 *   - a fixed domain label (distinct from enroll/sas/confirm),
 *   - the per-pair `pairingId` (the SAME key-INDEPENDENT id pinned at enrollment — so a peer that
 *     re-presents this id under a DIFFERENT key is detectable as a key change, NOT a new pair),
 *   - BOTH fresh challenges in a fixed role order (initiator's, then responder's) — the freshness
 *     that defeats replay even without assuming the DTLS cert is fresh,
 *   - the two DTLS fingerprints (canonical sorted order — the channel binding), and
 *   - a role label (initiator/responder).
 *
 *   sign( lv("hushsend/identity/reconnect") || lv(pairingId)
 *         || lv(challengeInitiator) || lv(challengeResponder)
 *         || lv(fp_min) || lv(fp_max) || lv(role) )
 *
 * Verification is TWO SEPARATE checks (the controller runs both, so it can tell the two failures
 * apart — see SessionController):
 *   (1) does the peer's PRESENTED public key equal the one we PINNED for this pairingId? A "no" is
 *       a KEY CHANGE — the peer under this id is using a different key (SSH-style; a hard stop,
 *       never a dismissable toast, no bytes). {@link presentedKeyMatchesPin} is that check.
 *   (2) does the peer's signature verify under the PINNED key, over the transcript reconstructed
 *       with OUR fingerprints and the PEER's role? A "no" with a matching key is a channel-binding
 *       failure / possible MITM (also a hard stop, no bytes). {@link verifyReconnect} is that check.
 * Both pass ⇒ authenticated reconnect.
 *
 * Same `lv` + sorted-fingerprint canonicalisation as keyConfirmation/sas/enrollment, so the four
 * transcripts share one unambiguous wire format. Pure module (except generateChallenge's CSPRNG
 * draw): no I/O, no FSM — the transport and the two-check gate live in SessionController.
 */
import { z } from 'zod';
import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { equalBytes, hexToBytes } from '@noble/curves/utils.js';
import { verifySignature, type IdentityKey } from './identity';
import { PAIRING_ID_BYTES } from './enrollment';
import type { ConfirmationRole } from './keyConfirmation';

/** Challenge length (bytes): 16 fresh CSPRNG bytes per side — the explicit anti-replay nonce. */
export const RECONNECT_CHALLENGE_BYTES = 16;
/** Ed25519 public key / signature byte lengths — pinned exactly in the wire schema below. */
const PUBKEY_BYTES = 32;
const SIG_BYTES = 64;

/** Domain separation for the reconnect transcript (distinct from enroll/sas/cpace-confirm). */
const RECONNECT_DOMAIN = utf8ToBytes('hushsend/identity/reconnect');

/** Length-value prefix (1-byte-granular LEB128) — identical to keyConfirmation/sas/enrollment. */
function lv(data: Uint8Array): Uint8Array {
  const prefix: number[] = [];
  let length = data.length;
  for (;;) {
    if (length < 128) prefix.push(length);
    else prefix.push((length & 0x7f) + 0x80);
    length = Math.floor(length / 128);
    if (length === 0) break;
  }
  return concatBytes(Uint8Array.from(prefix), data);
}

/** A fresh CSPRNG challenge. The only impure function here; everything else is deterministic. */
export function generateChallenge(): Uint8Array {
  return randomBytes(RECONNECT_CHALLENGE_BYTES);
}

/**
 * Build the reconnect signature transcript. The two challenges are bound in a FIXED role order
 * (initiator's, then responder's) — NOT local/peer order — so both sides, who label their own and
 * the peer's challenge oppositely, feed the SAME bytes. The two fingerprints are bound in CANONICAL
 * (lexicographic) order — the channel binding — identical to enrollment/sas/keyConfirmation.
 */
export function reconnectTranscript(
  pairingId: Uint8Array,
  challengeInitiator: Uint8Array,
  challengeResponder: Uint8Array,
  localFingerprint: string,
  remoteFingerprint: string,
  role: ConfirmationRole,
): Uint8Array {
  const [fpMin, fpMax] =
    localFingerprint <= remoteFingerprint
      ? [localFingerprint, remoteFingerprint]
      : [remoteFingerprint, localFingerprint];
  return concatBytes(
    lv(RECONNECT_DOMAIN),
    lv(pairingId),
    lv(challengeInitiator),
    lv(challengeResponder),
    lv(utf8ToBytes(fpMin)),
    lv(utf8ToBytes(fpMax)),
    lv(utf8ToBytes(role)),
  );
}

/** Sign the channel-bound reconnect transcript for `role` under our long-term identity. */
export function signReconnect(
  identity: IdentityKey,
  pairingId: Uint8Array,
  challengeInitiator: Uint8Array,
  challengeResponder: Uint8Array,
  localFingerprint: string,
  remoteFingerprint: string,
  role: ConfirmationRole,
): Promise<Uint8Array> {
  return identity.sign(
    reconnectTranscript(
      pairingId,
      challengeInitiator,
      challengeResponder,
      localFingerprint,
      remoteFingerprint,
      role,
    ),
  );
}

/**
 * Check (2): verify the peer's reconnect signature under the PINNED public key — reconstruct the
 * transcript with the same role-ordered challenges, OUR (canonicalised) fingerprints, and the
 * PEER's role. The signer is verified against the key we pinned, NOT the key presented on the wire;
 * the presented-vs-pinned equality is check (1) ({@link presentedKeyMatchesPin}), run first.
 */
export function verifyReconnect(
  pinnedPublicKey: Uint8Array,
  pairingId: Uint8Array,
  challengeInitiator: Uint8Array,
  challengeResponder: Uint8Array,
  localFingerprint: string,
  remoteFingerprint: string,
  peerRole: ConfirmationRole,
  signature: Uint8Array,
): Promise<boolean> {
  return verifySignature(
    pinnedPublicKey,
    reconnectTranscript(
      pairingId,
      challengeInitiator,
      challengeResponder,
      localFingerprint,
      remoteFingerprint,
      peerRole,
    ),
    signature,
  );
}

/**
 * Check (1): does the peer's PRESENTED key equal the key we PINNED for this pairingId? Both are
 * hex (the keystore stores hex; the wire frame carries hex). A mismatch is a KEY CHANGE → hard
 * stop. Public keys are not secret, but we compare decoded bytes with the same constant-time
 * primitive used elsewhere; malformed hex resolves to `false` (treated as "does not match").
 */
export function presentedKeyMatchesPin(pinnedPublicKeyHex: string, presentedPublicKeyHex: string): boolean {
  try {
    return equalBytes(hexToBytes(pinnedPublicKeyHex), hexToBytes(presentedPublicKeyHex));
  } catch {
    return false;
  }
}

// --- reconnect wire frames (over the already-bound DataChannel, NOT file bytes) ----------------
// The DataChannel is DTLS-protected (a relay cannot tamper with these frames), but they are still
// validated to EXACT decoded lengths (pairingId 16 B, challenge 16 B, pubKey 32 B, sig 64 B) so a
// malformed control message is rejected before it reaches the crypto. Hex ⇒ exactly 2× the bytes.
const HEX = /^(?:[0-9a-fA-F]{2})*$/;
const PAIRING_ID_HEX = PAIRING_ID_BYTES * 2;
const CHALLENGE_HEX = RECONNECT_CHALLENGE_BYTES * 2;
const PUBKEY_HEX = PUBKEY_BYTES * 2;
const SIG_HEX = SIG_BYTES * 2;

/** Initiator → responder: announce the pairingId to reconnect under + the initiator's challenge. */
export const reconnectInitSchema = z.object({
  kind: z.literal('reconnect-init'),
  pairingId: z.string().regex(HEX).length(PAIRING_ID_HEX),
  challenge: z.string().regex(HEX).length(CHALLENGE_HEX),
});

/** Either side's proof: the sender's challenge, its PRESENTED pubkey, and its signature. */
export const reconnectProofSchema = z.object({
  kind: z.literal('reconnect-proof'),
  challenge: z.string().regex(HEX).length(CHALLENGE_HEX),
  pubKey: z.string().regex(HEX).length(PUBKEY_HEX),
  sig: z.string().regex(HEX).length(SIG_HEX),
});

/** Responder → initiator: "I hold no pin for that pairingId" → both fall back to the human step. */
export const reconnectFallbackSchema = z.object({ kind: z.literal('reconnect-fallback') });

export const reconnectFrameSchema = z.discriminatedUnion('kind', [
  reconnectInitSchema,
  reconnectProofSchema,
  reconnectFallbackSchema,
]);
export type ReconnectInit = z.infer<typeof reconnectInitSchema>;
export type ReconnectProof = z.infer<typeof reconnectProofSchema>;
export type ReconnectFallback = z.infer<typeof reconnectFallbackSchema>;
export type ReconnectFrame = z.infer<typeof reconnectFrameSchema>;
