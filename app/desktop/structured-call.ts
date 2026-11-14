import { setTimeout as sleep } from "node:timers/promises";
import type { CallReceipt } from "./ai-database.js";
import { hash } from "./assets.js";
import type { DocumentStageContext } from "./document-runtime.js";
import { AppError, invariant } from "./errors.js";
import { ModelClient, type StructuredInput } from "./model.js";
import { object } from "./question-contract.js";
import { canonical } from "./questions.js";
import { SourceText } from "./source-text.js";

export const MAX_MODEL_CALLS = 4, MAX_OCR_MODEL_CALLS = 8, MODEL_MAX_INPUT_CHARS = 64_000;
export interface StructuredCallResult { parsed: unknown | null; calls: CallReceipt[]; failureCode: string | null }
const knownUsage = (value: unknown): boolean => ["inputTokens", "outputTokens", "cachedInputTokens"].every(key => Number.isSafeInteger(object(value)[key]) && Number(object(value)[key]) >= 0) && Number(object(value).cachedInputTokens) <= Number(object(value).inputTokens);

/** Check the entire pending round before concurrent units can enter their provider queues. */
export function assertKnownUnitCalls(client: ModelClient, taskId: string, keys: string[]): void {
  invariant(keys.every(key => /^(?:(?:document_parse|vision_parse):\d+:\d+|answer_generation:[a-f0-9]{64}:\d+)$/.test(key)), "EXECUTION_STORE_REQUIRED", "Invalid document unit scope");
  const pending = new Set(keys), unknown = client.database.db.prepare("SELECT call_key FROM ai_calls WHERE task_id=? AND status='unknown'").all(taskId);
  invariant(!unknown.some(row => pending.has(String(row.call_key).split(":").slice(0, 3).join(":"))), "AI_RESULT_UNKNOWN", "A document unit has an unresolved provider outcome; use an explicit retry");
}

/** Explicit document-unit work; each attempt is a distinct durable claim, never a transport retry. */
export async function structuredCall(context: DocumentStageContext, client: ModelClient, key: string, allowance: number, input: StructuredInput, validate: (value: unknown) => unknown, phase?: "primary" | "context"): Promise<StructuredCallResult> {
  context.execution.guard();
  invariant(/^[A-Za-z0-9:_-]{1,128}$/.test(key) && Number.isSafeInteger(allowance) && allowance >= 0 && allowance <= Math.min(phase ? MAX_OCR_MODEL_CALLS : MAX_MODEL_CALLS, context.task.maxCalls) && (!phase || input.schema === "OcrPageParseResult" && ["primary", "context"].includes(phase)) && input.correction === undefined, "EXECUTION_STORE_REQUIRED", "Structured correction requires a preallocated unit allowance and original input");
  if (!allowance) return { parsed: null, calls: [], failureCode: "MODEL_BUDGET_EXCEEDED" };
  return context.execution.unit(key, allowance, async () => {
    const calls: CallReceipt[] = []; let correction: StructuredInput["correction"], previousFailure: string | null = null, failureCode = "OUTPUT_INVALID";
    for (let attempt = 1; attempt <= MAX_MODEL_CALLS; attempt++) {
      context.execution.guard();
      const characters = new SourceText(input.system).length + new SourceText(input.text).length + (input.images ?? []).reduce((sum, image) => sum + new SourceText(image.label ?? "").length, 0) + (correction ? new SourceText(correction.output).length + new SourceText(correction.feedback).length : 0);
      if (characters > MODEL_MAX_INPUT_CHARS) return { parsed: null, calls, failureCode: "MODEL_INPUT_TOO_LARGE" };
      const callKey = `${key}${phase ? `:${phase}` : ""}:attempt:${attempt}`; let parsed: unknown, caught: unknown;
      try { parsed = (await client.structured(context.task.id, callKey, { ...input, ...(correction ? { correction } : {}) }, context.config, context.signal, validate)).value; }
      catch (error) { caught = error; }
      const receipt = client.database.receipt(context.task.id, callKey);
      if (receipt) calls.push(receipt);
      if (!caught) { invariant(receipt?.status === "succeeded" && knownUsage(receipt.usage), "AI_USAGE_INVALID", "Successful output has no valid durable usage"); return { parsed, calls, failureCode: null }; }
      if (caught instanceof AppError && caught.code === "MODEL_BUDGET_EXCEEDED") return { parsed: null, calls, failureCode: failureCode === "AI_PROVIDER_UNAVAILABLE" ? failureCode : caught.code };
      if (!receipt || receipt.status !== "failed" || caught instanceof AppError && caught.code === "AI_CALL_CONFLICT") throw caught;
      const failed = object(receipt.result);
      if (failed.code === "AI_REQUEST_REJECTED") {
        if (![409, 429].includes(Number(failed.status))) return { parsed: null, calls, failureCode: Number(failed.status) === 402 ? "AI_PROVIDER_BALANCE_REQUIRED" : Number(failed.status) === 401 || Number(failed.status) === 403 ? "AI_PROVIDER_AUTH_ERROR" : "AI_PROVIDER_ERROR" };
        failureCode = "AI_PROVIDER_UNAVAILABLE"; previousFailure = null;
        if (attempt < MAX_MODEL_CALLS) {
          const base = Math.min(2 ** (attempt - 1), 8); let delay = (base + Math.random() * base / 2) * 1000;
          while (delay > 0) { const interval = Math.min(1000, delay); await sleep(interval, undefined, { signal: context.signal }); delay -= interval; context.execution.guard(); }
        } continue;
      }
      if (!knownUsage(receipt.usage) || failed.validationCode === "NOT_RUN") return { parsed: null, calls, failureCode: typeof failed.code === "string" ? failed.code : "AI_USAGE_INVALID" };
      if (failed.validationCode === "OUTPUT_TRUNCATED") return { parsed: null, calls, failureCode: "OUTPUT_TRUNCATED" };
      invariant(failed.validationCode === "OUTPUT_INVALID" && typeof failed.output === "string" && failed.output.length <= 8 * 1024 * 1024 && typeof failed.feedback === "string" && failed.feedback.length > 0 && failed.feedback.length <= 20000, "TASK_CHECKPOINT_UNREADABLE", "Saved failed output has no valid correction receipt");
      const fingerprint = hash(canonical({ output: failed.output, error: failed.feedback }));
      if (fingerprint === previousFailure) return { parsed: null, calls, failureCode: "OUTPUT_STALLED" };
      previousFailure = fingerprint; failureCode = "OUTPUT_INVALID";
      correction = { output: failed.output, feedback: `Your previous output failed validation with these errors:\n${failed.feedback}\nReturn a complete corrected result. Follow the original task rules; never invent source content to pass validation.` };
      // Feedback is bounded independently of the raw output and complete original source.
      if (correction.feedback.length > 20000) correction.feedback = correction.feedback.slice(0, 20000);
    }
    return { parsed: null, calls, failureCode };
  });
}
