/**
 * Per-pairing SAS reader/picker role, derived PURELY from the two readable signaling ids.
 *
 * The room method is a mesh LOBBY: several peers can be in the same 4-digit room and any pair may
 * raise a 1:1 channel — INCLUDING joiner↔joiner. The SAS screen is asymmetric (one side READS its
 * phrase aloud, the other is the BLIND PICKER), so the role can no longer be "creator = reader /
 * joiner = picker" — two joiners would both be pickers and the comparison would degenerate (nobody
 * reads). Instead each 1:1 pair fixes the role from the two ids: the lexicographically SMALLER id is
 * the reader, the other the picker. Both peers compute this identically (ids are unique within a
 * room) → the roles are always opposite, for ANY pair.
 *
 * `null` means the role cannot be determined (an id is missing, or — impossibly — the two ids are
 * equal). The UI must FAIL CLOSED on null: render the "restart verification" screen, NEVER a
 * functional blind picker (a picker with no reader could false-accept a MITM ~1/9). This closes the
 * BACKLOG "SAS fail-closed on unset role" item.
 *
 * The readable id is a LABEL, not identity — it authenticates nothing on its own. It is used here
 * ONLY to deterministically split the asymmetric UI roles; the SAS crypto (sas.ts) is unchanged and
 * is what actually defeats a MITM.
 */
export type SasUiRole = 'reader' | 'picker';

export function sasRoleFor(selfId: string | null | undefined, peerId: string | null | undefined): SasUiRole | null {
  if (!selfId || !peerId || selfId === peerId) return null;
  return selfId < peerId ? 'reader' : 'picker';
}
