import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASE, enrollViaSas, forwardConsole, resetBoth, startReconnect } from './helpers';

/**
 * Step-4b-ii reconnect (TOFU re-auth under pinned keys), end to end through two Chromium tabs.
 *
 * Setup: two peers FIRST enroll (SAS room → authenticated connected → each pins the other's Ed25519
 * identity under a shared pairingId). Then, with the pins in place, they RECONNECT with NO human
 * step — a mutual signature under the pinned keys, channel-bound to this session's DTLS
 * fingerprints + fresh challenges, replaces SAS. We assert two paths:
 *   - happy: enrolled peers reconnect → connected WITHOUT any SAS comparison → file byte-for-byte;
 *   - key-changed: one side presents a DIFFERENT identity key under the same pairingId (the DEV
 *     `forgeReconnectKey` knob) → the other side's check (1) fires a visible hard stop → both fail,
 *     no channel, no transfer.
 *
 * The two tabs use SEPARATE browser contexts so each has its OWN IndexedDB → DISTINCT identities
 * and pins (two tabs in one context would share storage). Every tab forces the RAM-bound Blob
 * receive path (`?forceBlob=1`) so the download is observable. A MITM / channel-binding e2e is NOT
 * attempted (simulating swapped DTLS certs in Playwright is impractical) — that path is covered by
 * the reconnect unit tests ("rejects under DIFFERENT fingerprints"), as for keyConfirmation/SAS.
 */

const TMP = join(process.cwd(), 'e2e-tmp-reconnect');

/**
 * How long these assertions wait — deliberately LONGER than the app's own 120 s reconnect deadline
 * (`DEFAULT_RECONNECT_TIMEOUT_MS`), and the per-test budget is raised to fit.
 *
 * It used to be 60 s, which is SHORTER than that deadline, and it cost three debugging sessions: the
 * test gave up before the app could report its own verdict, so "the re-auth stalled forever" and
 * "the app failed correctly at its deadline" produced the IDENTICAL failure — `Received: "pairing"` —
 * and nothing distinguished them. Raising it was deliberately NOT done while the stall was
 * unexplained, because raising a timeout mid-hunt is how a real hang gets hidden. With the cause
 * found and fixed (an early `reconnect-init` dropped for good — BACKLOG § Third pass), it now makes
 * the next failure informative rather than ambiguous: a stall that survives the app's own deadline is
 * a different bug from one the deadline catches, and this is what tells them apart.
 */
const RECONNECT_ASSERT_TIMEOUT_MS = 140_000;
// The default per-test budget (180 s) is not enough to WAIT OUT the deadline and still report, so the
// whole file gets room. Only failures are slow; a healthy reconnect finishes in a couple of seconds.
test.describe.configure({ timeout: 300_000 });

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Open one isolated context+page (own IndexedDB → its own identity), forcing the Blob receive
 *  path. `extraQuery` enables a DEV knob on this tab (e.g. `forgeReconnectKey=1`). */
let tabSeq = 0;
/** Contexts opened by the current test, closed after it — see the afterEach below. */
const openContexts: BrowserContext[] = [];

async function openTab(browser: Browser, extraQuery = ''): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE, acceptDownloads: true });
  openContexts.push(context);
  const page = await context.newPage();
  forwardConsole(page, `tab${++tabSeq}${extraQuery ? ` ${extraQuery}` : ''}`);
  await page.goto(`${BASE}/?forceBlob=1${extraQuery ? `&${extraQuery}` : ''}`);
  return page;
}

// Each test here opens two tabs and every one of them holds a live WebRTC connection and a signaling
// socket. Without this they all stayed open until the FILE finished, so by the third test six tabs
// were competing — which is how a 3-second test turned into a 60-second timeout on a loaded machine.
// Close what the test opened.
test.afterEach(async () => {
  await Promise.all(openContexts.splice(0).map((c) => c.close().catch(() => {})));
});

/** Drive A (creator) + B (joiner) through a SAS room to an authenticated connected, so enrollment
 *  pins each other's identity under a shared pairingId. Leaves both at `connected`. */

/** Dispose both sessions back to `idle` so a fresh reconnect can start. The keystore pins PERSIST
 *  in IndexedDB across dispose (only the per-session state resets), which is exactly what reconnect
 *  reads from. */

