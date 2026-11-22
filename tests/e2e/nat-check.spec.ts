import dgram from 'node:dgram';
import os from 'node:os';
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { BASE, createLink, fragmentOf } from './helpers';

/**
 * E2E for the network check (src/core/natCheck.ts) — the REAL check, in each engine, against two STUN
 * servers run by this file.
 *
 * A symmetric NAT cannot be had on demand, but what it looks like from inside the browser can: one
 * socket asks two servers for its address and gets two different ports back. `fakeStun` answers a
 * Binding request with whatever mapped port it is told to, so the pair below IS a symmetric NAT as
 * far as the engine can tell (`portOffset: 1` on the second), an endpoint-independent one (the same
 * port from both), or a network where one destination never answers.
 *
 * `?natCheck=<url>,<url>` (DEV-only) points the check at them; the pairing itself still runs with no
 * STUN at all, as in every other spec, so nothing here depends on a real connection. `forceIceFail`
 * drives the direct failure the warning is about.
 */

const MAPPED_IP = '203.0.113.7'; // TEST-NET-3: an address nothing here can be confused with
const COOKIE = 0x2112a442;

interface FakeStun {
  port: number;
  /** Every Binding request received, as `address:port`. */
  seen: string[];
  close(): void;
}

function fakeStun(host: string, opts: { portOffset?: number; silent?: boolean }): Promise<FakeStun> {
  const seen: string[] = [];
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, from) => {
    if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0001) return; // not a Binding request
    seen.push(`${from.address}:${from.port}`);
    if (opts.silent) return;
    const ip = MAPPED_IP.split('.').map(Number);
    const attr = Buffer.alloc(12); // XOR-MAPPED-ADDRESS, IPv4
    attr.writeUInt16BE(0x0020, 0);
    attr.writeUInt16BE(8, 2);
    attr.writeUInt8(1, 5);
    attr.writeUInt16BE(((from.port + (opts.portOffset ?? 0)) & 0xffff) ^ 0x2112, 6);
    attr.writeUInt32BE((((ip[0] << 24) | (ip[1] << 16) | (ip[2] << 8) | ip[3]) ^ COOKIE) >>> 0, 8);
    const head = Buffer.alloc(20); // Binding success, same cookie + transaction id
    head.writeUInt16BE(0x0101, 0);
    head.writeUInt16BE(attr.length, 2);
    msg.copy(head, 4, 4, 20);
    sock.send(Buffer.concat([head, attr]), from.port, from.address);
  });
  return new Promise((resolve) =>
    sock.bind(0, host, () => resolve({ port: sock.address().port, seen, close: () => sock.close() })),
  );
}

/** Firefox sends nothing to a loopback STUN server (ICE error 701 at once, measured 2026-11-22), so
 *  it needs this machine's own LAN address; Chromium and WebKit take loopback. */
function stunHost(browserName: string): string | null {
  if (browserName !== 'firefox') return '127.0.0.1';
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

const openContexts: BrowserContext[] = [];
const openServers: FakeStun[] = [];
test.afterEach(async () => {
  await Promise.all(openContexts.splice(0).map((c) => c.close().catch(() => {})));
  for (const s of openServers.splice(0)) s.close();
});

async function servers(
  browserName: string,
  second: { portOffset?: number; silent?: boolean },
): Promise<{ a: FakeStun; b: FakeStun; query: string }> {
  const host = stunHost(browserName);
  test.skip(host === null, 'Firefox needs a non-loopback IPv4 address to reach a local STUN server');
  const a = await fakeStun(host!, {});
  const b = await fakeStun(host!, second);
  openServers.push(a, b);
  return { a, b, query: `natCheck=stun:${host}:${a.port},stun:${host}:${b.port}` };
}

async function openTab(browser: Browser, url: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE });
  openContexts.push(context);
  const page = await context.newPage();
  await page.goto(`${BASE}${url}`);
  return page;
}

test('network check · a symmetric NAT is announced on the invite screen and named on the failure screen', async ({
  browser,
  browserName,
}) => {
  const { a, b, query } = await servers(browserName, { portOffset: 1 });
  const sender = await openTab(browser, `/?forceIceFail=1&${query}`);

  // Nothing is asked on page load: the check belongs to the action that starts a pairing.
  await expect(sender.getByTestId('privacy-toggle')).toHaveAttribute('aria-checked', 'true');
  await sender.waitForTimeout(1_000);
  expect(a.seen).toHaveLength(0);
  expect(b.seen).toHaveLength(0);

  const link = await createLink(sender, 'link');
  await expect(sender.getByTestId('nat-warning')).toBeVisible();
  await expect(sender.getByTestId('nat-verdict')).toHaveText('symmetric');
  await expect(sender.getByTestId('nat-warning')).toContainText(/Reliable/);
  // One socket asked both servers — that is what makes two answers a statement about the NAT.
  expect(a.seen.some((from) => b.seen.includes(from))).toBe(true);

  // Advisory: the pairing runs regardless, and the direct failure then says why.
  const receiver = await openTab(browser, `/?forceIceFail=1&${query}${fragmentOf(link)}`);
  await expect(sender.getByTestId('status')).toHaveText('failed', { timeout: 60_000 });
  await expect(receiver.getByTestId('status')).toHaveText('failed', { timeout: 60_000 });
  for (const page of [sender, receiver]) {
    await expect(page.getByTestId('nat-verdict')).toHaveText('symmetric');
    await expect(page.getByTestId('direct-fail-hint')).toContainText(/different address for every destination/);
    await expect(page.getByTestId('direct-fail-hint')).toContainText(/Reliable/);
  }
});

test('network check · one mapping from both servers reads `direct` and shows nothing', async ({
  browser,
  browserName,
}) => {
  // The control: a check that warned whatever it saw would pass the test above too.
  const { query } = await servers(browserName, { portOffset: 0 });
  const sender = await openTab(browser, `/?${query}`);
  await createLink(sender, 'link');
  await expect(sender.getByTestId('nat-verdict')).toHaveText('direct');
  await expect(sender.getByTestId('nat-warning')).toHaveCount(0);
});

test('network check · a destination that never answers reads `unknown`, not `direct`', async ({
  browser,
  browserName,
}) => {
  // One mapping is all a silent second server leaves — exactly what an honest NAT shows. Only the
  // per-server probes tell the two apart (Firefox names no server on its candidates).
  const { b, query } = await servers(browserName, { silent: true });
  const sender = await openTab(browser, `/?${query}`);
  await createLink(sender, 'link');
  await expect(sender.getByTestId('nat-verdict')).toHaveText('unknown', { timeout: 45_000 });
  await expect(sender.getByTestId('nat-warning')).toHaveCount(0);
  expect(b.seen.length).toBeGreaterThan(0); // it was asked; it just did not answer
});

test('network check · Reliable does not run it', async ({ browser, browserName }) => {
  const { a, b, query } = await servers(browserName, { portOffset: 1 });
  const sender = await openTab(browser, `/?${query}`);
  await sender.getByTestId('privacy-reliable').click();
  await expect(sender.getByTestId('privacy-toggle')).toHaveAttribute('aria-checked', 'false');
  await createLink(sender, 'link');
  await sender.waitForTimeout(2_000);
  expect(a.seen).toHaveLength(0);
  expect(b.seen).toHaveLength(0);
  await expect(sender.getByTestId('nat-verdict')).toHaveText('—');
  await expect(sender.getByTestId('nat-warning')).toHaveCount(0);
});
