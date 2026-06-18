import { configureStore } from '@reduxjs/toolkit';
import connection from './connectionSlice';
import transfer from './transferSlice';

/**
 * The store holds ONLY serializable projections of session state.
 * Live objects (RTCPeerConnection, RTCDataChannel, WebSocket, CryptoKey) must
 * never be placed here — they live in the SessionController (core). Because of
 * that, RTK's default serializability check stays ON.
 */
export const store = configureStore({
  reducer: { connection, transfer },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
