import { test as base, expect } from 'playwright/test';
import { writeFile } from 'node:fs/promises';

const test=base.extend({page:async ({page},use)=>{
 const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.__previewNativeCalls=0;window.__TAURI_INTERNALS__={invoke:()=>{window.__previewNativeCalls++;throw new Error('Unexpected native IPC in preview');}};});
 await use(page);
 expect(errors).toEqual([]);
 expect(await page.evaluate(()=>window.__previewNativeCalls)).toBe(0);
}});

test('development preview pages stay offline',async ({page},testInfo)=>{
 await page.goto('/');
 await expect(page.getByText('基础知识 · 全题型',{exact:true}).first()).toBeVisible();
 await page.getByRole('button',{name:'查看题目',exact:true}).first().click();
 await expect(page.getByText('下面哪一个是质数？',{exact:true}).first()).toBeVisible();
 await page.getByRole('button',{name:'我的题库',exact:true}).click();
 await page.getByRole('button',{name:'开始练习',exact:true}).first().click();
 await page.getByRole('button',{name:'立即开始',exact:true}).click();
 await expect(page.getByText('下面哪一个是质数？',{exact:true}).first()).toBeVisible();
 for(const name of ['错题本','收藏夹','练习记录','导入题库','设置']) {
  await page.getByRole('button',{name,exact:true}).first().click();
  await expect(page.getByRole('heading',{name,exact:true})).toBeVisible();
 }
 await page.getByRole('button',{name:'练习记录',exact:true}).click();
 await page.getByRole('button',{name:'继续练习',exact:true}).first().click();
 await expect(page.getByText('下面哪一个是质数？',{exact:true}).first()).toBeVisible();
 await page.getByRole('button',{name:'导入题库',exact:true}).click();
 await page.getByRole('tab',{name:'导入记录',exact:true}).click();
 await page.getByRole('button',{name:'线性代数 · 矩阵',exact:true}).click();
 await page.getByRole('button',{name:'查看内容与审核',exact:true}).click();
 await expect(page.getByText(/可查看 9 道题目/)).toBeVisible();
 await page.screenshot({path:testInfo.outputPath('preview.png'),fullPage:true});
});

for (const kind of ['bank','question']) {
 test(`${kind} editor protects drafts from implicit dismissal`,async ({page})=>{
  await page.goto('/');
  await expect(page.getByText('基础知识 · 全题型',{exact:true}).first()).toBeVisible();
  const bankTitle='基础知识 · 全题型';
  if(kind==='question')await page.getByRole('button',{name:'查看题目',exact:true}).first().click();
  const title=kind==='bank'?'编辑题库':'编辑题目';
  const fieldName=kind==='bank'?'题库名称':'题干（支持 Markdown 和公式）';
  const open=async()=>{
   if(kind==='bank'){
    await page.getByRole('button',{name:`题库操作 ${bankTitle}`,exact:true}).click();
    await page.getByRole('menuitem',{name:title,exact:true}).click();
   }else await page.getByRole('button',{name:title,exact:true}).first().click();
   await expect(page.getByRole('dialog',{name:title,exact:true})).toBeVisible();
  };
  const dismiss=async action=>{
   if(action==='Escape')await page.keyboard.press('Escape');
   else if(action==='close')await page.getByRole('dialog',{name:title,exact:true}).getByRole('button',{name:'关闭',exact:true}).click();
   else await page.mouse.click(8,8);
  };
  const actions=['Escape','close','outside'];
  for(const action of actions){
   await open();
   await dismiss(action);
   await expect(page.getByRole('dialog',{name:title,exact:true})).toBeHidden();
   await expect(page.getByRole('alertdialog')).toHaveCount(0);
  }
  await open();
  const editor=page.getByRole('dialog',{name:title,exact:true});
  const field=editor.getByRole('textbox',{name:fieldName,exact:true});
  const original=await field.inputValue();
  await field.fill(`${original} draft`);
  for(const action of actions){
   await field.focus();
   await dismiss(action);
   const confirmation=page.getByRole('alertdialog',{name:'放弃未保存的更改？',exact:true});
   await expect(confirmation).toBeVisible();
   const resume=confirmation.getByRole('button',{name:'继续编辑',exact:true});
   await expect(resume).toBeFocused();
   await resume.click();
   await expect(confirmation).toBeHidden();
   await expect(field).toHaveValue(`${original} draft`);
   await expect(action==='close'?editor.getByRole('button',{name:'关闭',exact:true}):field).toBeFocused();
  }
  await editor.getByRole('button',{name:'放弃更改',exact:true}).click();
  await expect(editor).toBeHidden();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await open();
  await expect(field).toHaveValue(original);
  await field.fill(`${original} saved`);
  await editor.getByRole('button',{name:kind==='bank'?'保存题库':'保存题目',exact:true}).click();
  await expect(editor).toBeHidden();
  if(kind==='bank'){
   await page.getByRole('button',{name:`题库操作 ${original} saved`,exact:true}).click();
   await page.getByRole('menuitem',{name:title,exact:true}).click();
  }else{
   const row=page.getByRole('button',{name:new RegExp(`${original} saved`)}).locator('..');
   await row.getByRole('button',{name:title,exact:true}).click();
  }
  await expect(field).toHaveValue(`${original} saved`);
  await page.keyboard.press('Escape');
  await expect(editor).toBeHidden();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
 });
}

