/**
 * "link" / "qr" method credential: a high-entropy one-time secret carried in the URL
 * **fragment**, plus the 4-digit rendezvous code.
 *
 * Unlike the words method there is NO PAKE and NO SAS: the secret S is a full-entropy
 * CSPRNG draw (≥16 bytes), so it is not offline-guessable and it authenticates the
 * channel on its own (via the channel-bound key-confirmation in keyConfirmation.ts,
 * domain `LINK_CONFIRM_DOMAIN`). The rendezvous is a server-allocated 4-digit room
 * (same as the room method — the server is untrusted and only routes).
 *
 * Link shape: `<origin>/#<roomCode>.<S>`
 *   - `roomCode` — the PUBLIC 4-digit room id (routing; the server sees it).
 *   - `S`        — the SECRET, base64url-encoded, in the URL FRAGMENT. The fragment is
 *                  never sent to the server by browsers, and the joiner SCRUBS it from
 *                  the address bar / history immediately after reading it
 *                  (history.replaceState), so S leaves no trace and is single-use.
 *
 * This module is pure (no DOM, no live objects): it generates S, builds the link, and
 * parses an inbound link/fragment back to { roomCode, secret } for the joiner. The QR
 * method uses the SAME link, just rendered/scanned as a QR code (see src/ui/qr.ts).
 */

/** Secret size in bytes. 16 bytes = 128 bits of CSPRNG entropy — not offline-guessable,
 *  so no PAKE is needed; the secret authenticates the channel by itself. */
export const LINK_SECRET_BYTES = 16;

/** base64url alphabet, no padding (URL-safe; `+/=` would need escaping in a fragment). */
function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode a base64url string (no padding) back to bytes. Throws on invalid input. */
function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64); // throws on malformed base64
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A freshly-generated link secret: raw CSPRNG bytes plus their base64url encoding for
 *  the URL. The bytes are the key-confirmation IKM; the string is transport-only. */
export interface LinkSecret {
  bytes: Uint8Array;
  encoded: string;
}

/** Draw a fresh one-time secret from the CSPRNG (never user-chosen). */
export function generateLinkSecret(): LinkSecret {
  const bytes = crypto.getRandomValues(new Uint8Array(LINK_SECRET_BYTES));
  return { bytes, encoded: bytesToB64url(bytes) };
}

/** Build the shareable link `<origin>/#<roomCode>.<encodedSecret>`. */
export function buildLinkUrl(origin: string, roomCode: string, encodedSecret: string): string {
  // Trim any trailing slash on origin so we never produce `//#…`.
  const base = origin.replace(/\/+$/, '');
  return `${base}/#${roomCode}.${encodedSecret}`;
}

export interface ParsedLink {
  roomCode: string;
  secret: Uint8Array;
}

/**
 * Parse an inbound link back to { roomCode, secret }. Accepts a full URL
 * (`https://host/?x#1234.S`), a bare fragment (`#1234.S`), or the fragment body
 * (`1234.S`) — so it serves both the page-load `location.hash` path and a pasted-link /
 * scanned-QR fallback. Validation is strict (the input is attacker-influenced): the room
 * code must be exactly 4 digits and the secret must base64url-decode to exactly
 * LINK_SECRET_BYTES. Returns null on anything malformed (no throw).
 */
export function parseLink(input: string | null | undefined): ParsedLink | null {
  if (!input) return null;
  // Take everything after the FIRST '#': for a full URL this drops the origin/query; for a
  // bare fragment it strips the leading '#'; a string with no '#' is treated as the body.
  const hashIdx = input.indexOf('#');
  const body = hashIdx >= 0 ? input.slice(hashIdx + 1) : input;
  const dot = body.indexOf('.');
  if (dot < 0) return null;
  const roomCode = body.slice(0, dot);
  const encoded = body.slice(dot + 1);
  if (!/^\d{4}$/.test(roomCode)) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  let secret: Uint8Array;
  try {
    secret = b64urlToBytes(encoded);
  } catch {
    return null;
  }
  if (secret.length !== LINK_SECRET_BYTES) return null;
  return { roomCode, secret };
}
