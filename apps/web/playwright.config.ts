import { defineConfig, devices } from '@playwright/test';

// Both apps run for real: the NestJS API (API_URL, default
// 127.0.0.1:3001) and the Next.js page (WEB_PORT, default 3000), which
// reaches the API through its /api proxy. The API entry comes first and waits
// on a URL only this API answers with 2xx. The child processes read the same
// API_PORT, WEB_PORT and API_URL from the environment.
const webPort = process.env.WEB_PORT ?? '3000';
const apiUrl =
  process.env.API_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? '3001'}`;
const webUrl = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  use: {
    baseURL: webUrl,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --dir ../api dev',
      url: `${apiUrl}/receipts/count`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
    {
      // Waits on a URL that goes through the API, so the page is only
      // "ready" once the proxy has an API behind it.
      command: 'pnpm dev',
      url: `${webUrl}/api/receipts/count`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
  ],
});
