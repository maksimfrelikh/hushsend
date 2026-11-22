import { test, expect, type Browser, type Page, type BrowserContext } from '@playwright/test';
import { BASE, createLink, createWords, fragmentOf, joinQrByPaste, pickWords } from './helpers';

// Every tab here holds a LIVE WebRTC connection: even after its signaling socket closes on connect,
// the PeerConnection keeps running ICE keepalives and DTLS. A context that is never closed therefore
// keeps working until the WORKER exits, not until the test ends, so they accumulate across the run.
// Measured 2026-09-13: a full chromium suite peaks at 31 browser processes, and on a 2-core CI runner
// that contention is what turns a 2-second reconnect into a 60-second timeout — the failure mode
// reconnect.spec.ts documented and fixed for itself. Same fix here. (See docs/history/security-audits.md, "Reconnect stalled at `pairing` for 120 s".)
test.afterEach(async () => {
  await Promise.all(openContexts.splice(0).map((c) => c.close().catch(() => {})));
});

/**
 * E2E for the Max-privacy STRICT model (step 6d).
 *
 * Max-privacy NEVER relays — there is no consent escalation, no relay-retry. Each side drops the peer's
 * relay candidates and never requests TURN, so a direct connection that cannot come up is TERMINAL:
 *   - status goes to the EXISTING `failed` state (no hang, no new FSM state, no relay offer);
 *   - the FailedScreen surfaces a hint to switch to Reliable (which allows a server relay), and
 *     "Retry with relay": the failed session ends there, and a NEW pairing starts in Reliable.
 *
 * The `?forceIceFail=1` DEV knob makes each tab treat ICE as failed AND suppress its own candidates, so
 * no real loopback path forms and the failure runs deterministically without a network failure.
 * Isolated contexts (own localStorage/IndexedDB) per tab.
 */


/** Contexts opened by the current test, closed after it — see the afterEach below. */
const openContexts: BrowserContext[] = [];

async function openTab(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE });
  openContexts.push(context);
  const page = await context.newPage();
  await page.goto(`${BASE}/?forceIceFail=1`);
  return page;
}

/** The strict model only applies in Max-privacy — assert the (default) toggle is ON. */
async function expectMaxPrivacy(page: Page): Promise<void> {
  await expect(page.getByTestId('privacy-toggle')).toHaveAttribute('aria-checked', 'true');
}

test('max-privacy · a direct ICE failure fails terminally with a switch-to-Reliable hint (no relay, no hang)', async ({
  browser,
}) => {
  const sender = await openTab(browser);
  const receiver = await openTab(browser);
  await expectMaxPrivacy(sender);
  await expectMaxPrivacy(receiver);

  const words = await createWords(sender);
  await pickWords(receiver, words);

  // ICE can't connect (forced). Max-privacy is STRICT — no relay, no escalation offer — so the
  // failure is TERMINAL: both sides land in the existing `failed` state (no hang).
  await expect(sender.getByTestId('status')).toHaveText('failed', { timeout: 60_000 });
  await expect(receiver.getByTestId('status')).toHaveText('failed', { timeout: 60_000 });

  // The FailedScreen surfaces the hint to switch to Reliable (which permits a server relay).
  await expect(sender.getByTestId('direct-fail-hint')).toBeVisible();
  await expect(sender.getByTestId('direct-fail-hint')).toContainText(/Reliable/i);

  // The relay-escalation UI no longer exists (strict model — no consent-gated relay).
  await expect(sender.getByTestId('relax-offer')).toHaveCount(0);
  await expect(sender.getByTestId('relax-accept')).toHaveCount(0);
});

/**
 * The REFUSAL branch of the Max-privacy relay gate (audit 2026-09-12).
 *
 * Dropping the peer's signalled `typ relay` candidates is not enough on its own: ICE also LEARNS
 * candidates from incoming connectivity checks, so a peer relaying through TURN can have us pair
 * with its relayed address as a PEER-REFLEXIVE candidate. The gate therefore verifies the path we
 * actually got, at channel-open, BEFORE `onOpen` reaches the SessionController — so a relayed path
 * is refused with no byte crossing it.
 *
 * Reproducing that for real needs a relaying peer AND a failed direct path — a cross-network setup
 * no loopback test can build — so `?forceRelayPath=1` stubs the VERDICT and nothing else: the
 * refusal, the teardown and the reason the user sees are all the production path.
 */
/**
 * One tab, ONE navigation. Navigating again to the same path+query with only a different #fragment is
 * a same-document navigation — the page does not reload, so the link-fragment join handler never
 * re-runs and the joiner silently never joins. Pass the final URL, fragment included.
 */
async function openRelayGatedTab(browser: Browser, url: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE });
  openContexts.push(context);
  const page = await context.newPage();
  await page.goto(`${BASE}${url}`);
  return page;
}

