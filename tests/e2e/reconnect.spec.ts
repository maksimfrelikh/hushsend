import { test, expect, type Browser, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSasRoom, joinSasRoom, confirmSas } from './helpers';

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

const BASE = 'http://localhost:5173';
const TMP = join(process.cwd(), 'e2e-tmp-reconnect');

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Open one isolated context+page (own IndexedDB → its own identity), forcing the Blob receive
 *  path. `extraQuery` enables a DEV knob on this tab (e.g. `forgeReconnectKey=1`). */
async function openTab(browser: Browser, extraQuery = ''): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE, acceptDownloads: true });
  const page = await context.newPage();
  await page.goto(`${BASE}/?forceBlob=1${extraQuery ? `&${extraQuery}` : ''}`);
  return page;
}

/** Drive A (creator) + B (joiner) through a SAS room to an authenticated connected, so enrollment
 *  pins each other's identity under a shared pairingId. Leaves both at `connected`. */
async function enrollViaSas(a: Page, b: Page): Promise<void> {
  const code = await createSasRoom(a);
  await joinSasRoom(b, code);

  // Asymmetric SAS: A (creator) READS its phrase; B (joiner) is the BLIND picker → both confirm →
  // authenticated connected → enrollment pins.
  await confirmSas(a, b);
  await expect(a.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(b.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });

  // Enrollment pinned the peer on both sides (each holds the other's 32-byte key under a pairingId).
  await expect(a.getByTestId('pinned-peer-pubkey')).toHaveText(/^[0-9a-f]{64}$/, { timeout: 30_000 });
  await expect(b.getByTestId('pinned-peer-pubkey')).toHaveText(/^[0-9a-f]{64}$/, { timeout: 30_000 });
}

/** Dispose both sessions back to `idle` so a fresh reconnect can start. The keystore pins PERSIST
 *  in IndexedDB across dispose (only the per-session state resets), which is exactly what reconnect
 *  reads from. */
async function resetBoth(a: Page, b: Page): Promise<void> {
  await a.getByTestId('reset-btn').click();
  await b.getByTestId('reset-btn').click();
  await expect(a.getByTestId('status')).toHaveText('idle');
  await expect(b.getByTestId('status')).toHaveText('idle');
}

/** A starts a reconnect (allocates a fresh room, announces its stored pairingId); B joins by code.
 *  Returns once B has joined. */
async function startReconnect(a: Page, b: Page): Promise<void> {
  await a.getByTestId('create-reconnect-btn').click();
  await expect(a.getByTestId('status')).toHaveText('awaitingPeer', { timeout: 30_000 });
  const code = (await a.getByTestId('room-code').textContent())?.trim() ?? '';
  expect(code).toMatch(/^\d{4}$/);
  await b.getByTestId('reconnect-input').fill(code);
  await b.getByTestId('join-reconnect-btn').click();
}

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
  await expect(a.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(b.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
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

  const downloadPromise = b.waitForEvent('download', { timeout: 60_000 });
  await b.getByTestId('accept-btn').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('note.bin');
  const out = join(TMP, 'note.out');
  await download.saveAs(out);
  await expect(a.getByTestId('transfer-phase')).toContainText('done', { timeout: 30_000 });
  await expect(b.getByTestId('transfer-phase')).toContainText('done', { timeout: 30_000 });
  expect(sha256(readFileSync(out))).toBe(srcHash);
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
  await expect(a.getByTestId('status')).toHaveText('failed', { timeout: 60_000 });
  await expect(a.getByTestId('key-changed')).toBeVisible();
  await expect(a.getByTestId('error')).toContainText('key changed');
  await expect(b.getByTestId('status')).toHaveText('failed', { timeout: 60_000 });

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
