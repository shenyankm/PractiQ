import { chooseOption } from "../../shared/select-test.mjs";
import { test as base, expect } from 'playwright/test';
import { writeFile } from 'node:fs/promises';


async function editQuestion(page, trigger) {
  await trigger.click();
  await page.getByRole('menuitem', {name:'编辑题目',exact:true}).click();
}

function textLines(node) {
 const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);
 const tops=new Set();
 while(walker.nextNode()) {
  if(!walker.currentNode.textContent.trim()) continue;
  const range=document.createRange();
  range.selectNodeContents(walker.currentNode);
  for(const rect of range.getClientRects()) if(rect.width) tops.add(Math.round(rect.top));
 }
 return tops.size;
}

const test=base.extend({page:async ({page},use)=>{
 const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.__previewNativeCalls=0;window.__TAURI_INTERNALS__={invoke:()=>{window.__previewNativeCalls++;throw new Error('Unexpected native IPC in preview');}};});
 await use(page);
 expect(errors).toEqual([]);
 expect(await page.evaluate(()=>window.__previewNativeCalls)).toBe(0);
}});

for(const locale of ['zh-CN','en']) for(const width of [360,390,960,1280]) for(const theme of ['light','dark']) {
 test(`localized bank actions and question lists fit in ${locale} at ${width}px (${theme})`,async ({page},testInfo)=>{
  const english=locale==='en';
  await page.setViewportSize({width,height:850});
  await page.emulateMedia({reducedMotion:'reduce',colorScheme:theme});
  await page.addInitScript(language=>Object.defineProperty(navigator,'languages',{get:()=>[language]}),locale);
  await page.goto('/');
  const card=page.locator('.bank-card').first();
  await expect(card).toBeVisible();
  for(const button of await card.locator('[data-slot="card-content"] button').all()) {
   expect.soft(await button.evaluate(textLines)).toBe(1);
   const box=await button.boundingBox(),container=await card.boundingBox();
   expect.soft(box.x).toBeGreaterThanOrEqual(container.x);
   expect.soft(box.x+box.width).toBeLessThanOrEqual(container.x+container.width);
   expect.soft(box.height).toBe(width<768?48:40);
  }
  await page.screenshot({path:testInfo.outputPath('banks.png'),fullPage:true});
  const trigger=card.getByRole('button',{name:english?/^Actions for bank /:/^题库操作 /});
  await trigger.click();
  const menu=page.getByRole('menu');
  await expect(menu).toBeVisible();
  for(const item of await menu.getByRole('menuitem').all()) expect.soft(await item.evaluate(textLines)).toBe(1);
  const box=await menu.boundingBox();
  expect.soft(box.x).toBeGreaterThanOrEqual(0);
  expect.soft(box.x+box.width).toBeLessThanOrEqual(width);
  await page.screenshot({path:testInfo.outputPath('bank-menu.png'),fullPage:true});
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  if(width<768) await page.getByRole('button',{name:english?'Open navigation':'打开主导航',exact:true}).click();
  await page.getByRole('button',{name:english?'Mistakes':'错题本',exact:true}).click();
  await expect(page.locator('.question-row').first()).toBeVisible();
  const stems=await page.locator('.question-row > button > p').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().x));
  expect.soft(Math.max(...stems)-Math.min(...stems)).toBeLessThanOrEqual(1);
  if(width>=768) {
   const value=page.locator('#question-mode [data-slot="select-value"]').locator('..');
   expect.soft(await value.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  }
  expect.soft(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('mistakes.png'),fullPage:true});
 });
}

for (const [locale, width, theme] of [['zh-CN', 1280, 'light'], ['en', 960, 'dark'], ['zh-CN', 390, 'light'], ['en', 360, 'dark']]) {
 test(`settings backup actions share geometry in ${locale} at ${width}px (${theme})`, async ({page}, testInfo) => {
  await page.setViewportSize({width, height:850});
  await page.emulateMedia({reducedMotion:'reduce', colorScheme:theme});
  await page.addInitScript(language => Object.defineProperty(navigator, 'languages', {get:()=>[language]}), locale);
  await page.goto('/');
  const english=locale==='en';
  if(width<768) await page.getByRole('button',{name:english?'Open navigation':'打开主导航',exact:true}).click();
  await page.getByRole('button',{name:english?'Settings':'设置',exact:true}).click();
  const exportButton=page.getByRole('button',{name:english?'Export backup':'导出备份',exact:true});
  const restore=page.getByRole('button',{name:english?'Import and restore':'导入与恢复',exact:true});
  await expect(restore).toHaveAttribute('data-slot','dropdown-menu-trigger');
  const dimensions=await Promise.all([exportButton,restore].map(button=>button.evaluate(node=>{
   const box=node.getBoundingClientRect(), icon=node.querySelector('svg').getBoundingClientRect();
   const group=node.parentElement.getBoundingClientRect();
   return {height:box.height,width:box.width,x:box.x,y:box.y,center:box.y+box.height/2,iconHeight:icon.height,
    availableWidth:group.width,gap:parseFloat(getComputedStyle(node.parentElement).gap)};
  })));
  expect(dimensions[0].height).toBe(width<768?48:40);
  expect(dimensions[1].height).toBe(dimensions[0].height);
  if(dimensions[0].width+dimensions[1].width+dimensions[0].gap<=dimensions[0].availableWidth+1) {
   expect(Math.abs(dimensions[0].center-dimensions[1].center)).toBeLessThanOrEqual(1);
  } else {
   expect(dimensions[1].x).toBe(dimensions[0].x);
   expect(dimensions[1].y-dimensions[0].y-dimensions[0].height).toBe(dimensions[0].gap);
  }
  expect(dimensions[1].iconHeight).toBe(dimensions[0].iconHeight);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath(`settings-buttons-${locale}-${width}-${theme}.png`),fullPage:true});
  await restore.click();
  await expect(page.getByRole('menuitem',{name:english?'Import bank ZIP':'导入题库 ZIP',exact:true})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(restore).toBeFocused();
  await exportButton.click();
  await expect(page.getByText(english?'Backup saved: [演示] 未创建文件':'备份已保存：[演示] 未创建文件',{exact:true})).toBeVisible();
 });
}

