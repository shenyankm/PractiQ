// Built App + personal HTTP/queue/storage; only native IPC and providers are substitutes.
import { chromium, request } from '../node_modules/playwright/index.mjs';
import { expect } from '../node_modules/playwright/test.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const base = process.env.PRACTIQ_ACCEPT_URL, output = process.env.PRACTIQ_ACCEPT_OUTPUT;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base || '')) throw Error('Acceptance requires an isolated loopback service');
const browser = await chromium.launch({headless:true});
const samples = [];
try {
  for (const name of ['txt','md','png']) {
    if (process.env.PRACTIQ_WORKFLOW_CASE && name !== process.env.PRACTIQ_WORKFLOW_CASE) continue;
    const api = await request.newContext({baseURL:base, maxRedirects:0});
    let generation = 1, detail = null, creates = 0, uploads = 0;
    const sample = {name,requests:[],phasesMs:{},error:null}; samples.push(sample);
    const payload = await readFile(path.join(output,'sources',`quiz.${name}`));
    const mediaType = name==='png'?'image/png':name==='md'?'text/markdown':'text/plain';
    async function forward(p, method='GET', body) {
      if (!p.startsWith('/api/') || p.includes('://') || p.includes('\\')) throw Error('Invalid acceptance API path');
      const response = await api.fetch(p,{method,...(body===undefined?{}:{data:body}),maxRedirects:0});
      sample.requests.push({method,path:p.split('?')[0],status:response.status()});
      if (method==='POST'&&p==='/api/document-tasks') { creates++; sample.threadId=(await response.json()).threadId; }
      if (method==='GET'&&/^\/api\/document-tasks\/[^/]+$/.test(p)) detail=await response.json();
      return response;
    }
    async function open() {
      const context=await browser.newContext({viewport:{width:1440,height:1040}});
      const page=await context.newPage();page.setDefaultTimeout(15000);
      page.on('pageerror',error=>console.log(name,'page error',error.message));
      await page.exposeFunction('__acceptInvoke',async(command,args)=>{
        const r=args.request;
        console.log(name, command, r.type, r.path||'');
        if(command==='request') {
          switch(r.type) {
            case 'language':return 'zh-CN'; case 'banks':return [];
            case 'info':return {version:'Acceptance native IPC substitute',dataDirectory:'isolated'};
            case 'banks_page':case 'sessions_page':return {items:[],total:0,offset:0};
            case 'unfinished_session':return null;
            case 'backup_status':return {lastBackupAt:null,newAttempts:0,changedNotes:0,due:false};
            default:throw Error(`Unexpected local request ${r.type}`);
          }
        }
        if(command!=='cloud_request') throw Error('Unexpected native command');
        let value;
        if(r.type==='status') value={origin:base,generation};
        else {
          if(args.context?.origin!==base || args.context?.generation!==generation) throw Error('Stale service context');
          if(r.type==='fetch') {
            const response=await forward(r.path,r.method||'GET',r.body===null?undefined:r.body);
            let bytes=await response.body();
            value={status:response.status(),mediaType:response.headers()['content-type']||'',bytes:bytes.toString('base64')};
          } else if(r.type==='pick_sources') value=[{name:`quiz.${name}`,size:payload.length,nativeTicket:'selected-source'}];
          else if(r.type==='upload') {
            if(r.ticket!=='selected-source') throw Error('Unknown source ticket');
            uploads++;
            const response=await forward('/api/uploads','POST',{fileName:`quiz.${name}`,sourceType:name==='png'?'image':name==='md'?'markdown':'text',mediaType,sizeBytes:payload.length,sha256:createHash('sha256').update(payload).digest('hex')});
            expect(response.status()).toBe(201); const prepared=await response.json();
            if(prepared.upload) {const put=await api.put(prepared.upload.url,{data:payload,headers:prepared.upload.headers,maxRedirects:0});expect(put.ok()).toBe(true);}
            value=prepared.document;
          } else if(r.type==='download') {
            expect(r.path).toMatch(/^\/api\/document-tasks\/[a-f0-9-]+\/export\?/);
            const response=await forward(r.path);expect(response.ok()).toBe(true);
            await writeFile(path.join(output,'exports',`${name}.zip`),await response.body()); value=true;
          } else if(r.type==='confirm') value=true;
          else throw Error(`Unexpected cloud action ${r.type}`);
        }
        return {value,generation};
      });
      await page.addInitScript(()=>{window.isTauri=false;window.__TAURI_INTERNALS__={invoke:(command,args)=>window.__acceptInvoke(command,args)};});
      await page.goto(process.env.PRACTIQ_ACCEPT_APP_URL);console.log(name, 'opened built App');return {page,context};
    }
    let current;
    try {
      const started=performance.now(); current=await open();let {page}=current;
      await page.locator('#app-sidebar').getByRole('button',{name:'文档导入',exact:true}).click();
      await page.getByRole('button',{name:'选择文档',exact:true}).click();
      await expect(page.getByRole('button',{name:'开始导入',exact:true})).toBeEnabled();
      expect(uploads).toBe(0);expect(creates).toBe(0);
      await page.getByRole('button',{name:'开始导入',exact:true}).click();
      await expect.poll(()=>creates,{timeout:15000}).toBe(1);
      await expect.poll(()=>detail?.state,{timeout:260000,intervals:[100,500]}).toMatch(/COMPLETED|FAILED|WAITING_REVIEW|INTERRUPTED|PAUSED/);
      expect(detail.state).toBe('COMPLETED');expect(detail.status).toBe('SUCCEEDED');
      await expect(page.getByText(/The Earth orbits the Sun\./).first()).toBeVisible();
      const original = structuredClone(detail);
      await page.getByText(detail.result.questions[0].stem,{selector:'summary span',exact:true}).click();
      await page.getByRole('button',{name:'对照原文与校对',exact:true}).click();
      await page.getByRole('button',{name:'人工校对',exact:true}).click();
      await page.getByRole('textbox',{name:'解析',exact:true}).fill('Manual acceptance analysis; original answer retained.');
      await page.getByRole('button',{name:'保存修订',exact:true}).click();
      await expect(page.getByText(/修订已保存/)).toBeVisible();
      const saved = await (await forward(`/api/document-tasks/${sample.threadId}/corrections`)).json();
      expect(saved.edits).toHaveLength(1);expect(saved.edits[0].question.answerPayload).toEqual(original.result.questions[0].answerPayload);
      await writeFile(path.join(output,`${name}-corrections.json`),JSON.stringify(saved,null,2)+'\n');
      sample.correctionSaved=true;
      await page.getByRole('button',{name:'下载修订版 ZIP',exact:true}).click();
      await expect.poll(async()=>{try{return (await readFile(path.join(output,'exports',`${name}.zip`))).length;}catch{return 0;}}).toBeGreaterThan(0);
      expect(uploads).toBe(1);expect(creates).toBe(1);sample.phasesMs.startToDownloaded=performance.now()-started;
      await writeFile(path.join(output,`${name}-detail.json`),JSON.stringify(detail,null,2)+'\n');
      await page.screenshot({path:path.join(output,`${name}-result.png`),fullPage:true});
      await current.context.close();current=await open();page=current.page;
      await page.locator('#app-sidebar').getByRole('button',{name:'文档导入',exact:true}).click();
      await expect(page.getByRole('link',{name:'导入记录',exact:true})).toBeVisible();
      expect(creates).toBe(1);expect(uploads).toBe(1);sample.serviceReopen=true;
      const reopened = await (await forward(`/api/document-tasks/${sample.threadId}/corrections`)).json();
      expect(reopened).toEqual(saved);
      const after = await (await forward(`/api/document-tasks/${sample.threadId}`)).json();
      expect(after.usage).toEqual(original.usage);expect(after.result).toEqual(original.result);
      sample.correctionReopen=true;
      const native=await promisify(execFile)(process.env.PRACTIQ_ACCEPT_NATIVE,['performance::workflow_practice','--exact','--ignored','--nocapture'],{timeout:120000,env:{...process.env,PRACTIQ_WORKFLOW_DIR:output,PRACTIQ_WORKFLOW_CASE:name,PRACTIQ_BENCH_OUTPUT:path.join(output,`${name}-native.json`)}});
      await writeFile(path.join(output,`${name}-native.log`),native.stdout+native.stderr);
      const rows=JSON.parse(await readFile(path.join(output,`${name}-native.json`),'utf8'));expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({name,repetition:0,reopen:true,backupRestore:true});
      sample.modelCalls=detail.usage.length;sample.unknownCalls=detail.unknownUsageCalls;expect(sample.unknownCalls).toEqual([]);
      await page.locator('#app-sidebar').getByRole('button',{name:'我的题库',exact:true}).click();
      await expect(page.getByRole('heading',{name:'我的题库',exact:true})).toBeVisible();sample.offlineAfterImport=true;
    } catch(error) {sample.error=String(error.message).slice(0,1200);if(detail)await writeFile(path.join(output,`${name}-detail.json`),JSON.stringify(detail,null,2)+'\n');}
    finally {await current?.context.close();await api.dispose();await writeFile(path.join(output,'browser.json'),JSON.stringify({samples},null,2)+'\n');}
  }
} finally {await browser.close();}
process.exitCode=samples.some(sample=>sample.error)?1:0;
