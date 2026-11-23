/**
 * Where a pairing that failed to connect directly meets again, to continue through the relay.
 *
 * Both sides of the failed attempt hold the same two DTLS fingerprints (each one's own, and the
 * peer's from the received SDP), and nothing else is common to every method — a room pairing has no
 * shared secret before its SAS. So the retry rendezvous is derived from them: a 128-bit token room,
 * join-or-create, taken by each side on its own user's tap on "Retry with relay"
 * (SessionController.retryWithRelay, README § Max-privacy strict model).
 *
 * NOT a secret: the fingerprints crossed the untrusted server inside the SDP. Like every rendezvous
 * token it is routing only — the server can put anyone into any room — and what authenticates the
 * retried transport is the method's own check over the NEW fingerprints.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

const DOMAIN = utf8ToBytes('hushsend/relay-retry/rendezvous/v1');
const TOKEN_BYTES = 16;

function lv(data: Uint8Array): Uint8Array {
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, data.length);
  return concatBytes(len, data);
}

function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The token for the pairing whose failed attempt had these two fingerprints; null when either is
 * missing or they are equal (no remote description ever arrived, or a wiring bug) — the caller then
 * has nothing to continue and starts over. Order- and case-independent, so both sides agree.
 */
export function relayRetryToken(local: string | null, remote: string | null): string | null {
  if (!local || !remote) return null;
  const [a, b] = [local.trim().toLowerCase(), remote.trim().toLowerCase()].sort();
  if (!a || a === b) return null;
  const digest = sha256(concatBytes(lv(DOMAIN), lv(utf8ToBytes(a)), lv(utf8ToBytes(b))));
  return bytesToB64url(digest.slice(0, TOKEN_BYTES));
}
