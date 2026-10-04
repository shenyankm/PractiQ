import { test as base, expect } from 'playwright/test';
import fs from 'node:fs';
import assert from 'node:assert/strict';

// Each independent flow gets fresh service settings and fail-closed IPC mocks.
const test=base.extend({observedCalls:[async ({page},use)=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const observedCalls=[];
 await page.exposeFunction('__recordMockCall',call=>observedCalls.push(call));
 await page.addInitScript(({fixture})=>{
  // Exercise the browser UI with mocked commands, not native window/event APIs.
  window.isTauri = false;
  let lang=localStorage.getItem('test-language');
  const banks=[{id:'one',title:'原始题库 — Original bank',description:'Imported content stays unchanged',count:fixture.questions.length,createdAt:1},{id:'two',title:'Mathematics',description:'',count:0,createdAt:1}];
  const questions=fixture.questions.map((q,i)=>({id:String(i),bankId:'one',bankTitle:banks[0].title,question:q,groups:[],visuals:[],sources:[],warnings:[],missingAssets:false,favorite:false,latestResult:null}));
  let settings={config:{service_url:null},hasServiceToken:false};
  window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
   const request = args?.request;
   await window.__recordMockCall({command,request});
   if (command!=='request') throw Error(`Unexpected native command: ${command}`);
   switch(request.type){
    case 'language':return lang;
    case 'save_language': if(window.__failLanguageSave) throw {code:'LOCAL_LANGUAGE_INVALID',message:'语言设置无效'};lang=request.locale;localStorage.setItem('test-language',lang);return lang;
    case 'banks':return banks;
    case 'banks_page':return {items:banks,total:banks.length,offset:0};
    case 'sessions_page':return {items:[],total:0,offset:0};
    case 'unfinished_session':return null;
    case 'save_attempt':case 'save_draft':return null;
    case 'question_stats':return {count:questions.length,types:questions.reduce((types,{question:q})=>{const type=q.answerMode==='choice'?q.choiceVariant:q.answerMode;types[type]=(types[type]||0)+1;return types;},{})};
    case 'questions_page':return {items:questions.slice(request.offset,request.offset+request.limit),total:questions.length,offset:request.offset};
    case 'info':return {version:'preview',dataDirectory:'/local/test'};
    case 'settings':return settings;
    case 'test_settings':return null;
    case 'save_settings': {
     const hasServiceToken=request.service_token===null ? (request.config.service_url===settings.config.service_url ? settings.hasServiceToken:null):!!request.service_token.trim();
     settings={config:request.config,hasServiceToken};return settings;
    }
    case 'pick_import':return null;
    case 'preview_paper': {
     const selected=questions.slice(0,request.request.count);
     return {questionIds:selected.map(q=>q.id),digest:'browser-preview',questions:selected,scores:selected.map(()=>0),count:selected.length};
    }
    case 'start_paper':return {id:'session',title:'原始名称',createdAt:1,finishedAt:null,position:0,mode:'ordered',attempts:request.paper.question_ids.map((id,i)=>({ordinal:i,snapshot:questions.find(q=>q.id===id),answer:null,autoResult:null,result:null,gradeKind:'ungraded',submittedAt:null,skipped:false,elapsedMs:0}))};
    default:throw Error(`Unexpected request: ${request.type}`);
   }
  }};
 },{fixture:JSON.parse(fs.readFileSync('fixtures/sample.json','utf8'))});
 await page.goto('/');
 await expect(page.getByRole('heading',{name:'My banks',exact:true})).toBeVisible();
 expect(await page.evaluate(async () => (await import('/node_modules/@tauri-apps/api/core.js')).isTauri())).toBe(false);
 await use(observedCalls);
 expect(errors).toEqual([]);
 expect(observedCalls.filter(c=>c.command!=='request')).toEqual([]);

}, {auto:true}]});

