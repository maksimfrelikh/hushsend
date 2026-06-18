/**
 * Channel binding. Proves both sides derived the same PAKE key AND ties it to the
 * actual DTLS channel by MAC-ing the negotiated DTLS fingerprint under the session
 * key. Mismatch => abort (status 'failed'). A MITM can't forge this: without the
 * secret words it can't derive the key.
 */
export function makeConfirmation(_sessionKey: Uint8Array, _dtlsFingerprint: string): Uint8Array {
  // TODO: HKDF a confirmation key from the session key, HMAC over (transcript || fingerprint).
  throw new Error('makeConfirmation not implemented');
}

export function verifyConfirmation(
  _sessionKey: Uint8Array,
  _dtlsFingerprint: string,
  _tag: Uint8Array,
): boolean {
  throw new Error('verifyConfirmation not implemented');
}
