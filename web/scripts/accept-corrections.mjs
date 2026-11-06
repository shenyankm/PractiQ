// Production browser + HTTP acceptance against the isolated substitute-provider service.
import { chromium } from "../node_modules/playwright/index.mjs";
import { expect } from "../node_modules/playwright/test.mjs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
const output = process.env.PRACTIQ_ACCEPT_OUTPUT;
const base = process.env.PRACTIQ_ACCEPT_URL;
const browser = await chromium.launch({ headless: true });
const report = { status: "FAILED", samples: [], providerCallsBefore: null, providerCallsAfter: null, error: null };
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1040 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  await page.goto(base);
  await expect(page.getByLabel("选择文档")).toBeAttached();
  await page.getByLabel("选择文档").setInputFiles(path.join(output, "sources/quiz.png"));
  const create = page.waitForResponse(r => new URL(r.url()).pathname === "/api/document-tasks" && r.request().method() === "POST");
  await page.getByRole("button", { name: "开始导入", exact: true }).click();
  const { threadId } = await (await create).json();
  await expect(page.getByRole("button", { name: "下载题库 ZIP", exact: true })).toBeEnabled({ timeout: 90000 });
  const url = `/api/document-tasks/${threadId}`;
  const before = await (await context.request.get(base + url)).json();
  await writeFile(path.join(output, "before.json"), JSON.stringify(before, null, 2));
  report.providerCallsBefore = before.usage.length;
  const first = before.result.questions[0];
  await page.getByText(first.stem, { selector: "summary span", exact: true }).click();
  await page.getByRole("button", { name: "对照原文与校对", exact: true }).click();
  await expect(page.getByRole("img", { name: /题目来源/ })).toBeVisible();
  const sourceImage = page.getByRole("img", { name: /题目来源/ });
  expect(await sourceImage.evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "人工校对", exact: true }).click();
  await page.getByRole("textbox", { name: "题干", exact: true }).fill("人工校对：" + first.stem);
  await page.getByRole("textbox", { name: "内容块 1 · 文本", exact: true }).fill("人工校对：" + first.stem);
  await page.getByRole("textbox", { name: "题型标签", exact: true }).fill("判断题");
  await page.getByRole("textbox", { name: "解析", exact: true }).fill("人工核对后保存的解析。");
  await page.getByRole("combobox", { name: "参考答案", exact: true }).click();
  await page.getByRole("option", { name: "错误", exact: true }).click();
  await page.setViewportSize({ width:390, height:844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width:1440, height:1040 });
  await page.getByRole("button", { name: "保存修订", exact: true }).click();
  await expect(page.getByText(/修订已保存/)).toBeVisible();
  const saved = await (await context.request.get(base + url + "/corrections")).json();
  expect(saved.edits).toHaveLength(1);
  expect(saved.edits[0].question.stem).toBe("人工校对：" + first.stem);
  expect(saved.edits[0].question.contentBlocks[0].textValue).toBe("人工校对：" + first.stem);
  expect(saved.edits[0].question.answerPayload).toEqual({ value: false });
  for (const [name,width,height,dark] of [["desktop-light",1440,1040,false],["narrow-dark",390,844,true]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(dark => document.documentElement.classList.toggle("dark", dark), dark);
    await page.getByRole("heading", { name: "对照与校对 · 第 1 条" }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    report.samples.push({ name, width, height, noHorizontalOverflow: true });
  }
  await page.setViewportSize({ width:1440, height:1040 });
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载修订版 ZIP", exact: true }).click();
  await (await download).saveAs(path.join(output, "exports/png.zip"));
  const original = await context.request.get(base + url + "/export?checkpoint_id=" + encodeURIComponent(before.checkpointId));
  expect(original.status()).toBe(200);
  await writeFile(path.join(output, "original.zip"), await original.body());
  // Reload the production client: revisions must come from PostgreSQL, not component memory.
  await page.reload();
  await page.getByRole("link", { name: "导入记录", exact: true }).click();
  await page.getByRole("button", { name: "quiz.png", exact: true }).click();
  await expect(page.getByText("人工校对：" + first.stem, { selector: "summary span", exact: true })).toBeVisible();
  const after = await (await context.request.get(base + url)).json();
  expect(after.result).toEqual(before.result);
  expect(after.usage).toEqual(before.usage);
  report.providerCallsAfter = after.usage.length;
  expect(errors).toEqual([]);
  report.saved = saved;
  report.threadId = threadId;
  report.status = "PASSED";
  await context.close();
} catch (error) { report.error = String(error.stack ?? error); }
finally {
  await browser.close();
  await writeFile(path.join(output, "browser.json"), JSON.stringify(report, null, 2));
}
if (report.status !== "PASSED") throw Error(report.error);
