/**
 * Post-connect signaling teardown for the 1:1 methods (words / link / qr) — when does a signaling
 * `peer-left` still mean "this pairing attempt failed" (a guess attempt for words, a single-use
 * abort for link/qr)?
 *
 * The 1:1 client CLOSES its own signaling socket the instant it reaches an AUTHENTICATED
 * `connected` (so the untrusted server learns nothing about how long the P2P session runs — see
 * SessionController.closeSignalingAfterConnect). That close makes the OTHER side observe a
 * `peer-left`, and the two sides can close at slightly different instants (key-confirmation is
 * mutual but adjudicated independently, over the DataChannel — so the side that connects first can
 * close its socket a hair before the peer's own completion). We must NOT let that benign close —
 * nor a peer that simply closed its socket after connecting — be mistaken for a dropped/guessing
 * peer. So a `peer-left` is treated as a liveness/abort signal ONLY while the rendezvous is still
 * the liveness authority: BEFORE the DataChannel transport is up.
 *
 * Once the DataChannel is open, the DataChannel + ICE are the SOLE liveness signal:
 *   - a REAL abort after channel-open tears the channel down → the channel-close path handles it
 *     (and, for words, still counts the guess attempt — see SessionController.onChannelClose);
 *   - a peer that merely closed its signaling socket after connecting keeps the channel up → no
 *     teardown, correctly.
 * And trivially, once WE are `established` a `peer-left` is irrelevant (the channel outlives
 * signaling — the whole point of this feature).
 *
 * This does NOT weaken the words online-guessing bound. A guess is COUNTED whenever the
 * key-confirmation actually fails (tag mismatch → onConfirmFailure) or the transport collapses
 * (channel-close → onChannelClose) — both INDEPENDENT of signaling presence, both UNCHANGED. A
 * `peer-left` is the SOLE counter only before the channel ever opens (a peer that abandons the
 * rendezvous / CPace without bringing up a DataChannel), which this predicate still catches
 * (channelOpen === false there).
 */
export function peerLeftAbortsPairing(established: boolean, channelOpen: boolean): boolean {
  return !established && !channelOpen;
}
