/**
 * ICE-server config for the WebRTC PeerConnection, driven by the privacy toggle (step 6d, client
 * side). Pure + framework-free so it unit-tests without a browser.
 *
 * Two modes (the home "Max privacy" toggle):
 *   - `max` (DEFAULT): direct, peer-to-peer only. iceServers = our STUN (or none). We NEVER request
 *     TURN credentials, so the relay is never even contacted — the peer learns our IP, nothing relays.
 *   - `reliable`: our STUN + a TURN relay, so a pair that can't connect directly can fall back through
 *     coturn. The TURN credential is fetched from the signaling server (`turn-request`) and fed here.
 *
 * The relay is added ONLY when the server actually returned relay URLs: an empty `urls` means TURN is
 * unconfigured / undeployed (the server replies with empty urls even when a credential is present),
 * so we ignore the username/credential and stay STUN-only (direct-only). This keys relay availability
 * off `urls.length`, never off the presence of a credential.
 *
 * NOTE: switching mode affects the NEXT connection (iceServers are read at pairing start, before the
 * PeerConnection is created); it does NOT re-negotiate a live connection. A LIVE Max-privacy ICE
 * failure escalating to a relay on the fly is the separate relax-retry path (`src/core/relax.ts` +
 * SessionController) — it re-uses this builder (in 'reliable' shape) once the human consents to relay.
 */

/** Direct-only (`max`) vs relay-allowed (`reliable`). The toggle default is `max`. */
export type PrivacyMode = 'max' | 'reliable';

/** Default privacy mode — Max-privacy (direct only, never request/feed TURN). */
export const DEFAULT_PRIVACY_MODE: PrivacyMode = 'max';

/**
 * The per-session coturn credential the signaling server mints in reply to `turn-request`
 * (`{type:'turn-credentials', urls, username, credential, ttl}`). `urls` empty ⇒ relay unavailable.
 * The shared `TURN_SECRET` never leaves the server; only this derived credential reaches the client.
 */
export interface TurnCredentials {
  urls: string[];
  username: string;
  credential: string;
}

/** A `turn-credentials` reply that carries no usable relay — the direct-only fallback. */
export const NO_TURN: TurnCredentials = { urls: [], username: '', credential: '' };

/**
 * Parse the build-time STUN config (`VITE_STUN_URLS`, comma-separated) into an array. Pure so it can
 * be unit-tested directly. Empty / unset ⇒ `[]` (no STUN) — fine in dev/test where two loopback tabs
 * connect on host candidates with no STUN round-trip.
 */
export function parseStunUrls(raw: string | undefined | null): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The configured STUN URLs (from `VITE_STUN_URLS`). Empty in dev/test. */
export function configuredStunUrls(): string[] {
  return parseStunUrls(import.meta.env.VITE_STUN_URLS);
}

/**
 * Build the `iceServers` array the PeerConnection is created with, from the privacy mode, the
 * configured STUN URLs, and (Reliable only) the fetched TURN credentials.
 *
 *   - `max`:      STUN only (or `[]`). TURN is NEVER added — even if a `turn` arg is passed.
 *   - `reliable`: STUN + a TURN entry, but ONLY when `turn.urls` is non-empty (relay configured).
 *                 Empty `turn.urls` ⇒ STUN-only (relay undeployed → stay direct-only).
 */
export function buildIceServers(opts: {
  mode: PrivacyMode;
  stunUrls: string[];
  turn: TurnCredentials | null;
}): RTCIceServer[] {
  const { mode, stunUrls, turn } = opts;
  const servers: RTCIceServer[] = stunUrls.length > 0 ? [{ urls: stunUrls }] : [];
  if (mode === 'reliable' && turn && turn.urls.length > 0) {
    servers.push({ urls: turn.urls, username: turn.username, credential: turn.credential });
  }
  return servers;
}
