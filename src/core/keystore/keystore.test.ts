import { describe, it, expect, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { Keystore, MemoryKeystoreBackend } from './index';
import type { StoredIdentity } from './types';

function fixtureIdentity(): StoredIdentity {
  const seed = new Uint8Array(32).map((_, i) => (i * 3 + 1) & 0xff);
  return { kind: 'noble', seed, publicKey: Uint8Array.from(ed25519.getPublicKey(seed)) };
}

describe('keystore', () => {
  it('pins: put / get / list / remove round-trip', async () => {
    const ks = new Keystore(new MemoryKeystoreBackend());
    const pairingId = 'a'.repeat(32);
    const peerKey = 'b'.repeat(64);

    expect(await ks.getPin(pairingId)).toBeNull();

    const stored = await ks.putPin(pairingId, peerKey, { firstSeen: 1234 });
    expect(stored).toEqual({ peerPublicKey: peerKey, firstSeen: 1234 });

    expect(await ks.getPin(pairingId)).toEqual({ peerPublicKey: peerKey, firstSeen: 1234 });

    const list = await ks.listPins();
    expect(list).toEqual([{ pairingId, peerPublicKey: peerKey, firstSeen: 1234 }]);

    await ks.removePin(pairingId);
    expect(await ks.getPin(pairingId)).toBeNull();
    expect(await ks.listPins()).toEqual([]);
  });

  it('putPin keeps an optional label', async () => {
    const ks = new Keystore(new MemoryKeystoreBackend());
    await ks.putPin('c'.repeat(32), 'd'.repeat(64), { firstSeen: 7, label: 'alice' });
    expect(await ks.getPin('c'.repeat(32))).toEqual({
      peerPublicKey: 'd'.repeat(64),
      firstSeen: 7,
      label: 'alice',
    });
  });

  it('loadOrCreateIdentity generates once, then loads (generator not called again)', async () => {
    const ks = new Keystore(new MemoryKeystoreBackend());
    const fixture = fixtureIdentity();
    const generate = vi.fn(async () => fixture);

    const first = await ks.loadOrCreateIdentity(generate);
    const second = await ks.loadOrCreateIdentity(generate);

    expect(generate).toHaveBeenCalledTimes(1); // second call hit the stored record
    expect(first).toEqual(fixture);
    expect(second).toEqual(fixture);
  });

  it('clearAll wipes identity and pins', async () => {
    const ks = new Keystore(new MemoryKeystoreBackend());
    const fixture = fixtureIdentity();
    await ks.loadOrCreateIdentity(async () => fixture);
    await ks.putPin('e'.repeat(32), 'f'.repeat(64), { firstSeen: 1 });

    await ks.clearAll();

    expect(await ks.listPins()).toEqual([]);
    const regen = vi.fn(async () => fixture);
    await ks.loadOrCreateIdentity(regen);
    expect(regen).toHaveBeenCalledTimes(1); // identity was gone after clearAll
  });
});
