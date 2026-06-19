/**
 * Long-term Ed25519 identity for TOFU pinning (and, in 4b-ii, reconnect signatures).
 *
 * Two storage/signing paths, chosen by capability detection ("WebCrypto where available"):
 *
 *  1. **WebCrypto Ed25519 (preferred).** `crypto.subtle.generateKey('Ed25519', extractable=false)`
 *     yields a NON-EXTRACTABLE private `CryptoKey`: the private scalar never enters the JS heap
 *     and cannot be read back, even out of the IndexedDB-stored handle. We export only the raw
 *     32-byte PUBLIC key (public keys are always extractable). sign() calls `subtle.sign`.
 *  2. **@noble/curves fallback.** On engines without WebCrypto Ed25519 (older Safari/Firefox),
 *     we generate a 32-byte seed and store the raw bytes. sign() calls `ed25519.sign`.
 *
 * Detection: attempt a throwaway `generateKey('Ed25519', …)` once and cache the boolean —
 * unsupported engines throw `NotSupportedError`, which selects the fallback. sign() is async to
 * cover both paths uniformly (WebCrypto is inherently async).
 *
 * Signatures interoperate across both paths: both produce/consume standard Ed25519, so a
 * WebCrypto-signed message verifies under noble and vice-versa. {@link verifySignature} uses
 * noble unconditionally — verification touches only PUBLIC keys, so it needs no secure path and
 * no capability detection, and gives one deterministic, always-available verifier for both.
 *
 * ⚠️ PRIVATE-KEY STORAGE LIMITATION: IndexedDB is NOT a secure enclave. The WebCrypto path
 * mitigates this (the stored handle is non-extractable — the bytes can't be exfiltrated). The
 * byte fallback does NOT: the seed sits in IndexedDB as raw bytes, readable by anything with
 * store access (XSS, malicious extension). This is the platform's limit, not a design choice.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { Keystore, defaultKeystore } from '../keystore';
import type { StoredIdentity } from '../keystore/types';

/** A usable identity: the raw 32-byte public key and an async Ed25519 signer. */
export interface IdentityKey {
  /** Raw Ed25519 public key, 32 bytes. */
  publicKey: Uint8Array;
  /** Ed25519 signature over `message`, 64 bytes. Async to cover both crypto paths. */
  sign(message: Uint8Array): Promise<Uint8Array>;
}

/** Cached WebCrypto-Ed25519 capability (null = not yet probed). */
let webCryptoEd25519: boolean | null = null;

/** Probe WebCrypto Ed25519 once: try to generate a throwaway key; cache the result. */
async function supportsWebCryptoEd25519(): Promise<boolean> {
  if (webCryptoEd25519 !== null) return webCryptoEd25519;
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
      webCryptoEd25519 = false;
      return false;
    }
    // A successful generateKey is a strong signal the whole path works.
    await subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    webCryptoEd25519 = true;
  } catch {
    webCryptoEd25519 = false;
  }
  return webCryptoEd25519;
}

/**
 * Generate a fresh identity, preferring the WebCrypto (non-extractable) path. Any failure in the
 * WebCrypto branch (e.g. an engine that generates but won't export the raw public key) falls
 * through to the noble path, so a half-supported engine still yields a working identity.
 */
export async function generateStoredIdentity(): Promise<StoredIdentity> {
  if (await supportsWebCryptoEd25519()) {
    try {
      const subtle = globalThis.crypto.subtle;
      const pair = (await subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair;
      const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
      if (raw.length === 32) return { kind: 'webcrypto', privateKey: pair.privateKey, publicKey: raw };
    } catch {
      /* fall through to the noble path */
    }
  }
  const seed = Uint8Array.from(ed25519.utils.randomSecretKey());
  return { kind: 'noble', seed, publicKey: Uint8Array.from(ed25519.getPublicKey(seed)) };
}

/** Wrap a persisted identity record into a usable {@link IdentityKey} (selects the sign path). */
export function restoreIdentity(stored: StoredIdentity): IdentityKey {
  if (stored.kind === 'webcrypto') {
    const privateKey = stored.privateKey;
    return {
      publicKey: stored.publicKey,
      async sign(message: Uint8Array): Promise<Uint8Array> {
        // Our messages are always plain ArrayBuffer-backed Uint8Arrays; narrow for subtle.sign's
        // BufferSource (ArrayBuffer-backed) parameter — mirrors PeerConnection.send's cast.
        const sig = await globalThis.crypto.subtle.sign(
          { name: 'Ed25519' },
          privateKey,
          message as Uint8Array<ArrayBuffer>,
        );
        return new Uint8Array(sig);
      },
    };
  }
  const seed = stored.seed;
  return {
    publicKey: stored.publicKey,
    async sign(message: Uint8Array): Promise<Uint8Array> {
      return Uint8Array.from(ed25519.sign(message, seed));
    },
  };
}

/**
 * The device's identity, loaded from the keystore or generated + persisted on first use.
 * Defaults to the app-wide IndexedDB keystore; tests inject a memory-backed one.
 */
export async function getOrCreateIdentity(keystore: Keystore = defaultKeystore()): Promise<IdentityKey> {
  const stored = await keystore.loadOrCreateIdentity(generateStoredIdentity);
  return restoreIdentity(stored);
}

/**
 * Verify an Ed25519 signature against a public key. Uses noble unconditionally (a pure,
 * always-available, standard verifier — interoperates with WebCrypto-produced signatures).
 * Malformed inputs (bad point/length) resolve to `false` rather than throwing.
 */
export async function verifySignature(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}
