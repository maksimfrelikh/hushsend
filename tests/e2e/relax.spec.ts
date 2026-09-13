import { test, expect, type Browser, type Page, type BrowserContext } from '@playwright/test';
import { BASE, createLink, createWords, fragmentOf, pickWords } from './helpers';

// Every tab here holds a LIVE WebRTC connection: even after its signaling socket closes on connect,
// the PeerConnection keeps running ICE keepalives and DTLS. A context that is never closed therefore
// keeps working until the WORKER exits, not until the test ends, so they accumulate across the run.
// Measured 2026-09-13: a full chromium suite peaks at 31 browser processes, and on a 2-core CI runner
// that contention is what turns a 2-second reconnect into a 60-second timeout — the failure mode
// reconnect.spec.ts documented and fixed for itself. Same fix here. (See BACKLOG § Third pass.)
test.afterEach(async () => {
  await Promise.all(openContexts.splice(0).map((c) => c.close().catch(() => {})));
});

/**
 * E2E for the Max-privacy STRICT model (step 6d).
 *
 * Max-privacy NEVER relays — there is no consent escalation, no relay-retry. Each side drops the peer's
 * relay candidates and never requests TURN, so a direct connection that cannot come up is TERMINAL:
 *   - status goes to the EXISTING `failed` state (no hang, no new FSM state, no relay offer);
 *   - the FailedScreen surfaces a hint to switch to Reliable (which allows a server relay).
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
