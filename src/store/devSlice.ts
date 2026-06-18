import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

/**
 * TEMPORARY — state for the step-1 transport dev harness only. Delete this slice
 * (and src/ui/DevHarness.tsx, and its line in store/index.ts) once the real screens
 * land in step 5. Holds nothing security-relevant — fingerprints are public values
 * shown only to confirm the DTLS channel was established.
 */
export interface DevState {
  /** our readable signaling id from `welcome` (a label, not identity) */
  selfId: string | null;
  /** local / remote DTLS fingerprints, surfaced once the DataChannel opens */
  localFingerprint: string | null;
  remoteFingerprint: string | null;
  /** ping/echo trace, newest last */
  log: string[];
}

const initialState: DevState = {
  selfId: null,
  localFingerprint: null,
  remoteFingerprint: null,
  log: [],
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
    reset: () => initialState,
  },
});

export const devActions = slice.actions;
export default slice.reducer;
