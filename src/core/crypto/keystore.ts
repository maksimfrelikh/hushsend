/**
 * IndexedDB-backed key storage:
 *  - our own identity key (a non-extractable CryptoKey handle, or raw bytes for the
 *    noble fallback)
 *  - pinned peer public keys (TOFU). A changed key => "key changed" HARD STOP =>
 *    re-verify out of band, never silently accept.
 */
export interface PinnedPeer {
  peerLabel: string;
  publicKey: Uint8Array;
  pinnedAt: number;
}

export async function getPinnedPeer(_peerLabel: string): Promise<PinnedPeer | null> {
  throw new Error('getPinnedPeer not implemented');
}

export async function pinPeer(_peer: PinnedPeer): Promise<void> {
  throw new Error('pinPeer not implemented');
}
