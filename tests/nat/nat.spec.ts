import { test, expect, type Browser, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createLink } from '../e2e/helpers';
import {
  APP,
  NAT_CHECK_URLS,
  ROUTER_WAN,
  annotate,
  launchBehind,
  measure,
  requireLab,
  serverLogs,
  setNat,
  type Measured,
  type NatRule,
  type Router,
} from './lab';

/**
 * Connectivity under real NAT behaviour — the part of the product nothing else in the repository
 * exercises (the e2e pairs two tabs on loopback), and what the real-device run of 2026-11-22
 * found by hand: Max privacy cannot cross a symmetric NAT, Reliable can, through the relay.
 *
 * Two real Chromiums run the BUILT app, each in its own network namespace behind its own NAT
 * router; signaling, coturn (STUN + TURN) and the app sit on the lab's public side
 * (tests/nat/net/lib.sh has the map, up.sh builds it). A case sets each router's rule, MEASURES
 * the mapping and filtering that rule produces, pairs the two browsers with a one-time link and
 * reads which candidate pair ICE selected.
 *
 *   1. Max ↔ Max, both NATs endpoint-independent            → connects, the pair is not a relay
 *   2. Max ↔ Max, symmetric ↔ port-restricted               → the failure screen with
 *                                                              `direct-fail-hint`, within a bound
 *   3. Reliable ↔ Reliable, symmetric ↔ port-restricted     → connects, the pair is a relay
 *   4. control: case 2's lab with the one rule switched back → connects
 *   5. the network check, an invite behind each NAT of case 2 → the symmetric side shows
 *                                                              `nat-warning` before anyone joins,
 *                                                              the other side does not
 *   6. case 2, then both tap "Retry with relay"              → the SAME pairing connects, the pair is
 *                                                              a relay; one tap alone relays nothing
 *
 * Case 4 is what keeps 2 honest: a lab where nothing connects (STUN down, a route missing) would
 * pass 2 as well. Case 2 also refuses to pass unless both sides gathered a server-reflexive
 * candidate on their router's address and started checking — it must be the NAT that stopped them.
 *
 * The app is the production build, so there are no DEV diagnostics: the connection is observed
 * from outside, by recording the page's RTCPeerConnections (the bundle is not touched). For case 5
 * that means the check's verdict is read from what it does — the warning — and from what its own
 * connections gathered, not from the DEV strip's `nat-verdict`.
 */

test.beforeAll(requireLab);

/** Max privacy must give up in well under this; a session still pending at the bound is a hang. */
const FAIL_WITHIN_MS = 60_000;
const CONNECT_WITHIN_MS = 60_000;
/** The check gives up gathering after 12 s (natCheck.ts); it answered in under a second on a LAN. */
const CHECK_WITHIN_MS = 15_000;
const PAYLOAD_BYTES = 512 * 1024;

type Mode = 'max' | 'reliable';
interface Lab {
  r1: NatRule;
  r2: NatRule;
}

interface Candidate {
  type: string;
  address: string | null;
  port: number | null;
  protocol: string | null;
}
interface SelectedPair {
  local: Candidate;
  remote: Candidate;
  bytesSent: number;
}
interface PcReport {
  /** A remote description was applied: this is the session's connection, not a STUN probe. */
  negotiated: boolean;
  /** The STUN / TURN URLs the connection was created with. */
  urls: string[];
  iceStates: string[];
  candidates: string[];
  selected: SelectedPair | null;
}
interface NatWindow {
  __natPcs: {
    pc: RTCPeerConnection;
    negotiated: boolean;
    urls: string[];
    iceStates: string[];
    candidates: string[];
  }[];
}

/** Runs in the page before the app: remember every RTCPeerConnection, its local candidates and its
 *  ICE states. The app closes a failed connection, so what it gathered has to be kept as it goes. */
