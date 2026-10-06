import { test, expect } from 'playwright/test';

async function inject(page, source) {
  await page.route('**/src/transport.ts', async route => {
    const response = await route.fetch();
    const body = await response.text();
    const target = 'const scenario = previewMode();';
    expect(body).toContain(target);
    await route.fulfill({ response, body: body.replace(target, `${source}\n${target}`) });
  });
}

async function navigate(page, name) {
  const menu = page.getByRole('button', { name: '打开主导航', exact: true });
  if (page.viewportSize().width < 768) await menu.click();
  await page.getByRole('button', { name, exact: true }).click();
}

for (const width of [1280, 360]) {
  test(`overview and committed import recover without replay at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await inject(page, `
      if (command === 'request' && args?.request?.type === 'banks') {
        globalThis.auditReads = (globalThis.auditReads || 0) + 1;
        if (globalThis.auditReads === 1 || globalThis.auditFailRefresh) {
          globalThis.auditFailRefresh = false;
          throw new Error('Simulated overview read failure');
        }
      }
      if (command === 'request' && args?.request?.type === 'import') {
        globalThis.auditImports = (globalThis.auditImports || 0) + 1;
        globalThis.auditFailRefresh = true;
      }
    `);
    await page.goto('/');
    const retry = page.getByRole('button', { name: '重试读取概览', exact: true });
    await expect(retry).toBeVisible();
    await expect(page.getByText('题库概览读取失败', { exact: true })).toBeVisible();
    await retry.click();
    await expect(retry).toBeHidden();
    await expect(page.getByText('4 个题库 · 30 道题目', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '查看题目', exact: true }).first().click();
    const review = page.getByRole('checkbox', { name: '仅看待复核', exact: true });
    await review.check();
    await page.getByRole('button', { name: '导入题库 ZIP', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '导入到', exact: true })).toHaveValue('preview-bank-0');
    await page.getByRole('button', { name: '确认导入', exact: true }).click();
    await expect(page.getByText('已导入 9 道题目', { exact: true })).toBeVisible();
    await expect(retry).toBeVisible();
    await expect(review).not.toBeChecked();
    await retry.click();
    await expect(retry).toBeHidden();
    expect(await page.evaluate(() => globalThis.auditImports)).toBe(1);
  });

  test(`manual grading drafts and configuration return preserve context at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await inject(page, `
      // This scenario supplies a reference for the current question; the stock
      // preview's grading fixture deliberately has missing evidence.
      if (command === 'request' && args?.request?.type === 'session' && args.request.id === 'preview-grading') {
        const { demoInvoke } = await import('/src/preview-data.ts');
        const session = await demoInvoke(command, args, 'normal');
        session.attempts[0].snapshot.question.answerPayload = { text: 'Checked reference' };
        return session;
      }
      if (command === 'ai_request') {
        globalThis.auditGradingCalls = (globalThis.auditGradingCalls || 0) + 1;
        throw { code: 'LOCAL_SERVICE_URL_REQUIRED' };
      }
    `);
    await page.goto('/');
    await navigate(page, '练习记录');
    const record = page.locator('[data-slot=card]').filter({ has: page.getByRole('heading', { name: '主观题 · 评分与恢复', exact: true }) });
    await record.getByRole('button', { name: '核对评分', exact: true }).click();
    const score = page.getByRole('textbox', { name: '人工得分', exact: true });
    const reason = page.getByRole('textbox', { name: '改分原因', exact: true });
    await score.fill('2');
    await reason.fill('Checked rubric');
    await page.getByRole('button', { name: '下一题', exact: true }).click();
    await expect(score).toHaveValue('');
    await page.getByRole('button', { name: '上一题', exact: true }).click();
    await expect(score).toHaveValue('2');
    await expect(reason).toHaveValue('Checked rubric');
    await navigate(page, '练习记录');
    await record.getByRole('button', { name: '核对评分', exact: true }).click();
    await expect(score).toHaveValue('2');
    await page.getByRole('button', { name: '核对上次评分结果', exact: true }).click();
    await page.getByRole('button', { name: '配置 AI 服务', exact: true }).click();
    await expect(page.getByLabel('AI 服务地址', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '返回评分', exact: true }).click();
    await expect(page.getByRole('heading', { name: '第 1 / 5 题', exact: true })).toBeVisible();
    await expect(score).toHaveValue('2');
    await expect(reason).toHaveValue('Checked rubric');
    expect(await page.evaluate(() => globalThis.auditGradingCalls)).toBe(1);
    expect(await page.evaluate(async () => (await import('/src/useUnsavedChanges.ts')).canCloseWindow())).toBe(false);
    await page.getByRole('button', { name: '保存人工评分', exact: true }).click();
    await expect(score).toHaveValue('');
    expect(await page.evaluate(async () => (await import('/src/useUnsavedChanges.ts')).canCloseWindow())).toBe(true);
  });
}
