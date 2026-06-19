import type { KeystoreBackend, PinEntry, PinRecord, StoredIdentity } from './types';

/**
 * IndexedDB {@link KeystoreBackend} — the app's real persistence.
 *
 * Two object stores:
 *  - `identity`: the device's own key, under a single fixed key. The WebCrypto path stores a
 *    NON-EXTRACTABLE `CryptoKey` directly (IndexedDB structured-clones it, so the private bytes
 *    are never serialized into the heap); the noble path stores the raw seed bytes.
 *  - `pins`: peer public keys (TOFU), keyed by `pairingId` (hex). value = {@link PinRecord}.
 *
 * Promise-wrapped over the callback IDB API; no external dependency (the stack forbids adding
 * one here). IndexedDB is browser-only — in a non-browser context `open()` rejects, which the
 * caller (the dev harness identity panel / enrollment) treats as non-fatal.
 */

const DB_NAME = 'hushsend-keystore';
const DB_VERSION = 1;
const IDENTITY_STORE = 'identity';
const PINS_STORE = 'pins';
/** Single fixed key under which the one own-identity record lives. */
const IDENTITY_KEY = 'self';

export class IdbKeystoreBackend implements KeystoreBackend {
  /** Opened lazily and memoized — one connection per backend instance. */
  private dbPromise: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDENTITY_STORE)) db.createObjectStore(IDENTITY_STORE);
        if (!db.objectStoreNames.contains(PINS_STORE)) db.createObjectStore(PINS_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    });
    return this.dbPromise;
  }

  /** Run one request inside a transaction on `store`, resolving with its result. */
  private async request<T>(
    store: string,
    mode: IDBTransactionMode,
    run: (s: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = run(tx.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
    });
  }

  async loadIdentity(): Promise<StoredIdentity | null> {
    const value = await this.request<StoredIdentity | undefined>(IDENTITY_STORE, 'readonly', (s) =>
      s.get(IDENTITY_KEY),
    );
    return value ?? null;
  }

  async saveIdentity(identity: StoredIdentity): Promise<void> {
    await this.request(IDENTITY_STORE, 'readwrite', (s) => s.put(identity, IDENTITY_KEY));
  }

  async getPin(pairingId: string): Promise<PinRecord | null> {
    const value = await this.request<PinRecord | undefined>(PINS_STORE, 'readonly', (s) => s.get(pairingId));
    return value ?? null;
  }

  async putPin(pairingId: string, record: PinRecord): Promise<void> {
    await this.request(PINS_STORE, 'readwrite', (s) => s.put(record, pairingId));
  }

  async listPins(): Promise<PinEntry[]> {
    const db = await this.open();
    return new Promise<PinEntry[]>((resolve, reject) => {
      const tx = db.transaction(PINS_STORE, 'readonly');
      const store = tx.objectStore(PINS_STORE);
      const keysReq = store.getAllKeys();
      const valsReq = store.getAll();
      tx.oncomplete = () => {
        const keys = keysReq.result as IDBValidKey[];
        const vals = valsReq.result as PinRecord[];
        resolve(keys.map((k, i) => ({ pairingId: String(k), ...vals[i] })));
      };
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB listPins failed'));
    });
  }

  async removePin(pairingId: string): Promise<void> {
    await this.request(PINS_STORE, 'readwrite', (s) => s.delete(pairingId));
  }

  async clearAll(): Promise<void> {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([IDENTITY_STORE, PINS_STORE], 'readwrite');
      tx.objectStore(IDENTITY_STORE).clear();
      tx.objectStore(PINS_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB clearAll failed'));
    });
  }
}
