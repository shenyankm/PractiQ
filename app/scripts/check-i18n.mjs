import { chromium } from 'playwright';
import { createServer } from 'vite';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const server = await createServer({server:{port:1420,host:'127.0.0.1',strictPort:true}});
await server.listen();
let browser;
try {
 browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:960,height:820},locale:'en-US'});
 page.setDefaultTimeout(10000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(({fixture})=>{
  // Exercise the browser UI with mocked commands, not native window/event APIs.
  window.isTauri = false;
  let lang=localStorage.getItem('test-language');
  const banks=[{id:'one',title:'原始题库 — Original bank',description:'Imported content stays unchanged',count:8,createdAt:1},{id:'two',title:'Mathematics',description:'',count:8,createdAt:1}];
  const questions=fixture.questions.map((q,i)=>({id:String(i),bankId:'one',bankTitle:banks[0].title,question:q,groups:[],visuals:[],sources:[],warnings:[],missingAssets:false,favorite:false,latestResult:null}));
  window.__calls=[];
  window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
   if (!['request','ai_request'].includes(command)) throw Error(`Unexpected native command: ${command}`);
   const {request} = args;
   window.__calls.push({command,request});
   if(command==='ai_request') {if(['operations','batches'].includes(request.type)) return [];throw Error('No model calls in preview');}
   switch(request.type){
    case 'language':return lang;
    case 'save_language': lang=request.locale;localStorage.setItem('test-language',lang);return lang;
    case 'banks':return banks;
    case 'sessions':return [];
    case 'questions':return questions;
    case 'info':return {version:'preview',dataDirectory:'/local/test'};
    case 'settings':return {config:{base_url:null,model_id:null,oss_url:null},hasApiKey:false};
    case 'start_paper':return {id:'session',title:'原始名称',createdAt:1,finishedAt:null,position:0,mode:'ordered',attempts:questions.slice(0,request.paper.question_ids.length).map((q,i)=>({ordinal:i,snapshot:q,answer:null,autoResult:null,result:null,gradeKind:'ungraded',submittedAt:null,skipped:false,elapsedMs:0}))};
    default:throw Error(`Unexpected request: ${request.type}`);
   }
  }};
 },{fixture:JSON.parse(fs.readFileSync('fixtures/sample.json','utf8'))});
 await page.goto('http://127.0.0.1:1420');
 await page.getByRole('heading',{name:'My banks',exact:true}).waitFor();
 assert.equal(await page.evaluate(async () => (await import('/node_modules/@tauri-apps/api/core.js')).isTauri()),false);

 const overflow=async label=>({label,items:await page.locator('main *, [role=dialog] *').evaluateAll(elements=>elements.filter(e=>e.clientWidth>0&&e.scrollWidth>e.clientWidth+3&&getComputedStyle(e).overflowX==='visible'&&e.children.length===0&&e.textContent.trim()).map(e=>({tag:e.tagName,text:e.textContent.slice(0,140),width:e.clientWidth,scroll:e.scrollWidth}))) });
 const checks=[await overflow('banks')];
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 await page.getByRole('heading',{name:'Settings',exact:true}).waitFor();
 checks.push(await overflow('settings'));
 await page.getByRole('button',{name:'Import',exact:true}).click();
 await page.getByText('Choose bank JSON',{exact:true}).waitFor();
 checks.push(await overflow('import'));
 const selector = page.getByRole('combobox',{name:'Language'});
 await page.waitForFunction(()=>!document.querySelector('#app-language').disabled);
 await selector.selectOption('zh-CN');
 await page.getByRole('heading',{name:'导入题库',exact:true}).waitFor();
 await page.waitForFunction(()=>!document.querySelector('#app-language').disabled);
 await page.getByRole('combobox',{name:'语言'}).focus();
 // Native select type-ahead works with real key events on macOS headless Chromium.
 await page.keyboard.press('e');
 await page.getByRole('heading',{name:'Import',exact:true}).waitFor();
 await page.keyboard.press('Tab');
 assert.equal(await page.getByRole('button',{name:'Settings',exact:true}).evaluate(el=>el===document.activeElement),true);
 await page.getByRole('button',{name:'My banks',exact:true}).click();
 await page.getByRole('button',{name:'Start practice',exact:true}).first().click();
 await page.getByRole('dialog').waitFor();
 await page.keyboard.press('Escape');
 await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.waitForFunction(()=>document.activeElement?.textContent?.trim()==='Start practice');
 await page.keyboard.press('Enter');
 await page.getByRole('dialog').waitFor();
 checks.push(await overflow('setup'));
 await page.getByRole('button',{name:'Start now',exact:true}).click();
 await page.getByRole('heading',{name:'Practice',exact:true}).waitFor();
 checks.push(await overflow('practice'));
 assert.deepEqual(errors,[]);
 for (const check of checks) assert.deepEqual(check.items,[],`Text overflow: ${check.label}`);
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 assert.deepEqual(await page.evaluate(()=>window.__calls.filter(c=>c.command==='ai_request'&&!['operations','batches'].includes(c.request.type))),[]);
 console.log('PASS: bilingual sidebar keyboard, dialog dismissal/focus, 960px bank/settings/import/setup/practice layout; no model requests.');
} finally { await browser?.close(); await server.close(); }
