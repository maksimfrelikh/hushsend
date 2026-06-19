import { defaultKeystore, type PinEntry } from '../core/keystore';

/**
 * Recent paired devices for the home screen, READ FROM THE KEYSTORE — the single source of truth
 * for pins/keys/labels. The keystore (IndexedDB) already persists `pairingId → { peerPublicKey,
 * firstSeen, label? }` across reloads/tabs, so the UI reads them directly rather than duplicating
 * any key material into localStorage. `listPins()` returns plain serializable records (hex strings
 * + numbers) — no live objects, no private keys — so this stays on the UI side of the boundary.
 */
export async function loadRecentDevices(): Promise<PinEntry[]> {
  try {
    const pins = await defaultKeystore().listPins();
    return [...pins].sort((a, b) => b.firstSeen - a.firstSeen); // most-recently-pinned first
  } catch {
    return []; // no IndexedDB / fresh profile — nothing pinned yet
  }
}

/**
 * A short, readable handle for a device: an explicit label if set, else a colon-grouped
 * fingerprint of the first 4 bytes of its PUBLIC key (stable, human-distinguishable).
 */
export function deviceLabel(d: PinEntry): string {
  if (d.label) return d.label;
  const fp = (d.peerPublicKey.slice(0, 8).match(/.{2}/g) ?? []).join(':');
  return `device ${fp}`;
}
