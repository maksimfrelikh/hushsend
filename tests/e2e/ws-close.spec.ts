import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BASE,
  createLink,
  createWords,
  enrollViaSas,
  fragmentOf,
  pickWords,
  resetBoth,
  startReconnect,
} from './helpers';

/**
 * Privacy: the 1:1 methods (link / qr / words) CLOSE their own signaling socket the instant they
 * reach an authenticated `connected` — so the untrusted server never learns how long the P2P
 * session lasts (it sees the short pairing window, then both peers vanish). This must NOT disturb
 * the live session:
 *   - each side closing its socket makes the OTHER observe a `peer-left`; that must NOT drop the
 *     peer, fail it, or bounce it (liveness is the DataChannel/ICE, not room presence);
 *   - a transfer STARTED AFTER both sockets are closed must still complete intact over the live
 *     DataChannel.
 *
 * Exercised over both the `link` method (no PAKE, no human SAS) and the CPace `words` method — the
 * close + liveness-decoupling is method-agnostic (it hangs off the key-confirmation `connected`). Like
 * the other suites, `?forceBlob=1` forces the RAM-bound Blob receive path so the download is
 * observable.
 *
 * (This supersedes the old word-room-TTL e2e: the client no longer WAITS for the server's TTL to
 * tear down signaling post-connect — it closes its own socket the instant it connects — so the
 * "P2P survives a signaling teardown" property is now demonstrated by the client's own close. The
 * server-side TTL freeing the code is still covered by the integration suites.)
 */

const TMP = join(process.cwd(), 'e2e-tmp-ws-close');
const CLOSE_LOG = 'closing signaling socket';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function openJoiner(context: BrowserContext, fragment = ''): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`/?forceBlob=1${fragment}`);
  return page;
}

test.beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

test('1:1 link: signaling socket closes on connect; the peer-left it causes does NOT drop P2P; transfer after close is intact', async ({
  context,
}) => {
  const sender = await context.newPage();
  await sender.goto('/?forceBlob=1');
  const link = await createLink(sender, 'link');
  const receiver = await openJoiner(context, fragmentOf(link));

  // Both authenticate (key-confirmation over S) and reach connected.
  await expect(sender.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(receiver.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });

  // Each side closes its OWN signaling socket on connect (the DEV diagnostics log surfaces it).
  await expect(sender.getByText(CLOSE_LOG)).toBeVisible({ timeout: 15_000 });
  await expect(receiver.getByText(CLOSE_LOG)).toBeVisible({ timeout: 15_000 });

  // The `peer-left` each close generates on the other side must NOT fail/bounce the peer: liveness
  // is the DataChannel/ICE, not room presence. Give the relayed peer-left time to arrive, then assert
  // both are STILL connected (never 'failed', never bounced out of 'connected').
  await sender.waitForTimeout(1000);
  await expect(sender.getByTestId('status')).toHaveText('connected');
  await expect(receiver.getByTestId('status')).toHaveText('connected');

  // A transfer STARTED AFTER both sockets are closed still completes over the live DataChannel.
  const src = join(TMP, 'after-close.bin');
  const payload = randomBytes(256 * 1024);
  writeFileSync(src, payload);
  const srcHash = sha256(payload);

  await sender.getByTestId('file-input').setInputFiles(src);
  await sender.getByTestId('send-btn').click();
  await expect(receiver.getByTestId('transfer-phase')).toContainText('offered');

  const downloadPromise = receiver.waitForEvent('download', { timeout: 60_000 });
  await receiver.getByTestId('accept-btn').click();
  const download = await downloadPromise;
  const out = join(TMP, 'after-close.out');
  await download.saveAs(out);

  await expect(sender.getByTestId('transfer-phase')).toContainText('done', { timeout: 30_000 });
  await expect(receiver.getByTestId('transfer-phase')).toContainText('done', { timeout: 30_000 });
  expect(sha256(readFileSync(out))).toBe(srcHash);
});

