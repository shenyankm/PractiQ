import { test, expect } from 'playwright/test';
import { capabilities, task, preview, taskId, runId } from '../../shared/cloud/test-fixtures';

test('App keeps offline practice available and submits cloud imports only through explicit native actions', async ({ page }, testInfo) => {
  await page.emulateMedia({reducedMotion:'reduce'});
  const calls: {command:string; request:Record<string,unknown>}[] = [], errors: string[] = [], external: string[] = [];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.route('**/*',route=>{ if(new URL(route.request().url()).origin==='http://127.0.0.1:1422') return route.continue(); external.push(route.request().url()); return route.abort(); });
  await page.exposeFunction('__recordCloudCall',(call:{command:string;request:Record<string,unknown>})=>calls.push(call));
  await page.addInitScript(({capabilities,task,preview,taskId,runId})=>{
    const w=window as unknown as {isTauri:boolean; __recordCloudCall:(call:unknown)=>Promise<void>; __TAURI_INTERNALS__:unknown};
    w.isTauri=false; sessionStorage.setItem("practiq-preview", "normal");
    let user: unknown=null, generation=1, paid=false, origin='http://127.0.0.1:8090';
    let payment: {id:string;requestId:string;productId:string;state:string;environment:string;amount:string;subject:string;refunds:unknown[]} | null=null;
    const products=[{id:'free',name:'Free',amount:'0.00',pages:50,durationDays:null,activeTasks:1,priority:false},{id:'plus',name:'Plus',amount:'39.00',pages:100,durationDays:30,activeTasks:2,priority:false},{id:'pro',name:'Pro',amount:'99.00',pages:300,durationDays:30,activeTasks:3,priority:true},{id:'pages50',name:'50 页加量包',amount:'19.90',pages:50,durationDays:365,activeTasks:1,priority:false}];
    w.__TAURI_INTERNALS__={invoke:async(command:string,args:{request:Record<string,unknown>;context?:{origin:string;generation:number}})=>{
      const r=args.request; await w.__recordCloudCall({command,request:r});
      if(command==='cloud_request'){
        let value: unknown;
        if(r.type==='status') value={origin,generation};
        else if(r.type==='configure') {origin=String(r.origin);generation++;value={origin,generation};}
        else if(r.type==='forget_session') {user=null;generation++;value=null;}
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
  await expect(page.locator('.preview-controls')).toHaveCount(0);
  await expect(page.getByText(/开发预览：仅演示账户与资料/)).toHaveCount(0);
  const sidebar=page.locator('#app-sidebar');
  await expect(page.getByRole('heading',{name:'我的题库',exact:true})).toBeVisible();
  await expect(sidebar.getByRole('button',{name:'个人中心',exact:true})).toHaveAttribute('aria-description','未登录');
  expect(calls.filter(c=>c.command==='cloud_request').every(c=>c.request.type==='status'||c.request.type==='fetch'&&c.request.method==='GET'&&c.request.path==='/api/auth/session')).toBe(true);
  await sidebar.getByRole('button',{name:'个人中心',exact:true}).click();
  await expect(page.getByLabel('云端服务地址',{exact:true})).toHaveCount(0);
  await expect(page.getByText('云端连接设置',{exact:true})).toHaveCount(0);
  await expect(page.getByText('http://127.0.0.1:8090',{exact:true})).toHaveCount(0);
  await expect(page.locator('.account-header:empty')).toHaveCount(0);
  await page.getByRole('button',{name:'更改云端服务地址',exact:true}).click();
  await expect(page.getByLabel('云端服务地址',{exact:true})).toHaveValue('http://127.0.0.1:8090');
  await page.getByLabel('云端服务地址',{exact:true}).fill('https://replacement.example.test');
  await page.getByRole('button',{name:'取消',exact:true}).click();
  expect(calls.some(c=>c.request.type==='configure')).toBe(false);
  await page.getByRole('button',{name:'更改云端服务地址',exact:true}).click();
  await expect(page.getByLabel('云端服务地址',{exact:true})).toHaveValue('http://127.0.0.1:8090');
  await page.getByLabel('云端服务地址',{exact:true}).fill('https://replacement.example.test');
  await page.screenshot({path:testInfo.outputPath('cloud-change-service-light.png'),fullPage:true});
  await page.getByRole('button',{name:'连接云端服务',exact:true}).click();
  await expect(page.getByLabel('登录邮箱',{exact:true})).toBeVisible();
  expect(calls.filter(c=>c.request.type==='configure').map(c=>c.request.origin)).toEqual(['https://replacement.example.test']);
  await page.getByRole('button',{name:'注册账户',exact:true}).click();
  await page.getByLabel('登录邮箱',{exact:true}).fill('app-ui@example.test');
  await page.getByLabel('密码（至少 12 字符）',{exact:true}).fill('app-ui-test-password');
  await page.screenshot({path:testInfo.outputPath('cloud-register-light.png'),fullPage:true});
  await page.getByRole('button',{name:'注册并登录',exact:true}).click();
  await expect(page.getByRole('region',{name:'个人信息'}).getByText('app-ui@example.test',{exact:true})).toBeVisible();
  await expect(sidebar.getByRole('button',{name:'个人中心',exact:true})).toHaveAttribute('aria-description','app-ui@example.test');
  await sidebar.getByRole('button',{name:'文档导入',exact:true}).click();
  await expect(page.getByRole('navigation',{name:'个人导航'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'退出登录',exact:true})).toHaveCount(0);
  await expect(page.locator('.file-picker .file-picker-action')).toHaveCount(1);
  await expect(page.getByRole('button',{name:'选择云端导入文件',exact:true})).toHaveText('选择文件');
  for (const width of [1440,960]) for (const dark of [false,true]) {
    await page.setViewportSize({width,height:1040});
    await sidebar.getByRole('button',{name:'主题',exact:true}).click();
    await page.getByRole('menuitemradio',{name:dark?'深色':'浅色',exact:true}).click();
    await expect(page.locator('html')).toHaveCSS('color-scheme',dark?'dark':'light');
    const role=await page.getByRole('combobox',{name:'文件用途',exact:true}).boundingBox();
    const range=await page.getByRole('textbox',{name:'页面范围（留空为全部）',exact:true}).boundingBox();
    expect(Math.abs(role!.y-range!.y)).toBeLessThan(2);
    expect(Math.abs(role!.height-range!.height)).toBeLessThan(2);
    const picker=await page.locator('.file-picker').boundingBox();
    const button=await page.getByRole('button',{name:'选择云端导入文件',exact:true}).boundingBox();
    expect(Math.abs(picker!.x+picker!.width/2-button!.x-button!.width/2)).toBeLessThan(2);
    await page.screenshot({path:testInfo.outputPath(`cloud-import-${width}-${dark?'dark':'light'}.png`),fullPage:true});
  }
  await page.setViewportSize({width:1440,height:1040});
  await sidebar.getByRole('button',{name:'主题',exact:true}).click();
  await page.getByRole('menuitemradio',{name:'浅色',exact:true}).click();
  await expect(page.locator('html')).toHaveCSS('color-scheme','light');
  await page.getByRole('button',{name:'选择云端导入文件',exact:true}).click();
  await expect(page.getByText('cloud-only.txt',{exact:true})).toBeVisible();
  expect(calls.some(c=>c.request.type==='upload'||c.request.path==='/api/document-tasks'&&c.request.method==='POST')).toBe(false);
  await page.getByRole('button',{name:'开始导入',exact:true}).click();
  await expect.poll(()=>calls.filter(c=>c.request.path==='/api/document-tasks'&&c.request.method==='POST').length).toBe(1);
  expect(calls.filter(c=>c.request.type==='upload').map(c=>c.request)).toEqual([{type:'upload',ticket:'private-picker-ticket'}]);
  await expect(page.getByText('根据材料选择答案',{exact:true})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('cloud-results-light.png'),fullPage:true});
  await sidebar.getByRole('button',{name:'设置',exact:true}).click();
  const allowanceCalls = calls.length;
  await page.getByRole('button',{name:'查看额度',exact:true}).click();
  await expect(page.getByRole('heading',{name:'套餐与额度',level:1})).toBeVisible();
  await expect(page.getByText('可用识别额度',{exact:true})).toBeVisible();
  await expect(page.getByLabel('AI 服务地址',{exact:true})).toHaveCount(0);
  await expect(page.getByRole('navigation',{name:'个人导航',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'导入工作区',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'退出登录',exact:true})).toHaveCount(0);
  expect(calls.slice(allowanceCalls).filter(c=>['/api/import-settings','/api/import-capabilities'].includes(String(c.request.path)))).toEqual([]);
  await page.screenshot({path:testInfo.outputPath('allowance-from-settings.png'),fullPage:true});
  await page.getByRole('button',{name:'购买记录',exact:true}).click();
  await expect(page.getByRole('heading',{name:'购买记录',exact:true})).toBeVisible();
  await expect(page.getByRole('navigation',{name:'个人导航',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'查看套餐与额度',exact:true}).click();
  await expect(page.getByText('可用识别额度',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'返回设置',exact:true}).click();
  await expect(page.getByRole('button',{name:'查看额度',exact:true})).toBeVisible();
  await sidebar.getByRole('button',{name:'文档导入',exact:true}).click();
  await expect(page.getByRole('heading',{name:'文档导入',level:1})).toBeVisible();
  await page.getByRole('navigation',{name:'工作区导航',exact:true}).getByRole('link',{name:'开始导入',exact:true}).click();
  await expect(page.getByRole('button',{name:'选择云端导入文件',exact:true})).toBeVisible();
  await expect(page.getByText('可用识别额度',{exact:true})).toHaveCount(0);
  await sidebar.getByRole('button',{name:'设置',exact:true}).click();
  await page.getByRole('button',{name:'查看额度',exact:true}).click();
  await expect(page.getByRole('heading',{name:'套餐与额度',level:1})).toBeVisible();
  await expect(page.getByText('可用识别额度',{exact:true})).toBeVisible();
  await expect(page.getByRole('navigation',{name:'个人导航',exact:true})).toHaveCount(0);
  await sidebar.getByRole('button',{name:'个人中心',exact:true}).click();
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
  await page.getByRole('button',{name:'清除本机登录状态',exact:true}).click();
  await expect(page.getByLabel('登录邮箱',{exact:true})).toBeVisible();
  expect(calls.filter(c=>c.request.type==='forget_session')).toHaveLength(1);
  await sidebar.getByRole('button',{name:'我的题库',exact:true}).click();
  await expect(page.getByRole('heading',{name:'我的题库',exact:true})).toBeVisible();
  await expect(sidebar.getByRole('button',{name:'个人中心',exact:true})).toHaveAttribute('aria-description','未登录');
  expect(errors).toEqual([]); expect(external).toEqual([]);
});

for (const language of ['en','zh-TW'] as const) test(`cloud account and plan copy follows ${language}`,async({page},testInfo)=>{
  await page.addInitScript(({language})=>{
    const w=window as unknown as {__TAURI_INTERNALS__:unknown};
    w.__TAURI_INTERNALS__={invoke:async(command:string,args:{request:Record<string,unknown>;context:{origin:string;generation:number}|null})=>{
      if(command==='cloud_request') {
        const {previewCloud}=await import('/scripts/fixtures/cloud-preview.ts');
        return previewCloud(args.request,args.context,'normal');
      }
      switch(args.request.type){
        case 'language':return language;case 'banks':return [];
        case 'info':return {version:'Localization substitute',dataDirectory:'isolated'};
        case 'banks_page':case 'sessions_page':return {items:[],total:0,offset:0};
        case 'unfinished_session':return null;
        case 'backup_status':return {lastBackupAt:null,newAttempts:0,changedNotes:0,due:false};
        default:throw Error('Unexpected local action');
      }
    }};
  },{language});
  await page.goto('/');
  const english=language==='en';
  await page.locator('#app-sidebar').getByRole('button',{name:english?'Account':'個人中心',exact:true}).click();
  await expect(page.getByRole('heading',{name:english?'Sign in to PractiQ':'登入 PractiQ',exact:true})).toBeVisible();
  await page.getByRole('button',{name:english?'Register account':'註冊帳戶',exact:true}).click();
  await page.getByLabel(english?'Login email':'登入電子郵件',{exact:true}).fill('locale@example.test');
  await page.getByLabel(english?'Password (at least 12 characters)':'密碼（至少 12 字符）',{exact:true}).fill('localized-test-password');
  await page.getByRole('button',{name:english?'Register and sign in':'註冊並登入',exact:true}).click();
  await expect(page.getByRole('region',{name:english?'Profile':'個人信息',exact:true})).toBeVisible();
  await page.getByRole('button',{name:english?'Plans and allowance':'套餐與額度',exact:true}).click();
  await expect(page.getByRole('heading',{name:english?'Current plan · Free':'當前套餐 · Free',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:english?'Buy Plus':'購買 Plus',exact:true})).toBeDisabled();
  await page.screenshot({path:testInfo.outputPath(`plans-${language}-light.png`),fullPage:true});
  await page.evaluate(()=>document.documentElement.classList.add('dark'));
  await page.screenshot({path:testInfo.outputPath(`plans-${language}-dark.png`),fullPage:true});
});
