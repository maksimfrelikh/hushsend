import { test, expect } from '@playwright/test';
import { SCENES, ZOOM_SCENES, THEMES, VIEWPORTS, open, settle } from './scenes';

/* ============================================================
   Baselines for every screen state. See playwright.config.ts for
   how to run; visual/scenes.ts for how each state is reached.

   Core screens run the whole matrix (3 viewports × 2 themes);
   state variants run on the base phone in both themes; the three
   200 % text-zoom boards run at 375 with the root font doubled.
   ============================================================ */

for (const vp of VIEWPORTS) {
  for (const theme of THEMES) {
    test.describe(`${vp.name} ${theme}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height } });

      for (const scene of SCENES) {
        if (scene.matrix === 'phone' && vp.name !== 'w375') continue;
        test(scene.name, async ({ page }) => {
          await open(page, theme, scene);
          await expect(page).toHaveScreenshot(`${scene.name}-${vp.name}-${theme}.png`, {
            fullPage: true,
          });
        });
      }
    });
  }
}

/* ---------- 200 % text zoom ----------
   Browser text-only zoom scales the root font size; the kit's type roles are rem-based clamps, so
   doubling the root doubles every text size while the three display caps (min(132px, 35vw) …) hold.
   Checked at the base phone width, where the caps bind. */
test.describe('w375 zoom200', () => {
  test.use({ viewport: { width: 375, height: 812 } });
  for (const theme of THEMES) {
    for (const scene of ZOOM_SCENES) {
      test(`${scene.name} ${theme}`, async ({ page }) => {
        await open(page, theme, scene);
        await page.addStyleTag({ content: 'html { font-size: 200%; }' });
        await settle(page);
        await expect(page).toHaveScreenshot(`${scene.name}-w375-zoom200-${theme}.png`, {
          fullPage: true,
        });
      });
    }
  }
});
