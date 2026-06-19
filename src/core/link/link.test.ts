import { describe, it, expect } from 'vitest';
import { generateLinkSecret, buildLinkUrl, parseLink, LINK_SECRET_BYTES } from './link';

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
    const url = buildLinkUrl('https://hushsend.app', '1234', s.encoded);
    const parsed = parseLink(url);
    expect(parsed).not.toBeNull();
    expect([...parsed!.secret]).toEqual([...s.bytes]);
  });
});

describe('buildLinkUrl', () => {
  it('builds <origin>/#<roomCode>.<secret>', () => {
    expect(buildLinkUrl('https://hushsend.app', '4729', 'AbCd')).toBe('https://hushsend.app/#4729.AbCd');
  });
  it('does not double the slash when the origin has a trailing slash', () => {
    expect(buildLinkUrl('https://hushsend.app/', '4729', 'AbCd')).toBe('https://hushsend.app/#4729.AbCd');
  });
  it('keeps the secret in the FRAGMENT (after #), never in the path or query', () => {
    const s = generateLinkSecret();
    const url = buildLinkUrl('https://hushsend.app', '4729', s.encoded);
    const [beforeHash, afterHash] = url.split('#');
    // Nothing the server would receive (origin/path/query) contains the secret.
    expect(beforeHash).not.toContain(s.encoded);
    expect(afterHash).toContain(s.encoded);
  });
});

describe('parseLink', () => {
  const s = generateLinkSecret();
  const fragment = `4729.${s.encoded}`;

  it('parses a full URL', () => {
    const parsed = parseLink(`https://hushsend.app/?forceBlob=1#${fragment}`);
    expect(parsed).not.toBeNull();
    expect(parsed!.roomCode).toBe('4729');
    expect([...parsed!.secret]).toEqual([...s.bytes]);
  });

  it('parses a bare "#fragment"', () => {
    const parsed = parseLink(`#${fragment}`);
    expect(parsed?.roomCode).toBe('4729');
  });

  it('parses the fragment body alone (a pasted "code.secret")', () => {
    const parsed = parseLink(fragment);
    expect(parsed?.roomCode).toBe('4729');
  });

  it('rejects malformed input (no throw, returns null)', () => {
    expect(parseLink(null)).toBeNull();
    expect(parseLink(undefined)).toBeNull();
    expect(parseLink('')).toBeNull();
    expect(parseLink('#')).toBeNull();
    expect(parseLink('https://hushsend.app/')).toBeNull(); // no fragment
    expect(parseLink('#4729')).toBeNull(); // no secret separator
    expect(parseLink(`#abcd.${s.encoded}`)).toBeNull(); // room code not 4 digits
    expect(parseLink(`#473.${s.encoded}`)).toBeNull(); // room code too short
    expect(parseLink('#4729.not valid base64!')).toBeNull(); // illegal chars
  });

  it('rejects a secret of the wrong decoded length (anti-truncation / anti-grind)', () => {
    // A 4-byte secret ('AAAAAA' decodes to fewer than LINK_SECRET_BYTES) must be refused.
    expect(parseLink('#4729.AAAAAA')).toBeNull();
  });

  it('round-trips with buildLinkUrl (a "scanned" link parses to the same code + secret)', () => {
    const fresh = generateLinkSecret();
    const url = buildLinkUrl('https://hushsend.app', '0007', fresh.encoded);
    const parsed = parseLink(url);
    expect(parsed!.roomCode).toBe('0007');
    expect([...parsed!.secret]).toEqual([...fresh.bytes]);
  });
});