test('development preview pages stay offline',async ({page},testInfo)=>{
 await page.goto('/');
 await expect(page.getByText('基础知识 · 全题型',{exact:true}).first()).toBeVisible();
 await page.getByRole('button',{name:'查看题目',exact:true}).first().click();
 await expect(page.getByText('下面哪一个是质数？',{exact:true}).first()).toBeVisible();
 await page.getByRole('button',{name:'我的题库',exact:true}).click();
 await page.getByRole('button',{name:'开始练习',exact:true}).first().click();
 await page.getByRole('button',{name:'立即开始',exact:true}).click();
 await expect(page.getByText('下面哪一个是质数？',{exact:true}).first()).toBeVisible();
 for(const name of ['错题本','收藏夹','练习记录','设置']) {
  await page.getByRole('button',{name,exact:true}).first().click();
  await expect(page.getByRole('heading',{name,exact:true})).toBeVisible();
 }
 await page.getByRole('button',{name:'练习记录',exact:true}).click();
 await page.getByRole('button',{name:'继续练习',exact:true}).first().click();
 await expect(page.getByText('下面哪一个是质数？',{exact:true}).first()).toBeVisible();
 await expect(page.locator('aside').getByRole('button',{name:'导入题库',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'我的题库',exact:true}).click();
 await page.getByRole('button',{name:'导入',exact:true}).click();
 await expect(page.getByRole('dialog',{name:'导入题库',exact:true})).toHaveCount(0);
 await expect(page.getByRole('menuitem',{name:'导入题库 ZIP',exact:true})).toBeVisible();
 await expect(page.getByRole('menuitem',{name:'恢复学习数据备份',exact:true})).toBeVisible();
 await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'我的题库',exact:true}).click();
 const bank=page.locator('[data-slot=card]').filter({has:page.getByText('基础知识 · 全题型',{exact:true})});
 await bank.getByRole('button',{name:'查看题目',exact:true}).click();
 await expect(page.getByText('题库共 9 小题 · 当前匹配 9 项',{exact:true})).toBeVisible();
 await page.screenshot({path:testInfo.outputPath('preview.png'),fullPage:true});
});

test('study rules and backup details remain available on desktop and narrow screens',async ({page},testInfo)=>{
 for(const width of [1280,390]) {
  await page.setViewportSize({width,height:900});
  await page.goto('/');
  await page.getByRole('button',{name:'开始练习',exact:true}).first().click();
  const dialog=page.getByRole('dialog');
  await expect(dialog.getByRole('heading',{name:'开始练习或考试',exact:true})).toBeVisible();
  if(width===1280) {
   await dialog.getByRole('combobox',{name:/^模式/}).click();
   await expect(page.getByRole('option',{name:'即时反馈练习',exact:true})).toHaveAttribute('data-state','checked');
   await expect(page.getByRole('listbox')).toHaveCSS('background-color','rgb(255, 252, 250)');
   await page.screenshot({path:testInfo.outputPath('app-select-menu.png'),animations:'disabled'});
   await page.keyboard.press('Escape');
   await expect(dialog.getByRole('combobox',{name:/^模式/})).toBeFocused();
   await expect(dialog).toBeVisible();
  }
  await chooseOption(dialog.getByRole('combobox',{name:/^模式/}), 'self_test');
  await expect(dialog.getByText(/作答时隐藏答案，交卷后核对评分；先预览配分/)).toBeVisible();
  await expect(dialog.getByRole('button',{name:'预览题目与配分',exact:true})).toBeVisible();
  await expect(dialog.getByRole('button',{name:'开始考试',exact:true})).toBeHidden();
  await chooseOption(dialog.getByRole('combobox',{name:/^模式/}), 'mock_exam');
  await expect(dialog.getByText('到时自动交卷，关闭应用仍会计时。',{exact:true})).toBeVisible();
  await expect(dialog.getByRole('button',{name:'预览题目与配分',exact:true})).toBeEnabled();
  await dialog.getByText('高级设置 · 题库、筛选与选题方式',{exact:true}).click();
  await expect(dialog.getByRole('combobox',{name:'选题方式',exact:true})).toBeVisible();
  const geometry=await dialog.locator('[data-slot="native-select"], [data-slot="select-trigger"]').evaluateAll(nodes=>nodes.map(node=>{
   const select=node.getBoundingClientRect(), wrapper=node.parentElement.getBoundingClientRect();
   const icon=node.parentElement.querySelector('[data-slot="select-icon"]').getBoundingClientRect();
   const style=getComputedStyle(node);
   return {alignment:style.alignItems,wrapperGap:wrapper.height-select.height,iconOffset:Math.abs(icon.y+icon.height/2-select.y-select.height/2),paddingTop:style.paddingTop,paddingBottom:style.paddingBottom,height:select.height};
  }));
  for(const control of geometry) {
   expect(control.alignment).toBe('center');
   expect(Math.abs(control.wrapperGap)).toBeLessThanOrEqual(1);
   expect(control.iconOffset).toBeLessThanOrEqual(1);
   expect(control.paddingTop).toBe(control.paddingBottom);
   expect(control.height).toBe(width===390?48:40);
  }
  await dialog.getByText('高级设置 · 题库、筛选与选题方式',{exact:true}).click();
  await dialog.locator('.overflow-y-auto').evaluate(node=>{node.scrollTop=0;});
  await page.screenshot({path:testInfo.outputPath(`exam-rules-${width}.png`),fullPage:true,animations:'disabled'});
  await dialog.getByRole('button',{name:'取消',exact:true}).click();
  if(width===390) await page.getByRole('button',{name:'打开主导航',exact:true}).click();
  await page.getByRole('button',{name:'设置',exact:true}).click();
  const details=page.getByText('备份范围与注意事项',{exact:true});
  await expect(page.getByText('备份题库与学习记录，不含访问令牌。',{exact:true})).toBeVisible();
  await expect(page.getByText(/不包含原始文档、AI 任务及服务访问令牌/)).toBeHidden();
  await details.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(/不包含原始文档、AI 任务及服务访问令牌/)).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByText(/不包含原始文档、AI 任务及服务访问令牌/)).toBeHidden();
 }
});

