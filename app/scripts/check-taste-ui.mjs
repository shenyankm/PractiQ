import { test as runner, expect } from 'playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { withEvidence } from '../../shared/browser-evidence.mjs';
import { chooseOption } from '../../shared/select-test.mjs';

const test = withEvidence(runner);
// Baseline capture runs before the presentation changes; normal runs assert the new behavior.
const phase = process.env.PRACTIQ_TASTE_PHASE === 'before' ? 'before' : 'after';
const evidenceRoot = process.env.PRACTIQ_TASTE_EVIDENCE_DIR;
const labels = {
  'zh-CN': { banks: '我的题库', view: '查看题目', filters: '筛选', type: '筛选题型', clear: '清除筛选', search: '搜索题目', expand: '展开侧边栏', collapse: '收起侧边栏' },
  'zh-TW': { banks: '我的題庫', view: '檢視題目', filters: '篩選', type: '篩選題型', clear: '清除篩選', search: '搜尋題目', expand: '展開側邊欄', collapse: '收合側邊欄' },
  en: { banks: 'My banks', view: 'View questions', filters: 'Filters', type: 'Filter by question type', clear: 'Clear filters', search: 'Search questions', expand: 'Expand sidebar', collapse: 'Collapse sidebar' },
};

for (const [width, height] of [[1440, 900], [768, 900], [390, 844], [360, 640]]) for (const theme of ['light', 'dark']) for (const locale of Object.keys(labels)) {
  test(`taste UI ${width} ${theme} ${locale}`, async ({ page }, testInfo) => {
    const names = labels[locale];
    const key = `${width}-${theme}-${locale}`;
    const output = evidenceRoot ? resolve(evidenceRoot, phase) : testInfo.outputPath('captures');
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await mkdir(output, { recursive: true });
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.addInitScript(({ theme, locale }) => {
      localStorage.setItem('practiq-theme', theme);
      Object.defineProperty(navigator, 'languages', { get: () => [locale] });
      window.__tasteNativeCalls = 0;
      window.__TAURI_INTERNALS__ = { invoke: () => { window.__tasteNativeCalls++; throw Error('Unexpected native call in preview'); } };
    }, { theme, locale });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: names.banks, exact: true })).toBeVisible();
    await expect(page.locator('.bank-card')).toHaveCount(4);
    await page.evaluate(() => document.fonts.ready);
    const metrics = { width, height, theme, locale, source: 'Chromium preview; repository demo data; no native or model calls' };
    metrics.sidebarWidth = await page.locator('#app-sidebar').count() ? (await page.locator('#app-sidebar').boundingBox()).width : 0;
    await page.screenshot({ path: resolve(output, `${key}-banks.png`) });
    if (phase === 'after') {
      await expect(page.locator('.resume-actions button').last()).toHaveAttribute('data-variant', 'default');
      await expect(page.locator('.bank-actions button[data-variant="default"]')).toHaveCount(0);
      if (width === 768) expect(metrics.sidebarWidth).toBe(64);
      if (width === 1440) expect(metrics.sidebarWidth).toBe(208);
    }
    await page.getByRole('button', { name: names.view, exact: true }).first().click();
    await expect(page.locator('.question-row')).toHaveCount(9);
    metrics.firstQuestionTop = (await page.locator('.question-row').first().boundingBox()).y;
    metrics.contentWidth = (await page.locator('.app-content').boundingBox()).width;
    await page.screenshot({ path: resolve(output, `${key}-questions.png`) });
    if (phase === 'after') {
      const toggle = page.getByRole('button', { name: new RegExp(`^${names.filters}`) });
      const type = page.getByLabel(names.type, { exact: true });
      if (width < 768) {
        await expect(type).toBeHidden();
        expect(metrics.firstQuestionTop).toBeLessThan(height * .6);
        await toggle.focus();
        await page.keyboard.press('Enter');
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      } else await expect(toggle).toHaveCount(0);
      await chooseOption(type, 'single');
      await expect(type).toHaveAttribute('data-value', 'single');
      await expect(page.locator('.question-row').first()).toBeVisible();
      await expect(page.getByRole('button', { name: names.clear, exact: true })).toBeVisible();
      if (width < 768) {
        await page.screenshot({ path: resolve(output, `${key}-filters-open.png`) });
        await toggle.click();
        await expect(type).toBeHidden();
        await expect(toggle).toContainText('1');
        await toggle.click();
        await expect(type).toHaveAttribute('data-value', 'single');
        const review = page.getByRole('checkbox');
        await review.check();
        await toggle.click();
        await expect(toggle).toContainText('2');
        await toggle.click();
        await expect(review).toBeChecked();
      }
      await page.getByRole('button', { name: names.clear, exact: true }).click();
      await expect(page.getByLabel(names.search, { exact: true })).toBeFocused();
      await expect(page.locator('.question-row')).toHaveCount(9);
      if (width === 768) {
        await page.getByRole('button', { name: names.expand, exact: true }).click();
        await expect(page.locator('#app-sidebar')).toHaveCSS('width', '208px');
        await page.getByRole('button', { name: names.collapse, exact: true }).click();
        await page.setViewportSize({ width: 1440, height });
        await expect(page.locator('#app-sidebar')).toHaveCSS('width', '64px');
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.evaluate(() => window.__tasteNativeCalls)).toBe(0);
    expect(errors).toEqual([]);
    await writeFile(resolve(output, `${key}-metrics.json`), JSON.stringify(metrics, null, 2));
    await testInfo.attach('taste-metrics', { body: JSON.stringify(metrics), contentType: 'application/json' });
  });
}

test('taste responsive defaults retain filters across layout changes', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.locator('#app-sidebar')).toHaveCSS('width', '208px');
  await page.setViewportSize({ width: 768, height: 900 });
  await expect(page.locator('#app-sidebar')).toHaveCSS('width', '64px');
  await page.getByRole('button', { name: '查看题目', exact: true }).first().click();
  await chooseOption(page.getByLabel('筛选题型'), 'single');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#app-sidebar')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^筛选/ })).toContainText('1');
  await page.getByRole('button', { name: /^筛选/ }).click();
  await expect(page.getByLabel('筛选题型')).toHaveAttribute('data-value', 'single');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('#app-sidebar')).toHaveCSS('width', '208px');
  await expect(page.getByLabel('筛选题型')).toHaveAttribute('data-value', 'single');
});
