import { test, expect } from '@playwright/test';

test('new-bank import form adopts AI suggestions and recovers upload without duplicate creation', async ({ page }) => {
  let creates = 0, failParse = true;
  const job = { id: 99, bank_id: 101, file_name: 'math.PDF', source_type: 'pdf', status: 'queued', ai_task_id: null, source_deleted_at: null };
  await page.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown = [];
    if (path === '/api/v1/bank-metadata-tasks') {
      expect(route.request().postDataJSON()).toEqual({ name: '高等数学' });
      data = { id: 98, status: 'queued' };
    } else if (path === '/api/v1/ai-tasks/98') {
      data = { id: 98, status: 'succeeded', result: { description: '微积分复习资料', tags: ['数学', '微积分'] } };
    } else if (path === '/api/v1/import-jobs' && route.request().method() === 'POST') {
      creates++;
      expect(route.request().postDataJSON()).toEqual({ name: '高等数学', description: '微积分复习资料', tags: ['数学', '微积分'], fileName: 'math.PDF', sourceType: 'pdf' });
      data = job;
    } else if (path === '/api/v1/import-jobs/99/parse' && failParse) {
      await route.fulfill({ status: 503, json: { error: { message: '解析暂不可用' } } }); return;
    } else if (path.startsWith('/api/v1/import-jobs/99') && !path.endsWith('/outputs') && !path.endsWith('/events')) data = job;
    await route.fulfill({ json: { data } });
  });
  await page.goto('/imports');
  await page.getByLabel('名称', { exact: true }).fill('高等数学');
  await page.getByLabel('描述（非必填）').fill('手动说明');
  await page.getByRole('button', { name: 'AI 生成描述和标签' }).click();
  await expect(page.getByRole('button', { name: '采用 AI 建议' })).toBeVisible();
  await expect(page.getByLabel('描述（非必填）')).toHaveValue('手动说明');
  await page.getByLabel('名称', { exact: true }).fill('新名称');
  await expect(page.getByRole('button', { name: '采用 AI 建议' })).toBeDisabled();
  await page.getByLabel('名称', { exact: true }).fill('高等数学');
  await page.getByRole('button', { name: '采用 AI 建议' }).click();
  await expect(page.getByLabel('描述（非必填）')).toHaveValue('微积分复习资料');
  await page.locator('input[type=file]').setInputFiles({ name: 'math.PDF', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-test') });
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/import-form-${width}.png`, fullPage: true, animations: 'disabled' });
  }
  await page.getByRole('button', { name: '上传并开始解析' }).click();
  await expect(page.getByText('解析暂不可用', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('发现未完成的导入', { exact: true })).toBeVisible();
  await expect(page.getByLabel('名称', { exact: true })).toHaveValue('高等数学');
  await expect(page.getByLabel('名称', { exact: true })).toBeDisabled();
  failParse = false;
  await page.locator('input[type=file]').setInputFiles({ name: 'math.PDF', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-test') });
  await page.getByRole('button', { name: '恢复导入', exact: true }).click();
  await expect(page).toHaveURL(/\/imports\/99$/);
  expect(creates).toBe(1);
});
