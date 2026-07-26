import process from 'node:process';
import { defineConfig } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';

export default defineConfig({
  testDir: './e2e',
  use: { baseURL },
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: '../scripts/e2e-server.sh',
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000
      }
});
