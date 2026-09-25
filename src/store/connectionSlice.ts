import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { PathVerdict } from '../core/pathAttest';
import type { SasUiRole } from '../core/sasRole';
import type { PeerInfo } from '../types/protocol';

/**
 * The connection lifecycle as ONE explicit status field with guarded transitions.
 * This is the hand-rolled finite state machine — no scattered booleans. A single
 * source of truth means security invariants collapse to a status check, e.g.
 * "file bytes only ever flow while status === 'connected'".
 */
export type ConnectionStatus =
  | 'idle' // nothing in progress
  | 'creating' // A: allocating room + generating credential (words / code)
  | 'awaitingPeer' // A: room ready, credential shown, waiting for the other side
  | 'joining' // B: joining the room / entering the credential
  | 'pairing' // key agreement in progress (CPace for words; DTLS setup for room)
  | 'awaitingSas' // room method only: waiting for the human SAS comparison
  | 'confirming' // verifying key-confirmation + channel binding (DTLS fingerprint)
  | 'connected' // authenticated & channel-bound — data is allowed from here on
  | 'failed'; // terminal error (see `error`)

/** `reconnect` is the codeless pinned-key re-auth: no code, no SAS — its own screens. */
export type ConnectionMethod = 'words' | 'room' | 'link' | 'qr' | 'reconnect';

export interface ConnectionState {
  status: ConnectionStatus;
  method: ConnectionMethod | null;
  /** human-readable peer label from signaling — a LABEL, not identity */
  peerId: string | null;
  /** rendezvous code shown to A (rendezvous word, or numeric room) */
  room: string | null;
  /** credential to display to the user (e.g. the spoken words), if any */
  credential: string[] | null;
  /** SAS digits/emoji for the room method, when status === 'awaitingSas' */
  sas: string | null;
  /** Per-pairing SAS UI role (room method): `reader` (shows + reads its phrase) or `picker` (blind,
   *  identifies the phrase by listening). Derived from the two readable ids in the core
   *  (`sasRoleFor`), so it works for ANY pair (incl. joiner↔joiner). `null` = not resolved yet OR an
   *  id was missing → the SAS screen FAILS CLOSED (restart, never a functional picker). */
  sasRole: SasUiRole | null;
  /**
   * User-facing path-attestation result, carried THREE-WAY (see `core/pathAttest.ts`).
   *
   * This used to be binary — `ok` vs everything else — on the reasoning that a `mismatch` is not
   * reliable enough to accuse anyone with, because a peer behind mDNS-obfuscated host candidates
   * cannot name the address it was reached on and honest firefox↔webkit pairs therefore mismatch
   * with no attacker present. That reasoning is still right, and nothing here turns `mismatch` into
   * an accusation. What was wrong was the CONSEQUENCE: collapsing it made the one positive detection
   * the system can produce render identically to the everyday "this browser cannot tell" state — and
   * the copy under that state explains the cause as the browser's, which on a `mismatch` is false.
   * Since `unknown` is the ordinary outcome on Safari, users are trained to ignore exactly the badge
   * a real interposer would raise, and the DEV diagnostics that hold the real verdict are
   * tree-shaken out of the production bundle, so there is no other signal at all.
   *
   * So the three states stay distinct here and the UI says, for each, what was actually checked:
   *  - `ok`       — we verified the address we connected to is one the peer named.
   *  - `unknown`  — we could not check (one of the two browsers reported too little).
   *  - `mismatch` — we checked and it DISAGREED. Both causes are named to the user, and no byte is
   *                 gated on it: this is still advisory, which is what BACKLOG tracks.
   *
   * `null` until the attestation settles (or off the authenticated paths).
   */
  pathCheck: PathVerdict | null;
  /** True once two or more STUN servers have DISAGREED about our public address (see
   *  `core/stunCheck.ts`). Only the disagreement is projected: "they agree" and "there was nothing to
   *  compare" are both unremarkable, and a badge that is always green teaches people to ignore
   *  badges — the lesson of F2. Advisory: nothing is gated on it. */
  stunDisagreed: boolean;
  /**
   * Reliable mode only: the relay we were promised is NOT there. Set when a `turn-request` comes back
   * with no urls (TURN undeployed, a misconfigured secret, or the 5 s fetch timing out), which makes
   * this session direct-only — exactly what Max privacy does, but chosen by a user who asked for the
   * fallback. Nothing downstream is gated on it; it exists so a failure can SAY the fallback was
   * missing instead of reading as ordinary bad luck. Always false in Max privacy, which never asks.
   */
  relayUnavailable: boolean;
  /** Mesh-lobby roster (room method): everyone currently in the 4-digit room EXCEPT us. The human
   *  picks whom to raise a 1:1 channel with. Maintained from welcome (set) / peer-joined (add) /
   *  peer-left (remove). Empty/unused for words/link/qr (they auto-pair with a single peer). */
  roster: PeerInfo[];
  /** Transient lobby notice — currently only a clear "that peer is busy" rejection after a pick was
   *  bounced (the peer is already pairing with someone else). Cleared on the next pick or when the
   *  busy peer leaves. NOT a hang: the picker is back in the lobby and may pick another peer. */
  notice: { kind: 'busy'; peerId: string } | null;
  /** failure reason when status === 'failed' */
  error: string | null;
}

