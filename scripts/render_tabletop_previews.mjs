// Render actual published frames, never paid inference or newly simulated data.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { verifyPreviewIdentity } from './tabletop_preview_identity.mjs';
const url = process.argv.find(arg => arg.startsWith('--url='))?.slice(6) ?? 'https://labbit.science';
const inventory = JSON.parse(readFileSync('config/tabletop-recordings.json'));
const approved = join(tmpdir(), 'opencode'); mkdirSync(approved, { recursive: true });
const directory = mkdtempSync(join(approved, 'labbit-previews-'));
const browser = await chromium.launch({ channel: 'chrome' });
const previews = [];
try {
  const page = await browser.newPage({ viewport: { width: 1080, height: 760 } });
  let physicsRequests = 0;
  await page.route('**/model/**', route => { physicsRequests++; return route.abort(); });
  await page.goto(url);
  for (const task of ['transfer', 'push', 'stack', 'pour']) {
    const entry = inventory.episodes.find(e => e.scenario.task === task); assert.ok(entry);
    await page.getByLabel(`Episode ${entry.id + 1}: ${entry.scenario.title}`, { exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.tt-loading'), null, { timeout: 180000 });
    assert.equal(await page.locator('[role=alert]').count(), 0);
    if (await page.getByLabel('Pause tabletop playback').count()) await page.getByLabel('Pause tabletop playback').click();
    await page.getByRole('button', { name: 'Data & AI', exact: true }).click();
    const identity = await page.locator('.data-selected').innerText();
    verifyPreviewIdentity(identity, inventory, entry);
    await page.getByLabel('Close data explorer').click();
    const frames = [];
    for (let index = 0; index <= 360; index += 3) {
      await page.getByLabel('Tabletop playback position').fill(String(index));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const file = join(directory, `${task}-${String(index).padStart(3, '0')}.png`);
      await page.locator('.tt-viewport canvas').screenshot({ path: file }); frames.push(file);
    }
    previews.push({ task, episode_id: entry.id, displayed_episode: entry.id + 1, trajectory_sha256: entry.sha256, dataset_revision: inventory.revision, frame_indices: Array.from({ length: 121 }, (_, i) => i * 3), frames, gif: `${task}.gif` });
  }
  assert.equal(physicsRequests, 0);
  writeFileSync(join(directory, 'capture.json'), JSON.stringify({ frame_duration_ms: 100, previews }, null, 2));
  console.log('Captured real recorded frames:', join(directory, 'capture.json'));
} finally { await browser.close(); }
