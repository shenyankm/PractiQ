import { test as base, expect } from 'playwright/test';

const test=base.extend({page:async ({page},use)=>{
 const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.__previewNativeCalls=0;window.__TAURI_INTERNALS__={invoke:()=>{window.__previewNativeCalls++;throw new Error('Unexpected native IPC in preview');}};});
 await use(page);
 expect(errors).toEqual([]);
 expect(await page.evaluate(()=>window.__previewNativeCalls)).toBe(0);
}});

test('development preview pages stay offline',async ({page},testInfo)=>{
 await page.goto('/');
 await expect(page.getByText('基础知识 · 全题型',{exact:true}).first()).toBeVisible();
 await page.getByRole('button',{name:'查看题目',exact:true}).first().click();
 await expect(page.getByText('下面哪一个是质数？',{exact:true}).first()).toBeVisible();
 await page.getByRole('button',{name:'我的题库',exact:true}).click();
 await page.getByRole('button',{name:'开始练习',exact:true}).first().click();
 await page.getByRole('button',{name:'立即开始',exact:true}).click();
 await expect(page.getByText('下面哪一个是质数？',{exact:true}).first()).toBeVisible();
 for(const name of ['错题本','收藏夹','练习记录','导入题库','设置']) {
  await page.getByRole('button',{name,exact:true}).first().click();
  await expect(page.getByRole('heading',{name,exact:true})).toBeVisible();
 }
 await page.getByRole('button',{name:'练习记录',exact:true}).click();
 await page.getByRole('button',{name:'继续练习',exact:true}).first().click();
 await expect(page.getByText('下面哪一个是质数？',{exact:true}).first()).toBeVisible();
 await page.getByRole('button',{name:'导入题库',exact:true}).click();
 await page.getByRole('tab',{name:'导入记录',exact:true}).click();
 await page.getByRole('button',{name:'线性代数 · 矩阵',exact:true}).click();
 await page.getByRole('button',{name:'查看内容与审核',exact:true}).click();
 await expect(page.getByText(/可查看 9 道题目/)).toBeVisible();
 await page.screenshot({path:testInfo.outputPath('preview.png'),fullPage:true});
});

for(const scenario of ['empty','many','unconfigured','missing','slow','error']) {
 test(`preview scenario ${scenario} stays offline`,async ({page})=>{
  await page.addInitScript(value=>sessionStorage.setItem('practiq-preview',value),scenario);
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'我的题库',exact:true})).toBeVisible();
  if(scenario==='empty') await expect(page.getByText('从第一份题库开始',{exact:true})).toBeVisible();
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