test('new question reverted nullable fields close without discarding other edits',async ({page})=>{
 await page.goto('/');
 await page.getByRole('button',{name:'查看题目',exact:true}).first().click();
 const editor=page.getByRole('dialog',{name:'编辑题目',exact:true});
 const instructions=editor.getByRole('textbox',{name:'作答说明',exact:true});
 const open=()=>page.getByRole('button',{name:'新增题目',exact:true}).click();
 for(const action of ['Escape','close','outside']){
  await open();
  await instructions.fill('Temporary instructions');
  await instructions.fill('');
  if(action==='Escape')await page.keyboard.press('Escape');
  else if(action==='close')await editor.getByRole('button',{name:'关闭',exact:true}).click();
  else await page.mouse.click(8,8);
  await expect(editor).toBeHidden();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
 }
 await open();
 await instructions.fill('Temporary instructions');
 await instructions.fill('');
 const stem=editor.getByRole('textbox',{name:'题干（支持 Markdown 和公式）',exact:true});
 await stem.fill('Actual changed stem');
 await page.keyboard.press('Escape');
 const confirmation=page.getByRole('alertdialog',{name:'放弃未保存的更改？',exact:true});
 await expect(confirmation).toBeVisible();
 await confirmation.getByRole('button',{name:'继续编辑',exact:true}).click();
 await expect(stem).toHaveValue('Actual changed stem');
 await expect(stem).toBeFocused();
 await editor.getByRole('button',{name:'放弃更改',exact:true}).click();
 await expect(editor).toBeHidden();
});

test('child editors retain changed drafts and stage changes until the parent saves',async ({page})=>{
 await page.goto('/');
 const bank=page.locator('[data-slot=card]').filter({has:page.getByText('阅读与组合题',{exact:true})});
 await bank.getByRole('button',{name:'查看题目',exact:true}).click();
 const openRoot=()=>page.getByRole('button',{name:/words-root$/}).locator('..').getByRole('button',{name:'编辑题目',exact:true}).click();
 const editor=page.getByRole('dialog',{name:'编辑题目',exact:true});
 const field=editor.getByRole('textbox',{name:'题干（支持 Markdown 和公式）',exact:true});
 await openRoot();
 await editor.getByText('1. words-root1',{exact:true}).locator('..').getByRole('button',{name:'编辑题目',exact:true}).click();
 await expect(field).toHaveValue('words-root1');
 await field.fill('Changed child draft');
 for(const action of ['Escape','close','outside']){
  if(action==='Escape')await page.keyboard.press('Escape');
  else if(action==='close')await editor.getByRole('button',{name:'关闭',exact:true}).click();
  else await page.mouse.click(8,8);
  const confirmation=page.getByRole('alertdialog',{name:'放弃未保存的更改？',exact:true});
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button',{name:'继续编辑',exact:true}).click();
  await expect(field).toHaveValue('Changed child draft');
 }
 await editor.getByRole('button',{name:'放弃更改',exact:true}).click();
 await expect(field).toHaveValue('words-root');
 await expect(editor.getByText('1. words-root1',{exact:true})).toBeVisible();
 await page.keyboard.press('Escape');
 await expect(editor).toBeHidden();
 await expect(page.getByRole('alertdialog')).toHaveCount(0);
 await openRoot();
 await editor.getByText('1. words-root1',{exact:true}).locator('..').getByRole('button',{name:'编辑题目',exact:true}).click();
 await field.fill('Saved child draft');
 await editor.getByRole('button',{name:'保存题目',exact:true}).click();
 await expect(editor.getByText('1. Saved child draft',{exact:true})).toBeVisible();
 await page.keyboard.press('Escape');
 const confirmation=page.getByRole('alertdialog',{name:'放弃未保存的更改？',exact:true});
 await expect(confirmation).toBeVisible();
 await confirmation.getByRole('button',{name:'继续编辑',exact:true}).click();
 await editor.getByRole('button',{name:'保存题目',exact:true}).click();
 await expect(editor).toBeHidden();
 await openRoot();
 await expect(editor.getByText('1. Saved child draft',{exact:true})).toBeVisible();
 await expect(editor.getByText('2. words-root2',{exact:true})).toBeVisible();
 await page.keyboard.press('Escape');
 await expect(editor).toBeHidden();
 await expect(page.getByRole('alertdialog')).toHaveCount(0);
});

