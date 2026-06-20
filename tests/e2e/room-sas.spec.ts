import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSasRoom as openSasRoom,
  joinSasRoom as fillSasJoin,
  expectSas,
  confirmSas,
  resolveSasParties,
  lobbyConnect,
  readSelfId,
} from './helpers';

/**
 * Step-4a "room" method, end to end through two Chromium tabs:
 *   - A clicks "New SAS room" → the server allocates a PUBLIC 4-digit code, shown in A's UI.
 *   - B enters the code → joins. WebRTC brings up the DataChannel; in PARALLEL a ZRTP-style
 *     commit-reveal of nonces runs over signaling (B commits first, A reveals, B reveals).
 *   - Both sides derive the SAME 3-word SAS from (nonceA, nonceB, DTLS-fingerprint-pair). The
 *     humans compare it out-of-band; mutual "matches" → AUTHENTICATED connected. A "doesn't
 *     match" on either side is a hard stop — no channel, no bytes.
 *
 * Like the other suites, every test forces the RAM-bound Blob receive path (`?forceBlob=1`) so
 * the download is observable (the native FSA dialog can't be automated).
 */

const TMP = join(process.cwd(), 'e2e-tmp-room-sas');

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Build the harness URL, always forcing the Blob receive path, plus any extra dev query. */
function harnessUrl(extraQuery = ''): string {
  return `/?forceBlob=1${extraQuery ? `&${extraQuery}` : ''}`;
}

/** A creates a SAS room; returns the page and the allocated 4-digit code read from A's UI. */
async function createSasRoom(
  context: BrowserContext,
  extraQuery = '',
): Promise<{ sender: Page; code: string }> {
  const sender = await context.newPage();
  await sender.goto(harnessUrl(extraQuery));
  const code = await openSasRoom(sender);
  return { sender, code };
}

/** B joins a SAS room by code. */
async function joinSasRoom(context: BrowserContext, code: string, extraQuery = ''): Promise<Page> {
  const receiver = await context.newPage();
  await receiver.goto(harnessUrl(extraQuery));
  await fillSasJoin(receiver, code);
  return receiver;
}

/** Assert the asymmetric SAS choreography (reader shows phrase; blind picker has it among options). */
async function readMatchingSas(reader: Page, picker: Page): Promise<string> {
  return expectSas(reader, picker);
}

/**
 * The SAS reader/picker role is no longer "creator = reader" — it is fixed per pair by the readable
 * ids (see core/sasRole.ts), so either tab can be the reader. Resolve the real reader/picker at
 * runtime from which tab renders its phrase, instead of assuming the sender is the reader.
 */

test.beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

