/**
 * Whether this browser exposes WebRTC at all. Some privacy browsers and hardened Firefox settings switch
 * it off, and then `new RTCPeerConnection` throws a ReferenceError the moment a pairing starts. Measured
 * on the live build (docs/test-runs/2026-10-11.md): before the up-front check and the guarded peer start,
 * such a joiner left BOTH sides on "Agreeing on keys…" until the server expired the room.
 *
 * Its own module, not PeerConnection.ts: the SessionController unit tests mock PeerConnection wholesale,
 * and the UI asks this before any session exists.
 */
export function webrtcAvailable(): boolean {
  return typeof (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection === 'function';
}

/** The failure reason when a pairing could not start for lack of WebRTC; FailedScreen keys its
 *  "this browser cannot send files" variant off it. */
export const WEBRTC_UNAVAILABLE_REASON = 'WebRTC is not available in this browser';
