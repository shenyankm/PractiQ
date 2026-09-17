import { test, expect } from '@playwright/test';

test('grouped navigation supports routing, keyboard and responsive layouts', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/banks');
    const nav = page.getByRole('navigation', { name: width < 768 ? '移动导航' : '主导航', exact: true });
    await expect(nav).toBeVisible();
    if (width >= 768) {
      const before = await page.locator('aside').boundingBox();
      await page.getByRole('button', { name: '收起', exact: true }).click();
      await expect(nav).toBeVisible();
      for (const label of ['首页', '题库管理', '学情分析与统计', '系统设置']) {
        const item = nav.getByRole('button', { name: label, exact: true });
        await expect(item).toBeVisible();
        await expect(item).toHaveText('');
        await expect(item.locator(label === '首页' ? 'img' : 'svg')).toHaveCount(1);
      }
      await expect(nav.getByRole('button')).toHaveCount(4);
      expect(await nav.locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
      await nav.getByRole('button', { name: '学情分析与统计', exact: true }).click();
      await expect(page).toHaveURL(/\/analytics$/);
      await nav.getByRole('button', { name: '题库管理', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/banks$/);
      await page.screenshot({ path: `test-results/navigation-collapsed-${width}.png`, fullPage: true, animations: 'disabled' });
      const after = await page.locator('aside').boundingBox();
      expect(after!.width).toBeLessThan(before!.width);
      const expand = page.getByRole('button', { name: '展开', exact: true });
      await expect(expand).toHaveAttribute('aria-expanded', 'false');
      await expand.focus();
      await page.keyboard.press('Enter');
      await expect(nav).toBeVisible();
      await expect(page.getByRole('button', { name: '收起', exact: true })).toHaveAttribute('aria-expanded', 'true');
    }
    if (width < 768) await nav.getByRole('button', { name: 'PractiQ 导航' }).click();
    await expect(nav.getByRole('button', { name: '题库管理', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await expect(nav.getByRole('link', { name: '我的题库' })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link').locator('svg')).toHaveCount(0);
    const analytics = nav.getByRole('button', { name: '学情分析与统计' });
    await analytics.focus();
    await page.keyboard.press('Enter');
    await expect(analytics).toHaveAttribute('aria-expanded', 'true');
    await nav.getByRole('link', { name: '学情统计' }).click();
    await expect(page).toHaveURL(/\/analytics$/);
    if (width < 768) {
      await expect(nav.getByRole('button', { name: 'PractiQ 导航' })).toHaveAttribute('aria-expanded', 'false');
      await nav.getByRole('button', { name: 'PractiQ 导航' }).click();
    }
    await expect(nav.getByRole('link', { name: '学情统计' })).toHaveAttribute('aria-current', 'page');
    await nav.getByRole('button', { name: '系统设置', exact: true }).click();
    await expect(page).toHaveURL(/\/settings$/);
    if (width < 768) await nav.getByRole('button', { name: 'PractiQ 导航' }).click();
    await expect(nav.getByRole('button', { name: '系统设置', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: '分类与知识点' })).toHaveCount(0);
    await nav.getByRole('button', { name: '首页', exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    if (width < 768) await nav.getByRole('button', { name: 'PractiQ 导航' }).click();
    await expect(nav.getByRole('button', { name: '首页', exact: true })).toHaveAttribute('aria-current', 'page');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/navigation-${width}.png`, fullPage: true, animations: 'disabled' });
  }
  expect(errors).toEqual([]);
});

for (const mode of ['animated', 'reduced', 'unsupported'] as const) {
  test(`sidebar toggle supports ${mode} transitions`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: mode === 'reduced' ? 'reduce' : 'no-preference' });
    await page.addInitScript(({ mode }) => {
      const start = document.startViewTransition?.bind(document);
      Object.defineProperty(document, 'startViewTransition', {
        configurable: true,
        value: mode === 'unsupported' ? undefined : (callback: () => void) => {
          document.documentElement.dataset.transitionCalls = String(Number(document.documentElement.dataset.transitionCalls || 0) + 1);
          return start!(callback);
        },
      });
    }, { mode });
    await page.goto('/');
    const toggle = page.locator('button[aria-controls="desktop-navigation"]');
    // Dispatch without waiting for animations to exercise interrupted transitions.
    for (let index = 0; index < 3; index++) {
      await toggle.dispatchEvent('click');
      await expect(toggle).toHaveAttribute('aria-expanded', index % 2 === 0 ? 'false' : 'true');
    }
    expect(await page.locator('html').getAttribute('data-transition-calls')).toBe(mode === 'animated' ? '3' : null);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toBeFocused();
  });
}
