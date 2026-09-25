/**
 * TOFU reconnect re-authentication (step 4b-ii) — re-establish trust between two peers that
 * ALREADY pinned each other's long-term Ed25519 identity (in a prior {@link ./enrollment}), with
 * NO human step: no SAS, no spoken words, and — since 2026-09-25 — NO CODE. The pin replaces the
 * human: each side proves possession of the private key behind the pinned public key, bound to
 * THIS session's DTLS channel.
 *
 * There are three pieces, all keyed by the `pairingId` the two peers minted together at enrollment
 * (16 CSPRNG bytes exchanged over the DTLS-protected, authenticated channel — a SHARED SECRET, held
 * only in the two keystores; it never went to the server and appears in no signaling schema):
 *
 *   1. {@link reconnectRendezvous} — WHERE to meet. Both sides derive the same 128-bit rendezvous
 *      token from `HMAC(pairingId, DOMAIN ‖ time-bucket)` and each asks the untrusted server for
 *      that token room (join-or-create, so it does not matter who taps first). No human carries a
 *      code, the token cannot be enumerated or squatted, and it changes every
 *      {@link RECONNECT_BUCKET_MS}, so the server cannot link one day's reconnect to the next by the
 *      room name. On the wire it is indistinguishable from a link/QR rendezvous.
 *   2. {@link reconnectHelloMac} — WHO is in the room. Meeting at the token is not authentication:
 *      the server can put anyone into any room. Before either side reveals its long-term identity
 *      key, each proves knowledge of the pairing secret with a MAC over its fresh challenge, the
 *      DTLS fingerprints and its role. A stranger the server routed in cannot produce it and learns
 *      nothing from it (the MAC is under a 128-bit secret — not offline-guessable). Only a verified
 *      hello unlocks step 3, so the identity key is disclosed to a pin-holder alone.
 *   3. {@link signReconnect} / {@link verifyReconnect} — the signature under the pinned key, exactly
 *      as before: channel-bound to the DTLS fingerprints, fresh per-side challenges, the two-check
 *      verify (key-changed vs MITM) in SessionController.
 *
 * Roles are derived from the DTLS fingerprints ({@link reconnectRoleFor}: the lexicographically
 * smaller fingerprint is the `initiator`), NOT from create/join — there is no creator any more —
 * and NOT from the server-assigned readable ids (a hostile server could hand both peers the same
 * role; it cannot pick the fingerprints without breaking DTLS, and a MITM presenting its own
 * certificates fails the channel binding regardless). The initiator is the verifier-first side:
 * the responder proves first, the initiator verifies, proves, and waits for the responder's
 * `reconnect-ok` before settling — so the two sides never disagree about whether the reconnect
 * succeeded (one settled while the other hard-stopped would be a half-connected pair).
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
 * Same `lv` + sorted-fingerprint canonicalisation as keyConfirmation/sas/enrollment, so the
 * transcripts share one unambiguous wire format. Pure module (except generateChallenge's CSPRNG
 * draw): no I/O, no FSM — the transport, the wait/rollover logic and the two-check gate live in
 * SessionController.
 */
import { z } from 'zod';
import { concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { equalBytes, hexToBytes } from '@noble/curves/utils.js';
import { verifySignature, type IdentityKey } from './identity';
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

// --- rendezvous: WHERE two pinned peers meet, with no code -----------------------------------

/** Domain separation for the rendezvous derivation (distinct from the signing transcript + hello). */
const RENDEZVOUS_DOMAIN = utf8ToBytes('hushsend/identity/reconnect-rendezvous');

/**
 * How long one derived rendezvous token stays valid. Both sides derive the token from the CURRENT
 * bucket of their own clock; a side that is still waiting re-derives at every bucket boundary
 * (SessionController), so two clocks that disagree by less than a bucket still meet — at worst after
 * the skew has elapsed. Within a bucket, repeated attempts show the server the same token; across
 * buckets it sees nothing it can link. 10 minutes trades that linkability window against how much
 * clock skew a pair tolerates without a visible delay.
 */
export const RECONNECT_BUCKET_MS = 10 * 60_000;
/** Bytes of the derived token — the same 16 bytes / 22 base64url chars as a link/QR token, so the
 *  server cannot tell a reconnect rendezvous from a link/QR one by its shape. */
const RENDEZVOUS_TOKEN_BYTES = 16;

/** The bucket index a clock reading falls in. */
export function reconnectBucket(nowMs: number): number {
  return Math.floor(nowMs / RECONNECT_BUCKET_MS);
}

/** Milliseconds from `nowMs` until the NEXT bucket boundary (when a waiting side must re-derive). */
export function msUntilNextBucket(nowMs: number): number {
  return (reconnectBucket(nowMs) + 1) * RECONNECT_BUCKET_MS - nowMs;
}

/** base64url, no padding — the exact shape the server's token validator enforces (22 chars). */
function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The rendezvous token for `pairingId` in `bucket`: `HMAC(pairingId, DOMAIN ‖ bucket)` truncated to
 * a link/QR-shaped token. Deterministic — that is the point: the two pin-holders compute it alone
 * and meet there without anyone carrying a code. Unguessable to anyone else (keyed by the pairing
 * secret), different every bucket (so the server cannot correlate sessions by the room name), and
 * NOT a secret itself: it is public routing, exactly like a link token — authentication is the
 * hello MAC and the signature that follow, not the room name.
 */
export function reconnectRendezvous(pairingId: Uint8Array, bucket: number): string {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(bucket));
  const mac = hmac(sha256, pairingId, concatBytes(lv(RENDEZVOUS_DOMAIN), lv(b)));
  return bytesToB64url(mac.slice(0, RENDEZVOUS_TOKEN_BYTES));
}

