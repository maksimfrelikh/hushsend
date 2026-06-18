/**
 * Long-term identity key for TOFU pinning + reconnect signatures (Ed25519).
 * Prefer WebCrypto non-extractable Ed25519 (the private key never enters the JS
 * heap); fall back to @noble/curves Ed25519 on browsers lacking WebCrypto Ed25519.
 * Signatures are interoperable across both paths.
 */
export interface IdentityKey {
  publicKey: Uint8Array;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

export async function loadOrCreateIdentity(): Promise<IdentityKey> {
  // TODO: try crypto.subtle.generateKey('Ed25519', extractable:false, ['sign','verify']),
  //       persist the CryptoKey in IndexedDB (core/crypto/keystore.ts);
  //       else @noble/curves ed25519, persisting raw key bytes in IndexedDB.
  throw new Error('loadOrCreateIdentity not implemented');
}

export async function verifySignature(
  _publicKey: Uint8Array,
  _message: Uint8Array,
  _signature: Uint8Array,
): Promise<boolean> {
  // TODO: Ed25519 verify (WebCrypto where available, else noble).
  throw new Error('verifySignature not implemented');
}
