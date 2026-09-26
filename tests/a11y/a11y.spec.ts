import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { SCENES, THEMES, open, dispatch } from '../../visual/scenes';

/**
 * Automated accessibility checks.
 *
 * Two halves, on purpose. axe-core catches the machine-checkable part — names, roles, contrast,
 * duplicate ids — which is maybe a third of what actually breaks for a keyboard or screen-reader
 * user. The behavioural tests below cover the rest: the focus and keyboard contracts no static rule
 * can see, and which are exactly what regresses when someone refactors a control.
 */

// Normative only. `best-practice` is useful to read but not to gate on.
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function scan(page: Page) {
  return new AxeBuilder({ page }).withTags([...WCAG]).analyze();
}

/** Failure output that names the rule and the node, instead of "expected 0". */
function report(results: Awaited<ReturnType<typeof scan>>) {
  return results.violations
    .map(
      (v) =>
        `${v.id} (${v.impact}) — ${v.help}\n` +
        v.nodes.map((n) => `    ${n.target.join(' ')}`).join('\n'),
    )
    .join('\n\n');
}

/* ------------------------------------------------------------------
   axe over every screen state, both themes.
   ------------------------------------------------------------------ */

for (const theme of THEMES) {
  for (const scene of SCENES) {
    test(`axe: ${scene.name} · ${theme}`, async ({ page }, testInfo) => {
      // The state matrix is the same on both projects; the phone project exists for the listbox.
      test.skip(
        testInfo.project.name === 'phone' &&
          !['home-empty', 'words-enter', 'lobby', 'transfer-sending'].includes(scene.name),
        'desktop covers the matrix',
      );
      await open(page, theme, scene);
      const results = await scan(page);
      expect(report(results), report(results)).toBe('');
    });
  }
}

/* ------------------------------------------------------------------
   Keyboard contracts — the part axe cannot see.
   ------------------------------------------------------------------ */

test('word fields · pointer: inline completion, Enter accepts and moves on, Tab accepts', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'pointer path');
  await open(page, 'light', SCENES.find((s) => s.name === 'home-empty')!);
  await page.getByTestId('enter-words-btn').click();
  const first = page.getByTestId('word-input-0');
  await first.fill('bat');
  // "bat" → bathrobe is the unique 3-letter prefix; Enter takes it and focuses word 2.
  await first.press('Enter');
  await expect(first).toHaveValue('bathrobe');
  await expect(page.getByTestId('word-input-1')).toBeFocused();
  // Tab accepts too, and lets focus move on by itself.
  await page.getByTestId('word-input-1').fill('gad');
  await page.getByTestId('word-input-1').press('Tab');
  await expect(page.getByTestId('word-input-1')).toHaveValue('gadget');
  await expect(page.getByTestId('word-input-2')).toBeFocused();
  // No listbox on a pointer device — the completion is inline.
  await expect(page.getByRole('listbox')).toHaveCount(0);
  // Connect stays disabled until all five hold list words.
  await expect(page.getByTestId('words-join-btn')).toBeDisabled();
});

test('word fields · touch: a listbox of up to three matches, arrows move, Enter accepts', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'touch path');
  await open(page, 'light', SCENES.find((s) => s.name === 'home-empty')!);
  await page.getByTestId('enter-words-btn').click();
  const field = page.getByTestId('word-input-2');
  await field.focus();
  await field.fill('sp');
  const list = page.getByRole('listbox');
  await expect(list).toBeVisible();
  const options = list.getByRole('option');
  await expect(options).toHaveCount(3);
  await expect(field).toHaveAttribute('aria-expanded', 'true');
  // aria-activedescendant follows the arrows; the field keeps DOM focus (a combobox contract).
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await field.press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(field).toBeFocused();
  const second = (await options.nth(1).textContent())!.trim();
  await field.press('Enter');
  await expect(field).toHaveValue(second);
  await expect(page.getByRole('listbox')).toHaveCount(0);
  // A tap on an option accepts it as well.
  const other = page.getByTestId('word-input-3');
  await other.focus();
  await other.fill('la');
  await page.getByRole('option').first().dispatchEvent('mousedown');
  await expect(other).not.toHaveValue('la');
});

