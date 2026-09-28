import { chromium } from 'playwright';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
const server=await createServer({server:{host:'127.0.0.1',port:0}});
await server.listen();
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:1280,height:900},locale:"zh-CN"});
 page.setDefaultTimeout(10000);
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=> {window.__previewNativeCalls=0;window.__TAURI_INTERNALS__={invoke:()=>{window.__previewNativeCalls++;throw new Error('Unexpected native IPC in preview');}};});
 await page.goto(server.resolvedUrls.local[0]);
 await page.getByText('基础知识 · 全题型',{exact:true}).first().waitFor();
 await page.getByRole('button',{name:'查看题目',exact:true}).first().click();
 await page.getByText('下面哪一个是质数？',{exact:true}).first().waitFor();
 await page.getByRole('button',{name:'我的题库',exact:true}).click();
 await page.getByRole('button',{name:'开始练习',exact:true}).first().click();
 await page.getByRole('button',{name:'立即开始',exact:true}).click();
 await page.getByText('下面哪一个是质数？',{exact:true}).first().waitFor();
 for(const name of ['错题本','收藏夹','练习记录','导入题库','设置']) {
   await page.getByRole('button',{name,exact:true}).first().click();
   await page.waitForTimeout(250);
   assert.equal(await page.locator('main').count(),1);
 }
 await page.getByRole('button',{name:'练习记录',exact:true}).click();
 await page.getByRole('button',{name:'继续练习',exact:true}).first().click();
 await page.getByText('下面哪一个是质数？',{exact:true}).first().waitFor();
 await page.getByRole('button',{name:'导入题库',exact:true}).click();
 await page.getByRole('tab',{name:'导入记录',exact:true}).click();
 await page.getByRole('button',{name:'线性代数 · 矩阵',exact:true}).click();
 await page.getByRole('button',{name:'查看内容与审核',exact:true}).click();
 await page.getByText(/可查看 9 道题目/).waitFor();
 await page.waitForTimeout(300);
 await page.screenshot({path:'/tmp/practiq-preview.png',fullPage:true});
 assert.deepEqual(errors,[]);
 assert.equal(await page.evaluate(()=>window.__previewNativeCalls),0);
 for(const scenario of ['empty','many','unconfigured','missing','slow','error']) {
   await page.evaluate(value=>sessionStorage.setItem('practiq-preview',value),scenario);
   await page.reload();
   await page.waitForTimeout(scenario==='slow' ? 2200 : 500);
   assert.equal(await page.evaluate(()=>window.__previewNativeCalls),0);
   await page.getByRole('button',{name:'设置',exact:true}).click();
   await page.waitForTimeout(scenario==='slow' ? 2200 : 300);
 }
 assert.deepEqual(errors,[]);
 assert.equal(await page.evaluate(()=>window.__previewNativeCalls),0);
 console.log('Development preview pages and scenarios passed without native IPC.');
} finally {await browser.close();await server.close();}
