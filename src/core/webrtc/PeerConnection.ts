import { z } from 'zod';

/**
 * The opaque `data` payload we put inside each signaling `signal` frame. The server
 * relays it without inspecting it; the peer validates it (the relay is UNTRUSTED).
 */
export type SignalPayload =
  | { kind: 'offer'; description: RTCSessionDescriptionInit }
  | { kind: 'answer'; description: RTCSessionDescriptionInit }
  | { kind: 'ice'; candidate: RTCIceCandidateInit | null };

export interface PeerConnectionHandlers {
  /** Emit a payload to relay to the remote peer (offer / answer / ICE candidate). */
  onSignal?: (data: SignalPayload) => void;
  /** DataChannel opened — transport is up. */
  onOpen?: () => void;
  /** DataChannel or peer connection closed/failed. */
  onClose?: () => void;
  /** A message arrived on the DataChannel. Step-1 ping uses strings; binary transfer is step 2. */
  onMessage?: (data: string | ArrayBuffer) => void;
}

export interface PeerConfig {
  /** ICE servers. Default is a public STUN; TURN/coturn fallback is configured later. */
  iceServers?: RTCIceServer[];
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

// Inbound signal payloads come from an UNTRUSTED relay — validate before touching the PC.
const descriptionSchema = z.object({ type: z.string(), sdp: z.string() });
const signalPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('offer'), description: descriptionSchema }),
  z.object({ kind: z.literal('answer'), description: descriptionSchema }),
  z.object({ kind: z.literal('ice'), candidate: z.unknown() }),
]);

function parseFingerprint(sdp: string | undefined | null): string | null {
  if (!sdp) return null;
  // SDP line: `a=fingerprint:<hash-func> <hex:hex:...>` — the value DTLS validates against.
  const m = /a=fingerprint:(\S+)\s+(\S+)/.exec(sdp);
  return m ? `${m[1]} ${m[2]}` : null;
}

/**
 * Wraps a raw RTCPeerConnection + RTCDataChannel (deliberately NOT PeerJS/
 * simple-peer, so we keep control of SDP and the DTLS certificate/fingerprint
 * needed for channel binding). Owns live objects; stays in the core.
 */
export class PeerConnection {
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  /** Remote ICE candidates that arrived before setRemoteDescription — flushed after. */
  private readonly pendingIce: RTCIceCandidateInit[] = [];
  /** Backpressure high-water mark (bytes). send() awaits drain past this. */
  private readonly highWaterMark = 1 << 20; // 1 MiB
  /** Set on our own close() so deliberate teardown doesn't fire onClose. */
  private closed = false;

  constructor(
    private readonly handlers: PeerConnectionHandlers = {},
    private readonly config: PeerConfig = {},
  ) {}

  /**
   * Start negotiation. INITIATOR RULE: the side already in the room is the
   * initiator — it creates the DataChannel and the offer. The newcomer is the
   * responder — it waits for the offer and answers, never initiates. This keeps
   * 1:1 free of offer/answer glare.
   */
  start(initiator: boolean): void {
    const pc = new RTCPeerConnection({ iceServers: this.config.iceServers ?? DEFAULT_ICE_SERVERS });
    this.pc = pc;

    pc.onicecandidate = (e) => {
      // null candidate = end-of-candidates; relay it too so the peer can finalize.
      this.handlers.onSignal?.({ kind: 'ice', candidate: e.candidate ? e.candidate.toJSON() : null });
    };
    pc.onconnectionstatechange = () => {
      if (import.meta.env.DEV) console.debug('[webrtc] connectionState =', pc.connectionState);
      if (!this.closed && (pc.connectionState === 'failed' || pc.connectionState === 'closed')) {
        this.handlers.onClose?.();
      }
    };

    if (initiator) {
      this.setupChannel(pc.createDataChannel('hushsend', { ordered: true }));
      void this.makeOffer();
    } else {
      pc.ondatachannel = (e) => this.setupChannel(e.channel);
    }
  }

