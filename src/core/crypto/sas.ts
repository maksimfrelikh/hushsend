/**
 * Short Authentication String (SAS) for the "room" method.
 *
 * The 4-digit room code is PUBLIC rendezvous only (the untrusted server sees it) — it
 * authenticates nothing. The room method's entire MITM defence is the two humans comparing
 * a short string out-of-band (voice). So the SAS must be unforgeable by a server that sits
 * between the two DTLS legs. We follow the ZRTP / Vaudenay SAS pattern:
 *
 *   1. COMMIT–REVEAL of nonces (kills grinding). The responder (B) commits to its nonce
 *      first — commit = SHA-256("hushsend/sas/commit" || nonceB) — before the initiator (A)
 *      reveals nonceA. Only after A reveals does B reveal nonceB; A then checks the reveal
 *      against the commit. Because B is locked to nonceB before learning nonceA (and A reveals
 *      nonceA while nonceB is still hidden behind the commit), NEITHER side can choose its
 *      nonce as a function of the other's to steer the SAS — an attacker gets one ONLINE shot,
 *      not an offline search.
 *   2. SAS = HKDF-SHA512(IKM = lv(nonceA) || lv(nonceB) || lv(fp_min) || lv(fp_max),
 *      salt = ∅, info = "hushsend/sas") where fp_min/fp_max are the two DTLS fingerprints in
 *      canonical (lexicographic) order. Same KDF as the words key-confirmation (HKDF-SHA512 with
 *      a labelled info, material in the IKM). Binding the fingerprints is the CHANNEL BINDING: a
 *      MITM terminating DTLS on each leg presents different certs, so the two sides feed
 *      different fingerprint pairs into the KDF and compute DIFFERENT words — the humans see a
 *      mismatch and stop.
 *   3. Rendered as 3 words from the EFF short #2 list (~31 bits: 1296^3 ≈ 2^31, comfortably
 *      above ZRTP's ~20-bit floor; readable over a voice channel). Both sides derive the SAME
 *      triple from identical (nonceA, nonceB, fingerprint-pair) inputs.
 *
 * Pure module (except generateNonce's CSPRNG draw): no I/O, no FSM. The transport, the
 * commit-reveal ordering, and the human accept/reject live in SessionController.
 *
 * NOTE: nonceA/nonceB are bound in a FIXED ROLE order (initiator, responder), NOT local/peer
 * order — both peers must pass the initiator's nonce first so their transcripts agree. The
 * fingerprints, by contrast, ARE canonicalised here (the two peers label them local/remote
 * oppositely). lv-encoding mirrors keyConfirmation so the transcript is unambiguous.
 */
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { equalBytes } from '@noble/curves/utils.js';
import { WORDLIST } from '../words/words';

/** Nonce length (bytes). 16 random bytes ⇒ the commit is a 2nd-preimage-hard binding. */
export const NONCE_BYTES = 16;
/** SAS length in words. 3 × log2(1296) ≈ 31 bits — voice-readable, above the ZRTP floor. */
export const SAS_WORD_COUNT = 3;
/** HKDF output bytes per word index. 8 bytes (64 bits) reduced mod 1296 leaves a modulo bias of
 *  ≈1296/2^64 ≈ 7e-17 — effectively bias-free, no rejection loop needed over a fixed KDF output. */
const INDEX_BYTES = 8;

/** Domain separation for the nonce commitment (kept distinct from the SAS hash). */
const COMMIT_DOMAIN = utf8ToBytes('hushsend/sas/commit');
/** Domain separation for the SAS derivation. */
const SAS_DOMAIN = utf8ToBytes('hushsend/sas');

/** Length-value prefix (1-byte-granular LEB128) for an unambiguous transcript — as in keyConfirmation. */
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

/** A fresh CSPRNG nonce. The only impure function here; everything else is deterministic. */
export function generateNonce(): Uint8Array {
  return randomBytes(NONCE_BYTES);
}

