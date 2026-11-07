import { test, expect } from '@playwright/test';

test('live grid, pause, focus, dataset controls, and VLM upload', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/health', route => route.fulfill({ json: { subq_configured: true } }));
  await page.goto('/');
  await expect(page).toHaveTitle('Labbit · robotic hand lab');
  await expect(page.locator('.wordmark')).toHaveText('labbit / lab');
  await expect(page.locator('.status')).toHaveText('LIVE');
  await expect(page.locator('.tile')).toHaveCount(9);
  await expect.poll(async () => Number((await page.locator('.time').innerText()).replace('s', ''))).toBeGreaterThan(.3);
  await page.getByRole('button', { name: 'Pause simulations' }).click();
  await page.waitForTimeout(200);
  const time = await page.locator('.time').innerText();
  await page.waitForTimeout(200);
  expect(await page.locator('.time').innerText()).toBe(time);
  await page.getByRole('button', { name: 'Play simulations' }).click();
  await page.getByRole('button', { name: 'Show four simulations' }).click();
  await expect(page.locator('.tile')).toHaveCount(4);
  await page.locator('.tile').first().dblclick();
  await expect(page.locator('.tile')).toHaveCount(1);
  await page.locator('.tile').first().dblclick();
  await page.getByRole('button', { name: 'Show nine simulations' }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'test-results/studio-desktop.png' });
  await page.getByRole('button', { name: 'Open dataset generation' }).click();
  await expect(page.getByRole('spinbutton', { name: 'Number of episodes' })).toHaveValue('100');
  await page.getByRole('button', { name: 'Close dataset controls' }).click();
  // No external API spend in automated tests. Verify real PNG+text submission.
  await page.route('**/api/annotate', async route => {
    const body = route.request().postDataJSON();
    expect(body.frames).toHaveLength(4);
    expect(body.frames[0].startsWith('iVBOR')).toBeTruthy();
    expect(body.summary.samples).toHaveLength(4);
    expect(body.summary.samples[3].time).toBeGreaterThan(body.summary.samples[0].time);
    await route.fulfill({ json: { model: 'subq-snap-1.1', image_count: 4, answers: { movement: { choice: 'flex', confidence: .9 }, coordination: { score: 2 } } } });
  });
  await page.getByRole('button', { name: 'Evaluate selected hand with SubQ' }).click();
  await expect(page.locator('.decision')).toContainText('SubQ · 4 frames');
  expect(errors).toEqual([]);
});

test('mobile grid stays usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('.status')).toHaveText('LIVE');
  await page.getByRole('button', { name: 'Show four simulations' }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/studio-mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});
