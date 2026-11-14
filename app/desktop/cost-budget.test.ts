import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { DesktopCostPreferences } from "../src/contracts.generated.js";
import { CostBudget, costSettings, modelEstimate, noCost, pageEstimate } from "./cost-budget.js";
import { SqliteStore } from "./graph-store.js";
import { AiDatabase } from "./ai-database.js";
import type { AiSnapshot } from "./ai-settings.js";
import { AiSettings, savedCostPolicy } from "./ai-settings.js";
import { ModelClient } from "./model.js";
import { TencentClient } from "./tencent.js";
import { hash } from "./assets.js";

const fixtures: ReturnType<typeof setup>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) { f.store.stop(); f.db.close(); rmSync(f.path, { recursive: true, force: true }); } });
function setup() {
  const path = mkdtempSync(join(tmpdir(), "practiq-cost-")), store = new SqliteStore(path), db = new AiDatabase(path), costs = new CostBudget(store), cost: DesktopCostPreferences = { enabled: true, currency: "CNY", taskLimitMicros: 1000000, dailyLimitMicros: 2000000, inputMicrosPerMillion: 2000000, outputMicrosPerMillion: 8000000, tencentMicrosPerPage: 100000 };
  const config: AiSnapshot = { revision: randomUUID(), preferences: { model: { provider: "openai", baseUrl: "https://model.example/v1", modelId: "model", maxOutputTokens: 2000, timeoutSeconds: 10 }, import: { tencentConcurrency: 2, readRetryCount: 0, retryBaseSeconds: .5 }, maxCalls: 64, tencentCos: { enabled: false, bucket: "", region: "" }, cost }, secrets: { modelApiKey: "TEST_ONLY", tencentSecretId: "TEST_ONLY", tencentSecretKey: "TEST_ONLY" } };
  const task = db.createTask(hash("source"), 64), f = { path, store, db, costs, cost, config, task }; fixtures.push(f); return f;
}
const rows = (f: ReturnType<typeof setup>) => f.store.db.prepare("SELECT * FROM store_items ORDER BY namespace,key").all();
const target = hash("target");

