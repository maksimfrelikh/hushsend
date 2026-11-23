import { z } from 'zod';
import {
  classifySelectedPath,
  relayCandidateEndpoint,
  selectedPairRelayed,
  selectedRemoteCandidate,
  shouldDropCandidate,
  stripRelayCandidates,
  type SelectedPathClass,
  type StatsEntry,
} from '../relax';
import { localCandidateAddresses } from '../pathAttest';
import { certificateHasFingerprint, sdpFingerprint } from './fingerprint';

/**
 * How long the Max-privacy channel-open gate waits for ICE to publish a selected candidate pair
 * before giving up and REFUSING the path (see `classifySelectedPath`).
 *
 * Measured 2026-09-13: chromium, firefox and webkit each report a selected pair on the FIRST read
 * after DataChannel `open` (0–1 ms, 3/3 runs per engine), so a healthy connection never waits and
 * this budget is insurance, not latency. It sits far below the 120 s key-confirmation deadline, so a
 * stalled gate surfaces as its own failure first.
 *
 * WHY 15 s AND NOT THE 5 s THIS SHIPPED WITH. 5 s was picked from the measurement above, taken on an
 * idle 8-core host — and the same codebase contains evidence that the worst case is not that: the
 * OTHER consumer of this resolver, `SessionController.verifyPath`, polls for up to 5 s because it was
 * measured returning null, on firefox↔webkit. Setting the deadline AT a measured worst case is
 * exactly where spurious failures come from. The cost asymmetry is severe and one-sided: waiting
 * longer only makes a doomed connection fail later, while refusing too early breaks an HONEST
 * transfer — for a user whose alternative to this tool may be worse than no transfer at all, on the
 * cheap phone and congested network this product exists for. So it matches PATH_ATTEST_TIMEOUT_MS.
 */
const SELECTED_PAIR_TIMEOUT_MS = 15_000;
/** Poll step while waiting for that selection. */
const SELECTED_PAIR_POLL_MS = 100;

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
  /** DataChannel or peer connection closed/failed. `why` names which, for the diagnostics log. */
  onClose?: (why: string) => void;
  /**
   * The connection went `disconnected` (true) or came back to `connected` from it (false) — edge
   * triggered, so the owner hears each change once. Transient by definition: a Wi-Fi hop or a tunnel
   * can bring it back and SCTP resumes where it stopped. A connection that does not come back goes
   * `failed`, which arrives through `onClose` / `onIceFailed` like any other failure.
   */
  onInterrupted?: (interrupted: boolean) => void;
  /**
   * ICE could NOT establish connectivity in the Max-privacy STRICT model (we drop the peer's SIGNALLED
   * relay candidates and never request local TURN, so no relay path was offered — a peer-reflexive one
   * can still be LEARNED; known gap, see core/relax.ts + README § Security — open). The owner treats
   * this as a terminal failure with a hint to switch to Reliable. Only fired while `filterRelay` is on
   * (Max-privacy); in Reliable an ICE failure goes through `onClose` (a genuine close — relay was
   * available and still couldn't save it).
   */
  onIceFailed?: () => void;
  /** A message arrived on the DataChannel. Step-1 ping uses strings; binary transfer is step 2. */
  onMessage?: (data: string | ArrayBuffer) => void;
  /**
   * The peer's description was refused, or the certificate DTLS accepted is not the one it named
   * (`DESCRIPTION_TAMPERED_REASON`, core/webrtc/fingerprint.ts). The description comes through the
   * untrusted server, so this is tampering until shown otherwise: the owner fails the pairing closed.
   * Nothing was applied in the first case, and `onOpen` never fires in the second.
   */
  onTampered?: (reason: string) => void;
}

