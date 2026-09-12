import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { BASE, createLink, fragmentOf } from './helpers';

/**
 * SIZE-LIMIT LADDER — where does each ENGINE actually stop? (step 6e, no devices needed.)
 *
 * The Blob receive path holds the whole file in the receiving tab's memory, so the ceiling is the
 * engine's, not ours: JS heap / ArrayBuffer maxima, Blob storage behaviour and download plumbing all
 * differ between Chromium, Gecko and WebKit. The app's own cap (MAX_BYTES_DESKTOP_BLOB, 1 GiB) is a
 * POLICY guess on top of that — this ladder is how we find out whether the guess is honest,
 * especially for WebKit, where a 1 GiB in-memory Blob is the least likely to survive.
 *
 * The cap is lifted here (`__HUSHSEND_MAX_BYTES__`) precisely so the ENGINE is what fails, not our
 * pre-accept guard. Each rung: send a file of N MB over a link pairing, accept, download, hash. The
 * ladder stops at the first rung that fails and prints a table — the failure IS the result, so only
 * the smallest rung is asserted (if that breaks, something is wrong beyond size).
 *
 * OPT-IN, because it is slow and RAM-hungry:
 *   E2E_LIMITS=1 npx playwright test tests/e2e/limits.spec.ts --project=webkit
 *   E2E_LIMITS=1 E2E_LIMITS_SIZES=128,256,512,1024,1536,2048 npx playwright test ... # full ladder
 *
 * RAM, read this before raising the sizes: the RECEIVING tab holds ~N MB, and saving the download
 * copies it again. On a 6 GB box that also runs production services, a 2 GB rung risks the OOM
 * killer picking something that is not the browser. Run the big rungs on a workstation.
 */

const LADDER_ENABLED = process.env.E2E_LIMITS === '1';
// Conservative default: safe next to live services on a small host. Override for a real ladder.
const SIZES_MB = (process.env.E2E_LIMITS_SIZES ?? '128,256,512')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

const TMP = join(process.cwd(), 'e2e-tmp-limits');
/** Lifted far above MAX_BYTES_DESKTOP_BLOB so OUR pre-accept guard never fires — we want the engine. */
const CAP_OVERRIDE = 8 * 1024 * 1024 * 1024;

/** Write `mb` megabytes of random-ish data without ever holding it in memory; return its sha256. */
async function makeFile(path: string, mb: number): Promise<string> {
  const hash = createHash('sha256');
  const chunk = randomBytes(8 * 1024 * 1024);
  const out = createWriteStream(path);
  const chunks = Math.ceil(mb / 8);
  await pipeline(
    (function* () {
      for (let i = 0; i < chunks; i++) {
        // Vary each chunk so the file is not trivially compressible along the wire.
        chunk.writeUInt32LE(i, 0);
        hash.update(chunk);
        yield chunk;
      }
    })(),
    out,
  );
  return hash.digest('hex');
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

interface Rung {
  mb: number;
  ok: boolean;
  seconds: number;
  detail: string;
}

/** First line of an error, trimmed — enough to identify it, short enough for a table row. */
function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0].trim().slice(0, 120);
}

/**
 * Run one phase with a NAME attached to any failure. Without this the ladder reports things like
 * "expect(locator).toHaveText(expected) failed", which cannot distinguish "the two tabs never
 * paired" from "the bytes never arrived" — and those have completely different causes (ICE/mDNS vs
 * an actual engine size limit). The label is the whole point of the table.
 */
async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new Error(`${label} — ${firstLine(err)}`);
  }
}

