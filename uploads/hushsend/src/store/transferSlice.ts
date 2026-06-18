import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export type TransferDirection = 'send' | 'receive';

export interface TransferState {
  direction: TransferDirection | null;
  fileName: string | null;
  totalBytes: number;
  transferredBytes: number;
  done: boolean;
}

const initialState: TransferState = {
  direction: null,
  fileName: null,
  totalBytes: 0,
  transferredBytes: 0,
  done: false,
};

const slice = createSlice({
  name: 'transfer',
  initialState,
  reducers: {
    started(
      state,
      action: PayloadAction<{ direction: TransferDirection; fileName: string; totalBytes: number }>,
    ) {
      state.direction = action.payload.direction;
      state.fileName = action.payload.fileName;
      state.totalBytes = action.payload.totalBytes;
      state.transferredBytes = 0;
      state.done = false;
    },
    progress(state, action: PayloadAction<{ transferredBytes: number }>) {
      state.transferredBytes = action.payload.transferredBytes;
    },
    completed(state) {
      state.done = true;
      state.transferredBytes = state.totalBytes;
    },
    reset: () => initialState,
  },
});

export const transferActions = slice.actions;
export default slice.reducer;
