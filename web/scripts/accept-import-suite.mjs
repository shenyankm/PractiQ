// Actual loopback HTTP/PostgreSQL with substitute providers; no real model calls.
import { chromium } from "../node_modules/playwright/index.mjs";
import { expect } from "../node_modules/playwright/test.mjs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chooseOption } from "../../shared/select-test.mjs";
const output = process.env.PRACTIQ_ACCEPT_OUTPUT, base = process.env.PRACTIQ_ACCEPT_URL;
let context;
const report = { status: "FAILED", liveProviders: false, error: null, samples: [] };
try {
  const browserOptions = { headless: true, viewport: { width: 1440, height: 1040 }, acceptDownloads: true };
  const profile = path.join(output, "browser-profile");
  context = await chromium.launchPersistentContext(profile, browserOptions);
  let page = context.pages()[0];
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  page.on("dialog", dialog => dialog.accept());
  async function detail(id) { const response = await context.request.get(base + `/api/document-tasks/${id}`); expect(response.status()).toBe(200); return response.json(); }
  async function complete(id) { await expect.poll(async () => (await detail(id)).state, { timeout: 90000, intervals: [300, 1000] }).toBe("COMPLETED"); return detail(id); }
  async function openTask(file) {
    await page.getByRole("link", { name: "导入记录", exact: true }).click();
    await page.getByRole("button", { name: file, exact: true }).click();
    await expect(page.getByRole("heading", { name: file, exact: true })).toBeVisible();
  }
  async function inspect(name) {
    for (const [variant, width, height, dark] of [["desktop", 1440, 1040, false], ["narrow", 390, 844, true]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(dark => document.documentElement.classList.toggle("dark", dark), dark);
      await page.evaluate(() => scrollTo(0, 0));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (process.env.PRACTIQ_CAPTURE === "1") await page.screenshot({ path: path.join(output, `${name}-${variant}.png`), fullPage: true, animations: "disabled" });
      report.samples.push({ name, variant, width, height, noHorizontalOverflow: true });
    }
    await page.setViewportSize({ width: 1440, height: 1040 });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
  }
  await page.goto(base);
  await page.getByLabel("选择文档").setInputFiles(path.join(output, "sources/questions.txt"));
  await expect(page.getByRole("button", { name: "开始导入", exact: true })).toBeEnabled();
  await inspect("start");
  const created = page.waitForResponse(r => new URL(r.url()).pathname === "/api/document-tasks" && r.request().method() === "POST");
  await page.getByRole("button", { name: "开始导入", exact: true }).click();
  const { threadId } = await (await created).json();
  const before = await complete(threadId);
  expect(before.result.questions).toHaveLength(3);
  expect(before.result.questions.every(q => q.answerPayload === null)).toBe(true);
  const first = before.result.questions[0];
  await page.getByText(first.stem, { selector: "summary span", exact: true }).click();
  await page.getByRole("button", { name: "对照原文与校对", exact: true }).click();
  await page.getByRole("button", { name: "人工校对", exact: true }).click();
  await page.getByRole("textbox", { name: "解析", exact: true }).fill("恢复后的人工解析");
  await page.reload(); await openTask("questions.txt");
  await page.getByRole("button", { name: "恢复第 1 题草稿", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "解析", exact: true })).toHaveValue("恢复后的人工解析");
  await inspect("draft");
  let lost = null, puts = 0;
  const saveProbe = async route => {
    if (route.request().method() !== "PUT") { await route.continue(); return; }
    puts++;
    if (!lost) { lost = route.request().postDataJSON(); const accepted = await route.fetch(); expect(accepted.status()).toBe(200); await route.abort("failed"); }
    else await route.continue();
  };
  await page.route(`**/api/document-tasks/${threadId}/corrections`, saveProbe);
  await page.getByRole("button", { name: "保存修订", exact: true }).click();
  await expect(page.getByText(/结果尚未确认，先重新读取修订/)).toBeVisible();
  const savedRequest = structuredClone(lost);
  await context.close();
  context = await chromium.launchPersistentContext(profile, browserOptions);
  page = context.pages()[0];
  page.on("pageerror", error => errors.push(String(error)));
  page.on("dialog", dialog => dialog.accept());
  await page.route(`**/api/document-tasks/${threadId}/corrections`, saveProbe);
  await page.goto(base); await openTask("questions.txt");
  report.browserRestartRecovered = true;
  await page.getByRole("button", { name: "恢复第 1 题草稿", exact: true }).click();
  await expect(page.getByText(new RegExp(savedRequest.requestId))).toBeVisible();
  expect(puts).toBe(1);
  await page.getByRole("button", { name: "重新读取已保存修订", exact: true }).click();
  await expect(page.getByText(/上次保存已确认/)).toBeVisible(); expect(puts).toBe(1);
  report.unknownSaveRecoveredWithoutReplay = true; report.retainedRequestId = savedRequest.requestId;
  await page.getByRole("button", { name: "返回题目列表", exact: true }).click();
  await page.getByRole("button", { name: "关联答案卷", exact: true }).click();
  await page.getByLabel("选择答案卷文件").setInputFiles(path.join(output, "sources/answers.txt"));
  const answerCreated = page.waitForResponse(r => new URL(r.url()).pathname === "/api/document-tasks" && r.request().method() === "POST");
  await page.getByRole("button", { name: "导入答案卷（将调用 AI）", exact: true }).click();
  const answerReceipt = await (await answerCreated).json();
  const answers = await complete(answerReceipt.threadId);
  expect(answers.documentRole).toBe("answers"); expect(answers.result.questions.every(q => q.answerPayload !== null)).toBe(true);
  await page.getByRole("button", { name: "读取匹配建议（不调用模型）", exact: true }).click();
  await expect(page.getByRole("button", { name: "采用此答案并进入校对 · 第 1 题", exact: true })).toBeEnabled();
  await inspect("matching");
  await page.getByRole("button", { name: "采用此答案并进入校对 · 第 1 题", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "解析", exact: true })).toHaveValue("恢复后的人工解析");
  await page.getByRole("button", { name: "保存修订", exact: true }).click();
  await expect(page.getByText(/修订已保存/)).toBeVisible();
  const saved = await (await context.request.get(base + `/api/document-tasks/${threadId}/corrections`)).json();
  expect(saved.edits).toHaveLength(2); expect(saved.edits[1].answerEvidence.selection.taskId).toBe(answers.threadId);
  report.saved = saved;
  const after = await detail(threadId); expect(after.result).toEqual(before.result); expect(after.usage).toEqual(before.usage);
  await page.getByRole("button", { name: "返回题目列表", exact: true }).click();
  await page.getByRole("checkbox", { name: "选择第 1 题", exact: true }).check();
  const selectedDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载所选题目 ZIP", exact: true }).click();
  await (await selectedDownload).saveAs(path.join(output, "exports/png.zip"));
  const original = await context.request.get(base + `/api/document-tasks/${threadId}/export?checkpoint_id=${encodeURIComponent(before.checkpointId)}`);
  expect(original.status()).toBe(200); await writeFile(path.join(output, "original.zip"), await original.body());
  report.selectedOriginalIndex = 0; report.targetThreadId = threadId; report.answerThreadId = answers.threadId;
  await page.getByRole("link", { name: "开始导入", exact: true }).click();
  await page.getByRole("textbox", { name: "页面范围（留空为全部）", exact: true }).fill("2");
  await chooseOption(page.getByRole("combobox", { name: "文件用途", exact: true }), "questions");
  await page.getByLabel("选择文档").setInputFiles(path.join(output, "sources/range.pdf"));
  const rangeCreated = page.waitForResponse(r => new URL(r.url()).pathname === "/api/document-tasks" && r.request().method() === "POST");
  await page.getByRole("button", { name: "开始导入", exact: true }).click();
  const rangeReceipt = await (await rangeCreated).json(); const range = await complete(rangeReceipt.threadId);
  expect(range.pages).toEqual([2]); expect(range.result.questions).toHaveLength(1);
  expect(range.progress.visuals.total).toBe(1); expect(range.processing.questionSources[0].unitIndex).toBe(1);
  await page.getByText(range.result.questions[0].stem, { selector: "summary span", exact: true }).click();
  await page.getByRole("button", { name: "对照原文与校对", exact: true }).click();
  await expect(page.getByRole("img", { name: /题目来源 · 第 2 页/ })).toBeVisible();
  await inspect("range");
  await page.getByRole("button", { name: "返回题目列表", exact: true }).click();
  await page.getByRole("checkbox", { name: "选择第 1 题", exact: true }).check();
  const beforeReparse = JSON.parse(await readFile(path.join(output, "provider-events.json"), "utf8"));
  const reparse = page.waitForResponse(r => new URL(r.url()).pathname === `/api/document-tasks/${range.threadId}/reparse` && r.request().method() === "POST");
  await page.getByRole("button", { name: "重新解析所选题目的来源", exact: true }).click();
  const reparseResponse = await reparse; expect(reparseResponse.status()).toBe(202);
  const request = reparseResponse.request().postDataJSON();
  expect(request.selection).toEqual({ checkpointId: range.checkpointId, units: [{ stage: "vision_parse", index: 1 }] });
  const reparsed = await complete((await reparseResponse.json()).threadId);
  const afterReparse = JSON.parse(await readFile(path.join(output, "provider-events.json"), "utf8"));
  expect(reparsed.parentThreadId).toBe(range.threadId); expect(reparsed.parserJobs).toEqual([]);
  expect(reparsed.result.questions).toHaveLength(1); expect(reparsed.processing.questionSources[0].unitIndex).toBe(1);
  expect(afterReparse.tencentSubmissions).toBe(beforeReparse.tencentSubmissions);
  expect(afterReparse.modelCalls).toBe(beforeReparse.modelCalls + 1);
  expect((await detail(range.threadId)).result).toEqual(range.result);
  report.rangeThreadId = range.threadId; report.reparseThreadId = reparsed.threadId;
  report.providerBeforeReparse = beforeReparse; report.providerAfterReparse = afterReparse;
  report.providerCallsBefore = before.usage.length; report.providerCallsAfter = after.usage.length;
  report.originalsAndUsageUnchanged = true; expect(errors).toEqual([]); report.status = "PASSED";
  await context.close();
} catch (error) { report.error = String(error.stack ?? error); }
finally { await context?.close(); await writeFile(path.join(output, "browser.json"), JSON.stringify(report, null, 2)); }
if (report.status !== "PASSED") throw Error(report.error);
