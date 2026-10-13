// Run only after both roots have fresh production builds; no build or model work occurs here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { arch, platform, release } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const baselineProbe = process.argv.includes("--baseline-probe");
const [baselineArg, candidateArg, outputArg] = process.argv.slice(2).filter(value => value !== "--baseline-probe");
assert(baselineArg && candidateArg && outputArg, "usage: node measure_web_usage.mjs [--baseline-probe] BASELINE_ROOT CANDIDATE_ROOT NEW_OUTPUT_JSON (AI_PYTHON required)");
const baselineRoot = resolve(baselineArg), candidateRoot = resolve(candidateArg), output = resolve(outputArg);
assert(!existsSync(output), `Refusing to replace ${output}`);
assert(process.env.AI_PYTHON, "Set AI_PYTHON to the existing Python 3.14+ interpreter");
const require = createRequire(join(candidateRoot, "web/package.json"));
const { chromium } = require("playwright");
const fixtureSource = readFileSync(join(candidateRoot, "web/src/test-fixtures.ts"), "utf8");
const fixtureCode = stripTypeScriptTypes(fixtureSource);
const fixtures = await import(`data:text/javascript;base64,${Buffer.from(fixtureCode).toString("base64")}`);
const fixedTask = structuredClone(fixtures.task);
const questions = Array.from({ length: 1000 }, (_, index) => fixtures.question({
  id: `performance-question-${String(index).padStart(4, "0")}`,
  parentId: null, optionSourceId: null, stem: `Performance question ${String(index).padStart(4, "0")}`,
  sourceText: `Literal source for question ${index}`, options: [{ label: "A", content: "Document option" }], confidence: 0.72,
}));
const questionSources = questions.flatMap(question => Array.from({ length: 10 }, (_, unitIndex) => ({ questionId: question.id, stage: "document_parse", unitIndex })));
const quality = { reviewRequired: true, reviewQuestionCount: 1000, issues: questions.flatMap(question => ["MISSING_FIELDS", "NEEDS_REVIEW"].map(code => ({ questionId: question.id, code }))) };
Object.assign(fixedTask, {
  fileName: "performance-1000.txt", failures: [], status: "SUCCEEDED",
  updatedAt: "2026-10-13T12:00:00Z", expiresAt: "2026-10-14T12:00:00Z",
  progress: { chunks: { total: 10, succeeded: 10, failed: 0, remaining: 0 }, visuals: { total: 0, succeeded: 0, failed: 0, remaining: 0 } },
  processing: { chunks: { total: 10, succeeded: 10 }, visuals: { total: 0, succeeded: 0 }, truncated: false, failures: [], questionSources, quality },
  result: { ...fixedTask.result, questions, groups: [], visualElements: [], warnings: [], missingFields: [] },
});
const fixedPreview = { ...structuredClone(fixtures.preview), failures: [], quality, questionSources,
  units: [{ stage: "result", index: 0, questions, groups: [], visualElements: [], sourceRef: null }],
};
const input = JSON.stringify({ task: fixedTask, preview: fixedPreview });
assert(Buffer.byteLength(input) < 64 * 1024 * 1024);
const validated = spawnSync(process.env.AI_PYTHON, ["-c", "import json,sys; from practiq_ai.contracts import DocumentTaskDetail,DocumentTaskReview; x=json.load(sys.stdin); DocumentTaskDetail.model_validate(x['task']); DocumentTaskReview.model_validate(x['preview']); print(sys.version.split()[0])"], {
  input, encoding: "utf8", env: { ...process.env, PYTHONPATH: join(candidateRoot, "server/src") },
});
assert.equal(validated.status, 0, validated.stderr || validated.error?.message);
const digest = value => createHash("sha256").update(value).digest("hex");
const assets = root => {
  const dist = join(root, "web/dist");
  assert(existsSync(join(dist, "index.html")), `Missing production build: ${dist}`);
  const files = readdirSync(dist, { recursive: true }).filter(name => statSync(join(dist, name)).isFile());
  return Object.fromEntries(files.map(name => [name, { bytes: readFileSync(join(dist, name)).length, sha256: digest(readFileSync(join(dist, name))) }]));
};
const report = {
  mode: baselineProbe ? "baseline-probe" : "five-pairs",
  environment: { node: process.version, python: validated.stdout.trim(), machine: `${platform()} ${release()} ${arch()}` },
  roots: { baseline: baselineRoot, candidate: candidateRoot },
  sourceHashes: Object.fromEntries([baselineRoot, candidateRoot].map(root => [root, digest(readFileSync(join(root, "web/src/App.tsx")))])),
  assets: baselineProbe ? { baseline: assets(baselineRoot) } : { baseline: assets(baselineRoot), candidate: assets(candidateRoot) },
  workload: { questions: 1000, sourceAssociationsPerQuestion: 10, questionSources: 10000, qualityIssues: 2000, usageCalls: fixedTask.usage.length, inputBytes: Buffer.byteLength(input), inputSha256: digest(input) },
  scope: baselineProbe
    ? "One instrumented production Chromium baseline context against local Vite preview and authenticated synthetic GET responses. No natural-poll wait or candidate comparison. JSON.stringify call counts/durations only localize current diagnostic work; instrumented browser latency is not acceptance evidence. Not HTTP-service, real model, WebView, Android, or typical-provenance throughput evidence."
    : "Production Chromium against local Vite preview and authenticated synthetic GET responses. Each fresh browser context has cold HTTP cache; subsequent filters/diagnostic opening are warm. Browser event-to-two-requestAnimationFrame latency includes browser layout/paint scheduling and Playwright readiness round trips. Separate instrumentation localizes JSON.stringify work and is excluded from browser latency samples. One natural 30-second task-list poll per uninstrumented context is observed; no clock/timer acceleration. Not HTTP-service, real model, WebView, Android, or typical-provenance throughput evidence.",
  samples: [],
};
const save = () => writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(output.replace(/\.json$/, "-input.json"), `${input}\n`, { flag: "wx" });
const browser = await chromium.launch({ headless: true });
report.environment.chromium = browser.version();
const origin = "http://127.0.0.1:18671";
const token = "synthetic-performance-card";

