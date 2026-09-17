import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function createBank(page: import('@playwright/test').Page, name: string) {
  await page.goto('/banks');
  await page.getByLabel('题库名称').fill(name);
  await page.getByRole('button', { name: '创建题库', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true }).first()).toBeVisible();
  await page.getByRole('link', { name: '添加题目', exact: true }).click();
}

async function chooseType(page: import('@playwright/test').Page, label: string) {
  await page.getByRole('button', { name: '题型' }).click();
  await page.getByRole('option', { name: label }).click();
}

test('ordering question: create with items, publish, practice by moving items and grade', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  const name = `排序验证 ${randomUUID().slice(0, 8)}`;
  await createBank(page, name);
  await chooseType(page, '排序题');
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: '添加条目', exact: true }).click();
  await page.getByLabel('正确顺序', { exact: false }).fill('1,2,3');
  await page.getByLabel('来源原文', { exact: true }).fill('将需求分析、系统设计、测试验收按顺序排列');
  await page.getByLabel('解析', { exact: true }).fill('先分析需求，再设计，最后测试验收。');
  await expect(page.getByRole('textbox', { name: '条目 1' })).toBeVisible();
  await page.getByLabel('题干', { exact: true }).fill('将步骤按顺序排列');
  await page.getByRole('textbox', { name: '条目 1' }).fill('需求分析');
  await page.getByRole('textbox', { name: '条目 2' }).fill('系统设计');
  await page.getByRole('textbox', { name: '条目 3' }).fill('测试验收');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('heading', { name: '题目详情', exact: true })).toBeVisible();
  await expect(page.getByText('条目 1 · 需求分析', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '发布', exact: true }).click();
  await expect(page.getByRole('button', { name: '归档', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '返回题库', exact: true }).click();
  const bankUrl = page.url();
  await page.getByRole('link', { name: '开始练习', exact: true }).click();
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await expect(page.getByRole('heading', { name: '专注练习' })).toBeVisible();
  await expect(page.getByText('需求分析', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '下移', exact: true }).first().click();
  await page.getByRole('button', { name: '下移', exact: true }).first().click();
  await page.getByRole('button', { name: '提交答案', exact: true }).click();
  await expect(page.getByText('回答正确', { exact: true })).toBeVisible();
  await expect(page.getByText(/参考答案：需求分析 → 系统设计 → 测试验收/)).toBeVisible();
  await page.getByRole('button', { name: '完成并查看结果', exact: true }).click();
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByRole('heading', { name: '练习结果', exact: true })).toBeVisible();
  await expect(page.getByText(/你的答案：需求分析 → 系统设计 → 测试验收/)).toBeVisible();
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.goto(new URL(bankUrl).pathname);
    await expect(page.locator('main')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  expect(failures).toEqual([]);
});

test('short answer: keyword-free question stays ungraded and supports self review', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  const name = `自评验证 ${randomUUID().slice(0, 8)}`;
  await createBank(page, name);
  await chooseType(page, '简答题');
  await page.getByLabel('来源原文', { exact: true }).fill('简述冒泡排序的思路');
  await page.getByLabel('解析', { exact: true }).fill('比较相邻元素，将较大元素逐轮后移。');
  await page.getByLabel('题干', { exact: true }).fill('简述冒泡排序的思路');
  await page.getByLabel('参考答案', { exact: true }).fill('相邻元素两两比较，逐轮将最大值沉底');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('heading', { name: '题目详情', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '发布', exact: true }).click();
  await expect(page.getByRole('button', { name: '归档', exact: true })).toBeVisible();
  await page.getByRole('link', { name: '返回题库', exact: true }).click();
  await page.getByRole('link', { name: '开始练习', exact: true }).click();
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await expect(page.getByRole('heading', { name: '专注练习' })).toBeVisible();
  await page.getByLabel('你的答案', { exact: true }).fill('相邻两个元素比较，大的往后换');
  await page.getByRole('button', { name: '提交答案', exact: true }).click();
  await expect(page.getByText('请对照参考答案自查', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '记为正确', exact: true }).click();
  await expect(page.getByText('回答正确', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '记为正确', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '完成并查看结果', exact: true }).click();
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect(page.getByRole('heading', { name: '练习结果', exact: true })).toBeVisible();
  await expect(page.getByText('正确', { exact: true })).toBeVisible();
  expect(failures).toEqual([]);
});
