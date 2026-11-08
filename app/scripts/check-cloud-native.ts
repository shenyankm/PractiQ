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
    let user: unknown=null, generation=1, paid=false;
    let payment: {id:string;requestId:string;productId:string;state:string;environment:string;amount:string;subject:string;refunds:unknown[]} | null=null;
    const products=[{id:'free',name:'Free',amount:'0.00',pages:50,durationDays:null,activeTasks:1,priority:false},{id:'plus',name:'Plus',amount:'39.00',pages:100,durationDays:30,activeTasks:2,priority:false},{id:'pro',name:'Pro',amount:'99.00',pages:300,durationDays:30,activeTasks:3,priority:true},{id:'pages50',name:'50 页加量包',amount:'19.90',pages:50,durationDays:365,activeTasks:1,priority:false}];
    w.__TAURI_INTERNALS__={invoke:async(command:string,args:{request:Record<string,unknown>;context?:{origin:string;generation:number}})=>{
      const r=args.request; await w.__recordCloudCall({command,request:r});
      if(command==='cloud_request'){
        let value: unknown;
        if(r.type==='status') value={origin:'http://127.0.0.1:8090',generation};
        else if(r.type==='pick_sources') value=[{nativeTicket:'private-picker-ticket',name:'cloud-only.txt',size:4}];
        else if(r.type==='upload') value={fileName:'cloud-only.txt',sizeBytes:4,sourceType:'text',mediaType:'text/plain',sha256:'a'.repeat(64),objectKey:`practiq-agent/sources/${'a'.repeat(64)}/source.txt`};
        else if(r.type==='checkout') {payment={id:'f'.repeat(32),requestId:String(r.request_id),productId:String(r.product_id),state:'PENDING_PAYMENT',environment:'production',amount:'39.00',subject:'PractiQ Plus · 100 页 / 30 天',refunds:[]};value=null;}
        else if(r.type==='fetch'){
          let data: unknown={items:[],hasMore:false}; const path=String(r.path).split("?")[0], body=r.body as {email:string;requestId:string};
          if(path!=='/api/auth/session' && args.context?.generation!==generation) throw {code:'CLOUD_ACCOUNT_CHANGED'};
          if(path==='/api/auth/session') {if(!user) generation++;data={user,csrf:'',registrationEnabled:true};}
          else if(path==='/api/auth/register'||path==='/api/auth/login') { user={id:'app-owner',name:'',email:body.email,role:'user',enabled:true}; generation++; data={user,csrf:'',registrationEnabled:true}; }
          else if(path==='/api/auth/logout') {user=null;generation++;data={ok:true};}
          else if(path==='/api/import-capabilities') data=capabilities;
          else if(path==='/api/import-settings') data={revision:taskId,settings:{tencentConcurrency:5,readRetryCount:2,retryBaseSeconds:1,deduplicateQuestions:false,generateAnswers:false}};
          else if(path==='/api/document-tasks'&&r.method==='POST') data={threadId:taskId,runId,requestId:body.requestId,accepted:true};
          else if(path===`/api/document-tasks/${taskId}`||path===`/api/document-tasks/${taskId}/head`) data=task;
          else if(path===`/api/document-tasks/${taskId}/preview`) data=preview;
          else if(path==='/api/me/plans') data={products,checkoutEnabled:true,environment:'production',sandboxAmount:null,balance:{plan:paid?'plus':'free',expiresAt:paid?'2026-12-08T00:00:00Z':null,activeTasks:paid?2:1,freePages:50,freeUsedPages:0,freeRemainingPages:50,remainingPages:paid?150:50,grants:paid?[{orderId:'f'.repeat(32),productId:'plus',totalPages:100,usedPages:0,remainingPages:100,expiresAt:'2026-12-08T00:00:00Z',state:'active'}]:[]}};
          else if(path==='/api/me/payments') data=payment?[payment]:[];
          else if(path.endsWith('/query')&&r.method==='POST') {paid=true;if(payment)payment.state='PAID';data=payment;}
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
  await expect(sidebar.getByRole('button',{name:'个人中心',exact:true})).toHaveAttribute('aria-description','未登录');
  expect(calls.filter(c=>c.command==='cloud_request').every(c=>c.request.type==='status'||c.request.type==='fetch'&&c.request.method==='GET'&&c.request.path==='/api/auth/session')).toBe(true);
  await sidebar.getByRole('button',{name:'个人中心',exact:true}).click();
  await page.getByRole('button',{name:'注册账户',exact:true}).click();
  await page.getByLabel('登录邮箱',{exact:true}).fill('app-ui@example.test');
  await page.getByLabel('密码（至少 12 字符）',{exact:true}).fill('app-ui-test-password');
  await page.screenshot({path:testInfo.outputPath('cloud-register-light.png'),fullPage:true});
  await page.getByRole('button',{name:'注册并登录',exact:true}).click();
  await expect(page.getByRole('region',{name:'个人信息'}).getByText('app-ui@example.test',{exact:true})).toBeVisible();
  await expect(sidebar.getByRole('button',{name:'个人中心',exact:true})).toHaveAttribute('aria-description','app-ui@example.test');
  await page.getByRole('button',{name:'导入工作区',exact:true}).click();
  await page.getByRole('button',{name:'选择云端导入文件',exact:true}).click();
  await expect(page.getByText('cloud-only.txt',{exact:true})).toBeVisible();
  expect(calls.some(c=>c.request.type==='upload'||c.request.path==='/api/document-tasks'&&c.request.method==='POST')).toBe(false);
  await page.getByRole('button',{name:'开始导入',exact:true}).click();
  await expect.poll(()=>calls.filter(c=>c.request.path==='/api/document-tasks'&&c.request.method==='POST').length).toBe(1);
  expect(calls.filter(c=>c.request.type==='upload').map(c=>c.request)).toEqual([{type:'upload',ticket:'private-picker-ticket'}]);
  await expect(page.getByText('根据材料选择答案',{exact:true})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('cloud-results-light.png'),fullPage:true});
  await page.getByRole('button',{name:'用量',exact:true}).click();
  await expect(page.getByText(/可用识别额度：50 页/)).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('cloud-usage-light.png'),fullPage:true});
  await page.getByRole('button',{name:'套餐与额度',exact:true}).click();
  await expect(page.getByRole('heading',{name:'当前套餐 · Free',exact:true})).toBeVisible();
  await expect(page.locator('.plan-price').filter({hasText:'¥39'})).toBeVisible();
  await expect(page.locator('.plan-price').filter({hasText:'¥99'})).toBeVisible();
  expect(calls.some(c=>c.request.type==='checkout')).toBe(false);
  await expect(page.getByRole('button',{name:'刷新额度',exact:true})).toBeEnabled();
  await page.locator('.plan-options').scrollIntoViewIfNeeded();
  await page.mouse.move(1300,100);
  await page.screenshot({path:testInfo.outputPath('plans-free-light.png'),fullPage:true});
  await page.getByRole('button',{name:'购买 Plus',exact:true}).click();
  await expect.poll(()=>calls.filter(c=>c.request.type==='checkout').length).toBe(1);
  expect(calls.find(c=>c.request.type==='checkout')!.request.product_id).toBe('plus');
  await page.getByRole('button',{name:'查看订单并确认',exact:true}).click();
  await page.getByRole('button',{name:'查询支付结果',exact:true}).click();
  await expect(page.getByText(/正式收款 · 已付款/)).toBeVisible();
  await page.getByRole('button',{name:'套餐与额度',exact:true}).click();
  await expect(page.getByRole('heading',{name:'当前套餐 · Plus',exact:true})).toBeVisible();
  await expect(page.locator('.plan-balance dd').first()).toHaveText('150 页');
  await sidebar.getByRole('button',{name:'主题',exact:true}).click();
  await page.getByRole('menuitemradio',{name:'深色',exact:true}).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  expect(await sidebar.getByRole('button',{name:'我的题库',exact:true}).evaluate(node=>getComputedStyle(node).color)).toBe('rgb(248, 250, 252)');
  await expect(page.locator("html")).not.toHaveClass(/theme-transition/);
  await page.locator('.plan-options').scrollIntoViewIfNeeded();
  await page.mouse.move(1300,100);
  await page.screenshot({path:testInfo.outputPath('plans-plus-dark.png'),fullPage:true});
  expect(await page.locator('.plans-page').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await page.getByText('页数、到期和退款如何计算？',{exact:true}).click();
  await page.locator('.plan-rules').scrollIntoViewIfNeeded();
  await page.screenshot({path:testInfo.outputPath('plans-ledger-dark.png'),fullPage:true});
  await page.getByRole('button',{name:'退出登录',exact:true}).click();
  await expect(page.getByRole('heading',{name:'登录 PractiQ',exact:true})).toBeVisible();
  await expect(sidebar.getByRole('button',{name:'个人中心',exact:true})).toHaveAttribute('aria-description','未登录');
  await page.getByLabel('登录邮箱',{exact:true}).fill('app-ui@example.test');
  await page.getByLabel('密码',{exact:true}).fill('app-ui-test-password');
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('region',{name:'个人信息'}).getByText('app-ui@example.test',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'退出登录',exact:true}).click();
  await expect(page.getByRole('heading',{name:'登录 PractiQ',exact:true})).toBeVisible();
  await sidebar.getByRole('button',{name:'我的题库',exact:true}).click();
  await expect(page.getByRole('heading',{name:'我的题库',exact:true})).toBeVisible();
  await expect(sidebar.getByRole('button',{name:'个人中心',exact:true})).toHaveAttribute('aria-description','未登录');
  expect(errors).toEqual([]); expect(external).toEqual([]);
});
