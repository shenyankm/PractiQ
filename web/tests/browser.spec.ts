import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type Page, type Route } from "playwright/test";
import type { DocumentTaskDetail, DocumentTaskReview } from "../src/contracts.generated";
import { capabilities, newTaskId, preview, runId, summary, task, taskId } from "../src/test-fixtures";

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
      const document = { ...metadata, objectKey: `practiq-agent/sources/${metadata.sha256}/source.${metadata.sourceType === "text" ? "txt" : metadata.sourceType}` };
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
  await page.goto("/"); await page.getByLabel("服务 Token").fill(fakeToken); await page.getByRole("button", { name: "连接服务", exact: true }).click();
  await expect(page.getByText("服务已连接", { exact: true })).toBeVisible();
}
async function openTask(page: Page) {
  await page.getByRole("button", { name: /sample.docx/ }).click();
  await expect(page.getByRole("heading", { name: "sample.docx", exact: true })).toBeVisible();
  await expect(page.getByText("根据材料选择答案", { exact: true })).toBeVisible();
}
const mutations = (calls: Call[]) => calls.filter(call => call.method !== "GET");
const starts = (calls: Call[]) => calls.filter(call => call.path === "/api/document-tasks" && call.method === "POST");

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
  await page.goto("/"); expect(http.calls).toHaveLength(0); await connect(page);
  await page.getByLabel("Word / Excel 转换模式").selectOption("text");
  const bytes = Buffer.from("synthetic office file");
  await page.getByLabel("选择文档").setInputFiles({ name: "selected.docx", mimeType: "application/octet-stream", buffer: bytes });
  await expect(page.getByText(/尚未提交/)).toBeVisible(); expect(mutations(http.calls)).toHaveLength(0);
  await page.getByRole("button", { name: "开始导入", exact: true }).click();
  await expect(page.getByText(/任务已创建。页面/)).toBeVisible();
  expect(mutations(http.calls).map(call => call.method)).toEqual(["POST", "PUT", "POST"]);
  expect(mutations(http.calls)[0].body).toMatchObject({ sourceType: "docx", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sizeBytes: bytes.length, sha256: digest(bytes) });
  expect(starts(http.calls)[0].body).toMatchObject({ officeMode: "text", graphId: "document_parser", failurePolicy: "return_partial" });
  expect(http.calls.every(call => call.authenticated && !call.query.includes(fakeToken))).toBe(true);
  expect(http.server.modelStarts).toBe(1);
});

test("invalid auth makes no model request; disconnect and reload clear memory-only Token", async ({ page }) => {
  const http = await fakeHTTP(page); await page.goto("/");
  await page.getByLabel("服务 Token").fill("invalid-synthetic-token"); await page.getByRole("button", { name: "连接服务", exact: true }).click();
  await expect(page.getByText(/服务 Token 无效/).first()).toBeVisible();
  expect(mutations(http.calls)).toHaveLength(0);
  await page.getByRole("button", { name: "断开连接", exact: true }).click(); await expect(page.getByLabel("服务 Token")).toHaveValue("");
  await page.getByLabel("服务 Token").fill(fakeToken); await page.getByRole("button", { name: "连接服务", exact: true }).click();
  await expect(page.getByText("服务已连接", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, query: location.search }))).toEqual({ local: 0, session: 0, query: "" });
  await page.reload(); await expect(page.getByLabel("服务 Token")).toHaveValue("");
  expect(await page.locator("body").innerText()).not.toContain(fakeToken);
});

test("uncertain accepted POST never auto replays; explicit retry preserves requestId and Office mode", async ({ page }) => {
  await page.clock.install();
  const http = await fakeHTTP(page); let lose = true;
  http.server.intercept = async (route, call) => {
    if (call.path === "/api/document-tasks" && call.method === "POST" && lose) {
      lose = false; http.creates.set(call.body!.requestId, newTaskId); http.server.modelStarts++; http.records.set(newTaskId, { ...task, threadId: newTaskId, fileName: "uncertain.docx" });
      await route.abort("failed"); return true;
    }
    return false;
  };
  await connect(page); await page.getByLabel("Word / Excel 转换模式").selectOption("text");
  await page.getByLabel("选择文档").setInputFiles({ name: "uncertain.docx", mimeType: "application/octet-stream", buffer: Buffer.from("fake office") });
  await page.getByRole("button", { name: "开始导入", exact: true }).click(); await expect(page.getByRole("button", { name: "重试开始", exact: true })).toBeVisible();
  const reads = http.calls.filter(call => call.method === "GET").length;
  await page.clock.fastForward(30000);
  await expect.poll(() => http.calls.filter(call => call.method === "GET").length).toBeGreaterThan(reads);
  expect(starts(http.calls)).toHaveLength(1); await expect(page.getByLabel("Word / Excel 转换模式")).toBeDisabled();
  await page.getByRole("button", { name: "重试开始", exact: true }).click(); await expect(page.getByText(/任务已创建。页面/)).toBeVisible();
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
  expect(http.calls.find(call => call.path.endsWith("/export"))).toMatchObject({ method: "GET", authenticated: true, query: "?checkpoint_id=checkpoint-one" });
  expect(starts(http.calls)).toHaveLength(0); expect(http.calls.some(call => /\/(control|reparse)$/.test(call.path))).toBe(false); expect(external).toEqual([]);
});

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
  await page.getByLabel("筛选任务状态").selectOption("failed"); await expect(page.getByRole("button", { name: /current-failed.pdf/ })).toBeVisible();
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
  http.server.intercept = async (route, call) => { if (call.path === "/api/import-capabilities") { await respond(route, { ...capabilities, sourceTypes: ["text"], sourceMaxBytes: 1, modelConfigured: false, officeAvailable: false, officeModes: [] }); return true; } return false; };
  await connect(page); await expect(page.getByLabel("Word / Excel 转换模式")).toHaveCount(0);
  await expect(page.getByText("服务支持：TXT。Office 转换当前不可用。", { exact: true })).toBeVisible();
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
  await page.getByLabel("筛选任务状态").selectOption("failed");
  await expect(page.getByText("没有符合此状态的任务。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "查看全部任务" }).click();
  await expect(page.getByLabel("筛选任务状态")).toHaveValue("");
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
    await expect(badge).toHaveCSS('color',colors.foreground);
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
