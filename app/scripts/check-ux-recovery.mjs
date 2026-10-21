import { chooseOption } from "../../shared/select-test.mjs";
import { test as runner, expect } from 'playwright/test';
import { withEvidence } from '../../shared/browser-evidence.mjs';
const test = withEvidence(runner);

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
  if (page.viewportSize().width < 768) {
    const back=page.getByRole('button',{name:/^返回(题库|练习记录|设置|评分)$/});
    await expect(menu.or(back).first()).toBeVisible();
    if (!await menu.count()) { await back.click(); await expect(menu).toBeVisible(); }
    await menu.click();
  }
  await page.getByRole('button', { name, exact: true }).click();
}

for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
  test(`service failures stay with their controls at ${width}px in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 850 });
    await page.addInitScript(value => localStorage.setItem('practiq-theme', value), theme);
    await inject(page, `
      if (command === 'request' && args?.request?.type === 'test_settings') {
        globalThis.connectionTests = (globalThis.connectionTests || 0) + 1;
        throw new Error('Synthetic connection failure');
      }
      if (command === 'request' && args?.request?.type === 'save_settings' && args.request.service_token === '') {
        globalThis.clearAttempts = (globalThis.clearAttempts || 0) + 1;
        if (globalThis.clearAttempts === 1) throw new Error('Synthetic credential clear failure');
      }
    `);
    await page.goto('/');
    await navigate(page, '设置');
    await page.getByRole('button', { name: '配置', exact: true }).click();
    await page.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(1);
    await expect(page.getByRole('alert')).toContainText('Synthetic connection failure');
    const errorToast = page.locator('[data-sonner-toast][data-type="error"]');
    await expect(errorToast).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`connection-error-${width}-${theme}.png`), fullPage: true });
    await navigate(page, '设置');
    await page.getByRole('button', { name: '导入与恢复', exact: true }).click();
    await page.getByRole('menuitem', { name: '导入题库 ZIP', exact: true }).click();
    const confirm = page.getByRole('button', { name: '确认导入', exact: true });
    await expect(confirm).toBeEnabled();
    await confirm.scrollIntoViewIfNeeded();
    expect(await confirm.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    })).toBe(true);
    await expect(errorToast).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`import-unobscured-${width}-${theme}.png`), fullPage: true });
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '配置', exact: true }).click();
    const clear = page.getByRole('button', { name: '清除已保存的访问令牌', exact: true });
    await expect(clear).toBeEnabled();
    await clear.click();
    await expect(page.getByRole('alert')).toHaveCount(1);
    await expect(page.getByRole('alert')).toContainText('Synthetic credential clear failure');
    await expect(errorToast).toHaveCount(0);
    await expect(clear).toBeEnabled();
    await clear.click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(clear).toBeDisabled();
    expect(await page.evaluate(() => ({ tests: globalThis.connectionTests, clears: globalThis.clearAttempts }))).toEqual({ tests: 1, clears: 2 });
  });
}

for (const width of [1280, 360]) {
  test(`history refresh stays beside filters and preserves read recovery at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 850 });
    await inject(page, `
      if (command === 'request' && args?.request?.type === 'sessions_page') {
        globalThis.historyReads = [...(globalThis.historyReads || []), args.request];
        if (globalThis.historyFail) { globalThis.historyFail = false; throw new Error('Synthetic history read failure'); }
        while (globalThis.historyHold) await new Promise(resolve => setTimeout(resolve, 20));
        if (!globalThis.historyPopulated) return { items: [], total: 0, offset: 0 };
      }
    `);
    await page.goto('/');
    await navigate(page, '练习记录');
    const refresh = page.getByRole('button', { name: '刷新', exact: true });
    const filter = page.getByRole('combobox', { name: '练习记录状态', exact: true });
    await expect(refresh).toBeEnabled();
    await expect(page.getByText('还没有练习记录', { exact: true })).toBeVisible();
    const [action, select, empty] = await Promise.all([refresh, filter, page.locator('[data-slot="empty"]')].map(node => node.boundingBox()));
    expect(Math.abs(action.y + action.height / 2 - select.y - select.height / 2)).toBeLessThanOrEqual(1);
    expect(action.y + action.height).toBeLessThan(empty.y);
    expect(action.x).toBeGreaterThan(select.x + select.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`history-refresh-empty-${width}.png`), fullPage: true });
    await chooseOption(filter, 'active');
    await expect(page.getByText('没有符合此状态的记录', { exact: true })).toBeVisible();
    const reads = await page.evaluate(() => globalThis.historyReads.length);
    await page.evaluate(() => { globalThis.historyPopulated = true; globalThis.historyHold = true; });
    await refresh.click();
    await expect(refresh).toBeDisabled();
    await page.evaluate(() => { globalThis.historyHold = false; });
    await expect(page.getByRole('button', { name: '继续练习', exact: true }).first()).toBeVisible();
    await expect(refresh).toBeEnabled();
    const requests = await page.evaluate(() => globalThis.historyReads.slice(-1));
    expect(requests[0]).toMatchObject({ filter: 'active', offset: 0 });
    expect(await page.evaluate(() => globalThis.historyReads.length)).toBe(reads + 1);
    await page.screenshot({ path: testInfo.outputPath(`history-refresh-populated-${width}.png`), fullPage: true });
    await page.evaluate(() => { globalThis.historyFail = true; });
    await refresh.click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(refresh).toBeEnabled();
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.getByRole('alert')).toBeHidden();
    await expect(filter).toHaveText('进行中');
  });
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
    if (width < 768) await page.getByRole('button', { name: '筛选', exact: true }).click();
    await review.check();
    await page.getByRole('button', { name: '导入题库 ZIP', exact: true }).click();
    expect(await page.evaluate(() => globalThis.auditImports || 0)).toBe(0);
    await page.getByRole('menuitem', { name: '导入题库 ZIP', exact: true }).click();
    await chooseOption(page.getByRole('combobox', { name: '导入到', exact: true }), 'preview-bank-0');
    await page.getByRole('button', { name: '确认导入', exact: true }).click();
    await expect(page.getByText('已导入 9 道题目', { exact: true })).toBeVisible();
    await expect(retry).toBeVisible();
    if (width < 768) await page.getByRole('button', { name: '筛选', exact: true }).click();
    await expect(review).not.toBeChecked();
    await retry.click();
    await expect(retry).toBeHidden();
    expect(await page.evaluate(() => globalThis.auditImports)).toBe(1);
  });

  test(`manual grading drafts and configuration return preserve context at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await inject(page, `
      // This scenario supplies a reference for the current question; the stock
      // preview's grading fixture deliberately has missing evidence.
      if (command === 'request' && args?.request?.type === 'session' && args.request.id === 'preview-grading') {
        if (globalThis.auditFailReturn) { globalThis.auditFailReturn = false; throw { code: 'OPERATION_FAILED', diagnostic: 'Session read unavailable (synthetic)' }; }
        const { demoInvoke } = await import('/src/preview-data.ts');
        const session = await demoInvoke(command, args, 'normal');
        session.attempts[0].snapshot.question.answerPayload = { text: 'Checked reference' };
        return session;
      }
      if (command === 'ai_request') {
        globalThis.auditGradingCalls = (globalThis.auditGradingCalls || 0) + 1;
        globalThis.auditFailReturn = true;
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
    await expect(page.getByRole('alert').filter({ hasText: '操作失败' })).toBeVisible();
    await expect(page.getByLabel('AI 服务地址', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`settings-return-error-${width}.png`) });
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
    if (width < 768) await page.getByRole('button', { name: '筛选', exact: true }).click();
    await chooseOption(page.getByLabel('筛选题型'), 'single');
    await page.getByRole('checkbox', { name: '仅看待复核' }).check();
    await expect(page.getByText('没有符合筛选的题目', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`filters-empty-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: '清除筛选', exact: true }).click();
    await expect(page.getByLabel('搜索题目', { exact: true })).toBeFocused();
    await expect(page.getByLabel('筛选题型')).toHaveAttribute('data-value', '');
    await expect(page.getByRole('checkbox', { name: '仅看待复核' })).not.toBeChecked();
    await expect(page.getByText('题库共 9 小题 · 当前匹配 9 项', { exact: true })).toBeVisible();
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
    await expect(setup.getByText('提交后查看参考答案，可对照自评。',{exact:true})).toBeVisible();
    await expect(setup.getByRole('button',{name:'立即开始',exact:true})).toBeEnabled();
    await page.screenshot({path:testInfo.outputPath(`setup-${width}.png`),fullPage:true});
    await setup.getByRole('button',{name:'立即开始',exact:true}).click();
    await page.getByRole('link',{name:'查看答题卡',exact:true}).click();
    await expect(page.getByRole('progressbar',{name:'提交进度'})).toHaveAttribute('value','0');
    await expect(page.locator('#answer-card-panel')).toBeFocused();
    await expect(page.getByLabel('本次题目状态',{exact:true})).toBeInViewport();
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
    await expect(empty.getByText('0 题',{exact:true})).toBeVisible();
    await empty.getByRole('button',{name:'查看题目',exact:true}).click();
    await expect(page.getByRole('button',{name:'新增题目',exact:true})).toBeEnabled();
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

for (const width of [1280, 360]) {
  test(`persistent errors, deletion focus and explicit retry at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await inject(page, `
      if (command === 'request' && args?.request?.type === 'delete_bank') {
        globalThis.auditDeletes = (globalThis.auditDeletes || 0) + 1;
        if (globalThis.auditDeletes === 1) throw { code: 'OPERATION_FAILED', diagnostic: 'Disk full (synthetic)', requestId: 'demo-request' };
      }
      if (command === 'request' && args?.request?.type === 'save_bank') throw { code: 'OPERATION_FAILED', diagnostic: 'Disk full (synthetic)' };
    `);
    if (width === 360) await page.emulateMedia({ colorScheme: "dark" });
    await page.goto('/');
    const trigger = page.getByRole('button', { name: '题库操作 基础知识 · 全题型', exact: true });
    await trigger.click(); await expect(page.getByRole('menu', { name: '题库操作 基础知识 · 全题型', exact: true })).toBeVisible(); await page.getByRole('menuitem', { name: '删除题库', exact: true }).click();
    let dialog = page.getByRole('alertdialog');
    await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(trigger).toBeFocused();
    await trigger.click(); await expect(page.getByRole('menu', { name: '题库操作 基础知识 · 全题型', exact: true })).toBeVisible(); await page.getByRole('menuitem', { name: '删除题库', exact: true }).click();
    await dialog.getByRole('button', { name: '删除题库', exact: true }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog.getByText(/已有练习记录和内容快照会保留/)).toBeVisible();
    await page.waitForTimeout(4500);
    await expect(dialog.getByRole('alert')).toBeVisible();
    expect(await page.evaluate(() => globalThis.auditDeletes)).toBe(1);
    await page.screenshot({ path: testInfo.outputPath(`delete-error-${width}.png`) });
    await dialog.getByRole('button', { name: '删除题库', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('heading', { name: '我的题库', exact: true })).toBeFocused();
    expect(await page.evaluate(() => globalThis.auditDeletes)).toBe(2);
    await page.getByRole('button', { name: '新建题库', exact: true }).click();
    await page.getByLabel('题库名称', { exact: true }).fill('未保存的示例题库');
    await page.getByRole('button', { name: '保存题库', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '新建题库' });
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(page.getByLabel('题库名称', { exact: true })).toHaveValue('未保存的示例题库');
    await dialog.getByText('诊断详情', { exact: true }).click();
    await expect(dialog.getByText(/Disk full/)).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(900);
    await page.screenshot({ path: testInfo.outputPath(`editor-error-${width}.png`) });
    await dialog.getByRole('button', { name: '关闭提示', exact: true }).click();
    await expect(page.getByLabel('题库名称', { exact: true })).toHaveValue('未保存的示例题库');
  });

  test(`lazy view failure stays local and closes without native work at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route(/\/src\/StudySetup\.tsx(?:\?.*)?$/, route => route.abort('failed'));
    if (width === 360) await page.emulateMedia({ colorScheme: "dark" });
    await page.goto('/');
    await page.getByRole('button', { name: '开始练习', exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: '此界面暂时无法显示' }).last()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`render-failure-${width}.png`) });
    await dialog.getByRole('button', { name: '关闭', exact: true }).last().click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('heading', { name: '我的题库', exact: true })).toBeVisible();
    await navigate(page, '练习记录');
    await expect(page.getByRole('heading', { name: '练习记录', exact: true })).toBeVisible();
  });
}


test('subpage return preserves failed settings feedback without a second navigation control', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await inject(page, `
    if (command === 'request' && args?.request?.type === 'save_settings') throw { code: 'OPERATION_FAILED', diagnostic: 'Settings save unavailable (synthetic)' };
  `);
  await page.goto('/'); await navigate(page, '设置');
  await page.getByRole('button', { name: '配置', exact: true }).click();
  await page.getByLabel('AI 服务地址', { exact: true }).fill('http://127.0.0.1:8000');
  await page.getByRole('heading', { name: 'AI 服务', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button',{name:'打开主导航',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'返回设置',exact:true}).click();
  await expect(page.getByRole('heading',{name:'AI 服务',exact:true})).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(1);
  await expect(page.getByLabel('AI 服务地址', { exact: true })).toHaveValue('http://127.0.0.1:8000');
  await page.screenshot({path:testInfo.outputPath('subpage-return-save-error-360.png')});
});

for (const width of [1280, 360]) {
  test(`restore confirmation returns focus to its surviving menu trigger at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await inject(page, `if (command === 'request' && args?.request?.type === 'restore') { globalThis.auditRestores = (globalThis.auditRestores || 0) + 1; }`);
    await page.goto('/'); await navigate(page, '设置');
    const trigger = page.getByRole('button', { name: '导入与恢复', exact: true });
    for (const name of ['恢复学习数据备份', '修复资源并恢复备份']) {
      await trigger.click(); await page.getByRole('menuitem', { name, exact: true }).click();
      const confirmation = page.getByRole('alertdialog', { name: '用备份替换当前数据？', exact: true });
      await expect(confirmation).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`restore-confirmation-${width}-${name === '修复资源并恢复备份' ? 'repair' : 'normal'}.png`) });
      await confirmation.getByRole('button', { name: '取消', exact: true }).click();
      await expect(trigger).toBeFocused();
    }
    expect(await page.evaluate(() => globalThis.auditRestores || 0)).toBe(0);
  });
}

