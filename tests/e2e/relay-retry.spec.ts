import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  BASE,
  confirmSas,
  createLink,
  createSasRoom,
  createWords,
  enrollViaSas,
  expectSas,
  joinQrByPaste,
  joinSasRoom,
  lobbyConnect,
  pickWords,
  readSelfId,
  resetBoth,
  startReconnect,
} from './helpers';

/**
 * E2E for "Retry with relay" (README § Max-privacy strict model): a pairing that could not connect
 * directly CONTINUES through the relay once both users tap — the same link, the same words, the same
 * room, the same pinned device; nothing is scanned, pasted or typed again.
 *
 * The direct failure is the simulated one (`forceIceFail`, switched off before the taps so the retry
 * can connect). There is no relay in this suite — the signaling server hands out a TURN URL that
 * resolves nowhere — so the retried pair connects on loopback and what is asserted here is the
 * PROTOCOL: who taps, what each screen says, that the retry's PeerConnection is built in Reliable with
 * a TURN entry, that the method's own authentication ran again, that a file arrives, that no second
 * invite was made, and that one tap alone relays nothing. A path that really goes through coturn is
 * the NAT suite's case (tests/nat/nat.spec.ts).
 */

const openContexts: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(openContexts.splice(0).map((c) => c.close().catch(() => {})));
});

async function openTab(browser: Browser, query = ''): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE });
  openContexts.push(context);
  const page = await context.newPage();
  await page.goto(`${BASE}/?forceBlob=1${query}`);
  return page;
}

/** The simulated ICE failure for PeerConnections this tab builds from now on (`?forceIceFail=1`
 *  without a reload — so one tab fails in Max and then connects). */
async function forceIceFail(page: Page, on: boolean): Promise<void> {
  await page.evaluate((v) => {
    (window as unknown as { __HUSHSEND_FORCE_ICE_FAIL__: boolean }).__HUSHSEND_FORCE_ICE_FAIL__ = v;
  }, on);
}

/** Both sides on the direct-failure screen with the retry offered; then the failure is switched off. */
async function expectDirectFailure(...pages: Page[]): Promise<void> {
  for (const page of pages) {
    await expect(page.getByTestId('status')).toHaveText('failed', { timeout: 60_000 });
    await expect(page.getByTestId('relay-retry')).toHaveText('offered');
    await expect(page.getByTestId('direct-fail-hint')).toContainText(/Both of you have to tap it/);
    await expect(page.getByTestId('retry-relay-btn')).toBeVisible();
    await forceIceFail(page, false);
  }
}

