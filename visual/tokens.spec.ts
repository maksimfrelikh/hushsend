import { test, expect, type Page } from '@playwright/test';
import { pinTheme, settle, type Theme } from './scenes';

/* ============================================================
   Exact token gate — the companion to screens.spec.ts (modelled
   on frelikh/visual/tokens.spec.ts).

   The pixel gate cannot see small value drift: a hairline moving
   from #e6e6e6 to #e5e5e5 stays under the per-pixel threshold.
   So this snapshots the RESOLVED value of every custom property on
   the live document, per theme and contrast preference. The palette
   comes from stark-ui-kit/theme-mono.css through the pin, so a pin
   bump that moves a value shows up here as a readable diff; a
   token that is ADDED or REMOVED shows up too.

   The second half snapshots the geometry of the controls (radius,
   padding, border, type) — the numbers a screenshot budget lets
   through when only a few dozen pixels change.
   ============================================================ */

async function tokensFor(page: Page, theme: Theme, contrast: 'no-preference' | 'more') {
  await page.emulateMedia({ contrast });
  await pinTheme(page, theme);
  await page.goto('/', { waitUntil: 'load' });
  await settle(page);
  return page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const out: Record<string, string> = {};
    for (const name of Array.from(cs)) {
      if (name.startsWith('--')) out[name] = cs.getPropertyValue(name).trim();
    }
    // the app scope carries its own derived properties (the wash, the inversion set)
    const app = getComputedStyle(document.querySelector('.hs-app')!);
    for (const name of Array.from(app)) {
      if (name.startsWith('--hs-')) out[`.hs-app ${name}`] = app.getPropertyValue(name).trim();
    }
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
  });
}

for (const theme of ['light', 'dark'] as const) {
  for (const contrast of ['no-preference', 'more'] as const) {
    test(`tokens ${theme} ${contrast}`, async ({ page }) => {
      const tokens = await tokensFor(page, theme, contrast);
      // Guard against the enumeration silently returning nothing, which would make an empty
      // snapshot look like a pass forever after.
      expect(Object.keys(tokens).length).toBeGreaterThan(20);
      expect(JSON.stringify(tokens, null, 2)).toMatchSnapshot(`tokens-${theme}-${contrast}.json`);
    });
  }
}

/* ---------- computed geometry ---------- */

const PROPS = [
  'borderRadius',
  'padding',
  'borderTopWidth',
  'borderLeftWidth',
  'fontSize',
  'lineHeight',
  'letterSpacing',
  'minHeight',
  'fontFamily',
] as const;

async function geometry(page: Page, selectors: string[]) {
  return page.evaluate(
    ({ selectors, props }) => {
      const out: Record<string, Record<string, string> | string> = {};
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (!el) {
          // Recorded rather than skipped: a selector that stops matching is itself a regression.
          out[sel] = 'MISSING';
          continue;
        }
        const cs = getComputedStyle(el);
        out[sel] = Object.fromEntries(props.map((p) => [p, cs[p as never] as string]));
      }
      return out;
    },
    { selectors, props: PROPS as unknown as string[] },
  );
}

test('home controls at 375', async ({ page }) => {
  await pinTheme(page, 'light');
  await page.goto('/', { waitUntil: 'load' });
  await settle(page);
  const g = await geometry(page, [
    '.hs-topbar',
    '.theme-toggle',
    '.hs-h1',
    '.hs-mode__radio[aria-checked="true"]',
    '.hs-mode__radio[aria-checked="false"]',
    '.hs-pill--primary',
    '.hs-pill:not(.hs-pill--primary)',
    '.hs-input--code',
    '.hs-h3',
    '.hs-fold__summary',
    '.hs-fold__title',
  ]);
  expect(JSON.stringify(g, null, 2)).toMatchSnapshot('geometry-home-w375.json');
});

test('home controls at 1440', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await pinTheme(page, 'light');
  await page.goto('/', { waitUntil: 'load' });
  await settle(page);
  const g = await geometry(page, ['.hs-topbar', '.hs-main', '.hs-h1', '.hs-pill--primary']);
  expect(JSON.stringify(g, null, 2)).toMatchSnapshot('geometry-home-w1440.json');
});

test('theme switch is a cut, not a cross-fade', async ({ page }) => {
  await pinTheme(page, 'light');
  await page.goto('/', { waitUntil: 'load' });
  await settle(page);
  // With the attribute off, themed controls animate their colour as usual…
  const before = await page.evaluate(
    () => getComputedStyle(document.querySelector('.theme-toggle')!).transitionDuration,
  );
  expect(before).not.toBe('0s');
  // …and with it on, nothing does (the kit's data-theme-switching cut, which prefs.tsx uses).
  const during = await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme-switching', '');
    const d = getComputedStyle(document.querySelector('.theme-toggle')!).transitionDuration;
    document.documentElement.removeAttribute('data-theme-switching');
    return d;
  });
  expect(during).toBe('0s');
});