for (const width of [1280, 360]) {
  test(`workspace errors stay below headings and keep diagnostics compact at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    if (width === 360) await page.emulateMedia({ colorScheme: 'dark' });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => { globalThis.auditCopiedError = value; } } });
    });
    await inject(page, `if (command === 'request' && args?.request?.type === 'backup') throw { code: 'LOCAL_BANK_ZIP_INVALID', params: { detail: 'ZIP entry checksum mismatch. '.repeat(160) } };`);
    await page.goto('/'); await navigate(page, '设置');
    await page.getByRole('button', { name: '导出备份', exact: true }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    const header = await page.locator('.app-header').boundingBox();
    const card = await page.locator('[data-slot=card]').filter({ has: page.getByRole('heading', { name: '学习数据备份', exact: true }) }).boundingBox();
    const closed = await alert.boundingBox();
    expect(closed.y).toBeGreaterThanOrEqual(header.y + header.height);
    expect(Math.abs(closed.x - card.x)).toBeLessThan(2);
    expect(Math.abs(closed.width - card.width)).toBeLessThan(2);
    expect(closed.height).toBeLessThan(width === 360 ? 180 : 120);
    await page.screenshot({ path: testInfo.outputPath(`workspace-error-collapsed-${width}.png`), animations: 'disabled' });
    await alert.getByText('诊断详情', { exact: true }).click();
    await alert.getByRole('button', { name: '复制诊断', exact: true }).click();
    await expect(alert.getByRole('status')).toHaveText('诊断已复制');
    const expanded = await alert.boundingBox();
    expect(expanded.height).toBeLessThan(width === 360 ? 400 : 320);
    await expect(alert.locator('pre')).not.toContainText('题库 ZIP 无法读写');
    expect(await alert.locator('pre').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await alert.locator('summary').focus();
    await page.keyboard.press('Tab');
    await expect(alert.locator('pre')).toBeFocused();
    await page.keyboard.press('End');
    await expect.poll(() => alert.locator('pre').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    expect(await page.evaluate(() => globalThis.auditCopiedError)).toContain('题库 ZIP 无法读写');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`workspace-error-expanded-${width}.png`), animations: 'disabled' });
    await alert.getByRole('button', { name: '关闭提示', exact: true }).click();
    await expect(alert).toBeHidden();
    await expect(page.getByRole('heading', { name: '学习数据备份', exact: true })).toBeVisible();
  });
}

for (const [width, locale] of [[1280, 'zh-CN'], [390, 'zh-CN'], [360, 'en']]) {
  test(`bank refresh stays in the header and preserves loading, recovery and paging at ${width}px (${locale})`, async ({ page }, testInfo) => {
    const english = locale === 'en';
    const label = english ? 'Refresh' : '刷新';
    await page.setViewportSize({ width, height: 850 });
    await page.addInitScript(language => {
      Object.defineProperty(navigator, 'languages', { get: () => [language] });
      if (!sessionStorage.getItem('practiq-preview')) sessionStorage.setItem('practiq-preview', 'empty');
    }, locale);
    await inject(page, `
      if (command === 'request' && args?.request?.type === 'banks_page') {
        globalThis.bankPageReads = [...(globalThis.bankPageReads || []), args.request];
        while (globalThis.bankPageHold) await new Promise(resolve => setTimeout(resolve, 20));
        if (globalThis.bankPageFail) { globalThis.bankPageFail = false; throw new Error('Synthetic bank read failure'); }
      }
    `);
    await page.goto('/');
    await page.addStyleTag({ content: '.preview-controls { display: none; }' });
    const refresh = page.locator('header').getByRole('button', { name: label, exact: true });
    await expect(refresh).toBeEnabled();
    await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(1);
    const empty = page.getByText(english ? 'Start with your first bank' : '从第一个题库开始', { exact: true });
    await expect(empty).toBeVisible();
    const [action, content] = await Promise.all([refresh.boundingBox(), empty.boundingBox()]);
    expect(action.y + action.height).toBeLessThan(content.y);
    expect(action.height).toBeGreaterThanOrEqual(width < 768 ? 48 : 40);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`bank-refresh-empty-${width}.png`), fullPage: true });
    await page.evaluate(() => { globalThis.bankPageHold = true; globalThis.bankPageFail = true; });
    await refresh.click();
    await expect(refresh).toBeDisabled();
    await page.evaluate(() => { globalThis.bankPageHold = false; });
    await expect(page.getByRole('alert').filter({ hasText: 'Synthetic bank read failure' })).toBeVisible();
    await expect(refresh).toBeEnabled();
    await refresh.click();
    await expect(empty).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.evaluate(() => sessionStorage.setItem('practiq-preview', 'many'));
    await page.reload();
    await page.addStyleTag({ content: ".preview-controls { display: none; }" });
    const next = page.getByRole('button', { name: english ? 'Next page' : '下一页', exact: true });
    await expect(next).toBeEnabled(); await next.click();
    await expect(refresh).toBeEnabled();
    await page.evaluate(() => { globalThis.bankPageReads = []; });
    await refresh.click();
    await expect.poll(() => page.evaluate(() => globalThis.bankPageReads?.at(-1)?.offset)).toBe(30);
    await expect(refresh).toBeEnabled();
    await expect(next).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`bank-refresh-paged-${width}.png`), fullPage: true });
  });
}