test('preview question filters preserve imported warnings through review confirmation',async ({page})=>{
 await page.goto('/');
 await page.getByRole('button',{name:'查看题目',exact:true}).first().click();
 const type=page.getByLabel('筛选题型');
 await chooseOption(type, 'single');
 await expect(page.getByRole('button',{name:/下面哪一个是质数？/})).toBeVisible();
 await expect(page.getByRole('button',{name:/请选择偶数。/})).toBeHidden();
 await chooseOption(type, 'multiple');
 await expect(page.getByRole('button',{name:/请选择偶数。/})).toBeVisible();
 await expect(page.getByRole('button',{name:/下面哪一个是质数？/})).toBeHidden();
 await chooseOption(type, '');
 await page.getByRole('checkbox',{name:'仅看待复核',exact:true}).check();
 const question=page.getByRole('button',{name:/观察 PractiQ 图标，描述你的印象。/});
 await question.click();
 const dialog=page.getByRole('dialog',{name:'题目详情',exact:true});
 await dialog.getByRole('button',{name:'标记已复核',exact:true}).click();
 await expect(dialog.getByRole('button',{name:'撤销复核确认',exact:true})).toBeVisible();
 const stored=await page.evaluate(async()=>{
  const {invoke}=await import('/src/transport.ts');
  return invoke('request',{request:{type:'question_detail',id:'0-q8'}});
 });
 expect(stored.question.needsReview).toBe(true);
 expect(stored.reviewedAt).toBeGreaterThan(0);
 expect(stored.warnings).toEqual(['原文未提供参考答案，请人工确认。']);
 await page.keyboard.press('Escape');
 await expect(question).toBeHidden();
 await page.getByRole('checkbox',{name:'仅看待复核',exact:true}).uncheck();
 await question.click();
 await dialog.getByRole('button',{name:'撤销复核确认',exact:true}).click();
 await page.keyboard.press('Escape');
 await page.getByRole('checkbox',{name:'仅看待复核',exact:true}).check();
 await expect(question).toBeVisible();
});

for (const kind of ['bank','question']) {
 test(`${kind} editor protects drafts from implicit dismissal`,async ({page})=>{
  await page.goto('/');
  await expect(page.getByText('基础知识 · 全题型',{exact:true}).first()).toBeVisible();
  const bankTitle='基础知识 · 全题型';
  if(kind==='question')await page.getByRole('button',{name:'查看题目',exact:true}).first().click();
  const title=kind==='bank'?'编辑题库':'编辑题目';
  const fieldName=kind==='bank'?'题库名称':'题干（支持 Markdown 和公式）';
  const open=async()=>{
   if(kind==='bank'){
    await page.getByRole('button',{name:`题库操作 ${bankTitle}`,exact:true}).click();
    await page.getByRole('menuitem',{name:title,exact:true}).click();
   }else await editQuestion(page, page.getByRole('button',{name:/^题目更多操作/}).first());
   await expect(page.getByRole('dialog',{name:title,exact:true})).toBeVisible();
  };
  const dismiss=async action=>{
   if(action==='Escape')await page.keyboard.press('Escape');
   else if(action==='close')await page.getByRole('dialog',{name:title,exact:true}).getByRole('button',{name:'关闭',exact:true}).click();
   else await page.mouse.click(8,8);
  };
  const actions=['Escape','close','outside'];
  for(const action of actions){
   await open();
   await dismiss(action);
   await expect(page.getByRole('dialog',{name:title,exact:true})).toBeHidden();
   await expect(page.getByRole('alertdialog')).toHaveCount(0);
  }
  await open();
  const editor=page.getByRole('dialog',{name:title,exact:true});
  const field=editor.getByRole('textbox',{name:fieldName,exact:true});
  const original=await field.inputValue();
  await field.fill(`${original} draft`);
  for(const action of actions){
   await field.focus();
   await dismiss(action);
   const confirmation=page.getByRole('alertdialog',{name:'放弃未保存的更改？',exact:true});
   await expect(confirmation).toBeVisible();
   const resume=confirmation.getByRole('button',{name:'继续编辑',exact:true});
   await expect(resume).toBeFocused();
   await resume.click();
   await expect(confirmation).toBeHidden();
   await expect(field).toHaveValue(`${original} draft`);
   await expect(action==='close'?editor.getByRole('button',{name:'关闭',exact:true}):field).toBeFocused();
  }
  await editor.getByRole('button',{name:'放弃更改',exact:true}).click();
  if(kind==='bank')await page.getByRole('alertdialog').getByRole('button',{name:'放弃更改',exact:true}).click();
  await expect(editor).toBeHidden();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await open();
  await expect(field).toHaveValue(original);
  await field.fill(`${original} saved`);
  await editor.getByRole('button',{name:kind==='bank'?'保存题库':'保存题目',exact:true}).click();
  await expect(editor).toBeHidden();
  if(kind==='bank'){
   await page.getByRole('button',{name:`题库操作 ${original} saved`,exact:true}).click();
   await page.getByRole('menuitem',{name:title,exact:true}).click();
  }else{
   const row=page.getByRole('button',{name:new RegExp(`${original} saved`)}).locator('..');
   await editQuestion(page, row.getByRole('button',{name:/^题目更多操作/}));
  }
  await expect(field).toHaveValue(`${original} saved`);
  await page.keyboard.press('Escape');
  await expect(editor).toBeHidden();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
 });
}

test('new question reverted nullable fields close without discarding other edits',async ({page})=>{
 await page.goto('/');
 await page.getByRole('button',{name:'查看题目',exact:true}).first().click();
 const editor=page.getByRole('dialog',{name:/^(编辑题目|新增题目)$/,exact:true});
 const instructions=editor.getByRole('textbox',{name:'作答说明',exact:true});
 const open=()=>page.getByRole('button',{name:'新增题目',exact:true}).click();
 for(const action of ['Escape','close','outside']){
  await open();
  await instructions.fill('Temporary instructions');
  await instructions.fill('');
  if(action==='Escape')await page.keyboard.press('Escape');
  else if(action==='close')await editor.getByRole('button',{name:'关闭',exact:true}).click();
  else await page.mouse.click(8,8);
  await expect(editor).toBeHidden();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
 }
 await open();
 await instructions.fill('Temporary instructions');
 await instructions.fill('');
 const stem=editor.getByRole('textbox',{name:'题干（支持 Markdown 和公式）',exact:true});
 await stem.fill('Actual changed stem');
 await page.keyboard.press('Escape');
 const confirmation=page.getByRole('alertdialog',{name:'放弃未保存的更改？',exact:true});
 await expect(confirmation).toBeVisible();
 await confirmation.getByRole('button',{name:'继续编辑',exact:true}).click();
 await expect(stem).toHaveValue('Actual changed stem');
 await expect(stem).toBeFocused();
 await editor.getByRole('button',{name:'放弃更改',exact:true}).click();
 await expect(editor).toBeHidden();
});

