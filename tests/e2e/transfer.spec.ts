import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWords, pickWords } from './helpers';

/**
 * Step-2 file transfer, end to end through the live DataChannel. Every test forces the
 * RAM-bound Blob receive path (`?forceBlob=1`) so the download is observable by Playwright
 * — the native FSA save dialog cannot be automated (that path is verified manually).
 *
 * The pair is brought up through the REAL "words" screens (CPace + key-confirmation → an
 * authenticated `connected`), the simplest fully-automatable real flow (no human SAS step). The
 * old no-crypto transport rendezvous is no longer exposed by the real UI.
 */

const TMP = join(process.cwd(), 'e2e-tmp');
const SIZE_MB = Number(process.env.E2E_SIZE_MB) || 120; // big enough to sustain backpressure
const BIG_SIZE = SIZE_MB * 1024 * 1024;

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
function sha256File(path: string): string {
  return sha256(readFileSync(path));
}
function makeRandomFile(path: string, size: number): void {
  const fd = openSync(path, 'w');
  try {
    let written = 0;
    const CHUNK = 1 << 20;
    while (written < size) {
      const n = Math.min(CHUNK, size - written);
      writeSync(fd, randomBytes(n));
      written += n;
    }
  } finally {
    closeSync(fd);
  }
}

function bytesOf(text: string | null): { transferred: number; total: number } | null {
  if (!text) return null;
  const m = /(\d+)\s*\/\s*(\d+)/.exec(text);
  return m ? { transferred: Number(m[1]), total: Number(m[2]) } : null;
}

/** Sample the progress counter on a page until the transfer settles; returns the byte series. */
async function sampleProgress(page: Page): Promise<number[]> {
  const seen: number[] = [];
  for (let i = 0; i < 1200; i++) {
    const phase = await page.getByTestId('transfer-phase').textContent().catch(() => null);
    const b = bytesOf(await page.getByTestId('transfer-bytes').textContent().catch(() => null));
    if (b && seen[seen.length - 1] !== b.transferred) seen.push(b.transferred);
    if (phase && /done|error|rejected|cancelled/.test(phase)) break;
    await page.waitForTimeout(40);
  }
  return seen;
}

/** Bring up two connected tabs via the real words flow (authenticated, forced Blob receive path). */
async function connectPair(
  context: BrowserContext,
  opts: { receiverMaxBytes?: number } = {},
): Promise<{ sender: Page; receiver: Page }> {
  const sender = await context.newPage();
  await sender.goto('/?forceBlob=1');
  const words = await createWords(sender);

  const receiver = await context.newPage();
  if (opts.receiverMaxBytes != null) {
    await receiver.addInitScript((max) => {
      (window as unknown as { __HUSHSEND_MAX_BYTES__: number }).__HUSHSEND_MAX_BYTES__ = max;
    }, opts.receiverMaxBytes);
  }
  await receiver.goto('/?forceBlob=1');
  await pickWords(receiver, words);

  await expect(sender.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(receiver.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  return { sender, receiver };
}

test.beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

test('single large file transfers intact, progress grows (Blob path)', async ({ context }) => {
  const src = join(TMP, 'big.bin');
  makeRandomFile(src, BIG_SIZE);
  const srcHash = sha256File(src);

  const { sender, receiver } = await connectPair(context);
  await sender.getByTestId('file-input').setInputFiles(src);
  await sender.getByTestId('send-btn').click();

  await expect(receiver.getByTestId('transfer-phase')).toContainText('offered');

  const downloadPromise = receiver.waitForEvent('download', { timeout: 150_000 });
  await receiver.getByTestId('accept-btn').click();
  await expect(receiver.getByTestId('transfer-phase')).toContainText('transferring', { timeout: 30_000 });

  const series = await sampleProgress(sender);
  const download = await downloadPromise;
  const out = join(TMP, 'big.out');
  await download.saveAs(out);

  expect(download.suggestedFilename()).toBe('big.bin');
  await expect(sender.getByTestId('transfer-phase')).toContainText('done', { timeout: 30_000 });
  await expect(receiver.getByTestId('transfer-phase')).toContainText('done', { timeout: 30_000 });

  // progress grew: monotonic, at least one intermediate value, ending exactly at the size.
  expect(series.length).toBeGreaterThan(1);
  for (let i = 1; i < series.length; i++) expect(series[i]).toBeGreaterThanOrEqual(series[i - 1]);
  expect(series[series.length - 1]).toBe(BIG_SIZE);

  // bytes-perfect: same size and same sha-256.
  expect(statSync(out).size).toBe(BIG_SIZE);
  expect(sha256File(out)).toBe(srcHash);
});

test('multiple files arrive as one unpackable zip (Blob path)', async ({ context }) => {
  const a = join(TMP, 'alpha.txt');
  const b = join(TMP, 'beta.bin');
  const c = join(TMP, 'gamma.txt');
  writeFileSync(a, 'alpha contents — hello hushsend\n'.repeat(1000));
  makeRandomFile(b, 2 * 1024 * 1024);
  writeFileSync(c, 'gamma 🎉 unicode contents\n'.repeat(500));
  const hashes = { 'alpha.txt': sha256File(a), 'beta.bin': sha256File(b), 'gamma.txt': sha256File(c) };

  const { sender, receiver } = await connectPair(context);
  await sender.getByTestId('file-input').setInputFiles([a, b, c]);
  await sender.getByTestId('send-btn').click();

  await expect(receiver.getByTestId('transfer-phase')).toContainText('offered');
  const downloadPromise = receiver.waitForEvent('download', { timeout: 60_000 });
  await receiver.getByTestId('accept-btn').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('hushsend-files.zip');

  const zipPath = join(TMP, 'out.zip');
  await download.saveAs(zipPath);
  await expect(receiver.getByTestId('transfer-phase')).toContainText('done', { timeout: 30_000 });

  const outDir = join(TMP, 'unzipped');
  rmSync(outDir, { recursive: true, force: true });
  // Native Windows unzip — no extra dependency.
  execFileSync('powershell', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`,
  ]);

  expect(readdirSync(outDir).sort()).toEqual(['alpha.txt', 'beta.bin', 'gamma.txt']);
  for (const [name, hash] of Object.entries(hashes)) {
    expect(sha256File(join(outDir, name)), `${name} content matches`).toBe(hash);
  }
});

test('oversize file is rejected before any byte (Blob path limit)', async ({ context }) => {
  const big = join(TMP, 'over.bin');
  makeRandomFile(big, 12 * 1024 * 1024); // 12 MB

  // Cap the in-memory limit at 5 MB so a 12 MB file is over the ceiling.
  const { sender, receiver } = await connectPair(context, { receiverMaxBytes: 5 * 1024 * 1024 });
  await sender.getByTestId('file-input').setInputFiles(big);
  await sender.getByTestId('send-btn').click();

  // Receiver auto-rejects with a clear reason and never offers an Accept button.
  await expect(receiver.getByTestId('transfer-phase')).toContainText('rejected', { timeout: 30_000 });
  await expect(receiver.getByTestId('transfer-reason')).toContainText('larger than');
  await expect(receiver.getByTestId('accept-btn')).toHaveCount(0);

  // Sender sees the same reason and never entered the transferring phase (no byte left).
  await expect(sender.getByTestId('transfer-phase')).toContainText('rejected', { timeout: 30_000 });
  await expect(sender.getByTestId('transfer-reason')).toContainText('larger than');
  await expect(sender.getByTestId('transfer-bytes')).toHaveCount(0);
});