async function measureContext(instrumented, screenshotPath) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1040 }, locale: "zh-CN", reducedMotion: "reduce" });
  const page = await context.newPage();
  const calls = [], errors = [];
  let currentTask = structuredClone(fixedTask);
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(({ instrumented }) => {
    window.__perf = { diagnosticStringify: [], listStarts: [], marks: {} };
    const originalFetch = window.fetch;
    window.fetch = function (...args) {
      if (new URL(String(args[0]), location.href).pathname === "/api/document-tasks") window.__perf.listStarts.push(performance.now());
      return originalFetch.apply(this, args);
    };
    if (instrumented) {
      const originalStringify = JSON.stringify;
      JSON.stringify = function (...args) {
        const value = args[0];
        if (!value || typeof value !== "object" || !Object.hasOwn(value, "usage") || !Object.hasOwn(value, "unknownUsageCalls") || !Object.hasOwn(value, "processing") || !Object.hasOwn(value, "blocking")) return originalStringify.apply(this, args);
        const start = performance.now();
        const result = originalStringify.apply(this, args);
        window.__perf.diagnosticStringify.push({ milliseconds: performance.now() - start, characters: result.length });
        return result;
      };
    }
  }, { instrumented });
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    const call = { method: request.method(), path: url.pathname, query: url.search, authenticated: request.headers().authorization === `Card ${token}`, phone: request.headers()["x-practiq-phone"] };
    calls.push(call);
    if (call.method !== "GET" || (call.path !== "/api/products" && (!call.authenticated || call.phone !== "13800138000"))) {
      errors.push(`Unexpected mutation/auth: ${JSON.stringify(call)}`); await route.abort(); return;
    }
    let value;
    if (call.path === "/api/products") value = { items: [] };
    else if (call.path === "/api/account") value = { phone: "+8613800138000", balanceMicropoints: "1000000", usageUnknown: false };
    else if (call.path === "/api/import-capabilities") value = fixtures.capabilities;
    else if (call.path === "/api/document-tasks") value = { items: [{ ...fixtures.summary, fileName: currentTask.fileName, state: currentTask.state, status: currentTask.status, createdAt: currentTask.updatedAt, expiresAt: currentTask.expiresAt, questionCount: 1000, reviewCount: 1000 }], hasMore: false, nextCursor: null };
    else if (call.path === `/api/document-tasks/${currentTask.threadId}`) value = currentTask;
    else if (call.path.endsWith("/preview")) value = fixedPreview;
    else if (call.path.endsWith("/head")) value = Object.fromEntries(["threadId", "runId", "state", "checkpointId", "updatedAt", "modelConfigured", "resumeCompatible"].map(key => [key, currentTask[key]]));
    else { errors.push(`Unexpected API: ${call.path}`); await route.abort(); return; }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
  });
  try {
    await page.goto(origin);
    await page.getByLabel("手机号").fill("13800138000");
    await page.getByLabel("卡密").fill(token);
    await page.getByRole("button", { name: "查询记录", exact: true }).click();
    await page.getByText("服务已连接", { exact: true }).waitFor();
    const row = page.getByRole("button", { name: /performance-1000.txt/ });
    await row.waitFor();
    async function mark(name, locator, event) {
      await locator.evaluate((element, { name, event }) => element.addEventListener(event, () => { window.__perf.marks[name] = performance.now(); }, { once: true, capture: true }), { name, event });
    }
    async function painted(name) {
      return page.evaluate(name => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - window.__perf.marks[name])))), name);
    }
    await mark("taskOpen", row, "click");
    await row.click();
    await page.getByRole("heading", { name: "解析结果 · 1000 条题目记录", exact: true }).waitFor();
    const coldTaskOpenMs = await painted("taskOpen");
    assert.equal(await page.locator("details.question-card").count(), 20);
    await page.getByText("显示 1000 / 1000 条记录。筛选不会修改复核标记或导出内容。", { exact: true }).waitFor();
    const diagnostics = page.locator("details.resource-card").filter({ has: page.locator("summary", { hasText: "模型用量与任务诊断" }) });
    assert.equal(await diagnostics.getAttribute("open"), null);
    const stringifyCounts = { afterTaskOpen: await page.evaluate(() => window.__perf.diagnosticStringify.length) };
    async function filters(state) {
      const values = [];
      const select = page.getByLabel("筛选任务状态");
      for (let index = 0; index < 5; index++) {
        const filter = await select.inputValue() === "completed" ? "" : "completed";
        const name = `${state}-filter-${index}`;
        await mark(name, select, "change");
        const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/document-tasks");
        await select.selectOption(filter);
        await response;
        await row.waitFor();
        values.push(await painted(name));
        assert.equal(await page.locator("details.question-card").count(), 20);
      }
      return values;
    }
    const closedFilterMs = await filters("closed");
    stringifyCounts.afterClosedFilters = await page.evaluate(() => window.__perf.diagnosticStringify.length);
    let naturalPollMs = null;
    if (!instrumented) {
      // The final completed filter starts a fresh 30-second timer; no user action triggers this GET.
      const response = await page.waitForResponse(response => new URL(response.url()).pathname === "/api/document-tasks", { timeout: 35000 });
      assert.equal(response.request().method(), "GET");
      naturalPollMs = await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - window.__perf.listStarts.at(-1))))));
    }
    await diagnostics.locator("summary").scrollIntoViewIfNeeded();
    await mark("diagnosticOpen", diagnostics.locator("summary"), "click");
    await diagnostics.locator("summary").click();
    await diagnostics.locator("pre.raw-data").waitFor({ state: "visible" });
    const diagnosticOpenMs = await painted("diagnosticOpen");
    stringifyCounts.afterDiagnosticOpen = await page.evaluate(() => window.__perf.diagnosticStringify.length);
    const expected = task => JSON.stringify({ usage: task.usage, unknownUsageCalls: task.unknownUsageCalls, processing: task.processing, blocking: task.blocking }, null, 2);
    assert.equal(await diagnostics.locator("pre.raw-data").textContent(), expected(currentTask));
    await diagnostics.getByText("已知用量：1 次调用，输入 21 tokens，输出 8 tokens。", { exact: true }).waitFor();
    const openFilterMs = await filters("open");
    stringifyCounts.afterOpenFilters = await page.evaluate(() => window.__perf.diagnosticStringify.length);
    assert.equal(await diagnostics.locator("pre.raw-data").textContent(), expected(currentTask));
    await page.getByRole("searchbox", { name: "搜索解析题目", exact: true }).fill("Performance question 0999");
    await page.getByText("显示 1 / 1000 条记录。筛选不会修改复核标记或导出内容。", { exact: true }).waitFor();
    assert.equal(await page.locator("details.question-card").count(), 1);
    await page.getByText("Performance question 0999", { exact: true }).click();
    await page.getByText("Literal source for question 999", { exact: true }).waitFor();
    assert.equal(await page.locator("details.question-card").getByText("未提供（null），不会补写答案", { exact: true }).count(), 1);
    if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });
    const localization = await page.evaluate(() => window.__perf.diagnosticStringify);
    currentTask = structuredClone(currentTask);
    currentTask.usage[0].inputTokens = 22;
    currentTask.result.warnings = ["Refreshed synthetic diagnostic task"];
    const refreshedDetail = page.waitForResponse(response => new URL(response.url()).pathname === `/api/document-tasks/${currentTask.threadId}`);
    await page.getByRole("button", { name: "刷新任务详情", exact: true }).click();
    await refreshedDetail;
    await page.getByText("Refreshed synthetic diagnostic task", { exact: true }).waitFor();
    // Refresh may remount the section or preserve its open state; both implementations must update its content.
    if (await diagnostics.getAttribute("open") === null) await diagnostics.locator("summary").click();
    await diagnostics.getByText("已知用量：1 次调用，输入 22 tokens，输出 8 tokens。", { exact: true }).waitFor();
    assert.equal(await diagnostics.locator("pre.raw-data").textContent(), expected(currentTask));
    assert.deepEqual(errors, []);
    assert(calls.every(call => call.method === "GET"));
    assert(calls.filter(call => call.path !== "/api/products").every(call => call.authenticated && call.phone === "13800138000"));
    return { coldTaskOpenMs, closedFilterMs, naturalPollMs, diagnosticOpenMs, openFilterMs, stringifyCounts, diagnosticStringify: localization, requests: calls, assertions: "Pydantic-valid fixed DTOs; 20-record pagination; exact diagnostic JSON before/after parent filters and task refresh; 1,000-record search; supplied-null answers; authenticated GET-only/no model mutations" };
  } finally { await context.close(); }
}