function recordPeerConnections(): void {
  const seen: NatWindow['__natPcs'] = [];
  (window as unknown as NatWindow).__natPcs = seen;
  window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
    construct(target, args, newTarget) {
      const pc = Reflect.construct(target, args, newTarget) as RTCPeerConnection;
      const urls = ((args[0] as RTCConfiguration | undefined)?.iceServers ?? []).flatMap((s) => s.urls);
      const entry = { pc, negotiated: false, urls, iceStates: [] as string[], candidates: [] as string[] };
      pc.addEventListener('icecandidate', (e) => {
        if (e.candidate?.candidate) entry.candidates.push(e.candidate.candidate);
      });
      pc.addEventListener('signalingstatechange', () => {
        if (pc.remoteDescription) entry.negotiated = true;
      });
      pc.addEventListener('iceconnectionstatechange', () => entry.iceStates.push(pc.iceConnectionState));
      seen.push(entry);
      return pc;
    },
  });
}

async function peerConnections(page: Page): Promise<PcReport[]> {
  return page.evaluate(async () => {
    const reports: PcReport[] = [];
    for (const { pc, negotiated, urls, iceStates, candidates } of (window as unknown as NatWindow).__natPcs) {
      let selected: SelectedPair | null = null;
      try {
        const stats = await pc.getStats();
        const byId = new Map<string, Record<string, unknown>>();
        let pairId: unknown;
        stats.forEach((s: Record<string, unknown>) => {
          byId.set(s.id as string, s);
          if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
        });
        const pair = byId.get(pairId as string);
        const local = pair && byId.get(pair.localCandidateId as string);
        const remote = pair && byId.get(pair.remoteCandidateId as string);
        const candidate = (c: Record<string, unknown>): Candidate => ({
          type: c.candidateType as string,
          address: (c.address as string | undefined) ?? null,
          port: (c.port as number | undefined) ?? null,
          protocol: (c.protocol as string | undefined) ?? null,
        });
        if (pair && local && remote) {
          selected = { local: candidate(local), remote: candidate(remote), bytesSent: pair.bytesSent as number };
        }
      } catch {
        // a closed connection has no stats; the recorded candidates and states are the evidence
      }
      reports.push({ negotiated, urls, iceStates, candidates, selected });
    }
    return reports;
  });
}

interface Client {
  router: Router;
  browser: Browser;
  page: Page;
  console: string[];
}
const clients: Client[] = [];

async function openClient(router: Router, mode: Mode): Promise<Client> {
  const browser = await launchBehind(router);
  const page = await (await browser.newContext()).newPage();
  const client: Client = { router, browser, page, console: [] };
  clients.push(client);
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') client.console.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => client.console.push(`pageerror: ${e.message}`));
  await page.addInitScript(recordPeerConnections);
  await page.goto(APP);
  // The mode is a persisted preference read when pairing starts, so set it on the landing.
  await page.getByTestId(mode === 'max' ? 'privacy-toggle' : 'privacy-reliable').click();
  await expect(page.getByTestId('privacy-toggle')).toHaveAttribute('aria-checked', String(mode === 'max'));
  return client;
}

/** Set both rules, then MEASURE: a case never proceeds on a NAT that is not what it names. */
function prepare(lab: Lab): Record<Router, Measured> {
  const measured = {} as Record<Router, Measured>;
  for (const router of ['r1', 'r2'] as const) {
    setNat(router, lab[router]);
    const m = measure(router);
    expect(m.mapping, `nat-${router} (${lab[router]}): mapping, measured ${JSON.stringify(m.mapped)}`).toBe(
      lab[router] === 'cone' ? 'endpoint-independent' : 'address-and-port-dependent',
    );
    // Both rules filter the same way: only the exact endpoint that was sent to gets back in.
    expect(m.filtering, `nat-${router} (${lab[router]}): filtering`).toBe('address-and-port-dependent');
    expect(m.mapped.stun.split(':')[0], `nat-${router}: the address STUN reports`).toBe(ROUTER_WAN[router]);
    measured[router] = m;
  }
  return measured;
}

/** nat-c1 creates a one-time link, nat-c2 opens it. Returns once the join is under way. */
async function pair(mode: Mode): Promise<{ a: Client; b: Client; startedAt: number }> {
  const a = await openClient('r1', mode);
  const b = await openClient('r2', mode);
  const link = await createLink(a.page);
  expect(link.startsWith(`${APP}/#`), `the invite link: ${link}`).toBe(true);
  const startedAt = Date.now();
  // A full load, as when a person opens the link: the page was on the same document, where a
  // changed fragment alone would not run the join.
  await b.page.goto('about:blank');
  await b.page.goto(link);
  return { a, b, startedAt };
}

