import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  CHUNK_MAX,
  CHUNK_MIN,
  MAX_BYTES_DESKTOP_BLOB,
  MAX_BYTES_MOBILE_BLOB,
  canStreamToDisk,
  chunkSize,
  formatBytes,
  receiveMaxBytes,
} from './fileTransfer';

/**
 * The receive-path POLICY: which ceiling applies, and how it is worded. Measured engine ceilings
 * (see the constants' comment) put both caps well below where a browser actually dies, but the cap
 * only protects anyone if the right one is CHOSEN — and that choice is a User-Agent regex, which
 * until now nothing exercised at any level. The phone-profile e2e (tests/e2e/mobile.spec.ts) covers
 * the same decision through a real WebKit; these are the cheap, deterministic half.
 */

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('receive ceiling by device class', () => {
  it('streaming to disk is unbounded — the cap exists only for the RAM-bound path', () => {
    expect(receiveMaxBytes(true)).toBe(Infinity);
  });

  it('a phone gets the mobile cap, a desktop the desktop one', () => {
    for (const ua of [IPHONE, IPAD, ANDROID]) {
      vi.stubGlobal('navigator', { userAgent: ua });
      expect(receiveMaxBytes(false), ua).toBe(MAX_BYTES_MOBILE_BLOB);
    }
    vi.stubGlobal('navigator', { userAgent: MAC });
    expect(receiveMaxBytes(false)).toBe(MAX_BYTES_DESKTOP_BLOB);
  });

  it('the mobile cap is the SMALLER of the two (a phone has less room, not more)', () => {
    expect(MAX_BYTES_MOBILE_BLOB).toBeLessThan(MAX_BYTES_DESKTOP_BLOB);
  });

  it('no navigator at all (non-browser context) degrades to the desktop cap, never to unbounded', () => {
    vi.stubGlobal('navigator', undefined);
    expect(receiveMaxBytes(false)).toBe(MAX_BYTES_DESKTOP_BLOB);
  });
});

describe('how the ceiling is worded to the human', () => {
  it('names each cap in units a person reads, since the refusal text quotes it', () => {
    expect(formatBytes(MAX_BYTES_MOBILE_BLOB)).toBe('512 MB');
    expect(formatBytes(MAX_BYTES_DESKTOP_BLOB)).toBe('1.0 GB');
  });

  it('handles the unbounded case and small sizes', () => {
    expect(formatBytes(Infinity)).toBe('∞');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });
});

describe('chunk sizing against the SCTP limit', () => {
  it('clamps the negotiated maximum into [CHUNK_MIN, CHUNK_MAX]', () => {
    expect(chunkSize(4 * 1024 * 1024)).toBe(CHUNK_MAX); // engine offers more than we will use
    expect(chunkSize(1024)).toBe(CHUNK_MIN); // engine offers less than is worth sending
    expect(chunkSize(64 * 1024)).toBe(64 * 1024); // in range — taken as-is
  });

  it('falls back to the maximum when the negotiated size is unknown (0)', () => {
    expect(chunkSize(0)).toBe(CHUNK_MAX);
  });
});

describe('receive-path capability detection', () => {
  it('reports no streaming when there is no window (non-browser context)', () => {
    expect(canStreamToDisk()).toBe(false);
  });
});
