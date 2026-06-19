import { describe, it, expect } from 'vitest';
import { linkToQrSvg } from './qr';
import { generateLinkSecret, buildLinkUrl, parseLink } from '../core/link/link';

/**
 * The camera scan path is impractical to drive headlessly, so the unit layer covers what it can
 * deterministically: QR GENERATION produces a self-contained SVG, and the link a scanner would read
 * back PARSES to the exact roomCode + secret the generator encoded ("scanned == same link"). The
 * post-scan join flow is exercised end-to-end in the e2e by injecting the decoded link.
 */
describe('qr generation', () => {
  it('renders a self-contained SVG QR for a link', async () => {
    const url = buildLinkUrl('https://hushsend.app', '1234', 'AbCdEf');
    const svg = await linkToQrSvg(url);
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
  });

  it('round-trips: the encoded link parses back to the same room code + secret', () => {
    const s = generateLinkSecret();
    const url = buildLinkUrl('https://hushsend.app', '4729', s.encoded);
    // A successful scan returns exactly `url`; parsing it must recover the inputs.
    const parsed = parseLink(url);
    expect(parsed).not.toBeNull();
    expect(parsed!.roomCode).toBe('4729');
    expect([...parsed!.secret]).toEqual([...s.bytes]);
  });
});
