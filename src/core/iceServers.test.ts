import { describe, it, expect } from 'vitest';
import {
  buildIceServers,
  parseStunUrls,
  DEFAULT_PRIVACY_MODE,
  NO_TURN,
  type TurnCredentials,
} from './iceServers';

/**
 * The privacy-toggle → iceServers builder (step 6d, client side). The toggle picks how the
 * PeerConnection is configured:
 *   - `max` (DEFAULT): STUN only (or none) — direct-only, TURN is NEVER added (and never even fetched).
 *   - `reliable`: STUN + a TURN relay, BUT only when the server actually returned relay URLs; an empty
 *     `urls` (TURN unconfigured/undeployed) keeps us STUN-only, even if a credential is present.
 * These pin the exact array fed to RTCPeerConnection per mode + creds combination.
 */

const STUN = ['stun:stun.example.org:3478'];
const TURN: TurnCredentials = {
  urls: ['turn:turn.example.org:3478?transport=udp', 'turn:turn.example.org:3478?transport=tcp'],
  username: '1700000000', // a coturn future-expiry username
  credential: 'YmFzZTY0LWhtYWM=', // base64(HMAC-SHA1(secret, username))
};

describe('buildIceServers', () => {
  it('Max-privacy → STUN only (no TURN), even when creds are supplied', () => {
    expect(buildIceServers({ mode: 'max', stunUrls: STUN, turn: TURN })).toEqual([{ urls: STUN }]);
  });

  it('Max-privacy with no STUN configured → empty (loopback host candidates; fine in dev/test)', () => {
    expect(buildIceServers({ mode: 'max', stunUrls: [], turn: TURN })).toEqual([]);
    expect(buildIceServers({ mode: 'max', stunUrls: [], turn: null })).toEqual([]);
  });

  it('Reliable + relay creds → STUN + a TURN entry carrying the username/credential verbatim', () => {
    expect(buildIceServers({ mode: 'reliable', stunUrls: STUN, turn: TURN })).toEqual([
      { urls: STUN },
      { urls: TURN.urls, username: TURN.username, credential: TURN.credential },
    ]);
  });

  it('Reliable + relay creds but no STUN → TURN only', () => {
    expect(buildIceServers({ mode: 'reliable', stunUrls: [], turn: TURN })).toEqual([
      { urls: TURN.urls, username: TURN.username, credential: TURN.credential },
    ]);
  });

  it('Reliable + EMPTY urls (relay undeployed) → STUN only, ignoring any username/credential', () => {
    // The server replies with empty urls even when a credential is present if TURN_URLS is unset;
    // relay availability is keyed off urls.length, never off the credential — so we stay direct-only.
    expect(buildIceServers({ mode: 'reliable', stunUrls: STUN, turn: NO_TURN })).toEqual([{ urls: STUN }]);
    const credButNoUrls: TurnCredentials = { urls: [], username: 'x', credential: 'y' };
    expect(buildIceServers({ mode: 'reliable', stunUrls: STUN, turn: credButNoUrls })).toEqual([{ urls: STUN }]);
  });

  it('Reliable + null creds (not yet fetched / fetch failed) → STUN only', () => {
    expect(buildIceServers({ mode: 'reliable', stunUrls: STUN, turn: null })).toEqual([{ urls: STUN }]);
  });

  it('the DEFAULT privacy mode is Max-privacy → never relays (direct-only) even with creds in hand', () => {
    expect(DEFAULT_PRIVACY_MODE).toBe('max');
    const servers = buildIceServers({ mode: DEFAULT_PRIVACY_MODE, stunUrls: STUN, turn: TURN });
    // no TURN entry: every server is STUN-only (carries neither username nor credential)
    expect(servers.every((s) => !('credential' in s))).toBe(true);
    expect(servers).toEqual([{ urls: STUN }]);
  });
});

describe('parseStunUrls (VITE_STUN_URLS parsing)', () => {
  it('splits a comma-separated list, trimming whitespace and dropping empties', () => {
    expect(parseStunUrls('stun:a:3478, stun:b:3478 ,, stun:c:3478')).toEqual([
      'stun:a:3478',
      'stun:b:3478',
      'stun:c:3478',
    ]);
  });

  it('a single url → a one-element array', () => {
    expect(parseStunUrls('stun:a:3478')).toEqual(['stun:a:3478']);
  });

  it('empty / unset → [] (no STUN — fine in dev/test, two loopback tabs use host candidates)', () => {
    expect(parseStunUrls('')).toEqual([]);
    expect(parseStunUrls('   ')).toEqual([]);
    expect(parseStunUrls(undefined)).toEqual([]);
    expect(parseStunUrls(null)).toEqual([]);
  });
});
