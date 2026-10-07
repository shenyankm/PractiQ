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
    expect(await page.evaluate(() => globalThis.auditImports || 0)).toBe(0);
    await page.getByRole('menuitem', { name: '导入题库 ZIP', exact: true }).click();
    await page.getByRole('combobox', { name: '导入到', exact: true }).selectOption('preview-bank-0');
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

for (const width of [1280, 360]) {
  test(`question filter reset restores results and keyboard focus at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    await page.getByRole('button', { name: '查看题目', exact: true }).first().click();
    await page.getByLabel('搜索题目', { exact: true }).fill('no-matching-question');
    await page.getByLabel('筛选题型').selectOption('single');
    await page.getByRole('checkbox', { name: '仅看待复核' }).check();
    await expect(page.getByText('没有符合筛选的题目', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`filters-empty-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: '清除筛选', exact: true }).click();
    await expect(page.getByLabel('搜索题目', { exact: true })).toBeFocused();
    await expect(page.getByLabel('筛选题型')).toHaveValue('');
    await expect(page.getByRole('checkbox', { name: '仅看待复核' })).not.toBeChecked();
    await expect(page.getByText('9 道题目', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const width of [375, 768, 1440]) {
  test(`complete study workspace keeps controls and context reachable at ${width}px`, async ({ page }, testInfo) => {
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.setViewportSize({width,height:900});
    await page.goto('/');
    const bank=page.locator('[data-slot=card]').filter({has:page.getByRole('heading',{name:'基础知识 · 全题型',exact:true})});
    await bank.getByRole('button',{name:'开始练习',exact:true}).click();
    const setup=page.getByRole('dialog',{name:'开始练习或考试',exact:true});
    await expect(setup.getByText('提交后立即查看参考答案，可对照答案自评。',{exact:true})).toBeVisible();
    await expect(setup.getByRole('button',{name:'立即开始',exact:true})).toBeEnabled();
    await page.screenshot({path:testInfo.outputPath(`setup-${width}.png`),fullPage:true});
    await setup.getByRole('button',{name:'立即开始',exact:true}).click();
    await expect(page.getByRole('progressbar',{name:'提交进度'})).toHaveAttribute('value','0');
    await page.getByRole('link',{name:'查看答题卡',exact:true}).click();
    await expect(page.getByRole('region',{name:'答题卡',exact:true})).toBeFocused();
    await page.getByRole('link',{name:'返回当前题',exact:true}).click();
    await expect(page.locator('#current-question')).toBeFocused();
    await page.getByRole('radio').first().click();
    await page.getByRole('button',{name:'提交答案',exact:true}).click();
    await expect(page.getByRole('progressbar',{name:'提交进度'})).toHaveAttribute('value','1');
    await page.screenshot({path:testInfo.outputPath(`practice-${width}.png`),fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await navigate(page,'我的题库');
    await page.getByRole('button',{name:'新建题库',exact:true}).click();
    const editor=page.getByRole('dialog',{name:'新建题库',exact:true});
    await editor.getByLabel('题库名称',{exact:true}).fill('新建的本地题库');
    await editor.getByRole('button',{name:'保存题库',exact:true}).click();
    await expect(page.getByRole('heading',{name:'新建的本地题库',exact:true})).toBeVisible();
    const empty=page.locator('[data-slot=card]').filter({has:page.getByRole('heading',{name:'新建的本地题库',exact:true})});
    await expect(empty.getByText('题库还是空的，打开后可新增题目。',{exact:true})).toBeVisible();
    await navigate(page,'设置');
    await page.screenshot({path:testInfo.outputPath(`settings-${width}.png`),fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  });
}

for(const theme of ['light','dark']) {
  test(`workspace text and input boundaries meet contrast targets in ${theme} theme`, async ({page},testInfo)=>{
    await page.addInitScript(value=>localStorage.setItem('practiq-theme',value),theme);
    await page.setViewportSize({width:375,height:900});
    await page.goto('/');
    await expect(page.getByRole('button',{name:'新建题库',exact:true})).toBeEnabled();
    await expect(page.getByRole('heading',{name:'基础知识 · 全题型',exact:true})).toBeVisible();
    const ratios=await page.evaluate(()=>{
      const root=getComputedStyle(document.documentElement), canvas=document.createElement('canvas'), context=canvas.getContext('2d');
      function luminance(token){context.fillStyle=root.getPropertyValue(token).trim();context.fillRect(0,0,1,1);return [...context.getImageData(0,0,1,1).data].slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);}
      return [['--foreground','--background',4.5],['--card-foreground','--card',4.5],['--muted-foreground','--card',4.5],['--muted-foreground','--muted',4.5],['--primary-foreground','--primary',4.5],['--input','--card',3]].map(([a,b,min])=>{const x=luminance(a),y=luminance(b);return {a,b,min,ratio:(Math.max(x,y)+.05)/(Math.min(x,y)+.05)};});
    });
    for(const {a,b,min,ratio} of ratios)expect(ratio,`${a} on ${b}`).toBeGreaterThanOrEqual(min);
    await page.evaluate(()=>document.documentElement.style.fontSize='200%');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:testInfo.outputPath(`large-text-${theme}.png`),fullPage:true});
  });
}