test('reverted empty reference answers close without losing real editor changes',async ({page})=>{
 await page.goto('/');
 await page.getByRole('button',{name:'查看题目',exact:true}).first().click();
 const editor=page.getByRole('dialog',{name:/^(编辑题目|新增题目)$/,exact:true});
 const open=()=>page.getByRole('button',{name:'新增题目',exact:true}).click();
 for(const mode of ['short_answer','choice','fill_blank']){
  for(const action of ['Escape','close','outside']){
   await open();
   if(mode!=='choice')await chooseOption(editor.getByLabel('答题方式',{exact:true}), mode);
   else {
    await chooseOption(editor.getByLabel('选择题类型',{exact:true}), 'multiple');
    await editor.getByRole('textbox',{name:'选项 1 内容',exact:true}).fill('One');
    await editor.getByRole('textbox',{name:'选项 2 内容',exact:true}).fill('Two');
   }
   // Save the mode first so the reopened reference starts null with no other draft.
   await editor.getByRole('textbox',{name:'题干（支持 Markdown 和公式）',exact:true}).fill(`Empty reference ${mode} ${action}`);
   await editor.getByRole('button',{name:'保存题目',exact:true}).click();
   const row=page.getByRole('button',{name:new RegExp(`^Empty reference ${mode} ${action}`)}).locator('..');
   // Development overlays can cover appended rows; reopen with the keyboard.
   await editQuestion(page, row.getByRole('button',{name:/^题目更多操作/}));
   if(mode==='choice'){
    const choice=editor.getByRole('checkbox',{name:/A\./});
    await choice.check();await choice.uncheck();
   }else{
    const text=editor.getByRole('textbox',{name:mode==='short_answer'?'作答内容':'第 1 空',exact:true});
    await text.fill('Temporary reference');await text.fill('');
   }
   if(action==='Escape')await page.keyboard.press('Escape');
   else if(action==='close')await editor.getByRole('button',{name:'关闭',exact:true}).click();
   else await page.mouse.click(8,8);
   await expect(editor).toBeHidden();
   await expect(page.getByRole('alertdialog')).toHaveCount(0);
  }
 }
 const changedRow=page.getByRole('button',{name:/^Empty reference fill_blank outside/}).locator('..');
 await editQuestion(page, changedRow.getByRole('button',{name:/^题目更多操作/}));
 const answer=editor.getByRole('textbox',{name:'第 1 空',exact:true});
 await answer.fill('Real reference');
 await page.keyboard.press('Escape');
 const confirmation=page.getByRole('alertdialog',{name:'放弃未保存的更改？',exact:true});
 await expect(confirmation).toBeVisible();
 await confirmation.getByRole('button',{name:'继续编辑',exact:true}).click();
 await expect(answer).toHaveValue('Real reference');
 await editor.getByRole('button',{name:'保存题目',exact:true}).click();
 await editQuestion(page, changedRow.getByRole('button',{name:/^题目更多操作/}));
 await expect(answer).toHaveValue('Real reference');
 await page.keyboard.press('Escape');
 await expect(editor).toBeHidden();
});

test('incomplete question reference fallbacks close after reverting text and keep real edits',async ({page})=>{
 await page.goto('/');
 await page.getByRole('button',{name:'查看题目',exact:true}).first().click();
 const editor=page.getByRole('dialog',{name:/^(编辑题目|新增题目)$/,exact:true});
 for(const mode of ['choice','ordering','matching']){
  await page.getByRole('button',{name:'新增题目',exact:true}).click();
  if(mode!=='choice')await chooseOption(editor.getByRole('combobox',{name:'答题方式',exact:true}), mode);
  const title=`Incomplete ${mode} reference`;
  await editor.getByRole('textbox',{name:'题干（支持 Markdown 和公式）',exact:true}).fill(title);
  await editor.getByRole('button',{name:'保存题目',exact:true}).click();
  const open=async()=>{
   const button=page.getByRole('button',{name:new RegExp(`^${title}`)}).locator('..').getByRole('button',{name:/^题目更多操作/});
   await button.evaluate(node=>node.scrollIntoView({block:'center'}));
   await page.mouse.move(0,0);
   await expect(page.getByText('题目已保存，历史练习不受影响',{exact:true})).toBeHidden();
   await editQuestion(page, button);
  };
  for(const dismiss of ['Escape','close','outside']){
   await open();
   const text=editor.getByRole('textbox',{name:'自由作答',exact:true});
   await text.fill('Temporary reference');await text.fill('');
   if(dismiss==='Escape')await page.keyboard.press('Escape');
   else if(dismiss==='close')await editor.getByRole('button',{name:'关闭',exact:true}).click();
   else await page.mouse.click(8,8);
   await expect(editor).toBeHidden();
   await expect(page.getByRole('alertdialog')).toHaveCount(0);
  }
  await open();
  const text=editor.getByRole('textbox',{name:'自由作答',exact:true});
  await text.fill('Actual reference');
  await page.keyboard.press('Escape');
  const confirmation=page.getByRole('alertdialog',{name:'放弃未保存的更改？',exact:true});
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button',{name:'继续编辑',exact:true}).click();
  await expect(text).toHaveValue('Actual reference');
  await editor.getByRole('button',{name:'保存题目',exact:true}).click();
  await open();
  await expect(text).toHaveValue('Actual reference');
  await text.fill('');
  await page.keyboard.press('Escape');
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button',{name:'继续编辑',exact:true}).click();
  await editor.getByRole('button',{name:'放弃更改',exact:true}).click();
 }
});

