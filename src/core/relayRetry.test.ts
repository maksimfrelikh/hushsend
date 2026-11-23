import { describe, expect, it } from 'vitest';
import { relayRetryToken } from './relayRetry';

const A = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';
const B = '11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00';

describe('relayRetryToken — the rendezvous of a retried pairing', () => {
  it('is the same token on both sides: local and remote swap', () => {
    expect(relayRetryToken(A, B)).toBe(relayRetryToken(B, A));
  });

  it('has the shape the server takes as a token room: 16 bytes, base64url, no padding', () => {
    expect(relayRetryToken(A, B)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('does not depend on the case or the padding of the SDP line', () => {
    expect(relayRetryToken(A.toLowerCase(), ` ${B} `)).toBe(relayRetryToken(A, B));
  });

  it('differs for another pair of certificates', () => {
    const C = B.replace('11:22', '11:23');
    expect(relayRetryToken(A, C)).not.toBe(relayRetryToken(A, B));
  });

  it('is null without two distinct fingerprints — nothing to continue from', () => {
    expect(relayRetryToken(null, B)).toBeNull();
    expect(relayRetryToken(A, null)).toBeNull();
    expect(relayRetryToken('', B)).toBeNull();
    expect(relayRetryToken(A, A.toLowerCase())).toBeNull();
  });
});
