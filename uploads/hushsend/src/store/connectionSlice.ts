import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

/**
 * The connection lifecycle as ONE explicit status field with guarded transitions.
 * This is the hand-rolled finite state machine — no scattered booleans. A single
 * source of truth means security invariants collapse to a status check, e.g.
 * "file bytes only ever flow while status === 'connected'".
 */
export type ConnectionStatus =
  | 'idle' // nothing in progress
  | 'creating' // A: allocating room + generating credential (words / code)
  | 'awaitingPeer' // A: room ready, credential shown, waiting for the other side
  | 'joining' // B: joining the room / entering the credential
  | 'pairing' // key agreement in progress (CPace for words; DTLS setup for room)
  | 'awaitingSas' // room method only: waiting for the human SAS comparison
  | 'confirming' // verifying key-confirmation + channel binding (DTLS fingerprint)
  | 'connected' // authenticated & channel-bound — data is allowed from here on
  | 'failed'; // terminal error (see `error`)

export type ConnectionMethod = 'words' | 'room' | 'link' | 'qr';

export interface ConnectionState {
  status: ConnectionStatus;
  method: ConnectionMethod | null;
  /** human-readable peer label from signaling — a LABEL, not identity */
  peerId: string | null;
  /** rendezvous code shown to A (rendezvous word, or numeric room) */
  room: string | null;
  /** credential to display to the user (e.g. the spoken words), if any */
  credential: string[] | null;
  /** SAS digits/emoji for the room method, when status === 'awaitingSas' */
  sas: string | null;
  /** failure reason when status === 'failed' */
  error: string | null;
}

const initialState: ConnectionState = {
  status: 'idle',
  method: null,
  peerId: null,
  room: null,
  credential: null,
  sas: null,
  error: null,
};

/**
 * Allowed transitions. A request from a state not listed here is ignored (and
 * warned in dev) — an illegal transition can't corrupt the machine.
 */
const ALLOWED: Record<ConnectionStatus, ConnectionStatus[]> = {
  idle: ['creating', 'joining'],
  creating: ['awaitingPeer', 'failed'],
  awaitingPeer: ['pairing', 'failed'],
  joining: ['pairing', 'failed'],
  pairing: ['awaitingSas', 'confirming', 'failed'],
  awaitingSas: ['confirming', 'failed'],
  confirming: ['connected', 'failed'],
  connected: ['idle', 'failed'], // 'idle' = clean session end / reset
  failed: ['idle'],
};

function canGo(from: ConnectionStatus, to: ConnectionStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

function warnIllegal(from: ConnectionStatus, to: ConnectionStatus): void {
  if (import.meta.env.DEV) {
    console.warn(`[connection] illegal transition ${from} -> ${to} ignored`);
  }
}

const slice = createSlice({
  name: 'connection',
  initialState,
  reducers: {
    /** Low-level guarded transition. Prefer the semantic events below. */
    transitioned(state, action: PayloadAction<ConnectionStatus>) {
      const to = action.payload;
      if (!canGo(state.status, to)) return warnIllegal(state.status, to);
      if (to === 'idle') return initialState; // full reset on session end
      state.status = to;
    },

    // --- semantic events (each goes through the same guard) ---
    createStarted(state, action: PayloadAction<{ method: ConnectionMethod }>) {
      if (!canGo(state.status, 'creating')) return warnIllegal(state.status, 'creating');
      state.status = 'creating';
      state.method = action.payload.method;
    },
    roomReady(state, action: PayloadAction<{ room: string; credential: string[] | null }>) {
      if (!canGo(state.status, 'awaitingPeer')) return warnIllegal(state.status, 'awaitingPeer');
      state.status = 'awaitingPeer';
      state.room = action.payload.room;
      state.credential = action.payload.credential;
    },
    joinStarted(state, action: PayloadAction<{ method: ConnectionMethod; room: string }>) {
      if (!canGo(state.status, 'joining')) return warnIllegal(state.status, 'joining');
      state.status = 'joining';
      state.method = action.payload.method;
      state.room = action.payload.room;
    },
    pairingStarted(state, action: PayloadAction<{ peerId: string }>) {
      if (!canGo(state.status, 'pairing')) return warnIllegal(state.status, 'pairing');
      state.status = 'pairing';
      state.peerId = action.payload.peerId;
    },
    sasReady(state, action: PayloadAction<{ sas: string }>) {
      if (!canGo(state.status, 'awaitingSas')) return warnIllegal(state.status, 'awaitingSas');
      state.status = 'awaitingSas';
      state.sas = action.payload.sas;
    },
    confirmStarted(state) {
      if (!canGo(state.status, 'confirming')) return warnIllegal(state.status, 'confirming');
      state.status = 'confirming';
    },
    connectionEstablished(state) {
      if (!canGo(state.status, 'connected')) return warnIllegal(state.status, 'connected');
      state.status = 'connected';
    },
    failed(state, action: PayloadAction<{ reason: string }>) {
      if (!canGo(state.status, 'failed')) return warnIllegal(state.status, 'failed');
      state.status = 'failed';
      state.error = action.payload.reason;
    },
    /** Hard reset back to idle (cancel / session end). */
    reset: () => initialState,
  },
});

export const connectionActions = slice.actions;
export default slice.reducer;
