import { test, expect, type Browser, type Page, type BrowserContext } from '@playwright/test';
import { BASE, createWords, pickWords } from './helpers';

// Every tab here holds a LIVE WebRTC connection: even after its signaling socket closes on connect
// (which it does — see ws-close.spec.ts), the PeerConnection keeps running ICE keepalives and DTLS.
// A context that is never closed therefore keeps working until the WORKER exits, not until the test
// ends, so they accumulate across the file and then across the whole run. Measured 2026-09-13: a full
// chromium suite peaks at 31 browser processes, and on a 2-core CI runner that contention is what
// turns a 2-second reconnect into a 60-second timeout — the failure mode reconnect.spec.ts documented
// and fixed for itself. Same fix, applied here. (See BACKLOG § Third pass.)
test.afterEach(async () => {
  await Promise.all(openContexts.splice(0).map((c) => c.close().catch(() => {})));
});

/**
 * E2E for the privacy toggle + TURN relay (step 6d, client side).
 *
 * The home "Max privacy" toggle is now FUNCTIONAL and drives the WebRTC iceServers:
 *   - Max-privacy (DEFAULT, switch ON): direct-only — STUN at most, NEVER a TURN relay, and the
 *     client never even requests creds. Existing flows are unchanged (they connect over loopback).
 *   - Reliable (switch OFF): the client requests short-lived coturn creds via `turn-request` and
 *     assembles a TURN iceServer from them, so a pair that can't connect directly can relay.
 *
 * We assert the toggle renders + flips, that Max-privacy still connects directly (no TURN), and that
 * Reliable fetches creds and builds a correct TURN entry. We do NOT run an actual relay (no coturn) —
 * both modes connect over loopback host candidates; the TURN URL in the test env is a placeholder.
 * The ICE config the PeerConnection was built with is read from the DEV diagnostics strip.
 *
 * Isolated contexts (own localStorage) per tab so the persisted pref is set explicitly per side and
 * doesn't bleed across tests.
 */


/** `extraQuery` appends DEV-only knobs (e.g. `&forcePathMismatch=1`) to this tab's URL alone, so one
 *  side of a pair can be driven into a branch while the other stays honest. */
/** Contexts opened by the current test, closed after it — see the afterEach below. */
const openContexts: BrowserContext[] = [];

async function openIsolatedTab(browser: Browser, extraQuery = ''): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE });
  openContexts.push(context);
  const page = await context.newPage();
  await page.goto(`${BASE}/?forceBlob=1${extraQuery}`);
  return page;
}

/** Read the toggle's current state (aria-checked: true = Max-privacy ON, false = Reliable). */
async function isMaxPrivacy(page: Page): Promise<boolean> {
  return (await page.getByTestId('privacy-toggle').getAttribute('aria-checked')) === 'true';
}

/** Set the privacy toggle to the desired mode on the landing screen (idempotent). */
async function setPrivacy(page: Page, mode: 'max' | 'reliable'): Promise<void> {
  const wantMax = mode === 'max';
  if ((await isMaxPrivacy(page)) !== wantMax) await page.getByTestId('privacy-toggle').click();
  await expect(page.getByTestId('privacy-toggle')).toHaveAttribute('aria-checked', String(wantMax));
}

test('privacy · toggle renders, defaults to Max-privacy, and flips both ways', async ({ browser }) => {
  const page = await openIsolatedTab(browser);
  // Default is Max-privacy (switch ON / aria-checked true).
  await expect(page.getByTestId('privacy-toggle')).toHaveAttribute('aria-checked', 'true');
  // Flip to Reliable, then back to Max — the switch tracks both ways, and the description follows.
  await page.getByTestId('privacy-toggle').click();
  await expect(page.getByTestId('privacy-toggle')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('privacy-desc')).toContainText('relay');
  await page.getByTestId('privacy-toggle').click();
  await expect(page.getByTestId('privacy-toggle')).toHaveAttribute('aria-checked', 'true');
});

