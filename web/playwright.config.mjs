import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "browser.spec.ts",
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: "./test-results/browser",
  use: {
    browserName: "chromium",
    baseURL: "http://127.0.0.1:1671",
    viewport: { width: 1440, height: 1040 },
    locale: "zh-CN",
    reducedMotion: "reduce",
    actionTimeout: 10_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: { command: "npm run dev -- --port 1671", url: "http://127.0.0.1:1671", reuseExistingServer: false },
});
