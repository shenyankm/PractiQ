import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import type { AiSnapshot } from "./ai-settings.js";
import { hash } from "./assets.js";
import type { DocumentRecord } from "./document-tasks.js";
import { AppError, invariant } from "./errors.js";
import { SqliteStore } from "./graph-store.js";
import { canonical } from "./questions.js";

export const DOCUMENT_TTL_MS = 259_200 * 60_000;
const context = new AsyncLocalStorage<{ execution: DocumentExecution; unit?: { key: string; allowance: number } }>();
let codeVersion: string | undefined;
function codeFingerprint(): string {
  if (codeVersion) return codeVersion;
  const path = new URL(import.meta.url.endsWith(".ts") ? "../.build/electron/app/desktop/execution-version.json" : "./execution-version.json", import.meta.url), bytes = readFileSync(path);
  invariant(bytes.length <= 1024, "EXECUTION_VERSION_MISMATCH", "Execution build manifest is invalid");
  const value = JSON.parse(bytes.toString()); invariant(value.version === 1 && Object.keys(value).length === 2 && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256), "EXECUTION_VERSION_MISMATCH", "Execution build manifest is invalid"); return codeVersion = value.sha256;
}
function timeout(config: Pick<AiSnapshot, "preferences">): number { const seconds = config.preferences.runTimeoutSeconds === undefined ? 1800 : config.preferences.runTimeoutSeconds; invariant(Number.isFinite(seconds) && seconds > 0 && (!Number.isInteger(seconds) || Number.isSafeInteger(seconds)), "LOCAL_FILTER_INVALID", "Invalid document run timeout"); return seconds; }
export function executionBuildFingerprint(): string { return hash(canonical({ version: 1, code: codeFingerprint(), runtime: { node: process.versions.node, v8: process.versions.v8, modules: process.versions.modules, platform: process.platform, arch: process.arch } })); }
export function executionFingerprint(config: Pick<AiSnapshot, "preferences">): string {
  const { model, maxCalls, tencentCos, import: preferences } = config.preferences;
  return hash(canonical({ version: 1, build: executionBuildFingerprint(), settings: { model: { provider: model.provider, baseUrl: model.baseUrl, modelId: model.modelId, maxOutputTokens: model.maxOutputTokens }, maxCalls, tencentCos, runTimeoutSeconds: timeout(config), deduplicateQuestions: preferences.deduplicateQuestions ?? false, generateAnswers: preferences.generateAnswers ?? false } }));
}
export function callAllocations(value: Record<string, unknown> | null, task: Pick<DocumentRecord, "executionFingerprint" | "maxCalls">) {
  const saved = value ?? { fingerprint: task.executionFingerprint!, limit: task.maxCalls, units: {} };
  invariant(Object.keys(saved).length === 3 && saved.fingerprint === task.executionFingerprint && saved.limit === task.maxCalls && saved.units !== null && typeof saved.units === "object" && !Array.isArray(saved.units), "TASK_CHECKPOINT_UNREADABLE", "Saved call allocation belongs to another execution or budget");
  const units = new Map(Object.entries(saved.units as Record<string, { calls: number; allowance: number }>)); let reserved = 0;
  invariant(units.size <= 10000, "TASK_CHECKPOINT_UNREADABLE", "Saved call allocation exceeds its limit");
  for (const [key, item] of units) { invariant(/^[A-Za-z0-9:_-]{1,128}$/.test(key) && item !== null && typeof item === "object" && Object.keys(item).length === 2 && Number.isSafeInteger(item.calls) && item.calls >= 1 && item.calls <= 8 && Number.isSafeInteger(item.allowance) && item.allowance >= 0 && item.allowance <= item.calls, "TASK_CHECKPOINT_UNREADABLE", "Saved call allocation is invalid"); reserved += item.allowance; }
  invariant(reserved <= task.maxCalls, "TASK_CHECKPOINT_UNREADABLE", "Saved call allocation exceeds the task budget"); return { units, reserved };
}

