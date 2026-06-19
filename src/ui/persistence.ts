/**
 * Lightweight, UI-only persistence of NON-KEY metadata across reloads / tabs (localStorage).
 *
 * What is persisted here: a short transfer history (file name, size, direction, timestamp).
 * Language/theme prefs are persisted separately (prefs.tsx).
 *
 * What is NOT persisted here: recent paired DEVICES — those are read from the keystore
 * (recentDevices.ts), which is the single source of pins/keys/labels. No key material lives in
 * localStorage (no peer public keys, no pairingIds), and no secrets (no secret/SAS words, link/QR
 * secrets, CPace passwords, reconnect challenges, or private keys). This module holds only metadata
 * that is safe to show and safe to lose.
 *
 * It reads/writes localStorage directly and holds no live objects, so it never crosses the
 * "no live objects in React/store" boundary.
 */

export interface TransferRecord {
  /** monotonic-ish id (timestamp + name) just for React keys. */
  id: string;
  fileName: string;
  totalBytes: number;
  direction: 'send' | 'receive';
  at: number;
}

const HISTORY_KEY = 'hushsend.transferHistory';
const HISTORY_CAP = 12;

function readArray<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function writeArray(key: string, value: unknown[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota / private mode — persistence is best-effort */
  }
}

/** Transfer history, newest first. */
export function listTransfers(): TransferRecord[] {
  return readArray<TransferRecord>(HISTORY_KEY);
}

/** Append a completed transfer to the (capped) history. */
export function rememberTransfer(entry: Omit<TransferRecord, 'id' | 'at'>): void {
  const at = Date.now();
  const record: TransferRecord = { ...entry, at, id: `${at}-${entry.fileName}` };
  writeArray(HISTORY_KEY, [record, ...listTransfers()].slice(0, HISTORY_CAP));
}

/** Clear the transfer history (pairs with the "forget pinned devices" reset). */
export function forgetTransfers(): void {
  writeArray(HISTORY_KEY, []);
}
