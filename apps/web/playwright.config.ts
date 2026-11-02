import { defineConfig, devices } from '@playwright/test';

// Both apps run for real: the NestJS API on 127.0.0.1:3001 and the Next.js
// page on 127.0.0.1:3000, which reaches the API through its /api proxy. The
// API entry comes first and waits on a URL only this API answers with 2xx.
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3000',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --dir ../api dev',
      url: 'http://127.0.0.1:3001/receipts/count',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
    {
      // Waits on a URL that goes through the API, so the page is only
      // "ready" once the proxy has an API behind it.
      command: 'pnpm dev',
      url: 'http://127.0.0.1:3000/api/receipts/count',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
  ],
});
