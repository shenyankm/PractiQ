import { chooseOption } from "../../shared/select-test.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "playwright/test";

const output = new URL("../.build/design-preview/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const report = { screenshots: [], errors: [], checks: [] };
const appURL = process.env.PRACTIQ_APP_PREVIEW_URL ?? "http://127.0.0.1:1426";

async function capture(page, name) {
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByText("加载中…", { exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo(0, 0);
    document.querySelector(".app-content")?.scrollTo(0, 0);
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  const dark = name.includes("-dark-");
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(dark);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--primary").trim())).toBe(dark ? "#d9b5e5" : "#795088");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), { message: `${name}: document overflow` }).toBe(true);
  const content = page.locator(".app-content");
  if (await content.count()) await expect.poll(() => content.evaluate(node => node.scrollWidth <= node.clientWidth), { message: `${name}: content overflow` }).toBe(true);
  const defects = await page.locator('[data-slot="input"], [data-slot="input-group"], [data-slot="select-trigger"], select, [data-slot="button"]:not([data-size^="icon"])').evaluateAll(nodes => {
    const minimum = matchMedia('(max-width: 767px), (any-pointer: coarse)').matches ? 48 : 40;
    return nodes.filter(node => node.getClientRects().length && node.getBoundingClientRect().height < minimum - 1).map(node => ({ name: node.getAttribute('aria-label') || node.textContent, height: node.getBoundingClientRect().height }));
  });
  assert.deepEqual(defects, [], `${name}: inconsistent control height`);
  const misalignedSelects = await page.locator('[data-slot="native-select"], [data-slot="select-trigger"]').evaluateAll(nodes => nodes.filter(node => {
    if (!node.getClientRects().length) return false;
    const control = node.getBoundingClientRect(), wrapper = node.parentElement.getBoundingClientRect();
    const icon = node.parentElement.querySelector('[data-slot="select-icon"]').getBoundingClientRect();
    return getComputedStyle(node).alignItems !== 'center' || Math.abs(wrapper.height - control.height) > 1 || Math.abs(icon.y + icon.height / 2 - control.y - control.height / 2) > 1;
  }).map(node => node.getAttribute('aria-label') || node.closest('label')?.textContent));
  assert.deepEqual(misalignedSelects, [], `${name}: select text or arrow is off-center`);
  await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, output)), fullPage: true, animations: "disabled" });
  report.screenshots.push(name);
}

