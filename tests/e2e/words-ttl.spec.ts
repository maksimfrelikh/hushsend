import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The word-room TTL bounds the PAIRING WINDOW only — it must NOT cut off an already-established
 * (authenticated) P2P connection or an in-flight transfer. That matters for the headline feature:
 * a 10 GB transfer easily runs longer than the 3-minute TTL, and killing it at 3:00 would be a
 * bug on the main path.
 *
 * This test spins up an ISOLATED signaling server with a deliberately SHORT TTL (so the timer
 * fires within the test), connects a real authenticated pair through it (via the DEV-only
 * `?signalingUrl=` override), waits for the TTL to actually expire the word room, and then shows
 * the live P2P DataChannel transfer still completes intact. Other suites keep the default 3-min
 * TTL on the shared server, so they're unaffected.
 */

const PORT = 8082;
const TTL_MS = 8000; // short enough to fire mid-test, long enough to pair first
const SIGNALING = `ws://127.0.0.1:${PORT}`;
const TMP = join(process.cwd(), 'e2e-tmp-words-ttl');

let server: ChildProcess;

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function pickWords(page: Page, words: string[]): Promise<void> {
  for (let i = 0; i < words.length; i++) {
    await page.getByTestId(`word-input-${i}`).fill(words[i]);
    await page.getByTestId(`word-pos-${i}`).getByRole('button', { name: words[i], exact: true }).click();
    await expect(page.getByTestId(`word-picked-${i}`)).toContainText(words[i]);
  }
  await page.getByTestId('words-join-btn').click();
}

async function waitForHealth(timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - start > timeoutMs) throw new Error('isolated signaling server did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
}

test.beforeAll(async () => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  server = spawn(process.execPath, ['server/signaling-server.js'], {
    env: { ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(PORT), WORD_ROOM_TTL_MS: String(TTL_MS) },
    stdio: 'ignore',
  });
  await waitForHealth();
});

test.afterAll(() => {
  server?.kill();
});

test('word-room TTL expiry after connected does NOT drop the live P2P transfer', async ({ context }) => {
  const url = `/?forceBlob=1&signalingUrl=${encodeURIComponent(SIGNALING)}`;
  // Pre-load both tabs so the TTL timer (armed when A creates) isn't eaten by page-load latency.
  const sender = await context.newPage();
  const receiver = await context.newPage();
  await sender.goto(url);
  await receiver.goto(url);

  // A creates the word room (the short TTL starts ticking now); B reproduces the 5 words.
  await sender.getByTestId('create-words-btn').click();
  await expect(sender.getByTestId('status')).toHaveText('awaitingPeer', { timeout: 30_000 });
  const words = (await sender.getByTestId('words').textContent())!.trim().split(/\s+/).filter(Boolean);
  expect(words).toHaveLength(5);
  await pickWords(receiver, words);

  // Both authenticate (CPace + key-confirmation) and reach connected.
  await expect(sender.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(receiver.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(sender.getByTestId('auth-state')).toContainText('authenticated');

  // Wait until the TTL actually expires the word room (server closes signaling on both sides).
  // The client notes it but does not tear down — proof that the pairing-window timer is over.
  await expect(sender.getByText('word-room TTL expired')).toBeVisible({ timeout: TTL_MS + 15_000 });
  await expect(receiver.getByText('word-room TTL expired')).toBeVisible({ timeout: 15_000 });

  // The authenticated P2P session is untouched by the signaling teardown.
  await expect(sender.getByTestId('status')).toHaveText('connected');
  await expect(receiver.getByTestId('status')).toHaveText('connected');

  // And a transfer over that live DataChannel — started AFTER the TTL fired — still succeeds.
  const src = join(TMP, 'after-ttl.bin');
  const payload = randomBytes(64 * 1024);
  writeFileSync(src, payload);

  await sender.getByTestId('file-input').setInputFiles(src);
  await sender.getByTestId('send-btn').click();
  await expect(receiver.getByTestId('transfer-phase')).toContainText('offered');

  const downloadPromise = receiver.waitForEvent('download', { timeout: 60_000 });
  await receiver.getByTestId('accept-btn').click();
  const download = await downloadPromise;
  const out = join(TMP, 'after-ttl.out');
  await download.saveAs(out);

  await expect(sender.getByTestId('transfer-phase')).toContainText('done', { timeout: 30_000 });
  await expect(receiver.getByTestId('transfer-phase')).toContainText('done', { timeout: 30_000 });
  expect(sha256(readFileSync(out))).toBe(sha256(payload));
});
