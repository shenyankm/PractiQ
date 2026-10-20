import { chooseOption } from "../../shared/select-test.mjs";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { expect, test, type Page, type Route } from "playwright/test";
import type { DocumentTaskDetail, DocumentTaskReview } from "../src/contracts.generated";
import { capabilities, material, newTaskId, preview, question, runId, summary, task, taskId } from "../src/test-fixtures";
import { layoutImage, layoutSnapshots, layoutViewports } from "../../app/scripts/responsive-fixtures.mjs";

// All HTTP here is synthetic. No model, Office worker, or live service is used.
const fakeToken = "fake-service-token";
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=", "base64");
const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 5, 6]), Buffer.alloc(18)]); // Empty ZIP transport fixture.
type Call = { method: string; path: string; query: string; body: Record<string, any> | null; bytes: Buffer | null; authenticated: boolean };
type Intercept = (route: Route, call: Call) => Promise<boolean>;
const respond = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
async function fakeHTTP(page: Page, initial: DocumentTaskDetail = task) {
  const calls: Call[] = [];
  const records = new Map([[initial.threadId, structuredClone(initial)]]);
  const uploads = new Map<string, Record<string, unknown>>();
  const creates = new Map<string, string>();
  const server: { intercept?: Intercept; review?: DocumentTaskReview; hasMore: boolean; modelStarts: number } = { hasMore: false, modelStarts: 0 };
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    const raw = request.postDataBuffer();
    const jsonBody = request.headers()["content-type"]?.includes("application/json");
    const call: Call = { method: request.method(), path: url.pathname, query: url.search, body: jsonBody && raw ? JSON.parse(raw.toString()) : null, bytes: jsonBody ? null : raw, authenticated: request.headers().authorization === `Bearer ${fakeToken}` };
    calls.push(call);
    if (!call.authenticated) { await respond(route, { detail: { code: "INVALID_TOKEN" } }, 401); return; }
    if (await server.intercept?.(route, call)) return;
    if (call.path === "/api/import-capabilities") { await respond(route, capabilities); return; }
    if (call.path === "/api/document-tasks" && call.method === "GET") {
      await respond(route, { items: Array.from(records.values()).map(current => ({ ...summary, threadId: current.threadId, fileName: current.fileName, state: current.state, checkpointId: current.checkpointId, status: current.status })), hasMore: server.hasMore }); return;
    }
    if (call.path === "/api/uploads") {
      const metadata = call.body!;
      const document = { ...metadata, objectKey: `practiq-agent/sources/${metadata.sha256}/source.${metadata.sourceType === "text" ? "txt" : metadata.sourceType === "markdown" ? "md" : metadata.sourceType}` };
      const exists = uploads.has(metadata.sha256);
      uploads.set(metadata.sha256, document);
      await respond(route, { document, upload: exists ? null : { method: "PUT", url: "/api/uploads/content?" + new URLSearchParams(metadata), headers: { "Content-Type": metadata.mediaType } } }); return;
    }
    if (call.path === "/api/uploads/content") {
      expect(call.bytes).not.toBeNull(); expect(digest(call.bytes!)).toBe(url.searchParams.get("sha256"));
      expect(call.bytes!.length).toBe(Number(url.searchParams.get("sizeBytes")));
      await respond(route, uploads.get(url.searchParams.get("sha256")!)); return;
    }
    if (call.path === "/api/document-tasks" && call.method === "POST") {
      const body = call.body!;
      if (!creates.has(body.requestId)) { creates.set(body.requestId, newTaskId); server.modelStarts++; records.set(newTaskId, { ...task, threadId: newTaskId, fileName: body.document.fileName }); }
      await respond(route, { threadId: creates.get(body.requestId), requestId: body.requestId, runId, accepted: true }, 202); return;
    }
    if (call.path === "/api/artifacts/read") { await route.fulfill({ contentType: "image/png", body: png }); return; }
    const id = call.path.split("/")[3], current = records.get(id);
    if (call.path.endsWith("/preview")) { await respond(route, { ...(server.review || preview), threadId: id, checkpointId: current?.checkpointId, state: current?.state }); return; }
    if (call.path.endsWith("/export")) { await route.fulfill({ contentType: "application/zip", headers: { "Content-Disposition": `attachment; filename="practiq-bank-${id}.zip"` }, body: zip }); return; }
    if (call.path.endsWith("/control")) {
      const paused = call.body!.action === "pause";
      records.set(id, { ...current!, state: paused ? "PAUSED" : "RUNNING", runId, allowedActions: paused ? ["resume", "retry_failed", "accept_partial"] : ["pause", "interrupt"] });
      await respond(route, { threadId: id, requestId: call.body!.requestId, runId, accepted: true }, 202); return;
    }
    if (call.path.endsWith("/reparse")) {
      server.modelStarts++; records.set(newTaskId, { ...task, threadId: newTaskId, fileName: "reparsed.docx", parentThreadId: id, state: "PENDING", checkpointId: null, result: null });
      await respond(route, { threadId: newTaskId, requestId: call.body!.requestId, runId, accepted: true }, 202); return;
    }
    if (call.method === "DELETE") { records.delete(id); await respond(route, { deleted: true }); return; }
    await respond(route, current);
  });
  return { calls, records, creates, server };
}
async function connect(page: Page) {
  await page.goto("/"); await page.getByLabel("服务访问令牌").fill(fakeToken); await page.getByRole("button", { name: "连接服务", exact: true }).click();
  await expect(page.getByText(/^服务支持：/)).toBeVisible();
  await expect(page.getByText(/普通单元最多 100 个.*带上下文的视觉单元最多 50 个/)).toBeVisible();
}
async function openTask(page: Page) {
  await page.getByRole("button", { name: /sample.docx/ }).click();
  await expect(page.getByRole("heading", { name: "sample.docx", exact: true })).toBeVisible();
  await expect(page.getByText("根据材料选择答案", { exact: true })).toBeVisible();
}
const mutations = (calls: Call[]) => calls.filter(call => call.method !== "GET");
const starts = (calls: Call[]) => calls.filter(call => call.path === "/api/document-tasks" && call.method === "POST");