/** The session's own connection (the STUN cross-check opens throwaway ones). */
async function session(client: Client): Promise<PcReport> {
  const all = await peerConnections(client.page);
  const mine = all.filter((r) => r.negotiated);
  expect(mine, `${client.router}: connections that negotiated, of ${all.length} created`).toHaveLength(1);
  return mine[0];
}

const typesOf = (r: PcReport): string[] =>
  [...new Set(r.candidates.map((c) => / typ (\w+)/.exec(c)?.[1] ?? '?'))].sort();
const describePair = (p: SelectedPair): string =>
  `${p.local.type} ${p.local.address ?? '?'}:${p.local.port ?? '?'} → ${p.remote.type} ${p.remote.address ?? '?'}:${p.remote.port ?? '?'}`;
/** The distinct `address:port` a connection learned from STUN. */
const mappingsOf = (r: PcReport): string[] => [
  ...new Set(
    r.candidates.filter((c) => c.includes(' typ srflx')).map((c) => c.split(' ').slice(4, 6).join(':')),
  ),
];

/**
 * The network check's connections, which never negotiate: the one that asks both STUN destinations
 * from one socket, and the destinations that answered a connection of their own (asked only when
 * the first one could mean `direct`).
 */
async function networkCheck(client: Client): Promise<{ joint: string[][]; answeredAlone: string[] }> {
  const probes = (await peerConnections(client.page)).filter((r) => !r.negotiated);
  return {
    joint: probes.filter((r) => NAT_CHECK_URLS.every((u) => r.urls.includes(u))).map(mappingsOf),
    answeredAlone: [
      ...new Set(probes.filter((r) => r.urls.length === 1 && mappingsOf(r).length > 0).map((r) => r.urls[0])),
    ].sort(),
  };
}

async function expectConnected(a: Client, b: Client): Promise<{ a: SelectedPair; b: SelectedPair }> {
  for (const c of [a, b]) {
    await expect(c.page.getByTestId('status'), `${c.router}: status`).toHaveText('connected', {
      timeout: CONNECT_WITHIN_MS,
    });
    await expect(c.page.getByTestId('auth-state')).toContainText('authenticated');
  }
  const selected = { a: (await session(a)).selected, b: (await session(b)).selected };
  expect(selected.a, 'r1: a selected candidate pair').not.toBeNull();
  expect(selected.b, 'r2: a selected candidate pair').not.toBeNull();
  return selected as { a: SelectedPair; b: SelectedPair };
}

/** A file from nat-c1 to nat-c2, compared by hash — "connected" must mean bytes cross this path. */
async function transfer(a: Client, b: Client): Promise<void> {
  const payload = randomBytes(PAYLOAD_BYTES);
  await a.page
    .getByTestId('file-input')
    .setInputFiles({ name: 'nat.bin', mimeType: 'application/octet-stream', buffer: payload });
  await a.page.getByTestId('send-btn').click();
  await expect(b.page.getByTestId('transfer-phase')).toContainText('offered', { timeout: 30_000 });
  const download = b.page.waitForEvent('download', { timeout: 60_000 });
  await b.page.getByTestId('accept-btn').click();
  const file = await (await download).path();
  await expect(a.page.getByTestId('transfer-phase')).toContainText('done', { timeout: 60_000 });
  await expect(b.page.getByTestId('transfer-phase')).toContainText('done', { timeout: 60_000 });
  const sha = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');
  expect(sha(readFileSync(file)), 'the received file').toBe(sha(payload));
}

