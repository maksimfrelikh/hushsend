/**
 * CPace — balanced PAKE for the "words" method.
 *
 * Implements the **CPACE-RISTRETTO255-SHA512** cipher suite of
 * draft-irtf-cfrg-cpace-21 ("CPace, a balanced composable PAKE", April 2026).
 * Built on `@noble/curves` ristretto255 (RFC 9496 group abstraction +
 * §4.3.4 element-derivation, exposed as `deriveToCurve`) and `@noble/hashes`
 * SHA-512. Verified against the official appendix B.3 test vectors
 * (group object `G_Ristretto255`, JSON key `G_Coffee25519`).
 *
 * Protocol shape: a single simultaneous round trip. Each side derives a
 * password-dependent generator `g`, sends its public point `Y = g^y`, and on
 * receiving the peer's point computes the shared point `K` and derives the
 * intermediate session key (ISK) from a prefix-free transcript. Equal ISK on
 * both sides iff both used the same password (PRS), CI and sid.
 *
 * The PAKE password (PRS) is the SECRET words only — the rendezvous word
 * (public routing) is excluded. At this step PRS is raw bytes; the words →
 * bytes mapping is wired in 3b.
 *
 * SECURITY NOTE: JavaScript does not provide constant-time guarantees. The
 * scalar arithmetic in @noble/curves is written to avoid obvious data-dependent
 * branches, but timing/cache side-channels cannot be ruled out on the JS/JIT
 * platform. This is acceptable here (online-guessing-bounded PAKE in a browser),
 * but do not treat it as a hardened constant-time implementation.
 */
import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { bytesToNumberLE, concatBytes } from '@noble/curves/utils.js';
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { sha512 } from '@noble/hashes/sha2.js';

// --- Cipher-suite constants (draft-irtf-cfrg-cpace-21 §8.3, §B.3) ---------

/** G_Ristretto255.DSI — domain separation identifier for generator derivation. */
const DSI = utf8ToBytes('CPaceRistretto255');
/** G.DSI || b"_ISK" — domain separation for the ISK hash. */
const DSI_ISK = utf8ToBytes('CPaceRistretto255_ISK');
/** H.s_in_bytes — SHA-512 input block size, used to size the generator ZPAD. */
const S_IN_BYTES = 128;
/** G_Ristretto255.field_size_bytes; the generator hash is 2*field_size = 64 bytes. */
const FIELD_SIZE_BYTES = 32;
/** G_Ristretto255.group_order = 2^252 + 27742317777372353535851937790883648493. */
const GROUP_ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;
/** G_Ristretto255.group_size_bits — scalars are sampled with the bits above this cleared. */
const GROUP_SIZE_BITS = 252;

const EMPTY = new Uint8Array(0);

/**
 * RFC 9496 §4.3.4 element-derivation (64 uniform bytes → ristretto255 point).
 * Typed optional in @noble's hash-to-curve interface but always present for
 * ristretto255; resolve once so a future removal fails loudly here.
 */
const elementDerivation = ristretto255_hasher.deriveToCurve;
if (!elementDerivation) {
  throw new Error('CPace: ristretto255 element-derivation (deriveToCurve) unavailable');
}

// --- String utility functions (draft §A.1–A.3) ----------------------------

