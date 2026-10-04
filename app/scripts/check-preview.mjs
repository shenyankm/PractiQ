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

base('study setup retries failed statistics and manual pages without resetting settings',async ({page})=>{
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{
  sessionStorage.setItem('practiq-preview','local');
  window.isTauri=false;
  const questions=Array.from({length:31},(_,i)=>({id:`q${i}`,bankId:'one',bankTitle:'Retry bank',question:{id:`q${i}`,parentId:null,stem:`Retry question ${i}`,answerMode:'short_answer',questionTypeId:'简答题',options:[],items:[],answerPayload:{text:'Reference'},analysis:null,sourceText:null,contentBlocks:[],needsReview:false,missingFields:[],confidence:1},groups:[],visuals:[],sources:[],warnings:[],missingAssets:false,favorite:false,latestResult:null}));
  const bank={id:'one',title:'Retry bank',description:'',count:31,createdAt:1};
  const statistics={count:31,types:{short_answer:31},feasibleCounts:Array.from({length:31},(_,i)=>i+1)};
  window.__studyRequests=[];
  window.__studyStatsFail=true;
  window.__studyPageFail=true;
  window.__TAURI_INTERNALS__={invoke:async(command,{request})=>{
   if(command!=='request')throw Error(`Unexpected command ${command}`);
   switch(request.type){
    case 'language':return 'zh-CN';
    case 'banks':return [bank];
    case 'banks_page':return {items:[bank],total:1,offset:0};
    case 'unfinished_session':return null;
    case 'info':return {version:'retry-test',dataDirectory:'/mock'};
    case 'question_stats':
     window.__studyRequests.push(request);
     if(window.__studyStatsFail)throw Error('Statistics unavailable');
     return new Promise(resolve=>{window.__resolveStudyStats=()=>resolve(statistics);});
    case 'questions_page':{
     window.__studyRequests.push(request);
     const result={items:questions.slice(request.offset,request.offset+request.limit),total:31,offset:request.offset};
     if(request.offset===30){
      if(window.__studyPageFail)throw Error('Question page unavailable');
      return new Promise(resolve=>{window.__resolveStudyPage=()=>resolve(result);});
     }
     return result;
    }
    default:throw Error(`Unexpected request ${request.type}`);
   }
  }};
 });
 await page.goto('/');
 await page.getByRole('button',{name:'开始练习',exact:true}).click();
 const dialog=page.getByRole('dialog');
 await expect(dialog.getByRole('alert')).toContainText('Statistics unavailable');
 await dialog.getByRole('combobox',{name:/^模式/}).selectOption('mock_exam');
 await dialog.getByLabel('考试分钟数',{exact:true}).fill('45');
 await dialog.getByLabel('题目数量',{exact:true}).fill('10');
 await dialog.getByLabel('考试总分',{exact:true}).fill('90');
 await dialog.getByText('高级设置 · 题库、筛选与选题方式',{exact:true}).click();
 await dialog.getByRole('combobox',{name:/^选题方式/}).selectOption('quota');
 await dialog.getByLabel('简答题数',{exact:true}).fill('3');
 await page.evaluate(()=>{window.__studyStatsFail=false;});
 const statsRetry=dialog.getByRole('button',{name:'重试题目统计',exact:true});
 await statsRetry.click();
 await expect(statsRetry).toBeDisabled();
 await statsRetry.evaluate(button=>button.click());
 await expect.poll(()=>page.evaluate(()=>window.__studyRequests.filter(r=>r.type==='question_stats').length)).toBe(2);
 await page.evaluate(()=>window.__resolveStudyStats());
 await expect(statsRetry).toHaveCount(0);
 await expect(dialog.getByRole('alert')).toHaveCount(0);
 await expect(dialog.getByLabel('简答题数',{exact:true})).toHaveValue('3');
 await dialog.getByRole('combobox',{name:/^选题方式/}).selectOption('manual');
 await dialog.getByRole('checkbox',{name:'Retry question 0',exact:true}).check();
 await dialog.getByRole('button',{name:'下一页',exact:true}).click();
 await expect(dialog.getByRole('alert')).toContainText('Question page unavailable');
 await page.evaluate(()=>{window.__studyPageFail=false;});
 const pageRetry=dialog.getByRole('button',{name:'重试选题列表',exact:true});
 await pageRetry.click();
 await expect(pageRetry).toBeDisabled();
 await pageRetry.evaluate(button=>button.click());
 await expect.poll(()=>page.evaluate(()=>window.__studyRequests.filter(r=>r.type==='questions_page').length)).toBe(3);
 await page.evaluate(()=>window.__resolveStudyPage());
 await expect(pageRetry).toHaveCount(0);
 await expect(dialog.getByRole('alert')).toHaveCount(0);
 await dialog.getByRole('checkbox',{name:'Retry question 30',exact:true}).check();
 await dialog.getByRole('button',{name:'上一页',exact:true}).focus();
 await page.keyboard.press('Enter');
 await expect(dialog.getByRole('checkbox',{name:'Retry question 0',exact:true})).toBeChecked();
 await expect(dialog.getByRole('status')).toContainText('本次 2 题');
 await expect(dialog.getByLabel('考试分钟数',{exact:true})).toHaveValue('45');
 await expect(dialog.getByLabel('考试总分',{exact:true})).toHaveValue('90');
 await expect(dialog.getByRole('checkbox',{name:'Retry bank（31）',exact:true})).toBeChecked();
 await dialog.getByRole('combobox',{name:/^选题方式/}).selectOption('quota');
 await expect(dialog.getByLabel('简答题数',{exact:true})).toHaveValue('3');
 await dialog.getByRole('combobox',{name:/^选题方式/}).selectOption('count');
 await expect(dialog.getByLabel('题目数量',{exact:true})).toHaveValue('10');
 const requests=await page.evaluate(()=>window.__studyRequests);
 const statsRequests=requests.filter(r=>r.type==='question_stats');
 const pageRequests=requests.filter(r=>r.type==='questions_page');
 expect(statsRequests).toHaveLength(2);
 expect(statsRequests[1]).toEqual(statsRequests[0]);
 expect(pageRequests[2]).toEqual(pageRequests[1]);
 expect(errors).toEqual([]);
});

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
