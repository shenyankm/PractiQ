// Run serially, separately from builds/tests; uses synthetic responses, never a service.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "..");
const { values } = parseArgs({ options: { baseline: { type: "string" }, output: { type: "string" }, worker: { type: "string" } } });
const sha256 = value => createHash("sha256").update(value).digest("hex");
const cases = [
  { shape: "export", bytes: 32 * 1024, chunkBytes: 8 * 1024 },
  { shape: "export", bytes: 16 * 1024 ** 2, chunkBytes: 1024 ** 2 },
  { shape: "export", bytes: 128 * 1024 ** 2, chunkBytes: 1024 ** 2 },
  { shape: "bytes-control", bytes: 16 * 1024 ** 2, chunkBytes: 1024 ** 2 },
  { shape: "bodyless-control", bytes: 32 * 1024, chunkBytes: 32 * 1024 },
];

async function worker(directory) {
  const server = await createServer({ configFile: false, root: directory, logLevel: "silent", server: { host: "127.0.0.1", port: 0 } });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.route("**/", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Export probe</title>" }));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
    await page.evaluate(async () => {
      const { Client, readBytes } = await import("/src/api.ts");
      const { task } = await import("/src/test-fixtures.ts");
      globalThis.exportProbe = { Client, readBytes, task };
    });
    const session = await page.context().newCDPSession(page);
    const workloads = [];
    for (const fixture of cases) {
      const expected = createHash("sha256");
      for (let offset = 0; offset < fixture.bytes; offset += fixture.chunkBytes) {
        expected.update(Buffer.alloc(Math.min(fixture.chunkBytes, fixture.bytes - offset), 17 + (offset / fixture.chunkBytes) % 239));
      }
      const expectedHash = expected.digest("hex");
      const task = await page.evaluate(fixture => {
        const chunks = [];
        for (let offset = 0; offset < fixture.bytes; offset += fixture.chunkBytes) {
          chunks.push(new Uint8Array(Math.min(fixture.chunkBytes, fixture.bytes - offset)).fill(17 + (offset / fixture.chunkBytes) % 239));
        }
        globalThis.exportProbe.chunks = chunks;
        return globalThis.exportProbe.task;
      }, fixture);
      const samples = [];
      for (let iteration = 0; iteration < 6; iteration++) {
        await session.send("HeapProfiler.collectGarbage");
        const sample = await page.evaluate(async fixture => {
          const { Client, readBytes, task, chunks } = globalThis.exportProbe;
          const response = fixture.shape === "bodyless-control" ? new Response(null) : new Response(new ReadableStream({
            start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
          }), { headers: { "Content-Type": "application/zip" } });
          if (fixture.shape === "bodyless-control") response.arrayBuffer = async () => chunks[0].buffer;
          const originalFetch = globalThis.fetch;
          const originalSet = Uint8Array.prototype.set;
          let copiedBytes = 0, copyCalls = 0, requests = 0;
          globalThis.fetch = async (path, init) => {
            requests++;
            const expected = `/api/document-tasks/${task.threadId}/export?checkpoint_id=${task.checkpointId}&scope=full`;
            if (path !== expected || new Headers(init.headers).get("Authorization") !== "Bearer synthetic-probe") throw new Error("Unexpected request");
            return response;
          };
          Uint8Array.prototype.set = function (bytes, offset) { copiedBytes += bytes.length; copyCalls++; return originalSet.call(this, bytes, offset); };
          const client = new Client("synthetic-probe");
          let result, elapsedMs;
          try {
            const started = performance.now();
            result = fixture.shape === "export" ? await client.exportBank(task) : await readBytes(response, fixture.bytes);
            elapsedMs = performance.now() - started;
          } finally {
            globalThis.fetch = originalFetch;
            Uint8Array.prototype.set = originalSet;
          }
          const blob = fixture.shape === "export" ? result.blob : new Blob([result], { type: "application/zip" });
          const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, "0")).join("");
          if (response.body?.locked || requests !== (fixture.shape === "export" ? 1 : 0)) throw new Error("Reader/request mismatch");
          return { elapsedMs, copiedBytes, copyCalls, hash, bytes: blob.size, type: blob.type,
            name: fixture.shape === "export" ? result.name : null };
        }, fixture);
        assert.equal(sample.hash, expectedHash);
        assert.equal(sample.bytes, fixture.bytes);
        assert.equal(sample.type, "application/zip");
        samples.push(sample);
      }
      const { elapsedMs, copiedBytes, copyCalls, ...output } = samples[0];
      for (const sample of samples) assert.deepEqual({ hash: sample.hash, bytes: sample.bytes, type: sample.type, name: sample.name }, output);
      workloads.push({ ...fixture, inputSha256: sha256(JSON.stringify([fixture, task, expectedHash])), outputSha256: sha256(JSON.stringify(output)), samples: samples.slice(1) });
    }
    return { chromium: browser.version(), sourceSha256: sha256(readFileSync(resolve(directory, "src/api.ts"))), workloads };
  } finally {
    await browser?.close();
    await server.close();
  }
}