test("shared dropdowns preserve themed menus, empty filters and keyboard focus", async ({ page }, testInfo) => {
  const http = await fakeHTTP(page);
  await connect(page);
  const filter = page.getByRole("combobox", { name: "筛选任务状态" });
  await expect(filter).toHaveAttribute("data-slot", "select-trigger");
  await filter.focus();
  await page.keyboard.press("Space");
  const all = page.getByRole("option", { name: "全部任务", exact: true });
  await expect(all).toBeFocused();
  await expect(all).toHaveAttribute("data-state", "checked");
  await expect(page.getByRole("listbox")).toHaveCSS("background-color", "rgb(255, 252, 250)");
  await page.screenshot({ path: testInfo.outputPath("web-select-menu.png"), animations: "disabled" });
  await page.keyboard.press("End");
  await expect(page.getByRole("option", { name: "已过期", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(filter).toHaveAttribute("data-value", "expired");
  await expect(filter).toBeFocused();
  await chooseOption(filter, "");
  await expect(filter).toHaveAttribute("data-value", "");
  await filter.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(filter).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("combobox", { name: "Word / Excel 转换模式" })).toHaveCount(0);
  await expect(filter).toHaveCSS("min-height", "48px");
  expect(mutations(http.calls)).toHaveLength(0);
});

test("1000 question searches scan a shared option bank once and stay passive", async ({ page }, testInfo) => {
  const children = Array.from({ length: 999 }, (_, index) => question({ id: `child-${index}` }));
  const owner = question({ ...material, answerMode: "word_bank", questionTypeId: "word_bank", options: Array.from({ length: 100 }, (_, index) => ({ label: String(index), content: `Benchmark option ${index}` })), passage: children.map(child => ({ partType: "blank", questionId: child.id })) });
  const questions = [owner, ...children];
  const http = await fakeHTTP(page);
  http.server.review = { ...preview, units: [{ ...preview.units[0], questions }] };
  await page.addInitScript(() => {
    const metrics = window as typeof window & { optionComparisons: number };
    metrics.optionComparisons = 0;
    const original = String.prototype.toLocaleLowerCase;
    String.prototype.toLocaleLowerCase = function (this: string, locales?: string | string[]) {
      if (String(this).startsWith("Benchmark option ")) metrics.optionComparisons++;
      return original.call(this, locales);
    };
  });
  await connect(page);
  await page.getByRole("button", { name: /sample.docx/ }).click();
  const search = page.getByRole("searchbox");
  await expect(search).toBeVisible();
  // Development StrictMode repeats the memo calculation; production runs it once.
  const expectedComparisons = process.env.PRACTIQ_WEB_BUILT === "1" ? 100 : 200;
  const comparisons = [];
  for (let index = 0; index < 5; index++) {
    await page.evaluate(() => { (window as typeof window & { optionComparisons: number }).optionComparisons = 0; });
    await search.fill(`absent-${index}`);
    await expect(page.getByText("显示 0 / 1000 条记录")).toBeVisible();
    comparisons.push(await page.evaluate(() => (window as typeof window & { optionComparisons: number }).optionComparisons));
  }
  expect(comparisons).toEqual(Array(5).fill(expectedComparisons));
  expect(starts(http.calls)).toHaveLength(0);
  await testInfo.attach("shared-options-performance", { body: JSON.stringify({ questions: 1000, sharedOptions: 100, expectedComparisons, comparisons }), contentType: "application/json" });
});

for (const [width, height] of [[1440, 1000], [390, 844]]) {
  test(`import flow screenshot acceptance at ${width}px`, async ({ page }, testInfo) => {
    const evidence = testInfo.outputPath("import-flow");
    await mkdir(evidence, { recursive: true });
    await page.setViewportSize({ width, height });
    const http = await fakeHTTP(page);
    await page.goto("/");
    await page.mouse.move(0, 0);
    await expect(page.locator('.import-steps [aria-current="step"]')).toHaveText(/选择并导入/);
    await expect(page.getByRole("button", { name: "刷新余额与商品" })).toBeHidden();
    await page.screenshot({ path: `${evidence}/after-connection-${width}.png`, fullPage: true });
    await connect(page);
    const importRules = page.getByText("格式与导入规则", { exact: true });
    await importRules.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText(/所有支持的格式统一使用腾讯异步解析/)).toBeVisible();
    await expect(page.getByText(/下载的 ZIP 可在 App/)).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.getByText(/所有支持的格式统一使用腾讯异步解析/)).toBeHidden();
    await page.evaluate(() => scrollTo(0, 0));
    await page.mouse.move(0, 0);
    await expect(page.getByRole("button", { name: "查看积分明细", exact: true })).toBeHidden();
    await expect(page.getByLabel("追加卡密")).toHaveCount(0);
    await expect(page.getByText(/启用 AI 复核会增加调用与费用/)).toBeVisible();
    await page.screenshot({ path: `${evidence}/after-workspace-${width}.png`, fullPage: true });
    await openTask(page);
    await page.evaluate(() => scrollTo(0, 0));
    await page.mouse.move(0, 0);
    await expect(page.locator('.import-steps [aria-current="step"]')).toHaveText(/检查解析结果/);
    await page.getByRole("searchbox", { name: "搜索解析题目" }).fill("absent");
    await expect(page.getByText("显示 0 / 3 条记录")).toBeVisible();
    await expect(page.getByText("筛选仅影响显示，导出仍包含全部已完成题目。")).toBeVisible();
    await expect(page.getByRole("button", { name: "下载题库 ZIP", exact: true })).toBeEnabled();
    await page.screenshot({ path: `${evidence}/after-review-${width}.png`, fullPage: true });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.screenshot({ path: `${evidence}/after-review-dark-${width}.png`, fullPage: true, animations: "disabled" });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    for (const checkWidth of [375, 768, 1024]) {
      await page.setViewportSize({ width: checkWidth, height });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.setViewportSize({ width, height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(mutations(http.calls)).toHaveLength(0);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载题库 ZIP", exact: true }).click();
    await download;
    await expect(page.locator('.import-steps [aria-current="step"]')).toHaveText(/导出并离线练习/);
    await expect(page.getByText("ZIP 已下载 · App：设置 → 恢复备份", { exact: true })).toBeAttached();
    expect(http.server.modelStarts).toBe(0);
    await page.evaluate(() => scrollTo(0, 0));
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${evidence}/after-export-${width}.png`, fullPage: true, animations: "disabled" });
    http.records.set(taskId, { ...task, checkpointId: "new-checkpoint" });
    await page.getByRole("button", { name: "刷新任务详情", exact: true }).click();
    await expect(page.locator('.import-steps [aria-current="step"]')).toHaveText(/检查解析结果/);
    await expect(page.getByRole("button", { name: "断开连接", exact: true })).toHaveCount(0);
    await expect(page.getByText("服务已连接", { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.import-steps [aria-current="step"]')).toHaveText(/选择并导入/);
  });
}

test("all KaTeX font faces load from WOFF2 with no fallback font requests", async ({ page }) => {
  const http = await fakeHTTP(page);
  const fontRequests: string[] = [];
  page.on("request", request => { if (/\.(?:woff2?|ttf)(?:\?|$)/.test(request.url())) fontRequests.push(request.url()); });
  await connect(page);
  await openTask(page);
  const fonts = await page.evaluate(async () => {
    const faces = [...document.fonts].filter(face => face.family.startsWith("KaTeX_"));
    await Promise.all(faces.map(face => face.load()));
    return faces.map(face => ({ family: face.family, style: face.style, weight: face.weight, status: face.status }));
  });
  const css = await readFile(new URL("../node_modules/katex/dist/katex.min.css", import.meta.url), "utf8");
  expect(fonts).toHaveLength((css.match(/@font-face/g) || []).length);
  expect(fonts.every(face => face.status === "loaded")).toBe(true);
  expect(fontRequests.length).toBeGreaterThan(0);
  expect(fontRequests.every(url => /\.woff2(?:\?|$)/.test(url))).toBe(true);
  expect(mutations(http.calls)).toHaveLength(0);
});

test("workspace fits narrow and desktop windows with keyboard shortcuts to content", async ({ page }, testInfo) => {
  const http = await fakeHTTP(page, { ...task, fileName: "很长的来源文档名称-".repeat(12) + ".docx" });
  await page.goto("/");
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: testInfo.outputPath(`connection-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "跳到主要内容" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  await connect(page);
  await page.getByRole("button", { name: /很长的来源文档名称/ }).click();
  await expect(page.getByRole("heading", { name: /很长的来源文档名称/ })).toBeVisible();
  await expect(page.getByText("根据材料选择答案", { exact: true })).toBeVisible();
  for (const width of [1440, 900, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: testInfo.outputPath(`workspace-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.getByRole("link", { name: "查看当前任务详情" }).click();
  await expect(page.getByRole("region", { name: "任务详情" })).toBeFocused();
  await page.getByText("模型用量与任务诊断", { exact: true }).click();
  const sourcesButton = page.getByRole("button", { name: "来源与资源", exact: true });
  await sourcesButton.click();
  await expect(sourcesButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "题目与材料", exact: true })).toHaveAttribute("aria-pressed", "false");
  expect(await sourcesButton.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(48);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("link", { name: "返回任务列表" }).click();
  await expect(page.locator("#task-list-heading")).toBeFocused();
  expect(mutations(http.calls)).toHaveLength(0);
});

test("passive file selection becomes one authenticated SHA upload only after explicit Start", async ({ page }) => {
  const http = await fakeHTTP(page);
  await page.goto("/"); expect(http.calls.length === 0).toBe(true); await connect(page);
  const bytes = Buffer.from("synthetic office file");
  await page.getByLabel("选择文档").setInputFiles({ name: "selected.docx", mimeType: "application/octet-stream", buffer: bytes });
  await expect(page.getByText(/尚未提交/)).toBeVisible(); expect(mutations(http.calls)).toHaveLength(0);
  await page.getByRole("button", { name: "开始导入", exact: true }).click();
  await expect(page.getByText(/任务已创建。页面/)).toBeVisible();
  expect(mutations(http.calls).map(call => call.method)).toEqual(["POST", "PUT", "POST"]);
  expect(mutations(http.calls)[0].body).toMatchObject({ sourceType: "docx", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sizeBytes: bytes.length, sha256: digest(bytes) });
  expect(starts(http.calls)[0].body).toMatchObject({ graphId: "document_parser", failurePolicy: "return_partial" });
  expect(starts(http.calls)[0].body).not.toHaveProperty("officeMode");
  expect(http.calls.every(call => (call.authenticated) && !call.query.includes(fakeToken))).toBe(true);
  expect(http.server.modelStarts).toBe(1);
});

test("invalid auth makes no model request; reload clears memory-only Token", async ({ page }) => {
  const http = await fakeHTTP(page); await page.goto("/");
  await page.getByLabel("服务访问令牌").fill("invalid-synthetic-token"); await page.getByRole("button", { name: "连接服务", exact: true }).click();
  await expect(page.getByText(/服务访问令牌无效/).first()).toBeVisible();
  expect(mutations(http.calls)).toHaveLength(0);
  await page.getByLabel("服务访问令牌").fill(fakeToken); await page.getByRole("button", { name: "连接服务", exact: true }).click();
  await expect(page.getByText(/^服务支持：/)).toBeVisible();
  await expect(page.getByText(/普通单元最多 100 个.*带上下文的视觉单元最多 50 个/)).toBeVisible();
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, query: location.search }))).toEqual({ local: 0, session: 0, query: "" });
  await page.reload(); await expect(page.getByLabel("服务访问令牌")).toHaveValue("");
  expect(await page.locator("body").innerText()).not.toContain(fakeToken);
});

test("uncertain accepted POST never auto replays; explicit retry preserves requestId and source", async ({ page }) => {
  await page.clock.install();
  const http = await fakeHTTP(page); let lose = true;
  http.server.intercept = async (route, call) => {
    if (call.path === "/api/document-tasks" && call.method === "POST" && lose) {
      lose = false; http.creates.set(call.body!.requestId, newTaskId); http.server.modelStarts++; http.records.set(newTaskId, { ...task, threadId: newTaskId, fileName: "uncertain.docx" });
      await route.abort("failed"); return true;
    }
    return false;
  };
  await connect(page);
  await page.getByLabel("选择文档").setInputFiles({ name: "uncertain.docx", mimeType: "application/octet-stream", buffer: Buffer.from("fake office") });
  await page.getByRole("button", { name: "开始导入", exact: true }).click(); await expect(page.getByRole("button", { name: "重试开始", exact: true })).toBeVisible();
  const reads = http.calls.filter(call => call.method === "GET").length;
  await page.clock.fastForward(30000);
  await expect.poll(() => http.calls.filter(call => call.method === "GET").length).toBeGreaterThan(reads);
  expect(starts(http.calls)).toHaveLength(1); await expect(page.getByLabel("Word / Excel 转换模式")).toHaveCount(0);
  await page.getByLabel("选择文档").setInputFiles({ name: "uncertain.docx", mimeType: "application/octet-stream", buffer: Buffer.from("fake office") });
  await page.getByRole("button", { name: "开始导入", exact: true }).click();
  await expect(page.getByText(/任务已创建。页面/)).toBeVisible();
  expect(starts(http.calls)).toHaveLength(2); expect(starts(http.calls)[0].body).toEqual(starts(http.calls)[1].body); expect(http.server.modelStarts).toBe(1);
});

test("paused partial checkpoints only poll GET until explicit resume and pause actions", async ({ page }) => {
  await page.clock.install();
  const http = await fakeHTTP(page, { ...task, state: "PAUSED", phase: "chunk_review", allowedActions: ["resume", "retry_failed", "accept_partial"] });
  await connect(page); await openTask(page);
  await expect(page.getByRole("button", { name: "重试失败单元", exact: true })).toBeEnabled(); await expect(page.getByRole("button", { name: "接受部分结果", exact: true })).toBeEnabled();
  await page.getByText("模型用量与任务诊断", { exact: true }).click(); await expect(page.getByText(/实际总用量未知/)).toBeVisible();
  const reads = http.calls.length; await page.clock.fastForward(30000); await expect.poll(() => http.calls.length).toBeGreaterThan(reads); expect(mutations(http.calls)).toHaveLength(0);
  await page.getByRole("button", { name: "继续解析", exact: true }).click(); await expect(page.getByRole("button", { name: "暂停", exact: true })).toBeEnabled();
  expect(http.calls.find(call => call.path.endsWith("/control"))?.body).toMatchObject({ action: "resume", runId: null, checkpointId: "checkpoint-one", units: [] });
  await page.getByRole("button", { name: "暂停", exact: true }).click(); await expect(page.getByRole("button", { name: "继续解析", exact: true })).toBeEnabled();
  expect(http.calls.filter(call => call.path.endsWith("/control")).at(-1)?.body).toMatchObject({ action: "pause", runId, checkpointId: null });
});

test("partial review preserves nulls, sources, shared material and warnings; checked image and ZIP are explicit", async ({ page }) => {
  const http = await fakeHTTP(page); const external: string[] = [];
  page.on("request", request => { if (new URL(request.url()).hostname === "untrusted.invalid") external.push(request.url()); });
  const imageRef = { objectKey: "practiq-agent/artifacts/fake/image.png", sha256: digest(png), sizeBytes: png.length, mediaType: "image/png" };
  http.server.review = { ...preview, units: [{ ...preview.units[0], visualElements: [{ kind: "image", description: "已校验来源图", questionIds: ["q-child"], imageRef }] }] };
  await connect(page); await openTask(page);
  await expect(page.getByText(/这是部分结果/)).toBeVisible(); await expect(page.getByText("保留失败单元；参考答案缺失。", { exact: true })).toBeVisible();
  await page.locator("details.question-card").filter({ hasText: "根据材料选择答案" }).locator("summary").click();
  await expect(page.getByText("未提供（null），不会补写答案", { exact: true })).toBeVisible(); await expect(page.getByText("共享选项一", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "所属材料 · q-material", exact: true })).toBeVisible();
  await page.locator("details.question-card").filter({ hasText: "题干未提供（null）" }).locator("summary").click();
  await expect(page.getByText("<script>window.documentInjected=true</script>", { exact: true })).toBeVisible(); expect(await page.evaluate(() => (window as any).documentInjected)).toBeUndefined();
  await page.getByRole("button", { name: "来源与资源", exact: true }).click(); await expect(page.getByRole("region", { name: "解析结果检查" }).getByText(/"questionId": "q-child"/).first()).toBeVisible();
  expect(http.calls.some(call => call.path === "/api/artifacts/read")).toBe(false);
  await page.getByRole("button", { name: "查看图片", exact: true }).click(); const image = page.getByRole("img", { name: "已校验来源图", exact: true });
  await expect(image).toHaveAttribute("src", /^blob:/); await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true);
  expect(http.calls.find(call => call.path === "/api/artifacts/read")).toMatchObject({ authenticated: true, body: imageRef });
  const downloading = page.waitForEvent("download"); await page.getByRole("button", { name: "下载题库 ZIP", exact: true }).click(); const downloaded = await downloading;
  expect(downloaded.suggestedFilename()).toBe(`practiq-bank-${taskId}.zip`); expect(await readFile((await downloaded.path())!)).toEqual(zip);
  expect(http.calls.find(call => call.path.endsWith("/export"))).toMatchObject({ method: "GET", authenticated: true, query: "?checkpoint_id=checkpoint-one&scope=full" });
  expect(starts(http.calls)).toHaveLength(0); expect(http.calls.some(call => /\/(control|reparse)$/.test(call.path))).toBe(false); expect(external).toEqual([]);
});

for (const width of [1280, 360]) {
  test(`error messages and retry controls remain readable at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const http = await fakeHTTP(page);
    let fail = true, reads = 0;
    http.server.intercept = async (route, call) => {
      if (call.path === "/api/import-capabilities" && ++reads > 1 && fail) {
        await respond(route, { detail: { code: "TEMPORARILY_UNAVAILABLE_" + "X".repeat(40) } }, 503);
        return true;
      }
      return false;
    };
    await page.goto("/");
    await page.getByLabel("服务访问令牌").fill(fakeToken);
    await page.getByRole("button", { name: "连接服务", exact: true }).click();
    const retry = page.getByRole("button", { name: "重试读取服务能力", exact: true });
    const banner = page.getByRole("alert").filter({ has: retry });
    await expect(banner).toBeVisible();
    const text = await banner.locator("span").boundingBox(), button = await retry.boundingBox();
    expect(text!.width).toBeGreaterThan(width === 360 ? 240 : 280);
    if (width === 360) expect(button!.y).toBeGreaterThanOrEqual(text!.y + text!.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await banner.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`error-retry-${width}.png`), animations: "disabled" });
    fail = false;
    await retry.click();
    await expect(banner).toHaveCount(0);
    expect(mutations(http.calls)).toHaveLength(0);
  });
}

test("failed reads retry explicitly and stale pages cannot overwrite a new filter", async ({ page }) => {
  const http = await fakeHTTP(page); let fail = true; let release: (() => Promise<void>) | undefined;
  http.server.hasMore = true;
  http.server.intercept = async (route, call) => {
    if (call.path === "/api/document-tasks" && call.method === "GET") {
      if (fail) { fail = false; await respond(route, { detail: { code: "TEMPORARILY_UNAVAILABLE" } }, 503); return true; }
      if (call.query.includes("offset=20")) { await new Promise<void>(resolve => { release = async () => { try { await respond(route, { items: [summary], hasMore: false }); } catch { /* The obsolete request was aborted. */ } resolve(); }; }); return true; }
      if (call.query.includes("state_filter=failed")) { await respond(route, { items: [{ ...summary, threadId: newTaskId, fileName: "current-failed.pdf", state: "FAILED" }], hasMore: false }); return true; }
    }
    return false;
  };
  await connect(page); await page.getByRole("button", { name: "重试任务列表", exact: true }).click(); await expect(page.getByRole("button", { name: /sample.docx/ })).toBeVisible();
  await page.getByRole("button", { name: "下一页任务", exact: true }).click(); await expect.poll(() => !!release).toBe(true);
  await chooseOption(page.getByLabel("筛选任务状态"), "failed"); await expect(page.getByRole("button", { name: /current-failed.pdf/ })).toBeVisible();
  await release!(); await expect(page.getByRole("button", { name: /sample.docx/ })).toHaveCount(0); await expect(page.getByText("第 1 页", { exact: true })).toBeVisible();
  expect(mutations(http.calls)).toHaveLength(0);
});

test("expired task deletion stays explicit and recoverable when detail and preview return 410", async ({ page }) => {
  const http = await fakeHTTP(page, { ...task, state: "EXPIRED", allowedActions: [] }); let failDelete = true;
  let release: (() => Promise<void>) | undefined;
  http.server.intercept = async (route, call) => {
    if (call.path === `/api/document-tasks/${taskId}` && call.method === "DELETE" && failDelete) {
      failDelete = false;
      await new Promise<void>(resolve => { release = async () => { await respond(route, { detail: { code: "DELETE_UNAVAILABLE" } }, 503); resolve(); }; });
      return true;
    }
    if (call.method === "GET" && [`/api/document-tasks/${taskId}`, `/api/document-tasks/${taskId}/preview`].includes(call.path)) { await respond(route, { detail: { code: "TASK_EXPIRED" } }, 410); return true; }
    return false;
  };
  await connect(page); await page.getByRole("button", { name: /sample.docx.*已过期/ }).click();
  await expect(page.getByRole("button", { name: "重试任务详情", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "删除已过期任务 sample.docx", exact: true }).click();
  expect(mutations(http.calls)).toHaveLength(0);
  await page.getByRole("button", { name: "保留任务", exact: true }).click();
  await expect(page.getByRole("group", { name: "删除任务确认" })).toHaveCount(0);
  await page.getByRole("button", { name: "删除已过期任务 sample.docx", exact: true }).click();
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(page.getByRole("button", { name: "确认删除", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "保留任务", exact: true })).toBeDisabled();
  await expect.poll(() => typeof release).toBe("function"); await release!();
  await expect(page.getByText(/DELETE_UNAVAILABLE/)).toBeVisible();
  await expect(page.getByRole("group", { name: "删除任务确认" })).toBeVisible();
  expect(http.records.has(taskId)).toBe(true);
  await page.clock.install(); await page.clock.runFor(6000);
  expect(mutations(http.calls).map(call => call.method)).toEqual(["DELETE"]);
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(page.getByText("任务已删除。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "删除已过期任务 sample.docx", exact: true })).toHaveCount(0);
  await expect(page.getByText("选择一个任务查看结果", { exact: true })).toBeVisible();
  expect(mutations(http.calls).map(call => call.method)).toEqual(["DELETE", "DELETE"]);
  expect(http.records.has(taskId)).toBe(false); expect(http.server.modelStarts).toBe(0);
});

test("reparse and delete require explicit actions and delete confirmation", async ({ page }) => {
  const http = await fakeHTTP(page); await connect(page); await openTask(page);
  expect(mutations(http.calls)).toHaveLength(0);
  await page.getByText("其他任务操作", { exact: true }).click();
  await page.getByRole("button", { name: "删除任务", exact: true }).click(); expect(http.calls.some(call => call.method === "DELETE")).toBe(false); await page.getByRole("button", { name: "保留任务", exact: true }).click();
  await page.getByRole("button", { name: "重新解析为新任务", exact: true }).click(); await expect(page.getByRole("heading", { name: "reparsed.docx", exact: true })).toBeVisible();
  expect(http.calls.filter(call => call.path.endsWith("/reparse"))).toHaveLength(1); expect(http.server.modelStarts).toBe(1);
  await openTask(page); await page.getByText("其他任务操作", { exact: true }).click(); await page.getByRole("button", { name: "删除任务", exact: true }).click(); await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(page.getByText("任务已删除。", { exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: /sample.docx/ })).toHaveCount(0); expect(http.calls.filter(call => call.method === "DELETE")).toHaveLength(1);
});

test("server format, byte limit, and model availability gate submission before any upload", async ({ page }) => {
  const http = await fakeHTTP(page);
  http.server.intercept = async (route, call) => {
    if (call.path === "/api/import-capabilities") { await respond(route, { ...capabilities, sourceTypes: ["text"], sourceMaxBytes: 1, modelConfigured: false, officeAvailable: false, officeModes: [] }); return true; } return false; };
  await connect(page); await expect(page.getByLabel("Word / Excel 转换模式")).toHaveCount(0);
  await expect(page.getByText("服务支持：TXT", { exact: true })).toBeVisible();
  await page.getByLabel("选择文档").setInputFiles({ name: "too-large.txt", mimeType: "text/plain", buffer: Buffer.from("xx") }); await expect(page.getByText(/为空或超过/)).toBeVisible();
  await page.getByLabel("选择文档").setInputFiles({ name: "small.txt", mimeType: "text/plain", buffer: Buffer.from("x") }); await expect(page.getByRole("button", { name: "开始导入", exact: true })).toBeDisabled();
  await expect(page.getByText(/服务端尚未配置模型/)).toBeVisible(); expect(mutations(http.calls)).toHaveLength(0);
});

test("empty task guidance preserves keyboard focus and only reads when clearing a filter", async ({ page }) => {
  const http = await fakeHTTP(page);
  http.records.clear();
  await connect(page);
  await page.getByRole("button", { name: "选择第一份文档" }).click();
  await expect(page.getByLabel("选择文档")).toBeFocused();
  await chooseOption(page.getByLabel("筛选任务状态"), "failed");
  await expect(page.getByText("没有符合此状态的任务。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "查看全部任务" }).click();
  await expect(page.getByLabel("筛选任务状态")).toHaveAttribute('data-value', "");
  await expect(page.getByRole("button", { name: "选择第一份文档" })).toBeVisible();
  expect(mutations(http.calls)).toHaveLength(0);
});

for(const width of [375,768,1440]) {
  test(`import and review workspace supports passive filtering and file removal at ${width}px`, async ({page},testInfo)=>{
    await page.setViewportSize({width,height:1000});
    const http=await fakeHTTP(page); await connect(page);
    await page.getByLabel('选择文档').setInputFiles([{name:'remove.txt',mimeType:'text/plain',buffer:Buffer.from('a')},{name:'keep.txt',mimeType:'text/plain',buffer:Buffer.from('b')}]);
    await page.getByRole('button',{name:'移除文件 remove.txt',exact:true}).click();
    await expect(page.getByText('remove.txt',{exact:true})).toHaveCount(0);
    await openTask(page);
    await page.getByRole('searchbox',{name:'搜索解析题目',exact:true}).fill('共享选项一');
    await page.getByRole('checkbox',{name:'仅看需要复核',exact:true}).check();
    await page.locator('details.question-card').filter({hasText:'根据材料选择答案'}).locator('summary').click();
    await expect(page.getByRole('heading',{name:'所属材料 · q-material',exact:true})).toBeVisible();
    await page.screenshot({path:testInfo.outputPath(`review-filtered-${width}.png`),fullPage:true});
    await expect(page.getByRole('button',{name:'重新解析为新任务',exact:true})).toBeHidden();
    await page.getByText('其他任务操作',{exact:true}).click();
    await expect(page.getByRole('button',{name:'重新解析为新任务',exact:true})).toBeVisible();
    expect(mutations(http.calls)).toHaveLength(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  });
}

test('import workspace tokens preserve readable text in light and dark surfaces',async({page},testInfo)=>{
  await fakeHTTP(page);await connect(page);await openTask(page);
  for(const theme of ['light','dark']) {
    await page.evaluate(value=>document.documentElement.classList.toggle('dark',value==='dark'),theme);
    const pairs=await page.evaluate(()=>{
      const root=getComputedStyle(document.documentElement), canvas=document.createElement('canvas'), context=canvas.getContext('2d')!;
      const light=(token:string)=>{context.fillStyle=root.getPropertyValue(token).trim();context.fillRect(0,0,1,1);return [...context.getImageData(0,0,1,1).data].slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);};
      return [['--foreground','--background',4.5],['--muted-foreground','--card',4.5],['--primary-foreground','--primary',4.5],['--warning-foreground','--warning-background',4.5],['--error-foreground','--error-background',4.5],['--input','--card',3]].map(([a,b,min])=>{const x=light(a as string),y=light(b as string);return {a,b,min,ratio:(Math.max(x,y)+.05)/(Math.min(x,y)+.05)};});
    });
    for(const {a,b,min,ratio} of pairs)expect(ratio,`${theme}: ${a} on ${b}`).toBeGreaterThanOrEqual(min as number);
    const colors=await page.evaluate(()=>{const root=getComputedStyle(document.documentElement);return {primary:root.getPropertyValue('--primary').trim(),foreground:root.getPropertyValue('--foreground').trim()};});
    const exportButton=page.getByRole('button',{name:'下载题库 ZIP',exact:true});
    const expectedPrimary=await exportButton.evaluate((element,color)=>{const probe=document.createElement('span');probe.style.backgroundColor=color;document.body.append(probe);const value=getComputedStyle(probe).backgroundColor;probe.remove();return value;},colors.primary);
    await expect(exportButton).toHaveCSS('background-color',expectedPrimary);
    const badge=page.locator('[data-slot=badge][data-variant=outline]').first();
    const expectedForeground=await badge.evaluate((element,color)=>{const probe=document.createElement('span');probe.style.color=color;document.body.append(probe);const value=getComputedStyle(probe).color;probe.remove();return value;},colors.foreground);
    await expect(badge).toHaveCSS('color',expectedForeground);
    await exportButton.hover();
    const hoverContrast=await exportButton.evaluate(element=>{
      const style=getComputedStyle(element), root=getComputedStyle(document.documentElement), canvas=document.createElement('canvas'), context=canvas.getContext('2d')!;
      const luminance=(rgba:number[])=>rgba.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
      context.fillStyle=root.getPropertyValue('--card'); context.fillRect(0,0,1,1);
      context.fillStyle=style.backgroundColor; context.fillRect(0,0,1,1);
      const background=luminance([...context.getImageData(0,0,1,1).data]);
      context.fillStyle=style.color; context.fillRect(0,0,1,1);
      const foreground=luminance([...context.getImageData(0,0,1,1).data]);
      return (Math.max(foreground,background)+.05)/(Math.min(foreground,background)+.05);
    });
    expect(hoverContrast,`${theme}: primary button hover`).toBeGreaterThanOrEqual(4.5);
    await page.mouse.move(0,0);
    await page.screenshot({path:testInfo.outputPath(`workspace-${theme}.png`),fullPage:true});
  }
});

test('delete confirmation moves into view and Escape restores its trigger without a mutation',async({page})=>{
  const http=await fakeHTTP(page);await connect(page);await openTask(page);
  await page.getByText('其他任务操作',{exact:true}).click();
  const remove=page.getByRole('button',{name:'删除任务',exact:true});
  await remove.click();
  await expect(page.getByRole('group',{name:'删除任务确认',exact:true})).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('group',{name:'删除任务确认',exact:true})).toHaveCount(0);
  await expect(remove).toBeFocused();
  expect(mutations(http.calls)).toHaveLength(0);
});

for (const entry of ["detail", "expired"] as const) {
  test(`successful ${entry} deletion leaves focus on the surviving task list heading`, async ({ page }) => {
    const http = await fakeHTTP(page, entry === "expired" ? { ...task, state: "EXPIRED" } : task);
    await connect(page);
    if (entry === "detail") {
      await openTask(page);
      await page.getByText("其他任务操作", { exact: true }).click();
      await page.getByRole("button", { name: "删除任务", exact: true }).click();
    } else {
      await page.getByRole("button", { name: "删除已过期任务 sample.docx", exact: true }).click();
    }
    await page.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(page.getByRole("button", { name: /sample.docx/ })).toHaveCount(0);
    await expect(page.locator("#task-list-heading")).toBeFocused();
    expect(mutations(http.calls).map(call => call.method)).toEqual(["DELETE"]);
  });
}



async function captureReview(page: Page, card: ReturnType<Page['locator']>, prefix: string, testInfo: { outputPath: (name: string) => string }) {
  const range = await card.evaluate(e => ({ top: e.getBoundingClientRect().top + scrollY, height: (e as HTMLElement).offsetHeight, header: document.querySelector('.web-header')!.getBoundingClientRect().height }));
  const step = Math.max(80, (await page.evaluate(() => innerHeight)) - range.header - 32);
  for (let part = 0; part < Math.ceil(range.height / step); part++) {
    await page.evaluate(top => scrollTo(0, top), range.top - range.header - 16 + part * step);
    await page.screenshot({ path: testInfo.outputPath(`${prefix}-${part}.png`) });
  }
}
for (const [width, height] of layoutViewports) {
  test(`all reviewed question layouts at ${width}x${height}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height });
    const questions = layoutSnapshots.map((snapshot, index) => ({ ...snapshot.question, id: `layout-${index}`, parentId: null, optionSourceId: null, passage: snapshot.materials.flatMap(material => material.passage || material.contentBlocks || []) }));
    const http = await fakeHTTP(page, { ...task, result: { ...task.result!, questions } });
    http.server.review = { ...preview, units: [{ ...preview.units[0], questions, visualElements: [layoutSnapshots.at(-1)!.visuals[0]] }] };
    http.server.intercept = async (route, call) => {
      if (call.path !== '/api/artifacts/read') return false;
      await route.fulfill({ contentType: 'image/png', body: layoutImage });
      return true;
    };
    await connect(page);
    await page.getByRole('button', { name: /sample.docx/ }).click();
    await expect(page.locator('.question-card')).toHaveCount(layoutSnapshots.length);
    for (let index = 0; index < layoutSnapshots.length; index++) {
      const card = page.locator('.question-card').nth(index);
      await card.locator(':scope > summary').click();
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await card.locator('.document-content,.option-row').evaluateAll(elements => elements.filter(e => e.clientWidth && e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflowX === 'visible').length)).toBe(0);
      await expect(page.locator('.katex-error')).toHaveCount(0);
      expect(await card.locator('.katex-display').evaluateAll(elements => elements.filter(e => e.querySelector('.katex-html')!.getBoundingClientRect().left < e.getBoundingClientRect().left - 1).length)).toBe(0);
      expect(await card.locator('.katex-display,.document-content table').evaluateAll(elements => elements.filter(e => {
        if (e.scrollWidth <= e.clientWidth + 2) return false;
        e.scrollLeft = e.scrollWidth;
        const last = e.matches('table') ? e.querySelector('tbody tr:last-child td:last-child') : [...e.querySelectorAll('.katex-html')].at(-1);
        const clipped = last!.getBoundingClientRect().right > e.getBoundingClientRect().right + 2;
        e.scrollLeft = 0;
        return clipped;
      }).length)).toBe(0);
      await captureReview(page, card, layoutSnapshots[index].key, testInfo);
      await card.locator(':scope > summary').click();
    }
    await page.getByRole('button', { name: '来源与资源', exact: true }).click();
    await page.getByRole('button', { name: '查看图片', exact: true }).first().click();
    const image = page.locator('figure.resource-card img');
    await expect.poll(() => image.evaluate(img => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0)).toBe(true);
    await page.locator('figure.resource-card').first().screenshot({ path: testInfo.outputPath('image.png') });
    expect(errors).toEqual([]);
    expect(starts(http.calls)).toHaveLength(0);
    expect(mutations(http.calls).filter(call => call.path !== '/api/artifacts/read')).toHaveLength(0);
  });
}

for (const width of [1440, 390]) {
  test(`error recovery and result isolation at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 950 });
    const http = await fakeHTTP(page);
    http.server.intercept = async (route, call) => {
      if (call.path.endsWith('/reparse')) { await respond(route, { detail: { code: 'SERVER_UNAVAILABLE' } }, 503); return true; }
      return false;
    };
    await connect(page); await openTask(page);
    await page.getByText('其他任务操作', { exact: true }).click();
    await page.getByRole('button', { name: '重新解析为新任务', exact: true }).click();
    const error = page.getByRole('alert').filter({ hasText: '操作结果尚未确认' });
    await expect(error).toBeInViewport({ ratio: 1 });
    await expect.poll(async () => {
      const banner = await error.boundingBox(), header = await page.locator('.web-header').boundingBox();
      return !!banner && !!header && banner.y >= header.y + header.height && banner.y + banner.height <= 950;
    }).toBe(true);
    expect(mutations(http.calls)).toHaveLength(1);
    await page.screenshot({ path: testInfo.outputPath(`web-action-error-${width}.png`) });
    await page.route('**/src/ResultReview.tsx', route => route.abort('failed'));
    await page.reload();
    await expect(page.getByLabel('服务访问令牌')).toHaveValue('');
    await page.getByLabel('服务访问令牌').fill(fakeToken);
    await page.getByRole('button', { name: '连接服务', exact: true }).click();
    await page.getByRole('button', { name: /sample.docx/ }).click();
    await expect(page.getByRole('heading', { name: '此界面暂时无法显示', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '下载题库 ZIP', exact: true })).toBeEnabled();
    expect(mutations(http.calls)).toHaveLength(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('heading', { name: '此界面暂时无法显示', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`web-result-failure-${width}.png`) });
  });
}

for (const stage of ['metadata', 'content']) {
  test(`upload transport recovery stays explicit before a task exists (${stage})`, async ({ page }, testInfo) => {
    const http = await fakeHTTP(page); let fail = true;
    http.server.intercept = async (route, call) => {
      if (fail && call.path === (stage === 'metadata' ? '/api/uploads' : '/api/uploads/content')) { await route.abort('failed'); return true; }
      return false;
    };
    await connect(page);
    await page.getByLabel('选择文档').setInputFiles({ name: 'retry-upload.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic upload') });
    await page.getByRole('button', { name: '开始导入', exact: true }).click();
    await expect(page.getByText('文件上传未确认，请检查连接后手动重试上传。', { exact: true })).toBeVisible();
    expect(starts(http.calls)).toHaveLength(0);
    await page.screenshot({ path: testInfo.outputPath(`upload-recovery-${stage}.png`) });
    fail = false;
    await page.getByRole('button', { name: '重试开始', exact: true }).click();
    await expect(page.getByText(/任务已创建。页面/)).toBeVisible();
    expect(starts(http.calls)).toHaveLength(1);
    expect(http.server.modelStarts).toBe(1);
  });
}

test("file picker text stays centered across control sizes and themes", async ({ page }, testInfo) => {
  const http = await fakeHTTP(page); await connect(page);
  const input = page.getByLabel("选择文档", { exact: true });
  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({ width, height: 950 });
    for (const dark of [false, true]) {
      await page.evaluate(value => document.documentElement.classList.toggle("dark", value), dark);
      for (const selected of [false, true]) {
        await input.setInputFiles(selected ? { name: "文件选择控件-vertical-alignment-and-long-name.txt", mimeType: "text/plain", buffer: Buffer.from("Synthetic layout fixture") } : []);
        const geometry = await input.evaluate(node => {
          const style = getComputedStyle(node), button = getComputedStyle(node, "::file-selector-button");
          const number = (value: string) => parseFloat(value);
          return { height: node.getBoundingClientRect().height, paddingTop: number(style.paddingTop), paddingBottom: number(style.paddingBottom),
            content: node.clientHeight - number(style.paddingTop) - number(style.paddingBottom), lineHeight: number(style.lineHeight),
            buttonHeight: number(button.height), buttonLineHeight: number(button.lineHeight), font: style.fontSize, buttonFont: button.fontSize };
        });
        expect(geometry.height).toBe(width < 768 ? 48 : 40);
        expect(Math.abs(geometry.paddingTop - geometry.paddingBottom)).toBeLessThanOrEqual(1);
        expect(geometry.lineHeight).toBe(geometry.content);
        expect(geometry.buttonHeight).toBe(geometry.content);
        expect(geometry.buttonLineHeight).toBe(geometry.content);
        expect(geometry.buttonFont).toBe(geometry.font);
        const otherControls = await page.locator("button[data-button], [data-slot='badge']").evaluateAll(nodes => nodes.map(node => {
          const style = getComputedStyle(node); return { align: style.alignItems, top: style.paddingTop, bottom: style.paddingBottom };
        }));
        expect(otherControls.every(control => control.align === "center" && control.top === control.bottom)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(mutations(http.calls)).toHaveLength(0);
        if (selected) await input.screenshot({ path: testInfo.outputPath(`file-picker-${width}-${dark ? "dark" : "light"}.png`) });
      }
      await input.focus(); await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
      await expect(input).toBeFocused();
      await input.evaluate(node => { (node as HTMLInputElement).disabled = true; });
      expect(await input.evaluate(node => parseFloat(getComputedStyle(node, "::file-selector-button").height))).toBe(width < 768 ? 46 : 38);
      await input.evaluate(node => { (node as HTMLInputElement).disabled = false; });
    }
  }
});

for (const width of [1440, 390]) test(`uncertain duplicate batch stops and failed files can be discarded at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 1040 });
  await page.clock.install();
  const http = await fakeHTTP(page); let requestId: string | undefined;
  http.server.intercept = async (route, call) => {
    if (call.path !== "/api/document-tasks" || call.method !== "POST") return false;
    if (!requestId) { requestId = call.body!.requestId; http.server.modelStarts++; }
    expect(call.body!.requestId).toBe(requestId);
    http.records.set(newTaskId, { ...task, threadId: newTaskId, fileName: "same.txt" });
    const attempt = starts(http.calls).length;
    await respond(route, { threadId: newTaskId, requestId, runId: attempt === 2 ? null : runId, accepted: attempt !== 1 }, 202);
    return true;
  };
  await connect(page);
  const file = { name: "same.txt", mimeType: "text/plain", buffer: Buffer.from("same") };
  await page.getByLabel("选择文档").setInputFiles([file, file]);
  await page.getByRole("button", { name: "开始导入", exact: true }).click();
  await expect(page.getByText(/任务操作回执无效，结果尚未确认/)).toBeVisible();
  await page.clock.fastForward(30000);
  expect(starts(http.calls)).toHaveLength(1);
  await expect(page.locator(".file-list").getByText(/尚未提交/)).toHaveCount(1);
  await page.getByRole("button", { name: "重试开始", exact: true }).click();
  await expect(page.getByRole("button", { name: "重试开始", exact: true })).toBeEnabled();
  expect(starts(http.calls)).toHaveLength(2);
  await expect(page.getByText(/任务已创建。页面/)).toHaveCount(0);
  const failed = page.locator(".file-list > li").filter({ has: page.getByRole("button", { name: "重试开始", exact: true }) });
  await failed.scrollIntoViewIfNeeded();
  await expect(page.getByText(/移除文件只清理本页队列，不会取消服务端任务/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: testInfo.outputPath(`failed-file-${width}.png`), fullPage: true });
  const mutationCount = mutations(http.calls).length;
  await failed.getByRole("button", { name: "移除文件 same.txt", exact: true }).click();
  await expect(page.getByRole("button", { name: "重试开始", exact: true })).toHaveCount(0);
  expect(mutations(http.calls)).toHaveLength(mutationCount);
  await page.getByRole("button", { name: "开始导入", exact: true }).click();
  await expect(page.getByRole("heading", { name: "same.txt", exact: true })).toBeVisible();
  expect(starts(http.calls)).toHaveLength(3);
  expect(starts(http.calls).every(call => call.body!.requestId === requestId)).toBe(true);
  expect(http.server.modelStarts).toBe(1);
});

test("a malformed accepted reparse receipt keeps its original request until explicit retry", async ({ page }) => {
  await page.clock.install();
  const http = await fakeHTTP(page); let requestId: string | undefined;
  http.server.intercept = async (route, call) => {
    if (!call.path.endsWith("/reparse")) return false;
    if (!requestId) {
      requestId = call.body!.requestId;
      http.server.modelStarts++;
      http.records.set(newTaskId, { ...task, threadId: newTaskId, fileName: "reparsed.docx" });
      await respond(route, {}, 202);
    } else {
      expect(call.body!.requestId).toBe(requestId);
      await respond(route, { threadId: newTaskId, requestId, runId, accepted: true }, 202);
    }
    return true;
  };
  await connect(page); await openTask(page);
  await page.getByText("其他任务操作", { exact: true }).click();
  await page.getByRole("button", { name: "重新解析为新任务", exact: true }).click();
  await expect(page.getByText(/任务操作回执无效，结果尚未确认/)).toBeVisible();
  await page.clock.fastForward(30000);
  expect(http.calls.filter(call => call.path.endsWith("/reparse"))).toHaveLength(1);
  await page.getByRole("button", { name: "重新解析为新任务", exact: true }).click();
  await expect(page.getByRole("heading", { name: "reparsed.docx", exact: true })).toBeVisible();
  expect(http.calls.filter(call => call.path.endsWith("/reparse"))).toHaveLength(2);
  expect(http.server.modelStarts).toBe(1);
});