try {
  for (let pair = 1; pair <= (baselineProbe ? 1 : 5); pair++) {
    for (const phase of baselineProbe ? ["baseline"] : pair % 2 ? ["baseline", "candidate"] : ["candidate", "baseline"]) {
      const root = phase === "baseline" ? baselineRoot : candidateRoot;
      const server = spawn(process.execPath, [join(candidateRoot, "web/node_modules/vite/bin/vite.js"), "preview", "--config", join(candidateRoot, "web/vite.config.ts"), "--host", "127.0.0.1", "--port", "18671", "--strictPort"], { cwd: join(root, "web"), stdio: ["ignore", "pipe", "pipe"] });
      const logs = [];
      server.stdout.on("data", value => logs.push(value.toString())); server.stderr.on("data", value => logs.push(value.toString()));
      try {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error(`Preview did not start: ${logs.join("")}`)), 15000);
          server.once("exit", code => { clearTimeout(timeout); reject(new Error(`Preview exited ${code}: ${logs.join("")}`)); });
          server.stdout.on("data", value => { if (value.toString().includes(origin)) { clearTimeout(timeout); resolve(); } });
        });
        const servedIndex = await (await fetch(origin)).text();
        assert.equal(digest(servedIndex), digest(readFileSync(join(root, "web/dist/index.html"))), "Preview served the wrong variant");
        const browserSample = baselineProbe ? null : await measureContext(false, pair === 5 && phase === "candidate" ? output.replace(/\.json$/, "-candidate.png") : null);
        const localization = await measureContext(true, null);
        report.samples.push({ pair, phase, browser: browserSample, localization }); save();
        process.stdout.write(`${pair} ${phase}: ${browserSample ? `cold open ${browserSample.coldTaskOpenMs.toFixed(1)} ms, ` : "instrumented probe only, "}stringify calls ${localization.diagnosticStringify.length}\n`);
      } finally {
        if (server.exitCode === null) { const exited = new Promise(resolve => server.once("exit", resolve)); server.kill("SIGTERM"); await exited; }
        writeFileSync(output.replace(/\.json$/, `-${pair}-${phase}-preview.log`), logs.join(""));
      }
    }
  }
} catch (error) { report.error = String(error.stack || error); save(); throw error; }
finally { await browser.close(); }
