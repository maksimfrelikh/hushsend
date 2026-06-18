import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export type TransferDirection = 'send' | 'receive';

/**
 * Transfer lifecycle (one active transfer at a time in the dev harness):
 *   idle         — nothing in flight
 *   offered      — send: offer sent, awaiting peer · receive: offer in, awaiting the human
 *   transferring — accepted; bytes flowing
 *   done         — eof received/closed, file complete
 *   rejected     — declined or auto-rejected (size > cap); see `error` for the reason
 *   cancelled    — either side cancelled mid-flight
 *   error        — sink/transport failure; see `error`
 */
export type TransferPhase = 'idle' | 'offered' | 'transferring' | 'done' | 'rejected' | 'cancelled' | 'error';

export interface TransferState {
  direction: TransferDirection | null;
  fileName: string | null;
  totalBytes: number;
  transferredBytes: number;
  phase: TransferPhase;
  /** reject reason / failure message (for rejected | error) */
  error: string | null;
}

const initialState: TransferState = {
  direction: null,
  fileName: null,
  totalBytes: 0,
  transferredBytes: 0,
  phase: 'idle',
  error: null,
};

const slice = createSlice({
  name: 'transfer',
  initialState,
  reducers: {
    /** A transfer was offered (sender) / an offer arrived (receiver). */
    offered(
      state,
      action: PayloadAction<{ direction: TransferDirection; fileName: string; totalBytes: number }>,
    ) {
      state.direction = action.payload.direction;
      state.fileName = action.payload.fileName;
      state.totalBytes = action.payload.totalBytes;
      state.transferredBytes = 0;
      state.phase = 'offered';
      state.error = null;
    },
    /** Offer accepted — bytes start flowing. */
    accepted(state) {
      state.phase = 'transferring';
    },
    progress(state, action: PayloadAction<{ transferredBytes: number }>) {
      state.transferredBytes = action.payload.transferredBytes;
    },
    completed(state) {
      state.phase = 'done';
      state.transferredBytes = state.totalBytes;
    },
    rejected(state, action: PayloadAction<{ reason: string }>) {
      state.phase = 'rejected';
      state.error = action.payload.reason;
    },
    cancelled(state) {
      state.phase = 'cancelled';
    },
    failed(state, action: PayloadAction<{ reason: string }>) {
      state.phase = 'error';
      state.error = action.payload.reason;
    },
    reset: () => initialState,
  },
});

export const transferActions = slice.actions;
export default slice.reducer;
