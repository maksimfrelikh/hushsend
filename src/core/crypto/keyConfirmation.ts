/**
 * Channel binding / explicit key-confirmation for the "words" method.
 *
 * After CPace yields a shared ISK, each side proves it derived the same key AND
 * binds that key to the actual DTLS channel by MAC-ing the negotiated DTLS
 * fingerprints under a key derived from the ISK. A man-in-the-middle who
 * terminates DTLS on each leg ends up with two *different* fingerprint pairs and
 * (lacking the secret words) cannot derive the confirmation key, so it cannot
 * forge a matching tag — mismatch ⇒ abort, no data flows.
 *
 * Design (pure, no I/O):
 *   confKey = HKDF-SHA512(ikm = ISK, info = "hushsend/cpace/confirm", L = 32)
 *   tag     = HMAC-SHA256(confKey, lv(label) || lv(fp_min) || lv(fp_max) || lv(role))
 *
 * - Both DTLS fingerprints are bound, in a CANONICAL (sorted) order, so the two
 *   peers — who hold the same pair but label them local/remote oppositely —
 *   compute the same transcript.
 * - A role/direction label is bound so a reflected tag (the initiator's own tag
 *   echoed back to it) verifies against a different label and is rejected.
 * - Tag comparison is constant-time.
 *
 * NOTE on the signature: the channel binding must cover *both* fingerprints, so
 * these functions take the local and remote fingerprints (not a single one).
 * SHA-256/512 come from @noble/hashes. JavaScript gives no constant-time
 * guarantees beyond the timing-safe tag comparison below.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { utf8ToBytes, concatBytes } from '@noble/hashes/utils.js';
import { equalBytes } from '@noble/curves/utils.js';

/** Which side produced (or is expected to have produced) a confirmation tag. */
export type ConfirmationRole = 'initiator' | 'responder';

/** HKDF `info` — domain separation for the confirmation key derivation. */
const CONFIRM_DOMAIN = utf8ToBytes('hushsend/cpace/confirm');
/** Bound into the MAC transcript to scope the tag to this construction/version. */
const TAG_LABEL = utf8ToBytes('hushsend/cpace/confirm/v1');
const CONF_KEY_LEN = 32;

/** Length-value prefix (1-byte-granular LEB128) for an unambiguous transcript. */
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

/** confKey = HKDF-SHA512(ISK) with domain separation. */
function deriveConfirmationKey(isk: Uint8Array): Uint8Array {
  return hkdf(sha512, isk, undefined, CONFIRM_DOMAIN, CONF_KEY_LEN);
}

/**
 * Build the MAC transcript: the two fingerprints in canonical (lexicographic)
 * order plus the role label, each length-prefixed so no field boundary can be
 * shifted. Both peers reach the same byte string for a given role.
 */
function confirmationTranscript(
  localFingerprint: string,
  remoteFingerprint: string,
  role: ConfirmationRole,
): Uint8Array {
  // Canonical order by string comparison (stable across both peers).
  const [first, second] =
    localFingerprint <= remoteFingerprint
      ? [localFingerprint, remoteFingerprint]
      : [remoteFingerprint, localFingerprint];
  return concatBytes(
    lv(TAG_LABEL),
    lv(utf8ToBytes(first)),
    lv(utf8ToBytes(second)),
    lv(utf8ToBytes(role)),
  );
}

/**
 * Produce this party's confirmation tag.
 *
 * @param isk               Shared CPace session key.
 * @param localFingerprint  Our own DTLS fingerprint (from our local SDP).
 * @param remoteFingerprint The peer's DTLS fingerprint (from the received SDP).
 * @param role              Our role; selects the direction label.
 */
export function makeConfirmation(
  isk: Uint8Array,
  localFingerprint: string,
  remoteFingerprint: string,
  role: ConfirmationRole,
): Uint8Array {
  const confKey = deriveConfirmationKey(isk);
  const transcript = confirmationTranscript(localFingerprint, remoteFingerprint, role);
  return hmac(sha256, confKey, transcript);
}

/**
 * Verify the peer's confirmation tag.
 *
 * @param isk               Shared CPace session key.
 * @param localFingerprint  Our own DTLS fingerprint.
 * @param remoteFingerprint The peer's DTLS fingerprint.
 * @param peerRole          The role the *peer* claims (e.g. 'responder' when we
 *                          are the initiator). A tag we made ourselves, reflected
 *                          back, will carry the wrong role label and fail here.
 * @param tag               The tag received from the peer.
 * @returns true iff the tag is valid (constant-time comparison).
 */
export function verifyConfirmation(
  isk: Uint8Array,
  localFingerprint: string,
  remoteFingerprint: string,
  peerRole: ConfirmationRole,
  tag: Uint8Array,
): boolean {
  const expected = makeConfirmation(isk, localFingerprint, remoteFingerprint, peerRole);
  return equalBytes(expected, tag);
}
