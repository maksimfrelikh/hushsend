import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { closeSync, ftruncateSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BASE, createLink, forwardConsole, fragmentOf } from './helpers';

/**
 * An AUTHENTICATED channel dying mid-transfer (TESTPLAN F2 / F3; BACKLOG § UX bugs "Peer gone after
 * `connected`"). Before 2026-09-27 nothing after `connected` reacted to it: with the receiver's tab
 * closed at 8 % of a 900 MB send the SENDER sat on "Sending 46 %" for over a minute, and after a real
 * airplane-mode cut both sides stayed "transferring" for good. Expected now: the surviving side ends
 * on the failure screen's connection-lost variant, and the last file is named as NOT delivered.
 *
 * Two shapes of death, because they reach the survivor through different signals:
 *   - a CLOSED tab says goodbye (its browser aborts the SCTP association), so the survivor's
 *     DataChannel closes;
 *   - a CRASHED tab says nothing at all, so the survivor learns only from ICE (`disconnected` →
 *     `failed`) — and meanwhile its screen must admit the connection is interrupted (F2).
 *
 * The file is 190 MiB and SPARSE (no disk, no RAM in the runner): big enough that the tab goes with
 * the sender still pushing and its send buffer full — exactly where the old drain wait hung. It is
 * received into site storage (OPFS, the real path), so a receiver that is cut off must also leave
 * nothing behind there. Each tab is its own browser context, so a crashed renderer cannot take the
 * other tab with it.
 */

const TMP = join(process.cwd(), 'e2e-tmp-connection-lost');
// Under the 200 MiB RAM cap on purpose: an engine whose site storage cannot write (Playwright's
// WebKit) receives through RAM, and it must still take the file. Plenty to be mid-flight at the close.
const SIZE = 190 * 1024 * 1024;

// Every context here holds a live WebRTC connection; close them per test (see ws-close.spec.ts).
const openContexts: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(openContexts.splice(0).map((c) => c.close().catch(() => {})));
});
test.beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});
test.afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function sparseFile(name: string): string {
  const path = join(TMP, name);
  const fd = openSync(path, 'w');
  ftruncateSync(fd, SIZE);
  closeSync(fd);
  return path;
}

async function openTab(browser: Browser, label: string, fragment = ''): Promise<Page> {
  const context = await browser.newContext({ acceptDownloads: true });
  openContexts.push(context);
  const page = await context.newPage();
  forwardConsole(page, label);
  // No `forceBlob`: the receiver takes its real path — site storage (OPFS) on every engine here.
  await page.goto(`${BASE}/${fragment}`);
  return page;
}

/** Pair two tabs over a one-time link and start the 190 MiB send; returns once bytes are arriving. */
async function midTransfer(browser: Browser): Promise<{ sender: Page; receiver: Page }> {
  const sender = await openTab(browser, 'sender');
  const link = await createLink(sender, 'link');
  const receiver = await openTab(browser, 'receiver', fragmentOf(link));
  await expect(sender.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(receiver.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });

  await sender.getByTestId('file-input').setInputFiles(sparseFile('big.bin'));
  await sender.getByTestId('send-btn').click();
  await expect(receiver.getByTestId('transfer-phase')).toContainText('offered');
  await receiver.getByTestId('accept-btn').click();
  await expect(sender.getByTestId('transfer-phase')).toContainText('transferring');
  // "N / <size> bytes (p%)" with N > 0: the first chunks have landed, hundreds of MB are still to go.
  await receiver.waitForFunction(() =>
    /^[1-9]\d* \//.test(
      document.querySelector('[data-testid="transfer-bytes"]')?.textContent?.trim() ?? '',
    ),
  );
  return { sender, receiver };
}

/** The survivor's end state: the connection-lost screen, naming the file and what became of it. */
async function expectLost(page: Page, outcome: RegExp, timeout: number): Promise<void> {
  await expect(page.getByTestId('status')).toHaveText('failed', { timeout });
  await expect(page.getByTestId('failure')).toHaveAttribute('data-variant', 'lost');
  // The mono line names the signal that ended it (engine-dependent: a closed channel, a failed ICE…).
  await expect(page.getByTestId('error')).not.toBeEmpty();
  const last = page.getByTestId('last-transfer');
  await expect(last).toHaveAttribute('data-outcome', 'error');
  await expect(last).toContainText('big.bin');
  await expect(last).toContainText(outcome);
}

test('F3: the receiver closes its tab mid-transfer — the sender says so, and that the file was NOT delivered', async ({
  browser,
}) => {
  const { sender, receiver } = await midTransfer(browser);
  const t0 = Date.now();
  await receiver.close();
  await expectLost(sender, /not delivered/, 30_000);
  console.log(`[connection-lost] the sender noticed a closed receiver after ${Date.now() - t0} ms`);
});

test('the sender closes its tab mid-transfer — the receiver says so, and saves nothing', async ({
  browser,
}) => {
  const { sender, receiver } = await midTransfer(browser);
  let downloads = 0;
  receiver.on('download', () => downloads++);
  await sender.close();
  await expectLost(receiver, /not received/, 30_000);
  expect(downloads, 'a partial file must not be handed to the browser as a download').toBe(0);
  // …nor left in the site's private storage: a failed receive removes its file at once.
  const left = await receiver.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory(); // throws where site storage is unusable
      const dir = await root.getDirectoryHandle('incoming');
      let n = 0;
      for await (const _ of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) n++;
      return n;
    } catch {
      return 0; // never created, or no usable site storage at all
    }
  });
  expect(left, 'files left in site storage').toBe(0);
});

test('F2: the receiver goes SILENT mid-transfer — the sender shows the interruption, then ends as lost', async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'a silent death needs CDP Page.crash (Chromium only)');
  const { sender, receiver } = await midTransfer(browser);
  const cdp = await receiver.context().newCDPSession(receiver);
  const t0 = Date.now();
  // The renderer dies on the spot: no SCTP abort, no DTLS alert — the survivor hears nothing.
  void cdp.send('Page.crash').catch(() => {});
  await expect(sender.getByTestId('interrupted')).toBeVisible({ timeout: 30_000 });
  console.log(`[connection-lost] the sender showed the interruption after ${Date.now() - t0} ms`);
  await expectLost(sender, /not delivered/, 60_000);
  console.log(`[connection-lost] the sender ended the session after ${Date.now() - t0} ms`);
});
