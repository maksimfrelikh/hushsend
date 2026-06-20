import { describe, it, expect } from 'vitest';
import {
  generateLinkSecret,
  buildLinkUrl,
  parseLink,
  LINK_SECRET_BYTES,
  RENDEZVOUS_TOKEN_LEN,
} from './link';

/** A well-formed rendezvous token: RENDEZVOUS_TOKEN_LEN base64url chars (what the server allocates).
 *  parseLink only validates its SHAPE (it is opaque routing), so any base64url string of the right
 *  length stands in for a server-minted token here. */
const TOKEN = 'AbCd_E-19xKpQrStUvWxYz'.slice(0, RENDEZVOUS_TOKEN_LEN).padEnd(RENDEZVOUS_TOKEN_LEN, 'A');

describe('link secret generation', () => {
  it('produces a CSPRNG secret of the right size and a URL-safe encoding', () => {
    const s = generateLinkSecret();
    expect(s.bytes).toBeInstanceOf(Uint8Array);
    expect(s.bytes.length).toBe(LINK_SECRET_BYTES); // ≥16 bytes → not offline-guessable
    expect(LINK_SECRET_BYTES).toBeGreaterThanOrEqual(16);
    // base64url, no padding, no chars that would need escaping in a URL fragment.
    expect(s.encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(s.encoded).not.toContain('=');
    // 16 bytes → ceil(16/3)*4 = 24 base64 chars, minus 2 '=' pad → 22 url-safe chars.
    expect(s.encoded.length).toBe(22);
  });

  it('is fresh on each call (no reuse)', () => {
    const a = generateLinkSecret();
    const b = generateLinkSecret();
    expect(a.encoded).not.toBe(b.encoded);
  });

  it('encoding decodes back to the exact bytes (round-trip through parseLink)', () => {
    const s = generateLinkSecret();
    const url = buildLinkUrl('https://hushsend.app', TOKEN, s.encoded);
    const parsed = parseLink(url);
    expect(parsed).not.toBeNull();
    expect([...parsed!.secret]).toEqual([...s.bytes]);
  });
});

describe('rendezvous token', () => {
  it('is 128-bit-class entropy: 16 bytes → exactly 22 base64url chars (unguessable, no enumeration)', () => {
    expect(RENDEZVOUS_TOKEN_LEN).toBe(22);
    expect(TOKEN).toHaveLength(RENDEZVOUS_TOKEN_LEN);
  });
});

describe('buildLinkUrl', () => {
  it('builds <origin>/#<token>.<secret>', () => {
    expect(buildLinkUrl('https://hushsend.app', TOKEN, 'AbCd')).toBe(`https://hushsend.app/#${TOKEN}.AbCd`);
  });
  it('does not double the slash when the origin has a trailing slash', () => {
    expect(buildLinkUrl('https://hushsend.app/', TOKEN, 'AbCd')).toBe(`https://hushsend.app/#${TOKEN}.AbCd`);
  });
  it('keeps the secret in the FRAGMENT (after #), never in the path or query', () => {
    const s = generateLinkSecret();
    const url = buildLinkUrl('https://hushsend.app', TOKEN, s.encoded);
    const [beforeHash, afterHash] = url.split('#');
    // Nothing the server would receive (origin/path/query) contains the secret.
    expect(beforeHash).not.toContain(s.encoded);
    expect(afterHash).toContain(s.encoded);
  });
});

describe('parseLink', () => {
  const s = generateLinkSecret();
  const fragment = `${TOKEN}.${s.encoded}`;

  it('parses a full URL', () => {
    const parsed = parseLink(`https://hushsend.app/?forceBlob=1#${fragment}`);
    expect(parsed).not.toBeNull();
    expect(parsed!.rendezvous).toBe(TOKEN);
    expect([...parsed!.secret]).toEqual([...s.bytes]);
  });

  it('parses a bare "#fragment"', () => {
    const parsed = parseLink(`#${fragment}`);
    expect(parsed?.rendezvous).toBe(TOKEN);
  });

  it('parses the fragment body alone (a pasted "token.secret")', () => {
    const parsed = parseLink(fragment);
    expect(parsed?.rendezvous).toBe(TOKEN);
  });

  it('rejects malformed input (no throw, returns null)', () => {
    expect(parseLink(null)).toBeNull();
    expect(parseLink(undefined)).toBeNull();
    expect(parseLink('')).toBeNull();
    expect(parseLink('#')).toBeNull();
    expect(parseLink('https://hushsend.app/')).toBeNull(); // no fragment
    expect(parseLink(`#${TOKEN}`)).toBeNull(); // no secret separator
    expect(parseLink(`#4729.${s.encoded}`)).toBeNull(); // old 4-digit code is NOT a valid token
    expect(parseLink(`#${TOKEN}x.${s.encoded}`)).toBeNull(); // token too long
    expect(parseLink(`#${TOKEN.slice(0, -1)}.${s.encoded}`)).toBeNull(); // token too short
    expect(parseLink(`#bad.token.${s.encoded}`)).toBeNull(); // token has illegal '.'
    expect(parseLink(`#${TOKEN}.not valid base64!`)).toBeNull(); // illegal secret chars
  });

  it('rejects a secret of the wrong decoded length (anti-truncation / anti-grind)', () => {
    // A short secret ('AAAAAA' decodes to fewer than LINK_SECRET_BYTES) must be refused.
    expect(parseLink(`#${TOKEN}.AAAAAA`)).toBeNull();
  });

  it('round-trips with buildLinkUrl (a "scanned" link parses to the same token + secret)', () => {
    const fresh = generateLinkSecret();
    const url = buildLinkUrl('https://hushsend.app', TOKEN, fresh.encoded);
    const parsed = parseLink(url);
    expect(parsed!.rendezvous).toBe(TOKEN);
    expect([...parsed!.secret]).toEqual([...fresh.bytes]);
  });
});
