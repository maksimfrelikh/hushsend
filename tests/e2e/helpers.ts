import { expect, type Page } from '@playwright/test';

/**
 * Shared e2e helpers for the REAL, status-driven screens (the dev harness is gone).
 *
 * Navigation reminders for the home flow (no URL router — local view state):
 *   - create paths live behind "Invite someone" → method picker: `invite-btn` then
 *     `create-words-btn` / `create-room-sas-btn`;
 *   - the words RECEIVE picker lives behind `enter-words-btn`;
 *   - join-by-code (`room-sas-input`) and reconnect (`reconnect-input` / per-device
 *     `create-reconnect-btn`) sit on the landing.
 *
 * The SAS confirmation is ASYMMETRIC "pick from 3 phrases":
 *   - the READER (creator) sees its phrase (`sas-words`) and reads it aloud; it has NO options, only
 *     a "my peer found it" confirm (`sas-reader-confirm`) and an abort (`sas-reader-abort`);
 *   - the PICKER (joiner) is BLIND — it has NO `sas-words`, only three look-alike options
 *     (`sas-option-N`) + confirm (`sas-confirm-btn`) / "none match" (`sas-nomatch-btn`).
 * In a real comparison the picker hears the reader; the e2e simulates that by reading the reader's
 * phrase (cross-page) and clicking the matching option on the (blind) picker.
 */

const norm = (s: string | null): string => (s ?? '').trim().replace(/\s+/g, ' ');

/** A creates a words session; returns the 5-word credential read from A's UI. */
export async function createWords(page: Page): Promise<string[]> {
  await page.getByTestId('invite-btn').click();
  await page.getByTestId('create-words-btn').click();
  await expect(page.getByTestId('status')).toHaveText('awaitingPeer', { timeout: 30_000 });
  const words = norm(await page.getByTestId('words').textContent()).split(' ').filter(Boolean);
  expect(words).toHaveLength(5);
  return words;
}

/** B reproduces a 5-word credential in the picker (type the word → click the narrowed match). */
export async function pickWords(page: Page, words: string[]): Promise<void> {
  await page.getByTestId('enter-words-btn').click();
  for (let i = 0; i < words.length; i++) {
    await page.getByTestId(`word-input-${i}`).fill(words[i]);
    // ≥3 chars narrows to the unique word (unique-3-char-prefix list); select it by exact name.
    await page.getByTestId(`word-pos-${i}`).getByRole('button', { name: words[i], exact: true }).click();
    await expect(page.getByTestId(`word-picked-${i}`)).toContainText(words[i]);
  }
  await page.getByTestId('words-join-btn').click();
}

/**
 * A creates a link (or qr) session; returns the full one-time link read from A's UI
 * (`<origin>/#<roomCode>.<S>`). Both create screens expose the link via the `link-url` mirror.
 */
export async function createLink(page: Page, kind: 'link' | 'qr' = 'link'): Promise<string> {
  await page.getByTestId('invite-btn').click();
  await page.getByTestId(kind === 'qr' ? 'create-qr-btn' : 'create-link-btn').click();
  await expect(page.getByTestId('status')).toHaveText('awaitingPeer', { timeout: 30_000 });
  const link = norm(await page.getByTestId('link-url').textContent());
  expect(link).toMatch(/#\d{4}\.[A-Za-z0-9_-]+$/);
  return link;
}

/** The `#<roomCode>.<S>` fragment of a link (what the joiner's page load consumes). */
export function fragmentOf(link: string): string {
  return link.slice(link.indexOf('#'));
}

/**
 * B joins a qr session via the scan screen's paste fallback (camera is impractical headlessly): open
 * the scan view and submit the decoded link — the SAME joinLinkSession('qr') path a real scan hits.
 */
export async function joinQrByPaste(page: Page, link: string): Promise<void> {
  await page.getByTestId('scan-qr-btn').click();
  await page.getByTestId('scan-paste-input').fill(link);
  await page.getByTestId('scan-paste-btn').click();
}

/** A creates a SAS room; returns the allocated 4-digit code read from A's UI. */
export async function createSasRoom(page: Page): Promise<string> {
  await page.getByTestId('invite-btn').click();
  await page.getByTestId('create-room-sas-btn').click();
  await expect(page.getByTestId('status')).toHaveText('awaitingPeer', { timeout: 30_000 });
  const code = norm(await page.getByTestId('room-code').textContent());
  expect(code).toMatch(/^\d{4}$/);
  return code;
}

/** B joins a SAS room by code (the join-by-code input on the landing). */
export async function joinSasRoom(page: Page, code: string): Promise<void> {
  await page.getByTestId('room-sas-input').fill(code);
  await page.getByTestId('join-room-sas-btn').click();
}

/**
 * Assert the asymmetric SAS choreography and return the reader's phrase:
 *   - the READER shows its 3-word phrase (`sas-words`);
 *   - the PICKER is BLIND (NO `sas-words`) and shows three options that INCLUDE the reader's phrase
 *     (proving both sides derived the same phrase via the channel binding).
 */
export async function expectSas(reader: Page, picker: Page): Promise<string> {
  await expect(reader.getByTestId('status')).toHaveText('awaitingSas', { timeout: 60_000 });
  await expect(picker.getByTestId('status')).toHaveText('awaitingSas', { timeout: 60_000 });
  const phrase = norm(await reader.getByTestId('sas-words').textContent());
  expect(phrase.split(' ').filter(Boolean)).toHaveLength(3); // 3 EFF short #2 words
  // the picker must NOT expose the real phrase anywhere — it is blind, only 3 look-alike options
  await expect(picker.getByTestId('sas-words')).toHaveCount(0);
  const opts = await Promise.all([0, 1, 2].map((i) => picker.getByTestId(`sas-option-${i}`).textContent()));
  expect(opts.map(norm)).toContain(phrase); // channel binding: picker derived the same phrase
  return phrase;
}

/**
 * Confirm the SAS the way a correct human pair does: the reader reads its phrase; the (blind) picker
 * selects the option matching what it hears, then both confirm. ok=true is sent on the picker only
 * because it selects the real phrase (sasSelectionOk); the reader confirms its peer found it.
 */
export async function confirmSas(reader: Page, picker: Page): Promise<void> {
  const phrase = await expectSas(reader, picker);
  let clicked = false;
  for (let i = 0; i < 3; i++) {
    if (norm(await picker.getByTestId(`sas-option-${i}`).textContent()) === phrase) {
      await picker.getByTestId(`sas-option-${i}`).click(); // picker identifies the heard phrase
      clicked = true;
      break;
    }
  }
  expect(clicked, "the reader's phrase must be one of the picker's three options").toBe(true);
  await reader.getByTestId('sas-reader-confirm').click();
  await picker.getByTestId('sas-confirm-btn').click();
}
