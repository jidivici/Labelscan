import { defineConfig } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4173/backoffice/';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: 'list',
  outputDir: 'test-results',
  use: {
    baseURL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium-1440', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    { name: 'chromium-1024', use: { browserName: 'chromium', viewport: { width: 1024, height: 768 } } },
    { name: 'chromium-390', use: { browserName: 'chromium', viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4173',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
