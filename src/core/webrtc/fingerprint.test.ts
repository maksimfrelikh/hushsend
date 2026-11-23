import { describe, expect, it } from 'vitest';
import { certificateHasFingerprint, sdpFingerprint } from './fingerprint';

const A = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';
const B = '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00';

/** A data-channel SDP as the engines write it: session lines, then one (or more) media sections. */
function sdp(session: string[], ...media: string[][]): string {
  const head = ['v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0', ...session];
  const sections = media.flatMap((lines) => [
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=ice-ufrag:4Zk1',
    ...lines,
    'a=setup:actpass',
    'a=sctp-port:5000',
  ]);
  return [...head, ...sections, ''].join('\r\n');
}
const fp = (value: string, hash = 'sha-256'): string => `a=fingerprint:${hash} ${value}`;

describe('sdpFingerprint — a description names exactly one certificate', () => {
  it('one line at media level (Chromium, WebKit) or at session level (Firefox)', () => {
    expect(sdpFingerprint(sdp([], [fp(A)]))).toEqual({ ok: true, fingerprint: `sha-256 ${A}` });
    expect(sdpFingerprint(sdp([fp(A)], []))).toEqual({ ok: true, fingerprint: `sha-256 ${A}` });
  });

  it('the same value repeated — per media section, or at both levels — is still one', () => {
    expect(sdpFingerprint(sdp([], [fp(A)], [fp(A)]))).toEqual({ ok: true, fingerprint: `sha-256 ${A}` });
    expect(sdpFingerprint(sdp([fp(A)], [fp(A)]))).toEqual({ ok: true, fingerprint: `sha-256 ${A}` });
  });

  it('two different lines at one level are refused, in either order — Firefox would accept a certificate under either', () => {
    expect(sdpFingerprint(sdp([], [fp(B), fp(A)]))).toEqual({ ok: false, reason: 'several' });
    expect(sdpFingerprint(sdp([], [fp(A), fp(B)]))).toEqual({ ok: false, reason: 'several' });
    expect(sdpFingerprint(sdp([fp(A), fp(B)], []))).toEqual({ ok: false, reason: 'several' });
  });

  it('two different lines at two levels are refused — the media-level one would be the one in force', () => {
    expect(sdpFingerprint(sdp([fp(A)], [fp(B)]))).toEqual({ ok: false, reason: 'several' });
    expect(sdpFingerprint(sdp([fp(B)], [fp(A)]))).toEqual({ ok: false, reason: 'several' });
    expect(sdpFingerprint(sdp([], [fp(A)], [fp(B)]))).toEqual({ ok: false, reason: 'several' });
  });

  it('two hash functions are two values, even for what may be one certificate', () => {
    const sha1 = A.split(':').slice(0, 20).join(':');
    expect(sdpFingerprint(sdp([], [fp(A), fp(sha1, 'sha-1')]))).toEqual({ ok: false, reason: 'several' });
  });

  it('case does not make two values out of one, and the result has one spelling', () => {
    const mixed = sdp([fp(A.toLowerCase(), 'SHA-256')], [fp(A)]);
    expect(sdpFingerprint(mixed)).toEqual({ ok: true, fingerprint: `sha-256 ${A}` });
    expect(sdpFingerprint(sdp([], [fp(A.toLowerCase())]))).toEqual({ ok: true, fingerprint: `sha-256 ${A}` });
  });

  it('none is refused', () => {
    expect(sdpFingerprint(sdp([], []))).toEqual({ ok: false, reason: 'none' });
    expect(sdpFingerprint('')).toEqual({ ok: false, reason: 'none' });
    expect(sdpFingerprint(null)).toEqual({ ok: false, reason: 'none' });
    expect(sdpFingerprint(undefined)).toEqual({ ok: false, reason: 'none' });
  });

  it('a line that mentions a fingerprint and cannot be read is refused, not skipped', () => {
    for (const odd of [
      `a=fingerprint:sha-256  ${B}`, // two spaces
      `a=fingerprint: sha-256 ${B}`,
      ` a=fingerprint:sha-256 ${B}`,
      `A=FINGERPRINT:sha-256 ${B}`,
      `a=fingerprint:sha-256 ${B} extra`,
      `a=fingerprint:sha-256 ${B.replace(/:/g, '')}`,
      'a=fingerprint:sha-256',
      `a=x-fingerprint:sha-256 ${B}`,
    ]) {
      expect(sdpFingerprint(sdp([], [fp(A), odd])), odd).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('a second line cannot hide behind a bare CR or a bare LF', () => {
    expect(sdpFingerprint(sdp([], [`${fp(A)}\r${fp(B)}`]))).toEqual({ ok: false, reason: 'several' });
    expect(sdpFingerprint(sdp([], [fp(A)]).replace(/\r\n/g, '\n') + `${fp(B)}\n`)).toEqual({
      ok: false,
      reason: 'several',
    });
  });
});

describe('certificateHasFingerprint — the certificate DTLS accepted against the one that was named', () => {
  const der = new TextEncoder().encode('not a real certificate, but bytes with a digest').buffer;
  const digest = async (algorithm: string): Promise<string> =>
    Array.from(new Uint8Array(await crypto.subtle.digest(algorithm, der)), (b) =>
      b.toString(16).padStart(2, '0').toUpperCase(),
    ).join(':');

  it('true for its own fingerprint, under each hash the engines may use', async () => {
    expect(await certificateHasFingerprint(der, `sha-256 ${await digest('SHA-256')}`)).toBe(true);
    expect(await certificateHasFingerprint(der, `sha-384 ${await digest('SHA-384')}`)).toBe(true);
    expect(await certificateHasFingerprint(der, `sha-1 ${await digest('SHA-1')}`)).toBe(true);
  });

  it('false for another one', async () => {
    expect(await certificateHasFingerprint(der, `sha-256 ${A}`)).toBe(false);
  });

  it('null — no opinion — for a hash it cannot compute', async () => {
    expect(await certificateHasFingerprint(der, `md5 ${A}`)).toBeNull();
    expect(await certificateHasFingerprint(der, 'sha-256')).toBeNull();
  });
});
