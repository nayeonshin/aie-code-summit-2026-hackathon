import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  use: { baseURL: 'http://127.0.0.1:5173', viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', launchOptions: process.env.PLAYWRIGHT_CHROME ? { channel: 'chrome' } : {} },
  webServer: [
    { command: 'python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000', url: 'http://127.0.0.1:8000/api/health', reuseExistingServer: true },
    { command: 'npm run dev', url: 'http://127.0.0.1:5173', reuseExistingServer: true },
  ],
});