const initialState: ConnectionState = {
  status: 'idle',
  method: null,
  peerId: null,
  room: null,
  credential: null,
  sas: null,
  sasRole: null,
  pathCheck: null,
  stunDisagreed: false,
  relayUnavailable: false,
  roster: [],
  notice: null,
  error: null,
};

/**
 * Allowed transitions. A request from a state not listed here is ignored (and
 * warned in dev) — an illegal transition can't corrupt the machine.
 */
const ALLOWED: Record<ConnectionStatus, ConnectionStatus[]> = {
  idle: ['creating', 'joining'],
  creating: ['awaitingPeer', 'failed'],
  awaitingPeer: ['pairing', 'failed'],
  // room method is a mesh LOBBY: a joiner lands in the lobby (awaitingPeer) to see the roster + pick,
  // exactly like the creator — so `joining → awaitingPeer` is allowed (no new state). words/link/qr
  // still go straight `joining → pairing` (they auto-pair with a single peer).
  joining: ['pairing', 'awaitingPeer', 'failed'],
  // words method: a failed pairing attempt below the cap returns A to awaitingPeer (same words,
  // wait for the next joiner) — hence pairing/confirming → awaitingPeer. No new states added.
  pairing: ['awaitingSas', 'confirming', 'awaitingPeer', 'failed'],
  awaitingSas: ['confirming', 'failed'],
  confirming: ['connected', 'awaitingPeer', 'failed'],
  connected: ['idle', 'failed'], // 'idle' = clean session end / reset
  failed: ['idle'],
};