/** A starts a reconnect (allocates a fresh room, announces its stored pairingId); B joins by code.
 *  Returns once B has joined. */

test.beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

test('happy reconnect: enrolled peers re-auth via the pinned key (no SAS) → connected → transfer intact', async ({
  browser,
}) => {
  const a = await openTab(browser);
  const b = await openTab(browser);

  await enrollViaSas(a, b);
  await resetBoth(a, b);
  await startReconnect(a, b);

  // Both reach connected WITHOUT any SAS comparison — the pinned-key signatures authenticated it.
  await expect(a.getByTestId('status')).toHaveText('connected', { timeout: RECONNECT_ASSERT_TIMEOUT_MS });
  await expect(b.getByTestId('status')).toHaveText('connected', { timeout: RECONNECT_ASSERT_TIMEOUT_MS });
  await expect(a.getByTestId('auth-state')).toContainText('reconnect');
  await expect(b.getByTestId('auth-state')).toContainText('reconnect');

  // File transfer still works over the reconnect-authenticated DataChannel.
  const src = join(TMP, 'note.bin');
  const payload = randomBytes(200 * 1024);
  writeFileSync(src, payload);
  const srcHash = sha256(payload);

  await a.getByTestId('file-input').setInputFiles(src);
  await a.getByTestId('send-btn').click();
  await expect(b.getByTestId('transfer-phase')).toContainText('offered');

  const downloadPromise = b.waitForEvent('download', { timeout: RECONNECT_ASSERT_TIMEOUT_MS });
  await b.getByTestId('accept-btn').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('note.bin');
  const out = join(TMP, 'note.out');
  await download.saveAs(out);
  await expect(a.getByTestId('transfer-phase')).toContainText('done', { timeout: 30_000 });
  await expect(b.getByTestId('transfer-phase')).toContainText('done', { timeout: 30_000 });
  expect(sha256(readFileSync(out))).toBe(srcHash);
});

test('reconnect liveness deadline FIRES: a peer that never completes re-auth → the initiator fails at the deadline (no hang)', async ({
  browser,
}) => {
  // Closes the "mismatched-entry hang" residual (BACKLOG § Reconnect UX): on the reconnect path the
  // re-auth wait (reconnect-init → reconnect-proof) now has its OWN liveness deadline, INDEPENDENT of
  // the SAS pre-timer (which guards the SAS commit-reveal, not a stalled reconnect). Two DEV-only knobs
  // drive the FIRING direction (prod keeps the fixed 120 s deadline and never stalls — both are
  // tree-shaken out):
  //   - ?stallReconnect / window.__HUSHSEND_STALL_RECONNECT__ — this side reaches the reconnect
  //     handshake but withholds its reconnect-proof, standing in for the real bug (a peer that joined
  //     via the plain-SAS lobby and never runs the reconnect protocol at all → no reconnect response);
  //   - ?reconnectTimeoutMs=N — shrink the reconnect deadline so its firing is observable in seconds,
  //     NOT a real 120 s wait (SEPARATE from the SAS knobs, so it can't pre-empt SAS state).
  // The knobs are INERT during the initial plain-SAS enrollment below (no reconnect state there).
  // ASYMMETRIC deadlines on purpose. Both sides arm this timer, so giving them the same 6 s made the
  // outcome a race: whichever fired first decided the reason, and on Gecko it was B's teardown, so A
  // failed with "channel closed during re-auth" instead of the timeout under test. A short deadline
  // on A and a long one on B makes A's timer win on every engine — the firing direction is the point.
  const a = await openTab(browser, 'reconnectTimeoutMs=6000');
  const b = await openTab(browser, 'reconnectTimeoutMs=60000&stallReconnect=1');

  await enrollViaSas(a, b); // both pin each other (a fresh SAS pairing — reconnect knobs do nothing here)
  await resetBoth(a, b);
  await startReconnect(a, b); // A = reconnect-initiator (announces the pairingId); B = responder (stalls its proof)

  // B receives A's reconnect-init and would prove possession of its pinned key — but withholds the
  // reconnect-proof. So A (the initiator) waits for a response that never comes, stays in `pairing`,
  // and FAILS at the (shrunk) reconnect deadline rather than hanging — the firing direction under test.
  // Without the deadline this exact combination hung forever in "agreeing on keys".
  await expect(a.getByTestId('status')).toHaveText('failed', { timeout: 30_000 });
  await expect(a.getByTestId('error')).toContainText('timed out');
  // The stalling side does not hang either — it fails at its own deadline (or on A's teardown).
  await expect(b.getByTestId('status')).toHaveText('failed', { timeout: 30_000 });

  // No DataChannel transfer happened on EITHER side — the transfer UI renders only at `connected`,
  // so its absence is the structural proof that no byte could have crossed.
  for (const page of [a, b]) {
    await expect(page.getByTestId('file-input')).toHaveCount(0);
    await expect(page.getByTestId('send-btn')).toHaveCount(0);
    await expect(page.getByTestId('status')).not.toHaveText('connected');
  }
});

