import { defineConfig } from 'playwright/test';

export default defineConfig({
  testDir: './scripts',
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: './test-results/browser',
  use: { browserName: 'chromium', actionTimeout: 10_000, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: [
    { command: 'npm run dev -- --mode test --port 1421', url: 'http://127.0.0.1:1421', reuseExistingServer: false },
    { command: 'npm run dev -- --port 1422', url: 'http://127.0.0.1:1422', reuseExistingServer: false },
    { command: 'npx vite build --mode test --outDir .build/dist-browser-test && npx vite preview --outDir .build/dist-browser-test --host 127.0.0.1 --port 1423 --strictPort', url: 'http://127.0.0.1:1423', reuseExistingServer: false },
  ],
  projects: [
    { name: 'mocked', testMatch: 'check-i18n.mjs', use: { baseURL: 'http://127.0.0.1:1421', viewport: { width: 960, height: 820 }, locale: 'en-US' } },
    { name: 'preview', testMatch: ['check-preview.mjs', 'check-ux-recovery.mjs', 'check-uiux-fixes.mjs', 'check-taste-ui.mjs'], use: { baseURL: 'http://127.0.0.1:1422', viewport: { width: 1280, height: 900 }, locale: 'zh-CN' } },
    { name: 'rich-content', testMatch: ['check-rich-content.mjs', 'check-responsive-content.mjs'], use: { baseURL: 'http://127.0.0.1:1422', viewport: { width: 1280, height: 850 }, locale: 'zh-CN' } },
    { name: 'built-macos', testMatch: 'check-built-navigation.mjs', use: { baseURL: 'http://127.0.0.1:1423', viewport: { width: 1280, height: 850 }, locale: 'zh-CN' } },
  ],
});
