import { IdbKeystoreBackend } from './idbBackend';
import type { KeystoreBackend, PinEntry, PinRecord, StoredIdentity } from './types';

/** Web Lock name serializing first-ever identity creation across tabs of the same origin. */
const IDENTITY_LOCK_NAME = 'hushsend-identity';

/**
 * Run `fn` while holding the cross-tab {@link IDENTITY_LOCK_NAME} Web Lock — origin-scoped and
 * serialized across every tab of the profile. Where the Web Locks API is unavailable (older
 * engines, or any non-browser / insecure context — e.g. unit tests under Node), we DEGRADE to
 * running `fn` directly: the caller's intra-tab memoize ({@link Keystore.loadOrCreateIdentity})
 * still prevents an in-tab double-generate, so this is never worse than before — only the
 * cross-tab race is left unguarded, exactly as it was. `globalThis.navigator?.locks` (not a bare
 * `navigator`) so the probe can't throw a ReferenceError where `navigator` isn't even defined.
 */
async function withIdentityLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (!locks) return fn();
  // `request` resolves with (and awaits) the callback's value; `await` flattens the lib's
  // over-wrapped `Promise<Promise<T>>` typing back to `T` (matching the real runtime value).
  return await locks.request(IDENTITY_LOCK_NAME, fn);
}

/**
 * High-level keystore facade over a {@link KeystoreBackend}. It adds the small bits of
 * orchestration the raw port deliberately omits — generate-the-identity-if-absent, and
 * building a {@link PinRecord} from a raw key — while staying free of any crypto itself
 * (key generation is injected, so this module never imports `crypto/identity.ts` and there
 * is no import cycle: identity.ts → keystore, never the other way).
 */
export class Keystore {
  constructor(private readonly backend: KeystoreBackend) {}

  /** Memoized own-identity, so concurrent callers (e.g. React StrictMode double-constructing the
   *  SessionController, both racing this against the shared singleton keystore) get ONE identity —
   *  one generation, one save — instead of each generating and overwriting the other. */
  private identityPromise: Promise<StoredIdentity> | null = null;

  /**
   * Return the stored own-identity, creating + persisting one (via the injected `generate`
   * callback) on first use. The generator does the Ed25519 key generation (WebCrypto or noble);
   * keeping it a parameter is what avoids a keystore→identity import cycle. Memoized (see above);
   * a failed attempt clears the memo so a later call can retry.
   */
  loadOrCreateIdentity(generate: () => Promise<StoredIdentity>): Promise<StoredIdentity> {
    if (!this.identityPromise) {
      this.identityPromise = this.resolveIdentity(generate).catch((err: unknown) => {
        this.identityPromise = null; // allow a retry after a failure
        throw err;
      });
    }
    return this.identityPromise;
  }

  private resolveIdentity(generate: () => Promise<StoredIdentity>): Promise<StoredIdentity> {
    // Cross-tab single-flight: hold the origin-wide Web Lock across the whole read→generate→write
    // so two fresh tabs of the same profile can't each observe "no identity", generate DIFFERENT
    // keys, and clobber one another (last-write-wins — a lost identity that 4b-ii reconnect would
    // later read as a spurious key-changed hard stop). The first tab to take the lock creates +
    // persists; the next tab, once it acquires the lock, READS that identity instead of generating.
    // (The intra-tab memoize in loadOrCreateIdentity already coalesces same-tab callers.)
    return withIdentityLock(async () => {
      const existing = await this.backend.loadIdentity();
      if (existing) return existing;
      const fresh = await generate();
      await this.backend.saveIdentity(fresh);
      return fresh;
    });
  }

  /** The pin for `pairingId`, or null. */
  getPin(pairingId: string): Promise<PinRecord | null> {
    return this.backend.getPin(pairingId);
  }

  /**
   * Pin a peer's key under `pairingId`. `firstSeen` defaults to now; pass it explicitly for
   * deterministic tests. Returns the stored record.
   */
  async putPin(
    pairingId: string,
    peerPublicKey: string,
    meta?: { label?: string; firstSeen?: number },
  ): Promise<PinRecord> {
    const record: PinRecord =
      meta?.label !== undefined
        ? { peerPublicKey, firstSeen: meta.firstSeen ?? Date.now(), label: meta.label }
        : { peerPublicKey, firstSeen: meta?.firstSeen ?? Date.now() };
    await this.backend.putPin(pairingId, record);
    return record;
  }

  /** All pins (pairingId + record). */
  listPins(): Promise<PinEntry[]> {
    return this.backend.listPins();
  }

  /** Remove the pin for `pairingId`. */
  removePin(pairingId: string): Promise<void> {
    return this.backend.removePin(pairingId);
  }

  /** Wipe own identity + all pins ("forget pins / reset identity"). Also drops the memoized
   *  identity so the next loadOrCreateIdentity generates a fresh one. */
  clearAll(): Promise<void> {
    this.identityPromise = null;
    return this.backend.clearAll();
  }
}

/** Lazily-created app-wide keystore over IndexedDB. */
let singleton: Keystore | null = null;
export function defaultKeystore(): Keystore {
  if (!singleton) singleton = new Keystore(new IdbKeystoreBackend());
  return singleton;
}

export { IdbKeystoreBackend } from './idbBackend';
export { MemoryKeystoreBackend } from './memoryBackend';
export type { KeystoreBackend, PinEntry, PinRecord, StoredIdentity } from './types';
