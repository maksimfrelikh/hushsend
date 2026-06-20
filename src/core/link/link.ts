/**
 * "link" / "qr" method credential: a high-entropy one-time secret carried in the URL
 * **fragment**, plus a high-entropy rendezvous TOKEN.
 *
 * Unlike the words method there is NO PAKE and NO SAS: the secret S is a full-entropy
 * CSPRNG draw (≥16 bytes), so it is not offline-guessable and it authenticates the
 * channel on its own (via the channel-bound key-confirmation in keyConfirmation.ts,
 * domain `LINK_CONFIRM_DOMAIN`). The rendezvous is a server-allocated **128-bit token**
 * (codeType=token), NOT the 4-digit room — the link already carries the rendezvous, so a
 * high-entropy token costs nothing in UX while making the rendezvous UNGUESSABLE. That is
 * the whole point: a stranger can't enumerate/squat a token room the way the 10k 4-digit
 * space can be scanned, so a stray peer can't race the intended 1:1 (interloper-resistance
 * is STRUCTURAL). The room method keeps the 4-digit code; only link/qr use the token.
 *
 * Link shape: `<origin>/#<token>.<S>`
 *   - `token` — the PUBLIC rendezvous token (routing; the server sees it). base64url, no
 *               padding, so it never contains '.' and the link splits cleanly on the first '.'.
 *   - `S`     — the SECRET, base64url-encoded, in the URL FRAGMENT. The fragment is never
 *               sent to the server by browsers, and the joiner SCRUBS it from the address
 *               bar / history immediately after reading it (history.replaceState), so S
 *               leaves no trace and is single-use.
 *
 * This module is pure (no DOM, no live objects): it generates S, builds the link, and
 * parses an inbound link/fragment back to { rendezvous, secret } for the joiner. The QR
 * method uses the SAME link, just rendered/scanned as a QR code (see src/ui/qr.ts).
 */

/** Secret size in bytes. 16 bytes = 128 bits of CSPRNG entropy — not offline-guessable,
 *  so no PAKE is needed; the secret authenticates the channel by itself. */
export const LINK_SECRET_BYTES = 16;

/** Rendezvous TOKEN size in bytes (server-allocated, base64url). 16 bytes = 128 bits → the
 *  token is unguessable, so the link/qr rendezvous can't be enumerated/squatted. MUST match the
 *  server's TOKEN_ROOM_BYTES (server/signaling-server.js, codeType=token). */
export const RENDEZVOUS_TOKEN_BYTES = 16;
/** base64url length (no padding) of a RENDEZVOUS_TOKEN_BYTES token: ceil(16*4/3) = 22 chars. */
export const RENDEZVOUS_TOKEN_LEN = Math.ceil((RENDEZVOUS_TOKEN_BYTES * 4) / 3);
/** Strict rendezvous-token shape: exactly RENDEZVOUS_TOKEN_LEN base64url chars (the input is
 *  attacker-influenced, so parseLink validates format + length before trusting it as routing). */
const RENDEZVOUS_TOKEN_RE = new RegExp(`^[A-Za-z0-9_-]{${RENDEZVOUS_TOKEN_LEN}}$`);

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

/** Build the shareable link `<origin>/#<rendezvous>.<encodedSecret>` (rendezvous = the token). */
export function buildLinkUrl(origin: string, rendezvous: string, encodedSecret: string): string {
  // Trim any trailing slash on origin so we never produce `//#…`.
  const base = origin.replace(/\/+$/, '');
  return `${base}/#${rendezvous}.${encodedSecret}`;
}

export interface ParsedLink {
  /** The PUBLIC rendezvous token (sent to the server as the room param; routing only). */
  rendezvous: string;
  secret: Uint8Array;
}

/**
 * Parse an inbound link back to { rendezvous, secret }. Accepts a full URL
 * (`https://host/?x#<token>.S`), a bare fragment (`#<token>.S`), or the fragment body
 * (`<token>.S`) — so it serves both the page-load `location.hash` path and a pasted-link /
 * scanned-QR fallback. Validation is strict (the input is attacker-influenced): the rendezvous
 * must be a well-formed token (RENDEZVOUS_TOKEN_LEN base64url chars) and the secret must
 * base64url-decode to exactly LINK_SECRET_BYTES. Returns null on anything malformed (no throw) —
 * including an old 4-digit-style code, which is no longer a valid link/qr rendezvous.
 */
export function parseLink(input: string | null | undefined): ParsedLink | null {
  if (!input) return null;
  // Take everything after the FIRST '#': for a full URL this drops the origin/query; for a
  // bare fragment it strips the leading '#'; a string with no '#' is treated as the body.
  const hashIdx = input.indexOf('#');
  const body = hashIdx >= 0 ? input.slice(hashIdx + 1) : input;
  // Split on the FIRST '.': neither the token nor S contains '.' (both are base64url), so this
  // unambiguously separates the rendezvous from the secret.
  const dot = body.indexOf('.');
  if (dot < 0) return null;
  const rendezvous = body.slice(0, dot);
  const encoded = body.slice(dot + 1);
  if (!RENDEZVOUS_TOKEN_RE.test(rendezvous)) return null; // high-entropy token, exact shape
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  let secret: Uint8Array;
  try {
    secret = b64urlToBytes(encoded);
  } catch {
    return null;
  }
  if (secret.length !== LINK_SECRET_BYTES) return null;
  return { rendezvous, secret };
}