test('privacy · Max-privacy connects DIRECTLY — no TURN, no relay (existing flow unchanged)', async ({
  browser,
}) => {
  const sender = await openIsolatedTab(browser);
  const receiver = await openIsolatedTab(browser);
  await setPrivacy(sender, 'max');
  await setPrivacy(receiver, 'max');

  const words = await createWords(sender);
  await pickWords(receiver, words);

  await expect(sender.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(receiver.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });

  // The PeerConnection was built direct-only: Max-privacy mode, no relay, no TURN entry.
  await expect(sender.getByTestId('ice-mode')).toHaveText('max');
  await expect(sender.getByTestId('ice-relay')).toHaveText('false');
  await expect(sender.getByTestId('ice-turn-urls')).toHaveText('');
  await expect(sender.getByTestId('ice-turn-username')).toHaveText('');
});

test('reliable · fetches coturn creds via turn-request and builds a TURN iceServer', async ({ browser }) => {
  const sender = await openIsolatedTab(browser);
  const receiver = await openIsolatedTab(browser);
  // Reliable on the sender (the side we assert); the receiver may be either — both connect over
  // loopback host candidates regardless (we never run an actual relay).
  await setPrivacy(sender, 'reliable');
  await setPrivacy(receiver, 'reliable');

  const words = await createWords(sender);
  await pickWords(receiver, words);

  await expect(sender.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(receiver.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });

  // The sender requested creds and assembled a TURN iceServer from the server's reply: Reliable mode,
  // relay added, the configured TURN url, and a NON-empty username + credential (the per-session HMAC
  // creds the server minted — proving the client wired {urls, username, credential} correctly).
  await expect(sender.getByTestId('ice-mode')).toHaveText('reliable');
  await expect(sender.getByTestId('ice-relay')).toHaveText('true');
  await expect(sender.getByTestId('ice-turn-urls')).toContainText('turn:turn.example.org:3478');
  await expect(sender.getByTestId('ice-turn-username')).not.toHaveText('');
  await expect(sender.getByTestId('ice-turn-credential')).not.toHaveText('');
});

/**
 * Path attestation (core/pathAttest.ts) must actually REACH A VERDICT, not sit silently at
 * "unknown". `unknown` is benign by design — a missing API must not kill a working connection —
 * which means a wholly broken implementation would look exactly like a working one from the outside.
 * This test is the thing that tells them apart: a real SAME-ENGINE pair must resolve to `ok` and name
 * the address it actually selected.
 *
 * It is deliberately same-engine. A firefox↔webkit pair resolves to `mismatch` with no attacker
 * present — WebKit cannot disable mDNS obfuscation, so it cannot attest to the address its peer
 * reached it on — which is exactly why the verdict is ADVISORY and gates nothing. See
 * SessionController.startPathAttestation and BACKLOG § Security audit.
 */
test('path attestation resolves to ok on a real connection (not silently unknown)', async ({ browser }) => {
  const sender = await openIsolatedTab(browser);
  const receiver = await openIsolatedTab(browser);

  const words = await createWords(sender);
  await pickWords(receiver, words);

  await expect(sender.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(receiver.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });

  // BOTH sides attest and both verify — the check is symmetric, so a one-sided pass is a bug.
  await expect(sender.getByTestId('path-verdict')).toHaveText('ok', { timeout: 30_000 });
  await expect(receiver.getByTestId('path-verdict')).toHaveText('ok', { timeout: 30_000 });

  // And it verified a real address, not an empty projection.
  await expect(sender.getByTestId('path-selected')).not.toHaveText('—');
  await expect(sender.getByTestId('path-selected')).not.toHaveText('');

  // The USER-FACING badge follows the verdict. `ok` is the only one that reassures — and it carries
  // the verdict as a data attribute so the three states can be told apart from the outside.
  await expect(sender.getByTestId('path-state')).toContainText('confirmed');
  await expect(sender.getByTestId('path-state')).toHaveAttribute('data-path-verdict', 'ok');
  await expect(sender.getByTestId('path-state')).toHaveClass(/hs-badge--verified/);
  await expect(receiver.getByTestId('path-state')).toHaveClass(/hs-badge--verified/);
  // `ok` shows no hint at all — there is nothing to caveat.
  await expect(sender.getByTestId('path-hint')).toHaveCount(0);
});