export interface PeerConfig {
  /**
   * ICE servers for this connection. REQUIRED, with NO implicit default ON PURPOSE: the only source
   * is `buildIceServers()` (privacy mode + our OWN coturn from `VITE_STUN_URLS` + Reliable-mode TURN
   * creds). A built-in third-party STUN fallback would leak the client's public IP to a host we do
   * not control on every connection — a direct contradiction of the threat model — so there is
   * nothing to fall back to. `[]` (no ICE servers at all: dev/loopback, or Max-privacy with no STUN
   * configured) is a legitimate value and must be passed explicitly.
   */
  iceServers: RTCIceServer[];
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
  /**
   * DEV/TEST only: make the channel-open gate treat the SELECTED path as relayed, driving the
   * Max-privacy refusal without a real TURN relay and a real NAT failure to force one. The refusal
   * that follows is the production one — same `onIceFailure` → `onIceFailed` → `failDirect` path —
   * only the verdict is stubbed. Set by SessionController from `?forceRelayPath=1`.
   */
  forceRelayedPath?: boolean;
  /**
   * DEV/TEST only: milliseconds to hold the open channel back from the owner, AFTER the relay gate
   * has passed. Widens the window in which the channel already delivers `onmessage` but the owner has
   * not processed channel-open — a window that exists in production (the gate awaits `getStats()`) and
   * in which an arriving peer frame used to be dropped for good. Normally a few event-loop turns, so
   * the resulting bug looked like a rare engine-dependent flake; this makes it deterministic.
   * Production passes 0 and the branch is tree-shaken.
   */
  gateDelayMs?: number;
}

// Inbound signal payloads come from an UNTRUSTED relay — validate before touching the PC.
const descriptionSchema = z.object({ type: z.string(), sdp: z.string() });
const signalPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('offer'), description: descriptionSchema }),
  z.object({ kind: z.literal('answer'), description: descriptionSchema }),
  z.object({ kind: z.literal('ice'), candidate: z.unknown() }),
]);

/**
 * What the owner fails a pairing with when a description is refused (`onTampered`): the peer's
 * description did not name exactly one certificate, a second description arrived, or the certificate
 * DTLS accepted is not the one that was named. A STABLE marker — FailedScreen keys its "compromised"
 * variant off `tampered` / `man-in-the-middle`.
 */
