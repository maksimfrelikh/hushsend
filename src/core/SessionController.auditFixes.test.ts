import { describe, it, expect, vi } from 'vitest';
import type { AppDispatch } from '../store';

/**
 * Regressions for the four breaks found in the 2026-09-12 audit. Each test fails against the code as
 * it stood that morning, so a reintroduction is caught rather than re-discovered:
 *
 *  1. SAS nonces were revealed before the DTLS fingerprints were pinned. The commit-reveal locks the
 *     two NONCES, but the SAS transcript is nonces + BOTH FINGERPRINTS — so a relay that controls
 *     delivery order could finish both nonce exchanges while its certificate on each leg was still
 *     unchosen, then grind ~2^16 certificates per leg to make both humans read the SAME phrase
 *     (measured: ~4 s). Holding the reveal until `fps` is set removes the free variable.
 *  2. `onWelcome` had no once-guard, so an injected second `welcome` flipped `this.role`
 *     mid-handshake — turning key-confirmation's role label, its only anti-reflection defence, into
 *     an oracle.
 *  3. `onEnrollFrame` gated on the METHOD rather than on the authenticated STATE, so any peer that
 *     reached an open DataChannel could plant a TOFU pin and harvest our long-term identity key.
 *  4. The "no bytes before authentication" invariant was enforced only on the SEND side; an
 *     unauthenticated peer's file offer reached the store and survived into the next pairing.
 */
const hoisted = vi.hoisted(() => {
  class MockPeerConnection {
    readonly sent: unknown[] = [];
    constructor(_handlers: unknown, _config: unknown) {}
    start(): void {}
    async handleSignal(): Promise<void> {}
    async send(data: unknown): Promise<void> {
      this.sent.push(data);
    }
    close(): void {}
    localFingerprint(): string | null {
      return 'sha-256 AA:BB';
    }
    remoteFingerprint(): string | null {
      return 'sha-256 CC:DD';
    }
    async localAddresses(): Promise<string[]> {
      return ['192.168.1.19'];
    }
    async selectedRemoteAddress(): Promise<string | null> {
      return '192.168.1.19';
    }
    maxMessageSize(): number {
      return 0;
    }
  }
  return { MockPeerConnection };
});
vi.mock('./webrtc/PeerConnection', () => ({ PeerConnection: hoisted.MockPeerConnection }));

import { SessionController } from './SessionController';
import { generateNonce, sasCommit } from './crypto/sas';

interface Internals {
  method: string | null;
  selfId: string | null;
  role: string | null;
  peerId: string | null;
  established: boolean;
  sas: Record<string, unknown> | null;
  peer: { sent: unknown[] } | null;
  signaling: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } | null;
  pendingOffer: unknown;
  pendingEnrollFrame: unknown;
  onWelcome(selfId: string, room: string, peers: unknown[]): void;
  onSasSignal(frame: unknown): void;
  onSasFingerprints(local: string | null, remote: string | null): void;
  onEnrollFrame(frame: unknown): Promise<void>;
  handleIncomingOffer(offer: { name: string; size: number; isZip: boolean }): void;
}

function newSc(): { sc: SessionController; i: Internals; dispatch: ReturnType<typeof vi.fn> } {
  const dispatch = vi.fn();
  const sc = new SessionController(dispatch as unknown as AppDispatch);
  const i = sc as unknown as Internals;
  i.signaling = { send: vi.fn(), close: vi.fn() };
  i.peer = { sent: [] };
  i.peerId = 'peer-b';
  i.method = 'room';
  return { sc, i, dispatch };
}

/** A SAS state that has reached the commit-reveal but has NO fingerprints yet — exactly the window
 *  the grinding attack lived in. */
function sasAwaitingFps(role: 'initiator' | 'responder') {
  return {
    role,
    myNonce: generateNonce(),
    peerCommit: null,
    peerNonce: null,
    revealedMine: false,
    fps: null,
    words: null,
    surfaced: false,
    localApproved: false,
    peerApproved: null,
    settled: false,
    timer: null,
  };
}

