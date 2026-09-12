import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLink, fragmentOf, joinQrByPaste } from './helpers';

/**
 * The PHONE profile (step 6e, the closest thing to a handset without one): WebKit driven with an
 * iPhone device descriptor — iOS User-Agent, phone viewport, touch.
 *
 * What this genuinely covers: the receive ceiling is picked from the User-Agent, so a phone profile
 * is what selects MAX_BYTES_MOBILE_BLOB (512 MB) over the desktop gigabyte — and that decision had
 * NO end-to-end coverage at all. It also covers the Blob receive path taken for real (WebKit has no
 * showSaveFilePicker, so nothing needs forcing here), the layout at 390 px, and the QR paste
 * fallback a phone without a usable camera falls back to.
 *
 * What it does NOT cover, and must not be read as covering: real iOS memory pressure, background-tab
 * suspension mid-transfer, camera permissions, or cellular NAT. Playwright's WebKit is WebKitGTK on
 * Linux wearing an iPhone's UA — the same engine family, not the same device. TESTPLAN § B/F1 stay
 * open until a real handset runs them.
 *
 * WebKit needs a STUN server on a host with no mDNS responder (see playwright.config.ts):
 *   E2E_STUN_URLS=stun:127.0.0.1:3478 npx playwright test --project=mobile-webkit
 */

const TMP = join(process.cwd(), 'e2e-tmp-mobile');
/** Just over MAX_BYTES_MOBILE_BLOB (512 MB) and well under the desktop gigabyte: only a phone refuses it. */
const OVER_MOBILE_CAP = 520 * 1024 * 1024;

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Pair two tabs of this (phone) profile over the link method and return both pages. */
async function connectPair(context: BrowserContext): Promise<{ sender: Page; receiver: Page }> {
  const sender = await context.newPage();
  await sender.goto('/');
  const link = await createLink(sender, 'link');
  const receiver = await context.newPage();
  await receiver.goto(`/${fragmentOf(link)}`);
  await expect(sender.getByTestId('status')).toHaveText('connected', { timeout: 90_000 });
  await expect(receiver.getByTestId('status')).toHaveText('connected', { timeout: 90_000 });
  return { sender, receiver };
}

test.beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

test('phone · the UA picks the 512 MB ceiling, and an oversize file is refused before any byte', async ({
  context,
}) => {
  // A SPARSE file: the receiver refuses on the offer's declared size, so not one byte is ever read
  // from it. Writing 520 MB of real data would only slow the test down to prove the same thing.
  const big = join(TMP, 'over-mobile-cap.bin');
  writeFileSync(big, '');
  truncateSync(big, OVER_MOBILE_CAP);

  const { sender, receiver } = await connectPair(context);
  await sender.getByTestId('file-input').setInputFiles(big);
  await sender.getByTestId('send-btn').click();

  // Refused, and the reason must quote the PHONE cap — 1.0 GB here would mean the desktop ceiling
  // was applied to a phone, which is the whole failure this test exists to catch.
  await expect(receiver.getByTestId('transfer-phase')).toContainText('rejected', { timeout: 30_000 });
  await expect(receiver.getByTestId('transfer-reason')).toContainText('512 MB');
  await expect(receiver.getByTestId('accept-btn')).toHaveCount(0);

  // And the sender never started sending: no bytes counter, same reason shown.
  await expect(sender.getByTestId('transfer-phase')).toContainText('rejected', { timeout: 30_000 });
  await expect(sender.getByTestId('transfer-bytes')).toHaveCount(0);
});

test('phone · a normal transfer completes over the Blob path (no FSA on this engine)', async ({ context }) => {
  const src = join(TMP, 'note.bin');
  const payload = randomBytes(2 * 1024 * 1024);
  writeFileSync(src, payload);

  const { sender, receiver } = await connectPair(context);
  await sender.getByTestId('file-input').setInputFiles(src);
  await sender.getByTestId('send-btn').click();
  await expect(receiver.getByTestId('transfer-phase')).toContainText('offered', { timeout: 30_000 });

  const downloadPromise = receiver.waitForEvent('download', { timeout: 60_000 });
  await receiver.getByTestId('accept-btn').click();
  const download = await downloadPromise;
  const out = join(TMP, 'note.out');
  await download.saveAs(out);

  await expect(sender.getByTestId('transfer-phase')).toContainText('done', { timeout: 30_000 });
  expect(sha256(readFileSync(out)), 'received bytes match what was sent').toBe(sha256(payload));
});

test('phone · nothing overflows a 390 px screen', async ({ page }) => {
  await page.goto('/');
  const overflow = async (where: string): Promise<void> => {
    const [scrollW, clientW] = await page.evaluate(() => [
      document.documentElement.scrollWidth,
      document.documentElement.clientWidth,
    ]);
    // A 1 px slack for sub-pixel rounding; anything more is a real horizontal scrollbar on a phone.
    expect(scrollW, `${where}: horizontal overflow (${scrollW} > ${clientW})`).toBeLessThanOrEqual(clientW + 1);
  };
  await overflow('home');

  await page.getByTestId('invite-btn').click();
  await overflow('method picker');
  await page.getByTestId('create-words-btn').click();
  await expect(page.getByTestId('status')).toHaveText('awaitingPeer', { timeout: 30_000 });
  await overflow('words credential'); // five words side by side is the widest thing we render
});

test('phone · QR scanning falls back to pasting the link when the camera is unusable', async ({ context }) => {
  const sender = await context.newPage();
  await sender.goto('/');
  const link = await createLink(sender, 'qr');

  // A headless profile has no camera, which is also what a real phone gives us when permission is
  // denied — the paste fallback is the ONLY way through, and it must reach the same join path.
  const receiver = await context.newPage();
  await receiver.goto('/');
  await joinQrByPaste(receiver, link);

  await expect(sender.getByTestId('status')).toHaveText('connected', { timeout: 90_000 });
  await expect(receiver.getByTestId('status')).toHaveText('connected', { timeout: 90_000 });
  await expect(receiver.getByTestId('auth-state')).toContainText('authenticated');
});