function canGo(from: ConnectionStatus, to: ConnectionStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

function warnIllegal(from: ConnectionStatus, to: ConnectionStatus): void {
  if (import.meta.env.DEV) {
    console.warn(`[connection] illegal transition ${from} -> ${to} ignored`);
  }
}

const slice = createSlice({
  name: 'connection',
  initialState,
  reducers: {
    /** Low-level guarded transition. Prefer the semantic events below. */
    transitioned(state, action: PayloadAction<ConnectionStatus>) {
      const to = action.payload;
      if (!canGo(state.status, to)) return warnIllegal(state.status, to);
      if (to === 'idle') return initialState; // full reset on session end
      state.status = to;
    },

    // --- semantic events (each goes through the same guard) ---
    createStarted(state, action: PayloadAction<{ method: ConnectionMethod }>) {
      if (!canGo(state.status, 'creating')) return warnIllegal(state.status, 'creating');
      state.status = 'creating';
      state.method = action.payload.method;
    },
    roomReady(state, action: PayloadAction<{ room: string; credential: string[] | null }>) {
      if (!canGo(state.status, 'awaitingPeer')) return warnIllegal(state.status, 'awaitingPeer');
      state.status = 'awaitingPeer';
      state.room = action.payload.room;
      state.credential = action.payload.credential;
    },
    joinStarted(state, action: PayloadAction<{ method: ConnectionMethod; room: string }>) {
      if (!canGo(state.status, 'joining')) return warnIllegal(state.status, 'joining');
      state.status = 'joining';
      state.method = action.payload.method;
      state.room = action.payload.room;
    },
    pairingStarted(state, action: PayloadAction<{ peerId: string }>) {
      if (!canGo(state.status, 'pairing')) return warnIllegal(state.status, 'pairing');
      state.status = 'pairing';
      state.peerId = action.payload.peerId;
    },
    sasReady(state, action: PayloadAction<{ sas: string }>) {
      if (!canGo(state.status, 'awaitingSas')) return warnIllegal(state.status, 'awaitingSas');
      state.status = 'awaitingSas';
      state.sas = action.payload.sas;
    },
    /** Project the per-pairing SAS UI role (reader/picker) computed in the core from the two readable
     *  ids. NOT an FSM transition — just a serializable projection the SAS screen reads (so it survives
     *  re-renders and is the single source of the asymmetric role). Set at pairing start, well before
     *  `awaitingSas`. */
    sasRoleResolved(state, action: PayloadAction<{ role: SasUiRole }>) {
      state.sasRole = action.payload.role;
    },

    /** Path attestation settled. The verdict is carried through VERBATIM — see the field's own note
     *  for why collapsing `mismatch` into `unknown` here was the bug, and `core/pathAttest.ts` for
     *  why `unknown` is benign by design. Still advisory: nothing downstream gates bytes on this. */
    pathSettled(state, action: PayloadAction<{ verdict: PathVerdict }>) {
      state.pathCheck = action.payload.verdict;
    },
    /** Several STUN servers disagreed about our public address — see the field's note. */
    stunDisagreement(state) {
      state.stunDisagreed = true;
    },
    /** Reliable mode asked for a relay and got none — see the field's note. */
    relayUnavailable(state) {
      state.relayUnavailable = true;
    },

    // --- mesh-lobby roster (room method) — serializable projections, NOT FSM transitions ---
    /** Replace the roster (from `welcome` — the peers already in the room when we arrived). */
    rosterSet(state, action: PayloadAction<PeerInfo[]>) {
      state.roster = action.payload;
    },
    /** A newcomer joined (`peer-joined`). Idempotent on id (a re-announce won't duplicate). */
    rosterAdd(state, action: PayloadAction<PeerInfo>) {
      if (!state.roster.some((p) => p.id === action.payload.id)) state.roster.push(action.payload);
    },
    /** A peer left (`peer-left`). Also clears a stale "busy" notice that named that peer. */
    rosterRemove(state, action: PayloadAction<{ peerId: string }>) {
      state.roster = state.roster.filter((p) => p.id !== action.payload.peerId);
      if (state.notice?.peerId === action.payload.peerId) state.notice = null;
    },
    /** Set/clear the transient lobby notice (the "X is busy" rejection). */
    lobbyNotice(state, action: PayloadAction<{ kind: 'busy'; peerId: string } | null>) {
      state.notice = action.payload;
    },
    /** Return to the lobby after a bounced pick (busy) WITHOUT leaving the room: `pairing →
     *  awaitingPeer`, clearing the half-started pairing's per-pair projections but KEEPING the room
     *  code + roster so the human can pick another peer. (General return-to-lobby after a finished
     *  session is a separate, deferred feature.) */
    returnToLobby(state) {
      if (!canGo(state.status, 'awaitingPeer')) return warnIllegal(state.status, 'awaitingPeer');
      state.status = 'awaitingPeer';
      state.sas = null;
      state.sasRole = null;
      state.pathCheck = null; // per-pair, exactly like sas — must not survive into the next pick
      state.peerId = null;
    },
    confirmStarted(state) {
      if (!canGo(state.status, 'confirming')) return warnIllegal(state.status, 'confirming');
      state.status = 'confirming';
    },
    connectionEstablished(state) {
      if (!canGo(state.status, 'connected')) return warnIllegal(state.status, 'connected');
      state.status = 'connected';
    },
    failed(state, action: PayloadAction<{ reason: string }>) {
      if (!canGo(state.status, 'failed')) return warnIllegal(state.status, 'failed');
      state.status = 'failed';
      state.error = action.payload.reason;
    },
    /** Hard reset back to idle (cancel / session end). */
    reset: () => initialState,
  },
});

export const connectionActions = slice.actions;
export default slice.reducer;