/**
 * F2 REGRESSION (2026-09-13). `mismatch` — the only positive evidence of an interposer this system
 * can produce — used to be projected as `pathConfirmed: 'no'`, the SAME value as `unknown`, which is
 * the everyday outcome on Safari. So the badge, its class and its hint were all identical to the
 * benign case, and the hint asserted the cause was "this browser does not expose enough to check it"
 * — false on a mismatch, where the check ran and disagreed. The DEV diagnostics that hold the real
 * verdict are tree-shaken out of production, so there was no other signal anywhere.
 *
 * `?forcePathMismatch=1` (DEV-only) stubs the VERDICT and nothing else: the attestation runs for
 * real, and the projection, badge, hint and teardown below are all production code. Asserted on ONE
 * side only — the knob rides that tab's URL — which also proves the states are per-side.
 *
 * Note what is deliberately NOT asserted: a teardown. The check is still ADVISORY and gates no byte
 * (BACKLOG § Security audit); this test pins what the human is TOLD, not a control.
 */
test('path MISMATCH is shown differently from "could not check", and does not blame the browser', async ({
  browser,
}) => {
  const sender = await openIsolatedTab(browser, '&forcePathMismatch=1');
  const receiver = await openIsolatedTab(browser);

  const words = await createWords(sender);
  await pickWords(receiver, words);

  await expect(sender.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });
  await expect(receiver.getByTestId('status')).toHaveText('connected', { timeout: 60_000 });

  // The forcing side reports mismatch; the honest side still reaches ok — so this is the UI under
  // test, not a broken pairing.
  await expect(sender.getByTestId('path-verdict')).toHaveText('mismatch', { timeout: 30_000 });
  await expect(receiver.getByTestId('path-verdict')).toHaveText('ok', { timeout: 30_000 });

  // DISTINCT from both other states: its own verdict attribute, its own label, its own weight.
  const badge = sender.getByTestId('path-state');
  await expect(badge).toHaveAttribute('data-path-verdict', 'mismatch');
  await expect(badge).toHaveClass(/hs-badge--alert/);
  await expect(badge).not.toHaveClass(/hs-badge--verified/);
  await expect(badge).not.toContainText('not confirmed'); // the `unknown` label

  // And the hint must NOT be the `unknown` copy, whose explanation is untrue here.
  const hint = sender.getByTestId('path-hint');
  await expect(hint).toHaveClass(/hs-path__hint--alert/);
  await expect(hint).not.toContainText('Safari never does');
  await expect(hint).toContainText('not one your correspondent listed');
  await expect(hint).toContainText('still encrypted end-to-end'); // never a content scare
  await expect(hint).toContainText('different network'); // something to actually do

  // The honest side is untouched: benign states must not inherit the alarm.
  await expect(receiver.getByTestId('path-state')).toHaveClass(/hs-badge--verified/);
  await expect(receiver.getByTestId('path-hint')).toHaveCount(0);
});

/**
 * STUN cross-check (core/stunCheck.ts) must actually REACH a verdict when two servers are
 * configured, not sit at `unknown`.
 *
 * Same argument as the path-attestation test above: `unknown` is benign by design — an engine that
 * reports no server-reflexive candidate cannot be forced to — which means a wholly broken
 * implementation would be indistinguishable from a working one from the outside. This is the test
 * that tells them apart.
 *
 * Skipped unless the run supplies TWO STUN URLs, because the default e2e environment has none and a
 * single one is `unknown` BY DESIGN (a lone operator cross-checks nothing). Locally:
 *   E2E_STUN_URLS=stun:127.0.0.1:3478,stun:127.0.0.1:3479
 * CI's engine matrix starts one coturn; a second is a second `--listening-port`.
 */
test('stun cross-check reaches a verdict when two servers are configured', async ({ browser }) => {
  const urls = (process.env.E2E_STUN_URLS ?? '').split(',').filter(Boolean);
  test.skip(urls.length < 2, `needs two STUN URLs, got ${urls.length} — see this test's header`);

  const page = await openIsolatedTab(browser);
  // Two honest servers on the same host see the same address, so `agree` is the expected answer.
  // `disagree` here would be a real finding about the environment, not a flaky test.
  await expect(page.getByTestId('stun-verdict')).toHaveText('agree', { timeout: 30_000 });
  await expect(page.getByTestId('stun-addresses')).not.toHaveText('—');

  // And nothing is shown to the user, because agreement is unremarkable — only a disagreement is.
  await expect(page.getByTestId('stun-state')).toHaveCount(0);
});
