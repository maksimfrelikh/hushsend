/**
 * Keystore types — the serializable shapes persisted by a {@link KeystoreBackend},
 * plus the backend interface itself.
 *
 * Two things are stored:
 *  - the device's OWN long-term Ed25519 identity (one record), and
 *  - pinned PEER public keys (TOFU), keyed by a per-pair `pairingId`.
 *
 * The backend is a pure persistence port: it stores and retrieves records and does
 * NO crypto. Key generation and signing live in `crypto/identity.ts`; the higher-level
 * orchestration (generate-if-absent, build a pin record) lives in the `Keystore` facade.
 *
 * ⚠️ PRIVATE-KEY STORAGE LIMITATION: IndexedDB is NOT a secure enclave. On the WebCrypto
 * path the identity is a NON-EXTRACTABLE `CryptoKey` — the private scalar never enters the
 * JS heap and cannot be read back out of the stored handle, which limits exposure. On the
 * `@noble/curves` fallback path the 32-byte seed is stored as raw bytes and IS readable by
 * anything with IndexedDB access (XSS, a malicious extension) — the fallback does not have
 * the non-extractable protection. See `crypto/identity.ts`.
 */

/** The device's own identity, in one of two storage shapes (see identity.ts). */
export type StoredIdentity =
  | {
      /** WebCrypto Ed25519: the non-extractable private key handle (private bytes never exposed). */
      kind: 'webcrypto';
      privateKey: CryptoKey;
      /** Raw 32-byte Ed25519 public key (exported once at generation; public keys are extractable). */
      publicKey: Uint8Array;
    }
  | {
      /** @noble/curves fallback: the raw 32-byte Ed25519 seed (secret key). */
      kind: 'noble';
      seed: Uint8Array;
      /** Raw 32-byte Ed25519 public key derived from the seed. */
      publicKey: Uint8Array;
    };

/** A pinned peer (TOFU). Keyed in the store by the pair's `pairingId`. */
export interface PinRecord {
  /** The peer's Ed25519 public key, hex-encoded (32 bytes → 64 hex chars). */
  peerPublicKey: string;
  /** When this pin was first established (epoch ms). */
  firstSeen: number;
  /** Optional human label for the peer (unused in 4b-i). */
  label?: string;
}

/** A pin together with its key — the shape returned by `listPins()`. */
export interface PinEntry extends PinRecord {
  /** The 16-byte pairingId, hex-encoded (32 hex chars). */
  pairingId: string;
}

/**
 * Persistence port. The app uses an IndexedDB implementation; unit tests use an
 * in-memory one (no IndexedDB needed in unit tests — the IDB path is covered by e2e).
 * All methods are async so the IndexedDB implementation fits without changing callers.
 */
export interface KeystoreBackend {
  /** The stored own-identity record, or null if none has been created yet. */
  loadIdentity(): Promise<StoredIdentity | null>;
  /** Persist (replacing any prior) the own-identity record. */
  saveIdentity(identity: StoredIdentity): Promise<void>;
  /** The pin for `pairingId`, or null. */
  getPin(pairingId: string): Promise<PinRecord | null>;
  /** Insert or replace the pin for `pairingId`. */
  putPin(pairingId: string, record: PinRecord): Promise<void>;
  /** All pins (pairingId + record). */
  listPins(): Promise<PinEntry[]>;
  /** Delete the pin for `pairingId` (no-op if absent). */
  removePin(pairingId: string): Promise<void>;
  /** Wipe EVERYTHING — own identity and all pins ("forget pins / reset identity"). */
  clearAll(): Promise<void>;
}