test('listening URL drafts survive every implicit dismissal without triggering downloads',async ({page})=>{
 const remoteRequests=[];
 page.on('request',request=>{if(request.url().startsWith('https://example.com/'))remoteRequests.push(request.url());});
 await page.goto('/');
 const bank=page.locator('[data-slot=card]').filter({has:page.getByText('英语专项 · 听力与写作',{exact:true})});
 await bank.getByRole('button',{name:'查看题目',exact:true}).click();
 const open=()=>editQuestion(page, page.getByRole('button',{name:/^Listening — chimes/}).locator('..').getByRole('button',{name:/^题目更多操作/}));
 const editor=page.getByRole('dialog',{name:/^(编辑题目|新增题目)$/,exact:true});
 const input=editor.getByRole('textbox',{name:'听力资源网址',exact:true});
 await open();
 const url='https://example.com/unapplied.wav';
 await input.fill(url);
 await expect(editor.getByRole('button',{name:'保存题目',exact:true})).toBeDisabled();
 await expect(editor.getByRole('status').filter({hasText:'网址尚未应用'})).toBeVisible();
 for(const action of ['Escape','close','outside']){
  await input.focus();
  if(action==='Escape')await page.keyboard.press('Escape');
  else if(action==='close')await editor.getByRole('button',{name:'关闭',exact:true}).click();
  else await page.mouse.click(8,8);
  const confirmation=page.getByRole('alertdialog',{name:'放弃未保存的更改？',exact:true});
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button',{name:'继续编辑',exact:true}).click();
  await expect(confirmation).toBeHidden();
  await expect(input).toHaveValue(url);
  await expect(action==='close'?editor.getByRole('button',{name:'关闭',exact:true}):input).toBeFocused();
 }
 await input.fill('');
 await expect(editor.getByRole('button',{name:'保存题目',exact:true})).toBeEnabled();
 await page.keyboard.press('Escape');
 await expect(editor).toBeHidden();
 await expect(page.getByRole('alertdialog')).toHaveCount(0);
 await open();
 await editor.getByRole('button',{name:'识别二维码图片',exact:true}).click();
 await expect(input).toHaveValue('https://example.com/listening.mp3');
 await page.keyboard.press('Escape');
 const confirmation=page.getByRole('alertdialog',{name:'放弃未保存的更改？',exact:true});
 await expect(confirmation).toBeVisible();
 await confirmation.getByRole('button',{name:'继续编辑',exact:true}).click();
 await expect(input).toHaveValue('https://example.com/listening.mp3');
 await editor.getByRole('button',{name:'放弃更改',exact:true}).click();
 await expect(editor).toBeHidden();
 expect(remoteRequests).toEqual([]);
});

test('applied listening URLs become guarded when their audio is removed or replaced',async ({page})=>{
 const remoteRequests=[];
 page.on('request',request=>{if(request.url().startsWith('https://example.com/'))remoteRequests.push(request.url());});
 await page.goto('/');
 const bank=page.locator('[data-slot=card]').filter({has:page.getByText('英语专项 · 听力与写作',{exact:true})});
 await bank.getByRole('button',{name:'查看题目',exact:true}).click();
 const editor=page.getByRole('dialog',{name:/^(编辑题目|新增题目)$/,exact:true});
 const input=editor.getByRole('textbox',{name:'听力资源网址',exact:true});
 const save=editor.getByRole('button',{name:'保存题目',exact:true});
 const confirmation=page.getByRole('alertdialog',{name:'放弃未保存的更改？',exact:true});
 for(const action of ['remove','mode','file']){
  await editQuestion(page, page.getByRole('button',{name:/^Listening — chimes/}).locator('..').getByRole('button',{name:/^题目更多操作/}));
  const url=`https://example.com/${action}.wav`;
  await input.fill(url);
  await editor.getByRole('button',{name:'从网址获取音频',exact:true}).click();
  await expect(save).toBeEnabled();
  if(action==='remove')await editor.getByRole('button',{name:'移除音频',exact:true}).click();
  else if(action==='mode'){
   await chooseOption(editor.getByRole('combobox',{name:'答题方式',exact:true}), 'short_answer');
   await chooseOption(editor.getByRole('combobox',{name:'答题方式',exact:true}), 'listening');
  }else await editor.getByRole('button',{name:'选择听力音频',exact:true}).click();
  await expect(save).toBeDisabled();
  await expect(input).toHaveValue(url);
  await expect(editor.getByRole('status').filter({hasText:'网址尚未应用'})).toBeVisible();
  for(const dismiss of ['Escape','close','outside']){
   await input.focus();
   if(dismiss==='Escape')await page.keyboard.press('Escape');
   else if(dismiss==='close')await editor.getByRole('button',{name:'关闭',exact:true}).click();
   else await page.mouse.click(8,8);
   await expect(confirmation).toBeVisible();
   await confirmation.getByRole('button',{name:'继续编辑',exact:true}).click();
   await expect(input).toHaveValue(url);
   await expect(save).toBeDisabled();
  }
  await input.fill('');
  await expect(save).toBeEnabled();
  await editor.getByRole('button',{name:'放弃更改',exact:true}).click();
  await expect(editor).toBeHidden();
 }
 expect(remoteRequests).toEqual([]);
});

test('child editors retain changed drafts and stage changes until the parent saves',async ({page})=>{
 await page.goto('/');
 const bank=page.locator('[data-slot=card]').filter({has:page.getByText('阅读与组合题',{exact:true})});
 await bank.getByRole('button',{name:'查看题目',exact:true}).click();
 const openRoot=()=>editQuestion(page, page.getByRole('button',{name:/^words-root/}).locator('..').getByRole('button',{name:/^题目更多操作/}));
 const editor=page.getByRole('dialog',{name:/^(编辑题目|新增题目)$/,exact:true});
 const field=editor.getByRole('textbox',{name:'题干（支持 Markdown 和公式）',exact:true});
 await openRoot();
 await editor.getByText('1. words-root1',{exact:true}).locator('..').getByRole('button',{name:'编辑题目',exact:true}).click();
 await expect(field).toHaveValue('words-root1');
 await field.fill('Changed child draft');
 for(const action of ['Escape','close','outside']){
  if(action==='Escape')await page.keyboard.press('Escape');
  else if(action==='close')await editor.getByRole('button',{name:'关闭',exact:true}).click();
  else await page.mouse.click(8,8);
  const confirmation=page.getByRole('alertdialog',{name:'放弃未保存的更改？',exact:true});
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button',{name:'继续编辑',exact:true}).click();
  await expect(field).toHaveValue('Changed child draft');
 }
 await editor.getByRole('button',{name:'放弃更改',exact:true}).click();
 await expect(field).toHaveValue('words-root');
 await expect(editor.getByText('1. words-root1',{exact:true})).toBeVisible();
 await page.keyboard.press('Escape');
 await expect(editor).toBeHidden();
 await expect(page.getByRole('alertdialog')).toHaveCount(0);
 await openRoot();
 await editor.getByText('1. words-root1',{exact:true}).locator('..').getByRole('button',{name:'编辑题目',exact:true}).click();
 await field.fill('Saved child draft');
 await editor.getByRole('button',{name:'保存题目',exact:true}).click();
 await expect(editor.getByText('1. Saved child draft',{exact:true})).toBeVisible();
 await page.keyboard.press('Escape');
 const confirmation=page.getByRole('alertdialog',{name:'放弃未保存的更改？',exact:true});
 await expect(confirmation).toBeVisible();
 await confirmation.getByRole('button',{name:'继续编辑',exact:true}).click();
 await editor.getByRole('button',{name:'保存题目',exact:true}).click();
 await expect(editor).toBeHidden();
 await openRoot();
 await expect(editor.getByText('1. Saved child draft',{exact:true})).toBeVisible();
 await expect(editor.getByText('2. words-root2',{exact:true})).toBeVisible();
 await page.keyboard.press('Escape');
 await expect(editor).toBeHidden();
 await expect(page.getByRole('alertdialog')).toHaveCount(0);
});

