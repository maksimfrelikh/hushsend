import { z } from 'zod';
import { shouldDropCandidate } from '../relax';

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
  /**
   * ICE could NOT establish connectivity in the Max-privacy STRICT model (we drop the peer's relay
   * candidates and never request local TURN, so no relay path could ever form). The owner treats this
   * as a terminal failure with a hint to switch to Reliable. Only fired while `filterRelay` is on
   * (Max-privacy); in Reliable an ICE failure goes through `onClose` (a genuine close — relay was
   * available and still couldn't save it).
   */
  onIceFailed?: () => void;
  /** A message arrived on the DataChannel. Step-1 ping uses strings; binary transfer is step 2. */
  onMessage?: (data: string | ArrayBuffer) => void;
}

export interface PeerConfig {
  /** ICE servers. Default is a public STUN; TURN/coturn fallback is configured later. */
  iceServers?: RTCIceServer[];
  /**
   * Max-privacy STRICT model (step 6d): drop the peer's TURN-relay candidates, so we are never relayed.
   * Set true in Max-privacy, false in Reliable. Fixed for the connection's lifetime (Max-privacy never
   * escalates to a relay — a direct failure is terminal). See core/relax.ts.
   */
  filterRelay?: boolean;
  /**
   * DEV/TEST only: simulate an ICE failure (and suppress our own candidates so no real path can form),
   * driving the Max-privacy-direct-failure path without a real network failure. Goes through the SAME
   * `onIceFailure` decision as a real failure. Set by SessionController from the `?forceIceFail=1` knob.
   */
  forceIceFail?: boolean;
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
  /** Strict-model relay filter: drop the peer's relay candidates while true (Max-privacy). Fixed at
   *  construction — Max-privacy never escalates to a relay. */
  private readonly filterRelay: boolean;
  /** DEV/TEST: simulate an ICE failure + suppress our own candidates so no real path forms. */
  private readonly simulateIceFail: boolean;
  /** one-shot guard so the Max-privacy ICE-failure is reported (onIceFailed) at most once. */
  private iceFailureReported = false;

  constructor(
    private readonly handlers: PeerConnectionHandlers = {},
    private readonly config: PeerConfig = {},
  ) {
    this.filterRelay = config.filterRelay ?? false;
    this.simulateIceFail = config.forceIceFail ?? false;
  }

  /**
   * Start negotiation. INITIATOR RULE: the `initiator` creates the DataChannel and the offer; the
   * responder waits for the offer and answers, never initiates. Exactly one of each per pair keeps
   * 1:1 free of offer/answer glare. The CALLER decides which side is the initiator — SessionController
   * fixes it PER-PAIRING from the two readable ids (smaller id = initiator, see `pairingRoleFor`), so
   * it works for any pair (incl. a joiner↔joiner lobby pair), not just "the side already in the room".
   */
  start(initiator: boolean): void {
    const pc = new RTCPeerConnection({ iceServers: this.config.iceServers ?? DEFAULT_ICE_SERVERS });
    this.pc = pc;

    pc.onicecandidate = (e) => {
      // DEV/TEST: suppress our own candidates so no real path can form (drives the simulated failure).
      if (this.simulateIceFail) return;
      // null candidate = end-of-candidates; relay it too so the peer can finalize.
      this.handlers.onSignal?.({ kind: 'ice', candidate: e.candidate ? e.candidate.toJSON() : null });
    };
    pc.onconnectionstatechange = () => {
      if (import.meta.env.DEV) console.debug('[webrtc] connectionState =', pc.connectionState);
      if (this.closed) return;
      if (pc.connectionState === 'failed') this.onIceFailure();
      else if (pc.connectionState === 'closed') this.handlers.onClose?.();
    };
    pc.oniceconnectionstatechange = () => {
      if (import.meta.env.DEV) console.debug('[webrtc] iceConnectionState =', pc.iceConnectionState);
      if (!this.closed && pc.iceConnectionState === 'failed') this.onIceFailure();
    };

    if (initiator) {
      this.setupChannel(pc.createDataChannel('hushsend', { ordered: true }));
      void this.makeOffer();
    } else {
      pc.ondatachannel = (e) => this.setupChannel(e.channel);
    }

    if (this.simulateIceFail) {
      // DEV/TEST: report a failure shortly after start — same path as a real ICE failure, so the
      // Max-privacy-direct-failure path runs deterministically without a network failure. One-shot
      // (onIceFailure self-guards).
      setTimeout(() => this.onIceFailure(), 300);
    }
  }

  /**
   * ICE could not establish connectivity. In the Max-privacy strict model (`filterRelay` on) we drop
   * the peer's relay candidates and never request local TURN, so no relay path could ever have formed —
   * report this as a terminal Max-privacy failure (onIceFailed; the owner fails with a switch-to-Reliable
   * hint). Otherwise (Reliable) a relay was available and still couldn't save it, so it's a genuine
   * close (onClose). One-shot.
   */
  private onIceFailure(): void {
    if (this.closed) return;
    if (this.filterRelay) {
      if (this.iceFailureReported) return;
      this.iceFailureReported = true;
      this.handlers.onIceFailed?.();
    } else {
      this.handlers.onClose?.();
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
   *  bufferedAmountLowThreshold. Small control messages (the step-1 ping, transfer control
   *  frames) resolve at once; the chunked file transfer (step 2) leans on the drain wait. */
  async send(data: string | ArrayBuffer | ArrayBufferView): Promise<void> {
    const ch = this.channel;
    if (!ch || ch.readyState !== 'open') throw new Error('data channel is not open');
    if (typeof data === 'string') ch.send(data);
    // Our transfer chunks are always backed by a plain ArrayBuffer; the lib's send()
    // overload is typed for ArrayBufferView<ArrayBuffer>, so narrow to it.
    else if (ArrayBuffer.isView(data)) ch.send(data as ArrayBufferView<ArrayBuffer>);
    else ch.send(data);
    if (ch.bufferedAmount > this.highWaterMark) await this.waitForDrain(ch);
  }

  /** SCTP-negotiated maximum DataChannel message size (bytes); 0 if not yet known.
   *  The file transfer clamps its chunk size to this so a chunk never exceeds the limit. */
  maxMessageSize(): number {
    return this.pc?.sctp?.maxMessageSize ?? 0;
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
    // STRICT model: in Max-privacy drop the peer's TURN-relay candidates, so we are never relayed —
    // not locally (no TURN requested) and not via the peer's relay.
    if (shouldDropCandidate(this.filterRelay, candidate)) {
      if (import.meta.env.DEV) console.debug('[webrtc] dropped peer relay candidate (Max-privacy)');
      return;
    }
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
