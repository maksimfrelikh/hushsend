import { describe, it, expect } from 'vitest';
import { Keystore, MemoryKeystoreBackend } from '../core/keystore';
import { loadRecentDevices, dedupeByPeerKey } from './recentDevices';

/**
 * Recent-devices list is deduped by `peerPublicKey` (the stable identity), NOT by `pairingId`:
 * every fresh pairing mints a new pairingId for the same peer, so without dedup the home screen
 * would render one row per pin. Exercised over the in-memory keystore backend (no IndexedDB).
 */

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const pid = (n: string) => n.repeat(32).slice(0, 32);

describe('loadRecentDevices — dedup by peerPublicKey', () => {
  it('collapses several pins of ONE peer key into one row (the freshest pin)', async () => {
    const ks = new Keystore(new MemoryKeystoreBackend());
    // Three pins, distinct pairingIds, SAME peerPublicKey, increasing firstSeen.
    await ks.putPin(pid('1'), KEY_A, { firstSeen: 100 });
    await ks.putPin(pid('2'), KEY_A, { firstSeen: 300 }); // freshest
    await ks.putPin(pid('3'), KEY_A, { firstSeen: 200 });

    const rows = await loadRecentDevices(ks);

    expect(rows).toHaveLength(1);
    expect(rows[0].peerPublicKey).toBe(KEY_A);
    expect(rows[0].firstSeen).toBe(300); // display fields come from the freshest pin
    expect(rows[0].pairingId).toBe(pid('2')); // reconnect uses the freshest pin's pairingId
  });

  it('keeps DISTINCT peer keys as distinct rows, ordered most-recent first', async () => {
    const ks = new Keystore(new MemoryKeystoreBackend());
    await ks.putPin(pid('1'), KEY_A, { firstSeen: 100 }); // older peer A
    await ks.putPin(pid('2'), KEY_A, { firstSeen: 150 }); // freshest A pin
    await ks.putPin(pid('3'), KEY_B, { firstSeen: 400 }); // newer peer B

    const rows = await loadRecentDevices(ks);

    expect(rows.map((r) => r.peerPublicKey)).toEqual([KEY_B, KEY_A]); // newest first
    expect(rows.map((r) => r.pairingId)).toEqual([pid('3'), pid('2')]);
  });

  it('returns an empty list when nothing is pinned', async () => {
    const ks = new Keystore(new MemoryKeystoreBackend());
    expect(await loadRecentDevices(ks)).toEqual([]);
  });

  it('dedupeByPeerKey carries a label from the freshest pin', () => {
    const rows = dedupeByPeerKey([
      { pairingId: pid('1'), peerPublicKey: KEY_A, firstSeen: 100, label: 'old' },
      { pairingId: pid('2'), peerPublicKey: KEY_A, firstSeen: 200, label: 'new' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pairingId: pid('2'), label: 'new', firstSeen: 200 });
  });
});
