/**
 * The ONE certificate fingerprint of a session description — the value every method binds its
 * authentication to (the key-confirmation MAC, the SAS words, the reconnect signature).
 *
 * WHY "ONE". A description may legally carry several `a=fingerprint` lines, and the engines do not
 * agree on what that means (measured 2026-11-23, docs/test-runs/2026-11-23.md). Chromium and WebKit
 * keep a single effective line. Firefox accepts a certificate that matches ANY line it was given and
 * keeps them all — so "the first line of the description", which is what this code used to read, need
 * not be the certificate DTLS accepted. The signaling server relays the description and is untrusted:
 * it could list the honest peer's fingerprint first and its own second, terminate DTLS itself, and
 * both sides would authenticate the honest pair of fingerprints over a channel that ends at the server.
 *
 * So a description is taken only when every fingerprint line in it, at any level, names the SAME
 * value; anything else is refused before the engine sees it. An honest browser sends one certificate
 * fingerprint, repeated per media section at most.
 *
 * Pure and framework-free, so the rule is unit-tested without a browser.
 */

export type FingerprintCheck =
  | { ok: true; fingerprint: string }
  /** `none`: no fingerprint line at all. `malformed`: a line that mentions a fingerprint but is not
   *  one this code can read — refused rather than skipped, since the engine might read it. `several`:
   *  more than one distinct value. */
  | { ok: false; reason: 'none' | 'malformed' | 'several' };

const LINE = /^a=fingerprint:([A-Za-z0-9-]+) ([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2})+)$/;

/**
 * Read the fingerprint of an SDP. The value is returned in one canonical spelling — hash name in
 * lower case, hex in upper case, which is also how every engine writes it — so the two sides of a
 * pairing compare and MAC the same string.
 */
export function sdpFingerprint(sdp: string | null | undefined): FingerprintCheck {
  if (typeof sdp !== 'string' || sdp === '') return { ok: false, reason: 'none' };
  const values = new Set<string>();
  // A lone CR is not a line break in SDP, but an engine may take it for one: split on it too, so a
  // line cannot hide behind it.
  for (const raw of sdp.split(/\r\n|\n|\r/)) {
    if (!/fingerprint/i.test(raw)) continue;
    const m = LINE.exec(raw.trimEnd());
    if (!m) return { ok: false, reason: 'malformed' };
    values.add(`${m[1].toLowerCase()} ${m[2].toUpperCase()}`);
  }
  if (values.size === 0) return { ok: false, reason: 'none' };
  if (values.size > 1) return { ok: false, reason: 'several' };
  return { ok: true, fingerprint: [...values][0] };
}

const DIGESTS: Record<string, string> = {
  'sha-1': 'SHA-1',
  'sha-256': 'SHA-256',
  'sha-384': 'SHA-384',
  'sha-512': 'SHA-512',
};

/**
 * Does this certificate (DER) have this fingerprint? `null` when it cannot be told — a hash this
 * runtime does not compute — which the caller reads as "no second opinion", never as a match.
 */
export async function certificateHasFingerprint(der: ArrayBuffer, fingerprint: string): Promise<boolean | null> {
  const [hash, hex] = fingerprint.split(' ');
  const algorithm = DIGESTS[hash];
  if (!algorithm || !hex) return null;
  let digest: ArrayBuffer;
  try {
    digest = await crypto.subtle.digest(algorithm, der);
  } catch {
    return null;
  }
  const actual = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
  return actual === hex;
}