test('preview nested word-bank answers use inherited choices offline',async ({page})=>{
 await page.goto('/');
 await page.getByRole('button',{name:'开始练习',exact:true}).nth(2).click();
 await chooseOption(page.getByLabel('出题顺序',{exact:true}), 'ordered');
 await page.getByText('高级设置 · 题库、筛选与选题方式',{exact:true}).click();
 await chooseOption(page.getByRole('combobox',{name:'题型',exact:true}), 'reading');
 await expect(page.getByRole('status').filter({hasText:'可用 6 题'})).toBeVisible();
 await page.getByRole('spinbutton',{name:'题目数量',exact:true}).fill('6');
 await page.getByRole('button',{name:'立即开始',exact:true}).click();
 await page.getByRole('region',{name:'答题卡',exact:true}).getByRole('button',{name:/^转到第 3 题，未作答/}).click();
 await expect(page.getByRole('heading',{name:'第 3 / 6 题',exact:true})).toBeVisible();
 const choices=page.getByRole('radiogroup',{name:'选择答案',exact:true});
 await expect(choices.getByRole('radio')).toHaveCount(2);
 await expect(page.getByLabel('自由作答',{exact:true})).toBeHidden();
 await choices.getByRole('radio').first().check();
 await page.getByRole('button',{name:'提交答案',exact:true}).click();
 await expect(page.getByRole('status',{name:'答题状态',exact:true})).toHaveText('第 3 题：回答正确');
});

test('preview inline material hides ancestor answer passage before submission',async ({page})=>{
 await page.goto('/');
 await page.evaluate(async()=>{
  const {invoke}=await import('/src/transport.ts');
  const {default:fixture}=await import('/fixtures/composite.json');
  const questions=structuredClone(fixture.questions);
  const root=questions.find(q=>q.id==='reading');
  root.passage.push({partType:'text',role:'prompt',textValue:'Visible preview material marker'});
  root.passage.push({partType:'text',role:'ANSWER key',textValue:'Hidden preview solution marker'});
  await invoke('request',{request:{type:'save_question_tree',root_id:'2-reading',bank_id:'preview-bank-2',questions}});
 });
 await page.getByRole('button',{name:'开始练习',exact:true}).nth(2).click();
 await chooseOption(page.getByLabel('出题顺序',{exact:true}), 'ordered');
 await page.getByText('高级设置 · 题库、筛选与选题方式',{exact:true}).click();
 await chooseOption(page.getByRole('combobox',{name:'题型',exact:true}), 'reading');
 await expect(page.getByRole('status').filter({hasText:'可用 6 题'})).toBeVisible();
 await page.getByRole('spinbutton',{name:'题目数量',exact:true}).fill('6');
 await page.getByRole('button',{name:'立即开始',exact:true}).click();
 await page.getByRole('region',{name:'答题卡',exact:true}).getByRole('button',{name:/^转到第 3 题，未作答/}).click();
 await page.getByRole('button',{name:'查看原文',exact:true}).click();
 const material=page.getByRole('region',{name:'题目材料',exact:true});
 await expect(material.getByText('Visible preview material marker',{exact:true})).toBeVisible();
 await expect(material.getByText('Hidden preview solution marker',{exact:true})).toBeHidden();
 const source=await page.evaluate(async()=>{
  const {invoke}=await import('/src/transport.ts');
  const result=await invoke('request',{request:{type:'questions_page',bank_ids:['preview-bank-2'],search:'',mode:'reading',filter:'',offset:0,limit:20}});
  const detail=await invoke('request',{request:{type:'question_detail',id:result.items[0].id}});
  return detail.question.passage;
 });
 expect(source.some(block=>block.textValue==='Hidden preview solution marker')).toBe(true);
});

for(const scenario of ['empty','many','unconfigured','missing','slow','error']) {
 test(`preview scenario ${scenario} stays offline`,async ({page})=>{
  await page.addInitScript(value=>sessionStorage.setItem('practiq-preview',value),scenario);
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'我的题库',exact:true})).toBeVisible();
  if(scenario==='empty') {
   await expect(page.getByText('从第一份题库开始',{exact:true})).toBeVisible();
   await page.getByRole('button',{name:'导入题库 ZIP',exact:true}).click();
   await expect(page.getByRole('menuitem',{name:'恢复学习数据备份',exact:true})).toBeVisible();
   await page.getByRole('menuitem',{name:'导入题库 ZIP',exact:true}).click();
   await expect(page.getByRole('dialog',{name:'导入题库',exact:true})).toBeVisible();
   await expect(page.getByRole('combobox',{name:'导入到',exact:true})).toHaveAttribute('data-value', 'new');
   await page.getByRole('button',{name:'取消',exact:true}).click();
   await expect(page.getByRole('heading',{name:'设置',exact:true})).toBeVisible();
  }
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
 await chooseOption(dialog.getByRole('combobox',{name:/^模式/}), 'mock_exam');
 await dialog.getByLabel('考试分钟数',{exact:true}).fill('45');
 await dialog.getByLabel('题目数量',{exact:true}).fill('10');
 await dialog.getByLabel('考试总分',{exact:true}).fill('90');
 await dialog.getByText('高级设置 · 题库、筛选与选题方式',{exact:true}).click();
 await chooseOption(dialog.getByRole('combobox',{name:/^选题方式/}), 'quota');
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
 await chooseOption(dialog.getByRole('combobox',{name:/^选题方式/}), 'manual');
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
 await chooseOption(dialog.getByRole('combobox',{name:/^选题方式/}), 'quota');
 await expect(dialog.getByLabel('简答题数',{exact:true})).toHaveValue('3');
 await chooseOption(dialog.getByRole('combobox',{name:/^选题方式/}), 'count');
 await expect(dialog.getByLabel('题目数量',{exact:true})).toHaveValue('10');
 const requests=await page.evaluate(()=>window.__studyRequests);
 const statsRequests=requests.filter(r=>r.type==='question_stats');
 const pageRequests=requests.filter(r=>r.type==='questions_page');
 expect(statsRequests).toHaveLength(2);
 expect(statsRequests[1]).toEqual(statsRequests[0]);
 expect(pageRequests[2]).toEqual(pageRequests[1]);
 expect(errors).toEqual([]);
});

