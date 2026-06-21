import { defaultKeystore, type Keystore, type PinEntry } from '../core/keystore';

/**
 * Recent paired devices for the home screen, READ FROM THE KEYSTORE — the single source of truth
 * for pins/keys/labels. The keystore (IndexedDB) already persists `pairingId → { peerPublicKey,
 * firstSeen, label? }` across reloads/tabs, so the UI reads them directly rather than duplicating
 * any key material into localStorage. `listPins()` returns plain serializable records (hex strings
 * + numbers) — no live objects, no private keys — so this stays on the UI side of the boundary.
 *
 * The list is DEDUPED by `peerPublicKey` (the stable identity), NOT by `pairingId`. Every *fresh*
 * pairing runs enrollment, which mints a NEW key-independent `pairingId` (and the dual-pin-after-wipe
 * caveat does the same), so the SAME peer can hold several pins under distinct pairingIds. Without
 * dedup the home screen renders one row per pin → the same device shows up several times. This is a
 * DISPLAY-only fix: pins are NOT removed from the keystore (a keystore GC / pin-merge is a separate,
 * still-deferred change — see § Known residuals / dual-pin), and the reconnect protocol stays keyed
 * by `pairingId` on the wire. The keystore can be injected for unit tests (default: the app keystore).
 */
export async function loadRecentDevices(keystore: Keystore = defaultKeystore()): Promise<PinEntry[]> {
  try {
    return dedupeByPeerKey(await keystore.listPins());
  } catch {
    return []; // no IndexedDB / fresh profile — nothing pinned yet
  }
}

/**
 * Collapse pins to one row per distinct `peerPublicKey`, keeping the MOST-RECENT pin for each (by
 * `firstSeen`). The surviving entry carries that freshest pin's `pairingId` (used for the reconnect
 * action — both sides pinned it at the most recent enrollment, so it is a valid pairingId to
 * reconnect under) and its `label` / `firstSeen` for display. Rows are ordered most-recent first.
 */
export function dedupeByPeerKey(pins: PinEntry[]): PinEntry[] {
  const freshestByKey = new Map<string, PinEntry>();
  for (const pin of pins) {
    const seen = freshestByKey.get(pin.peerPublicKey);
    if (!seen || pin.firstSeen > seen.firstSeen) freshestByKey.set(pin.peerPublicKey, pin);
  }
  return [...freshestByKey.values()].sort((a, b) => b.firstSeen - a.firstSeen);
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
