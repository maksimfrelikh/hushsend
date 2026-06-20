import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLink, fragmentOf, joinQrByPaste } from './helpers';

/**
 * Step-5b "link" / "qr" methods, end to end through two Chromium tabs:
 *   - A clicks Invite → Link (or QR) → the server allocates a PUBLIC high-entropy 128-bit TOKEN
 *     rendezvous (codeType=token — unguessable, NOT the 4-digit room) and A's UI shows a one-time
 *     link `<origin>/#<token>.<S>` (S = high-entropy CSPRNG secret in the fragment).
 *   - B OPENS the link → the page-load handler reads the fragment, SCRUBS it from the URL, and joins
 *     with only the token; S stays local. WebRTC brings up the DataChannel, then a channel-bound
 *     key-confirmation over S (no PAKE, no SAS) authenticates → connected. Because the token is
 *     unguessable, a stray peer can't reach the room — interloper-resistance is STRUCTURAL.
 *   - The qr method is identical; the joiner reaches the same join path by submitting the decoded
 *     link in the scan screen's paste fallback (a headless camera can't decode a QR).
 *
 * Like the other suites, every test forces the RAM-bound Blob receive path (`?forceBlob=1`) so the
 * download is observable (the native FSA dialog can't be automated).
 */

const TMP = join(process.cwd(), 'e2e-tmp-link');

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Open a joiner tab on `url` (relative to baseURL), always forcing the Blob receive path. */
async function openJoiner(context: BrowserContext, fragment = ''): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`/?forceBlob=1${fragment}`);
  return page;
}

test.beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

test('link happy path: open the invite link → authenticated connected → small file transfers intact', async ({
  context,
}) => {
  const sender = await context.newPage();
  await sender.goto('/?forceBlob=1');
  const link = await createLink(sender, 'link');

  // B opens the link: the fragment carries the room code + secret. The page-load handler joins.
  const receiver = await openJoiner(context, fragmentOf(link));

  // Both sides reach an AUTHENTICATED connected (key-confirmation over S succeeded).
  await expect(sender.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(receiver.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(sender.getByTestId('auth-state')).toContainText('authenticated');
  await expect(receiver.getByTestId('auth-state')).toContainText('authenticated');

  // The secret must NOT linger in the joiner's URL (scrubbed via history.replaceState).
  expect(await receiver.evaluate(() => window.location.hash)).toBe('');

  // Send a small file over the now-authenticated DataChannel.
  const src = join(TMP, 'note.bin');
  const payload = randomBytes(200 * 1024); // ~200 KB — a couple of chunks
  writeFileSync(src, payload);
  const srcHash = sha256(payload);

  await sender.getByTestId('file-input').setInputFiles(src);
  await sender.getByTestId('send-btn').click();
  await expect(receiver.getByTestId('transfer-phase')).toContainText('offered');

  const downloadPromise = receiver.waitForEvent('download', { timeout: 60_000 });
  await receiver.getByTestId('accept-btn').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('note.bin');

  const out = join(TMP, 'note.out');
  await download.saveAs(out);
  await expect(sender.getByTestId('transfer-phase')).toContainText('done', { timeout: 30_000 });
  await expect(receiver.getByTestId('transfer-phase')).toContainText('done', { timeout: 30_000 });
  expect(sha256(readFileSync(out))).toBe(srcHash);
});

test('link negative: a wrong secret (correct room) → key-confirmation fails → both fail, no transfer', async ({
  context,
}) => {
  const sender = await context.newPage();
  await sender.goto('/?forceBlob=1');
  const link = await createLink(sender, 'link');

  // Keep the rendezvous TOKEN (so B still routes into A's room) but swap in a DIFFERENT well-formed
  // 16-byte secret: CPace-free key-confirmation over divergent S ⇒ the MAC tags cannot match.
  const token = fragmentOf(link).slice(1, fragmentOf(link).indexOf('.'));
  const wrongSecret = randomBytes(16).toString('base64url');
  const receiver = await openJoiner(context, `#${token}.${wrongSecret}`);

  // Both sides fail: the rejecting side on the tag mismatch, the other on the relayed teardown.
  await expect(receiver.getByTestId('status')).toHaveText('failed', { timeout: 60_000 });
  await expect(sender.getByTestId('status')).toHaveText('failed', { timeout: 60_000 });

  // Neither side ever rendered the file UI (only shown when connected) → no byte crossed.
  await expect(sender.getByTestId('file-input')).toHaveCount(0);
  await expect(receiver.getByTestId('file-input')).toHaveCount(0);
});

test('qr post-scan: decoded link joins via the scan paste fallback → authenticated connected', async ({
  context,
}) => {
  const sender = await context.newPage();
  await sender.goto('/?forceBlob=1');
  const link = await createLink(sender, 'qr'); // QR encodes exactly this link

  // Simulate a successful scan by submitting the decoded link in the scan screen's paste fallback.
  const receiver = await openJoiner(context);
  await joinQrByPaste(receiver, link);

  await expect(sender.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(receiver.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(sender.getByTestId('auth-state')).toContainText('authenticated');
  await expect(receiver.getByTestId('auth-state')).toContainText('authenticated');
});