/** `auth` is what the transfer screen says authenticated the channel — the method's own check. */
async function expectConnectedInReliable(auth: RegExp, ...pages: Page[]): Promise<void> {
  for (const page of pages) {
    await expect(page.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
    await expect(page.getByTestId('auth-state')).toHaveText(auth);
    await expect(page.getByTestId('ice-mode')).toHaveText('reliable');
    await expect(page.getByTestId('ice-relay')).toHaveText('true');
    // For this visit only: nothing was stored.
    expect(await page.evaluate(() => localStorage.getItem('hushsend.privacy'))).toBeNull();
  }
}

async function sendFile(from: Page, to: Page): Promise<void> {
  const payload = randomBytes(96 * 1024);
  await from
    .getByTestId('file-input')
    .setInputFiles({ name: 'retry.bin', mimeType: 'application/octet-stream', buffer: payload });
  await from.getByTestId('send-btn').click();
  await expect(to.getByTestId('transfer-phase')).toContainText('offered', { timeout: 30_000 });
  const download = to.waitForEvent('download', { timeout: 60_000 });
  await to.getByTestId('accept-btn').click();
  const file = await (await download).path();
  await expect(from.getByTestId('transfer-phase')).toContainText('done', { timeout: 60_000 });
  const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
  expect(sha(readFileSync(file)), 'the received file').toBe(sha(payload));
}

test('link · both tap "Retry with relay": the same pairing connects, a file arrives, no new invite', async ({
  browser,
}) => {
  const sender = await openTab(browser);
  const receiver = await openTab(browser);
  await forceIceFail(sender, true);
  await forceIceFail(receiver, true);

  const link = await createLink(sender, 'qr');
  await joinQrByPaste(receiver, link);
  await expectDirectFailure(sender, receiver);

  // The first tap waits for the second; the other screen says so, and is not moved by it.
  await sender.getByTestId('retry-relay-btn').click();
  await expect(sender.getByTestId('relay-waiting')).toBeVisible({ timeout: 30_000 });
  await expect(sender.getByTestId('status')).toHaveText('awaitingPeer');
  await expect(sender.getByTestId('link-url')).toHaveCount(0);
  await expect(receiver.getByTestId('peer-asks-relay')).toBeVisible();
  await expect(receiver.getByTestId('status')).toHaveText('failed');
  await expect(receiver.getByTestId('ice-mode')).toHaveText('max');
  await expect(receiver.getByTestId('ice-relay')).toHaveText('false');

  await receiver.getByTestId('retry-relay-btn').click();
  await expectConnectedInReliable(/authenticated/, sender, receiver);
  await expect(sender.getByTestId('link-url')).toHaveCount(0);
  await sendFile(sender, receiver);

  await receiver.reload();
  await expect(receiver.getByTestId('privacy-toggle')).toHaveAttribute('aria-checked', 'true');
});

test('one tap only · nothing relays, the wait ends by itself, and "Start over" is the fallback', async ({
  browser,
}) => {
  const sender = await openTab(browser, '&relayRetryWaitMs=4000');
  const receiver = await openTab(browser);
  await forceIceFail(sender, true);
  await forceIceFail(receiver, true);

  const link = await createLink(sender, 'link');
  await joinQrByPaste(receiver, link);
  await expectDirectFailure(sender, receiver);

  await sender.getByTestId('retry-relay-btn').click();
  await expect(sender.getByTestId('relay-waiting')).toBeVisible({ timeout: 30_000 });
  // Alone at the rendezvous: no PeerConnection was built, so no ICE configuration exists at all.
  await expect(sender.getByTestId('ice-mode')).toHaveText('—');
  await expect(sender.getByTestId('ice-relay')).toHaveText('—');

  // The peer never taps. Its side stays what the failure left: Max, no relay.
  await expect(sender.getByTestId('failure')).toHaveAttribute('data-variant', 'retryNoShow', { timeout: 30_000 });
  await expect(receiver.getByTestId('status')).toHaveText('failed');
  await expect(receiver.getByTestId('ice-mode')).toHaveText('max');
  await expect(receiver.getByTestId('ice-relay')).toHaveText('false');

  // The fallback is the behaviour from before the in-place retry: a NEW invite, in Reliable.
  await sender.getByTestId('start-over-btn').click();
  await expect(sender.getByTestId('status')).toHaveText('awaitingPeer', { timeout: 30_000 });
  await expect(sender.getByTestId('link-url')).not.toHaveText(link);
  await expect(sender.getByTestId('link-url')).toHaveText(/#[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
});

test('words · both tap: connected without the words being entered again', async ({ browser }) => {
  const sender = await openTab(browser);
  const receiver = await openTab(browser);
  await forceIceFail(sender, true);
  await forceIceFail(receiver, true);

  const words = await createWords(sender);
  await pickWords(receiver, words);
  await expectDirectFailure(sender, receiver);

  await receiver.getByTestId('retry-relay-btn').click();
  await expect(receiver.getByTestId('relay-waiting')).toBeVisible({ timeout: 30_000 });
  await expect(sender.getByTestId('peer-asks-relay')).toBeVisible();
  await sender.getByTestId('retry-relay-btn').click();

  await expectConnectedInReliable(/authenticated/, sender, receiver);
  await sendFile(receiver, sender);
});

test('room · both tap: no code, no pick — the SAS runs over the new channel and both confirm', async ({
  browser,
}) => {
  const a = await openTab(browser);
  const b = await openTab(browser);
  await forceIceFail(a, true);
  await forceIceFail(b, true);

  const code = await createSasRoom(a);
  await joinSasRoom(b, code);
  await expect(b.getByTestId('status')).toHaveText('awaitingPeer', { timeout: 60_000 });
  await lobbyConnect(a, await readSelfId(b));
  await expectDirectFailure(a, b);

  await a.getByTestId('retry-relay-btn').click();
  await expect(a.getByTestId('relay-waiting')).toBeVisible({ timeout: 30_000 });
  await expect(a.getByTestId('room-code')).toHaveCount(0);
  await b.getByTestId('retry-relay-btn').click();

  // Straight to the comparison: the rendezvous is 1:1, nobody picks anybody.
  await expect(a.getByTestId('status')).toHaveText('awaitingSas', { timeout: 60_000 });
  await expect(b.getByTestId('status')).toHaveText('awaitingSas', { timeout: 60_000 });
  const aReads = (await a.getByTestId('sas-words').count()) > 0;
  const [reader, picker] = aReads ? [a, b] : [b, a];
  await expectSas(reader, picker);
  await confirmSas(reader, picker);

  await expectConnectedInReliable(/SAS confirmed/, a, b);
});

test('reconnect · both tap: the pinned device is met again through Reliable, no code', async ({ browser }) => {
  const a = await openTab(browser);
  const b = await openTab(browser);
  await enrollViaSas(a, b);
  await resetBoth(a, b);
  await forceIceFail(a, true);
  await forceIceFail(b, true);

  await startReconnect(a, b);
  await expectDirectFailure(a, b);

  await b.getByTestId('retry-relay-btn').click();
  await expect(b.getByTestId('relay-waiting')).toBeVisible({ timeout: 30_000 });
  await expect(a.getByTestId('peer-asks-relay')).toBeVisible();
  await a.getByTestId('retry-relay-btn').click();

  for (const page of [a, b]) {
    await expect(page.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
    await expect(page.getByTestId('auth-state')).toContainText('reconnect');
    await expect(page.getByTestId('ice-mode')).toHaveText('reliable');
  }
});

test('mixed pair · the Reliable side reads "Try again", and the pairing continues once both tap', async ({
  browser,
}) => {
  const sender = await openTab(browser);
  const receiver = await openTab(browser);
  await sender.getByTestId('privacy-reliable').click();
  await expect(sender.getByTestId('privacy-reliable')).toHaveAttribute('aria-checked', 'true');
  await expect(receiver.getByTestId('privacy-toggle')).toHaveAttribute('aria-checked', 'true');
  await forceIceFail(sender, true);
  await forceIceFail(receiver, true);

  const link = await createLink(sender, 'qr');
  await joinQrByPaste(receiver, link);

  await expect(sender.getByTestId('status')).toHaveText('failed', { timeout: 60_000 });
  await expect(receiver.getByTestId('status')).toHaveText('failed', { timeout: 60_000 });
  await expect(sender.getByTestId('no-relay-path-hint')).toContainText(/ask them to tap “Retry with relay”/);
  await expect(sender.getByTestId('retry-relay-btn')).toHaveText('Try again');
  await expect(receiver.getByTestId('direct-fail-hint')).toBeVisible();
  await expect(receiver.getByTestId('retry-relay-btn')).toHaveText('Retry with relay');
  await forceIceFail(sender, false);
  await forceIceFail(receiver, false);

  await receiver.getByTestId('retry-relay-btn').click();
  await expect(receiver.getByTestId('relay-waiting')).toBeVisible({ timeout: 30_000 });
  // The Reliable side is told, and still has to tap: a frame from the server restarts nothing.
  await expect(sender.getByTestId('peer-asks-relay')).toBeVisible();
  await expect(sender.getByTestId('status')).toHaveText('failed');
  await sender.getByTestId('retry-relay-btn').click();

  for (const page of [sender, receiver]) {
    await expect(page.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
    await expect(page.getByTestId('ice-mode')).toHaveText('reliable');
  }
  await sendFile(sender, receiver);
});

/** Runs in the page, before the app: once `window.__rewriteDescriptions` is set, every offer / answer
 *  this tab sends gets a second fingerprint line — what its peer would receive from a server that
 *  rewrote it (tests/e2e/fingerprint.spec.ts has the same stand-in for a first pairing). */
function rewriteDescriptionsOnDemand(): void {
  const another =
    'a=fingerprint:sha-256 ' +
    Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (this: WebSocket, data: Parameters<WebSocket['send']>[0]): void {
    const w = window as unknown as { __rewriteDescriptions?: boolean; __rewritten?: number };
    if (w.__rewriteDescriptions && typeof data === 'string' && data.includes('a=fingerprint:')) {
      const frame = JSON.parse(data) as { data?: { description?: { sdp?: string } } };
      const d = frame.data?.description;
      const honest = d?.sdp ? /a=fingerprint:\S+ \S+/.exec(d.sdp)?.[0] : undefined;
      if (d?.sdp && honest) {
        d.sdp = d.sdp.replace(honest, `${honest}\r\n${another}`);
        w.__rewritten = (w.__rewritten ?? 0) + 1;
        data = JSON.stringify(frame);
      }
    }
    send.call(this, data);
  };
}

test('link · a description naming a second certificate in the retry is refused: the retry fails closed', async ({
  browser,
}) => {
  const receiver = await openTab(browser);
  const context = await browser.newContext({ baseURL: BASE });
  openContexts.push(context);
  const sender = await context.newPage();
  await sender.addInitScript(rewriteDescriptionsOnDemand);
  await sender.goto(`${BASE}/?forceBlob=1`);
  await forceIceFail(sender, true);
  await forceIceFail(receiver, true);

  const link = await createLink(receiver, 'qr');
  await joinQrByPaste(sender, link);
  await expectDirectFailure(sender, receiver);
  // From here on the "server" rewrites what the sender's side of the retry says about its certificate.
  await sender.evaluate(() => {
    (window as unknown as { __rewriteDescriptions: boolean }).__rewriteDescriptions = true;
  });

  await receiver.getByTestId('retry-relay-btn').click();
  await sender.getByTestId('retry-relay-btn').click();

  await expect(receiver.getByTestId('failure')).toHaveAttribute('data-variant', 'mismatch', { timeout: 60_000 });
  await expect(receiver.getByTestId('failure')).toHaveAttribute('data-reason', /tampered with/);
  // The retry was the one retry: nothing is offered again, and nothing connected.
  await expect(receiver.getByTestId('relay-retry')).toHaveText('active');
  await expect(receiver.getByTestId('retry-relay-btn')).toHaveCount(0);
  await expect(sender.getByTestId('status')).toHaveText('failed', { timeout: 60_000 });
  for (const page of [receiver, sender]) await expect(page.getByTestId('auth-state')).toHaveCount(0);
  expect(await sender.evaluate(() => (window as unknown as { __rewritten?: number }).__rewritten ?? 0)).toBeGreaterThan(0);
});

