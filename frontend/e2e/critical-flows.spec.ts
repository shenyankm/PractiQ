import { test, expect } from '@playwright/test';

test('auth redirect sends unauthenticated dashboard traffic to sign-in', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/sign-in\?redirect=%2Fdashboard/);
});

test('sign in succeeds for the seeded admin user and lands on the dashboard', async ({ page }) => {
  await page.goto('/sign-in?redirect=%2Fdashboard');
  await page.getByLabel('用户名或邮箱').fill('admin');
  await page.getByLabel('密码').fill('OpenWook123');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByText('Dashboard page')).toBeVisible();
});
