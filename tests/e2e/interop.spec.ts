import {
  test,
  expect,
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserType,
  type LaunchOptions,
} from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASE, CHROME_CHANNEL, CHROME_PATH, createLink, fragmentOf } from './helpers';

/**
 * CROSS-ENGINE interop (step 6e — the part that needs no real devices). The rest of the suite drives
 * two tabs of the SAME Chromium, which proves the protocol but NOT that two different WebRTC stacks
 * agree: SDP dialects, ICE candidate handling, DTLS, and SCTP message sizing are exactly where
 * engines differ, and that is what bites on a real phone-to-laptop transfer.
 *
 * Each test launches TWO REAL BROWSERS (not two contexts) and runs the **link** method end to end —
 * the simplest authenticated path, no words to type and no SAS to compare — then pushes a file over
 * the DataChannel and hashes it. `?forceBlob=1` forces the RAM-bound receive path on both sides,
 * which is also the path Safari and Firefox take for real (no `showSaveFilePicker`).
 *
 * NOT a substitute for the real-device pass (TESTPLAN § B/C): Playwright's WebKit is WebKitGTK on
 * Linux, not Safari on iOS, and there is no camera, no cellular NAT and no cross-network path here.
 * It is the cheap 80% that should fail on this box rather than in someone's hands.
 *
 * Engines that are not installed are SKIPPED, not failed — `npx playwright test` on a machine with
 * only Chrome behaves exactly as before. To install them:
 *   sudo npx playwright install-deps firefox webkit   # system libs (root)
 *   npx playwright install firefox webkit             # browsers (user)
 */

const TMP = join(process.cwd(), 'e2e-tmp-interop');

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

interface Engine {
  name: string;
  type: BrowserType;
  options: LaunchOptions;
}

/**
 * Per-engine launch options. Both mDNS knobs serve the same purpose: two browsers on ONE host must
 * exchange usable host candidates, and an engine that hides local IPs behind `*.local` names needs a
 * working mDNS responder to resolve them — which a headless box has no reason to run. WebKit exposes
 * no such switch, so that pair depends on whatever WebKitGTK does by default.
 */
const ENGINES: Record<string, Engine> = {
  chrome: {
    name: 'chrome',
    type: chromium,
    options: {
      ...(CHROME_CHANNEL ? { channel: CHROME_CHANNEL } : {}),
      ...(CHROME_PATH ? { executablePath: CHROME_PATH } : {}),
      args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
    },
  },
  firefox: {
    name: 'firefox',
    type: firefox,
    options: { firefoxUserPrefs: { 'media.peerconnection.ice.obfuscate_host_addresses': false } },
  },
  webkit: { name: 'webkit', type: webkit, options: {} },
};

/** Launch an engine, or SKIP the test when that browser is not installed on this host. */
async function launchOrSkip(engine: Engine): Promise<Browser> {
  try {
    return await engine.type.launch(engine.options);
  } catch (err) {
    const first = (err as Error).message.split('\n')[0];
    // Print it: a skipped test whose REASON is invisible is worse than a failing one — you cannot
    // tell "browser absent" from "our launch options are wrong".
    console.error(`[interop] cannot launch ${engine.name}: ${first}`);
    test.skip(true, `${engine.name} is not installed here (${first}) — see the header for install commands`);
    throw err; // unreachable: test.skip throws
  }
}

/** The full link flow across two browsers: pair → authenticated → a file crosses intact. */
async function pairAndTransfer(sending: Browser, receiving: Browser, label: string): Promise<void> {
  const senderCtx = await sending.newContext({ baseURL: BASE, acceptDownloads: true });
  const receiverCtx = await receiving.newContext({ baseURL: BASE, acceptDownloads: true });
  try {
    const sender = await senderCtx.newPage();
    await sender.goto('/?forceBlob=1');
    const link = await createLink(sender, 'link');

    // The joiner opens the one-time link: its fragment carries the token + secret S.
    const receiver = await receiverCtx.newPage();
    await receiver.goto(`/?forceBlob=1${fragmentOf(link)}`);

    // Cross-engine ICE + DTLS can be slower than same-browser loopback — hence the wide windows.
    await expect(sender.getByTestId('status')).toHaveText('connected', { timeout: 90_000 });
    await expect(receiver.getByTestId('status')).toHaveText('connected', { timeout: 90_000 });
    await expect(sender.getByTestId('auth-state')).toContainText('authenticated');
    await expect(receiver.getByTestId('auth-state')).toContainText('authenticated');

    // ~200 KB = several SCTP chunks, so chunk sizing (clamped to the negotiated maxMessageSize)
    // is exercised rather than a single-message shortcut.
    const src = join(TMP, `${label}.bin`);
    const payload = randomBytes(200 * 1024);
    writeFileSync(src, payload);

    await sender.getByTestId('file-input').setInputFiles(src);
    await sender.getByTestId('send-btn').click();
    await expect(receiver.getByTestId('transfer-phase')).toContainText('offered', { timeout: 30_000 });

    const downloadPromise = receiver.waitForEvent('download', { timeout: 90_000 });
    await receiver.getByTestId('accept-btn').click();
    const download = await downloadPromise;
    const out = join(TMP, `${label}.out`);
    await download.saveAs(out);

    await expect(sender.getByTestId('transfer-phase')).toContainText('done', { timeout: 60_000 });
    await expect(receiver.getByTestId('transfer-phase')).toContainText('done', { timeout: 60_000 });
    expect(sha256(readFileSync(out)), 'received bytes match what was sent').toBe(sha256(payload));
  } finally {
    await senderCtx.close();
    await receiverCtx.close();
  }
}

test.beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

// Both directions matter: the link CREATOR and the JOINER run different halves of the handshake
// (offer/answer, and which side confirms first), so chrome→firefox is not the same test as
// firefox→chrome. Same-engine pairs are already covered by the rest of the suite.
const PAIRS: Array<[string, string]> = [
  ['chrome', 'firefox'],
  ['firefox', 'chrome'],
  ['chrome', 'webkit'],
  ['webkit', 'chrome'],
  ['firefox', 'webkit'],
];

for (const [from, to] of PAIRS) {
  test(`interop · ${from} → ${to}: link pairing authenticates and a file crosses intact`, async () => {
    const sending = await launchOrSkip(ENGINES[from]);
    let receiving: Browser;
    try {
      receiving = await launchOrSkip(ENGINES[to]);
    } catch (err) {
      await sending.close();
      throw err;
    }
    try {
      await pairAndTransfer(sending, receiving, `${from}-to-${to}`);
    } finally {
      await sending.close();
      await receiving.close();
    }
  });
}
