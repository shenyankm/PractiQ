import { test as runner, expect } from 'playwright/test';
import { withEvidence } from '../../shared/browser-evidence.mjs';
import { installLayoutSession } from './responsive-fixtures.mjs';

const test = withEvidence(runner);
for (const [width,height] of [[360,640],[390,844],[667,375],[768,900],[960,640],[1280,720]]) for (const theme of ['light','dark']) for (const locale of ['zh-CN','en']) {
  test(`UI gallery fixes at ${width}x${height} ${theme} ${locale}`, async ({page},testInfo) => {
    const en = locale === 'en';
    await page.setViewportSize({width,height});
    await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'});
    await installLayoutSession(page,{submitted:true,locale});
    await page.goto('/');
    const menu = page.getByRole('button',{name:en?'Open navigation':'打开主导航',exact:true});
    if (await menu.isVisible()) await menu.click();
    await page.getByRole('button',{name:en?'History':'练习记录',exact:true}).click();
    await page.getByRole('button',{name:en?'Resume practice':'继续练习',exact:true}).click();
    await expect(page.getByRole('region',{name:en?'My answer':'我的答案',exact:true})).toBeVisible();
    const disclosure = page.locator('.practice-answer-card');
    await expect(disclosure).toHaveJSProperty('open',width >= 768);
    const viewport = await page.locator('.practice-scroll').boundingBox();
    const footer = await page.locator('.practice-footer').boundingBox();
    expect(viewport.y + viewport.height).toBeLessThanOrEqual(footer.y + 1);
    expect(footer.y + footer.height).toBeLessThanOrEqual(height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({path:testInfo.outputPath('practice-readonly.png')});
    await page.getByRole('link',{name:en?'View answer card':'查看答题卡',exact:true}).click();
    await expect(page.locator('#answer-card-panel')).toBeFocused();
    await page.getByRole('button',{name:en?'Answer sheet legend':'答题卡状态说明',exact:true}).click();
    const help = page.getByRole('dialog');
    await expect(help).toBeVisible();
    const helpBox = await help.boundingBox();
    expect(helpBox.height).toBeGreaterThanOrEqual(Math.min(220,height * .6));
    expect(helpBox.y).toBeGreaterThanOrEqual(width < 768 ? 0 : viewport.y);
    expect(helpBox.y + helpBox.height).toBeLessThanOrEqual(width < 768 ? height : footer.y + 1);
    await page.screenshot({path:testInfo.outputPath('answer-card-help.png')});
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button',{name:en?'Answer sheet legend':'答题卡状态说明',exact:true})).toBeFocused();
    const finish = page.getByRole('button',{name:en?'Finish practice':'结束练习',exact:true});
    await finish.scrollIntoViewIfNeeded();
    const finishBox = await finish.boundingBox();
    expect(finishBox.y + finishBox.height).toBeLessThanOrEqual(footer.y + 1);
    expect(await page.evaluate(() => window.__layoutNativeCalls.filter(call => call.command === 'ai_request' || ['save_attempt','submit_paper'].includes(call.request?.type)))).toEqual([]);
  });
}
