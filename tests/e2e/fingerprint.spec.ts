import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { BASE, createLink, createSasRoom, joinQrByPaste, joinSasRoom, lobbyConnect, readSelfId } from './helpers';

/**
 * E2E for the one-fingerprint rule (src/core/webrtc/fingerprint.ts): a description that names more
 * than one certificate is refused before the engine sees it, and the pairing fails closed BEFORE any
 * channel opens.
 *
 * Where it matters is Firefox ↔ Firefox: Firefox accepts a certificate that matches ANY fingerprint
 * line it was given and keeps them all, so "the first line" need not be the certificate DTLS accepted
 * (docs/test-runs/2026-11-23.md). The file runs in every engine project, each pairing two tabs of
 * that engine.
 *
 * The untrusted server is played from inside one tab: every offer / answer that tab sends gets a
 * second fingerprint line on its way out, which is exactly what the other tab would receive from a
 * server that rewrote it. The honest certificate stays in the description, so nothing here fails for
 * want of a matching certificate — without the rule the Firefox pair simply connects.
 */

type Variant = 'honest-then-another' | 'another-then-honest' | 'another-at-session-level';

/** Runs in the page, before the app: rewrite outgoing descriptions as a server in the middle would. */
function rewriteOutgoingDescriptions(variant: Variant): void {
  const another =
    'a=fingerprint:sha-256 ' +
    Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (this: WebSocket, data: Parameters<WebSocket['send']>[0]): void {
    if (typeof data === 'string' && data.includes('a=fingerprint:')) {
      const frame = JSON.parse(data) as { data?: { description?: { sdp?: string } } };
      const d = frame.data?.description;
      const honest = d?.sdp ? /a=fingerprint:\S+ \S+/.exec(d.sdp)?.[0] : undefined;
      if (d?.sdp && honest) {
        if (variant === 'honest-then-another') d.sdp = d.sdp.replace(honest, `${honest}\r\n${another}`);
        else if (variant === 'another-then-honest') d.sdp = d.sdp.replace(honest, `${another}\r\n${honest}`);
        else {
          // The other line at session level; the honest one at media level, where it is in force.
          const lines = d.sdp.split('\r\n').filter((l) => l !== honest);
          const media = lines.findIndex((l) => l.startsWith('m='));
          let after = media + 1;
          while (/^[cbi]=/.test(lines[after] ?? '')) after++;
          lines.splice(after, 0, honest);
          lines.splice(media, 0, another);
          d.sdp = lines.join('\r\n');
        }
        (window as unknown as { __rewritten: number }).__rewritten =
          ((window as unknown as { __rewritten?: number }).__rewritten ?? 0) + 1;
        data = JSON.stringify(frame);
      }
    }
    send.call(this, data);
  };
}

/** Runs in the page, before the app: count every DataChannel that reaches `open`. */
function countOpenChannels(): void {
  const w = window as unknown as { __channelsOpened: number };
  w.__channelsOpened = 0;
  const watch = (channel: RTCDataChannel): void => channel.addEventListener('open', () => (w.__channelsOpened += 1));
  const create = RTCPeerConnection.prototype.createDataChannel;
  RTCPeerConnection.prototype.createDataChannel = function (this: RTCPeerConnection, ...args) {
    const channel = create.apply(this, args);
    watch(channel);
    return channel;
  };
  window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
    construct(target, args, newTarget) {
      const pc = Reflect.construct(target, args, newTarget) as RTCPeerConnection;
      pc.addEventListener('datachannel', (e) => watch(e.channel));
      return pc;
    },
  });
}

const openContexts: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(openContexts.splice(0).map((c) => c.close().catch(() => {})));
});

async function openTab(browser: Browser, rewrite?: Variant): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE });
  openContexts.push(context);
  const page = await context.newPage();
  await page.addInitScript(countOpenChannels);
  if (rewrite) await page.addInitScript(rewriteOutgoingDescriptions, rewrite);
  await page.goto(`${BASE}/`);
  return page;
}

/** The side that RECEIVED the rewritten description: failed as compromised, no channel ever open. */
async function expectRefused(receiver: Page, sender: Page): Promise<void> {
  await expect(receiver.getByTestId('status')).toHaveText('failed', { timeout: 60_000 });
  await expect(receiver.getByTestId('failure')).toHaveAttribute('data-variant', 'mismatch');
  await expect(receiver.getByTestId('failure')).toHaveAttribute('data-reason', /tampered with/);
  await expect(sender.getByTestId('status')).toHaveText('failed', { timeout: 60_000 });
  for (const page of [receiver, sender]) {
    expect(await page.evaluate(() => (window as unknown as { __channelsOpened: number }).__channelsOpened)).toBe(0);
    await expect(page.getByTestId('auth-state')).toHaveCount(0);
  }
  // The rewrite did happen — this is not a pairing that failed for some other reason.
  expect(await sender.evaluate(() => (window as unknown as { __rewritten?: number }).__rewritten ?? 0)).toBeGreaterThan(0);
}

for (const variant of ['honest-then-another', 'another-then-honest', 'another-at-session-level'] as const) {
  test(`link · a description with a second fingerprint (${variant}) is refused before any channel opens`, async ({
    browser,
  }) => {
    const receiver = await openTab(browser);
    const sender = await openTab(browser, variant);

    const link = await createLink(receiver, 'qr');
    await joinQrByPaste(sender, link);

    await expectRefused(receiver, sender);
  });
}

test('room · a description with a second fingerprint is refused: no SAS is ever shown', async ({ browser }) => {
  const receiver = await openTab(browser);
  const sender = await openTab(browser, 'honest-then-another');

  const code = await createSasRoom(receiver);
  await joinSasRoom(sender, code);
  await expect(sender.getByTestId('status')).toHaveText('awaitingPeer', { timeout: 60_000 });
  await lobbyConnect(receiver, await readSelfId(sender));

  await expectRefused(receiver, sender);
  for (const page of [receiver, sender]) await expect(page.getByTestId('sas-words')).toHaveCount(0);
});