// --- roles: from the DTLS fingerprints, not from create/join and not from the server ------------

/**
 * The reconnect protocol role for this pairing: the side whose DTLS fingerprint sorts FIRST is the
 * `initiator` (verifier-first: it verifies the responder's proof before presenting its own). Both
 * sides compute it identically from the same two fingerprints. Equal fingerprints (impossible for
 * two distinct certificates; a wiring bug) resolve to null → the caller fails closed rather than
 * defaulting both sides onto the same role and deadlocking.
 */
export function reconnectRoleFor(localFingerprint: string, remoteFingerprint: string): ConfirmationRole | null {
  if (!localFingerprint || !remoteFingerprint || localFingerprint === remoteFingerprint) return null;
  return localFingerprint < remoteFingerprint ? 'initiator' : 'responder';
}

/** The peer's role given ours (the two are always opposite). */
export function oppositeRole(role: ConfirmationRole): ConfirmationRole {
  return role === 'initiator' ? 'responder' : 'initiator';
}

// --- hello: WHO is in the room, proven before any identity key is shown ------------------------

/** Domain separation for the hello MAC (distinct from the signing transcript + rendezvous). */
const HELLO_DOMAIN = utf8ToBytes('hushsend/identity/reconnect-hello');
/** HMAC-SHA256 output — the hello MAC is sent whole. */
const HELLO_MAC_BYTES = 32;

/**
 * `HMAC(pairingId, DOMAIN ‖ challenge ‖ fp_min ‖ fp_max ‖ role)`: proof that the sender holds the
 * pairing secret, bound to ITS fresh challenge (no replay across sessions), THIS channel's DTLS
 * fingerprints (a relay re-terminating DTLS fails it) and its role (the server echoing our own
 * hello back to us fails it — the roles differ). A stranger routed into the token room by the
 * server cannot produce one and gains nothing from seeing one. Only after the peer's hello verifies
 * does a side send its signed proof — which is what carries the long-term identity public key.
 */
export function reconnectHelloMac(
  pairingId: Uint8Array,
  challenge: Uint8Array,
  localFingerprint: string,
  remoteFingerprint: string,
  role: ConfirmationRole,
): Uint8Array {
  const [fpMin, fpMax] =
    localFingerprint <= remoteFingerprint
      ? [localFingerprint, remoteFingerprint]
      : [remoteFingerprint, localFingerprint];
  return hmac(
    sha256,
    pairingId,
    concatBytes(lv(HELLO_DOMAIN), lv(challenge), lv(utf8ToBytes(fpMin)), lv(utf8ToBytes(fpMax)), lv(utf8ToBytes(role))),
  );
}

/** Constant-time check of a peer's hello MAC, recomputed under OUR pairingId and fingerprints with
 *  the PEER's challenge and role. */
export function verifyReconnectHello(
  pairingId: Uint8Array,
  peerChallenge: Uint8Array,
  localFingerprint: string,
  remoteFingerprint: string,
  peerRole: ConfirmationRole,
  mac: Uint8Array,
): boolean {
  if (mac.length !== HELLO_MAC_BYTES) return false;
  return equalBytes(reconnectHelloMac(pairingId, peerChallenge, localFingerprint, remoteFingerprint, peerRole), mac);
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
// validated to EXACT decoded lengths (challenge 16 B, mac 32 B, pubKey 32 B, sig 64 B) so a
// malformed control message is rejected before it reaches the crypto. Hex ⇒ exactly 2× the bytes.
const HEX = /^(?:[0-9a-fA-F]{2})*$/;
const CHALLENGE_HEX = RECONNECT_CHALLENGE_BYTES * 2;
const HELLO_MAC_HEX = HELLO_MAC_BYTES * 2;
const PUBKEY_HEX = PUBKEY_BYTES * 2;
const SIG_HEX = SIG_BYTES * 2;

/** Both sides, at channel-open: the sender's fresh challenge + its hello MAC (knowledge of the
 *  pairing secret, bound to this channel). Carries NO identity and NO pairing identifier. */
export const reconnectHelloSchema = z.object({
  kind: z.literal('reconnect-hello'),
  challenge: z.string().regex(HEX).length(CHALLENGE_HEX),
  mac: z.string().regex(HEX).length(HELLO_MAC_HEX),
});

/** Either side's proof (sent only after the PEER's hello verified): its PRESENTED pubkey and its
 *  channel-bound signature. The challenge is the sender's own, repeated so the frame is self-contained. */
export const reconnectProofSchema = z.object({
  kind: z.literal('reconnect-proof'),
  challenge: z.string().regex(HEX).length(CHALLENGE_HEX),
  pubKey: z.string().regex(HEX).length(PUBKEY_HEX),
  sig: z.string().regex(HEX).length(SIG_HEX),
});

/** Responder → initiator: "your proof verified, I am connected". The initiator settles only on this,
 *  so a responder that hard-stopped on the initiator's proof never leaves the initiator connected
 *  to nobody — the two sides agree on the outcome. */
export const reconnectOkSchema = z.object({ kind: z.literal('reconnect-ok') });

export const reconnectFrameSchema = z.discriminatedUnion('kind', [
  reconnectHelloSchema,
  reconnectProofSchema,
  reconnectOkSchema,
]);
export type ReconnectHello = z.infer<typeof reconnectHelloSchema>;
export type ReconnectProof = z.infer<typeof reconnectProofSchema>;
export type ReconnectOk = z.infer<typeof reconnectOkSchema>;
export type ReconnectFrame = z.infer<typeof reconnectFrameSchema>;
