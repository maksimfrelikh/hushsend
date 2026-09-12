/**
 * Max-privacy STRICT relay filter (step 6d). Pure + framework-free so it unit-tests without a browser.
 *
 * Max-privacy = NEVER relayed. Period — no consent escalation, no relay-retry. Two mechanisms enforce
 * that, and they are ALWAYS on in Max-privacy:
 *   1. We request NO local TURN (the iceServers builder, step 6d) → we never offer a relay candidate.
 *   2. We DROP the peer's relay candidates (`isRelayCandidate`/`shouldDropCandidate`) → a relay address
 *      the peer SIGNALS is never added on our side.
 *
 *   3. We CHECK THE PATH WE ACTUALLY GOT before handing the channel to the app
 *      (`selectedRemoteCandidate` + `isForbiddenRemoteCandidate`, run from `PeerConnection` at
 *      channel-open, BEFORE `onOpen` → so not one byte can cross a relayed path).
 *
 * Mechanism 3 exists because 1+2 are NOT sufficient on their own (audit 2026-09-12): they cover
 * candidates we ADD, not the ones ICE LEARNS. A peer relaying through TURN sends its connectivity
 * checks FROM the relayed address, so per RFC 8445 §7.3.1.3 our agent learns that same address as a
 * PEER-REFLEXIVE candidate and can pair with it — the very address mechanism 2 just dropped. It bites
 * precisely when the direct path fails (otherwise the direct pair wins on priority) and only in a
 * mixed-privacy pair (Max ↔ Reliable; Max ↔ Max has no relay anywhere). Confidentiality was never at
 * risk (DTLS + PAKE/SAS); the PRIVACY PROMISE was, which is why the selected pair is now verified
 * rather than inferred from what we accepted.
 *
 * So a Max-privacy pair that cannot connect directly simply FAILS (the SessionController routes the ICE
 * failure to a terminal `failed`, with a hint to switch to Reliable); it is never offered a relay. The
 * relay path exists only in Reliable mode (STUN + TURN, where this filter is OFF). This module is just the candidate predicate; the live PeerConnection wiring (where the filter
 * runs) lives in PeerConnection, which owns the non-serializable objects.
 */

/**
 * STRICT-model predicate: is this inbound ICE candidate a TURN RELAY candidate? Matches the SDP
 * candidate attribute's `typ relay` field (e.g. `candidate:… typ relay raddr …`). Used to drop the
 * peer's relay candidates in Max-privacy, so we are never relayed.
 */
export function isRelayCandidate(candidate: { candidate?: string | null } | null | undefined): boolean {
  const s = candidate?.candidate;
  return typeof s === 'string' && /\btyp\s+relay\b/i.test(s);
}

/** Drop a peer ICE candidate iff we are currently filtering (Max-privacy) AND it is a relay candidate.
 *  Off (Reliable) → never drops; non-relay candidates → never dropped. */
export function shouldDropCandidate(
  filtering: boolean,
  candidate: { candidate?: string | null } | null | undefined,
): boolean {
  return filtering && isRelayCandidate(candidate);
}

/**
 * Strip `typ relay` candidate lines out of an inbound SDP, returning the cleaned SDP and the
 * endpoints removed.
 *
 * `shouldDropCandidate` only ever sees TRICKLED candidates — the ones that arrive as their own
 * signaling frames and pass through `addIce`. Candidates embedded in the SDP itself (non-trickle,
 * and anything a malicious relay chooses to inline) go straight to `setRemoteDescription` and are
 * added by the ICE agent with no filter in between. Until the 2026-09-12 audit that meant a
 * Max-privacy client would send STUN connectivity checks to a TURN relay — leaking its IP to the
 * very party the strict model exists to keep away — even though the channel-open gate would later
 * refuse the path. Removing the lines here closes the leak; recording their endpoints feeds the
 * same peer-reflexive check that `addIce` feeds, so a relayed address learned as `prflx` is still
 * refused.
 *
 * Only the candidate attribute lines go; everything else (m-lines, fingerprints, ICE credentials)
 * is untouched, so a mixed Max↔Reliable pair still has its host/srflx candidates to work with.
 */
export function stripRelayCandidates(sdp: string): { sdp: string; endpoints: string[] } {
  if (!/\btyp\s+relay\b/i.test(sdp)) return { sdp, endpoints: [] };
  const endpoints: string[] = [];
  const kept: string[] = [];
  for (const line of sdp.split(/\r?\n/)) {
    if (/^a=candidate:/i.test(line) && /\btyp\s+relay\b/i.test(line)) {
      const endpoint = relayCandidateEndpoint({ candidate: line });
      if (endpoint) endpoints.push(endpoint);
      continue; // drop the line
    }
    kept.push(line);
  }
  // Preserve the original line ending; SDP is CRLF by spec but engines emit both.
  return { sdp: kept.join(sdp.includes('\r\n') ? '\r\n' : '\n'), endpoints };
}

