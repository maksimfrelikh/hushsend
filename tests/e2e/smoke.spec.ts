import { test, expect, type Browser, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWords, pickWords, createSasRoom, joinSasRoom, confirmSas } from './helpers';

/**
 * Smoke coverage for each REAL screen flow (home → method/join → connected), driven through the
 * shipped status-driven UI (not a harness). Kept light: each test proves the flow reaches an
 * AUTHENTICATED `connected` via its own path, and the words flow also pushes a small file end to
 * end. The deeper assertions (mismatch / timeout / rate-limit / key-changed / large files /
 * persistence) live in the per-feature suites; this file guards the happy real-screen paths.
 */

const BASE = 'http://localhost:5173';
const TMP = join(process.cwd(), 'e2e-tmp-smoke');

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function openIsolatedTab(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE, acceptDownloads: true });
  const page = await context.newPage();
  await page.goto(`${BASE}/?forceBlob=1`);
  return page;
}

test.beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

test('smoke · words: home → create → pick 5 words → connected → small file transfers intact', async ({
  context,
}) => {
  const sender = await context.newPage();
  await sender.goto('/?forceBlob=1');
  const words = await createWords(sender);

  const receiver = await context.newPage();
  await receiver.goto('/?forceBlob=1');
  await pickWords(receiver, words);

  await expect(sender.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(receiver.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(sender.getByTestId('auth-state')).toContainText('authenticated');

  const src = join(TMP, 'smoke.bin');
  const payload = randomBytes(64 * 1024);
  writeFileSync(src, payload);
  await sender.getByTestId('file-input').setInputFiles(src);
  await sender.getByTestId('send-btn').click();
  await expect(receiver.getByTestId('transfer-phase')).toContainText('offered');

  const downloadPromise = receiver.waitForEvent('download', { timeout: 60_000 });
  await receiver.getByTestId('accept-btn').click();
  const download = await downloadPromise;
  const out = join(TMP, 'smoke.out');
  await download.saveAs(out);
  await expect(sender.getByTestId('transfer-phase')).toContainText('done', { timeout: 30_000 });
  await expect(receiver.getByTestId('transfer-phase')).toContainText('done', { timeout: 30_000 });
  expect(sha256(readFileSync(out))).toBe(sha256(payload));
});

test('smoke · room: home → invite → SAS room → join → pick the real phrase → authenticated connected', async ({
  context,
}) => {
  const a = await context.newPage();
  await a.goto('/?forceBlob=1');
  const code = await createSasRoom(a);

  const b = await context.newPage();
  await b.goto('/?forceBlob=1');
  await joinSasRoom(b, code);

  await confirmSas(a, b); // a = reader (creator), b = blind picker (joiner)

  await expect(a.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(b.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(a.getByTestId('auth-state')).toContainText('SAS');
});

test('smoke · reconnect: enrolled peers re-auth via the pinned key with NO SAS → connected', async ({ browser }) => {
  // Separate contexts → distinct identities / keystores (a real two-device pairing).
  const a = await openIsolatedTab(browser);
  const b = await openIsolatedTab(browser);

  // First connect (SAS room) so each side pins the other's identity.
  const code = await createSasRoom(a);
  await joinSasRoom(b, code);
  await confirmSas(a, b); // a = reader (creator), b = blind picker (joiner)
  await expect(a.getByTestId('pinned-peer-pubkey')).toHaveText(/^[0-9a-f]{64}$/, { timeout: 30_000 });
  await expect(b.getByTestId('pinned-peer-pubkey')).toHaveText(/^[0-9a-f]{64}$/, { timeout: 30_000 });

  // Back to idle, then reconnect using the stored pins — the home shows the recent device.
  await a.getByTestId('reset-btn').click();
  await b.getByTestId('reset-btn').click();
  await expect(a.getByTestId('status')).toHaveText('idle');
  await expect(b.getByTestId('status')).toHaveText('idle');

  await a.getByTestId('create-reconnect-btn').click();
  await expect(a.getByTestId('status')).toHaveText('awaitingPeer', { timeout: 30_000 });
  const reCode = (await a.getByTestId('room-code').textContent())?.trim() ?? '';
  expect(reCode).toMatch(/^\d{4}$/);
  await b.getByTestId('reconnect-input').fill(reCode);
  await b.getByTestId('join-reconnect-btn').click();

  await expect(a.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(b.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(a.getByTestId('auth-state')).toContainText('reconnect');
});
