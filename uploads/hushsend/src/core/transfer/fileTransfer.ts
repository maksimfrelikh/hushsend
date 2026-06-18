/**
 * File transfer over the DataChannel.
 *  - Send: chunk + apply backpressure via bufferedAmount / bufferedAmountLowThreshold.
 *  - Receive + save: File System Access (showSaveFilePicker) to stream to disk where
 *    available (Chromium); fall back to an in-memory Blob on iOS Safari / Firefox
 *    (RAM-bound — cap very large files there).
 *
 * INVARIANT: never call sendFile() unless connection status === 'connected'
 * (i.e. after key-confirmation). The UI gates this too.
 */
export interface TransferCallbacks {
  onProgress?: (transferredBytes: number) => void;
  onDone?: () => void;
}

export async function sendFile(
  _channel: RTCDataChannel,
  _file: File,
  _cb: TransferCallbacks = {},
): Promise<void> {
  throw new Error('sendFile not implemented');
}

export async function receiveFile(
  _channel: RTCDataChannel,
  _cb: TransferCallbacks = {},
): Promise<void> {
  throw new Error('receiveFile not implemented');
}
