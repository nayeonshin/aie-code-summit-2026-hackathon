import { test, expect } from '@playwright/test';

test('resume refreshes the row and starts progress polling without reopening panel', async ({ page }) => {
  const run = { id: 'resume-fixture', status: 'interrupted', attempted: 10, valid: 10, config: { count: 100 } };
  let listReads = 0;
  await page.route('**/api/runs', route => { listReads++; return route.fulfill({ json: [run] }); });
  await page.route('**/api/runs/resume-fixture/resume', route => { run.status = 'running'; return route.fulfill({ json: { id: run.id } }); });
  await page.goto('/#hands');
  await page.getByLabel('Open dataset generation').click();
  await expect(page.locator('.run-status')).toHaveText('interrupted');
  await page.getByLabel('Resume generation').click();
  await expect(page.locator('.run-status')).toHaveText('running');
  await expect.poll(() => listReads).toBeGreaterThan(2);
  run.attempted = 20;
  await expect(page.locator('.run-line')).toContainText('20');
});

test('data explorer separates Muse, physics and SubQ with a Hugging Face link', async ({ page }) => {
  await page.route('**/api/tabletop/plans/latest', route => route.fulfill({ status: 404 }));
  await page.route('**/data/tabletop-plan.json', route => route.fulfill({ status: 404 }));
  await page.route('**/data/catalog.json', route => route.fulfill({ json: { collections: [], tabletop: { planned: 1000, recorded: 100 }, muse: { model: 'muse-wonder-1.0', variants: 24, planId: 'fixture-plan', rationale: ['Test bounded friction diversity'] }, subq: [{ model: 'subq-snap-1.1', input_sha256: 'fixture-hash', image_count: 4, scope: 'hand-only sample', answers: { movement: { choice: 'flex', confidence: .9 } } }] } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Data & AI' }).click();
  await expect(page.getByRole('dialog', { name: 'Data and AI provenance' })).toBeVisible();
  await expect(page.locator('.data-note').first()).toContainText('1,000 Muse-derived scenarios');
  await expect(page.getByRole('link', { name: 'Open Hugging Face dataset' })).toHaveAttribute('href', 'https://huggingface.co/datasets/MedSalim/labbit-robotic-manipulation');
  await page.getByRole('tab', { name: 'Muse proposals' }).click();
  await expect(page.locator('.data-body')).toContainText('fixture-plan');
  await page.getByRole('tab', { name: 'SubQ reviews' }).click();
  await expect(page.locator('.data-body')).toContainText('not falsely linked to tabletop episodes');
  await expect(page.locator('.data-body')).toContainText('subq-snap-1.1');
  await page.getByLabel('Close data explorer').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('published Muse collection supports 1,000 studies and keyboard navigation beyond baseline', async ({ page }) => {
  test.setTimeout(90000);
  const variants = Array.from({ length: 24 }, (_, i) => ({ task: ['transfer', 'push', 'stack', 'pour'][i % 4], shape: ['cube', 'sphere', 'cylinder'][i % 3], size: .025, mass: .06, friction: .7, speed: 1, lift: .15, lateral: .01, startY: -.02, goalY: .02, rationale: 'Mock bounded diversity; no AI spend' }));
  await page.route('**/api/tabletop/plans/latest', route => route.fulfill({ json: { id: 'fixture-muse-1000', model: 'muse-wonder-1.0', created_at: '2026-11-07T00:00:00Z', count: 1000, variants } }));
  await page.goto('/');
  await expect(page.locator('.tt-card')).toHaveCount(1000);
  await expect(page.locator('.tt-loading')).toHaveCount(0, { timeout: 60000 });
  await expect(page.locator('.tt-source-line')).toHaveCount(0);
  await page.locator('.tt-card').nth(125).click();
  await expect(page.locator('.tt-loading')).toHaveCount(0, { timeout: 60000 });
  await page.locator('.tt-viewport canvas').click();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByLabel('Selected episode', { exact: true })).toHaveText('127');
  await page.getByRole('button', { name: 'Data & AI', exact: true }).click();
  await page.getByRole('tab', { name: 'Muse proposals' }).click();
  await expect(page.locator('.data-selected')).toContainText('fixture-muse-1000');
  await expect(page.locator('.data-selected')).not.toContainText('3d1546db');
  await expect(page.locator('.data-published')).toContainText('3d1546db');
});