for (const colorScheme of ['light','dark']) for (const width of [1280,390]) {
 base(`answer-card status markers match the legend and preserve keyboard navigation in ${colorScheme} theme at ${width}px`,async ({page},testInfo)=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.emulateMedia({colorScheme});
  await page.setViewportSize({width,height:844});
  await page.addInitScript(()=>{
   sessionStorage.setItem('practiq-preview','local');
   window.isTauri=false;
   const question={id:'q',parentId:null,passage:[],allowReuse:false,stem:'Answer-card status matrix',answerMode:'short_answer',questionTypeId:'简答题',choiceVariant:null,matchingVariant:null,options:[],items:[],answerPayload:{text:'Reference'},analysis:null,sourceText:null,contentBlocks:[],needsReview:false,missingFields:[],confidence:1};
   const snapshot={question,groups:[],visuals:[],sources:[],warnings:[],missingAssets:false};
   const partial={...snapshot,question:{...question,answerMode:'fill_blank',blankCount:2,answerPayload:{answers:['first','second']}}};
   const changes=[{}, {answer:{text:'Draft'},flagged:true}, {snapshot:partial,answer:{answers:['first','']}}, {answer:{text:'Submitted'},submittedAt:1}, {answer:{text:'Correct'},submittedAt:1,result:true}, {answer:{text:'Wrong'},submittedAt:1,result:false}, {submittedAt:1,skipped:true}, {snapshot:partial,answer:{answers:['First','second']},submittedAt:1,result:false,gradeKind:'auto'}];
   const session={id:'markers',title:'Status matrix',kind:'practice',createdAt:1,finishedAt:null,position:0,mode:'ordered',attempts:changes.map((change,ordinal)=>({ordinal,snapshot,answer:null,autoResult:null,result:null,gradeKind:'ungraded',submittedAt:null,skipped:false,elapsedMs:0,...change}))};
   const bank={id:'one',title:'Status matrix',description:'',count:8,createdAt:1};
   const questions=session.attempts.map(({snapshot},i)=>({...snapshot,id:String(i),bankId:'one',bankTitle:bank.title,favorite:false,latestResult:null}));
   window.__TAURI_INTERNALS__={invoke:async(command,{request})=>{
    if(command!=='request')throw Error(`Unexpected command ${command}`);
    switch(request.type){
     case 'language':return 'zh-CN';
     case 'banks':return [bank];
     case 'banks_page':return {items:[bank],total:1,offset:0};
     case 'unfinished_session':return null;
     case 'info':return {version:'markers',dataDirectory:'/mock'};
     case 'question_stats':return {count:8,types:{short_answer:6,fill_blank:2},feasibleCounts:[8]};
     case 'preview_paper':return {questionIds:questions.map(q=>q.id),digest:'markers',questions,scores:questions.map(()=>0),count:8};
     case 'start_paper':case 'session':return structuredClone(session);
     case 'position':session.position=request.position;return structuredClone(session);
     case 'save_draft':session.attempts[request.ordinal].answer=request.answer;return null;
     default:throw Error(`Unexpected request ${request.type}`);
    }
   }};
  });
  await page.goto('/');
  await page.getByRole('button',{name:'开始练习',exact:true}).click();
  await page.getByLabel('题目数量').fill('8');
  await page.getByRole('button',{name:'立即开始',exact:true}).click();
  const grid=page.getByRole('region',{name:'答题卡',exact:true});
  await expect(grid.getByRole('button')).toHaveCount(8);
  await expect(page.locator('html')).toHaveClass(colorScheme==='dark'?/dark/:/^(?!.*dark)/);
  const helpButton=page.getByRole('button',{name:'答题卡状态说明',exact:true});
  const help=page.getByRole('dialog',{name:'答题卡状态说明',exact:true});
  await expect(help).toBeHidden();
  await expect(helpButton).toHaveAttribute('aria-expanded','false');
  await helpButton.click();
  await expect(help).toBeVisible();
  const helpBounds=await help.boundingBox();
  expect(helpBounds.x).toBeGreaterThanOrEqual(0);
  expect(helpBounds.x+helpBounds.width).toBeLessThanOrEqual(width);
  expect(helpBounds.y).toBeGreaterThanOrEqual(0);
  expect(helpBounds.y+helpBounds.height).toBeLessThanOrEqual(844);
  await page.screenshot({path:testInfo.outputPath(`answer-card-help-${colorScheme}-${width}.png`)});
  await help.screenshot({path:testInfo.outputPath(`answer-card-popover-${colorScheme}-${width}.png`)});
  const matrix=[['未作答','circle','未作答','unanswered'],['已作答，未提交，待检查','pencil','已作答','answered'],['草稿未完成','pencil','草稿','draft'],['已提交，待判定','circle-dashed','待判定','pending'],['正确','check','正确','correct'],['错误','x','错误','incorrect'],['已跳过','skip-forward','跳过','skipped'],['文本不完全一致','x','错误','incorrect']];
  for(const [index,[label,marker,legend,status]] of matrix.entries()) {
   const button=grid.getByRole('button',{name:`转到第 ${index+1} 题，${label}`,exact:true});
   const icon=button.locator(`svg.lucide-${marker}`);
   await expect(button).toBeVisible();
   await expect(button).toHaveText(String(index+1));
   await expect(button).toHaveAttribute('data-answer-state',status);
   expect(await button.evaluate(node=>node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(width<768?48:40);
   await expect(icon).toBeVisible();
   await expect(icon).toHaveAttribute('aria-hidden','true');
   await expect(help.locator('p > span').filter({hasText:legend}).locator(`svg.lucide-${marker}`)).toBeVisible();
   const fits=await button.evaluate(element=>{const box=element.getBoundingClientRect();return [...element.children].every(child=>{const rect=child.getBoundingClientRect();return rect.left>=box.left&&rect.right<=box.right&&rect.top>=box.top&&rect.bottom<=box.bottom;});});
   expect(fits).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();
  await expect(helpButton).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(help).toBeVisible();
  await help.getByRole('button',{name:'关闭',exact:true}).click();
  await expect(help).toBeHidden();
  await helpButton.click();
  await page.getByText('答题卡',{exact:true}).click();
  await expect(help).toBeHidden();
  const current=grid.getByRole('button',{name:'转到第 1 题，未作答',exact:true});
  const colors=await grid.getByRole('button').evaluateAll(nodes=>{
   const context=document.createElement('canvas').getContext('2d',{willReadFrequently:true});
   const luminance=color=>{
    context.fillStyle=color;context.fillRect(0,0,1,1);
    const channels=[...context.getImageData(0,0,1,1).data].slice(0,3).map(value=>{const s=value/255;return s<=0.04045?s/12.92:((s+0.055)/1.055)**2.4;});
    return channels.reduce((sum,value,index)=>sum+value*[0.2126,0.7152,0.0722][index],0);
   };
   const contrast=(first,second)=>(Math.max(first,second)+0.05)/(Math.min(first,second)+0.05);
   return nodes.map(node=>{const style=getComputedStyle(node),background=luminance(style.backgroundColor);return {background:style.backgroundColor,text:contrast(luminance(style.color),background),border:contrast(luminance(style.borderColor),background)};});
  });
  expect(new Set(colors.slice(0,6).map(color=>color.background)).size).toBe(6);
  for(const color of colors){expect(color.text).toBeGreaterThanOrEqual(4.5);expect(color.border).toBeGreaterThanOrEqual(3);}
  await expect(current).toHaveAttribute('aria-current','step');
  await expect(current).toHaveCSS('text-decoration-line','underline');
  const flagged=grid.getByRole('button',{name:'转到第 2 题，已作答，未提交，待检查',exact:true});
  await expect(flagged.locator('svg.lucide-flag')).toBeVisible();
  const answerColor=await flagged.evaluate(node=>getComputedStyle(node).backgroundColor);
  await current.focus();
  await page.keyboard.press('Tab');
  await expect(flagged).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading',{name:'第 2 / 8 题',exact:true})).toBeFocused();
  await expect(flagged).toHaveAttribute('aria-current','step');
  await expect(flagged).toHaveCSS('outline-width','2px');
  await expect(flagged).toHaveCSS('outline-style','solid');
  await expect(flagged).toHaveCSS('background-color',answerColor);
  await expect(flagged.locator('svg.lucide-flag')).toBeVisible();
  await page.getByRole('button',{name:'定位当前题',exact:true}).focus();
  await page.keyboard.press('Enter');
  await expect(flagged).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.getByRole('heading',{name:'第 2 / 8 题',exact:true})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath(`answer-card-markers-${colorScheme}-${width}.png`)});
  await grid.locator('xpath=ancestor::*[@data-slot="card"][1]').screenshot({path:testInfo.outputPath(`answer-card-colors-${colorScheme}-${width}.png`)});
  expect(errors).toEqual([]);
 });
}

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

