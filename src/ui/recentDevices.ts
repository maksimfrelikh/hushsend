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
export async function loadRecentDevices(
  keystore: Keystore = defaultKeystore(),
): Promise<PinEntry[]> {
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
 * Forget ONE device: remove every pin that carries its `peerPublicKey`, not just the freshest one
 * the row shows — a row stands for a peer, and the dedup above hides the older pins of the same
 * peer, so removing a single pairingId would surface a stale sibling as a "new" row. Touches only the
 * pins; the own identity and the other devices stay. The peer keeps its pin of us until it forgets us
 * too (a later Reconnect from it ends in "did not show up" and the copy there says to pair afresh).
 */
export async function forgetDevice(
  peerPublicKey: string,
  keystore: Keystore = defaultKeystore(),
): Promise<void> {
  const pins = await keystore.listPins();
  await Promise.all(
    pins
      .filter((p) => p.peerPublicKey === peerPublicKey)
      .map((p) => keystore.removePin(p.pairingId)),
  );
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