for(const scenario of ['empty','many','unconfigured','missing','slow','error']) {
 test(`preview scenario ${scenario} stays offline`,async ({page})=>{
  await page.addInitScript(value=>sessionStorage.setItem('practiq-preview',value),scenario);
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'我的题库',exact:true})).toBeVisible();
  if(scenario==='empty') await expect(page.getByText('从第一份题库开始',{exact:true})).toBeVisible();
  else if(scenario==='error') await expect(page.getByRole('alert').filter({hasText:'演示请求失败'}).first()).toBeVisible();
  else await expect(page.getByText('基础知识 · 全题型',{exact:true}).first()).toBeVisible();
  if(scenario==='many') {
   const pagination=page.getByRole('navigation',{name:'题库分页'});
   await expect(pagination.getByRole('button',{name:'下一页',exact:true})).toBeEnabled();
   // The dev-only preview switcher overlays the footer; exercise keyboard paging.
   await pagination.getByRole('button',{name:'下一页',exact:true}).focus();
   await page.keyboard.press('Enter');
   await expect(page.getByText('综合复习 · 第 40 单元',{exact:true})).toBeVisible();
   await expect(pagination.getByRole('button',{name:'下一页',exact:true})).toBeDisabled();
   await expect(pagination.getByRole('button',{name:'上一页',exact:true})).toBeEnabled();
  }
  if(scenario==='missing') {
   await page.getByRole('button',{name:'查看题目',exact:true}).first().click();
   await page.getByRole('button',{name:/观察 PractiQ 图标，描述你的印象/}).click();
   await page.locator('figure').first().scrollIntoViewIfNeeded();
   await expect(page.getByText('图片不可用，可依据下方文字作答或跳过。',{exact:true}).first()).toBeVisible();
   await page.keyboard.press('Escape');
   await expect(page.getByRole('dialog')).toBeHidden();
  }
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await expect(page.getByRole('heading',{name:'设置',exact:true})).toBeVisible();
  if(scenario==='error') await expect(page.getByRole('alert').filter({hasText:'演示请求失败'}).first()).toBeVisible();
  else await expect(page.getByRole('status').filter({hasText:scenario==='unconfigured'?'未配置':'已配置'})).toBeVisible();
 });
}

