/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Signaling server WebSocket URL. Dev default (when unset): ws://localhost:8080 */
  readonly VITE_SIGNALING_URL?: string;
  /** STUN server URL(s) for WebRTC ICE, comma-separated. Unset/empty ⇒ no STUN (fine in
   *  dev/test — two loopback tabs connect on host candidates). Used by both privacy modes. */
  readonly VITE_STUN_URLS?: string;
  /** A second STUN destination for the network check (core/natCheck.ts): the first of
   *  `VITE_STUN_URLS` and this one are asked from one socket. Unset/empty ⇒ the check does not run. */
  readonly VITE_NAT_CHECK_STUN_URL?: string;
}