it("keeps disabled budgets storage-free and preserves the historical rounded estimate formulas", () => {
  const f = setup(); f.store.stop(); expect(f.costs.reserve(noCost(), "", "", 0, "model", target)).toBeNull(); expect(modelEstimate(1, 16384, f.cost)).toBe(131074); expect(pageEstimate(3, f.cost)).toBe(300000);
});
it.each(["currency", "missing_price", "no_limit", "negative", "unsafe", "extra"])("rejects %s pricing before reservation", kind => {
  const f = setup(), cost = { ...f.cost }; if (kind === "currency") cost.currency = "usd"; if (kind === "missing_price") cost.inputMicrosPerMillion = null; if (kind === "no_limit") cost.taskLimitMicros = cost.dailyLimitMicros = null; if (kind === "negative") cost.outputMicrosPerMillion = -1; if (kind === "unsafe") cost.dailyLimitMicros = Number.MAX_SAFE_INTEGER + 1; if (kind === "extra") Object.assign(cost, { executable: "/bin/unsafe" });
  expect(() => costSettings(cost)).toThrow(expect.objectContaining({ code: "COST_PRICING_INVALID" })); expect(rows(f)).toEqual([]);
});
it("rounds safely without floating multiplication and refuses overflow before financial mutation", () => {
  const f = setup(); expect(modelEstimate(1, 1, { ...f.cost, inputMicrosPerMillion: 1, outputMicrosPerMillion: 1 })).toBe(1); expect(() => modelEstimate(32 * 1024 * 1024, 131072, { ...f.cost, inputMicrosPerMillion: Number.MAX_SAFE_INTEGER })).toThrow(expect.objectContaining({ code: "COST_BUDGET_EXCEEDED" })); expect(rows(f)).toEqual([]);
});
it("atomically reserves call, scope and UTC day once, including replay after reopen or day rollover", () => {
  const f = setup(), scope = `task:${f.task}`, first = f.costs.reserve(f.cost, scope, "one", 600000, "model", target), before = rows(f); expect(f.costs.reserve(f.cost, scope, "one", 600000, "model", target)).toEqual(first); expect(rows(f)).toEqual(before);
  f.store.stop(); f.store = new SqliteStore(f.path); const reopened = new CostBudget(f.store); vi.useFakeTimers(); try { vi.setSystemTime(new Date(Date.now() + 86400000)); expect(reopened.reserve(f.cost, scope, "one", 600000, "model", target)).toEqual(first); expect(rows(f)).toEqual(before); } finally { vi.useRealTimers(); }
});
it("serializes competing daily reservations and rolls back all totals on rejection", async () => {
  const f = setup(); f.cost.dailyLimitMicros = 1000000; const results = await Promise.allSettled([f.costs, new CostBudget(new SqliteStore(f.path))].map((costs, index) => Promise.resolve().then(() => { try { return costs.reserve(f.cost, `task:${index ? randomUUID() : f.task}`, String(index), 600000, "model", target); } finally { if (costs !== f.costs) costs.store.stop(); } })));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1); expect(results.filter(result => result.status === "rejected")).toHaveLength(1); const report = await f.costs.report(f.cost); expect(report.day?.reservedMicros).toBe(600000); expect(report.recent).toHaveLength(1);
});
it("retains task totals across days and never refunds unknown reservations", async () => {
  const f = setup(); vi.useFakeTimers(); try { vi.setSystemTime("2026-10-28T23:59:00Z"); f.costs.reserve(f.cost, `task:${f.task}`, "unknown", 900000, "model", target); vi.setSystemTime("2026-10-29T00:01:00Z"); expect(() => f.costs.reserve(f.cost, `task:${f.task}`, "retry", 200000, "model", target)).toThrow(expect.objectContaining({ code: "COST_BUDGET_EXCEEDED" })); f.costs.reserve(f.cost, `task:${randomUUID()}`, "new-day", 900000, "tencent", target); const report = await f.costs.report(f.cost, f.task); expect(report.task?.reservedMicros).toBe(900000); expect(report.day?.reservedMicros).toBe(900000); } finally { vi.useRealTimers(); }
});
it.each(["amount", "price", "target", "kind", "currency"])("refuses %s changes without altering the retained reservation", kind => {
  const f = setup(), scope = `task:${f.task}`; f.costs.reserve(f.cost, scope, "one", 10, "model", target); const before = rows(f), cost = { ...f.cost }; if (kind === "price") cost.inputMicrosPerMillion++; if (kind === "currency") cost.currency = "USD";
  expect(() => f.costs.reserve(cost, scope, "one", kind === "amount" ? 11 : 10, kind === "kind" ? "tencent" : "model", kind === "target" ? hash("other") : target)).toThrow(expect.objectContaining({ code: "COST_RESERVATION_CONFLICT" })); expect(rows(f)).toEqual(before);
});
it("refuses cross-currency totals and retains a consistent snapshot after a failed commit", () => {
  const f = setup(); f.costs.reserve(f.cost, `task:${f.task}`, "one", 700000, "model", target); const before = rows(f);
  expect(() => f.costs.reserve({ ...f.cost, currency: "USD" }, `task:${randomUUID()}`, "two", 1, "model", target)).toThrow(expect.objectContaining({ code: "COST_CURRENCY_CONFLICT" })); expect(rows(f)).toEqual(before);
  f.store.db.exec("CREATE TEMP TRIGGER reject_cost BEFORE INSERT ON store_items WHEN NEW.key LIKE 'day:%' BEGIN SELECT RAISE(ABORT,'disk full'); END"); expect(() => f.costs.reserve(f.cost, `task:${f.task}`, "two", 1, "model", target)).toThrow(expect.objectContaining({ code: "COST_STORE_UNAVAILABLE" })); expect(rows(f)).toEqual(before);
});
it("fails closed on malformed accounting and never invents zero totals", async () => {
  const f = setup(), day = new Date().toISOString().slice(0, 10); await f.store.put(["practiq_cost_v1"], `day:${day}`, { currency: "CNY", reservedMicros: -1 }); const before = rows(f);
  expect(() => f.costs.reserve(f.cost, `task:${f.task}`, "one", 1, "model", target)).toThrow(expect.objectContaining({ code: "COST_STORE_UNAVAILABLE" })); await expect(f.costs.report(f.cost)).rejects.toMatchObject({ code: "COST_STORE_UNAVAILABLE" }); expect(rows(f)).toEqual(before);
});
it("stops models before a paid claim and keeps conservative reservations for known and unknown failures", async () => {
  const f = setup(), input = { schema: "UnitParseResult", promptVersion: "test", system: "Extract", text: "Source" }, http = vi.fn(async () => { throw Error("unknown provider outcome"); }), model = new ModelClient(f.db, http); model.bindCosts(f.costs); f.cost.taskLimitMicros = 1;
  await expect(model.structured(f.task, "one", input, f.config)).rejects.toMatchObject({ code: "COST_BUDGET_EXCEEDED" }); expect(http).not.toHaveBeenCalled(); expect(f.db.receipt(f.task, "one")).toBeNull(); expect(rows(f)).toEqual([]);
  f.cost.taskLimitMicros = 1000000; await expect(model.structured(f.task, "one", input, f.config)).rejects.toMatchObject({ code: "AI_RESULT_UNKNOWN" }); const reserved = await f.costs.report(f.cost, f.task); expect(reserved.task!.reservedMicros).toBeGreaterThan(0); await expect(model.structured(f.task, "one", input, f.config)).rejects.toMatchObject({ code: "AI_RESULT_UNKNOWN" }); expect(http).toHaveBeenCalledTimes(1); expect((await f.costs.report(f.cost, f.task)).task).toEqual(reserved.task);
});
it("stops Tencent before submission and binds the actual estimated page ceiling to one reservation", async () => {
  const f = setup(), http = vi.fn(async () => new Response(JSON.stringify({ Response: { TaskId: "job" } }))), client = new TencentClient(f.db, http), source = { sha256: hash("source"), type: "text" as const, bytes: Buffer.from("source"), estimatedPages: 3 }; client.bindCosts(f.costs); f.cost.taskLimitMicros = 1;
  await expect(client.submit(f.task, "source", source, f.config)).rejects.toMatchObject({ code: "COST_BUDGET_EXCEEDED" }); expect(http).not.toHaveBeenCalled(); expect(f.db.receipt(f.task, "tencent:source")).toBeNull(); f.cost.taskLimitMicros = 1000000; expect(await client.submit(f.task, "source", source, f.config)).toBe("job"); expect((await f.costs.report(f.cost, f.task)).task?.reservedMicros).toBe(300000); expect(await client.submit(f.task, "source", source, f.config)).toBe("job"); expect(http).toHaveBeenCalledTimes(1);
});
it.each(["succeeded", "failed"])("retains money for a known %s response and never charges a cached call twice", async status => {
  const f = setup(), input = { schema: "UnitParseResult", promptVersion: "test", system: "Extract", text: "Source" }, http = vi.fn(async () => status === "failed" ? new Response("rejected", { status: 400 }) : new Response(JSON.stringify({ status: "completed", output: [{ type: "function_call", name: "UnitParseResult", arguments: '{"questions":[],"groups":[]}' }], usage: { input_tokens: 2, output_tokens: 1 } }))), model = new ModelClient(f.db, http); model.bindCosts(f.costs);
  if (status === "failed") await expect(model.structured(f.task, "known", input, f.config)).rejects.toThrow(); else await model.structured(f.task, "known", input, f.config);
  const first = await f.costs.report(f.cost, f.task); expect(first.task!.reservedMicros).toBeGreaterThan(0); expect(f.db.receipt(f.task, "known")?.status).toBe(status);
  if (status === "failed") await expect(model.structured(f.task, "known", input, f.config)).rejects.toMatchObject({ code: "AI_CALL_FAILED" }); else await model.structured(f.task, "known", input, f.config);
  expect((await f.costs.report(f.cost, f.task)).task).toEqual(first.task); expect(http).toHaveBeenCalledTimes(1);
});
it("rejects malformed retained reservation dates instead of replaying an untrusted financial receipt", async () => {
  const f = setup(), scope = `task:${f.task}`, value = f.costs.reserve(f.cost, scope, "date", 1, "model", target)!; await f.store.put(["practiq_cost_v1"], `call:${hash(`${scope}/date`)}`, { ...value, day: "2026-02-31" });
  const before = rows(f); expect(() => f.costs.reserve(f.cost, scope, "date", 1, "model", target)).toThrow(expect.objectContaining({ code: "COST_STORE_UNAVAILABLE" })); await expect(f.costs.report(f.cost)).rejects.toMatchObject({ code: "COST_STORE_UNAVAILABLE" }); expect(rows(f)).toEqual(before);
});
it("reads the latest saved limits without decrypting credentials or retargeting an existing model snapshot", async () => {
  const f = setup(), decrypt = vi.fn(async (): Promise<never> => { throw Error("Cost policy must not decrypt"); }), settings = new AiSettings(f.path, { isAsyncEncryptionAvailable: async () => false, encryptStringAsync: async () => { throw Error(); }, decryptStringAsync: decrypt }), view = await settings.view();
  const saved = await settings.save({ revision: view.revision, preferences: { ...view.preferences, cost: { ...f.cost, taskLimitMicros: 1 } } });
  const model = new ModelClient(f.db, vi.fn()), costs = new CostBudget(f.store, () => savedCostPolicy(f.path)); model.bindCosts(costs); const stale = structuredClone(f.config); delete stale.preferences.cost;
  await expect(model.structured(f.task, "one", { schema: "UnitParseResult", promptVersion: "test", system: "Extract", text: "Source" }, stale)).rejects.toMatchObject({ code: "COST_BUDGET_EXCEEDED" }); expect(decrypt).not.toHaveBeenCalled(); expect((await costs.report()).taskLimitMicros).toBe(1);
  await settings.save({ revision: saved.revision, preferences: { ...saved.preferences, cost: { ...f.cost, enabled: false } } }); expect(costs.policy(f.cost).enabled).toBe(false); expect(decrypt).not.toHaveBeenCalled();
});
it("blocks new paid work when the worker's authoritative policy file disappears, even with an older disabled snapshot", async () => {
  const f = setup(), http = vi.fn(), model = new ModelClient(f.db, http); model.bindCosts(new CostBudget(f.store, required => savedCostPolicy(f.path, required))); delete f.config.preferences.cost;
  await expect(model.structured(f.task, "missing-policy", { schema: "UnitParseResult", promptVersion: "test", system: "Extract", text: "Source" }, f.config)).rejects.toMatchObject({ code: "COST_STORE_UNAVAILABLE" }); expect(http).not.toHaveBeenCalled(); expect(f.db.receipt(f.task, "missing-policy")).toBeNull(); expect(rows(f)).toEqual([]);
});
it.each(["reservation", "claim"])("survives SIGKILL after %s without refund or an uncertain replay", async phase => {
  const f = setup(), base = new URL("../.build/electron/app/desktop/", import.meta.url).href, key = "crash", scope = `task:${f.task}`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const d=JSON.parse(process.argv[1]), [{SqliteStore},{CostBudget},{AiDatabase}]=await Promise.all(['graph-store','cost-budget','ai-database'].map(n=>import(d.base+n+'.js'))), store=new SqliteStore(d.path), costs=new CostBudget(store), db=new AiDatabase(d.path);costs.reserve(d.cost,d.scope,d.key,600000,'model',d.target);if(d.phase==='claim')db.claim(d.task,d.key,{inputDigest:d.target,endpoint:'https://model.example/v1/responses',model:'model',promptVersion:'test'});process.kill(process.pid,'SIGKILL');
  `, JSON.stringify({ path: f.path, base, cost: f.cost, scope, key, target, task: f.task, phase })], { timeout: 15000, encoding: "utf8" }); expect(child.signal, child.stderr).toBe("SIGKILL"); const before = rows(f); expect(f.costs.reserve(f.cost, scope, key, 600000, "model", target)).toMatchObject({ reservedMicros: 600000 }); expect(rows(f)).toEqual(before); expect(f.db.receipt(f.task, key)?.status ?? null).toBe(phase === "claim" ? "unknown" : null);
});