test('max-privacy · a relayed path is refused at channel-open — terminal, with the switch-to-Reliable hint', async ({
  browser,
}) => {
  // Only the RECEIVER treats its path as relayed; the sender's gate passes normally. That asymmetry
  // is deliberate — it is what a mixed-privacy pair looks like when the relay belongs to the peer.
  const sender = await openRelayGatedTab(browser, '/?forceBlob=1');
  await expectMaxPrivacy(sender);

  const link = await createLink(sender, 'link');
  const receiver = await openRelayGatedTab(browser, `/?forceBlob=1&forceRelayPath=1${fragmentOf(link)}`);

  // The refusing side lands in the EXISTING terminal state with the hint that names the way out.
  await expect(receiver.getByTestId('status')).toHaveText('failed', { timeout: 60_000 });
  await expect(receiver.getByTestId('direct-fail-hint')).toBeVisible();

  // The other side does not hang waiting for a peer that tore itself down.
  await expect(sender.getByTestId('status')).toHaveText('failed', { timeout: 60_000 });

  // NOT ONE BYTE crossed: the transfer UI renders only at `connected`, so its absence is structural.
  for (const page of [sender, receiver]) {
    await expect(page.getByTestId('file-input')).toHaveCount(0);
    await expect(page.getByTestId('transfer-phase')).toHaveCount(0);
  }
});

test('max-privacy · a NON-relayed path is not refused (the gate does not break honest connections)', async ({
  browser,
}) => {
  // The control for the test above. A gate that refused everything would pass that test too, so the
  // same pairing without the knob must still reach an authenticated connection.
  const sender = await openRelayGatedTab(browser, '/?forceBlob=1');
  const link = await createLink(sender, 'link');
  const receiver = await openRelayGatedTab(browser, `/?forceBlob=1${fragmentOf(link)}`);

  await expect(sender.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(receiver.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(receiver.getByTestId('auth-state')).toContainText('authenticated');
});

/** Turn the simulated ICE failure on or off for PeerConnections this tab builds from now on (the same
 *  knob as `?forceIceFail=1`, without a reload — so one tab can fail in Max and then connect). */
async function forceIceFail(page: Page, on: boolean): Promise<void> {
  await page.evaluate((v) => {
    (window as unknown as { __HUSHSEND_FORCE_ICE_FAIL__: boolean }).__HUSHSEND_FORCE_ICE_FAIL__ = v;
  }, on);
}

test('max-privacy · "Retry with relay" starts over in Reliable for this visit, and the pair connects', async ({
  browser,
}) => {
  const sender = await openRelayGatedTab(browser, '/?forceBlob=1');
  const receiver = await openRelayGatedTab(browser, '/?forceBlob=1');
  await forceIceFail(sender, true);
  await forceIceFail(receiver, true);

  const firstLink = await createLink(sender, 'qr');
  await joinQrByPaste(receiver, firstLink);
  for (const page of [sender, receiver]) {
    await expect(page.getByTestId('status')).toHaveText('failed', { timeout: 60_000 });
    // The copy names the half one tap cannot do: the peer has to be in Reliable too.
    await expect(page.getByTestId('direct-fail-hint')).toContainText(/Your peer has to switch to Reliable too/);
    await expect(page.getByTestId('retry-relay-btn')).toBeVisible();
    await forceIceFail(page, false);
  }

  // Whoever made the invite gets a new one — nothing of the failed session is reused.
  await sender.getByTestId('retry-relay-btn').click();
  await expect(sender.getByTestId('status')).toHaveText('awaitingPeer', { timeout: 30_000 });
  await expect(sender.getByTestId('link-url')).not.toHaveText(firstLink);
  const secondLink = (await sender.getByTestId('link-url').textContent())!.trim();

  // A joiner cannot restart alone: home, with Reliable selected.
  await receiver.getByTestId('retry-relay-btn').click();
  await expect(receiver.getByTestId('status')).toHaveText('idle');
  await expect(receiver.getByTestId('privacy-reliable')).toHaveAttribute('aria-checked', 'true');

  await joinQrByPaste(receiver, secondLink);
  for (const page of [sender, receiver]) {
    await expect(page.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
    await expect(page.getByTestId('ice-mode')).toHaveText('reliable');
    await expect(page.getByTestId('ice-relay')).toHaveText('true');
    // For this visit only: the stored mode is still whatever the user chose on the home screen.
    expect(await page.evaluate(() => localStorage.getItem('hushsend.privacy'))).toBeNull();
  }
  await receiver.reload();
  await expectMaxPrivacy(receiver);
});

test('mixed pair · the Reliable side is told to ask its peer to switch, not "channel closed"', async ({
  browser,
}) => {
  // Max ↔ Reliable with no direct path: the Max side drops relay candidates, so the Reliable side's
  // ICE fails although it holds a relay. Both sides must end on copy that names the way out.
  const sender = await openTab(browser);
  const receiver = await openTab(browser);
  await sender.getByTestId('privacy-reliable').click();
  await expect(sender.getByTestId('privacy-reliable')).toHaveAttribute('aria-checked', 'true');
  await expectMaxPrivacy(receiver);

  const link = await createLink(sender, 'qr');
  await joinQrByPaste(receiver, link);

  await expect(sender.getByTestId('status')).toHaveText('failed', { timeout: 60_000 });
  await expect(receiver.getByTestId('status')).toHaveText('failed', { timeout: 60_000 });
  await expect(sender.getByTestId('no-relay-path-hint')).toContainText(/ask them to switch to Reliable too/);
  // Reliable already: there is no mode left to retry in.
  await expect(sender.getByTestId('retry-relay-btn')).toHaveCount(0);
  await expect(receiver.getByTestId('direct-fail-hint')).toBeVisible();
  await expect(receiver.getByTestId('retry-relay-btn')).toBeVisible();
});

