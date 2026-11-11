import { test as runner, expect } from 'playwright/test';
import { withBrowserFixtures } from './browser-fixtures.mjs';
import { chooseOption } from '../../shared/select-test.mjs';
const test=withBrowserFixtures(runner);

async function observe(page,seedReview=false) {
  await page.route('**/scripts/fixtures/transport.ts*',async route=>{
    const response=await route.fetch(),body=await response.text(),target='const scenario = fixtureScenario();';
    expect(body).toContain(target);
    await route.fulfill({response,body:body.replace(target,`
      globalThis.learningCalls ??= [];
      globalThis.learningCalls.push({command,request:args?.request});
      if (${seedReview} && command==='request' && args?.request?.type==='learning_overview') {
        const counts={submitted:7,skipped:1,ungraded:1,auto:{graded:4,correct:2},selfAssessed:{graded:1,correct:1},ai:{graded:0,correct:0},manual:{graded:0,correct:0}};
        const through=Date.now();
        return {days:args.request.days,since:args.request.since,through,counts,
          banks:[{id:'preview-bank-0',title:'基础知识 · 全题型',available:true,counts}],kinds:[{kind:'single',counts}],
          review:[{rootId:'0-q0',bankId:'preview-bank-0',bankTitle:'基础知识 · 全题型',stem:'下面哪一个是质数？',count:1,reason:'repeated_wrong',lastAnsweredAt:through-8*86400000,causes:['misread']}],
          backup:{lastBackupAt:null,newAttempts:7,changedNotes:0,due:true}};
      }
      ${target}`)});
  });
}

for(const [locale,names] of [
  ['zh-CN',{overview:'学习概览',refresh:'刷新',period:'统计范围',cause:'按错因筛选',practice:'专项练习',setup:'开始练习或考试',start:'开始复习 1 题'}],
  ['en',{overview:'Learning overview',refresh:'Refresh',period:'Date range',cause:'Filter by mistake cause',practice:'Practise this area',setup:'Start practice or an exam',start:'Review 1 question'}],
  ['zh-TW',{overview:'學習概覽',refresh:'重新整理',period:'統計範圍',cause:'依錯因篩選',practice:'專項練習',setup:'開始練習或考試',start:'開始複習 1 題'}],
]) for(const theme of ['light','dark']) for(const width of [1440,960]) {
  test(`learning overview fits and opens targeted practice ${locale} ${theme} ${width}`,async({page},testInfo)=>{
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'});
    await page.addInitScript(language=>Object.defineProperty(navigator,'languages',{get:()=>[language]}),locale);
    await observe(page,true);await page.goto('/');
    await page.getByRole('button',{name:names.overview,exact:true}).click();
    await expect(page.getByRole('heading',{name:names.overview,exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:names.start,exact:true})).toBeEnabled();
    const refresh=await page.getByRole('button',{name:names.refresh,exact:true}).boundingBox();
    const start=await page.getByRole('button',{name:names.start,exact:true}).boundingBox();
    expect(Math.abs(refresh.y-start.y)).toBeLessThan(2);
    expect(refresh.x+refresh.width).toBeLessThan(start.x);
    await page.screenshot({path:testInfo.outputPath('learning-overview.png')});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await chooseOption(page.getByLabel(names.period,{exact:true}),'30');
    await expect.poll(()=>page.evaluate(()=>globalThis.learningCalls.filter(call=>call.request?.type==='learning_overview').at(-1).request.days)).toBe(30);
    await chooseOption(page.getByLabel(names.cause,{exact:true}),'knowledge');
    await expect(page.getByRole('button',{name:locale==='en'?'Review 0 questions':locale==='zh-TW'?'開始複習 0 題':'开始复习 0 题',exact:true})).toBeDisabled();
    await page.getByRole('button',{name:names.practice,exact:true}).last().click();
    await expect(page.getByRole('dialog',{name:names.setup,exact:true})).toBeVisible();
    await page.keyboard.press('Escape');
    expect(await page.evaluate(()=>globalThis.learningCalls.some(call=>call.command!=='request' && !(call.command==='cloud_request' && (call.request?.type==='status' || (call.request?.type==='fetch' && call.request.path==='/api/auth/session' && call.request.method==='GET')))))).toBe(false);
    expect(errors).toEqual([]);
  });
}

test('review starts explicitly, notes persist after reopening, and duplicate policy is sent only on confirmation',async({page},testInfo)=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await observe(page,true);await page.goto('/');
  await page.getByRole('button',{name:'学习概览',exact:true}).click();
  await page.getByRole('button',{name:'开始复习 1 题',exact:true}).click();
  await expect(page.locator('.practice-session')).toBeVisible();
  await page.getByRole('radio',{name:/2/}).first().click();
  await page.getByRole('button',{name:'提交答案',exact:true}).click();
  await page.getByRole('button',{name:'笔记与错因',exact:true}).click();
  await page.getByLabel('个人笔记',{exact:true}).fill('先核对单位，再计算。');
  await chooseOption(page.getByLabel('错因',{exact:true}),'calculation');
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'笔记与错因',exact:true})).toBeHidden();
  await page.getByRole('button',{name:'笔记与错因',exact:true}).click();
  await expect(page.getByLabel('个人笔记',{exact:true})).toHaveValue('先核对单位，再计算。');
  await page.screenshot({path:testInfo.outputPath('notes.png')});await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await expect(page.getByText('尚未导出学习数据备份。',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'导出备份',exact:true}).click();
  await expect(page.getByText(/^上次成功备份：/)).toBeVisible();
  await page.getByRole('button',{name:'导入与恢复',exact:true}).click();
  await page.getByRole('menuitem',{name:'导入题库 ZIP',exact:true}).click();
  await chooseOption(page.getByLabel('导入到',{exact:true}),'preview-bank-0');
  await expect(page.getByLabel('重复题处理',{exact:true})).toBeVisible();
  const importsBefore=await page.evaluate(()=>globalThis.learningCalls.filter(call=>call.request?.type==='import').length);
  expect(importsBefore).toBe(0);
  await chooseOption(page.getByLabel('重复题处理',{exact:true}),'skip');
  await page.screenshot({path:testInfo.outputPath('duplicates.png')});
  await page.getByRole('button',{name:'确认导入',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>globalThis.learningCalls.filter(call=>call.request?.type==='import').length)).toBe(1);
  expect(await page.evaluate(()=>globalThis.learningCalls.find(call=>call.request?.type==='import').request.skip_duplicates)).toBe(true);
  expect(await page.evaluate(()=>globalThis.learningCalls.some(call=>call.command!=='request' && !(call.command==='cloud_request' && (call.request?.type==='status' || (call.request?.type==='fetch' && call.request.path==='/api/auth/session' && call.request.method==='GET')))))).toBe(false);
  expect(errors).toEqual([]);
});

test.describe('local calendar boundaries',()=>{
  test.use({timezoneId:'America/New_York'});
  test('keeps local midnight across the November daylight-saving change',async({page})=>{
    await page.clock.setFixedTime(new Date('2026-11-02T12:00:00Z'));
    await observe(page,true);await page.goto('/');await page.getByRole('button',{name:'学习概览',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>globalThis.learningCalls.find(call=>call.request?.type==='learning_overview')?.request.since)).toBe(Date.parse('2026-10-27T04:00:00Z'));
    expect(await page.evaluate(()=>globalThis.learningCalls.find(call=>call.request?.type==='learning_overview').request.today_start)).toBe(Date.parse('2026-11-02T05:00:00Z'));
  });
});