for (const reducedMotion of ['reduce', 'no-preference']) {
 test(`shared overlays honor ${reducedMotion} and restore keyboard focus`, async ({page}) => {
  await page.emulateMedia({reducedMotion});
  await page.goto('/');
  const expected = reducedMotion === 'reduce' ? 'none' : 'enter';
  const expectExitStyle = async slots => {
   const animations = await page.evaluate(slots => slots.map(slot => {
    const element = document.querySelector(`[data-slot="${slot}"]`);
    const state = element.getAttribute('data-state');
    // Conditional editor unmounts can bypass the exit animation; inspect the shared closed-state rule directly.
    element.setAttribute('data-state', 'closed');
    const animation = getComputedStyle(element).animationName;
    element.setAttribute('data-state', state);
    return animation;
   }), slots);
   expect(animations).toEqual(slots.map(() => reducedMotion === 'reduce' ? 'none' : 'exit'));
  };
  const theme = page.getByRole('button', {name:'主题', exact:true});
  await theme.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu', {name:'主题', exact:true})).toHaveCSS('animation-name', expected);
  await expectExitStyle(['dropdown-menu-content']);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  await expect(theme).toBeFocused();
  await page.getByRole('button', {name:'查看题目', exact:true}).first().click();
  const add = page.getByRole('button', {name:'新增题目', exact:true});
  await add.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveCSS('animation-name', expected);
  await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCSS('animation-name', expected);
  await expect(dialog).toContainText('新增题目');
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await expectExitStyle(['dialog-content', 'dialog-overlay']);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(add).toBeFocused();
  await page.getByRole('button', {name:'我的题库', exact:true}).click();
  await page.getByRole('button', {name:'开始练习', exact:true}).first().click();
  await page.getByRole('button', {name:'立即开始', exact:true}).click();
  const finish = page.getByRole('button', {name:'结束练习', exact:true});
  await finish.scrollIntoViewIfNeeded();
  await finish.focus();
  await page.keyboard.press('Enter');
  const alert = page.getByRole('alertdialog');
  await expect(alert).toHaveCSS('animation-name', expected);
  await expect(page.locator('[data-slot="alert-dialog-overlay"]')).toHaveCSS('animation-name', expected);
  await expect(alert.getByRole('button', {name:'继续作答', exact:true})).toBeFocused();
  await expectExitStyle(['alert-dialog-content', 'alert-dialog-overlay']);
  await page.keyboard.press('Escape');
  await expect(alert).toBeHidden();
  await expect(finish).toBeFocused();
 });
}

for (const width of [360, 390, 1280]) {
 base(`study setup separates settings from live score review at ${width}px`, async ({page}, testInfo) => {
  await page.setViewportSize({width,height:850});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto('/');
  await page.locator('.bank-card').first().getByRole('button',{name:'开始练习',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await chooseOption(dialog.getByRole('combobox',{name:/^模式/}), 'mock_exam');
  await dialog.getByLabel('考试分钟数',{exact:true}).fill('45');
  await expect(dialog.getByRole('group',{name:'快捷题数'})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath(`setup-${width}.png`)});
  await dialog.getByRole('button',{name:'预览题目与配分',exact:true}).click();
  await expect(dialog.getByRole('heading',{name:'检查题目与配分'})).toBeFocused();
  await expect(dialog.getByRole('combobox',{name:/^模式/})).toBeHidden();
  await expect(dialog.getByText('已分配 100 / 目标 100 分',{exact:true})).toBeVisible();
  await dialog.getByRole('button',{name:'第 1 题分值',exact:true}).click();
  await dialog.getByRole('textbox',{name:'第 1 题分值',exact:true}).fill('0');
  await page.screenshot({path:testInfo.outputPath(`scores-${width}.png`)});
  await dialog.getByRole('button',{name:'返回设置',exact:true}).click();
  await expect(dialog.getByLabel('考试分钟数',{exact:true})).toHaveValue('45');
  await dialog.getByRole('button',{name:'查看配分',exact:true}).click();
  await expect(dialog.getByRole('button',{name:'第 1 题分值',exact:true})).toHaveText('0 分');
  const box=await dialog.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x+box.width).toBeLessThanOrEqual(width);
  expect(box.y+box.height).toBeLessThanOrEqual(851);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 });
}