/**
 * Commitment to a nonce: SHA-256("hushsend/sas/commit" || nonce). The responder sends this
 * BEFORE the initiator reveals, so the responder cannot adapt its nonce afterwards. The domain
 * is a fixed-length constant prefix and the nonce a fixed length, so the concatenation is
 * unambiguous without length-prefixing.
 */
export function sasCommit(nonce: Uint8Array): Uint8Array {
  return sha256(concatBytes(COMMIT_DOMAIN, nonce));
}

/** Verify a revealed nonce against an earlier commitment (constant-time). */
export function verifySasCommit(commit: Uint8Array, nonce: Uint8Array): boolean {
  return equalBytes(sasCommit(nonce), commit);
}

/**
 * The HKDF input keying material (IKM): the two nonces in FIXED role order (initiator,
 * responder), then the two DTLS fingerprints in CANONICAL (lexicographic) order — each
 * length-prefixed (lv) so no field boundary can shift. Both peers reach the same byte string.
 * The "hushsend/sas" domain is NOT here — it is the HKDF `info` (see computeSasWords).
 */
function sasIkm(
  nonceInitiator: Uint8Array,
  nonceResponder: Uint8Array,
  localFingerprint: string,
  remoteFingerprint: string,
): Uint8Array {
  // Canonical fingerprint order by string comparison (stable across both peers, who hold the
  // same pair labelled local/remote oppositely). This is the channel binding.
  const [fpMin, fpMax] =
    localFingerprint <= remoteFingerprint
      ? [localFingerprint, remoteFingerprint]
      : [remoteFingerprint, localFingerprint];
  return concatBytes(
    lv(nonceInitiator),
    lv(nonceResponder),
    lv(utf8ToBytes(fpMin)),
    lv(utf8ToBytes(fpMax)),
  );
}

/** A bias-free word index from INDEX_BYTES big-endian bytes at offset `o`, reduced mod the
 *  wordlist size. BigInt because a 64-bit value exceeds Number's exact-integer range. */
function indexFromBytes(buf: Uint8Array, o: number): number {
  let v = 0n;
  for (let k = 0; k < INDEX_BYTES; k++) v = (v << 8n) | BigInt(buf[o + k]);
  return Number(v % BigInt(WORDLIST.length));
}

/**
 * Derive the SAS as SAS_WORD_COUNT words from the EFF short #2 list via HKDF-SHA512 — the same
 * KDF as the words key-confirmation. Parameter mapping (fixed here):
 *   IKM  = lv(nonceA) || lv(nonceB) || lv(fp_min) || lv(fp_max)   (the channel-bound material)
 *   info = "hushsend/sas"                                         (domain separation label)
 *   salt = ∅ (empty)                                             (no salt — like keyConfirmation)
 *   L    = SAS_WORD_COUNT * INDEX_BYTES                           (8 bytes per word index)
 * Each INDEX_BYTES slice of the output is reduced mod 1296 (bias ≈ 2^-52, effectively none). Both
 * peers compute the SAME triple from identical (nonceInitiator, nonceResponder, fingerprint-pair).
 *
 * @param nonceInitiator  The INITIATOR's (A / creator's) nonce — always first, regardless of side.
 * @param nonceResponder  The RESPONDER's (B / joiner's) nonce.
 * @param localFingerprint  Our own DTLS fingerprint (from our local SDP).
 * @param remoteFingerprint The peer's DTLS fingerprint (parsed from the RECEIVED SDP).
 */
export function computeSasWords(
  nonceInitiator: Uint8Array,
  nonceResponder: Uint8Array,
  localFingerprint: string,
  remoteFingerprint: string,
): string[] {
  const ikm = sasIkm(nonceInitiator, nonceResponder, localFingerprint, remoteFingerprint);
  // hkdf(hash, ikm, salt, info, length): salt = undefined ⇒ empty, info = SAS_DOMAIN.
  const material = hkdf(sha512, ikm, undefined, SAS_DOMAIN, SAS_WORD_COUNT * INDEX_BYTES);
  const words: string[] = [];
  for (let i = 0; i < SAS_WORD_COUNT; i++) {
    words.push(WORDLIST[indexFromBytes(material, i * INDEX_BYTES)]);
  }
  return words;
}
