import { test, expect } from '@playwright/test';

test('minimal grid renders distinct physics episodes, pages, pauses and focuses', async ({ page }) => {
  test.setTimeout(180000);
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: 'Grid', exact: true }).click();
  await page.getByLabel('Simultaneous simulations').selectOption('4');
  await expect(page.locator('.tt-grid-tile')).toHaveCount(4);
  await expect(page.locator('.tt-grid-loading')).toHaveCount(0, { timeout: 120000 });
  await expect(page.getByLabel('Tabletop simulation grid')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hand studies', exact: true })).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText('Small objects. Deliberate movements.');
  await page.getByLabel('Pause grid playback').click();
  await expect(page.getByLabel('Play grid playback')).toBeVisible();
  await page.screenshot({ path: 'test-results/tabletop-grid.png' });
  await page.getByLabel('Next simulation page').click();
  await expect(page.getByLabel('Focus simulation 5', { exact: true })).toBeVisible();
  await page.getByLabel('Focus simulation 5', { exact: true }).click();
  await expect(page.getByLabel('Selected episode', { exact: true })).toHaveText('5');
  await expect(page.locator('.tt-loading')).toHaveCount(0, { timeout: 60000 });
  expect(errors).toEqual([]);
});

test('25-view grid loads within bounded renderer count and fits mobile', async ({ page }) => {
  test.setTimeout(240000);
  await page.goto('/');
  await page.getByRole('button', { name: 'Grid', exact: true }).click();
  await page.getByLabel('Simultaneous simulations').selectOption('25');
  await expect(page.locator('.tt-grid-tile')).toHaveCount(25);
  await expect(page.locator('.tt-grid-loading')).toHaveCount(0, { timeout: 180000 });
  await expect(page.locator('[role=alert]')).toHaveCount(0);
  await expect(page.locator('.tt-grid canvas')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/tabletop-grid-25.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: 'test-results/tabletop-grid-mobile.png' });
});