const settleSidebar=page=>page.locator('#app-sidebar').evaluate(async el=>{
 await Promise.all(el.getAnimations({subtree:true}).map(animation=>animation.finished));
});
async function expectNoOverflow(page,label) {
 await expect.poll(()=>page.locator('aside *, main *, [role=dialog] *, [role=menu] *').evaluateAll(elements=>elements.filter(e=>e.clientWidth>0&&e.scrollWidth>e.clientWidth+3&&getComputedStyle(e).overflowX==='visible'&&e.children.length===0&&e.textContent.trim()).map(e=>({tag:e.tagName,text:e.textContent.slice(0,140),width:e.clientWidth,scroll:e.scrollWidth}))),{message:`Text overflow: ${label}`}).toEqual([]);
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),{message:`Page overflow: ${label}`}).toBe(true);
}

test('question-list failures persist, hide stale actions and retry the current filters',async ({page,observedCalls})=>{
 await page.evaluate(()=>{
  const original=window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke=async(command,args)=>{
   if(command!=='request'||args.request.type!=='questions_page') return original(command,args);
   const result=await original(command,args);
   if(window.__failQuestionRead) throw Error('Question read unavailable');
   const stem=args.request.search?'Current beta question':'Previous alpha question';
   return {items:[{...result.items[0],question:{...result.items[0].question,stem}}],total:60,offset:args.request.offset};
  };
 });
 await page.getByRole('button',{name:'View questions',exact:true}).first().click();
 await expect(page.getByText('Previous alpha question',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Edit question',exact:true})).toBeEnabled();
 await page.evaluate(()=>{window.__failQuestionRead=true;});
 await page.getByRole('textbox',{name:'Search questions',exact:true}).fill('beta');
 await page.getByRole('combobox',{name:'Filter by question type',exact:true}).selectOption('single');
 await page.getByRole('checkbox',{name:'Show only items needing review',exact:true}).check();
 const alert=page.getByRole('alert');
 await expect(alert).toContainText('Could not load questions');
 await expect(alert).toContainText('Question read unavailable');
 await expect(page.getByText('Previous alpha question',{exact:true})).toHaveCount(0);
 await expect(page.getByText('60 questions',{exact:true})).toHaveCount(0);
 for(const name of ['Edit question','Delete question','Favorite question','Next page']) await expect(page.getByRole('button',{name,exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Start practice',exact:true})).toBeDisabled();
 await expect(page.getByText('No questions found',{exact:true})).toHaveCount(0);
 await expectNoOverflow(page,'question-list failure');
 await page.evaluate(()=>{window.__failQuestionRead=false;});
 const retry=alert.getByRole('button',{name:'Retry',exact:true});
 await retry.focus();
 await page.keyboard.press('Enter');
 await expect(page.getByText('Current beta question',{exact:true})).toBeVisible();
 await expect(alert).toHaveCount(0);
 await expect(page.getByRole('textbox',{name:'Search questions',exact:true})).toHaveValue('beta');
 await expect(page.getByRole('combobox',{name:'Filter by question type',exact:true})).toHaveValue('single');
 await expect(page.getByRole('checkbox',{name:'Show only items needing review',exact:true})).toBeChecked();
 expect(observedCalls.filter(c=>c.request.type==='questions_page').at(-1).request).toEqual({type:'questions_page',bank_ids:['one'],search:'beta',mode:'single',filter:'review',limit:30,offset:0});
});

test('retry saves the failed language selection without resetting it to the saved preference',async ({page,observedCalls})=>{
 await page.getByRole('button',{name:'Language',exact:true}).click();
 await page.getByRole('menuitemradio',{name:'简体中文',exact:true}).click();
 await expect(page.getByRole('heading',{name:'我的题库',exact:true})).toBeVisible();
 await page.evaluate(()=>{window.__failLanguageSave=true;});
 await page.getByRole('button',{name:'语言',exact:true}).click();
 await page.getByRole('menuitemradio',{name:'English',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('保存语言设置失败');
 const before=observedCalls.length;
 await page.evaluate(()=>{window.__failLanguageSave=false;});
 await page.getByRole('menu').getByRole('button',{name:'重试',exact:true}).click();
 await expect(page.getByRole('heading',{name:'My banks',exact:true})).toBeVisible();
 await expect(page.getByRole('menu')).toHaveCount(0);
 expect(observedCalls.slice(before).map(c=>c.request)).toEqual([{type:'save_language',locale:'en'}]);
 await page.reload();
 await expect(page.getByRole('heading',{name:'My banks',exact:true})).toBeVisible();
});

test('theme follows system preferences and persists an explicit choice',async ({page})=>{
 await page.emulateMedia({colorScheme:'dark'});
 await expect(page.locator('html')).toHaveClass(/dark/);
 await page.getByRole('button',{name:'Theme',exact:true}).click();
 await expect(page.getByRole('menuitemradio',{name:'System',exact:true})).toHaveAttribute('aria-checked','true');
 await page.getByRole('menuitemradio',{name:'Light',exact:true}).click();
 await expect(page.locator('html')).not.toHaveClass(/dark/);
 await page.reload();
 await expect(page.getByRole('heading',{name:'My banks',exact:true})).toBeVisible();
 await expect(page.locator('html')).not.toHaveClass(/dark/);
 await page.getByRole('button',{name:'Collapse sidebar',exact:true}).click();
 await page.getByRole('button',{name:'Theme',exact:true}).click();
 await expect(page.getByRole('menuitemradio',{name:'Light',exact:true})).toHaveAttribute('aria-checked','true');
 await page.getByRole('menuitemradio',{name:'Dark',exact:true}).click();
 await expect(page.locator('html')).toHaveClass(/dark/);
 await page.getByRole('button',{name:'Theme',exact:true}).click();
 await page.getByRole('menuitemradio',{name:'System',exact:true}).click();
 await page.emulateMedia({colorScheme:'light'});
 await expect(page.locator('html')).not.toHaveClass(/dark/);
 await page.getByRole('button',{name:'Expand sidebar',exact:true}).click();
});

test('bilingual sidebar preserves alignment, keyboard navigation and language preferences',async ({page,observedCalls})=>{
 await expectNoOverflow(page,'banks');
 for (const names of [
  {locale:'en',language:'Language',collapse:'Collapse sidebar',expand:'Expand sidebar',nav:['My banks','Mistakes','Favorites','History','Settings']},
  {locale:'zh-CN',language:'语言',collapse:'收起侧边栏',expand:'展开侧边栏',nav:['我的题库','错题本','收藏夹','练习记录','设置']},
 ]) {
  await page.locator('aside').getByRole('button',{name:/^(Language|语言)$/,exact:true}).click();
  await page.getByRole('menuitemradio',{name:names.locale==='en'?'English':'简体中文',exact:true}).click();
  await expect(page.locator('html')).toHaveAttribute('lang',names.locale);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  const sidebarPositions=()=>page.locator('aside button').evaluateAll(buttons=>buttons.map(button=>{const rect=button.getBoundingClientRect();const icon=button.querySelector('img,svg').getBoundingClientRect();return {y:rect.y,height:rect.height,iconX:icon.x,iconY:icon.y};}));
  const expandedPositions=await sidebarPositions();
  const expandedMain=await page.locator('main').boundingBox();
  const toggle=page.getByRole('button',{name:names.collapse,exact:true});
  await toggle.hover();
  await expect(toggle.locator('img')).toHaveCSS('opacity','0');
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button',{name:names.expand})).toHaveAttribute('aria-expanded','false');
  const intermediateWidth=await page.locator('#app-sidebar').evaluate(el=>{
   const animation=el.getAnimations().find(animation=>animation.transitionProperty==='width');
   if (!animation) throw Error('Missing sidebar width transition');
   animation.pause(); animation.currentTime=animation.effect.getComputedTiming().duration/2;
   const width=el.getBoundingClientRect().width;
   animation.play(); return width;
  });
  assert(intermediateWidth>64 && intermediateWidth<176,'Sidebar passes through an intermediate width');
  await settleSidebar(page);
  await page.mouse.move(900,10); await page.locator('main').click({position:{x:10,y:10}});
  const collapsedToggle=page.getByRole('button',{name:names.expand,exact:true});
  await expect(collapsedToggle.locator('img')).toHaveCSS('opacity','1');
  await collapsedToggle.hover();
  await expect(collapsedToggle.locator('img')).toHaveCSS('opacity','0');
  const sidebar=await page.locator('#app-sidebar').boundingBox();
  const collapsedMain=await page.locator('main').boundingBox();
  assert.deepEqual(await sidebarPositions(),expandedPositions,'Sidebar rows and icons stay aligned when collapsed');
  assert.equal(sidebar.width,64);
  assert.equal(collapsedMain.width-expandedMain.width,112);
  assert.equal(collapsedMain.x,sidebar.x+sidebar.width);
  await expect(page.locator('#app-sidebar').getByText('PractiQ',{exact:true})).toBeHidden();
  for (const name of names.nav) {
   const entry=page.locator('#app-sidebar').getByRole('button',{name,exact:true});
   await entry.hover();
   await expect(page.getByRole('tooltip',{name,exact:true})).toBeVisible();
   await page.mouse.move(900,10);
   await entry.focus();
   await expect(page.getByRole('tooltip',{name,exact:true})).toBeVisible();
   await page.keyboard.press('Enter');
   await expect(entry).toHaveAttribute('aria-current','page');
   await expect(entry.locator('span').first()).toBeHidden();
  }
  for (const button of await page.locator('aside button').all()) {
   const box=await button.boundingBox();
   assert(box && box.x>=sidebar.x && box.x+box.width<=sidebar.x+sidebar.width && box.y>=0 && box.y+box.height<=820);
  }
  await page.getByRole('button',{name:names.language,exact:true}).click();
  await expect(page.getByRole('menu',{name:names.language,exact:true})).toBeVisible();
  const menuBox=await page.getByRole('menu').boundingBox();
  const languageBox=await page.getByRole('button',{name:names.language,exact:true,includeHidden:true}).boundingBox();
  assert(menuBox.y+menuBox.height<=languageBox.y && menuBox.x>=0 && menuBox.x+menuBox.width<=960);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  await expect(page.getByRole('button',{name:names.language,exact:true})).toBeFocused();
  await expectNoOverflow(page,names.locale+' collapsed');
  await page.getByRole('button',{name:names.expand,exact:true}).click();
  await settleSidebar(page);
  await expect(page.locator('#app-sidebar')).toHaveCSS('width','176px');
  assert.deepEqual(await sidebarPositions(),expandedPositions,'Sidebar rows and icons stay aligned after expanding');
  await expectNoOverflow(page,names.locale+' expanded');
  const serviceEntry=page.getByRole('button',{name:names.locale==='en'?'Configure':'配置',exact:true});
  await serviceEntry.click();
  await expect(page.getByLabel(names.locale==='en'?'AI service URL':'AI 服务地址',{exact:true})).toBeVisible();
  await expectNoOverflow(page,names.locale+' service settings');
  await page.getByRole('button',{name:names.locale==='en'?'Back to settings':'返回设置',exact:true}).click();
  await expect(serviceEntry).toBeVisible();
  await expect(page.getByLabel(names.locale==='en'?'AI service URL':'AI 服务地址',{exact:true})).toHaveCount(0);
 }
 await page.getByRole('button',{name:'语言',exact:true}).click();
 await page.getByRole('menuitemradio',{name:'English',exact:true}).click();
 await expect(page.getByRole('menu')).toBeHidden();
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Settings',exact:true})).toBeVisible();
 await expectNoOverflow(page,'settings');
 const savesBeforeDismiss=observedCalls.filter(c=>c.request.type==='save_language').length;
 const languageEntry=page.getByRole('button',{name:'Language',exact:true});
 await languageEntry.focus(); await page.keyboard.press('Enter');
 await expect(page.getByRole('menu')).toBeVisible();
 await expectNoOverflow(page,'language');
 await expect(page.getByRole('menuitemradio',{name:'English',exact:true})).toHaveAttribute('aria-checked','true');
 await page.keyboard.press('Escape');
 await expect(page.getByRole('menu')).toBeHidden();
 await expect(languageEntry).toBeFocused();
 expect(observedCalls.filter(c=>c.request.type==='save_language')).toHaveLength(savesBeforeDismiss);
 await languageEntry.click();
 await page.getByRole('menuitemradio',{name:'简体中文',exact:true}).click();
 await expect(page.getByRole('menu')).toBeHidden();
 await page.getByRole('button',{name:'语言',exact:true}).click();
 await expect(page.getByRole('menu')).toBeVisible();
 await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown');
 await expect(page.getByRole('menuitemradio',{name:'English',exact:true})).toBeFocused();
 await page.keyboard.press('Enter');
 await expect(page.getByRole('menu')).toBeHidden();
 await expect(page.locator('html')).toHaveAttribute('lang','en');
 await page.reload();
 await expect(page.getByRole('heading',{name:'My banks',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Language',exact:true}).click();
 await expect(page.getByRole('menuitemradio',{name:'English',exact:true})).toHaveAttribute('aria-checked','true');
 await page.keyboard.press('Escape');
 await expect(page.getByRole('menu')).toBeHidden();
});

test('offline ZIP entry and service settings never submit documents or start model work',async ({page,observedCalls})=>{
 await expect(page.locator('aside').getByRole('button',{name:'Import',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Start import',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Have a bank ZIP? Import it in Settings',exact:true}).click();
 await expect(page.getByRole('menuitem',{name:'Import bank ZIP',exact:true})).toBeVisible();
 await expect(page.getByRole('menuitem',{name:'Restore study-data backup',exact:true})).toBeVisible();
 await expectNoOverflow(page,'ZIP import and full restore choices');
 await page.getByRole('menuitem',{name:'Import bank ZIP',exact:true}).click();
 await expect(page.getByRole('menu')).toBeHidden();
 await expect(page.getByRole('heading',{name:'Settings',exact:true})).toBeVisible();
 await expect.poll(()=>observedCalls.filter(c=>c.request.type==='pick_import').length).toBe(1);

 await page.getByRole('button',{name:'Configure',exact:true}).click();
 await expect(page.getByRole('heading',{name:'AI service',exact:true})).toBeVisible();
 const url=page.getByLabel('AI service URL',{exact:true});
 const token=page.getByLabel('AI service access token',{exact:true});
 await expect(page.getByLabel('Model ID',{exact:true})).toHaveCount(0);
 await expect(page.getByLabel('API Key',{exact:true})).toHaveCount(0);
 await expect(token).toHaveAttribute('type','password');
 await url.fill('https://service.example.test');
 await token.focus();
 await expect.poll(()=>observedCalls.some(c=>c.request.type==='save_settings'&&c.request.config.service_url==='https://service.example.test')).toBe(true);
 await token.fill('fake-browser-token');
 await page.getByRole('button',{name:'Test',exact:true}).focus();
 await expect(token).toHaveValue('');
 const savedRequests=()=>observedCalls.filter(c=>c.request.type==='save_settings').map(c=>c.request);
 await expect.poll(savedRequests,'Each completed field blur saves once').toEqual([
  {type:'save_settings',config:{service_url:'https://service.example.test'},service_token:null},
  {type:'save_settings',config:{service_url:'https://service.example.test'},service_token:'fake-browser-token'},
 ]);
 await expectNoOverflow(page,'autosaved service settings');
 await page.getByRole('button',{name:'Test',exact:true}).click();
 await expect(page.getByText('Connection test passed',{exact:true})).toBeVisible();
 expect(savedRequests()).toHaveLength(2);
 await expect.poll(()=>observedCalls.filter(c=>c.request.type==='test_settings').map(c=>c.request)).toEqual([{type:'test_settings',config:{service_url:'https://service.example.test'},service_token:null}]);
 await url.fill('https://service-latest.example.test');
 await page.getByRole('button',{name:'Back to settings',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Settings',exact:true})).toBeVisible();
 await expect.poll(savedRequests,'Navigation flush and blur share the latest save').toHaveLength(3);
 expect(savedRequests().at(-1)).toEqual({type:'save_settings',config:{service_url:'https://service-latest.example.test'},service_token:null});
 await page.getByRole('button',{name:'Configure',exact:true}).click();
 await expect(url).toHaveValue('https://service-latest.example.test');
 await expect(token).toHaveValue('');
 await token.fill('fake-latest-service-token');
 await page.getByRole('button',{name:'Test',exact:true}).focus();
 await expect.poll(savedRequests).toHaveLength(4);
 await page.getByRole('button',{name:'Clear saved access token',exact:true}).click();
 await expect.poll(savedRequests).toHaveLength(5);
 expect(savedRequests().at(-1)).toEqual({type:'save_settings',config:{service_url:'https://service-latest.example.test'},service_token:''});
 await expect(page.getByRole('button',{name:'Test',exact:true})).toBeDisabled();
 await expect(token).toHaveValue('');
 await page.getByRole('button',{name:'Back to settings',exact:true}).click();
 await expect(page.getByRole('status').filter({hasText:'Not configured'})).toBeVisible();
 expect(observedCalls.every(c=>c.command==='request')).toBe(true);
});

test('practice preserves answers across sidebar and viewport changes',async ({page,observedCalls})=>{
 await page.getByRole('button',{name:'Start practice',exact:true}).first().click();
 await expect(page.getByRole('dialog')).toBeVisible();
 await page.keyboard.press('Escape');
 await expect(page.getByRole('dialog')).toBeHidden();
 await expect(page.getByRole('button',{name:'Start practice',exact:true}).first()).toBeFocused();
 await page.keyboard.press('Enter');
 await expect(page.getByRole('dialog')).toBeVisible();
 await expectNoOverflow(page,'setup');
 await page.getByRole('button',{name:'Start now',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Practice',exact:true})).toBeVisible();
 const paperRequests=()=>observedCalls.map(c=>c.request).filter(r=>['preview_paper','start_paper'].includes(r.type));
 await expect.poll(()=>paperRequests().map(r=>r.type)).toEqual(['preview_paper','start_paper']);
 const paperCalls=paperRequests();
 assert.equal(paperCalls[1].paper.digest,'browser-preview');
 assert.deepEqual(paperCalls[1].paper.question_ids,Array.from({length:paperCalls[0].request.count},(_,i)=>String(i)));
 const answer=page.getByRole('radio').first();
 await answer.click();
 await expect(answer).toHaveAttribute('aria-checked','true');
 await page.getByRole('button',{name:'Collapse sidebar',exact:true}).click();
 await expect(answer).toHaveAttribute('aria-checked','true');
 await expect(page.getByRole('heading',{name:'Practice',exact:true})).toBeVisible();
 await expectNoOverflow(page,'practice collapsed');
 await page.getByRole('button',{name:'Expand sidebar',exact:true}).click();
 await expect(answer).toHaveAttribute('aria-checked','true');
 await expectNoOverflow(page,'practice');
 await settleSidebar(page);
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.getByRole('button',{name:'Collapse sidebar',exact:true}).click();
 await expect(page.locator('#app-sidebar')).toHaveCSS('width','64px');
 await expect(page.locator('aside .sidebar-label').first()).toHaveCSS('visibility','hidden');
 await expect.poll(()=>page.locator('#app-sidebar').evaluate(el=>el.getAnimations().length)).toBe(0);
 await expect(page.locator('#app-sidebar .sidebar-label').first()).toHaveCSS('transition-duration','0s');
 await page.getByRole('button',{name:'Expand sidebar',exact:true}).click();
 await expect(page.locator('#app-sidebar')).toHaveCSS('width','176px');
 for (const [width,height] of [[960,640],[1920,1080],[2560,1440]]) {
  await page.setViewportSize({width,height});
  await expectNoOverflow(page,`practice ${width}x${height}`);
  await page.keyboard.press('Tab');
  assert(await page.evaluate(()=>document.activeElement !== document.body), 'Keyboard focus must remain reachable');
 }
});


for (const delay of ['reload', 'mutation']) test(`favorite ${delay} completion preserves the current question filters and pagination`, async ({page, observedCalls}) => {
 await page.evaluate(({question, delay}) => {
  const originalInvoke = window.__TAURI_INTERNALS__.invoke;
  const row = id => ({id, bankId:'one', bankTitle:'Test bank', question:{...question,id,stem:id},groups:[],visuals:[],sources:[],warnings:[],missingAssets:false,favorite:true,latestResult:null});
  const alpha = row('alpha'), beta = row('beta');
  let mutated = false, holdReload = true;
  window.__questionRefresh = {release:null};
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
   const request = args?.request;
   if (command !== 'request' || !['favorite','questions_page'].includes(request?.type)) return originalInvoke(command,args);
   await window.__recordMockCall({command,request});
   if (request.type === 'favorite') {
    if (delay === 'mutation') await new Promise(resolve => {window.__questionRefresh.release=resolve;});
    mutated = true;
    return null;
   }
   if (delay === 'reload' && mutated && holdReload && !request.search) {
    holdReload = false;
    return new Promise(resolve => {window.__questionRefresh.release=()=>resolve({items:[alpha],total:61,offset:30});});
   }
   return {items:[request.search === 'beta' ? beta : alpha],total:request.search === 'beta' ? 31 : 61,offset:request.offset};
  };
 }, {question:JSON.parse(fs.readFileSync('fixtures/sample.json','utf8')).questions.find(q=>q.answerMode==='true_false'), delay});
 await page.getByRole('button',{name:'Favorites',exact:true}).click();
 await expect(page.getByText('alpha',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Next page',exact:true}).click();
 await expect(page.getByText('Questions 31–60',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Remove favorite',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>typeof window.__questionRefresh.release)).toBe('function');
 const search=page.getByRole('textbox',{name:'Search questions',exact:true});
 await expect(search).toBeEnabled();
 await search.fill('beta');
 await page.getByRole('combobox',{name:'Filter by question type',exact:true}).selectOption('true_false');
 await expect(page.getByText('beta',{exact:true})).toBeVisible();
 await expect(page.getByText('Questions 1–30',{exact:true})).toBeVisible();
 const reads=observedCalls.filter(call=>call.request.type==='questions_page').length;
 await page.evaluate(()=>window.__questionRefresh.release());
 if (delay === 'mutation') {
  await expect.poll(()=>observedCalls.filter(call=>call.request.type==='questions_page').length).toBe(reads+1);
  expect(observedCalls.filter(call=>call.request.type==='questions_page').at(-1).request).toMatchObject({search:'beta',mode:'true_false',offset:0,filter:'favorite'});
 }
 await expect(page.getByText('alpha',{exact:true})).toHaveCount(0);
 await expect(search).toHaveValue('beta');
 await expect(page.getByText('Questions 1–30',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Next page',exact:true}).click();
 await expect(page.getByText('Questions 31–31',{exact:true})).toBeVisible();
});
