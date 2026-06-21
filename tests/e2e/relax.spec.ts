import { test, expect, type Browser, type Page } from '@playwright/test';
import { createWords, pickWords } from './helpers';

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

const BASE = 'http://localhost:5173';

async function openTab(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE });
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
