import { test, expect } from '@playwright/test';

test('empty draft saves, null values render safely, false survives editing', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  const q: Record<string, unknown> = { id: 9001, bank_id: 9001, stem: null, analysis: null, sourceText: null, answer_mode: null, question_type_id: null, choice_variant: null, matching_variant: null, options: [], items: [], answer_keys: [], draftAnswerPayload: null, missingFields: ['stem', 'questionTypeId', 'answerMode', 'answerPayload', 'analysis', 'sourceText'], status: 'draft', media: [], knowledge_points: [] };
  const writes: Record<string, unknown>[] = [];
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data: unknown = [];
    if (request.method() === 'POST' || request.method() === 'PATCH') {
      const body = request.postDataJSON(); writes.push(body);
      Object.assign(q, { stem: body.stem?.trim() || null, analysis: body.analysis?.trim() || null, sourceText: body.sourceText?.trim() || null });
      data = q;
    } else if (path.includes('/questions/9001')) data = q;
    else if (path.endsWith('/question-types')) data = [{ type_id: 'true_false', default_answer_mode: 'true_false', display_name: '判断题' }];
    await route.fulfill({ json: { data } });
  });
  await page.goto('/banks/9001/questions/new');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('heading', { name: '题目详情', exact: true })).toBeVisible();
  expect(writes[0].answerPayload).toBeNull();
  expect(writes[0].stem).toBe('');
  expect(writes[0]).not.toHaveProperty('missingFields');
  await expect(page.getByText('待补全题干', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '发布', exact: true })).toBeDisabled();
  Object.assign(q, { answer_mode: 'true_false', question_type_id: 'true_false', draftAnswerPayload: { value: false } });
  await page.getByRole('link', { name: '编辑题目', exact: true }).click();
  await expect(page.getByRole('button', { name: '参考答案' })).toContainText('错误');
  await page.getByLabel('来源原文', { exact: true }).fill('0 > 1');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('heading', { name: '题目详情', exact: true })).toBeVisible();
  expect(writes[1].answerPayload).toEqual({ value: false });
  expect(writes[1].sourceText).toBe('0 > 1');
  expect(writes[1].stem).toBe('');
  expect(failures).toEqual([]);
});