/** One rung: pair two tabs, push an `mb`-sized file, verify the received bytes. Throws on failure. */
async function runRung(context: BrowserContext, mb: number): Promise<number> {
  const src = join(TMP, `src-${mb}.bin`);
  const out = join(TMP, `out-${mb}.bin`);
  const srcHash = await makeFile(src, mb);

  let sender: Page | null = null;
  let receiver: Page | null = null;
  let wireSeconds = 0;
  try {
    sender = await context.newPage();
    await sender.goto('/?forceBlob=1');
    const link = await step('could not create the invite', () => createLink(sender!, 'link'));

    receiver = await context.newPage();
    await receiver.goto(`/?forceBlob=1${fragmentOf(link)}`);
    // Pairing has nothing to do with SIZE — if it fails, the ladder is measuring the stand, not the
    // engine's limit (WebKit with no mDNS responder and no STUN is the usual culprit: it only offers
    // `<uuid>.local` host candidates. Pass E2E_STUN_URLS).
    await step('never reached connected — pairing/ICE, not a size limit', async () => {
      await expect(sender!.getByTestId('status')).toHaveText('connected', { timeout: 90_000 });
      await expect(receiver!.getByTestId('status')).toHaveText('connected', { timeout: 90_000 });
    });

    await sender.getByTestId('file-input').setInputFiles(src);
    await sender.getByTestId('send-btn').click();
    await step('the offer never reached the receiver', () =>
      expect(receiver!.getByTestId('transfer-phase')).toContainText('offered', { timeout: 60_000 }),
    );

    // A big transfer needs a window proportional to its size, not a fixed one.
    const windowMs = Math.max(120_000, mb * 4_000);
    const downloadPromise = receiver.waitForEvent('download', { timeout: windowMs });
    // Time the WIRE only — from accept to the sender reporting done. Pairing and the local hashing
    // below are real cost but constant-ish, and folding them in makes the MB/s figure meaningless
    // for comparing engines.
    const wireStart = Date.now();
    await receiver.getByTestId('accept-btn').click();
    // THIS is the rung's real question: does the engine survive holding and delivering `mb` MB?
    const download = await step('transfer never completed (engine limit / OOM / stall)', async () => {
      const d = await downloadPromise;
      await expect(sender!.getByTestId('transfer-phase')).toContainText('done', { timeout: windowMs });
      return d;
    });
    wireSeconds = (Date.now() - wireStart) / 1000;
    await step('the download could not be saved', () => download.saveAs(out));

    await step('the received bytes were wrong', async () => {
      expect(statSync(out).size, 'received byte count').toBe(mb * 1024 * 1024);
      expect(await sha256File(out), 'received bytes match what was sent').toBe(srcHash);
    });
    return wireSeconds;
  } finally {
    await receiver?.close();
    await sender?.close();
    rmSync(src, { force: true });
    rmSync(out, { force: true });
  }
}

test.describe('engine size-limit ladder', () => {
  test.skip(!LADDER_ENABLED, 'opt-in: set E2E_LIMITS=1 (slow, RAM-hungry — read the header first)');

  test.beforeAll(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });

  test('how large a file survives the Blob receive path on this engine', async ({ browser }, testInfo) => {
    // Generous: the biggest rung dominates, and a timeout here would look like an engine limit.
    testInfo.setTimeout(Math.max(...SIZES_MB) * 4_000 + 300_000);

    const context = await browser.newContext({ baseURL: BASE, acceptDownloads: true });
    // Lift OUR cap so the engine is the only thing that can say no.
    await context.addInitScript((cap: number) => {
      (window as unknown as { __HUSHSEND_MAX_BYTES__?: number }).__HUSHSEND_MAX_BYTES__ = cap;
    }, CAP_OVERRIDE);

    const rungs: Rung[] = [];
    try {
      for (const mb of SIZES_MB) {
        try {
          const seconds = await runRung(context, mb);
          const mbps = (mb / seconds).toFixed(1);
          rungs.push({ mb, ok: true, seconds, detail: `${mbps} MB/s` });
        } catch (err) {
          rungs.push({ mb, ok: false, seconds: 0, detail: firstLine(err) });
          break; // the ceiling is found; bigger rungs would only cost RAM
        }
      }
    } finally {
      await context.close();
    }

    const table = rungs
      .map((r) => `  ${String(r.mb).padStart(5)} MB  ${r.ok ? 'OK  ' : 'FAIL'}  ${r.detail}`)
      .join('\n');
    const report = `size-limit ladder [${testInfo.project.name}]\n${table}`;
    console.log(report);
    await testInfo.attach('size-limit-ladder.txt', { body: report, contentType: 'text/plain' });

    // The ladder REPORTS a ceiling rather than asserting one — engines and hosts legitimately differ.
    // Only the smallest rung is a real assertion: if that fails, the problem is not size.
    expect(rungs[0]?.ok, `smallest rung (${SIZES_MB[0]} MB) must transfer on any engine`).toBe(true);
  });
});
