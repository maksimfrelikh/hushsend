import type { KeystoreBackend, PinEntry, PinRecord, StoredIdentity } from './types';

/**
 * In-memory {@link KeystoreBackend} for unit tests (and any non-persistent context).
 * Holds the identity + pins in plain JS structures — nothing touches IndexedDB, so the
 * keystore/identity/enrollment logic is unit-testable without a DOM. The real persistence
 * (IndexedDB) is exercised by the e2e suite.
 */
export class MemoryKeystoreBackend implements KeystoreBackend {
  private identity: StoredIdentity | null = null;
  private readonly pins = new Map<string, PinRecord>();

  async loadIdentity(): Promise<StoredIdentity | null> {
    return this.identity;
  }

  async saveIdentity(identity: StoredIdentity): Promise<void> {
    this.identity = identity;
  }

  async getPin(pairingId: string): Promise<PinRecord | null> {
    return this.pins.get(pairingId) ?? null;
  }

  async putPin(pairingId: string, record: PinRecord): Promise<void> {
    this.pins.set(pairingId, record);
  }

  async listPins(): Promise<PinEntry[]> {
    return [...this.pins.entries()].map(([pairingId, record]) => ({ pairingId, ...record }));
  }

  async removePin(pairingId: string): Promise<void> {
    this.pins.delete(pairingId);
  }

  async clearAll(): Promise<void> {
    this.identity = null;
    this.pins.clear();
  }
}
