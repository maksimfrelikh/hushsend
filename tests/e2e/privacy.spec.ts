import { test, expect, type Browser, type Page } from '@playwright/test';
import { createWords, pickWords } from './helpers';

/**
 * E2E for the privacy toggle + TURN relay (step 6d, client side).
 *
 * The home "Max privacy" toggle is now FUNCTIONAL and drives the WebRTC iceServers:
 *   - Max-privacy (DEFAULT, switch ON): direct-only — STUN at most, NEVER a TURN relay, and the
 *     client never even requests creds. Existing flows are unchanged (they connect over loopback).
 *   - Reliable (switch OFF): the client requests short-lived coturn creds via `turn-request` and
 *     assembles a TURN iceServer from them, so a pair that can't connect directly can relay.
 *
 * We assert the toggle renders + flips, that Max-privacy still connects directly (no TURN), and that
 * Reliable fetches creds and builds a correct TURN entry. We do NOT run an actual relay (no coturn) —
 * both modes connect over loopback host candidates; the TURN URL in the test env is a placeholder.
 * The ICE config the PeerConnection was built with is read from the DEV diagnostics strip.
 *
 * Isolated contexts (own localStorage) per tab so the persisted pref is set explicitly per side and
 * doesn't bleed across tests.
 */

const BASE = 'http://localhost:5173';

async function openIsolatedTab(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE });
  const page = await context.newPage();
  await page.goto(`${BASE}/?forceBlob=1`);
  return page;
}

/** Read the toggle's current state (aria-checked: true = Max-privacy ON, false = Reliable). */
async function isMaxPrivacy(page: Page): Promise<boolean> {
  return (await page.getByTestId('privacy-toggle').getAttribute('aria-checked')) === 'true';
}

/** Set the privacy toggle to the desired mode on the landing screen (idempotent). */
async function setPrivacy(page: Page, mode: 'max' | 'reliable'): Promise<void> {
  const wantMax = mode === 'max';
  if ((await isMaxPrivacy(page)) !== wantMax) await page.getByTestId('privacy-toggle').click();
  await expect(page.getByTestId('privacy-toggle')).toHaveAttribute('aria-checked', String(wantMax));
}

test('privacy · toggle renders, defaults to Max-privacy, and flips both ways', async ({ browser }) => {
  const page = await openIsolatedTab(browser);
  // Default is Max-privacy (switch ON / aria-checked true).
  await expect(page.getByTestId('privacy-toggle')).toHaveAttribute('aria-checked', 'true');
  // Flip to Reliable, then back to Max — the switch tracks both ways, and the description follows.
  await page.getByTestId('privacy-toggle').click();
  await expect(page.getByTestId('privacy-toggle')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('privacy-desc')).toContainText('relay');
  await page.getByTestId('privacy-toggle').click();
  await expect(page.getByTestId('privacy-toggle')).toHaveAttribute('aria-checked', 'true');
});

test('privacy · Max-privacy connects DIRECTLY — no TURN, no relay (existing flow unchanged)', async ({
  browser,
}) => {
  const sender = await openIsolatedTab(browser);
  const receiver = await openIsolatedTab(browser);
  await setPrivacy(sender, 'max');
  await setPrivacy(receiver, 'max');

  const words = await createWords(sender);
  await pickWords(receiver, words);

  await expect(sender.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(receiver.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });

  // The PeerConnection was built direct-only: Max-privacy mode, no relay, no TURN entry.
  await expect(sender.getByTestId('ice-mode')).toHaveText('max');
  await expect(sender.getByTestId('ice-relay')).toHaveText('false');
  await expect(sender.getByTestId('ice-turn-urls')).toHaveText('');
  await expect(sender.getByTestId('ice-turn-username')).toHaveText('');
});

test('reliable · fetches coturn creds via turn-request and builds a TURN iceServer', async ({ browser }) => {
  const sender = await openIsolatedTab(browser);
  const receiver = await openIsolatedTab(browser);
  // Reliable on the sender (the side we assert); the receiver may be either — both connect over
  // loopback host candidates regardless (we never run an actual relay).
  await setPrivacy(sender, 'reliable');
  await setPrivacy(receiver, 'reliable');

  const words = await createWords(sender);
  await pickWords(receiver, words);

  await expect(sender.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(receiver.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });

  // The sender requested creds and assembled a TURN iceServer from the server's reply: Reliable mode,
  // relay added, the configured TURN url, and a NON-empty username + credential (the per-session HMAC
  // creds the server minted — proving the client wired {urls, username, credential} correctly).
  await expect(sender.getByTestId('ice-mode')).toHaveText('reliable');
  await expect(sender.getByTestId('ice-relay')).toHaveText('true');
  await expect(sender.getByTestId('ice-turn-urls')).toContainText('turn:turn.example.org:3478');
  await expect(sender.getByTestId('ice-turn-username')).not.toHaveText('');
  await expect(sender.getByTestId('ice-turn-credential')).not.toHaveText('');
});