  /** Handle an inbound signal payload relayed from the peer. */
  async handleSignal(data: unknown): Promise<void> {
    const parsed = signalPayloadSchema.safeParse(data);
    if (!parsed.success) {
      if (import.meta.env.DEV) console.warn('[webrtc] dropped invalid signal payload', parsed.error.issues);
      return;
    }
    const pc = this.pc;
    if (!pc) return;
    const payload = parsed.data;

    if (payload.kind === 'offer') {
      await pc.setRemoteDescription(payload.description as RTCSessionDescriptionInit);
      await this.flushIce();
      await pc.setLocalDescription(await pc.createAnswer());
      const d = pc.localDescription;
      if (d) this.handlers.onSignal?.({ kind: 'answer', description: { type: d.type, sdp: d.sdp } });
    } else if (payload.kind === 'answer') {
      await pc.setRemoteDescription(payload.description as RTCSessionDescriptionInit);
      await this.flushIce();
    } else {
      const candidate = payload.candidate as RTCIceCandidateInit | null;
      if (!candidate) return; // end-of-candidates marker
      if (pc.remoteDescription) await this.addIce(pc, candidate);
      else this.pendingIce.push(candidate); // buffer until remote description is set
    }
  }

  /** Send over the DataChannel, honoring backpressure: if the send buffer is above the
   *  high-water mark, the returned promise resolves only once it drains below
   *  bufferedAmountLowThreshold. Small control messages (the step-1 ping) resolve at once.
   *  (Heavy chunked use is wired up in step 2's file transfer.) */
  async send(data: string | ArrayBuffer): Promise<void> {
    const ch = this.channel;
    if (!ch || ch.readyState !== 'open') throw new Error('data channel is not open');
    if (typeof data === 'string') ch.send(data);
    else ch.send(data);
    if (ch.bufferedAmount > this.highWaterMark) await this.waitForDrain(ch);
  }

  /** The fingerprint from our LOCAL SDP (what we offer the peer to validate against). */
  localFingerprint(): string | null {
    return parseFingerprint(this.pc?.localDescription?.sdp);
  }

  /** The fingerprint from the REMOTE SDP — the cert DTLS actually validates the peer
   *  against. This is the value step-3 key-confirmation will MAC for channel binding. */
  remoteFingerprint(): string | null {
    return parseFingerprint(this.pc?.remoteDescription?.sdp);
  }

  close(): void {
    this.closed = true;
    this.channel?.close();
    this.pc?.close();
    this.channel = null;
    this.pc = null;
  }

  // ---- internals ----

  private async makeOffer(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    await pc.setLocalDescription(await pc.createOffer());
    const d = pc.localDescription;
    if (d) this.handlers.onSignal?.({ kind: 'offer', description: { type: d.type, sdp: d.sdp } });
  }

  private setupChannel(channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = this.highWaterMark / 2;
    this.channel = channel;
    channel.onopen = () => this.handlers.onOpen?.();
    channel.onclose = () => {
      if (!this.closed) this.handlers.onClose?.();
    };
    channel.onmessage = (e: MessageEvent) => this.handlers.onMessage?.(e.data as string | ArrayBuffer);
  }

  private async flushIce(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    while (this.pendingIce.length) {
      const c = this.pendingIce.shift();
      if (c) await this.addIce(pc, c);
    }
  }

  private async addIce(pc: RTCPeerConnection, candidate: RTCIceCandidateInit): Promise<void> {
    try {
      await pc.addIceCandidate(candidate);
    } catch (err) {
      if (import.meta.env.DEV) console.warn('[webrtc] addIceCandidate failed', err);
    }
  }

  private waitForDrain(ch: RTCDataChannel): Promise<void> {
    return new Promise((resolve) => {
      const onLow = () => {
        ch.removeEventListener('bufferedamountlow', onLow);
        resolve();
      };
      ch.addEventListener('bufferedamountlow', onLow);
    });
  }
}