test('1:1 words (CPace): signaling socket closes on connect; P2P survives; transfer after close is intact', async ({
  context,
}) => {
  // Pre-load both tabs, then bring up the authenticated words pair (CPace + key-confirmation).
  const sender = await context.newPage();
  const receiver = await context.newPage();
  await sender.goto('/?forceBlob=1');
  await receiver.goto('/?forceBlob=1');
  const words = await createWords(sender);
  await pickWords(receiver, words);

  await expect(sender.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(receiver.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });

  // Both close their own signaling socket on connect — the words anti-bruteforce window is over
  // (key-confirmation succeeded), so leaving the room is safe and never counts as a guess.
  await expect(sender.getByText(CLOSE_LOG)).toBeVisible({ timeout: 15_000 });
  await expect(receiver.getByText(CLOSE_LOG)).toBeVisible({ timeout: 15_000 });

  // The peer-left from each close must NOT count as a failed guess / drop the connection. A spurious
  // words attempt would bounce the creator to `awaitingPeer` (attempts++), so a steady `connected`
  // on both sides is the proof the post-completion peer-left was ignored for both liveness AND
  // guess-counting.
  await sender.waitForTimeout(1000);
  await expect(sender.getByTestId('status')).toHaveText('connected');
  await expect(receiver.getByTestId('status')).toHaveText('connected');

  // A transfer started AFTER the sockets are closed completes intact over the live DataChannel.
  const src = join(TMP, 'after-close-words.bin');
  const payload = randomBytes(256 * 1024);
  writeFileSync(src, payload);
  const srcHash = sha256(payload);

  await sender.getByTestId('file-input').setInputFiles(src);
  await sender.getByTestId('send-btn').click();
  await expect(receiver.getByTestId('transfer-phase')).toContainText('offered');

  const downloadPromise = receiver.waitForEvent('download', { timeout: 60_000 });
  await receiver.getByTestId('accept-btn').click();
  const download = await downloadPromise;
  const out = join(TMP, 'after-close-words.out');
  await download.saveAs(out);

  await expect(sender.getByTestId('transfer-phase')).toContainText('done', { timeout: 30_000 });
  await expect(receiver.getByTestId('transfer-phase')).toContainText('done', { timeout: 30_000 });
  expect(sha256(readFileSync(out))).toBe(srcHash);
});

/** A tab with its OWN context — reconnect needs two separate keystores, not two tabs sharing one. */
async function openIsolated(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE, acceptDownloads: true });
  const page = await context.newPage();
  await page.goto(`${BASE}/?forceBlob=1`);
  return page;
}

test('reconnect: the one pairing that used to KEEP its socket now closes it too; P2P survives; transfer intact', async ({
  browser,
}) => {
  // Reconnect was excluded from the per-pair close while reconnect-in-lobby was deferred, which made
  // it the only pairing whose socket stayed open for the whole session. That is itself a signal: the
  // untrusted server could read "these two have met before" off the behaviour alone, and got the
  // session duration the close exists to hide. This asserts the exclusion is gone — and that closing
  // it did not break the thing the exclusion was protecting.
  const a = await openIsolated(browser);
  const b = await openIsolated(browser);

  await enrollViaSas(a, b); // first meeting: SAS + enrollment pins both sides
  await resetBoth(a, b);
  await startReconnect(a, b); // second meeting: pinned-key re-auth, no human step

  await expect(a.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(b.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(a.getByTestId('auth-state')).toContainText('reconnect'); // authenticated by the pin

  // BOTH sides drop their socket — this is the behaviour that used to be missing here.
  await expect(a.getByText(CLOSE_LOG)).toBeVisible({ timeout: 15_000 });
  await expect(b.getByText(CLOSE_LOG)).toBeVisible({ timeout: 15_000 });

  // Each close makes the OTHER side observe a `peer-left`. On the reconnect path that used to be a
  // hard stop (failReconnect), so this is the race the peerLeftAbortsPairing gate had to close:
  // neither side may drop, and the two settle independently, so give it a moment and re-check.
  await a.waitForTimeout(1500);
  await expect(a.getByTestId('status')).toHaveText('connected');
  await expect(b.getByTestId('status')).toHaveText('connected');

  // And the session is genuinely alive afterwards, not merely not-failed.
  const src = join(TMP, 'reconnect-after-close.bin');
  const payload = randomBytes(256 * 1024);
  writeFileSync(src, payload);

  await a.getByTestId('file-input').setInputFiles(src);
  await a.getByTestId('send-btn').click();
  await expect(b.getByTestId('transfer-phase')).toContainText('offered');

  const downloadPromise = b.waitForEvent('download', { timeout: 60_000 });
  await b.getByTestId('accept-btn').click();
  const download = await downloadPromise;
  const out = join(TMP, 'reconnect-after-close.out');
  await download.saveAs(out);

  await expect(a.getByTestId('transfer-phase')).toContainText('done', { timeout: 30_000 });
  expect(sha256(readFileSync(out)), 'bytes intact over a session whose signaling is gone').toBe(
    sha256(payload),
  );
});