test('key-changed hard-stop: a peer presenting a different key under the same pairingId is rejected → no transfer', async ({
  browser,
}) => {
  const a = await openTab(browser);
  // B carries the forge knob: enrollment still uses B's REAL key (the knob only affects the
  // reconnect proof), so A pins B's real key — but on reconnect B presents a FRESH key.
  const b = await openTab(browser, 'forgeReconnectKey=1');

  await enrollViaSas(a, b);
  await resetBoth(a, b);
  await startReconnect(a, b);

  // A's check (1) sees B's presented key ≠ the pinned key → a VISIBLE key-changed hard stop (not a
  // toast). The other side goes down on the torn-down channel. No side reaches `connected`.
  await expect(a.getByTestId('status')).toHaveText('failed', { timeout: RECONNECT_ASSERT_TIMEOUT_MS });
  await expect(a.getByTestId('key-changed')).toBeVisible();
  await expect(a.getByTestId('error')).toContainText('key changed');
  await expect(b.getByTestId('status')).toHaveText('failed', { timeout: RECONNECT_ASSERT_TIMEOUT_MS });

  // No DataChannel transfer happened on EITHER side — not just "the banner is shown". The transfer
  // surface (the file picker AND the transfer panel/plaque + send control) renders ONLY at status
  // `connected` (TransferScreen), so its total absence here is the structural proof that no byte
  // could have crossed the DataChannel: never connected ⇒ no transfer UI ⇒ no transfer.
  for (const page of [a, b]) {
    await expect(page.getByTestId('file-input')).toHaveCount(0);
    await expect(page.getByTestId('send-btn')).toHaveCount(0);
    await expect(page.getByTestId('transfer')).toHaveCount(0);
    await expect(page.getByTestId('status')).not.toHaveText('connected');
  }
});

/**
 * REGRESSION (2026-09-17): a `reconnect-init` that arrives BEFORE the receiving side has processed
 * channel-open must be held and replayed, not dropped.
 *
 * THE WINDOW IS REAL AND IS NOT A TEST ARTIFACT. `PeerConnection.setupChannel` wires `onmessage`
 * synchronously, while `onopen` runs the Max-privacy relay gate, which AWAITS `getStats()` before
 * handing the channel to the SessionController. So the peer's first reconnect frame can land while we
 * are still inside that await. It used to hit `if (!rc.fps) return` and be discarded — and the sender
 * never resends, because it considers itself announced. Both sides then sat in `pairing` until the
 * 120 s deadline with NOTHING written to the dev log, which is what made this cost a full debugging
 * session: measured at roughly 1 CI engine-matrix night in 5, and ~4 failures in 8 local webkit runs,
 * but never reproducible on demand.
 *
 * `?gateDelayMs=N` (DEV-only, tree-shaken) widens that window on ONE side only, which turns the race
 * into a deterministic test. It stubs nothing else: the drop/hold decision, the replay, the deadline
 * and the state machine are all production code.
 *
 * Applied to the RESPONDER, because the responder is the side that must already be ready when the
 * initiator's announcement lands.
 */
