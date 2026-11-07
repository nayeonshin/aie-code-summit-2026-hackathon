// Real Chrome first-launch regression in an isolated checkout with no public/model.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
const approved = join(tmpdir(), 'opencode'); mkdirSync(approved, { recursive: true });
const checkout = mkdtempSync(join(approved, 'labbit-first-launch-'));
for (const file of ['package.json', 'vite.config.ts', 'index.html', 'tsconfig.json', 'src', 'backend', 'scripts', 'config']) cpSync(file, join(checkout, file), { recursive: true, filter: source => !source.includes('__pycache__') });
cpSync(resolve('public'), join(checkout, 'public'), { recursive: true, filter: source => !source.startsWith(resolve('public/model')) && !source.startsWith(resolve('public/data')) });
symlinkSync(resolve('node_modules'), join(checkout, 'node_modules'), 'dir'); symlinkSync(resolve('models'), join(checkout, 'models'), 'dir');
assert.equal(existsSync(join(checkout, 'public/model/manifest.json')), false);
const process = spawn('npm', ['run', 'dev', '--', '--port', '5197', '--strictPort'], { cwd: checkout, detached: true });
let output = ''; process.stdout.on('data', data => { output += data; }); process.stderr.on('data', data => { output += data; });
let browser;
try {
  await new Promise((resolveReady, reject) => { const timer = setTimeout(() => reject(new Error(output)), 30000); process.stdout.on('data', () => { if (output.includes('http://127.0.0.1:5197')) { clearTimeout(timer); resolveReady(); } }); process.on('exit', code => { clearTimeout(timer); reject(new Error(`Startup exited ${code}: ${output}`)); }); });
  assert.equal(existsSync(join(checkout, 'public/model/manifest.json')), true);
  browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage(); await page.goto('http://127.0.0.1:5197');
  await page.locator('input[aria-label="Tabletop playback position"]').waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector('.tt-loading'), null, { timeout: 60000 });
  assert.equal(await page.locator('[role=alert]').count(), 0);
  await page.waitForFunction(() => Number(document.querySelector('input[aria-label="Tabletop playback position"]')?.value ?? '0') > 1);
  console.log('Fresh checkout: npm run dev prepared missing public model assets and Chrome played a real tabletop episode without a prior cloud build.');
} finally { await browser?.close(); try { globalThis.process.kill(-process.pid, 'SIGTERM'); } catch {} rmSync(checkout, { recursive: true, force: true }); }
