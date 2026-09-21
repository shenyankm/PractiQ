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
    case 'save_attempt':case 'save_draft':return null;
    case 'questions':return questions;
    case 'questions_page':return {items:questions.slice(request.offset,request.offset+request.limit),total:questions.length,offset:request.offset};
    case 'info':return {version:'preview',dataDirectory:'/local/test'};
    case 'settings':return {config:{base_url:null,model_id:null,oss_url:null},hasApiKey:false};
    case 'preview_paper': {
     const selected=questions.slice(0,request.request.count);
     return {questionIds:selected.map(q=>q.id),digest:'browser-preview',questions:selected,scores:selected.map(()=>0),count:selected.length};
    }
    case 'start_paper':return {id:'session',title:'原始名称',createdAt:1,finishedAt:null,position:0,mode:'ordered',attempts:request.paper.question_ids.map((id,i)=>({ordinal:i,snapshot:questions.find(q=>q.id===id),answer:null,autoResult:null,result:null,gradeKind:'ungraded',submittedAt:null,skipped:false,elapsedMs:0}))};
    default:throw Error(`Unexpected request: ${request.type}`);
   }
  }};
 },{fixture:JSON.parse(fs.readFileSync('fixtures/sample.json','utf8'))});
 await page.goto('http://127.0.0.1:1420');
 await page.getByRole('heading',{name:'My banks',exact:true}).waitFor();
 assert.equal(await page.evaluate(async () => (await import('/node_modules/@tauri-apps/api/core.js')).isTauri()),false);

 const overflow=async label=>({label,items:await page.locator('aside *, main *, [role=dialog] *').evaluateAll(elements=>elements.filter(e=>e.clientWidth>0&&e.scrollWidth>e.clientWidth+3&&getComputedStyle(e).overflowX==='visible'&&e.children.length===0&&e.textContent.trim()).map(e=>({tag:e.tagName,text:e.textContent.slice(0,140),width:e.clientWidth,scroll:e.scrollWidth}))) });
 const checks=[await overflow('banks')];
 for (const names of [
  {locale:'en',language:'Language',collapse:'Collapse sidebar',expand:'Expand sidebar',nav:['My banks','Import','Mistakes','Favorites','History','Settings']},
  {locale:'zh-CN',language:'语言',collapse:'收起侧边栏',expand:'展开侧边栏',nav:['我的题库','导入题库','错题本','收藏夹','练习记录','设置']},
 ]) {
  await page.locator('aside button[aria-haspopup="dialog"]').click();
  await page.getByRole('combobox').selectOption(names.locale);
  await page.waitForFunction(locale=>document.documentElement.lang===locale,names.locale);
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({state:'hidden'});
  const expandedMain=await page.locator('main').boundingBox();
  const toggle=page.getByRole('button',{name:names.collapse,exact:true});
  await toggle.focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.getByRole('button',{name:names.expand}).getAttribute('aria-expanded'),'false');
  const sidebar=await page.locator('aside').boundingBox();
  const collapsedMain=await page.locator('main').boundingBox();
  assert.equal(sidebar.width,64);
  assert.equal(collapsedMain.width-expandedMain.width,160);
  assert.equal(collapsedMain.x,sidebar.x+sidebar.width);
  assert.equal(await page.locator('aside').getByText('PractiQ',{exact:true}).isVisible(),false);
  for (const name of names.nav) {
   const entry=page.locator('aside').getByRole('button',{name,exact:true});
   await entry.hover();
   await page.getByRole('tooltip',{name,exact:true}).waitFor();
   await page.mouse.move(900,10);
   await entry.focus();
   await page.getByRole('tooltip',{name,exact:true}).waitFor();
   await page.keyboard.press('Enter');
   await page.waitForFunction(name=>document.querySelector('aside button[aria-current="page"]')?.getAttribute('aria-label')===name,name);
   assert.equal(await entry.locator('span').first().isVisible(),false);
  }
  for (const button of await page.locator('aside button').all()) {
   const box=await button.boundingBox();
   assert(box && box.x>=sidebar.x && box.x+box.width<=sidebar.x+sidebar.width && box.y>=0 && box.y+box.height<=820);
  }
  await page.getByRole('button',{name:names.language,exact:true}).click();
  await page.getByRole('dialog',{name:names.language,exact:true}).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({state:'hidden'});
  assert.equal(await page.getByRole('button',{name:names.language,exact:true}).evaluate(el=>el===document.activeElement),true);
  checks.push(await overflow(names.locale+' collapsed'));
  await page.getByRole('button',{name:names.expand,exact:true}).click();
  assert.equal((await page.locator('aside').boundingBox()).width,224);
  checks.push(await overflow(names.locale+' expanded'));
 }
 await page.getByRole('button',{name:'语言',exact:true}).click();
 await page.getByRole('combobox',{name:'语言'}).selectOption('en');
 await page.getByRole('dialog',{name:'Language',exact:true}).waitFor();
 await page.keyboard.press('Escape');
 await page.getByRole('dialog').waitFor({state:'hidden'});

 await page.getByRole('button',{name:'Settings',exact:true}).click();
 await page.getByRole('heading',{name:'Settings',exact:true}).waitFor();
 checks.push(await overflow('settings'));
 await page.getByRole('button',{name:'Import',exact:true}).click();
 await page.getByText('Choose bank JSON',{exact:true}).waitFor();
 checks.push(await overflow('import'));
 const savesBeforeDismiss=await page.evaluate(()=>window.__calls.filter(c=>c.request.type==='save_language').length);
 assert.equal(await page.getByRole('combobox',{name:'Language'}).count(),0);
 const languageEntry=page.getByRole('button',{name:'Language',exact:true});
 await languageEntry.focus();
 await page.keyboard.press('Enter');
 const languageDialog=page.getByRole('dialog',{name:'Language',exact:true});
 await languageDialog.waitFor();
 checks.push(await overflow('language'));
 const selector = page.getByRole('combobox',{name:'Language'});
 assert.equal(await selector.inputValue(),'en');
 await page.keyboard.press('Escape');
 await languageDialog.waitFor({state:'hidden'});
 assert.equal(await languageEntry.evaluate(el=>el===document.activeElement),true);
 assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c.request.type==='save_language').length),savesBeforeDismiss);
 await languageEntry.click();
 await page.waitForFunction(()=>!document.querySelector('#app-language').disabled);
 await selector.selectOption('zh-CN');
 await page.getByRole('dialog',{name:'语言',exact:true}).waitFor();
 await page.waitForFunction(()=>!document.querySelector('#app-language').disabled);
 await page.getByRole('combobox',{name:'语言'}).focus();
 // Native select type-ahead works with real key events on macOS headless Chromium.
 await page.keyboard.press('e');
 await page.getByRole('dialog',{name:'Language',exact:true}).waitFor();
 await page.keyboard.press('Escape');
 await page.getByRole('dialog').waitFor({state:'hidden'});
 await page.waitForFunction(()=>document.activeElement?.textContent?.trim()==='Language');
 await page.reload();
 await page.getByRole('heading',{name:'My banks',exact:true}).waitFor();
 await page.getByRole('button',{name:'Language',exact:true}).click();
 assert.equal(await page.getByRole('combobox',{name:'Language'}).inputValue(),'en');
 await page.getByRole('button',{name:'Close',exact:true}).click();
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
 const paperCalls=await page.evaluate(()=>window.__calls.map(c=>c.request).filter(r=>['preview_paper','start_paper'].includes(r.type)));
 assert.deepEqual(paperCalls.map(r=>r.type),['preview_paper','start_paper']);
 assert.equal(paperCalls[1].paper.digest,'browser-preview');
 assert.deepEqual(paperCalls[1].paper.question_ids,Array.from({length:paperCalls[0].request.count},(_,i)=>String(i)));
 const answer=page.getByRole('radio').first();
 await answer.click();
 assert.equal(await answer.getAttribute('aria-checked'),'true');
 await page.getByRole('button',{name:'Collapse sidebar',exact:true}).click();
 assert.equal(await answer.getAttribute('aria-checked'),'true');
 await page.getByRole('heading',{name:'Practice',exact:true}).waitFor();
 checks.push(await overflow('practice collapsed'));
 await page.getByRole('button',{name:'Expand sidebar',exact:true}).click();
 assert.equal(await answer.getAttribute('aria-checked'),'true');
 checks.push(await overflow('practice'));
 assert.deepEqual(errors,[]);
 for (const check of checks) assert.deepEqual(check.items,[],`Text overflow: ${check.label}`);
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 assert.deepEqual(await page.evaluate(()=>window.__calls.filter(c=>c.command==='ai_request'&&!['operations','batches'].includes(c.request.type))),[]);
 console.log('PASS: bilingual expanded/collapsed sidebar navigation, tooltips, draft retention, language dialog/focus, 960px layouts; no model requests.');
} finally { await browser?.close(); await server.close(); }
