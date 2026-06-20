/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Signaling server WebSocket URL. Dev default (when unset): ws://localhost:8080 */
  readonly VITE_SIGNALING_URL?: string;
  /** STUN server URL(s) for WebRTC ICE, comma-separated. Unset/empty ⇒ no STUN (fine in
   *  dev/test — two loopback tabs connect on host candidates). Used by both privacy modes. */
  readonly VITE_STUN_URLS?: string;
}
