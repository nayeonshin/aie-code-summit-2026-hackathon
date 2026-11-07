// Explicit integration check; --ai makes one real Meta planning request.
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
const url = process.argv.find(arg => arg.startsWith('http')) ?? 'http://127.0.0.1:8787';
const ai = process.argv.includes('--ai');
const count = Number(process.env.SMOKE_EPISODES ?? 100);
const token = readFileSync('.deploy.env', 'utf8').split('\n').find(line => line.startsWith('ADMIN_TOKEN=')).slice('ADMIN_TOKEN='.length).trim();
const browser = await chromium.launch({ channel: 'chrome' });
const started = performance.now();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => console.log('Browser error:', error.message));
  await page.goto(url);
  await page.locator('.status').filter({ hasText: 'LIVE' }).waitFor({ timeout: 120000 });
  await page.getByRole('button', { name: 'Unlock cloud generation' }).click();
  await page.getByLabel('Cloud admin token').fill(token);
  await page.getByRole('button', { name: 'Save admin token' }).click();
  await page.getByRole('button', { name: 'Open dataset generation' }).click();
  if (ai) {
    const responsePromise = page.waitForResponse(r => r.url().endsWith('/api/plans'), { timeout: 60000 });
    await page.getByRole('button', { name: 'Meta', exact: true }).click();
    const response = await responsePromise;
    const data = await response.json();
    console.log('Meta planning:', response.status(), data.model, data.variants?.length, data.detail ?? '');
    if (!response.ok()) throw new Error('Meta planning failed.');
  }
  await page.getByRole('spinbutton', { name: 'Number of episodes' }).fill(String(count));
  const createPromise = page.waitForResponse(r => r.url().endsWith('/api/runs') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Start dataset generation' }).click();
  const created = await createPromise;
  const { id, detail } = await created.json();
  if (!created.ok()) throw new Error(detail);
  for (let attempt = 0; attempt < 90; attempt++) {
    await page.waitForTimeout(1000);
    const response = await page.request.get(`${url}/api/runs/${id}`);
    const run = await response.json();
    const notice = await page.locator('[role=alert]').count() ? await page.locator('[role=alert]').textContent() : '';
    if (notice) throw new Error(notice);
    if (run.status === 'complete') {
      console.log(JSON.stringify({ id, attempted: run.attempted, valid: run.valid, objective_passed: run.objective_passed, seconds: run.config.seconds, coverage: run.coverage, elapsed_wall_seconds: (performance.now() - started) / 1000 }));
      const manifest = await (await page.request.get(`${url}/datasets/${id}/manifest.json`)).json();
      console.log('Persisted shards:', manifest.shards.length);
      await page.getByRole('button', { name: 'Replay episode' }).first().click();
      await page.getByRole('slider', { name: 'Replay position' }).waitFor();
      await page.screenshot({ path: 'test-results/cloud-replay.png' });
      console.log('R2 replay passed');
      break;
    }
    if (attempt === 89) throw new Error('Cloud generation timed out.');
  }
} finally { await browser.close(); }
