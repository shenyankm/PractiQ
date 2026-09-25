// Requires Vite on port 1420. Optional first argument: installed Playwright module path.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.argv[2] || 'playwright');
const browser = await chromium.launch({headless: true, channel: "chrome"});
try {
  const page = await browser.newPage({viewport:{width:1280,height:850},locale:"zh-CN"});
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const fontRequests = [];
  page.on('request', r => { if (r.resourceType() === 'font') fontRequests.push(r.url()); });
  await page.goto('http://127.0.0.1:1420/fixtures/rich-content/');
  const zoom = page.getByRole('button',{name:'放大查看图片'});
  await zoom.waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert(fontRequests.length > 0 && fontRequests.every(url => new URL(url).pathname.endsWith('.woff2')));
  assert(await page.evaluate(() => [...document.fonts].filter(f => f.family.startsWith('KaTeX')).every(f => f.status !== 'error')));
  assert.equal(await page.locator('.katex-error').count(),0);
  assert.equal(await page.locator('.katex-display').count(),3);
  assert.equal(await page.locator('table td').count(),12);
  // A .katex node alone misses incompatible renderer/CSS versions: fractions overlap.
  const scale = await page.locator('.katex-display .sizing.reset-size6.size3').first().evaluate(el =>
    parseFloat(getComputedStyle(el).fontSize) / parseFloat(getComputedStyle(el.closest('.katex')).fontSize));
  assert(Math.abs(scale - 0.7) < 0.01, `fraction font scale ${scale}, expected 0.7`);
  assert(await page.locator('figure img').evaluate(img => img.complete && img.naturalWidth > 0));
  for (const width of [1280,960]) {
    await page.setViewportSize({width,height:850});
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),`overflow at ${width}`);
  }
  await zoom.click();
  await page.getByRole('dialog').waitFor();
  assert(await page.getByRole('dialog').locator('img').evaluate(img => img.complete && img.naturalWidth > 0));
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({state:'hidden'});
  assert(await zoom.evaluate(el => el === document.activeElement));
  await page.setViewportSize({width:1280,height:850});
  await mkdir('reports/rich-content',{recursive:true});
  await page.screenshot({path:'reports/rich-content/desktop.png',fullPage:true});
  if (process.argv.includes('--generate-pdf')) {
    await zoom.evaluate(el => el.style.display='none');
    await page.pdf({path:'fixtures/rich-content/source.pdf',format:'A4',printBackground:true,margin:{top:'12mm',bottom:'12mm',left:'12mm',right:'12mm'}});
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: math, table, image decoding, 960/1280px layout, zoom and keyboard focus.');
} finally { await browser.close(); }
