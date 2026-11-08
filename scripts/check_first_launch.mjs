// Real Chrome first-launch regression in an isolated checkout with no public/model.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from '@playwright/test';
const approved = join(tmpdir(), 'opencode'); mkdirSync(approved, { recursive: true });
const checkout = mkdtempSync(join(approved, 'labbit-first-launch-'));
let child, browser;
try {
  for (const file of ['package.json', 'vite.config.ts', 'index.html', 'tsconfig.json', 'src', 'backend', 'scripts', 'config']) cpSync(file, join(checkout, file), { recursive: true, filter: source => !source.includes('__pycache__') });
  cpSync(resolve('public'), join(checkout, 'public'), { recursive: true, filter: source => !source.startsWith(resolve('public/model')) && !source.startsWith(resolve('public/data')) });
  for (const dir of ['node_modules', 'models']) symlinkSync(resolve(dir), join(checkout, dir), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(existsSync(join(checkout, 'public/model/manifest.json')), false);
  const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  child = spawn(process.execPath, [npmCli, 'run', 'dev', '--', '--port', '5197', '--strictPort'], { cwd: checkout, detached: process.platform !== 'win32' });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  await new Promise((ready, reject) => {
    const timer = setTimeout(() => reject(new Error(output || 'Startup timeout')), 30000);
    child.stdout.on('data', () => { if (output.includes('http://127.0.0.1:5197')) { clearTimeout(timer); ready(); } });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`Startup exited ${code}: ${output}`)); });
  });
  assert.equal(existsSync(join(checkout, 'public/model/manifest.json')), true);
  browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage();
  // Exercise real local physics preparation, independent of external HF access.
  await page.route('**/data/tabletop-recordings.json', route => route.fulfill({ status: 404 }));
  await page.goto('http://127.0.0.1:5197');
  await page.locator('input[aria-label="Tabletop playback position"]').waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector('.tt-loading'), null, { timeout: 60000 });
  assert.equal(await page.locator('[role=alert]').count(), 0);
  await page.waitForFunction(() => Number(document.querySelector('input[aria-label="Tabletop playback position"]')?.value ?? '0') > 1);
  console.log('Fresh checkout: model preparation and real Chrome tabletop playback passed.');
} finally {
  try { await browser?.close(); } finally {
    if (child?.pid) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      else { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
      if (child.exitCode === null && child.signalCode === null) await new Promise(resolveExit => child.once('exit', resolveExit));
    }
    rmSync(checkout, { recursive: true, force: true });
  }
}