async function expectDirect(lab: Lab, title: string): Promise<void> {
  const nat = prepare(lab);
  const { a, b, startedAt } = await pair('max');
  const selected = await expectConnected(a, b);
  const tookMs = Date.now() - startedAt;
  for (const [client, p, peer] of [
    [a, selected.a, b],
    [b, selected.b, a],
  ] as const) {
    expect(p.local.type, `${client.router}: local candidate of ${describePair(p)}`).not.toBe('relay');
    // Not a relay, and not a host candidate either: a host pair would mean the two LANs reach
    // each other around the NATs and the lab proves nothing.
    expect(['srflx', 'prflx'], `${client.router}: remote candidate of ${describePair(p)}`).toContain(p.remote.type);
    // Chromium withholds the address of a peer-reflexive candidate; when it is there, it is the
    // peer's router.
    if (p.remote.address) expect(p.remote.address).toBe(ROUTER_WAN[peer.router]);
    expect(typesOf(await session(client)), `${client.router}: gathered candidate types`).not.toContain('relay');
  }
  await transfer(a, b);
  const sent = (await session(a)).selected?.bytesSent ?? 0;
  expect(sent, 'bytes sent on the selected pair').toBeGreaterThan(PAYLOAD_BYTES);
  annotate(
    'notice',
    title,
    `connected in ${tookMs} ms, ${PAYLOAD_BYTES} bytes delivered intact\n` +
      `r1 ${lab.r1} (${nat.r1.mapping} mapping): ${describePair(selected.a)}\n` +
      `r2 ${lab.r2} (${nat.r2.mapping} mapping): ${describePair(selected.b)}`,
  );
}

test.afterEach(async () => {
  const testInfo = test.info();
  if (testInfo.status !== testInfo.expectedStatus) {
    // Everything a failure can be explained from, in one annotation: the log is not readable
    // without a sign-in.
    const parts: string[] = [];
    for (const c of clients) {
      const status = await c.page.getByTestId('status').textContent({ timeout: 2_000 }).catch(() => '?');
      const reports = await peerConnections(c.page).catch(() => [] as PcReport[]);
      const pcs = reports.map(
        (r) =>
          `[${r.negotiated ? 'session' : 'probe'} ice=${r.iceStates.join('>') || '-'} types=${typesOf(r).join(',') || '-'}` +
          ` pair=${r.selected ? describePair(r.selected) : '-'}]`,
      );
      const session = reports.find((r) => r.negotiated);
      parts.push(
        `${c.router}: status=${status} ${pcs.join(' ')}`,
        ...(session?.candidates ?? []).map((x) => `  ${x}`),
        ...c.console.slice(-4).map((x) => `  ${x.slice(0, 300)}`),
      );
    }
    annotate('error', `NAT diag — ${testInfo.title}`, `${parts.join('\n')}\n${serverLogs()}`.slice(0, 6000));
  }
  await Promise.all(clients.splice(0).map((c) => c.browser.close().catch(() => {})));
});

test('Max ↔ Max · both NATs endpoint-independent → connects, and not through a relay', async () => {
  await expectDirect({ r1: 'cone', r2: 'cone' }, 'Max ↔ Max, cone ↔ cone');
});

test('Max ↔ Max · symmetric ↔ port-restricted → the failure screen with direct-fail-hint, within a bound', async () => {
  prepare({ r1: 'symmetric', r2: 'cone' });
  const { a, b, startedAt } = await pair('max');

  // Both sides, and bounded: a session that neither connects nor fails is the bug this guards.
  await Promise.all(
    [a, b].map((c) =>
      expect(
        c.page.getByTestId('direct-fail-hint'),
        `${c.router}: the direct-failure hint within ${FAIL_WITHIN_MS} ms`,
      ).toBeVisible({ timeout: FAIL_WITHIN_MS }),
    ),
  );
  const tookMs = Date.now() - startedAt;
  const seen: string[] = [];
  for (const c of [a, b]) {
    await expect(c.page.getByTestId('status')).toHaveText('failed');
    const pc = await session(c);
    // It failed for the reason this case names. Each side learned its router's public address
    // from STUN and offered it, and ICE really tried: without these a dead STUN server or a
    // missing route would pass as "the NAT blocked it".
    const srflx = pc.candidates.filter((x) => x.includes(' typ srflx'));
    expect(srflx.join(' | '), `${c.router}: a server-reflexive candidate on its router`).toContain(
      ` ${ROUTER_WAN[c.router]} `,
    );
    expect(pc.iceStates, `${c.router}: ICE states`).toContain('checking');
    expect(pc.iceStates, `${c.router}: ICE states`).not.toContain('connected');
    expect(typesOf(pc), `${c.router}: gathered candidate types`).not.toContain('relay');
    seen.push(`${c.router}: ICE ${pc.iceStates.join(' → ')}, gathered ${typesOf(pc).join(' + ')}`);
  }
  annotate(
    'notice',
    'Max ↔ Max, symmetric ↔ port-restricted',
    `direct-fail-hint on both sides after ${tookMs} ms (bound ${FAIL_WITHIN_MS} ms)\n${seen.join('\n')}`,
  );
});

