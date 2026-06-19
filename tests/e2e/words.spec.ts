import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWords as readCreatedWords, pickWords } from './helpers';

/**
 * Step-3b "words" method, end to end through two Chromium tabs:
 *   - A clicks "Create (words)" → reads the 5 spoken words from its UI.
 *   - B reproduces them in the 5-position autocomplete picker → joins.
 *   - CPace over signaling derives the ISK; WebRTC brings up the DataChannel; a
 *     key-confirmation MAC over the DTLS fingerprints authenticates the channel.
 *
 * Like the file-transfer suite, every test forces the RAM-bound Blob receive path
 * (`?forceBlob=1`) so the download is observable (the native FSA dialog can't be automated).
 */

const TMP = join(process.cwd(), 'e2e-tmp-words');

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** A creates a words session; returns the 5-word credential read straight from A's UI.
 *  `extraQuery` lets a test lower the attempt cap (e.g. 'maxAttempts=3') so the rate-limit
 *  path is reachable in a few handshakes instead of ten. */
async function createWords(
  context: BrowserContext,
  extraQuery = '',
): Promise<{ sender: Page; words: string[] }> {
  const sender = await context.newPage();
  await sender.goto(`/?forceBlob=1${extraQuery ? `&${extraQuery}` : ''}`);
  const words = await readCreatedWords(sender);
  return { sender, words };
}

async function joinWithWords(context: BrowserContext, words: string[]): Promise<Page> {
  const receiver = await context.newPage();
  await receiver.goto('/?forceBlob=1');
  await pickWords(receiver, words);
  return receiver;
}

test.beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

test('happy path: correct words → authenticated connected → small file transfers intact', async ({
  context,
}) => {
  const { sender, words } = await createWords(context);
  const receiver = await joinWithWords(context, words);

  // Both sides reach an AUTHENTICATED connected (CPace + key-confirmation succeeded).
  await expect(sender.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(receiver.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(sender.getByTestId('auth-state')).toContainText('authenticated');
  await expect(receiver.getByTestId('auth-state')).toContainText('authenticated');

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

/** All-wrong-secret credential that keeps the rendezvous correct (so B still routes into A's
 *  room and CPace runs) but supplies the wrong 4 secret words: reuse the rendezvous word, which
 *  is a valid, selectable list word yet ≠ the real secrets. CPace → divergent ISKs → the
 *  key-confirmation MAC cannot match. */
function wrongSecretFor(words: string[]): string[] {
  return [words[0], words[0], words[0], words[0], words[0]];
}

test('wrong words: correct rendezvous, wrong secret → B fails; A counts the attempt and keeps waiting', async ({
  context,
}) => {
  const { sender, words } = await createWords(context);
  const receiver = await joinWithWords(context, wrongSecretFor(words));

  // B (the wrong guesser) fails on the key-confirmation mismatch.
  await expect(receiver.getByTestId('status')).toHaveText('failed', { timeout: 60_000 });

  // A does NOT connect and does NOT give up on a single wrong attempt: it counts the failed
  // attempt and returns to waiting with the SAME words (online-guessing bound, below the cap).
  await expect(sender.getByTestId('status')).toHaveText('awaitingPeer', { timeout: 60_000 });
  await expect(sender.getByTestId('attempts')).toContainText('1 / 10');

  // Neither side ever rendered the file UI (only shown when connected) → no byte crossed.
  await expect(sender.getByTestId('file-input')).toHaveCount(0);
  await expect(receiver.getByTestId('file-input')).toHaveCount(0);
});

test('rate limit: failed attempts up to the cap invalidate the rendezvous (attacker blocked)', async ({
  context,
}) => {
  const MAX = 3; // lowered via ?maxAttempts so the cap is reachable in a few handshakes
  const { sender, words } = await createWords(context, `maxAttempts=${MAX}`);
  const wrong = wrongSecretFor(words);

  // Attempts 1..MAX-1: each wrong guess is counted; A stays available with the SAME words.
  for (let i = 1; i < MAX; i++) {
    const b = await joinWithWords(context, wrong);
    await expect(b.getByTestId('status')).toHaveText('failed', { timeout: 60_000 });
    await expect(sender.getByTestId('attempts')).toContainText(`${i} / ${MAX}`, { timeout: 30_000 });
    await expect(sender.getByTestId('status')).toHaveText('awaitingPeer');
    await b.close(); // free A's 1:1 slot for the next attempt
  }

  // The capping attempt: A invalidates the rendezvous (server destroy) and fails with 'attempts'.
  const capper = await joinWithWords(context, wrong);
  await expect(capper.getByTestId('status')).toHaveText('failed', { timeout: 60_000 });
  await expect(sender.getByTestId('status')).toHaveText('failed', { timeout: 60_000 });
  await expect(sender.getByTestId('error')).toContainText('attempts');
  await capper.close();

  // The word is gone: a later join — even with the CORRECT words — can't find the room.
  const late = await joinWithWords(context, words);
  await expect(late.getByTestId('status')).toHaveText('failed', { timeout: 60_000 });
  await expect(sender.getByTestId('file-input')).toHaveCount(0); // A never connected
});