/** prepend_len: LEB128 length prefix followed by the data (draft §A.1.1). */
function prependLen(data: Uint8Array): Uint8Array {
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

/** lv_cat: length-value concatenation of the arguments (draft §A.1.3). */
function lvCat(...args: Uint8Array[]): Uint8Array {
  return concatBytes(...args.map(prependLen));
}

/** lexicographically_larger(a, b): true if a > b in lexicographic order (draft §A.3.1). */
function lexicographicallyLarger(a: Uint8Array, b: Uint8Array): boolean {
  const minLen = Math.min(a.length, b.length);
  for (let i = 0; i < minLen; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return a.length > b.length;
}

/** o_cat: ordered concatenation, larger string first, prefixed with b"oc" (draft §A.3.2). */
function oCat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const oc = utf8ToBytes('oc');
  return lexicographicallyLarger(a, b) ? concatBytes(oc, a, b) : concatBytes(oc, b, a);
}

/** transcript_ir = lv_cat(Ya,ADa) || lv_cat(Yb,ADb) (initiator/responder, draft §A.3.4). */
function transcriptIr(Ya: Uint8Array, ADa: Uint8Array, Yb: Uint8Array, ADb: Uint8Array): Uint8Array {
  return concatBytes(lvCat(Ya, ADa), lvCat(Yb, ADb));
}

/** transcript_oc = o_cat(lv_cat(Ya,ADa), lv_cat(Yb,ADb)) (symmetric, draft §A.3.6). */
function transcriptOc(Ya: Uint8Array, ADa: Uint8Array, Yb: Uint8Array, ADb: Uint8Array): Uint8Array {
  return oCat(lvCat(Ya, ADa), lvCat(Yb, ADb));
}

/** generator_string (draft §A.2): lv_cat(DSI, PRS, zero_bytes(len_zpad), CI, sid). */
function generatorString(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): Uint8Array {
  // The zero padding pushes PRS into the first hash block (anti-amortization).
  const lenZpad = Math.max(
    0,
    S_IN_BYTES - 1 - prependLen(prs).length - prependLen(DSI).length,
  );
  return lvCat(DSI, prs, new Uint8Array(lenZpad), ci, sid);
}

/**
 * G.calculate_generator (draft §8.3): hash the generator string to 2*field_size
 * bytes with SHA-512, then map to the group via the ristretto255 element-derivation
 * function (RFC 9496 §4.3.4 — `deriveToCurve`). Returns the internal point.
 */
function calculateGeneratorPoint(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array) {
  const genStr = generatorString(prs, ci, sid);
  const genHash = sha512(genStr).subarray(0, 2 * FIELD_SIZE_BYTES); // SHA-512 already yields 64
  return elementDerivation!(genHash); // guarded to be present at module load above

}

// --- Scalar handling -------------------------------------------------------

/**
 * G.sample_scalar — the RECOMMENDED *clamping* variant of draft-irtf-cfrg-cpace-21
 * §8.3 (not the alternative uniform-rejection variant):
 *   1. take group_size_bytes = ceil(group_size_bits/8) = ceil(252/8) = 32 CSPRNG
 *      bytes (for ristretto255 this equals field_size_bytes);
 *   2. clear the bits above group_size_bits (252) — i.e. the top nibble of the
 *      last byte — so the integer lies in [0, 2^252);
 *   3. interpret little-endian.
 * We additionally reject 0 (drawn with probability 2^-252) so the result is in
 * [1, 2^252).
 *
 * Conformance & bias: the ristretto255 group order is l = 2^252 + δ, where
 * δ = 27742317777372353535851937790883648493 ≈ 2^124.4. Hence [1, 2^252) ⊂ [1, l-1]
 * and every sampled value is a valid non-zero exponent (strictly < l, verified
 * again in decodeScalar). The only departure from a perfectly uniform draw over
 * [1, l-1] is the unreachable top window [2^252, l), whose width δ is a fraction
 * δ/l ≈ 2^-127.6 of the range — a statistical bias far below cryptographic
 * relevance. The draft endorses this clamping precisely because it avoids the
 * data-dependent control flow of rejection sampling. So we keep the clamp rather
 * than reaching for a wide-reduction reducer. (CSPRNG via @noble/hashes randomBytes.)
 */
function sampleScalarBytes(): Uint8Array {
  for (;;) {
    const b = randomBytes(FIELD_SIZE_BYTES);
    b[FIELD_SIZE_BYTES - 1] &= (1 << (GROUP_SIZE_BITS % 8)) - 1; // clear bits 252..255
    if (bytesToNumberLE(b) !== 0n) return b;
  }
}

/** Decode little-endian scalar bytes into a validated exponent in [1, group_order). */
function decodeScalar(bytes: Uint8Array): bigint {
  const s = bytesToNumberLE(bytes);
  if (s <= 0n || s >= GROUP_ORDER) {
    throw new Error('CPace: scalar out of range [1, group_order)');
  }
  return s;
}

// --- Public API ------------------------------------------------------------

/** Transcript ordering / party role for ISK derivation. */
export type CPaceRole = 'initiator' | 'responder' | 'symmetric';

export interface CPaceInitOptions {
  /**
   * Channel identifier CI bound into the generator (draft §10.1). Typically the
   * two party identifiers; public, integrity-protected. Defaults to empty.
   */
  ci?: Uint8Array;
  /** This party's associated data (ADa for the initiator / ADb for the responder). */
  ad?: Uint8Array;
  /**
   * Transcript ordering for ISK derivation:
   * - `initiator` / `responder`: ordered (initiator-responder) transcript, the
   *   default for hushsend since the "create" side is a clear initiator.
   * - `symmetric`: ordered-concatenation transcript (role-independent).
   */
  role?: CPaceRole;
  /**
   * TEST/VECTOR ONLY: little-endian bytes of a fixed ephemeral scalar. In
   * production omit this — the scalar is drawn from the CSPRNG via sample_scalar.
   */
  ephemeralScalar?: Uint8Array;
}

/** Opaque per-session state held by the imperative core between the two messages. */
export interface CPaceState {
  /** secret ephemeral scalar y (never leaves the core, never serialized) */
  readonly scalar: bigint;
  /** our outgoing public point Y, ristretto-encoded */
  readonly ownMsg: Uint8Array;
  /** our associated data */
  readonly ownAd: Uint8Array;
  /** session id */
  readonly sid: Uint8Array;
  /** role / transcript ordering chosen at init */
  readonly role: CPaceRole;
}

/**
 * Begin a CPace session: derive the password-dependent generator and our public
 * point. Returns the state to keep and the `msg` (encoded point Y) to send to
 * the peer.
 *
 * @param prs Password (the secret words, raw bytes; rendezvous word excluded).
 * @param sid Session identifier shared with the peer.
 */
export function init(
  prs: Uint8Array,
  sid: Uint8Array,
  options: CPaceInitOptions = {},
): { state: CPaceState; msg: Uint8Array } {
  const ci = options.ci ?? EMPTY;
  const ad = options.ad ?? EMPTY;
  const role = options.role ?? 'initiator';
  const scalar = decodeScalar(options.ephemeralScalar ?? sampleScalarBytes());

  const g = calculateGeneratorPoint(prs, ci, sid);
  const msg = g.multiply(scalar).toBytes(); // Y = g^y, ristretto-encoded

  return { state: { scalar, ownMsg: msg, ownAd: ad, sid, role }, msg };
}

/**
 * Finish a CPace session: combine the peer's message with our secret scalar to
 * obtain the shared point K, then derive ISK from the prefix-free transcript.
 *
 * Aborts (throws) if the peer point fails to decode or if K is the identity
 * element — the scalar_mult_vfy abort conditions (draft §8.3, §9) that defend
 * against invalid / low-order point injection.
 *
 * @param peerMsg The peer's encoded public point.
 * @param peerAd  The peer's associated data (ADb for the initiator's view, etc.).
 * @returns The 64-byte intermediate session key (ISK).
 */
export function finish(state: CPaceState, peerMsg: Uint8Array, peerAd: Uint8Array = EMPTY): Uint8Array {
  let peerPoint: ReturnType<typeof ristretto255.Point.fromBytes>;
  try {
    peerPoint = ristretto255.Point.fromBytes(peerMsg);
  } catch {
    throw new Error('CPace: peer point failed to decode — aborting');
  }

  const kPoint = peerPoint.multiply(state.scalar);
  if (kPoint.is0()) {
    throw new Error('CPace: shared point K is the identity element — aborting');
  }
  const K = kPoint.toBytes();

  let transcript: Uint8Array;
  if (state.role === 'symmetric') {
    // o_cat is order-independent, so both peers compute the same transcript.
    transcript = transcriptOc(state.ownMsg, state.ownAd, peerMsg, peerAd);
  } else if (state.role === 'initiator') {
    transcript = transcriptIr(state.ownMsg, state.ownAd, peerMsg, peerAd);
  } else {
    // responder: the peer is the initiator (a), we are the responder (b).
    transcript = transcriptIr(peerMsg, peerAd, state.ownMsg, state.ownAd);
  }

  // ISK = H.hash( lv_cat(DSI_ISK, sid, K) || transcript )  (draft §7)
  return sha512(concatBytes(lvCat(DSI_ISK, state.sid, K), transcript));
}

/**
 * Internals exposed solely for verification against the draft's published test
 * vectors. NOT part of the stable API — do not use from application code.
 */
export const _internals = {
  prependLen,
  lvCat,
  oCat,
  lexicographicallyLarger,
  transcriptIr,
  transcriptOc,
  generatorString,
  /** Encoded ristretto255 generator g for the given (PRS, CI, sid). */
  calculateGenerator: (prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): Uint8Array =>
    calculateGeneratorPoint(prs, ci, sid).toBytes(),
  /** ristretto255 group order l (exposed for the sampler sanity test). */
  GROUP_ORDER,
};
