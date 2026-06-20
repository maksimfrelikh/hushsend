import { test, expect, type Browser, type Page } from '@playwright/test';
import { createWords, pickWords } from './helpers';

/**
 * E2E for relax-retry — the Max-privacy STRICT model (step 6d, final piece).
 *
 * Max-privacy NEVER relays without consent: each side drops the peer's relay candidates and, when ICE
 * cannot connect, OFFERS a relay escalation instead of hard-failing. The relay path forms only once
 * BOTH sides relax (self-enforcing bilateral). We assert:
 *   - a Max-privacy ICE failure surfaces the relay offer (status stays `pairing`);
 *   - DECLINE → `failed` (we'd rather not connect than relay without consent);
 *   - ACCEPT sends the relax SIGNAL to the peer (the peer records `peerRelaxed`).
 *
 * The `?forceIceFail=1` DEV knob makes each tab treat ICE as failed AND suppress its own candidates,
 * so no real loopback path forms and the flow runs deterministically without a network failure. We do
 * NOT bring up an actual relay (no coturn) — a relay connecting end-to-end is a DEPLOY-time concern,
 * verified there. Isolated contexts (own localStorage/IndexedDB) per tab.
 */

const BASE = 'http://localhost:5173';

async function openTab(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE });
  const page = await context.newPage();
  await page.goto(`${BASE}/?forceIceFail=1`);
  return page;
}

/** The relax strict model only applies in Max-privacy — assert the (default) toggle is ON. */
async function expectMaxPrivacy(page: Page): Promise<void> {
  await expect(page.getByTestId('privacy-toggle')).toHaveAttribute('aria-checked', 'true');
}

test('relax · Max-privacy ICE failure offers a relay; decline → failed', async ({ browser }) => {
  const sender = await openTab(browser);
  const receiver = await openTab(browser);
  await expectMaxPrivacy(sender);
  await expectMaxPrivacy(receiver);

  const words = await createWords(sender);
  await pickWords(receiver, words);

  // ICE can't connect (forced) → we stay in `pairing` (no new FSM state) and the relay offer surfaces.
  await expect(sender.getByTestId('status')).toHaveText('pairing', { timeout: 60_000 });
  await expect(sender.getByTestId('relax-offer')).toBeVisible({ timeout: 60_000 });
  await expect(sender.getByTestId('relax-available')).toHaveText('true');
  await expect(sender.getByTestId('relax-local')).toHaveText('false'); // not relayed without consent

  // Decline → Max-privacy would rather not connect than relay → terminal failure.
  await sender.getByTestId('relax-decline').click();
  await expect(sender.getByTestId('status')).toHaveText('failed', { timeout: 30_000 });
});

test('relax · accepting relay sends the relax signal to the peer (peerRelaxed) — relay itself is deploy-verified', async ({
  browser,
}) => {
  const sender = await openTab(browser);
  const receiver = await openTab(browser);
  await expectMaxPrivacy(sender);
  await expectMaxPrivacy(receiver);

  const words = await createWords(sender);
  await pickWords(receiver, words);

  // Both sides offer relay (both forced ICE failures).
  await expect(sender.getByTestId('relax-offer')).toBeVisible({ timeout: 60_000 });
  await expect(receiver.getByTestId('relax-offer')).toBeVisible({ timeout: 60_000 });

  // Sender accepts → relax signal traverses signaling to the receiver, which records peerRelaxed.
  await sender.getByTestId('relax-accept').click();
  await expect(sender.getByTestId('relax-local')).toHaveText('true', { timeout: 30_000 });
  await expect(receiver.getByTestId('relax-peer')).toHaveText('true', { timeout: 30_000 });
  // The receiver hasn't accepted, so the relay has NOT formed (still filtering) — no `connected`.
  await expect(receiver.getByTestId('relax-local')).toHaveText('false');
  await expect(sender.getByTestId('status')).not.toHaveText('connected');
});
