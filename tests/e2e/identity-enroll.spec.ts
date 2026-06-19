import { test, expect, type Browser, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Step-4b-i TOFU enrollment, end to end. Two tabs connect via the "words" method (CPace +
 * key-confirmation → authenticated `connected`); on entering `connected` they exchange and PIN
 * each other's long-term Ed25519 identity over the DataChannel. We assert:
 *   - each side ends with `pairingId → peer pubkey` (the pinned peer projection, written right
 *     after the keystore put), under the SAME pairingId, cross-matching the peers' own pubkeys;
 *   - file transfer still works (enrollment didn't gate or break the channel);
 *   - the identity SURVIVES a tab reload (same pubkey — IndexedDB-persisted).
 *
 * The two tabs use SEPARATE browser contexts so each has its OWN IndexedDB → DISTINCT identities
 * (two tabs in one context would share storage, i.e. one identity). Reconnect-via-pin is 4b-ii
 * and is NOT tested here.
 */

const BASE = 'http://localhost:5173';
const TMP = join(process.cwd(), 'e2e-tmp-identity');

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Wait for the harness to surface our own 32-byte (64-hex) identity pubkey, and return it. */
async function readOwnPubkey(page: Page): Promise<string> {
  const loc = page.getByTestId('own-pubkey');
  await expect(loc).toHaveText(/^[0-9a-f]{64}$/, { timeout: 30_000 });
  return (await loc.textContent())!.trim();
}

/** B reproduces a 5-word credential in the picker (type the word → click the narrowed match). */
async function pickWords(page: Page, words: string[]): Promise<void> {
  for (let i = 0; i < words.length; i++) {
    await page.getByTestId(`word-input-${i}`).fill(words[i]);
    await page.getByTestId(`word-pos-${i}`).getByRole('button', { name: words[i], exact: true }).click();
    await expect(page.getByTestId(`word-picked-${i}`)).toContainText(words[i]);
  }
  await page.getByTestId('words-join-btn').click();
}

/** Open one isolated context+page (own IndexedDB), pointed at the Blob receive path. */
async function openTab(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE, acceptDownloads: true });
  const page = await context.newPage();
  await page.goto(`${BASE}/?forceBlob=1`);
  return page;
}

test.beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

test('words connect → both sides pin the peer identity (same pairingId); transfer intact; identity survives reload', async ({
  browser,
}) => {
  const a = await openTab(browser);
  const b = await openTab(browser);

  // Distinct identities (separate IndexedDB per context).
  const aPub = await readOwnPubkey(a);
  const bPub = await readOwnPubkey(b);
  expect(aPub).not.toBe(bPub);

  // A creates a words session; B reproduces the 5 words and joins.
  await a.getByTestId('create-words-btn').click();
  await expect(a.getByTestId('status')).toHaveText('awaitingPeer', { timeout: 30_000 });
  const words = ((await a.getByTestId('words').textContent())?.trim() ?? '').split(/\s+/).filter(Boolean);
  expect(words).toHaveLength(5);
  await pickWords(b, words);

  // Both reach an AUTHENTICATED connected (CPace + key-confirmation).
  await expect(a.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(b.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });

  // Enrollment ran over the authenticated channel: each side pinned the OTHER's identity.
  await expect(a.getByTestId('pinned-peer-pubkey')).toHaveText(bPub, { timeout: 30_000 });
  await expect(b.getByTestId('pinned-peer-pubkey')).toHaveText(aPub, { timeout: 30_000 });

  // Same key-independent pairingId on both sides (16 bytes → 32 hex).
  const pairA = (await a.getByTestId('pinned-peer-id').textContent())!.trim();
  const pairB = (await b.getByTestId('pinned-peer-id').textContent())!.trim();
  expect(pairA).toMatch(/^[0-9a-f]{32}$/);
  expect(pairA).toBe(pairB);

  // File transfer still works (enrollment did not gate `connected` or block bytes).
  const src = join(TMP, 'note.bin');
  const payload = randomBytes(200 * 1024);
  writeFileSync(src, payload);
  const srcHash = sha256(payload);

  await a.getByTestId('file-input').setInputFiles(src);
  await a.getByTestId('send-btn').click();
  await expect(b.getByTestId('transfer-phase')).toContainText('offered');

  const downloadPromise = b.waitForEvent('download', { timeout: 60_000 });
  await b.getByTestId('accept-btn').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('note.bin');
  const out = join(TMP, 'note.out');
  await download.saveAs(out);
  await expect(a.getByTestId('transfer-phase')).toContainText('done', { timeout: 30_000 });
  await expect(b.getByTestId('transfer-phase')).toContainText('done', { timeout: 30_000 });
  expect(sha256(readFileSync(out))).toBe(srcHash);

  // Identity persists across a tab reload (same pubkey — IndexedDB-backed).
  await a.reload();
  await expect(a.getByTestId('own-pubkey')).toHaveText(aPub, { timeout: 30_000 });
});