try {
  const app = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN", reducedMotion: "reduce" });
  app.on("pageerror", error => report.errors.push(error.message));
  await app.addInitScript(() => {
    localStorage.setItem("practiq-theme", "light");
    window.__designNativeCalls = 0;
    window.__TAURI_INTERNALS__ = { invoke: () => { window.__designNativeCalls++; throw new Error("Unexpected native request in preview"); } };
  });
  await app.goto(appURL);
  await expect(app.getByText("基础知识 · 全题型", { exact: true })).toBeVisible();
  await expect(app.locator(".preview-controls")).toHaveCount(0);
  await capture(app, "app-banks-light-desktop");
  for (const width of [375, 768, 1024]) {
    await app.setViewportSize({ width, height: 900 });
    await capture(app, `app-banks-light-${width}`);
  }
  await app.setViewportSize({ width: 1440, height: 1000 });
  await app.getByRole("button", { name: "查看题目", exact: true }).first().click();
  await expect(app.getByText("下面哪一个是质数？", { exact: true }).first()).toBeVisible();
  await capture(app, "app-questions-light-desktop");
  await app.setViewportSize({ width: 375, height: 844 });
  await capture(app, "app-questions-light-mobile");
  const summary = app.locator(".question-row > button").first();
  assert.ok(await summary.evaluate(node => node.getBoundingClientRect().width >= 200), "Mobile question stem must have readable width");
  await app.setViewportSize({ width: 1440, height: 1000 });
  await app.getByRole("button", { name: "编辑题目", exact: true }).first().click();
  await expect(app.getByRole("dialog", { name: "编辑题目", exact: true })).toBeVisible();
  await capture(app, "app-editor-light-desktop");
  await app.setViewportSize({ width: 390, height: 844 });
  await capture(app, "app-editor-light-mobile");
  await app.keyboard.press("Escape");
  await app.setViewportSize({ width: 1440, height: 1000 });
  for (const name of ["错题本", "收藏夹", "练习记录", "设置"]) {
    await app.getByRole("button", { name, exact: true }).first().click();
    await expect(app.getByRole("heading", { name, exact: true })).toBeVisible();
    await capture(app, `app-${({ 错题本: "mistakes", 收藏夹: "favorites", 练习记录: "history", 设置: "settings" })[name]}-light-desktop`);
    if (name === "练习记录") {
      const filter = app.getByLabel("练习记录状态", { exact: true });
      await filter.click();
      await expect(filter).toHaveAttribute("data-slot", "select-trigger");
      await expect(app.getByRole("option", { name: "全部", exact: true })).toBeVisible();
      await expect(app.getByRole("option", { name: "全部", exact: true })).toHaveCSS("color", "rgb(121, 80, 136)");
      await capture(app, "app-history-menu-light-desktop");
      await app.keyboard.press("Escape");
      await filter.focus();
      await app.keyboard.press("Space");
      await expect(app.getByRole("option", { name: "全部", exact: true })).toBeFocused();
      await app.keyboard.press("End");
      await expect(app.getByRole("option", { name: "已结束", exact: true })).toBeFocused();
      await app.keyboard.press("Enter");
      await expect(filter).toHaveAttribute('data-value', "finished");
      await chooseOption(filter, "all");
    }
  }
  await app.getByRole("button", { name: "配置", exact: true }).click();
  await expect(app.getByLabel("AI 服务地址", { exact: true })).toBeVisible();
  await capture(app, "app-service-light-desktop");
  await app.getByRole("button", { name: "返回设置", exact: true }).click();
  await app.getByRole("button", { name: "主题", exact: true }).click();
  await app.getByRole("menuitemradio", { name: "黑夜", exact: true }).click();
  await capture(app, "app-settings-dark-desktop");
  await app.getByRole("button", { name: "我的题库", exact: true }).click();
  await capture(app, "app-banks-dark-desktop");
  await app.setViewportSize({ width: 375, height: 844 });
  await capture(app, "app-banks-dark-mobile");
  await app.setViewportSize({ width: 1440, height: 1000 });
  await app.evaluate(async () => {
    const { toast } = await import('/src/notifications.tsx');
    toast.error('样式检查：示例错误');
  });
  const notice = app.locator('[data-sonner-toast][data-type="error"]');
  await expect(notice).toHaveCSS('background-color', 'rgb(65, 42, 51)');
  await expect(notice).toHaveCSS('border-radius', '12px');
  await expect(notice).toHaveCSS('box-shadow', 'none');
  await app.getByRole("button", { name: "主题", exact: true }).click();
  await app.getByRole("menuitemradio", { name: "白天", exact: true }).click();
  await expect(notice).toHaveCSS('background-color', 'rgb(251, 235, 237)');
  const sonner = await app.locator('[data-sonner-toaster]').evaluate(node => ({
    success: getComputedStyle(node).getPropertyValue('--success-border').trim(),
    warning: getComputedStyle(node).getPropertyValue('--warning-border').trim(),
  }));
  assert.equal(sonner.success, '#79947a');
  assert.equal(sonner.warning, '#ab873e');
  await expect(notice).toBeHidden();
  await app.getByRole("button", { name: "语言", exact: true }).click();
  await app.getByRole("menuitemradio", { name: "English", exact: true }).click();
  await app.setViewportSize({ width: 375, height: 844 });
  await capture(app, "app-banks-light-english-mobile");
  await app.setViewportSize({ width: 1440, height: 1000 });
  await app.getByRole("button", { name: "Language", exact: true }).click();
  await app.getByRole("menuitemradio", { name: "简体中文", exact: true }).click();
  await app.getByRole("button", { name: "开始练习", exact: true }).first().click();
  await app.getByRole("button", { name: "立即开始", exact: true }).click();
  await expect(app.getByText("下面哪一个是质数？", { exact: true }).first()).toBeVisible();
  await capture(app, "app-practice-light-desktop");
  await app.setViewportSize({ width: 390, height: 844 });
  await capture(app, "app-practice-light-mobile");
  const previous = await app.getByRole("button", { name: "上一题", exact: true }).boundingBox();
  const next = await app.getByRole("button", { name: "下一题", exact: true }).boundingBox();
  assert.ok(previous && next && Math.abs(previous.y - next.y) <= 1, "Previous and Next must stay together on mobile");
  assert.ok(await app.getByRole("button", { name: "下一题", exact: true }).evaluate(node => node.getBoundingClientRect().height >= 48));
  await app.setViewportSize({ width: 360, height: 640 });
  await capture(app, "app-practice-light-360");
  await app.setViewportSize({ width: 667, height: 375 });
  await capture(app, "app-practice-light-landscape");
  assert.ok(await app.locator(".practice-actions").evaluate(node => node.getBoundingClientRect().height < 80), "Landscape practice controls must stay compact");
  assert.equal(await app.evaluate(() => window.__designNativeCalls), 0);
  report.checks.push("App preview fits 1440/1024/768/390/375/360px, gives mobile stems readable width, keeps Previous/Next together, supports English wrapping, uses 40px/48px ordinary controls, supports keyboard filtering and light/dark toast colors, preserves theme switching and practice, and makes no native requests.");

  assert.deepEqual(report.errors, []);
} finally {
  await browser.close();
  await writeFile(new URL("report.json", output), JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify(report, null, 2));
