// Real production Web against the isolated service. No intercepted HTTP or credentials in reports.
import { chromium } from "../node_modules/playwright/index.mjs";
import { expect } from "../node_modules/playwright/test.mjs";
import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const output = process.env.PRACTIQ_ACCEPT_OUTPUT;
const token = process.env.AI_SERVICE_TOKEN;
const browser = await chromium.launch({ headless: true });
const samples = [];
try {
  for (const [name, mimeType] of [["txt", "text/plain"], ["md", "text/markdown"], ["png", "image/png"]]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const page = await context.newPage();
    const sample = { name, requests: [], phasesMs: {}, error: null };
    samples.push(sample);
    const starts = new Map();
    let detail = null, creates = 0;
    page.on("request", request => starts.set(request, performance.now()));
    page.on("response", async response => {
      const request = response.request(), url = new URL(response.url());
      if (!url.pathname.startsWith("/api/")) return;
      const row = { method: request.method(), path: url.pathname, status: response.status(), ms: null };
      sample.requests.push(row);
      try {
      await response.finished();
      row.ms = performance.now() - starts.get(request);
      if (request.method() === "POST" && url.pathname === "/api/document-tasks") {
        creates++;
        const receipt = await response.json();
        sample.threadId = receipt.threadId;
      }
      if (request.method() === "GET" && /^\/api\/document-tasks\/[^/]+$/.test(url.pathname)) detail = await response.json();
      } catch {
        row.cancelled = true; // Polls can be cancelled when their view closes.
      }
    });
    try {
      let started = performance.now();
      await page.goto(process.env.PRACTIQ_ACCEPT_URL);
      await page.getByLabel("服务访问令牌").fill(token);
      await page.getByRole("button", { name: "连接服务", exact: true }).click();
      await expect(page.getByText(/^服务支持：/)).toBeVisible();
      sample.phasesMs.connect = performance.now() - started;
      await page.getByLabel("选择文档").setInputFiles({ name: `quiz.${name}`, mimeType,
        buffer: await readFile(path.join(output, "sources", `quiz.${name}`)) });
      await expect(page.getByRole("button", { name: "开始导入", exact: true })).toBeEnabled();
      expect(creates).toBe(0);
      started = performance.now();
      await page.getByRole("button", { name: "开始导入", exact: true }).click();
      const download = page.getByRole("button", { name: "下载题库 ZIP", exact: true });
      await expect.poll(() => detail?.state, { timeout: 260_000, intervals: [100] }).toMatch(/COMPLETED|FAILED|WAITING_REVIEW|INTERRUPTED|CANCELLED|PAUSED/);
      if (detail.state !== "COMPLETED" || detail.status !== "SUCCEEDED") throw new Error(`Import terminal: ${detail.state}/${detail.status}`);
      await expect(page.getByText(/The Earth orbits the Sun\./).first()).toBeVisible();
      await expect(download).toBeEnabled();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      sample.phasesMs.startToResultVisible = performance.now() - started;
      await writeFile(path.join(output, `${name}-detail.json`), JSON.stringify(detail, null, 2) + "\n");
      const downloadStart = performance.now();
      const pending = page.waitForEvent("download");
      await download.click();
      await (await pending).saveAs(path.join(output, "exports", `${name}.zip`));
      sample.phasesMs.download = performance.now() - downloadStart;
      sample.phasesMs.startToDownloaded = performance.now() - started;
      const handoff = performance.now();
      const native = await promisify(execFile)(process.env.PRACTIQ_ACCEPT_NATIVE,
        ["performance::workflow_practice", "--exact", "--ignored", "--nocapture"],
        { timeout: 120_000, env: { ...process.env, PRACTIQ_WORKFLOW_DIR: output,
          PRACTIQ_WORKFLOW_CASE: name, PRACTIQ_BENCH_OUTPUT: path.join(output, `${name}-native.json`) } });
      await writeFile(path.join(output, `${name}-native.log`), native.stdout + native.stderr);
      sample.phasesMs.nativeHandoffAndPractice = performance.now() - handoff;
      sample.phasesMs.startToPracticeRestored = performance.now() - started;
      expect(creates).toBe(1);
      const usage = JSON.stringify(detail.usage);
      const again = await context.request.get(`${process.env.PRACTIQ_ACCEPT_URL}/api/document-tasks/${sample.threadId}`, { headers: { Authorization: `Bearer ${token}` } });
      expect(JSON.stringify((await again.json()).usage)).toBe(usage);
      sample.modelCalls = detail.usage.length;
      sample.unknownCalls = detail.unknownUsageCalls;
      sample.reviewRequired = detail.processing?.quality?.reviewRequired;
      expect(detail.unknownUsageCalls).toEqual([]);
      expect(detail.failures).toEqual([]);
      expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(token);
      await page.screenshot({ path: path.join(output, `${name}-result.png`), fullPage: true });
    } catch (error) {
      sample.error = String(error.message).replaceAll(token, "[redacted]").slice(0, 1200);
      if (detail) await writeFile(path.join(output, `${name}-detail.json`), JSON.stringify(detail, null, 2) + "\n");
      // Unknown mutations are never retried by this harness.
    } finally {
      await context.close();
      await writeFile(path.join(output, "browser.json"), JSON.stringify({ samples }, null, 2) + "\n");
    }
  }
} finally {
  await browser.close();
}
process.exitCode = samples.some(sample => sample.error) ? 1 : 0;
