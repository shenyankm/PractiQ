import { mockDesktop } from "./mock-desktop.mjs";
import { test, expect } from 'playwright/test';
import { capabilities, task, preview, taskId, runId } from '../../shared/cloud/test-fixtures';

test('personal App imports through explicit native actions while keeping offline practice independent', async ({ page }, testInfo) => {
  await page.emulateMedia({reducedMotion:'reduce',colorScheme:'dark'});
  await page.setViewportSize({width:1280,height:850});
  const calls: {command:string; request:Record<string,unknown>}[] = [], errors: string[] = [];
  page.on('pageerror',error=>errors.push(error.message));
  await page.exposeFunction('__recordCloudCall',(call:{command:string;request:Record<string,unknown>})=>calls.push(call));
  await mockDesktop(page); await page.addInitScript(({capabilities,task,preview,taskId,runId})=>{
    const w=window as unknown as {__recordCloudCall:(call:unknown)=>Promise<void>; __practiqNativeMock:unknown};
    sessionStorage.setItem('practiq-preview','normal');
    w.__practiqNativeMock={invoke:async(command:string,args:{request:Record<string,unknown>})=>{
      const r=args.request; await w.__recordCloudCall({command,request:r});
      if(command==='request') {
        switch(r.type) {
          case 'ai_settings': case 'save_ai_settings': return window.practiqAiFixture!(r);
          case 'pick_document_sources': return [{nativeTicket:'private-picker-ticket',name:'cloud-only.txt',size:4}];
          case 'upload_document_source': return {fileName:'cloud-only.txt',sizeBytes:4,sourceType:'text',mediaType:'text/plain',sha256:'a'.repeat(64),objectKey:`practiq-agent/sources/${'a'.repeat(64)}/source.txt`};
          case 'document_request': {
            const action=r.request as Record<string,unknown>; let value:unknown;
            switch(action.type) {
              case 'capabilities': value=capabilities; break;
              case 'create': value={threadId:taskId,runId,requestId:(action.value as {requestId:string}).requestId,accepted:true}; break;
              case 'preview': value=preview; break;
              case 'detail': case 'head': value=task; break;
              case 'import_bank': value={bankId:taskId,count:3}; break;
              default: return window.practiqAiFixture!(r);
            }
            return {type:action.type,value};
          }
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
      throw Error('Unexpected command');
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
  await expect(page.getByLabel('AI 服务地址',{exact:true})).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'AI 模型与识别',exact:true})).toBeVisible();
  await page.getByLabel('模型 ID',{exact:true}).fill('unsaved-model');
  await sidebar.getByRole('button',{name:'文档导入',exact:true}).click();
  await expect(page.getByRole('heading',{name:'设置',exact:true})).toBeVisible();
  await expect(page.getByRole('alert').filter({hasText:'请先保存 AI 设置或取消修改。'})).toBeVisible();
  expect(calls.some(c=>c.request.type==='save_ai_settings')).toBe(false);
  await page.getByRole('button',{name:'取消',exact:true}).click();
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
  expect(calls.some(c=>c.request.type==='document_request'&&(c.request.request as {type:string}).type==='save_import_settings')).toBe(true);
  await page.getByRole('button',{name:'选择文档',exact:true}).click();
  await expect(page.getByText('cloud-only.txt',{exact:true})).toBeVisible();
  expect(calls.some(c=>c.request.type==='upload_document_source'||c.request.type==='document_request'&&(c.request.request as {type:string}).type==='create')).toBe(false);
  await page.getByRole('button',{name:'开始导入',exact:true}).click();
  await expect(page.getByRole('heading',{name:'sample.docx',exact:true})).toBeVisible();
  expect(calls.filter(c=>c.request.type==='upload_document_source')).toHaveLength(1);
  const submitted=calls.filter(c=>c.request.type==='document_request'&&(c.request.request as {type:string}).type==='create');
  expect(submitted).toHaveLength(1);
  expect((submitted[0].request.request as {value:unknown}).value).toMatchObject({generateAnswers:true});
  expect(calls.some(c=>['settings','save_settings','test_settings'].includes(String(c.request.type)))).toBe(false);
  expect(calls.some(c=>String(c.request.path).startsWith('/api/auth/')||String(c.request.path).startsWith('/api/me/'))).toBe(false);
  await page.getByRole('button',{name:'导入题库',exact:true}).click();
  await expect(page.getByText('题库已导入，可前往“我的题库”开始练习。',{exact:true})).toBeVisible();
  expect(calls.filter(c=>c.request.type==='document_request'&&(c.request.request as {type:string}).type==='import_bank')).toHaveLength(1);
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
