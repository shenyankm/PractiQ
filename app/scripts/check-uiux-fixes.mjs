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
    expect(finishBox.y).toBeGreaterThanOrEqual(viewport.y);
    expect(finishBox.y + finishBox.height).toBeLessThanOrEqual(footer.y + 1);
    await finish.click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(finish).toBeFocused();
    expect(await page.evaluate(() => window.__layoutNativeCalls.filter(call => call.command === 'ai_request' || ['save_attempt','submit_paper'].includes(call.request?.type)))).toEqual([]);
  });
}

for (const [width,height] of [[360,640],[667,375],[1280,720]]) {
  test(`practice error recovery retains the footer at ${width}x${height}`, async ({page},testInfo) => {
    await page.setViewportSize({width,height});
    await installLayoutSession(page,{submitted:true,failPositionOnce:true,failInfo:true});
    await page.goto('/');
    if(width<768) await page.getByRole('button',{name:'打开主导航',exact:true}).click();
    await page.getByRole('button',{name:'练习记录',exact:true}).click();
    await page.getByRole('button',{name:'继续练习',exact:true}).click();
    await page.getByRole('button',{name:'下一题',exact:true}).click();
    const failure=page.getByRole('alert').filter({has:page.getByRole('button',{name:'关闭提示',exact:true})});
    await expect(page.getByRole('alert').filter({hasText:'概览读取失败'})).toBeVisible();
    await expect(failure).toBeVisible();
    for(const expanded of [false,true]) {
      if(expanded) await failure.getByText('诊断详情',{exact:true}).click();
      const content=await page.locator('.practice-app-content').boundingBox();
      const footer=await page.locator('.practice-footer').boundingBox();
      const scroll=await page.locator('.practice-scroll').boundingBox();
      expect(footer.y+footer.height).toBeLessThanOrEqual(content.y+content.height);
      expect(scroll.height).toBeGreaterThan(0);
      expect(scroll.y+scroll.height).toBeLessThanOrEqual(footer.y+1);
      const next=page.getByRole('button',{name:'下一题',exact:true});
      await next.focus();
      await expect(next).toBeInViewport();
    }
    const overviewRetry=page.getByRole('button',{name:'重试读取概览',exact:true});
    await overviewRetry.focus();
    await expect(overviewRetry).toBeInViewport();
    expect(await page.locator('.practice-footer').evaluate(node=>node.getBoundingClientRect().bottom)).toBeLessThanOrEqual(height);
    await page.screenshot({path:testInfo.outputPath('practice-error-recovery.png')});
    await page.getByRole('button',{name:'下一题',exact:true}).click();
    await expect(failure).toBeHidden();
    await expect(page.getByRole('heading',{name:/第 2 \/ /})).toBeVisible();
  });
}