// ── mechanism 3: verify the path we actually got ──────────────────────────────

/** A remote ICE candidate as reported by `getStats()` — only the fields we judge on. Firefox has
 *  historically reported the address under `ip` rather than `address`, so both are accepted. */
export interface RemoteCandidateInfo {
  candidateType?: string | null;
  address?: string | null;
  ip?: string | null;
  port?: number | null;
}

/** One `getStats()` record. Deliberately untyped-but-narrow: the browser shapes differ across
 *  engines and versions, so every field is read defensively rather than trusted. */
export type StatsEntry = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}

/**
 * Canonical key for a transport endpoint, used to match a candidate we DROPPED against the remote
 * endpoint we ended up talking to. `address|port`, not `address:port` — an IPv6 address is full of
 * colons — and the address is lower-cased (IPv6 hex casing is not significant). Null when either
 * half is missing, which callers treat as "cannot match" rather than "matches".
 */
export function endpointKey(
  address: string | null | undefined,
  port: number | string | null | undefined,
): string | null {
  if (!address) return null;
  if (port === null || port === undefined || port === '') return null;
  return `${address.toLowerCase()}|${port}`;
}

/**
 * The endpoint a `typ relay` candidate would have us talk to (`address|port`), or null if this is
 * not a relay candidate. Parsed off the SDP candidate attribute, whose grammar (RFC 8839) fixes the
 * connection-address and port as the 5th and 6th tokens, immediately before `typ`. Recorded for every
 * candidate the filter drops, so mechanism 3 can recognise that same endpoint if ICE later learns it
 * as a peer-reflexive candidate.
 */
export function relayCandidateEndpoint(
  candidate: { candidate?: string | null } | null | undefined,
): string | null {
  const s = candidate?.candidate;
  if (typeof s !== 'string') return null;
  const m = /^(?:a=)?candidate:\S+\s+\d+\s+\S+\s+\d+\s+(\S+)\s+(\d+)\s+typ\s+relay\b/i.exec(s.trim());
  return m ? endpointKey(m[1], m[2]) : null;
}

/**
 * Is the remote end of the path we actually got one we must refuse in Max-privacy? Two ways to say
 * yes, because a relayed path can present itself either way:
 *   - the remote candidate is typed `relay` (it was signalled and — in Reliable — accepted), or
 *   - its endpoint is one we DROPPED as `typ relay`, which is how the peer-reflexive bypass looks:
 *     type `prflx`, address the peer's TURN allocation.
 * A `prflx` remote whose endpoint we never dropped is NOT refused — legitimate NAT mappings produce
 * peer-reflexive candidates on genuinely direct paths, and rejecting those would break real
 * connections. Off (Reliable) it always returns false: relay is allowed there.
 */
export function isForbiddenRemoteCandidate(
  filtering: boolean,
  remote: RemoteCandidateInfo | null | undefined,
  droppedRelayEndpoints: ReadonlySet<string>,
): boolean {
  if (!filtering || !remote) return false;
  if (remote.candidateType === 'relay') return true;
  const key = endpointKey(remote.address ?? remote.ip, remote.port);
  return key !== null && droppedRelayEndpoints.has(key);
}

/**
 * Pull the SELECTED candidate pair's remote candidate out of a `getStats()` report. Engines disagree
 * on how the selection is expressed, so the lookup degrades in order: the transport's
 * `selectedCandidatePairId` (the standard, Chromium), then a pair flagged `selected` (Firefox), then
 * a nominated succeeded pair, then any succeeded pair. Returns null when nothing is selected yet —
 * the caller must read that as "unknown", never as "safe".
 */
export function selectedRemoteCandidate(entries: Iterable<StatsEntry>): RemoteCandidateInfo | null {
  const byId = new Map<string, StatsEntry>();
  const pairs: StatsEntry[] = [];
  const transports: StatsEntry[] = [];
  for (const e of entries) {
    const id = str(e.id);
    if (id) byId.set(id, e);
    const type = str(e.type);
    if (type === 'candidate-pair') pairs.push(e);
    else if (type === 'transport') transports.push(e);
  }
  let pair: StatsEntry | undefined;
  for (const t of transports) {
    const id = str(t.selectedCandidatePairId);
    const found = id ? byId.get(id) : undefined;
    if (found) {
      pair = found;
      break;
    }
  }
  pair ??= pairs.find((p) => p.selected === true);
  pair ??= pairs.find((p) => p.nominated === true && str(p.state) === 'succeeded');
  pair ??= pairs.find((p) => str(p.state) === 'succeeded');
  if (!pair) return null;
  const remoteId = str(pair.remoteCandidateId);
  const remote = remoteId ? byId.get(remoteId) : undefined;
  if (!remote) return null;
  return {
    candidateType: str(remote.candidateType),
    address: str(remote.address),
    ip: str(remote.ip),
    port: num(remote.port),
  };
}
