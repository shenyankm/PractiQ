import { test, expect } from 'playwright/test';

test('rich content renders math, tables and images with keyboard zoom', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const fontRequests = [];
  page.on('request', r => { if (r.resourceType() === 'font') fontRequests.push(r.url()); });
  // This fixture owns a deterministic asset mock; bypass the general preview data.
  await page.addInitScript(() => sessionStorage.setItem('practiq-preview', 'real'));
  await page.goto('/fixtures/rich-content/');
  await page.locator('figure').first().scrollIntoViewIfNeeded();
  const zoom = page.getByRole('button',{name:'放大查看图片'});
  await expect(zoom).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  expect(fontRequests.length).toBeGreaterThan(0);
  expect(fontRequests.every(url => new URL(url).pathname.endsWith('.woff2'))).toBe(true);
  await expect.poll(() => page.evaluate(() => [...document.fonts].filter(f => f.family.startsWith('KaTeX') && f.status === 'loaded').length)).toBeGreaterThan(0);
  expect(await page.evaluate(() => [...document.fonts].filter(f => f.family.startsWith('KaTeX') && f.status === 'error'))).toEqual([]);
  await expect(page.locator('.katex-error')).toHaveCount(0);
  await expect(page.locator('.katex-display')).toHaveCount(3);
  await expect(page.locator('table td')).toHaveCount(12);
  // A .katex node alone misses incompatible renderer/CSS versions: fractions overlap.
  await expect.poll(() => page.locator('.katex-display .katex-sizing.reset-size6.size3').first().evaluate(el =>
    Math.abs(parseFloat(getComputedStyle(el).fontSize) / parseFloat(getComputedStyle(el.closest('.katex')).fontSize) - 0.7))).toBeLessThan(0.01);
  await expect.poll(() => page.locator('figure img').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
  for (const width of [1280,960]) {
    await page.setViewportSize({width,height:850});
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),`overflow at ${width}`).toBe(true);
  }
  await zoom.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect.poll(() => page.getByRole('dialog').locator('img').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(zoom).toBeFocused();
  await page.setViewportSize({width:1280,height:850});
  await page.screenshot({path:testInfo.outputPath('desktop.png'),fullPage:true});
  if (process.env.PRACTIQ_GENERATE_RICH_PDF === '1') {
    await zoom.evaluate(el => el.style.display='none');
    await page.pdf({path:'fixtures/rich-content/source.pdf',format:'A4',printBackground:true,margin:{top:'12mm',bottom:'12mm',left:'12mm',right:'12mm'}});
  }
  expect(errors).toEqual([]);
});