describe('1. SAS nonce is never revealed before the fingerprints are pinned', () => {
  it('initiator: a peer commit does NOT trigger a reveal while fps is null', () => {
    const { i } = newSc();
    i.sas = sasAwaitingFps('initiator');
    i.onSasSignal({ kind: 'sas-commit', c: Buffer.from(sasCommit(generateNonce())).toString('hex') });
    expect(i.sas!.peerCommit).not.toBeNull(); // the commit is stored…
    expect(i.sas!.revealedMine).toBe(false); // …but nothing was revealed
    expect(i.signaling!.send).not.toHaveBeenCalled();
  });

  it('initiator: the held reveal goes out the moment the fingerprints arrive', () => {
    const { i } = newSc();
    i.sas = sasAwaitingFps('initiator');
    i.onSasSignal({ kind: 'sas-commit', c: Buffer.from(sasCommit(generateNonce())).toString('hex') });
    i.onSasFingerprints('sha-256 AA:BB', 'sha-256 CC:DD');
    expect(i.sas!.revealedMine).toBe(true);
    expect(i.signaling!.send).toHaveBeenCalledTimes(1);
    const [, frame] = i.signaling!.send.mock.calls[0] as [string, { kind: string }];
    expect(frame.kind).toBe('sas-nonce');
  });

  it("responder: the peer's nonce does NOT trigger a reveal while fps is null", () => {
    const { i } = newSc();
    i.sas = sasAwaitingFps('responder');
    i.onSasSignal({ kind: 'sas-nonce', nonce: Buffer.from(generateNonce()).toString('hex') });
    expect(i.sas!.peerNonce).not.toBeNull();
    expect(i.sas!.revealedMine).toBe(false);
    expect(i.signaling!.send).not.toHaveBeenCalled();
    // …and goes out once they are.
    i.onSasFingerprints('sha-256 AA:BB', 'sha-256 CC:DD');
    expect(i.sas!.revealedMine).toBe(true);
  });

  it('reveals exactly once, even if the fingerprints are re-delivered', () => {
    const { i } = newSc();
    i.sas = sasAwaitingFps('initiator');
    i.onSasSignal({ kind: 'sas-commit', c: Buffer.from(sasCommit(generateNonce())).toString('hex') });
    i.onSasFingerprints('sha-256 AA:BB', 'sha-256 CC:DD');
    i.onSasFingerprints('sha-256 AA:BB', 'sha-256 CC:DD');
    expect(i.signaling!.send).toHaveBeenCalledTimes(1);
  });
});

describe('2. onWelcome is idempotent — an injected second welcome cannot flip the role', () => {
  it('ignores every welcome after the first', () => {
    const { i } = newSc();
    i.selfId = null;
    i.peerId = null;
    i.method = 'link';
    i.onWelcome('id-zzz', 'room-1', []); // first: accepted, no peers so no pairing starts
    expect(i.selfId).toBe('id-zzz');
    i.role = 'responder'; // we are mid-handshake, having already emitted our tag as the responder
    i.onWelcome('id-aaa', 'room-1', [{ id: 'id-mmm', device: 'Desktop', joinedAt: 1 }]);
    expect(i.selfId).toBe('id-zzz'); // not rewritten
    expect(i.role).toBe('responder'); // and crucially NOT flipped to initiator
  });
});

describe('3. enrollment is gated on the authenticated STATE, not on the method', () => {
  it('does not act on an enroll frame before `established` — it holds it instead', async () => {
    const { i } = newSc();
    i.established = false;
    await i.onEnrollFrame({ kind: 'enroll-init', pairingId: 'aa', pubKey: 'bb', sig: 'cc' });
    expect(i.peer!.sent).toHaveLength(0); // no enroll-ack ⇒ our identity key stayed put
    expect(i.pendingEnrollFrame).not.toBeNull(); // held, so an honest early arrival is not lost
  });
});

describe('4. the receive side of the no-bytes-before-auth invariant', () => {
  it('drops an inbound file offer while unauthenticated', () => {
    const { i, dispatch } = newSc();
    i.established = false;
    i.handleIncomingOffer({ name: 'invoice.pdf', size: 1024, isZip: false });
    expect(i.pendingOffer).toBeNull();
    const offered = dispatch.mock.calls.filter(([a]) => String((a as { type?: string })?.type).includes('offered'));
    expect(offered).toHaveLength(0);
  });
});
