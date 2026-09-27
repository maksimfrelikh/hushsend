import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLink, forwardConsole, fragmentOf } from './helpers';

/**
 * Receiving to DISK with no dialog (owner's rule, 2026-09-27; src/core/transfer/opfs.ts): the file is
 * streamed into the site's private storage (OPFS) and, once complete, handed to the browser as an
 * ordinary download read from disk. No `forceBlob` here — this is the path a real receiver takes.
 *
 *   - the bytes survive the trip through site storage;
 *   - a page that is HIDDEN when the file completes (iOS drops a download started then) holds it and
 *     shows "Save file" — the tap hands it over.
 *
 * Skipped on an engine build whose site storage cannot write (the app falls back to RAM, which the
 * other suites cover with `forceBlob`).
 */

const TMP = join(process.cwd(), 'e2e-tmp-receive-disk');
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

test.beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});
test.afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

async function pair(context: BrowserContext): Promise<{ sender: Page; receiver: Page }> {
  const sender = await context.newPage();
  forwardConsole(sender, 'sender');
  await sender.goto('/');
  const link = await createLink(sender, 'link');
  const receiver = await context.newPage();
  forwardConsole(receiver, 'receiver');
  await receiver.goto(`/${fragmentOf(link)}`);
  await expect(sender.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(receiver.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  // Having the API is not enough: Playwright's WebKit exposes OPFS and fails the first write (the app
  // then falls back to RAM, which the other suites cover) — so probe a real write, as the app does.
  const opfs = await receiver.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const h = await root.getFileHandle('.e2e-probe', { create: true });
      const w = await h.createWritable();
      await w.write(new Uint8Array(1));
      await w.close();
      await root.removeEntry('.e2e-probe');
      return true;
    } catch {
      return false;
    }
  });
  test.skip(!opfs, 'this engine build cannot write to site storage');
  return { sender, receiver };
}

async function incomingCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('incoming');
      let n = 0;
      for await (const _ of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) n++;
      return n;
    } catch {
      return 0;
    }
  });
}

test('a file goes through site storage with no dialog and arrives intact as a download', async ({
  context,
}) => {
  const { sender, receiver } = await pair(context);
  const payload = randomBytes(8 * 1024 * 1024);
  const src = join(TMP, 'disk.bin');
  writeFileSync(src, payload);

  await sender.getByTestId('file-input').setInputFiles(src);
  await sender.getByTestId('send-btn').click();
  await expect(receiver.getByTestId('transfer-phase')).toContainText('offered');
  const downloadPromise = receiver.waitForEvent('download', { timeout: 60_000 });
  await receiver.getByTestId('accept-btn').click(); // no picker: nothing to click through
  const download = await downloadPromise;
  const out = join(TMP, 'disk.out');
  await download.saveAs(out);

  await expect(receiver.getByTestId('transfer-phase')).toContainText('done');
  // "Delivered" only after the receiver confirmed (the `received` control).
  await expect(sender.getByTestId('transfer-phase')).toContainText('done', { timeout: 30_000 });
  expect(sha256(readFileSync(out))).toBe(sha256(payload));
  // Held in site storage while the browser reads it into the download (OPFS_HOLD_MS), not longer.
  expect(await incomingCount(receiver)).toBe(1);
});

test('a page that is hidden when the file completes holds it and asks for a tap — "Save file"', async ({
  context,
}) => {
  const { sender, receiver } = await pair(context);
  const payload = randomBytes(2 * 1024 * 1024);
  const src = join(TMP, 'hidden.bin');
  writeFileSync(src, payload);

  await sender.getByTestId('file-input').setInputFiles(src);
  await sender.getByTestId('send-btn').click();
  await expect(receiver.getByTestId('transfer-phase')).toContainText('offered');
  await receiver.getByTestId('accept-btn').click();
  // The screen locks / another app comes to the front before the last byte.
  await receiver.evaluate(() =>
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }),
  );
  let early = 0;
  receiver.on('download', () => early++);
  await expect(receiver.getByTestId('transfer-phase')).toContainText('done', { timeout: 60_000 });
  await expect(receiver.getByTestId('save-file-btn')).toBeVisible();
  expect(early, 'no download may start while the page is hidden').toBe(0);

  // Back in front: the tap hands it over, in a real user gesture.
  await receiver.evaluate(() =>
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    }),
  );
  const downloadPromise = receiver.waitForEvent('download', { timeout: 30_000 });
  await receiver.getByTestId('save-file-btn').click();
  const out = join(TMP, 'hidden.out');
  await (await downloadPromise).saveAs(out);
  expect(sha256(readFileSync(out))).toBe(sha256(payload));
  await expect(receiver.getByTestId('save-file-btn')).toHaveCount(0);
});
