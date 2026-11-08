import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
// Bundle browser-only JSON imports before loading scenarios in the Node runner.
const bundled = await build({ entryPoints: ['src/tabletop-scenarios.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { scenarios } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const mesh = gzipSync(JSON.stringify({ vertices: [-.02, 0, 0, .02, 0, 0, 0, .04, 0], faces: [0, 1, 2] }));
  const hash = sha(mesh), meshFile = `meshes/${hash}.json.gz`;
  const frames = Array.from({ length: 361 }, (_, i) => ({ time: i / 30, positions: [[0, 0, .8]], rotations: [[1, 0, 0, 0, 1, 0, 0, 0, 1]], contacts: 17, holding: false, object: [0, 0, .8], objectCenter: [0, 0, .8], palm: [0, 0, .9], palmNormal: [0, 0, -1], graspCenter: [0, 0, .8] }));
  const files = new Map<string, Buffer>([[meshFile, mesh]]);
  const episodes = scenarios.slice(0, 9).map((scenario: any) => {
    const payload = { schema_version: 1, scenario, geoms: [{ id: 0, type: 'mesh', size: [], color: '#799374', mesh: hash }], frames,
      metrics: { finite: true, contacts: 17, goalDistance: .123 }, provenance: { runtime: 'Recorded test fixture', handActuators: 20, hand: 'five-finger fixture', controller: 'fixture', fluid: 'none', timestep: .004 } };
    const file = `compact/episode-${String(scenario.id + 1).padStart(4, '0')}.json.gz`, bytes = gzipSync(JSON.stringify(payload));
    files.set(file, bytes);
    return { id: scenario.id, scenario, frames: 361, file, sha256: sha(bytes), bytes: bytes.length, standalone_file: `episode-${String(scenario.id + 1).padStart(4, '0')}.json.gz` };
  });
  return { files, manifest: { schema_version: 1, revision: 'a'.repeat(40), base_url: '/fixtures/tabletop/', plan_fingerprint: 'b'.repeat(64), sample_hz: 30, planned: 100, recorded: 9, episodes, meshes: { [hash]: { file: meshFile, sha256: hash, bytes: mesh.length } } } };
}

test('published replay uses stored telemetry, shared meshes and export without MuJoCo downloads', async ({ page }) => {
  const { files, manifest } = fixture();
  let physicsReads = 0, meshReads = 0;
  await page.route('**/api/tabletop/plans/latest', route => route.fulfill({ status: 404 }));
  await page.route('**/data/tabletop-plan.json', route => route.fulfill({ status: 404 }));
  await page.route('**/data/tabletop-recordings.json', route => route.fulfill({ json: manifest }));
  await page.route('**/fixtures/tabletop/**', route => { const key = new URL(route.request().url()).pathname.replace('/fixtures/tabletop/', ''); if (key.startsWith('meshes/')) meshReads++; return route.fulfill({ body: files.get(key)!, contentType: 'application/gzip' }); });
  await page.route('**/model/**', route => { physicsReads++; return route.abort(); });
  await page.goto('/');
  await expect(page.locator('.tt-loading')).toHaveCount(0);
  await expect(page.locator('[role=alert]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Data & AI', exact: true }).click();
  await expect(page.locator('.data-selected')).toContainText('Published recording; no physics recomputation.');
  await expect(page.locator('.data-selected')).toContainText('17 peak contacts');
  await page.getByLabel('Close data explorer').click();
  await page.getByLabel('Next simulation', { exact: true }).click();
  await expect(page.locator('.tt-loading')).toHaveCount(0);
  const download = page.waitForEvent('download'); await page.getByLabel('Download simulated episode').click();
  expect((await download).suggestedFilename()).toBe('tabletop-002.json');
  expect(physicsReads).toBe(0); expect(meshReads).toBe(1);
});

test('corrupt published trajectory is not silently recomputed; Retry downloads again', async ({ page }) => {
  const { files, manifest } = fixture(); let corrupt = true, reads = 0, physicsReads = 0;
  await page.route('**/api/tabletop/plans/latest', route => route.fulfill({ status: 404 }));
  await page.route('**/data/tabletop-plan.json', route => route.fulfill({ status: 404 }));
  await page.route('**/data/tabletop-recordings.json', route => route.fulfill({ json: manifest }));
  await page.route('**/fixtures/tabletop/**', route => { const key = new URL(route.request().url()).pathname.replace('/fixtures/tabletop/', ''); reads++; return route.fulfill({ body: corrupt ? Buffer.from('corrupt') : files.get(key)!, contentType: 'application/gzip' }); });
  await page.route('**/model/**', route => { physicsReads++; return route.abort(); });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('checksum mismatch');
  const before = reads; corrupt = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.tt-loading')).toHaveCount(0);
  await expect(page.locator('[role=alert]')).toHaveCount(0);
  expect(reads).toBeGreaterThan(before); expect(physicsReads).toBe(0);
});

test('recorded grid plays multiple stored episodes without initializing physics', async ({ page }) => {
  const { files, manifest } = fixture();
  let physicsReads = 0;
  await page.route('**/api/tabletop/plans/latest', route => route.fulfill({ status: 404 }));
  await page.route('**/data/tabletop-plan.json', route => route.fulfill({ status: 404 }));
  await page.route('**/data/tabletop-recordings.json', route => route.fulfill({ json: manifest }));
  await page.route('**/fixtures/tabletop/**', route => route.fulfill({ body: files.get(new URL(route.request().url()).pathname.replace('/fixtures/tabletop/', ''))!, contentType: 'application/gzip' }));
  await page.route('**/model/**', route => { physicsReads++; return route.abort(); });
  await page.goto('/');
  await page.getByRole('button', { name: 'Grid', exact: true }).click();
  await page.getByRole('combobox', { name: 'Simultaneous simulations' }).click();
  await page.getByRole('option', { name: '4 views', exact: true }).click();
  await expect(page.locator('.tt-grid-tile')).toHaveCount(4);
  await expect(page.locator('.tt-grid-loading')).toHaveCount(0);
  await expect(page.locator('[role=alert]')).toHaveCount(0);
  expect(physicsReads).toBe(0);
});

test('new selection completes while the obsolete recording request is still stalled', async ({ page }) => {
  const { files, manifest } = fixture(); let requested = false, nextRequested = false, release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/tabletop/plans/latest', route => route.fulfill({ status: 404 }));
  await page.route('**/data/tabletop-plan.json', route => route.fulfill({ status: 404 }));
  await page.route('**/data/tabletop-recordings.json', route => route.fulfill({ json: manifest }));
  await page.route('**/fixtures/tabletop/**', async route => {
    const key = new URL(route.request().url()).pathname.replace('/fixtures/tabletop/', '');
    if (key === manifest.episodes[0].file) { requested = true; await blocked; return route.fulfill({ body: Buffer.from('corrupt') }).catch(() => {}); }
    if (key === manifest.episodes[1].file) nextRequested = true;
    return route.fulfill({ body: files.get(key)!, contentType: 'application/gzip' });
  });
  await page.goto('/');
  await expect.poll(() => requested).toBe(true);
  try {
    await page.getByLabel('Next simulation', { exact: true }).click();
    await expect.poll(() => nextRequested).toBe(true);
    await expect(page.getByLabel('Selected episode', { exact: true })).toHaveText('2');
    await expect(page.locator('.tt-loading')).toHaveCount(0);
    await expect(page.locator('[role=alert]')).toHaveCount(0);
  } finally { release(); }
});

for (const stage of ['engine manifest', 'engine asset', 'tabletop manifest', 'tabletop asset']) {
  test(`published replay starts while obsolete ${stage} download is stalled`, async ({ page }) => {
    const { files, manifest } = fixture();
    // The initially selected study is unrecorded; study 2 is published and has
    // never been loaded, so success cannot be explained by the worker cache.
    manifest.episodes = manifest.episodes.slice(1); manifest.recorded = manifest.episodes.length;
    let stalled = false, recordingRequested = false, manifests = 0, assets = 0;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/tabletop/plans/latest', route => route.fulfill({ status: 404 }));
    await page.route('**/data/tabletop-plan.json', route => route.fulfill({ status: 404 }));
    await page.route('**/data/tabletop-recordings.json', route => route.fulfill({ json: manifest }));
    await page.route('**/fixtures/tabletop/**', route => {
      const key = new URL(route.request().url()).pathname.replace('/fixtures/tabletop/', '');
      if (key === manifest.episodes[0].file) recordingRequested = true;
      return route.fulfill({ body: files.get(key)!, contentType: 'application/gzip' });
    });
    await page.route('**/model/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const manifestRequest = path === '/model/manifest.json';
      const assetRequest = path === '/model/right_hand.xml';
      if (manifestRequest) manifests++;
      if (assetRequest) assets++;
      const pass = stage.startsWith('engine') ? 1 : 2;
      if (stage.endsWith('manifest') ? manifestRequest && manifests === pass : assetRequest && assets === pass) {
        stalled = true; await blocked;
      }
      await route.continue().catch(() => {});
    });
    try {
      await page.goto('/');
      await expect.poll(() => stalled, { timeout: 20000 }).toBe(true);
      await page.getByLabel('Next simulation', { exact: true }).click();
      await expect.poll(() => recordingRequested).toBe(true);
      await expect(page.getByLabel('Selected episode', { exact: true })).toHaveText('2');
      await expect(page.locator('.tt-loading')).toHaveCount(0);
      await expect(page.locator('[role=alert]')).toHaveCount(0);
      await page.getByRole('button', { name: 'Data & AI', exact: true }).click();
      await expect(page.locator('.data-selected')).toContainText('Published recording; no physics recomputation.');
      await expect(page.locator('.data-selected')).toContainText(manifest.episodes[0].sha256);
    } finally { release(); }
  });
}

test('HTML inventory outage is surfaced without physics recomputation', async ({ page }) => {
  let physicsReads = 0;
  await page.route('**/api/tabletop/plans/latest', route => route.fulfill({ status: 404 }));
  await page.route('**/data/tabletop-plan.json', route => route.fulfill({ status: 404 }));
  await page.route('**/data/tabletop-recordings.json', route => route.fulfill({ status: 503, contentType: 'text/html', body: '<h1>Unavailable</h1>' }));
  await page.route('**/model/**', route => { physicsReads++; return route.abort(); });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('inventory unavailable (HTTP 503)');
  expect(physicsReads).toBe(0);
});

test('styled dropdowns support keyboard selection, Escape and mobile layout', async ({ page }) => {
  const { files, manifest } = fixture();
  await page.route('**/api/tabletop/plans/latest', route => route.fulfill({ status: 404 }));
  await page.route('**/data/tabletop-plan.json', route => route.fulfill({ status: 404 }));
  await page.route('**/data/tabletop-recordings.json', route => route.fulfill({ json: manifest }));
  await page.route('**/fixtures/tabletop/**', route => route.fulfill({ body: files.get(new URL(route.request().url()).pathname.replace('/fixtures/tabletop/', ''))!, contentType: 'application/gzip' }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Grid', exact: true }).click();
  const views = page.getByRole('combobox', { name: 'Simultaneous simulations' });
  await views.focus(); await page.keyboard.press('ArrowDown');
  await expect(views).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Home'); await page.keyboard.press('Enter');
  await expect(views).toHaveText('4 views'); await expect(views).toBeFocused();
  await expect(page.locator('.tt-grid-loading')).toHaveCount(0);
  await views.click(); await page.screenshot({ path: 'test-results/dropdown-desktop.png' });
  await page.keyboard.press('Escape'); await expect(views).toHaveAttribute('aria-expanded', 'false');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('combobox', { name: 'Grid task' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: 'test-results/dropdown-mobile.png' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Single', exact: true }).click();
  const speed = page.getByRole('combobox', { name: 'Playback speed' });
  await speed.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('End'); await page.keyboard.press('Enter');
  await expect(speed).toHaveText('2×');
});
