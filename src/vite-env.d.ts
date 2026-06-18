/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Signaling server WebSocket URL. Dev default (when unset): ws://localhost:8080 */
  readonly VITE_SIGNALING_URL?: string;
}
