import { test as runner, expect } from 'playwright/test';
import { withEvidence } from '../../shared/browser-evidence.mjs';
const test = withEvidence(runner);
import { installLayoutSession, layoutSnapshots, layoutViewports } from './responsive-fixtures.mjs';

async function capture(page, card, prefix, testInfo) {
  await card.scrollIntoViewIfNeeded();
  const nested = await page.locator('.practice-scroll').evaluate(e => getComputedStyle(e).overflowY === 'auto');
  const scroller = page.locator(nested ? '.practice-scroll' : '.app-content');
  const range = await card.evaluate((e, nested) => {
    const scroller = e.closest(nested ? '.practice-scroll' : '.app-content');
    return { top: e.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop, height: e.offsetHeight, viewport: scroller.clientHeight };
  }, nested);
  const actions = await page.locator('.practice-footer').boundingBox();
  const step = Math.max(80, range.viewport - (actions?.height || 0) - 24);
  for (let part = 0; part < Math.ceil(range.height / step); part++) {
    await scroller.evaluate((e, top) => e.scrollTop = top, range.top + part * step);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: testInfo.outputPath(`${prefix}-${part}.png`) });
  }
}

async function checkContent(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('.app-content,[data-slot="card"],fieldset,.document-content,[data-slot="select-wrapper"]').evaluateAll(elements => elements.filter(e => e.clientWidth && e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflowX === 'visible').map(e => ({ tag: e.tagName, width: e.clientWidth, scroll: e.scrollWidth })))).toEqual([]);
  await expect(page.locator('.katex-error')).toHaveCount(0);
  expect(await page.locator('.katex-display').evaluateAll(elements => elements.filter(e => e.querySelector('.katex-html').getBoundingClientRect().left < e.getBoundingClientRect().left - 1).length)).toBe(0);
  expect(await page.locator('.katex-display,.document-content table').evaluateAll(elements => elements.filter(e => {
    if (e.scrollWidth <= e.clientWidth + 2) return false;
    e.scrollLeft = e.scrollWidth;
    const last = e.matches('table') ? e.querySelector('tbody tr:last-child td:last-child') : [...e.querySelectorAll('.katex-html')].at(-1);
    const clipped = last.getBoundingClientRect().right > e.getBoundingClientRect().right + 2;
    e.scrollLeft = 0;
    return clipped;
  }).length)).toBe(0);
}

const variants = layoutViewports.flatMap(([width, height]) => [{ width, height, submitted: false }, { width, height, submitted: true }]);
for (const variant of variants) {
  const { width, height, submitted } = variant;
  test(`all question layouts at ${width}x${height} (${submitted ? 'reference' : 'answering'})`, async ({ page }, testInfo) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setViewportSize({ width, height });
    await installLayoutSession(page, variant);
    await page.goto('/');
    await page.addStyleTag({ content: '.preview-controls { display: none; }' });
    const navigation = page.getByRole('button', { name: '打开主导航', exact: true });
    if (await navigation.isVisible()) await navigation.click();
    await page.getByRole('button', { name: '练习记录', exact: true }).click();
    await page.getByRole('button', { name: '继续练习', exact: true }).click();
    if (width < 768) await page.getByRole('link', {name:'查看答题卡',exact:true}).click();
    for (let index = 0; index < layoutSnapshots.length; index++) {
      if (index) await page.locator('#answer-card').getByRole('button').nth(index).click();
      await expect(page.locator('#current-question')).toContainText(`${index + 1} /`);
      await page.evaluate(() => document.fonts.ready);
      const key = layoutSnapshots[index].key;
      await checkContent(page);
      const card = page.locator('[data-slot="card"]').filter({ has: page.locator('#current-question') });
      if (key === 'rich-choice') {
        await card.locator('figure').first().scrollIntoViewIfNeeded();
        await expect.poll(() => card.locator('figure img').first().evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
        const option = page.getByText('Matrix option:', { exact: true });
        await option.evaluate(e => {
          const workspace = e.closest('.practice-scroll');
          const scroller = getComputedStyle(workspace).overflowY === 'auto' ? workspace : e.closest('.app-content');
          scroller.scrollTop += e.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 20;
        });
        await expect(option).toBeInViewport();
        expect(await option.evaluate(e => { const r = e.getBoundingClientRect(); return e.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); })).toBe(true);
        await page.screenshot({ path: testInfo.outputPath('rich-choice-option.png') });
      }
      await capture(page, card, key, testInfo);
      const scrollBox = await page.locator('.practice-scroll').boundingBox();
      const footerBox = await page.locator('.practice-footer').boundingBox();
      expect(scrollBox.y + scrollBox.height).toBeLessThanOrEqual(footerBox.y + 1);
      await page.getByRole('button', {name:'结束练习',exact:true}).scrollIntoViewIfNeeded();
      const finishBox = await page.getByRole('button', {name:'结束练习',exact:true}).boundingBox();
      expect(finishBox.y + finishBox.height).toBeLessThanOrEqual(footerBox.y + 1);
      if (submitted) {
        await expect(card.getByRole('region', {name:'我的答案',exact:true})).toBeVisible();
        await expect(card.getByRole('textbox')).toHaveCount(0);
        await expect(card.getByRole('combobox')).toHaveCount(0);
      }
      if (['one_to_one','many_to_one','paragraph_matching'].includes(key) && !submitted) {
        for (const select of await card.getByRole('combobox').all()) expect((await select.boundingBox()).width).toBeGreaterThanOrEqual(160);
      }
      const material = page.getByRole('button', { name: '查看原文', exact: true });
      if (await material.count()) {
        await material.click();
        const reader = page.getByRole('region', { name: '题目材料', exact: true });
        const collapse = page.getByRole('button', { name: '收起原文', exact: true });
        await expect(reader).toBeVisible();
        await expect(collapse).toHaveAttribute('aria-expanded', 'true');
        await checkContent(page);
        await reader.screenshot({ path: testInfo.outputPath(`${key}-material.png`) });
        await collapse.click();
        await expect(reader).toHaveCount(0);
        await expect(material).toBeFocused();
      }
      if (key === 'rich-choice') {
        const label = '放大查看图片';
        await page.locator('figure').first().scrollIntoViewIfNeeded();
        await expect.poll(() => page.locator('figure img').first().evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
        for (const name of [label, ...(submitted ? ['查看原页'] : [])]) {
          const trigger = page.getByRole('button', { name, exact: true });
          await trigger.click();
          const dialog = page.getByRole('dialog');
          await expect.poll(() => dialog.locator('img').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
          expect((await dialog.boundingBox()).height).toBeLessThanOrEqual(height);
          expect(await dialog.locator('img').evaluate(img => img.getBoundingClientRect().width <= img.parentElement.clientWidth)).toBe(true);
          await dialog.getByRole('button', {name:'原始尺寸',exact:true}).click();
          await expect(dialog.getByRole('button', {name:'适应窗口',exact:true})).not.toHaveAttribute('aria-pressed');
          await dialog.getByRole('button', {name:'适应窗口',exact:true}).click();
          await dialog.screenshot({ path: testInfo.outputPath(`${key}-${name}.png`) });
          await page.keyboard.press('Escape');
          await expect(trigger).toBeFocused();
        }
        expect(await card.locator('th').filter({ hasText: 'Sample' }).evaluate(e => { const range = document.createRange(); range.selectNodeContents(e); return range.getClientRects().length; })).toBe(1);
      }
    }
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => window.__layoutNativeCalls.filter(call => call.command === 'ai_request' || ['save_attempt','submit_paper'].includes(call.request?.type)))).toEqual([]);
  });
}
