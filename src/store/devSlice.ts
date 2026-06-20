import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { PrivacyMode } from '../core/iceServers';

/**
 * Auxiliary serializable projections the SessionController publishes for the UI and the DEV
 * diagnostics strip: our own identity pubkey, the pinned peer, DTLS fingerprints, the words
 * attempt counter, the reconnect outcome, and a signaling activity log. Holds nothing
 * security-relevant — public keys, a pairing identifier, and public DTLS fingerprints. The real
 * screens read the non-secret bits they need (own key, pinned peer, attempts, reconnect outcome);
 * the rest is shown only by the DEV-only <Diagnostics> (tree-shaken from production builds).
 */
export interface DevState {
  /** our readable signaling id from `welcome` (a label, not identity) */
  selfId: string | null;
  /** local / remote DTLS fingerprints, surfaced once the DataChannel opens */
  localFingerprint: string | null;
  remoteFingerprint: string | null;
  /** ping/echo trace, newest last */
  log: string[];
  /** words method (A-side): failed pairing attempts against the rendezvous, and the cap. A
   *  projection of the core's online-guessing counter — shown by the harness. */
  pairingAttempts: number;
  maxPairingAttempts: number;
  /** our own long-term Ed25519 public key, hex (TOFU identity — step 4b-i). Public value. */
  ownPublicKey: string | null;
  /** the peer pinned on this connection (TOFU): pairingId + peer pubkey, both hex. A projection
   *  of what was written to the keystore on enrollment; null until pinned. */
  pinnedPeer: { pairingId: string; peerPublicKey: string } | null;
  /** reconnect (step 4b-ii) outcome projection for the harness: `active` once a reconnect is being
   *  attempted; `outcome` is the resolution — authenticated (no SAS), the visible key-changed hard
   *  stop, or a fall-back to the SAS comparison (a pin was missing). Throwaway dev display. */
  reconnect: { active: boolean; outcome: 'authenticated' | 'key-changed' | 'fell-back' | null };
  /** ICE config the PeerConnection was built with (step 6d): the privacy mode, whether a relay was
   *  added, and the TURN creds it carried. Set at pairing start (startPeer). `relay` is true ONLY in
   *  Reliable mode with a non-empty TURN url set. Non-secret dev projection (the credential is the
   *  per-session value also sent to coturn; the shared TURN secret never reaches the client). */
  iceConfig: { mode: PrivacyMode; relay: boolean; urls: string[]; username: string; credential: string } | null;
}

const initialState: DevState = {
  selfId: null,
  localFingerprint: null,
  remoteFingerprint: null,
  log: [],
  pairingAttempts: 0,
  maxPairingAttempts: 0,
  ownPublicKey: null,
  pinnedPeer: null,
  reconnect: { active: false, outcome: null },
  iceConfig: null,
};

const slice = createSlice({
  name: 'dev',
  initialState,
  reducers: {
    setSelfId(state, action: PayloadAction<string>) {
      state.selfId = action.payload;
    },
    setFingerprints(state, action: PayloadAction<{ local: string | null; remote: string | null }>) {
      state.localFingerprint = action.payload.local;
      state.remoteFingerprint = action.payload.remote;
    },
    appendLog(state, action: PayloadAction<string>) {
      state.log.push(action.payload);
    },
    setPairingAttempts(state, action: PayloadAction<{ attempts: number; max: number }>) {
      state.pairingAttempts = action.payload.attempts;
      state.maxPairingAttempts = action.payload.max;
    },
    setOwnPublicKey(state, action: PayloadAction<string | null>) {
      state.ownPublicKey = action.payload;
    },
    setPinnedPeer(state, action: PayloadAction<{ pairingId: string; peerPublicKey: string } | null>) {
      state.pinnedPeer = action.payload;
    },
    setReconnect(
      state,
      action: PayloadAction<{ active: boolean; outcome: 'authenticated' | 'key-changed' | 'fell-back' | null }>,
    ) {
      state.reconnect = action.payload;
    },
    setIceConfig(
      state,
      action: PayloadAction<{ mode: PrivacyMode; relay: boolean; urls: string[]; username: string; credential: string }>,
    ) {
      state.iceConfig = action.payload;
    },
    reset: () => initialState,
  },
});

export const devActions = slice.actions;
export default slice.reducer;
