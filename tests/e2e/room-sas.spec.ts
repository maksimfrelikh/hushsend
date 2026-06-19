import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Step-4a "room" method, end to end through two Chromium tabs:
 *   - A clicks "New SAS room" → the server allocates a PUBLIC 4-digit code, shown in A's UI.
 *   - B enters the code → joins. WebRTC brings up the DataChannel; in PARALLEL a ZRTP-style
 *     commit-reveal of nonces runs over signaling (B commits first, A reveals, B reveals).
 *   - Both sides derive the SAME 3-word SAS from (nonceA, nonceB, DTLS-fingerprint-pair). The
 *     humans compare it out-of-band; mutual "matches" → AUTHENTICATED connected. A "doesn't
 *     match" on either side is a hard stop — no channel, no bytes.
 *
 * Like the other suites, every test forces the RAM-bound Blob receive path (`?forceBlob=1`) so
 * the download is observable (the native FSA dialog can't be automated).
 */

const TMP = join(process.cwd(), 'e2e-tmp-room-sas');

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Build the harness URL, always forcing the Blob receive path, plus any extra dev query. */
function harnessUrl(extraQuery = ''): string {
  return `/?forceBlob=1${extraQuery ? `&${extraQuery}` : ''}`;
}

/** A creates a SAS room; returns the page and the allocated 4-digit code read from A's UI. */
async function createSasRoom(
  context: BrowserContext,
  extraQuery = '',
): Promise<{ sender: Page; code: string }> {
  const sender = await context.newPage();
  await sender.goto(harnessUrl(extraQuery));
  await sender.getByTestId('create-room-sas-btn').click();
  await expect(sender.getByTestId('status')).toHaveText('awaitingPeer', { timeout: 30_000 });
  const code = (await sender.getByTestId('room-code').textContent())?.trim() ?? '';
  expect(code).toMatch(/^\d{4}$/);
  return { sender, code };
}

/** B joins a SAS room by code. */
async function joinSasRoom(context: BrowserContext, code: string, extraQuery = ''): Promise<Page> {
  const receiver = await context.newPage();
  await receiver.goto(harnessUrl(extraQuery));
  await receiver.getByTestId('room-sas-input').fill(code);
  await receiver.getByTestId('join-room-sas-btn').click();
  return receiver;
}

/** Wait until both tabs render the SAS triple, and assert they agree. Returns the shared triple. */
async function readMatchingSas(a: Page, b: Page): Promise<string> {
  await expect(a.getByTestId('status')).toHaveText('awaitingSas', { timeout: 60_000 });
  await expect(b.getByTestId('status')).toHaveText('awaitingSas', { timeout: 60_000 });
  const sasA = (await a.getByTestId('sas-words').textContent())?.trim() ?? '';
  const sasB = (await b.getByTestId('sas-words').textContent())?.trim() ?? '';
  expect(sasA.split(/\s+/).filter(Boolean)).toHaveLength(3); // 3 EFF short #2 words
  expect(sasA).toBe(sasB); // channel binding: both sides derive the SAME triple
  return sasA;
}

test.beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

test('happy path: matching SAS on both sides → authenticated connected → small file transfers intact', async ({
  context,
}) => {
  const { sender, code } = await createSasRoom(context);
  const receiver = await joinSasRoom(context, code);

  // Both sides show the SAME 3-word SAS (proves the channel binding + same nonces).
  await readMatchingSas(sender, receiver);

  // Both humans confirm a match → mutual confirmation gates an AUTHENTICATED connected.
  await sender.getByTestId('sas-match-btn').click();
  await receiver.getByTestId('sas-match-btn').click();

  await expect(sender.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(receiver.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(sender.getByTestId('auth-state')).toContainText('SAS');
  await expect(receiver.getByTestId('auth-state')).toContainText('SAS');

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

test('mismatch: one side rejects the SAS → both fail, no channel, no transfer', async ({ context }) => {
  const { sender, code } = await createSasRoom(context);
  const receiver = await joinSasRoom(context, code);

  await readMatchingSas(sender, receiver);

  // The receiver reports the words do NOT match (the hard-stop path). Even though the SAS is
  // really identical here, a "doesn't match" click must abort both sides unconditionally.
  await receiver.getByTestId('sas-nomatch-btn').click();

  // The rejecting side fails immediately; the other side fails on the relayed reject / teardown.
  await expect(receiver.getByTestId('status')).toHaveText('failed', { timeout: 60_000 });
  await expect(sender.getByTestId('status')).toHaveText('failed', { timeout: 60_000 });

  // Neither side ever rendered the file UI (only shown when connected) → no byte crossed.
  await expect(sender.getByTestId('file-input')).toHaveCount(0);
  await expect(receiver.getByTestId('file-input')).toHaveCount(0);
});

test('timeout: SAS shown but nobody confirms → fails on the timeout path, no channel, no transfer', async ({
  context,
}) => {
  // Shrink the SAS *comparison* window with the DEV-only `?sasTimeoutMs` override so the timeout
  // branch fires in a few seconds instead of the real 120 s — no fake timers, no 120 s wait. The
  // PRE-SAS pairing deadline keeps its fixed default, so this shrink can't pre-empt the awaitingSas
  // state we assert below. The sender gets the shorter budget so ITS own timer (not the relayed
  // teardown) deterministically fires first → its error is the timeout reason; the receiver keeps a
  // longer budget purely as a backstop (it normally fails first via the torn-down channel).
  const { sender, code } = await createSasRoom(context, 'sasTimeoutMs=3000');
  const receiver = await joinSasRoom(context, code, 'sasTimeoutMs=10000');

  // The SAS IS shown to the human (awaitingSas + 3 EFF short #2 words) — we just never confirm.
  await expect(sender.getByTestId('status')).toHaveText('awaitingSas', { timeout: 60_000 });
  const sas = (await sender.getByTestId('sas-words').textContent())?.trim() ?? '';
  expect(sas.split(/\s+/).filter(Boolean)).toHaveLength(3);

  // Neither human clicks "match"/"don't match". After the (shrunk) comparison window elapses, the
  // sender's own timer takes the SAME failSas → `failed` path as every other SAS failure.
  await expect(sender.getByTestId('status')).toHaveText('failed', { timeout: 30_000 });
  await expect(sender.getByTestId('error')).toContainText('timed out');

  // The peer goes down too (its torn-down channel, or its own backstop timer) — no side hangs.
  await expect(receiver.getByTestId('status')).toHaveText('failed', { timeout: 30_000 });

  // Neither side ever rendered the file UI (only shown when connected) → no byte crossed.
  await expect(sender.getByTestId('file-input')).toHaveCount(0);
  await expect(receiver.getByTestId('file-input')).toHaveCount(0);
});