test('happy path: matching SAS on both sides → authenticated connected → small file transfers intact', async ({
  context,
}) => {
  const { sender, code } = await createSasRoom(context);
  const receiver = await joinSasRoom(context, code);

  // The room is a mesh LOBBY now: the joiner appears in the creator's roster, and the creator PICKS
  // it to raise the 1:1 channel (no more auto-pairing). Assert the roster entry, then pick + verify.
  const receiverId = await readSelfId(receiver);
  await expect(sender.getByTestId(`lobby-peer-${receiverId}`)).toBeVisible({ timeout: 30_000 });

  // Asymmetric SAS: one side READS its phrase, the other is the BLIND picker. The role is fixed by
  // the readable ids (not by who created the room). resolveSasParties does the lobby pick (sender →
  // receiver) and resolves the roles; confirmSas has the picker select the heard phrase → connected.
  const { reader, picker } = await resolveSasParties(sender, receiver);
  await confirmSas(reader, picker);

  await expect(sender.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(receiver.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(sender.getByTestId('auth-state')).toContainText('SAS');
  await expect(receiver.getByTestId('auth-state')).toContainText('SAS');

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

test('mismatch: one side rejects the SAS → both fail, no channel, no transfer', async ({ context }) => {
  const { sender, code } = await createSasRoom(context);
  const receiver = await joinSasRoom(context, code);

  // Resolve the real reader/picker (role is by id, not by create/join). The "none match" button
  // lives on the PICKER (the reader has no options), so we must reject from whichever tab that is.
  const { reader, picker } = await resolveSasParties(sender, receiver);
  await readMatchingSas(reader, picker);

  // The picker reports the words do NOT match (the hard-stop path). Even though the SAS is
  // really identical here, a "doesn't match" click must abort both sides unconditionally.
  await picker.getByTestId('sas-nomatch-btn').click();

  // The rejecting side fails immediately; the other side fails on the relayed reject / teardown.
  await expect(picker.getByTestId('status')).toHaveText('failed', { timeout: 60_000 });
  await expect(reader.getByTestId('status')).toHaveText('failed', { timeout: 60_000 });

  // Neither side ever rendered the file UI (only shown when connected) → no byte crossed.
  await expect(sender.getByTestId('file-input')).toHaveCount(0);
  await expect(receiver.getByTestId('file-input')).toHaveCount(0);
});

test('pre-SAS deadline FIRES: a peer withholds its sas-nonce → the other side fails at the deadline (no hang)', async ({
  context,
}) => {
  // Closes the "pre-SAS pairing deadline untested in the FIRING direction" residual. The pre-SAS
  // deadline (armed at pairing start) is the backstop for a peer that joins, commits, then NEVER
  // reveals its nonce — without it the other side would hang in `pairing` forever. Two DEV-only knobs
  // drive it (prod keeps the fixed 120 s deadline and never stalls — both are tree-shaken out):
  //   - ?stallSasNonce / window.__HUSHSEND_STALL_SAS_NONCE__ — this side reaches the SAS but withholds
  //     its sas-nonce reveal;
  //   - ?preSasTimeoutMs=N / window.__HUSHSEND_PRE_SAS_TIMEOUT_MS__ — shrink the pre-SAS deadline so its
  //     firing is observable in seconds, NOT a real 120 s wait (SEPARATE from the comparison knob).
  const { sender, code } = await createSasRoom(context);
  const receiver = await joinSasRoom(context, code);

  const senderId = await readSelfId(sender);
  const receiverId = await readSelfId(receiver);

  // The SAS RESPONDER is the larger readable id (smaller id = initiator — see core/pairingRole.ts).
  // Make the RESPONDER stall: it commits, then on the initiator's reveal computes the SAS and reaches
  // awaitingSas, but never reveals its own nonce. Give the INITIATOR a tiny pre-SAS deadline so it
  // fails fast; leave the responder on the default so it comfortably reaches awaitingSas first (then it
  // re-arms to the long comparison window and just sits there until the initiator's teardown reaches it).
  const initiatorIsSender = senderId < receiverId;
  const stallPage = initiatorIsSender ? receiver : sender; // larger id = responder = stalls its nonce
  const failPage = initiatorIsSender ? sender : receiver; // smaller id = initiator = fails at the deadline
  await stallPage.evaluate(() => {
    (window as unknown as { __HUSHSEND_STALL_SAS_NONCE__?: boolean }).__HUSHSEND_STALL_SAS_NONCE__ = true;
  });
  await failPage.evaluate(() => {
    (window as unknown as { __HUSHSEND_PRE_SAS_TIMEOUT_MS__?: number }).__HUSHSEND_PRE_SAS_TIMEOUT_MS__ = 6000;
  });

  // Lobby: the joiner is in the creator's roster; the creator PICKS it to start the 1:1 pairing, which
  // arms the pre-SAS deadline on BOTH sides (and the responder sends its commit).
  await expect(sender.getByTestId(`lobby-peer-${receiverId}`)).toBeVisible({ timeout: 30_000 });
  await lobbyConnect(sender, receiverId);

  // The stalling RESPONDER does reach the SAS (it computed the phrase) — it just withholds the reveal.
  // Asserted FIRST, while it is still in awaitingSas (before the initiator's teardown propagates).
  await expect(stallPage.getByTestId('status')).toHaveText('awaitingSas', { timeout: 30_000 });

  // The INITIATOR never receives the responder's nonce → it cannot compute the SAS, stays in `pairing`,
  // and FAILS at the pre-SAS deadline rather than hanging. This is the firing direction under test.
  await expect(failPage.getByTestId('status')).toHaveText('failed', { timeout: 30_000 });
  await expect(failPage.getByTestId('error')).toContainText('timed out');

  // No byte ever crossed — the file UI only renders when connected.
  await expect(sender.getByTestId('file-input')).toHaveCount(0);
  await expect(receiver.getByTestId('file-input')).toHaveCount(0);
});

test('timeout: SAS shown but nobody confirms → fails on the timeout path, no channel, no transfer', async ({
  context,
}) => {
  // Shrink the SAS *comparison* window with the DEV-only `?sasTimeoutMs` override so the timeout
  // branch fires in a few seconds instead of the real 120 s — no fake timers, no 120 s wait. The
  // PRE-SAS pairing deadline keeps its fixed default, so this shrink can't pre-empt the awaitingSas
  // state we assert below. The sender gets the shorter budget so ITS own timer (not the relayed
  // teardown) deterministically fires first → its error is the timeout reason; the receiver keeps a
  // longer budget purely as a backstop (it normally fails first via the torn-down channel).
  const { sender, code } = await createSasRoom(context, 'sasTimeoutMs=3000');
  const receiver = await joinSasRoom(context, code, 'sasTimeoutMs=10000');

  // The SAS IS shown to the human (awaitingSas + 3 EFF short #2 words) — we just never confirm. The
  // phrase is rendered on the READER (resolved by id, may be either tab); read it from there. The
  // sender keeps the shorter (3 s) budget so ITS timer fires first regardless of which role it plays.
  const { reader } = await resolveSasParties(sender, receiver);
  const sas = (await reader.getByTestId('sas-words').textContent())?.trim() ?? '';
  expect(sas.split(/\s+/).filter(Boolean)).toHaveLength(3);

  // Neither human clicks "match"/"don't match". After the (shrunk) comparison window elapses, the
  // sender's own timer takes the SAME failSas → `failed` path as every other SAS failure.
  await expect(sender.getByTestId('status')).toHaveText('failed', { timeout: 30_000 });
  await expect(sender.getByTestId('error')).toContainText('timed out');

  // The peer goes down too (its torn-down channel, or its own backstop timer) — no side hangs.
  await expect(receiver.getByTestId('status')).toHaveText('failed', { timeout: 30_000 });

  // Neither side ever rendered the file UI (only shown when connected) → no byte crossed.
  await expect(sender.getByTestId('file-input')).toHaveCount(0);
  await expect(receiver.getByTestId('file-input')).toHaveCount(0);
});
