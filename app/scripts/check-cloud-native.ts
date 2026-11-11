import { test, expect } from 'playwright/test';
import { capabilities, task, preview, taskId, runId } from '../../shared/cloud/test-fixtures';

test('personal App imports through explicit native actions while keeping offline practice independent', async ({ page }, testInfo) => {
  await page.emulateMedia({reducedMotion:'reduce',colorScheme:'dark'});
  await page.setViewportSize({width:1280,height:850});
  const calls: {command:string; request:Record<string,unknown>}[] = [], errors: string[] = [];
  page.on('pageerror',error=>errors.push(error.message));
  await page.exposeFunction('__recordCloudCall',(call:{command:string;request:Record<string,unknown>})=>calls.push(call));
  await page.addInitScript(({capabilities,task,preview,taskId,runId})=>{
    const w=window as unknown as {isTauri:boolean; __recordCloudCall:(call:unknown)=>Promise<void>; __TAURI_INTERNALS__:unknown};
    w.isTauri=false; sessionStorage.setItem('practiq-preview','normal');
    let generation=1, origin='http://127.0.0.1:8090';
    let settings={revision:taskId,settings:{tencentConcurrency:5,readRetryCount:2,retryBaseSeconds:1,deduplicateQuestions:false,generateAnswers:false}};
    w.__TAURI_INTERNALS__={invoke:async(command:string,args:{request:Record<string,unknown>;context?:{origin:string;generation:number}})=>{
      const r=args.request; await w.__recordCloudCall({command,request:r});
      if(command==='request') {
        switch(r.type) {
          case 'language': return 'zh-CN';
          case 'info': return {version:'Native IPC substitute',dataDirectory:'isolated'};
          case 'banks': return [];
          case 'banks_page': return {items:[],total:0,offset:0};
          case 'unfinished_session': return null;
          case 'learning_overview': return {days:r.days,since:r.since,through:Date.now(),counts:{submitted:0,skipped:0,ungraded:0,auto:{graded:0,correct:0},selfAssessed:{graded:0,correct:0},ai:{graded:0,correct:0},manual:{graded:0,correct:0}},banks:[],kinds:[],review:[],backup:{lastBackupAt:null,newAttempts:0,changedNotes:0,due:false}};
          case 'backup_status': return {lastBackupAt:null,newAttempts:0,changedNotes:0,due:false};
          default: throw Error(`Unexpected local action ${r.type}`);
        }
      }
      if(command!=='cloud_request') throw Error('Unexpected command');
      let value: unknown;
      if(r.type==='status') value={origin,generation};
      else if(r.type==='configure') {origin=String(r.origin);generation++;value={origin,generation};}
      else {
        if(args.context?.origin!==origin || args.context?.generation!==generation) throw {code:'CLOUD_SERVICE_CHANGED'};
        if(r.type==='pick_sources') value=[{nativeTicket:'private-picker-ticket',name:'cloud-only.txt',size:4}];
        else if(r.type==='upload') value={fileName:'cloud-only.txt',sizeBytes:4,sourceType:'text',mediaType:'text/plain',sha256:'a'.repeat(64),objectKey:`practiq-agent/sources/${'a'.repeat(64)}/source.txt`};
        else if(r.type==='fetch') {
          const path=String(r.path).split('?')[0], body=r.body as {requestId:string};
          let data: unknown={items:[],hasMore:false};
          if(path==='/api/import-capabilities') data=capabilities;
          else if(path==='/api/import-settings') { if(r.method==='PUT') settings={...r.body as typeof settings,revision:crypto.randomUUID()}; data=settings; }
          else if(path==='/api/document-tasks'&&r.method==='POST') data={threadId:taskId,runId,requestId:body.requestId,accepted:true};
          else if(path.endsWith('/preview')) data=preview;
          else if(path.startsWith(`/api/document-tasks/${taskId}`)) data=task;
          value={status:200,mediaType:'application/json',bytes:btoa(unescape(encodeURIComponent(JSON.stringify(data))))};
        } else if(r.type==='import_bank') value={bankId:taskId,count:3};
        else if(r.type==='download') throw Error('Document results must not use ZIP downloads');
        else throw Error('Unexpected personal import command');
      }
      return {value,generation};
    }};
  },{capabilities,task,preview,taskId,runId});
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'我的题库',exact:true})).toBeVisible();
  const sidebar=page.locator('#app-sidebar');
  await expect(sidebar.getByRole('button',{name:'个人中心',exact:true})).toHaveCount(0);
  expect(calls.filter(c=>c.command==='cloud_request')).toHaveLength(0);
  const empty=page.locator('[data-slot="empty"]');
  await expect(empty.getByRole('button',{name:'导入文档',exact:true})).toBeVisible();
  const primary=await empty.getByRole('button',{name:'导入文档',exact:true}).boundingBox();
  expect(primary!.width).toBeGreaterThan(80);
  await expect(empty.getByRole('button',{name:'导入题库 ZIP',exact:true})).toHaveCount(0);
  await page.screenshot({path:testInfo.outputPath('app-empty-banks.png')});
  await sidebar.getByRole('button',{name:'文档导入',exact:true}).click();
  await expect(page.getByText(/^服务支持：/)).toBeVisible();
  await expect(page.getByLabel('登录邮箱')).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'连接云端服务',exact:true})).toHaveCount(0);
  await expect(page.getByText('读取语言设置失败',{exact:true})).toHaveCount(0);
  await expect(page.getByText('题库概览读取失败',{exact:true})).toHaveCount(0);
  await page.screenshot({path:testInfo.outputPath('app-import-workspace.png'),fullPage:true});
  await expect(page.getByRole('link',{name:'设置',exact:true})).toHaveCount(0);
  await sidebar.getByRole('button',{name:'设置',exact:true}).click();
  await expect(page.getByLabel('AI 服务地址',{exact:true})).toHaveValue('http://127.0.0.1:8090');
  await page.screenshot({path:testInfo.outputPath('app-import-settings.png'),fullPage:true});
  const gap=await page.getByRole('heading',{name:'学习数据备份',exact:true}).evaluate(element=>{
    const backup=element.closest('[data-slot="card"]')!;
    const recognition=document.getElementById('execution-settings-heading')!.closest('section')!;
    return backup.getBoundingClientRect().top-recognition.getBoundingClientRect().bottom;
  });
  expect(gap).toBeGreaterThanOrEqual(24);
  await page.getByRole('switch',{name:'AI 生成答案与解析',exact:true}).click();
  await sidebar.getByRole('button',{name:'文档导入',exact:true}).click();
  await expect(page.getByText(/^服务支持：/)).toBeVisible();
  expect(calls.some(c=>c.request.path==='/api/import-settings'&&c.request.method==='PUT')).toBe(true);
  await page.getByRole('button',{name:'选择文档',exact:true}).click();
  await expect(page.getByText('cloud-only.txt',{exact:true})).toBeVisible();
  expect(calls.some(c=>c.request.type==='upload'||c.request.method==='POST')).toBe(false);
  await page.getByRole('button',{name:'开始导入',exact:true}).click();
  await expect(page.getByRole('heading',{name:'sample.docx',exact:true})).toBeVisible();
  expect(calls.filter(c=>c.request.type==='upload')).toHaveLength(1);
  const submitted=calls.filter(c=>c.request.method==='POST'&&c.request.path==='/api/document-tasks');
  expect(submitted).toHaveLength(1);
  expect(submitted[0].request.body).toMatchObject({generateAnswers:true});
  expect(calls.some(c=>['settings','save_settings','test_settings'].includes(String(c.request.type)))).toBe(false);
  expect(calls.some(c=>String(c.request.path).startsWith('/api/auth/')||String(c.request.path).startsWith('/api/me/'))).toBe(false);
  await page.getByRole('button',{name:'导入题库',exact:true}).click();
  await expect(page.getByText('题库已导入，可前往“我的题库”开始练习。',{exact:true})).toBeVisible();
  expect(calls.filter(c=>c.request.type==='import_bank')).toHaveLength(1);
  expect(calls.some(c=>c.request.type==='download'||String(c.request.path).includes('/export?'))).toBe(false);
  await page.screenshot({path:testInfo.outputPath('personal-native-import.png'),fullPage:true});
  await sidebar.getByRole('button',{name:'我的题库',exact:true}).click();
  await expect(page.getByRole('heading',{name:'我的题库',exact:true})).toBeVisible();
  await sidebar.getByRole('button',{name:'学习概览',exact:true}).click();
  const emptyReview=page.getByText('暂无待复习题目。',{exact:true});
  await expect(emptyReview).toBeVisible();
  await expect(page.getByRole('button',{name:'开始复习 0 题',exact:true})).toHaveCount(0);
  const row=await emptyReview.locator('..').boundingBox();
  expect(row!.height).toBeLessThanOrEqual(64);
  const heading=await page.getByRole('heading',{name:'今日复习',exact:true}).boundingBox();
  const filter=await page.getByLabel('按错因筛选',{exact:true}).boundingBox();
  expect(Math.abs(heading!.y+heading!.height/2-filter!.y-filter!.height/2)).toBeLessThan(2);
  await page.screenshot({path:testInfo.outputPath('app-compact-learning.png')});
  expect(errors).toEqual([]);
});
