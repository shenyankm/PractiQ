import { test, expect } from 'playwright/test';
import { capabilities, task, preview, taskId, runId } from '../../shared/cloud/test-fixtures';

test('App keeps offline practice available and submits cloud imports only through explicit native actions', async ({ page }, testInfo) => {
  const calls: {command:string; request:Record<string,unknown>}[] = [], errors: string[] = [], external: string[] = [];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.route('**/*',route=>{ if(new URL(route.request().url()).origin==='http://127.0.0.1:1422') return route.continue(); external.push(route.request().url()); return route.abort(); });
  await page.exposeFunction('__recordCloudCall',(call:{command:string;request:Record<string,unknown>})=>calls.push(call));
  await page.addInitScript(({capabilities,task,preview,taskId,runId})=>{
    const w=window as unknown as {isTauri:boolean; __recordCloudCall:(call:unknown)=>Promise<void>; __TAURI_INTERNALS__:unknown};
    w.isTauri=false; sessionStorage.setItem("practiq-preview", "off");
    let user: unknown=null, generation=1;
    w.__TAURI_INTERNALS__={invoke:async(command:string,args:{request:Record<string,unknown>})=>{
      const r=args.request; await w.__recordCloudCall({command,request:r});
      if(command==='cloud_request'){
        let value: unknown;
        if(r.type==='status') value={origin:'http://127.0.0.1:8090',generation};
        else if(r.type==='pick_sources') value=[{nativeTicket:'private-picker-ticket',name:'cloud-only.txt',size:4}];
        else if(r.type==='upload') value={fileName:'cloud-only.txt',sizeBytes:4,sourceType:'text',mediaType:'text/plain',sha256:'a'.repeat(64),objectKey:`practiq-agent/sources/${'a'.repeat(64)}/source.txt`};
        else if(r.type==='fetch'){
          let data: unknown={items:[],hasMore:false}; const path=String(r.path).split("?")[0], body=r.body as {email:string;requestId:string};
          if(path==='/api/auth/session') data={user,csrf:'',registrationEnabled:true};
          else if(path==='/api/auth/register'||path==='/api/auth/login') { user={id:'app-owner',name:'',email:body.email,role:'user',enabled:true}; generation++; data={user,csrf:'',registrationEnabled:true}; }
          else if(path==='/api/auth/logout') {user=null;generation++;data={ok:true};}
          else if(path==='/api/import-capabilities') data=capabilities;
          else if(path==='/api/import-settings') data={revision:taskId,settings:{tencentConcurrency:5,readRetryCount:2,retryBaseSeconds:1,deduplicateQuestions:false,generateAnswers:false}};
          else if(path==='/api/document-tasks'&&r.method==='POST') data={threadId:taskId,runId,requestId:body.requestId,accepted:true};
          else if(path===`/api/document-tasks/${taskId}`||path===`/api/document-tasks/${taskId}/head`) data=task;
          else if(path===`/api/document-tasks/${taskId}/preview`) data=preview;
          else if(path.startsWith('/api/me/usage')) data={limits:{freePages:50,modelCalls:1000,tencentCalls:50,activeTasks:2},remainingPages:50,usedPages:0,daily:[],calls:[]};
          value={status:200,mediaType:'application/json',bytes:btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(data))))};
        } else throw Error(`Unexpected cloud action ${r.type}`);
        return {value,generation};
      }
      if(command!=='request') throw Error(`Unexpected native command ${command}`);
      switch(r.type){
        case 'language': return 'zh-CN'; case 'banks': return [];
        case 'info': return {version:'Native IPC browser substitute',dataDirectory:'/mock'};
        case 'banks_page': case 'sessions_page': return {items:[],total:0,offset:0};
        case 'unfinished_session': return null;
        case 'backup_status': return {lastBackupAt:null,newAttempts:0,changedNotes:0,due:false};
        default: throw Error(`Unexpected local action ${r.type}`);
      }
    }};
  },{capabilities,task,preview,taskId,runId});
  await page.goto('/');
  const sidebar=page.locator('#app-sidebar');
  await expect(page.getByRole('heading',{name:'我的题库',exact:true})).toBeVisible();
  expect(calls.some(c=>c.command==='cloud_request')).toBe(false);
  await sidebar.getByRole('button',{name:'云端服务',exact:true}).click();
  await page.getByRole('button',{name:'注册账户',exact:true}).click();
  await page.getByLabel('登录邮箱',{exact:true}).fill('app-ui@example.test');
  await page.getByLabel('密码（至少 12 字符）',{exact:true}).fill('app-ui-test-password');
  await page.screenshot({path:testInfo.outputPath('cloud-register-light.png'),fullPage:true});
  await page.getByRole('button',{name:'注册并登录',exact:true}).click();
  await expect(page.getByText('app-ui@example.test',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'选择云端导入文件',exact:true}).click();
  await expect(page.getByText('cloud-only.txt',{exact:true})).toBeVisible();
  expect(calls.some(c=>c.request.type==='upload'||c.request.path==='/api/document-tasks'&&c.request.method==='POST')).toBe(false);
  await page.getByRole('button',{name:'开始导入',exact:true}).click();
  await expect.poll(()=>calls.filter(c=>c.request.path==='/api/document-tasks'&&c.request.method==='POST').length).toBe(1);
  expect(calls.filter(c=>c.request.type==='upload').map(c=>c.request)).toEqual([{type:'upload',ticket:'private-picker-ticket'}]);
  await expect(page.getByText('根据材料选择答案',{exact:true})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('cloud-results-light.png'),fullPage:true});
  await page.getByRole('button',{name:'用量',exact:true}).click();
  await expect(page.getByText(/免费识别额度：剩余 50 \/ 50 页/)).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('cloud-usage-light.png'),fullPage:true});
  await sidebar.getByRole('button',{name:'主题',exact:true}).click();
  await page.getByRole('menuitemradio',{name:'深色',exact:true}).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  expect(await sidebar.getByRole('button',{name:'我的题库',exact:true}).evaluate(node=>getComputedStyle(node).color)).toBe('rgb(248, 250, 252)');
  await page.screenshot({path:testInfo.outputPath('cloud-usage-dark.png'),fullPage:true});
  await page.getByRole('button',{name:'退出登录',exact:true}).click();
  await expect(page.getByRole('heading',{name:'登录 PractiQ',exact:true})).toBeVisible();
  await sidebar.getByRole('button',{name:'我的题库',exact:true}).click();
  await expect(page.getByRole('heading',{name:'我的题库',exact:true})).toBeVisible();
  expect(errors).toEqual([]); expect(external).toEqual([]);
});