/** Async-local scopes follow parallel graph units without placing credentials or provider payloads in checkpoints. */
export class DocumentExecution {
  private deadline = 0;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(readonly store: SqliteStore, readonly task: DocumentRecord, readonly config: AiSnapshot, readonly controller: AbortController, private readonly current: () => DocumentRecord) {}
  guard(checkPause = true): void {
    const record = this.current();
    invariant(record.id === this.task.id && record.runId === this.task.runId && record.inputDigest === this.task.inputDigest && record.createdAt === this.task.createdAt && ["PENDING", "RUNNING", "PAUSING"].includes(record.state), "STALE_RUN", "Document run is no longer current");
    invariant(record.executionBuild === executionBuildFingerprint() && record.executionFingerprint === executionFingerprint(this.config), "EXECUTION_VERSION_MISMATCH", "Resume with the original execution version or create a new task");
    invariant(Date.now() < record.createdAt + DOCUMENT_TTL_MS, "TASK_EXPIRED", "Document task expired");
    invariant(this.deadline === 0 || Date.now() < this.deadline, "RUN_DEADLINE_EXCEEDED", "Run execution deadline exceeded");
    this.controller.signal.throwIfAborted();
    invariant(!checkPause || !record.desired, "DOCUMENT_STOP_REQUESTED", "Document work was stopped before the next unit");
  }
  private schedule(): void {
    const remaining = Math.min(this.deadline, this.task.createdAt + DOCUMENT_TTL_MS) - Date.now();
    if (remaining <= 0) { this.controller.abort(new AppError(Date.now() >= this.task.createdAt + DOCUMENT_TTL_MS ? "TASK_EXPIRED" : "RUN_DEADLINE_EXCEEDED", "Document execution time limit exceeded")); return; }
    this.timer = setTimeout(() => this.schedule(), Math.min(remaining, 2_147_483_647)); this.timer.unref();
  }
  async run<T>(perform: () => Promise<T>): Promise<T> {
    this.guard();
    await this.store.update(["document_tasks", this.task.id, "deadlines"], this.task.runId, previous => {
      invariant(!previous || Object.keys(previous).length === 2 && Number.isSafeInteger(previous.at) && previous.fingerprint === this.task.executionFingerprint, "TASK_CHECKPOINT_UNREADABLE", "Saved execution deadline is invalid");
      this.deadline = previous ? Number(previous.at) : Math.min(this.task.createdAt + DOCUMENT_TTL_MS, Date.now() + Math.ceil(timeout(this.config) * 1000));
      return { at: this.deadline, fingerprint: this.task.executionFingerprint! };
    });
    this.guard(); this.schedule();
    try { return await context.run({ execution: this }, async () => { const result = await perform(); this.guard(false); return result; }); }
    finally { clearTimeout(this.timer); }
  }
  unit<T>(key: string, allowance: number, perform: () => Promise<T>): Promise<T> {
    invariant(context.getStore()?.execution === this && typeof key === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(key) && Number.isSafeInteger(allowance) && allowance >= 1 && allowance <= this.task.maxCalls, "EXECUTION_STORE_REQUIRED", "Document unit requires a valid execution and preallocated allowance");
    this.guard(); return context.run({ execution: this, unit: { key, allowance } }, perform);
  }
  async allocate(requests: { key: string; calls: number }[]): Promise<Map<string, number>> {
    invariant(context.getStore()?.execution === this && !context.getStore()?.unit, "EXECUTION_STORE_REQUIRED", "Allocate calls inside the active document dispatcher");
    this.guard();
    invariant(Array.isArray(requests) && requests.length <= 1000 && new Set(requests.map(item => item.key)).size === requests.length && requests.every(item => /^[A-Za-z0-9:_-]{1,128}$/.test(item.key) && Number.isSafeInteger(item.calls) && item.calls >= 1 && item.calls <= 8), "EXECUTION_STORE_REQUIRED", "Invalid document call allocation");
    const result = new Map<string, number>();
    await this.store.update(["document_tasks", this.task.id, "call_allowances"], "ledger", previous => {
      let { units, reserved } = callAllocations(previous, this.task);
      for (const request of requests) {
        const previous = units.get(request.key); invariant(!previous || previous.calls === request.calls, "TASK_CHECKPOINT_UNREADABLE", "A document unit cannot change its reserved call limit");
        const item = previous ?? { calls: request.calls, allowance: Math.min(request.calls, this.task.maxCalls - reserved) };
        if (!previous) { units.set(request.key, item); reserved += item.allowance; } result.set(request.key, item.allowance);
      }
      invariant(units.size <= 10000, "TASK_CHECKPOINT_UNREADABLE", "Document allocation ledger is full");
      return { fingerprint: this.task.executionFingerprint!, limit: this.task.maxCalls, units: Object.fromEntries(units) };
    }); return result;
  }
  async reserve(key: string, allowance: number, checkOnly = false): Promise<void> {
    const scope = context.getStore(); invariant(scope?.execution === this && scope.unit?.key === key && scope.unit.allowance === allowance, "EXECUTION_STORE_REQUIRED", "Model budget requires the active document unit");
    this.guard();
    const spend = (previous: Record<string, unknown> | null) => {
      invariant(!previous || Object.keys(previous).length === 3 && Number.isSafeInteger(previous.spent) && Number(previous.spent) >= 0 && previous.allowance === allowance && previous.fingerprint === this.task.executionFingerprint, "TASK_CHECKPOINT_UNREADABLE", "Saved unit budget is invalid or changed");
      const spent = previous ? Number(previous.spent) : 0; invariant(spent < allowance, "MODEL_BUDGET_EXCEEDED", "Document unit model-call budget exhausted"); return { spent: spent + 1, allowance, fingerprint: this.task.executionFingerprint! };
    };
    const path = ["document_tasks", this.task.id, "budget"];
    if (checkOnly) { spend(this.store.read(path, key)?.value ?? null); return; }
    await this.store.update(path, key, spend);
  }
}
export function currentExecution(): DocumentExecution { const value = context.getStore()?.execution; invariant(value, "EXECUTION_STORE_REQUIRED", "Document stage requires a persistent execution scope"); return value; }
export function guardDocumentCall(taskId: string | undefined, signal?: AbortSignal, config?: AiSnapshot): AbortSignal | undefined {
  const scope = context.getStore(); if (!scope) return signal;
  invariant(taskId === undefined || scope.execution.task.id === taskId, "EXECUTION_STORE_REQUIRED", "Provider work belongs to another document execution");
  invariant(!config || executionFingerprint(config) === scope.execution.task.executionFingerprint, "EXECUTION_VERSION_MISMATCH", "Provider settings differ from the authorized document execution");
  scope.execution.guard(); return signal ? AbortSignal.any([signal, scope.execution.controller.signal]) : scope.execution.controller.signal;
}
export function guardModelCall(taskId: string, config: AiSnapshot, signal?: AbortSignal): AbortSignal | undefined { const scope = context.getStore(); invariant(!scope || scope.unit, "EXECUTION_STORE_REQUIRED", "Model work requires its document unit scope"); return guardDocumentCall(taskId, signal, config); }
export async function reserveModelCall(taskId: string, config: AiSnapshot, checkOnly = false): Promise<void> { guardModelCall(taskId, config); const scope = context.getStore(); if (scope?.unit) await scope.execution.reserve(scope.unit.key, scope.unit.allowance, checkOnly); }
