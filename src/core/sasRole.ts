/**
 * Per-pairing SAS reader/picker role.
 *
 * The room method is a mesh LOBBY: several peers can be in the same 4-digit room and any pair may
 * raise a 1:1 channel — INCLUDING joiner↔joiner. The SAS screen is asymmetric (one side READS its
 * phrase aloud, the other is the BLIND PICKER), so the role cannot be "creator = reader / joiner =
 * picker" — two joiners would both be pickers and the comparison would degenerate (nobody reads).
 *
 * It used to be derived from the two readable signaling ids (smaller id reads). **That was a hole,
 * found in the 2026-09-12 audit:** the ids are assigned by the UNTRUSTED SERVER, independently to
 * each peer, so a malicious server could tell BOTH peers they held the smaller id and make both the
 * blind picker. Nobody reads, and two humans each guessing 1-in-3 is a far cheaper MITM than the
 * ~2^-31 the SAS is supposed to cost. The mirror case (both readers) is caught by the humans hearing
 * two different phrases, but both-pickers is silent.
 *
 * So the split is now derived from the SAS material itself — `sasReaderIsFpMin` in crypto/sas.ts,
 * an HKDF bit over both nonces and both DTLS fingerprints under its own label. The server cannot
 * choose it (it is not a function of the ids), and a MITM cannot steer it either: the nonces are
 * revealed only after the fingerprints are pinned, so the bit is decided after the attacker has
 * already committed to its certificate.
 *
 * `null` means the role cannot be determined (a fingerprint is missing, or — impossibly, since a
 * certificate is fresh per PeerConnection — the two are equal). The UI must FAIL CLOSED on null:
 * render the "restart verification" screen, NEVER a functional blind picker.
 */
export type SasUiRole = 'reader' | 'picker';

/**
 * Resolve OUR role from the two DTLS fingerprints plus the derived "fp_min reads" bit.
 *
 * Both peers hold the same unordered fingerprint pair and the same bit, and each asks whether its
 * OWN fingerprint is the lexicographically smaller one — so exactly one side resolves to `reader`.
 */
export function sasRoleFrom(
  localFingerprint: string | null | undefined,
  remoteFingerprint: string | null | undefined,
  readerIsFpMin: boolean,
): SasUiRole | null {
  if (!localFingerprint || !remoteFingerprint || localFingerprint === remoteFingerprint) return null;
  const localIsMin = localFingerprint < remoteFingerprint;
  return localIsMin === readerIsFpMin ? 'reader' : 'picker';
}