export const DESCRIPTION_TAMPERED_REASON =
  'the connection description was tampered with — it must name exactly one certificate (possible man-in-the-middle)';

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
  /** Set by start(): the side that offers takes one answer, the side that answers takes one offer. */
  private initiator = false;
  /**
   * The peer's certificate fingerprint, from the ONE description this connection ever takes —
   * validated as it arrived (`sdpFingerprint`), before the engine saw it, and never replaced. What
   * `remoteFingerprint()` returns: the engines disagree on what `remoteDescription.sdp` serializes
   * back when a description carried more than one line, so that text is not read for it.
   */
  private remoteFp: string | null = null;
  /** one-shot guard for onTampered. */
  private tamperReported = false;
  /** Strict-model relay filter: drop the peer's relay candidates while true (Max-privacy). Fixed at
   *  construction — Max-privacy never escalates to a relay. */
  private readonly filterRelay: boolean;
  /** DEV/TEST: simulate an ICE failure + suppress our own candidates so no real path forms. */
  private readonly simulateIceFail: boolean;
  /** DEV/TEST: answer the channel-open gate as if the selected path terminated on a relay. */
  private readonly simulateRelayedPath: boolean;
  /** DEV/TEST only: ms to hold the channel back from the owner after the relay gate passes. */
  private readonly gateDelayMs: number;
  /** one-shot guard so the Max-privacy ICE-failure is reported (onIceFailed) at most once. */
  private iceFailureReported = false;
  /** Whether we last told the owner the connection is `disconnected` (see onInterrupted). */
  private interrupted = false;
  /** Settlers of the drain waits in flight. Our own close() fires no event on the channel — the spec
   *  closes data channels abruptly when their connection closes — so it settles these itself. */
  private readonly drainAborts = new Set<() => void>();
  /** Endpoints (`address|port`) of every relay candidate the filter dropped. ICE can still LEARN one
   *  of these as a peer-reflexive candidate (RFC 8445 §7.3.1.3) — the channel-open gate matches the
   *  selected pair against this set so a relayed path we never accepted cannot be used anyway. */
  private readonly droppedRelayEndpoints = new Set<string>();

  constructor(
    private readonly handlers: PeerConnectionHandlers = {},
    // No default: `iceServers` is required and has no fallback (see PeerConfig), so a config must be
    // passed explicitly rather than defaulting to `{}` and silently connecting with no ICE config.
    private readonly config: PeerConfig,
  ) {
    this.filterRelay = config.filterRelay ?? false;
    this.simulateIceFail = config.forceIceFail ?? false;
    this.simulateRelayedPath = config.forceRelayedPath ?? false;
    this.gateDelayMs = config.gateDelayMs ?? 0;
  }

  /**
   * Start negotiation. INITIATOR RULE: the `initiator` creates the DataChannel and the offer; the
   * responder waits for the offer and answers, never initiates. Exactly one of each per pair keeps
   * 1:1 free of offer/answer glare. The CALLER decides which side is the initiator — SessionController
   * fixes it PER-PAIRING from the two readable ids (smaller id = initiator, see `pairingRoleFor`), so
   * it works for any pair (incl. a joiner↔joiner lobby pair), not just "the side already in the room".
   */
  start(initiator: boolean): void {
    const pc = new RTCPeerConnection({ iceServers: this.config.iceServers });
    this.pc = pc;
    this.initiator = initiator;

    pc.onicecandidate = (e) => {
      // DEV/TEST: suppress our own candidates so no real path can form (drives the simulated failure).
      if (this.simulateIceFail) return;
      // null candidate = end-of-candidates; relay it too so the peer can finalize.
      this.handlers.onSignal?.({ kind: 'ice', candidate: e.candidate ? e.candidate.toJSON() : null });
    };
    pc.onconnectionstatechange = () => {
      if (import.meta.env.DEV) console.debug('[webrtc] connectionState =', pc.connectionState);
      if (this.closed) return;
      const state = pc.connectionState;
      if (state === 'failed') this.onIceFailure();
      else if (state === 'closed') this.handlers.onClose?.('peer connection closed');
      else if (state === 'disconnected') this.setInterrupted(true);
      else if (state === 'connected') this.setInterrupted(false);
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
   * the peer's signalled relay candidates and never request local TURN, so no relay path was offered —
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
      this.handlers.onClose?.('ICE failed');
    }
  }

  /** Tell the owner about a change between `disconnected` and `connected`, once per change. */
  private setInterrupted(interrupted: boolean): void {
    if (this.interrupted === interrupted) return;
    this.interrupted = interrupted;
    this.handlers.onInterrupted?.(interrupted);
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

    if (payload.kind === 'offer' || payload.kind === 'answer') {
      // ONE remote description per connection, of the kind this side is waiting for: the answerer
      // takes one offer, the offerer one answer. hushsend never renegotiates (`createOffer` is called
      // exactly once), so a second one is not a feature we have — but this handler used to apply ANY
      // offer until the channel was up, and any answer at any time, which handed the untrusted server
      // a renegotiation primitive: a later description with other ICE credentials moves the path at a
      // moment the attacker picks (2026-09-12 audit), and one with another fingerprint would swap the
      // certificate the authentication is bound to after it was read (2026-11-23).
      if (this.remoteFp !== null || (payload.kind === 'offer') === this.initiator) {
        if (import.meta.env.DEV) console.warn(`[webrtc] refused an unexpected ${payload.kind}`);
        return;
      }
      if (!(await this.takeRemoteDescription(pc, payload.description))) return;
      await this.flushIce();
      if (payload.kind === 'answer') return;
      await pc.setLocalDescription(await pc.createAnswer());
      const d = pc.localDescription;
      if (d) this.handlers.onSignal?.({ kind: 'answer', description: { type: d.type, sdp: d.sdp } });
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

  /** The fingerprint from our LOCAL SDP (what we offer the peer to validate against) — under the
   *  same rule as the peer's: null unless the description names exactly one. */
  localFingerprint(): string | null {
    const check = sdpFingerprint(this.pc?.localDescription?.sdp);
    return check.ok ? check.fingerprint : null;
  }

  /** The peer's certificate fingerprint — the value key-confirmation, the SAS and the reconnect
   *  signature bind to. From the description as it ARRIVED and was validated (`remoteFp`), not from
   *  what the engine serializes back; null until a description was taken, and after close(). */
  remoteFingerprint(): string | null {
    return this.pc ? this.remoteFp : null;
  }

  close(): void {
    this.closed = true;
    this.channel?.close();
    this.pc?.close();
    this.channel = null;
    this.pc = null;
    for (const abort of [...this.drainAborts]) abort();
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
    channel.onopen = () => void this.openChannelUnlessRelayed();
    channel.onclose = () => {
      if (!this.closed) this.handlers.onClose?.('data channel closed');
    };
    channel.onmessage = (e: MessageEvent) => this.handlers.onMessage?.(e.data as string | ArrayBuffer);
  }

  /**
   * Take the peer's description — the only one this connection will ever take. It is refused, and the
   * owner told (`onTampered`), unless every fingerprint line in it names the same single certificate
   * (core/webrtc/fingerprint.ts has the measurement that makes "the first line" unsafe). The value is
   * stored BEFORE the engine is handed the description, so nothing that arrives while that call is
   * pending can take its place; and what the engine then reports back has to name it too.
   */
  private async takeRemoteDescription(pc: RTCPeerConnection, description: unknown): Promise<boolean> {
    const d = this.sanitizeDescription(description);
    const check = sdpFingerprint(d?.sdp);
    if (!check.ok) {
      this.reportTampered(`the peer's description has ${check.reason === 'none' ? 'no' : check.reason} fingerprint lines`);
      return false;
    }
    this.remoteFp = check.fingerprint;
    await pc.setRemoteDescription(d);
    if (this.closed) return false;
    const kept = sdpFingerprint(pc.remoteDescription?.sdp);
    if (!kept.ok || kept.fingerprint !== check.fingerprint) {
      this.reportTampered('the engine kept a fingerprint other than the one the description named');
      return false;
    }
    return true;
  }

  private reportTampered(detail: string): void {
    if (this.closed || this.tamperReported) return;
    this.tamperReported = true;
    if (import.meta.env.DEV) console.warn(`[webrtc] refusing: ${detail}`);
    this.handlers.onTampered?.(DESCRIPTION_TAMPERED_REASON);
  }

  /**
   * The second lock, at channel-open: the certificate DTLS actually accepted has to be the one the
   * description named. `getRemoteCertificates()` gave the peer's certificate in Chromium 158, Firefox
   * 159 and WebKit 27.2 (measured 2026-11-23), and its SHA-256 was the fingerprint of the SDP in each.
   * Where an engine does not have the call, or reports no certificate, there is no second opinion and
   * the single-fingerprint rule stands alone — `true`. Certificates that are there, none of which is
   * the named one, are `false`; a chain is searched whole, so its order does not matter.
   */
  private async remoteCertificateMatches(): Promise<boolean> {
    const fingerprint = this.remoteFp;
    if (!fingerprint) return false;
    let chain: ArrayBuffer[];
    try {
      chain = this.pc?.sctp?.transport?.getRemoteCertificates?.() ?? [];
    } catch {
      return true;
    }
    if (chain.length === 0) return true;
    for (const der of chain) {
      if ((await certificateHasFingerprint(der, fingerprint)) !== false) return true;
    }
    return false;
  }

  private async flushIce(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    while (this.pendingIce.length) {
      const c = this.pendingIce.shift();
      if (c) await this.addIce(pc, c);
    }
  }

  /**
   * Max-privacy only: remove `typ relay` candidate lines carried INSIDE an inbound SDP, recording
   * their endpoints so the selected-path check still recognises the same address if ICE learns it as
   * peer-reflexive. `shouldDropCandidate` covers trickled candidates; this covers the ones that never
   * pass through it. Off (Reliable) the description is handed through untouched.
   */
  private sanitizeDescription(description: unknown): RTCSessionDescriptionInit {
    const d = description as RTCSessionDescriptionInit;
    if (!this.filterRelay || typeof d?.sdp !== 'string') return d;
    const { sdp, endpoints } = stripRelayCandidates(d.sdp);
    for (const endpoint of endpoints) this.droppedRelayEndpoints.add(endpoint);
    if (endpoints.length && import.meta.env.DEV) {
      console.debug(`[webrtc] stripped ${endpoints.length} relay candidate(s) from inbound SDP (Max-privacy)`);
    }
    return { ...d, sdp };
  }

  private async addIce(pc: RTCPeerConnection, candidate: RTCIceCandidateInit): Promise<void> {
    // STRICT model: in Max-privacy drop the peer's TURN-relay candidates, so we are never relayed —
    // not locally (no TURN requested) and not via the peer's relay.
    if (shouldDropCandidate(this.filterRelay, candidate)) {
      // Remember WHERE it would have pointed: the same endpoint can come back as a peer-reflexive
      // candidate learned from the peer's connectivity checks, which addIce never sees.
      const endpoint = relayCandidateEndpoint(candidate);
      if (endpoint) this.droppedRelayEndpoints.add(endpoint);
      if (import.meta.env.DEV) console.debug('[webrtc] dropped peer relay candidate (Max-privacy)');
      return;
    }
    try {
      await pc.addIceCandidate(candidate);
    } catch (err) {
      if (import.meta.env.DEV) console.warn('[webrtc] addIceCandidate failed', err);
    }
  }

  /**
   * Max-privacy STRICT gate, run at channel-open and BEFORE `onOpen` reaches the owner: verify the
   * path ICE actually selected is not relayed, then hand the channel over. Dropping the peer's
   * signalled `typ relay` candidates is not enough on its own — ICE also LEARNS candidates from
   * incoming connectivity checks, so a peer relaying through TURN can have us pair with its relayed
   * address as a PEER-REFLEXIVE candidate (RFC 8445 §7.3.1.3). That only wins when the direct path
   * failed — exactly the case the strict model promises to fail on — so we check rather than assume.
   *
   * A refusal goes through the SAME terminal path as a direct ICE failure (`onIceFailure` →
   * `onIceFailed` → the owner's `failDirect`, with the switch-to-Reliable hint), and `onOpen` never
   * fires, so the owner never reaches an authenticated state and NOT ONE BYTE crosses a relayed path.
   * Off entirely in Reliable, where a relay is allowed.
   *
   * In Max privacy the rule is now POSITIVE: open only on a path we established is direct. A path we
   * could not classify within the deadline is refused, not waved through — see `classifySelectedPath`
   * for why the old "no evidence of a relay ⇒ open" reading was a hole rather than caution, and for
   * the measurement showing this costs a healthy connection nothing.
   */
  private async openChannelUnlessRelayed(): Promise<void> {
    if (this.closed) return;
    if (this.filterRelay) {
      const verdict = await this.classifyPath();
      if (this.closed) return; // the await yields — the owner may have torn us down meanwhile
      if (verdict !== 'direct') {
        if (import.meta.env.DEV) {
          console.warn(`[webrtc] Max-privacy refusing: selected path is ${verdict}`);
        }
        this.onIceFailure();
        return;
      }
    }
    if (this.closed) return; // the await above yields — the owner may have torn us down meanwhile
    if (!(await this.remoteCertificateMatches())) {
      this.reportTampered('the certificate DTLS accepted is not the one the description named');
      return;
    }
    if (this.closed) return;
    // DEV/TEST: widen the window between "the channel is open and already delivering messages" and
    // "the owner has processed channel-open". That window is REAL — `setupChannel` wires `onmessage`
    // synchronously while this gate awaits `getStats()` — and a peer frame landing inside it used to
    // be dropped for good. It is normally a few event-loop turns, so the bug behaved as a rare
    // engine-dependent flake; this knob turns it into a deterministic test. Production always passes
    // 0 and the whole branch is tree-shaken (see gateDelayMs in SessionController).
    if (this.gateDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.gateDelayMs));
      if (this.closed) return;
    }
    this.handlers.onOpen?.();
  }

  /** Ask the policy (`relax.classifySelectedPath`) what the selected path is, wired to this
   *  connection's stats reader, dropped-relay endpoints and teardown flag. The reasoning — above all
   *  why `undetermined` is not `direct` — lives with the policy. */
  private classifyPath(): Promise<SelectedPathClass> {
    // DEV/TEST: stub the VERDICT only. Everything after it — the refusal, the teardown, the reason
    // the user sees — is the production path, which is the point of driving it from a test at all.
    if (this.simulateRelayedPath) return Promise.resolve('relayed');
    return classifySelectedPath({
      readStats: () => this.readStats(),
      droppedRelayEndpoints: this.droppedRelayEndpoints,
      timeoutMs: SELECTED_PAIR_TIMEOUT_MS,
      pollMs: SELECTED_PAIR_POLL_MS,
      aborted: () => this.closed,
    });
  }

  /** Read `getStats()` into a plain array, or null when the API is unavailable/rejects. */
  private async readStats(): Promise<StatsEntry[] | null> {
    const pc = this.pc;
    if (!pc) return null;
    try {
      const report = await pc.getStats();
      const entries: StatsEntry[] = [];
      report.forEach((value: unknown) => entries.push(value as StatsEntry));
      return entries;
    } catch {
      return null;
    }
  }

  /**
   * The addresses WE can be reached at, for path attestation (see `core/pathAttest.ts`). Host and
   * server-reflexive alike — the peer may have selected either. Empty when stats are unavailable,
   * which the peer reads as "cannot judge", never as a mismatch.
   */
  async localAddresses(): Promise<string[]> {
    const entries = await this.readStats();
    return entries ? localCandidateAddresses(entries) : [];
  }

  /** Whether the selected pair runs through a TURN relay on either side (see relax.selectedPairRelayed);
   *  null when nothing is selected yet or stats are unavailable. */
  async selectedPathRelayed(): Promise<boolean | null> {
    const entries = await this.readStats();
    return entries ? selectedPairRelayed(entries) : null;
  }

  /**
   * The remote address of the candidate pair ICE actually SELECTED — the thing we are really sending
   * to. Null when nothing is selected yet or stats are unavailable.
   */
  async selectedRemoteAddress(): Promise<string | null> {
    const entries = await this.readStats();
    if (!entries) return null;
    const remote = selectedRemoteCandidate(entries);
    if (!remote) return null;
    return remote.address ?? remote.ip ?? null;
  }

  /**
   * Resolve once the send buffer drains below the low-water mark — or REJECT if the channel closes
   * first. A channel that dies with bytes still queued never reports `bufferedamountlow`, and this
   * used to wait for it forever: the sender's pump hung inside the await, so its row sat on
   * "Sending 46 %" to a peer whose tab was long closed (README § F3). Rejecting ends the pump through
   * its own error path, which also cancels the file reader.
   */
  private waitForDrain(ch: RTCDataChannel): Promise<void> {
    return new Promise((resolve, reject) => {
      const settle = (closed: boolean): void => {
        ch.removeEventListener('bufferedamountlow', onLow);
        ch.removeEventListener('close', onClose);
        this.drainAborts.delete(onClose);
        if (closed) reject(new Error('data channel closed'));
        else resolve();
      };
      const onLow = (): void => settle(false);
      const onClose = (): void => settle(true);
      ch.addEventListener('bufferedamountlow', onLow);
      ch.addEventListener('close', onClose);
      this.drainAborts.add(onClose);
    });
  }
}
