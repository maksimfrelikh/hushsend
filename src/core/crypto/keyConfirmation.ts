/**
 * Channel binding / explicit key-confirmation.
 *
 * After both sides agree on a shared secret — the CPace ISK for the "words"
 * method, or the high-entropy URL-fragment secret S for the "link"/"qr" methods —
 * each side proves it derived the same secret AND binds it to the actual DTLS
 * channel by MAC-ing the negotiated DTLS fingerprints under a key derived from the
 * secret. A man-in-the-middle who terminates DTLS on each leg ends up with two
 * *different* fingerprint pairs and (lacking the secret) cannot derive the
 * confirmation key, so it cannot forge a matching tag — mismatch ⇒ abort, no data
 * flows.
 *
 * Design (pure, no I/O):
 *   confKey = HKDF-SHA512(ikm = secret, info = domain.hkdfInfo, L = 32)
 *   tag     = HMAC-SHA256(confKey, lv(domain.tagLabel) || lv(fp_min) || lv(fp_max) || lv(role))
 *
 * - The DOMAIN is parameterised so the same construction serves both methods with
 *   independent key/tag derivations: `CPACE_CONFIRM_DOMAIN` ("hushsend/cpace/...")
 *   for words, `LINK_CONFIRM_DOMAIN` ("hushsend/link/...") for link/qr. The default
 *   is the CPace domain, so the words call sites are byte-for-byte unchanged.
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

/**
 * Domain separation for a key-confirmation: the HKDF `info` (scopes the derived
 * confirmation key) plus the transcript label (scopes the MAC). Both peers on a
 * given method MUST use the same domain; the two methods use DIFFERENT domains so
 * their tags never interoperate.
 */
export interface ConfirmationDomain {
  /** HKDF `info` — domain separation for the confirmation-key derivation. */
  hkdfInfo: Uint8Array;
  /** label bound into the MAC transcript, scoping the tag to this construction/version. */
  tagLabel: Uint8Array;
}

/** words / CPace path — the DEFAULT domain (these byte strings are unchanged from the
 *  original single-method construction, so the words tags are identical). */
export const CPACE_CONFIRM_DOMAIN: ConfirmationDomain = {
  hkdfInfo: utf8ToBytes('hushsend/cpace/confirm'),
  tagLabel: utf8ToBytes('hushsend/cpace/confirm/v1'),
};

/** link / qr path — high-entropy URL-fragment secret S (no PAKE, no SAS). Distinct from
 *  the CPace domain so an S-derived tag can never be confused with an ISK-derived one. */
export const LINK_CONFIRM_DOMAIN: ConfirmationDomain = {
  hkdfInfo: utf8ToBytes('hushsend/link/confirm'),
  tagLabel: utf8ToBytes('hushsend/link/confirm/v1'),
};

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

/** confKey = HKDF-SHA512(secret) with domain separation via `info`. */
function deriveConfirmationKey(secret: Uint8Array, info: Uint8Array): Uint8Array {
  return hkdf(sha512, secret, undefined, info, CONF_KEY_LEN);
}

/**
 * Build the MAC transcript: the domain label and the two fingerprints in canonical
 * (lexicographic) order plus the role label, each length-prefixed so no field
 * boundary can be shifted. Both peers reach the same byte string for a given role.
 */
function confirmationTranscript(
  localFingerprint: string,
  remoteFingerprint: string,
  role: ConfirmationRole,
  tagLabel: Uint8Array,
): Uint8Array {
  // Canonical order by string comparison (stable across both peers).
  const [first, second] =
    localFingerprint <= remoteFingerprint
      ? [localFingerprint, remoteFingerprint]
      : [remoteFingerprint, localFingerprint];
  return concatBytes(
    lv(tagLabel),
    lv(utf8ToBytes(first)),
    lv(utf8ToBytes(second)),
    lv(utf8ToBytes(role)),
  );
}

/**
 * Produce this party's confirmation tag.
 *
 * @param secret            Shared secret: the CPace ISK (words) or the URL-fragment S (link/qr).
 * @param localFingerprint  Our own DTLS fingerprint (from our local SDP).
 * @param remoteFingerprint The peer's DTLS fingerprint (from the received SDP).
 * @param role              Our role; selects the direction label.
 * @param domain            Method domain separation; defaults to the CPace/words domain.
 */
export function makeConfirmation(
  secret: Uint8Array,
  localFingerprint: string,
  remoteFingerprint: string,
  role: ConfirmationRole,
  domain: ConfirmationDomain = CPACE_CONFIRM_DOMAIN,
): Uint8Array {
  const confKey = deriveConfirmationKey(secret, domain.hkdfInfo);
  const transcript = confirmationTranscript(localFingerprint, remoteFingerprint, role, domain.tagLabel);
  return hmac(sha256, confKey, transcript);
}

/**
 * Verify the peer's confirmation tag.
 *
 * @param secret            Shared secret: the CPace ISK (words) or the URL-fragment S (link/qr).
 * @param localFingerprint  Our own DTLS fingerprint.
 * @param remoteFingerprint The peer's DTLS fingerprint.
 * @param peerRole          The role the *peer* claims (e.g. 'responder' when we
 *                          are the initiator). A tag we made ourselves, reflected
 *                          back, will carry the wrong role label and fail here.
 * @param tag               The tag received from the peer.
 * @param domain            Method domain separation; defaults to the CPace/words domain.
 * @returns true iff the tag is valid (constant-time comparison).
 */
export function verifyConfirmation(
  secret: Uint8Array,
  localFingerprint: string,
  remoteFingerprint: string,
  peerRole: ConfirmationRole,
  tag: Uint8Array,
  domain: ConfirmationDomain = CPACE_CONFIRM_DOMAIN,
): boolean {
  const expected = makeConfirmation(secret, localFingerprint, remoteFingerprint, peerRole, domain);
  return equalBytes(expected, tag);
}
