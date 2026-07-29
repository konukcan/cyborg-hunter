// playwright.config.js
// E2E suite for the live demo tour (demo/tests/tour.spec.js). webServer
// assembles the same artifact the Pages CI workflow deploys (demo/* + dist/
// into .demo-site/, gitignored) and serves it with a dependency-free static
// server, so the suite runs against something that behaves like the
// deployed site rather than the bare demo/ directory.

import { defineConfig, devices } from '@playwright/test';

const PORT = 8177;

export default defineConfig({
  testDir: 'demo/tests',
  retries: 0,
  timeout: 60000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    acceptDownloads: true,
  },
  webServer: {
    command: `node tools/assemble-demo-site.mjs && node tools/serve-demo.mjs ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
