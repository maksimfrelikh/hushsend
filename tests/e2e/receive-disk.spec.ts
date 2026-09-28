import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createLink, forwardConsole, fragmentOf } from './helpers';

/**
 * Receiving to DISK with no dialog — the paths a real receiver takes (no `forceBlob` here):
 *
 *   - STRAIGHT INTO DOWNLOADS (owner's rule, 2026-09-28; src/core/transfer/streamDownload.ts): the
 *     download worker streams the file into the browser's download manager as it arrives — no copy
 *     in site storage, no RAM. Desktop Chromium only (Firefox fails such a download unsafely).
 *       · the bytes arrive intact, the download starts at Accept, nothing lands in site storage;
 *       · a download cancelled in the browser stops the transfer, and the sender is told.
 *   - SITE STORAGE (2026-09-27; src/core/transfer/opfs.ts) — what Firefox, Safari and mobile browsers
 *     take, and the fallback everywhere: the file is written into OPFS and, once complete, handed to the browser
 *     as an ordinary download read from disk. Forced here with the DEV-only `?noStream=1`, so Chromium
 *     keeps exercising it.
 *       · the bytes survive the trip through site storage;
 *       · a page that is HIDDEN when the file completes (iOS drops a download started then) holds it
 *         and shows "Save file" — the tap hands it over.
 *
 * The site-storage cases skip on an engine build whose site storage cannot write (the app falls back
 * to RAM, which the other suites cover with `forceBlob`).
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

async function pair(
  context: BrowserContext,
  { siteStorage }: { siteStorage: boolean },
): Promise<{ sender: Page; receiver: Page }> {
  const sender = await context.newPage();
  forwardConsole(sender, 'sender');
  await sender.goto('/');
  const link = await createLink(sender, 'link');
  const receiver = await context.newPage();
  forwardConsole(receiver, 'receiver');
  await receiver.goto(`/${siteStorage ? '?noStream=1' : ''}${fragmentOf(link)}`);
  await expect(sender.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(receiver.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  if (!siteStorage) return { sender, receiver };
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

/** Is the download worker registered on this page right now — i.e. did it take the stream path? */
const worker = (page: Page): Promise<boolean> =>
  page.evaluate(async () => !!(await navigator.serviceWorker?.getRegistration('/dl/')));

test('a file goes STRAIGHT into Downloads — no dialog, no copy in site storage — and arrives intact', async ({
  context,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'only desktop Chromium streams (see streamDownload.ts)');
  const { sender, receiver } = await pair(context, { siteStorage: false });
  const payload = randomBytes(8 * 1024 * 1024);
  const src = join(TMP, 'stream.bin');
  writeFileSync(src, payload);

  await sender.getByTestId('file-input').setInputFiles(src);
  await sender.getByTestId('send-btn').click();
  await expect(receiver.getByTestId('transfer-phase')).toContainText('offered');
  const downloadPromise = receiver.waitForEvent('download', { timeout: 60_000 });
  await receiver.getByTestId('accept-btn').click(); // no picker
  // The download starts at Accept — the bytes go to it as they arrive, not at the end.
  const download = await downloadPromise;
  expect(await worker(receiver), 'the download worker carries it').toBe(true);
  const out = join(TMP, 'stream.out');
  await download.saveAs(out);

  await expect(receiver.getByTestId('transfer-phase')).toContainText('done');
  await expect(sender.getByTestId('transfer-phase')).toContainText('done', { timeout: 30_000 });
  expect(sha256(readFileSync(out))).toBe(sha256(payload));
  expect(await incomingCount(receiver), 'no copy in site storage').toBe(0);
});

test('a download cancelled in the browser stops the transfer, and the sender is told', async ({
  context,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'only desktop Chromium streams');
  const { sender, receiver } = await pair(context, { siteStorage: false });
  // Sparse and big enough to still be in flight when the cancel lands.
  const src = join(TMP, 'cancel.bin');
  const fd = openSync(src, 'w');
  ftruncateSync(fd, 190 * 1024 * 1024);
  closeSync(fd);

  await sender.getByTestId('file-input').setInputFiles(src);
  await sender.getByTestId('send-btn').click();
  await expect(receiver.getByTestId('transfer-phase')).toContainText('offered');
  const downloadPromise = receiver.waitForEvent('download', { timeout: 60_000 });
  await receiver.getByTestId('accept-btn').click();
  const download = await downloadPromise;
  await download.cancel(); // the human cancels it in the browser's downloads list
  await expect(receiver.getByTestId('transfer-phase')).toContainText('error', { timeout: 30_000 });
  await expect(receiver.getByTestId('transfer-reason')).toContainText(/stopped the download/);
  await expect(sender.getByTestId('transfer-phase')).toContainText('cancelled', {
    timeout: 30_000,
  });
  expect(await download.failure(), 'the browser keeps no partial file').not.toBeNull();
});

test('a file goes through site storage with no dialog and arrives intact as a download', async ({
  context,
}) => {
  const { sender, receiver } = await pair(context, { siteStorage: true });
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
  const { sender, receiver } = await pair(context, { siteStorage: true });
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