test('Reliable ↔ Reliable · symmetric ↔ port-restricted → connects, through the relay', async () => {
  const nat = prepare({ r1: 'symmetric', r2: 'cone' });
  const { a, b, startedAt } = await pair('reliable');
  const selected = await expectConnected(a, b);
  const tookMs = Date.now() - startedAt;
  for (const [client, p] of [
    [a, selected.a],
    [b, selected.b],
  ] as const) {
    expect([p.local.type, p.remote.type], `${client.router}: ${describePair(p)}`).toContain('relay');
    // The client's own account of the path, the row a user sees: "relayed through the server".
    await expect(client.page.getByTestId('path-state'), `${client.router}: path verdict`).toHaveAttribute(
      'data-path-verdict',
      'relayed',
      { timeout: 30_000 },
    );
  }
  await transfer(a, b);
  const after = (await session(a)).selected;
  expect([after?.local.type, after?.remote.type], 'the pair the file went over').toContain('relay');
  expect(after?.bytesSent ?? 0, 'bytes sent on the relayed pair').toBeGreaterThan(PAYLOAD_BYTES);
  annotate(
    'notice',
    'Reliable ↔ Reliable, symmetric ↔ port-restricted',
    `connected in ${tookMs} ms, ${PAYLOAD_BYTES} bytes delivered intact through the relay\n` +
      `r1 symmetric (${nat.r1.mapping} mapping): ${describePair(selected.a)}\n` +
      `r2 cone (${nat.r2.mapping} mapping): ${describePair(selected.b)}`,
  );
});

test('control · the symmetric router switched back to endpoint-independent → Max ↔ Max connects', async () => {
  // Start from the failing lab and prove it is the failing one, so the only thing that changes
  // between case 2 and this one is the rule on nat-r1.
  prepare({ r1: 'symmetric', r2: 'cone' });
  await expectDirect({ r1: 'cone', r2: 'cone' }, 'control: nat-r1 symmetric → cone, Max ↔ Max');
});

test('network check · an invite behind the symmetric NAT warns before anyone joins; behind the endpoint-independent NAT it stays silent', async () => {
  const nat = prepare({ r1: 'symmetric', r2: 'cone' });
  const a = await openClient('r1', 'max');
  const b = await openClient('r2', 'max');
  const startedAt = Date.now();
  await createLink(a.page);
  await createLink(b.page);

  await expect(
    a.page.getByTestId('nat-warning'),
    `r1: the warning on the Share screen within ${CHECK_WITHIN_MS} ms`,
  ).toBeVisible({ timeout: CHECK_WITHIN_MS });
  const warnedAfterMs = Date.now() - startedAt;
  const behindSymmetric = await networkCheck(a);
  expect(behindSymmetric.joint, 'r1: connections that asked both STUN destinations').toHaveLength(1);
  // The warning is the NAT's doing: one socket was given two mappings on the router's address.
  const mappings = behindSymmetric.joint[0];
  expect(mappings.length, `r1: mappings of one socket, ${mappings.join(' and ')}`).toBe(2);
  for (const m of mappings) expect(m.split(':')[0], 'r1: the mapped address').toBe(ROUTER_WAN.r1);

  // Silence must be the verdict `direct`, not a check that never ran or never heard back: one
  // mapping for both destinations, and each destination answered a connection of its own.
  await expect
    .poll(async () => (await networkCheck(b)).answeredAlone, {
      message: 'r2: STUN destinations that answered a connection of their own',
      timeout: CHECK_WITHIN_MS,
    })
    .toEqual([...NAT_CHECK_URLS].sort());
  const behindCone = await networkCheck(b);
  expect(behindCone.joint, 'r2: connections that asked both STUN destinations').toHaveLength(1);
  expect(behindCone.joint[0], 'r2: mappings of one socket').toHaveLength(1);
  expect(behindCone.joint[0][0].split(':')[0], 'r2: the mapped address').toBe(ROUTER_WAN.r2);
  // The verdict reaches the screen as soon as those answers are in; a wrong one would show by now.
  await b.page.waitForTimeout(1_000);
  await expect(b.page.getByTestId('nat-warning'), 'r2: no warning').toHaveCount(0);
  await expect(b.page.getByTestId('status')).toHaveText('awaitingPeer');

  annotate(
    'notice',
    'network check, symmetric and endpoint-independent',
    `r1 symmetric (${nat.r1.mapping} mapping): nat-warning after ${warnedAfterMs} ms, one socket mapped to ${mappings.join(' and ')}\n` +
      `r2 cone (${nat.r2.mapping} mapping): no warning, one socket mapped to ${behindCone.joint[0][0]} by both destinations`,
  );
});