if (values.worker) {
  console.log(JSON.stringify(await worker(resolve(values.worker))));
} else {
  assert(values.baseline && values.output, "Use --baseline /path/to/baseline/web --output /path/to/report.json");
  const baseline = resolve(values.baseline);
  const lockHash = sha256(readFileSync(resolve(root, "package-lock.json")));
  assert.equal(sha256(readFileSync(resolve(baseline, "package-lock.json"))), lockHash);
  const pairs = [];
  for (let pair = 0; pair < 3; pair++) {
    const runs = {};
    for (const label of pair % 2 ? ["after", "before"] : ["before", "after"]) {
      runs[label] = JSON.parse(execFileSync(process.execPath, [script, "--worker", label === "before" ? baseline : root], { encoding: "utf8", maxBuffer: 1024 ** 2 }));
    }
    pairs.push(runs);
  }
  const workloads = cases.map((fixture, index) => {
    const row = { ...fixture };
    for (const field of ["inputSha256", "outputSha256"]) {
      const hashes = new Set(pairs.flatMap(pair => [pair.before.workloads[index][field], pair.after.workloads[index][field]]));
      assert.equal(hashes.size, 1);
      row[field] = [...hashes][0];
    }
    for (const label of ["before", "after"]) {
      const samples = pairs.flatMap(pair => pair[label].workloads[index].samples);
      const sorted = samples.map(sample => sample.elapsedMs).sort((a, b) => a - b);
      row[label] = { samples, medianMs: sorted[Math.floor(sorted.length / 2)] };
    }
    console.log(fixture.shape, fixture.bytes, row.before.medianMs, row.after.medianMs);
    return row;
  });
  for (const label of ["before", "after"]) {
    assert.equal(new Set(pairs.map(pair => pair[label].sourceSha256)).size, 1);
    assert.equal(new Set(pairs.map(pair => pair[label].chromium)).size, 1);
  }
  assert.equal(pairs[0].before.chromium, pairs[0].after.chromium);
  const report = { baseline: execFileSync("git", ["rev-parse", "HEAD"], { cwd: baseline, encoding: "utf8" }).trim(),
    node: process.version, chromium: pairs[0].after.chromium, platform: `${platform()} ${arch()} ${release()}`, lockSha256: lockHash,
    beforeSourceSha256: pairs[0].before.sourceSha256, afterSourceSha256: pairs[0].after.sourceSha256, probeSha256: sha256(readFileSync(script)),
    scope: "Three alternating isolated Node/Chromium process pairs; one warmup and five retained samples per case/process. Fixture/Response creation, explicit pre-sample GC and full output hashing excluded. Native browser Client export/readBytes with synthetic fetch; counts JS Uint8Array.set bytes only, not Blob internals or peak memory. No service, network throughput, ZIP parsing, provider or end-to-end download claim.", workloads };
  mkdirSync(dirname(resolve(values.output)), { recursive: true });
  writeFileSync(values.output, JSON.stringify(report, null, 2) + "\n");
}