test('reconnect-init arriving before channel-open is held, not dropped', async ({ browser }) => {
  const a = await openTab(browser); // creator → reconnect INITIATOR, announces immediately
  const b = await openTab(browser, 'gateDelayMs=3000'); // joiner → responder, deliberately late

  await enrollViaSas(a, b);
  await resetBoth(a, b);
  await startReconnect(a, b);

  // Against the old code both sides sit in `pairing` here until the 120 s deadline and then fail.
  await expect(a.getByTestId('status')).toHaveText('connected', { timeout: RECONNECT_ASSERT_TIMEOUT_MS });
  await expect(b.getByTestId('status')).toHaveText('connected', { timeout: RECONNECT_ASSERT_TIMEOUT_MS });
  await expect(a.getByTestId('auth-state')).toContainText('reconnect');
  await expect(b.getByTestId('auth-state')).toContainText('reconnect');

  // And it authenticated by the PIN, not by silently falling back to a fresh SAS comparison.
  await expect(b.locator('.hs-diag')).toContainText('holding reconnect-init');
  await expect(b.locator('.hs-diag')).toContainText('replaying held reconnect-init');
});

/**
 * REGRESSION (2026-09-18): the raw `pairingId` must NOT appear on the wire.
 *
 * A reconnect rendezvous is a plain 4-digit room — enumerable, bounded only by the server's per-IP
 * rate limit — so a code-guesser that wins the race reaches the open channel BEFORE any
 * authentication and used to be handed the initiator's `pairingId`: a stable per-pair identifier,
 * correlatable across sessions. It could never forge a proof, so this was linkability rather than an
 * auth break, which is exactly why it survived two audits as "small".
 *
 * The announcement is now `HMAC(pairingId, fp_min || fp_max)` truncated to the same length, so a
 * peer holding the pin recognises it by recomputing while a stranger sees bytes that differ every
 * session. This test reads the frames the DataChannel actually sent — asserting the crypto in a unit
 * test proves the tag differs from the id, not that the tag is what goes out.
 */
test('the raw pairingId never goes on the wire', async ({ browser }) => {
  const a = await openTab(browser);
  const b = await openTab(browser);

  await enrollViaSas(a, b);
  // The pinned pairingId, read from A's own diagnostics — the value that must NOT be announced.
  const pinnedId = (await a.getByTestId('pinned-peer-id').textContent())?.trim() ?? '';
  expect(pinnedId, 'enrollment should have pinned a pairingId').toMatch(/^[0-9a-f]{32}$/);

  // Capture every control frame A puts on the channel, from the test side.
  //
  // Patched with `evaluate` on the LIVE page, not `addInitScript`: the tab is already open, and an
  // init script only applies to pages loaded afterwards — `resetBoth` disposes the session but does
  // not reload. The reconnect builds a FRESH RTCPeerConnection, which is the one this catches.
  await a.evaluate(`
    (() => {
      window.__sentFrames = [];
      const Orig = window.RTCPeerConnection;
      const watch = (ch) => { const s = ch.send.bind(ch);
        ch.send = (d) => { if (typeof d === 'string') window.__sentFrames.push(d); return s(d); }; return ch; };
      window.RTCPeerConnection = function (...a) {
        const pc = new Orig(...a);
        const cdc = pc.createDataChannel.bind(pc);
        pc.createDataChannel = (...c) => watch(cdc(...c));
        pc.addEventListener('datachannel', (e) => watch(e.channel));
        return pc;
      };
      window.RTCPeerConnection.prototype = Orig.prototype;
    })();
  `);

  await resetBoth(a, b);
  await startReconnect(a, b);
  await expect(a.getByTestId('status')).toHaveText('connected', { timeout: RECONNECT_ASSERT_TIMEOUT_MS });
  await expect(b.getByTestId('status')).toHaveText('connected', { timeout: RECONNECT_ASSERT_TIMEOUT_MS });
  // It still authenticated by the PIN — the point is to hide the id, not to lose the feature.
  await expect(a.getByTestId('auth-state')).toContainText('reconnect');

  const frames = await a.evaluate(() => (window as unknown as { __sentFrames?: string[] }).__sentFrames ?? []);
  const init = frames.map((f) => { try { return JSON.parse(f); } catch { return null; } })
    .find((f) => f && f.kind === 'reconnect-init');
  expect(init, 'A should have announced itself with a reconnect-init').toBeTruthy();

  // THE ASSERTION. The announced value is present, the right shape, and NOT the pinned id.
  expect(init.pairingId).toMatch(/^[0-9a-f]{32}$/);
  expect(init.pairingId, 'the raw pairingId must not be announced').not.toBe(pinnedId);
  // And it appears nowhere else in anything A sent.
  expect(frames.join('|'), 'the pairingId must not leak in any other frame either').not.toContain(pinnedId);
});