test('Max ↔ Max · symmetric ↔ port-restricted · both tap "Retry with relay" → the same pairing connects, through the relay', async () => {
  const nat = prepare({ r1: 'symmetric', r2: 'cone' });
  const { a, b } = await pair('max');
  await Promise.all(
    [a, b].map((c) =>
      expect(c.page.getByTestId('direct-fail-hint'), `${c.router}: the direct failure`).toBeVisible({
        timeout: FAIL_WITHIN_MS,
      }),
    ),
  );
  const negotiated = async (c: Client): Promise<PcReport[]> =>
    (await peerConnections(c.page)).filter((r) => r.negotiated);

  // One tap: that side waits, the other is told — and neither has built anything that could relay.
  const tappedAt = Date.now();
  await a.page.getByTestId('retry-relay-btn').click();
  await expect(a.page.getByTestId('relay-waiting'), 'r1: waiting for the peer').toBeVisible();
  await expect(a.page.getByTestId('link-url'), 'r1: no new invite').toHaveCount(0);
  await expect(b.page.getByTestId('peer-asks-relay'), 'r2: told that its peer waits').toBeVisible();
  await expect(b.page.getByTestId('status')).toHaveText('failed');
  for (const c of [a, b]) {
    const pcs = await negotiated(c);
    expect(pcs, `${c.router}: connections that negotiated after one tap`).toHaveLength(1);
    expect(typesOf(pcs[0]), `${c.router}: the failed attempt's candidate types`).not.toContain('relay');
    const turnAsked = (await peerConnections(c.page)).some((r) => r.urls.some((u) => u.startsWith('turn')));
    expect(turnAsked, `${c.router}: a connection configured with a relay after one tap`).toBe(false);
  }

  await b.page.getByTestId('retry-relay-btn').click();
  for (const c of [a, b]) {
    await expect(c.page.getByTestId('status'), `${c.router}: status`).toHaveText('connected', {
      timeout: CONNECT_WITHIN_MS,
    });
    await expect(c.page.getByTestId('auth-state')).toContainText('authenticated');
    await expect(c.page.getByTestId('path-state'), `${c.router}: path verdict`).toHaveAttribute(
      'data-path-verdict',
      'relayed',
      { timeout: 30_000 },
    );
  }
  const tookMs = Date.now() - tappedAt;
  const seen: string[] = [];
  for (const c of [a, b]) {
    const pcs = await negotiated(c);
    // The failed attempt and its continuation, on one page: nothing was reloaded or opened again.
    expect(pcs, `${c.router}: connections that negotiated`).toHaveLength(2);
    expect(pcs[0].iceStates, `${c.router}: the direct attempt`).not.toContain('connected');
    const p = pcs[1].selected;
    expect(p, `${c.router}: a selected pair on the retried connection`).not.toBeNull();
    expect([p!.local.type, p!.remote.type], `${c.router}: ${describePair(p!)}`).toContain('relay');
    seen.push(`${c.router}: ${describePair(p!)}`);
  }
  await transfer(a, b);
  const after = (await negotiated(a))[1].selected;
  expect([after?.local.type, after?.remote.type], 'the pair the file went over').toContain('relay');
  expect(after?.bytesSent ?? 0, 'bytes sent on the relayed pair').toBeGreaterThan(PAYLOAD_BYTES);
  await expect(a.page.getByTestId('link-url'), 'r1: still no new invite').toHaveCount(0);

  annotate(
    'notice',
    'Max ↔ Max, symmetric ↔ port-restricted, Retry with relay',
    `connected ${tookMs} ms after the first tap, ${PAYLOAD_BYTES} bytes delivered intact through the relay, one link\n` +
      `r1 symmetric (${nat.r1.mapping} mapping), r2 cone (${nat.r2.mapping} mapping)\n${seen.join('\n')}`,
  );
});