for (const width of [960,1280]) {
 base(`performance: 1000-question answer card stays reachable at ${width}px`,async ({page},testInfo)=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.setViewportSize({width,height:640});
  await page.addInitScript(()=>{
   sessionStorage.setItem('practiq-preview','local');
   window.isTauri=false;
   const questions=Array.from({length:1000},(_,i)=>({id:`q${i}`,bankId:'one',bankTitle:'Large bank',question:{id:`q${i}`,parentId:null,stem:`Question ${i+1}`,answerMode:'short_answer',questionTypeId:'简答题',options:[],items:[],answerPayload:{text:'Reference'},analysis:null,sourceText:null,contentBlocks:[],needsReview:false,missingFields:[],confidence:1},groups:[],visuals:[],sources:[],warnings:[],missingAssets:false,favorite:false,latestResult:null}));
   const bank={id:'one',title:'Large bank',description:'',count:1000,createdAt:1};
   const session={id:'large',title:'Large practice',kind:'practice',createdAt:1,finishedAt:null,position:0,mode:'ordered',attempts:questions.map((snapshot,ordinal)=>({ordinal,snapshot,answer:null,autoResult:null,result:null,gradeKind:'ungraded',submittedAt:null,skipped:false,elapsedMs:0}))};
   window.__TAURI_INTERNALS__={invoke:async(command,{request})=>{
    if(command!=='request')throw Error(`Unexpected command ${command}`);
    switch(request.type){
     case 'language':return 'zh-CN';
     case 'banks':return [bank];
     case 'banks_page':return {items:[bank],total:1,offset:0};
     case 'unfinished_session':return null;
     case 'info':return {version:'scale',dataDirectory:'/mock'};
     case 'question_stats':return {count:1000,types:{short_answer:1000},feasibleCounts:[20,1000]};
     case 'preview_paper':return {questionIds:questions.map(q=>q.id),digest:'large',questions,scores:questions.map(()=>0),count:1000};
     case 'start_paper':case 'session':return structuredClone(session);
     case 'position':session.position=request.position;return structuredClone(session);
     case 'save_draft':session.attempts[request.ordinal].answer=request.answer;return null;
     default:throw Error(`Unexpected request ${request.type}`);
    }
   }};
  });
  await page.goto('/');
  await page.getByRole('button',{name:'开始练习',exact:true}).click();
  await page.getByLabel('题目数量').fill('1000');
  await page.getByRole('button',{name:'立即开始',exact:true}).click();
  const grid=page.getByRole('region',{name:'答题卡',exact:true});
  await expect(grid.getByRole('button')).toHaveCount(1000);
  await grid.getByRole('button',{name:'转到第 501 题，未作答',exact:true}).evaluate(button=>{window.__retainedAnswerButton=button;});
  await page.getByRole('button',{name:'转到最后一题',exact:true}).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading',{name:'第 1,000 / 1,000 题',exact:true})).toBeFocused();
  expect(await grid.getByRole('button',{name:'转到第 501 题，未作答',exact:true}).evaluate(button=>button===window.__retainedAnswerButton)).toBe(true);
  await page.getByRole('button',{name:'定位当前题',exact:true}).focus();
  await page.keyboard.press('Enter');
  await expect(grid.getByRole('button',{name:'转到第 1,000 题，未作答',exact:true})).toBeFocused();
  await page.getByLabel('作答内容').fill('Answer');
  const submit=page.getByRole('button',{name:'提交答案',exact:true});
  await expect(submit).toBeEnabled();
  const gridBox=await grid.boundingBox(), submitBox=await submit.boundingBox();
  expect(gridBox.height).toBeLessThanOrEqual(640*0.45+1);
  expect(submitBox.y).toBeGreaterThanOrEqual(0);
  expect(submitBox.y+submitBox.height).toBeLessThanOrEqual(640);
  await page.getByRole('button',{name:'转到第一题',exact:true}).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading',{name:'第 1 / 1,000 题',exact:true})).toBeFocused();
  const finish=page.getByRole('button',{name:'结束练习',exact:true});
  await finish.scrollIntoViewIfNeeded();
  const finishBox=await finish.boundingBox();
  expect(finishBox.y).toBeGreaterThanOrEqual(0);
  expect(finishBox.y+finishBox.height).toBeLessThanOrEqual(640);
  await finish.focus();
  await page.keyboard.press('Enter');
  const confirmation=page.getByRole('alertdialog',{name:'结束本次练习？',exact:true});
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button',{name:'继续作答',exact:true}).click();
  await expect(confirmation).toBeHidden();
  await expect(finish).toBeFocused();
  const measurements=testInfo.outputPath('answer-card-scale.json');
  await writeFile(measurements,JSON.stringify({width,height:640,buttons:1000,gridHeight:gridBox.height,submitBottom:submitBox.y+submitBox.height,finishBottom:finishBox.y+finishBox.height,finishConfirmationReachable:true,retainedButton:true}));
  await testInfo.attach('answer-card-scale.json',{path:measurements,contentType:'application/json'});
  await page.screenshot({path:testInfo.outputPath('answer-card-scale.png')});
  expect(errors).toEqual([]);
 });
}
