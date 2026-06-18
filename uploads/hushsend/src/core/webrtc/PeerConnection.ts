export interface PeerConnectionHandlers {
  onData?: (chunk: ArrayBuffer) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

/**
 * Wraps a raw RTCPeerConnection + RTCDataChannel (deliberately NOT PeerJS/
 * simple-peer, so we keep control of SDP and the DTLS certificate/fingerprint
 * needed for channel binding). Owns live objects; stays in the core.
 */
export class PeerConnection {
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;

  // `handlers` gets stored as a field when the offer/answer flow is implemented.
  constructor(_handlers: PeerConnectionHandlers = {}) {}

  // TODO: createOffer() / createAnswer() / applyRemoteDescription(); trickle ICE via signaling.
  // TODO: localFingerprint()  -> the a=fingerprint from the local SDP (for key-confirmation).
  // TODO: remoteFingerprint() -> the fingerprint DTLS is validating the peer cert against.
  // TODO: send(chunk) honoring bufferedAmount / bufferedAmountLowThreshold (backpressure).

  close(): void {
    this.channel?.close();
    this.pc?.close();
    this.channel = null;
    this.pc = null;
  }
}
