import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test('create, edit, practice and render at mobile/tablet/desktop sizes', async ({ page, request }) => {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  const name = `浏览器验证 ${randomUUID().slice(0, 8)}`;
  await page.goto('/banks');
  await page.getByLabel('题库名称').fill(name);
  await page.getByRole('button', { name: '创建题库', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true }).first()).toBeVisible();
  await page.getByRole('link', { name: '添加题目', exact: true }).click();
  await page.getByLabel('题干', { exact: true }).fill('1 + 1 等于多少？');
  await page.getByLabel('选项 A', { exact: true }).fill('2');
  await page.getByLabel('选项 B', { exact: true }).fill('3');
  await page.getByLabel('正确选项', { exact: false }).fill('A');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('heading', { name: '题目详情', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '发布', exact: true }).click();
  await expect(page.getByRole('button', { name: '归档', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '返回题库', exact: true }).click();
  const bankUrl = page.url();
  await page.getByRole('link', { name: '开始练习', exact: true }).click();
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await expect(page.getByRole('heading', { name: '专注练习' })).toBeVisible();
  await page.getByText('A. 2', { exact: true }).click();
  await page.getByRole('button', { name: '提交答案', exact: true }).click();
  await expect(page.getByText('回答正确', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '完成并查看结果', exact: true }).click();
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByRole('heading', { name: '练习结果', exact: true })).toBeVisible();
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const url of ['/', '/banks', new URL(bankUrl).pathname, `/analytics${new URL(bankUrl).pathname}`, '/imports/new', '/analytics', '/settings']) {
      await page.goto(url);
      await expect(page.locator('main')).toBeVisible();
      await expect(page.getByLabel('加载中')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (width < 768) await expect(page.getByRole('navigation', { name: '移动导航' })).toBeVisible();
      else await expect(page.getByRole('navigation', { name: '主导航', exact: true })).toBeVisible();
    }
    await page.goto('/');
    await page.screenshot({ path: `test-results/home-${width}.png`, fullPage: true });
  }
  expect(failures).toEqual([]);
});

test('loading errors retry and file upload recovery survives refresh', async ({ page }) => {
  let first = true;
  await page.route('**/api/v1/analytics/snapshot', async route => {
    if (first) { await route.fulfill({ status: 503, json: { error: { code: 'DATABASE_UNAVAILABLE', message: '数据库暂不可用' } } }); }
    else await route.continue();
  });
  await page.goto('/');
  await expect(page.getByText('数据库暂不可用', { exact: true })).toBeVisible();
  first = false;
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByText('数据库暂不可用', { exact: true })).toHaveCount(0);
  await page.goto('/banks');
  await page.getByRole('link', { name: '打开题库', exact: true }).first().click();
  await page.getByRole('link', { name: '导入题目', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({ name: 'browser-import.txt', mimeType: 'text/plain', buffer: Buffer.from('Question: 1 + 1? Answer: 2') });
  // A failing submission must retain the job/file identity without fabricating success.
  await page.route('**/api/v1/import-jobs/*/parse', route => route.fulfill({ status: 503, json: { error: { code: 'AI_UNAVAILABLE', message: 'AI 尚未配置' } } }));
  await page.getByRole('button', { name: '上传并开始解析', exact: true }).click();
  await expect(page.getByText('AI 尚未配置', { exact: true })).toBeVisible();
  const before = await page.evaluate(() => localStorage.getItem('practiq-import'));
  expect(JSON.parse(before!).id).toBeGreaterThan(0);
  await page.reload();
  await expect(page.getByText('发现未完成的导入', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('practiq-import'))).toEqual(before);
  await page.getByRole('button', { name: '选择文件', exact: true }).focus();
  await expect(page.getByRole('button', { name: '选择文件', exact: true })).toBeFocused();
});
