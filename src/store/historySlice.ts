import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

/**
 * SESSION-ONLY transfer history (in-memory Redux state — NOT persisted).
 *
 * A short list of completed transfers (file name, size, direction, timestamp), kept ONLY in the
 * store for the lifetime of the page. It is deliberately NOT written to localStorage: file names are
 * a privacy trail and this is a privacy tool, so the history is gone on reload / tab close. The store
 * holds only this serializable projection — no live objects, no key material (RTK's serializability
 * check stays ON).
 *
 * What lives WHERE (privacy boundary): localStorage holds ONLY prefs (lang/theme/privacy mode,
 * prefs.tsx); IndexedDB holds the keystore pins (contacts/keys); transfer history is in-memory only.
 */

export type TransferDirection = 'send' | 'receive';

export interface TransferRecord {
  /** monotonic-ish id (timestamp + name) just for React keys. */
  id: string;
  fileName: string;
  totalBytes: number;
  direction: TransferDirection;
  at: number;
}

/** Cap the in-memory list so a long-lived tab can't grow it without bound. */
const HISTORY_CAP = 12;

export interface HistoryState {
  /** Completed transfers, newest first. */
  records: TransferRecord[];
}

const initialState: HistoryState = { records: [] };

const slice = createSlice({
  name: 'history',
  initialState,
  reducers: {
    /** Record a completed transfer (prepended; capped at HISTORY_CAP). The `id`/`at` are supplied by
     *  the caller so the reducer stays pure (no Date.now() inside a reducer). */
    remembered(state, action: PayloadAction<TransferRecord>) {
      state.records = [action.payload, ...state.records].slice(0, HISTORY_CAP);
    },
    /** Clear the in-memory history (pairs with the "forget pinned devices" reset). */
    forgotten(state) {
      state.records = [];
    },
  },
});

export const historyActions = slice.actions;
export default slice.reducer;