test('word fields · "No matching word" sits under the active field', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'pointer project');
  await open(page, 'light', SCENES.find((s) => s.name === 'home-empty')!);
  await page.getByTestId('enter-words-btn').click();
  await page.getByTestId('word-input-2').fill('spx');
  const alert = page.getByTestId('word-pos-2').getByRole('alert');
  await expect(alert).toHaveText('No matching word');
  await expect(page.getByTestId('word-input-2')).toHaveAttribute('aria-invalid', 'true');
});

test('phrase cards: buttons with aria-pressed, one selected at a time, Space toggles', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'desktop project');
  await open(page, 'light', SCENES.find((s) => s.name === 'sas-picker')!);
  const cards = page.getByRole('group', { name: 'Phrases' }).getByRole('button');
  await expect(cards).toHaveCount(3);
  for (let i = 0; i < 3; i++) await expect(cards.nth(i)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('sas-confirm-btn')).toBeDisabled();

  await cards.nth(1).focus();
  await page.keyboard.press('Space');
  await expect(cards.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('sas-confirm-btn')).toBeEnabled();

  await cards.nth(2).focus();
  await page.keyboard.press('Enter');
  await expect(cards.nth(2)).toHaveAttribute('aria-pressed', 'true');
  await expect(cards.nth(1)).toHaveAttribute('aria-pressed', 'false');
});

test('mode radios: one tab stop, arrows move the selection, the description follows', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'desktop project');
  await open(page, 'light', SCENES.find((s) => s.name === 'home-empty')!);
  const max = page.getByTestId('privacy-toggle');
  const reliable = page.getByTestId('privacy-reliable');
  await expect(max).toHaveAttribute('aria-checked', 'true');
  await expect(reliable).toHaveAttribute('tabindex', '-1');
  await max.focus();
  await page.keyboard.press('ArrowDown');
  await expect(reliable).toHaveAttribute('aria-checked', 'true');
  await expect(reliable).toBeFocused();
  await expect(page.getByTestId('privacy-desc')).toContainText('relayed');
  await page.keyboard.press('ArrowUp');
  await expect(max).toHaveAttribute('aria-checked', 'true');
  await expect(max).toBeFocused();
});

test('theme toggle: aria-pressed mirrors "light is active" and the flip is a cut', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'desktop project');
  await open(page, 'light', SCENES.find((s) => s.name === 'home-empty')!);
  const toggle = page.getByRole('button', { name: 'Switch theme' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
});

test('path rows: aria-expanded disclosure, the hint is hidden until opened', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'desktop project');
  await open(page, 'light', SCENES.find((s) => s.name === 'transfer-path-disagree')!);
  const row = page.getByTestId('path-state');
  await expect(row).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('path-hint')).toBeHidden();
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('path-hint')).toBeVisible();
  // the second row is independent
  await expect(page.getByTestId('stun-state')).toHaveAttribute('aria-expanded', 'false');
});

test('busy notice and word errors are live regions', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'desktop project');
  await open(page, 'light', SCENES.find((s) => s.name === 'lobby')!);
  await dispatch(page, {
    type: 'connection/lobbyNotice',
    payload: { kind: 'busy', peerId: 'brave-otter' },
  });
  const notice = page.getByTestId('lobby-busy');
  await expect(notice).toHaveAttribute('role', 'alert');
  await expect(notice).toContainText('brave-otter');
});

test('the room code is one accessible object and never overflows the phone at 200 %', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === 'phone', 'desktop project');
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page, 'light', SCENES.find((s) => s.name === 'lobby')!);
  const code = page.getByTestId('room-code');
  await expect(code).toHaveAccessibleName('Room code 4827');
  await page.addStyleTag({ content: 'html { font-size: 200%; }' });
  // The digits are capped at min(132px, 35vw) and sit in a wrapping row: whatever the zoom, the
  // page never scrolls sideways (SC 1.4.10).
  // (scrollWidth can come in UNDER clientWidth: the kit reserves a stable scrollbar gutter.)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
