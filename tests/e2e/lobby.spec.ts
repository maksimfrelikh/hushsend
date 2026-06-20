import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSasRoom,
  joinSasRoom,
  resolveSasParties,
  confirmSas,
  expectSas,
  readSelfId,
  lobbyConnect,
} from './helpers';

/**
 * Step-6 mesh LOBBY for the room method, end to end through Chromium tabs.
 *
 * The 4-digit room is a LOBBY: several peers sit in it (awaitingPeer) seeing a roster, and a human
 * PICKS whom to raise a 1:1 channel with (no auto-pairing). This suite covers what the 2-peer
 * room-sas suite can't:
 *   - joiner↔joiner: a joiner connects to ANOTHER joiner (neither is the creator) → the per-pairing
 *     role (smaller id = initiator/reader) drives a normal SAS → connected → transfer;
 *   - busy-reject: picking a peer already pairing with someone else yields a clear "busy" notice and
 *     leaves the picker in the lobby (no hang), without disturbing the busy peer's session.
 *
 * Every tab forces the RAM-bound Blob receive path (`?forceBlob=1`) so the download is observable.
 * (The test signaling server runs with MAX_PER_IP_PER_ROOM=8 — see playwright.config.ts — so 3
 * loopback tabs can share one room.)
 */

const TMP = join(process.cwd(), 'e2e-tmp-lobby');

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Open a fresh tab on the home screen (Blob receive path forced). */
async function tab(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto('/?forceBlob=1');
  return page;
}

test.beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

test('lobby joiner↔joiner: a joiner connects to ANOTHER joiner → SAS → connected → transfer intact', async ({
  context,
}) => {
  // A creates the room; B and C both JOIN it (neither B nor C is the creator).
  const a = await tab(context);
  const code = await createSasRoom(a);
  const b = await tab(context);
  await joinSasRoom(b, code);
  const c = await tab(context);
  await joinSasRoom(c, code);

  // All three sit in the lobby. B sees C in its roster (and vice-versa). B connects to C — a
  // joiner↔joiner pair. resolveSasParties does the pick and resolves the asymmetric SAS roles
  // (reader/picker by id), which proves the per-pairing role handles a non-creator pair.
  const cId = await readSelfId(c);
  await expect(b.getByTestId(`lobby-peer-${cId}`)).toBeVisible({ timeout: 30_000 });
  const { reader, picker } = await resolveSasParties(b, c);
  await confirmSas(reader, picker);

  await expect(b.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(c.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(b.getByTestId('auth-state')).toContainText('SAS');

  // A small file flows over the joiner↔joiner channel (B → C).
  const src = join(TMP, 'note.bin');
  const payload = randomBytes(200 * 1024);
  writeFileSync(src, payload);
  const srcHash = sha256(payload);

  await b.getByTestId('file-input').setInputFiles(src);
  await b.getByTestId('send-btn').click();
  await expect(c.getByTestId('transfer-phase')).toContainText('offered');

  const downloadPromise = c.waitForEvent('download', { timeout: 60_000 });
  await c.getByTestId('accept-btn').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('note.bin');
  const out = join(TMP, 'note.out');
  await download.saveAs(out);
  await expect(b.getByTestId('transfer-phase')).toContainText('done', { timeout: 30_000 });
  await expect(c.getByTestId('transfer-phase')).toContainText('done', { timeout: 30_000 });
  expect(sha256(readFileSync(out))).toBe(srcHash);
});

test('lobby busy-reject: picking a peer already pairing with someone else → clear "busy", no hang', async ({
  context,
}) => {
  const a = await tab(context);
  const code = await createSasRoom(a);
  const b = await tab(context);
  await joinSasRoom(b, code);
  const c = await tab(context);
  await joinSasRoom(c, code);

  // A connects to B → A and B leave the lobby and run their SAS (both BUSY with each other now).
  const { reader, picker } = await resolveSasParties(a, b);
  await expectSas(reader, picker); // both at awaitingSas — busy with one another

  // C now tries to connect to B. B is busy (pairing with A) → B bounces C with `busy`. C gets a
  // clear notice naming B and stays IN THE LOBBY (back to awaitingPeer) — never a hang.
  const bId = await readSelfId(b);
  await lobbyConnect(c, bId);
  await expect(c.getByTestId('lobby-busy')).toBeVisible({ timeout: 30_000 });
  await expect(c.getByTestId('lobby-busy')).toContainText(bId);
  await expect(c.getByTestId('status')).toHaveText('awaitingPeer', { timeout: 30_000 });

  // B's session with A is undisturbed by the rejected pick — B is still at the SAS comparison.
  await expect(b.getByTestId('status')).toHaveText('awaitingSas');

  // C never reached a transfer surface (only `connected` renders it) → no byte could have crossed.
  await expect(c.getByTestId('file-input')).toHaveCount(0);
});
