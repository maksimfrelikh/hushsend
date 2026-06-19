import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Keystore, MemoryKeystoreBackend } from '../keystore';
import { getOrCreateIdentity, restoreIdentity, verifySignature } from './identity';

describe('identity', () => {
  it('round-trips: own pubkey verifies its own signature', async () => {
    const keystore = new Keystore(new MemoryKeystoreBackend());
    const id = await getOrCreateIdentity(keystore);

    expect(id.publicKey).toBeInstanceOf(Uint8Array);
    expect(id.publicKey.length).toBe(32);

    const msg = utf8ToBytes('hello hushsend');
    const sig = await id.sign(msg);
    expect(sig.length).toBe(64);

    expect(await verifySignature(id.publicKey, msg, sig)).toBe(true);
  });

  it('rejects a signature under a wrong message or wrong key', async () => {
    const keystore = new Keystore(new MemoryKeystoreBackend());
    const id = await getOrCreateIdentity(keystore);
    const msg = utf8ToBytes('original');
    const sig = await id.sign(msg);

    expect(await verifySignature(id.publicKey, utf8ToBytes('tampered'), sig)).toBe(false);

    const otherSeed = Uint8Array.from(ed25519.utils.randomSecretKey());
    const otherPub = Uint8Array.from(ed25519.getPublicKey(otherSeed));
    expect(await verifySignature(otherPub, msg, sig)).toBe(false);
  });

  it('persists: a second load returns the SAME public key (stored, not regenerated)', async () => {
    const keystore = new Keystore(new MemoryKeystoreBackend());
    const first = await getOrCreateIdentity(keystore);
    const second = await getOrCreateIdentity(keystore);
    expect(second.publicKey).toEqual(first.publicKey);
  });

  it('noble fallback path signs and verifies (deterministic seed)', async () => {
    // Exercise the byte-fallback path explicitly, independent of WebCrypto availability.
    const seed = new Uint8Array(32).map((_, i) => (i + 1) & 0xff);
    const publicKey = Uint8Array.from(ed25519.getPublicKey(seed));
    const id = restoreIdentity({ kind: 'noble', seed, publicKey });

    expect(id.publicKey).toEqual(publicKey);
    const msg = utf8ToBytes('fallback message');
    const sig = await id.sign(msg);
    expect(sig.length).toBe(64);
    expect(await verifySignature(publicKey, msg, sig)).toBe(true);
  });
});
