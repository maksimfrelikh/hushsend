import type { ConfirmationRole } from './crypto/keyConfirmation';

/**
 * Per-pairing TRANSPORT/CRYPTO role, derived PURELY from the two readable signaling ids — the SAME
 * id ordering as the SAS reader/picker split (`sasRoleFor`): the lexicographically SMALLER id is the
 * `initiator`, the larger the `responder`.
 *
 * WHY per-pairing, not create/join: the room is a mesh LOBBY, so a 1:1 pair can be creator↔joiner OR
 * joiner↔joiner. The old rule "creator = initiator, joiner = responder" left a joiner↔joiner pair
 * with BOTH sides `responder` → nobody sends the WebRTC offer and the SAS commit-reveal (the
 * responder commits first) deadlocks. Fixing the role from the ids guarantees exactly one initiator +
 * one responder for ANY pair. Both peers compute it identically (ids are unique within a room) →
 * opposite roles. For a 1:1 creator↔joiner pair the OUTCOME is unchanged — same connection, same
 * authentication; only WHICH side offers / reveals first is now id-ordered.
 *
 * The role drives: the WebRTC offer/answer direction (initiator offers, responder answers), the
 * CPace initiator/responder (words), the SAS nonce ordering + commit-reveal order (room), and the
 * `lv(role)` label bound into the key-confirmation / enrollment transcripts. It is NOT the reconnect
 * protocol role (that stays create/join — the reconnect verifier-first must be a fixed side so a
 * key change is caught before the forger can settle; see SessionController), and it is NOT the SAS UI
 * reader/picker role (`sasRoleFor`, a display-only split that merely happens to share the same id
 * ordering). The crypto primitives (sas.ts / keyConfirmation.ts) are unchanged — only WHICH role each
 * side passes them changes.
 *
 * `null` means the role cannot be determined (an id is missing or — impossibly, ids are unique within
 * a room — the two are equal). The caller MUST FAIL CLOSED: never default a side, since defaulting
 * could put BOTH peers on the same role and re-introduce the deadlock.
 */
export function pairingRoleFor(
  selfId: string | null | undefined,
  peerId: string | null | undefined,
): ConfirmationRole | null {
  if (!selfId || !peerId || selfId === peerId) return null;
  return selfId < peerId ? 'initiator' : 'responder';
}
