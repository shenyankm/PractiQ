import type { ArtifactReference, UnitFailure } from "../src/contracts.generated.js";
import { AiStorage } from "./ai-storage.js";
import type { DocumentStageContext } from "./document-runtime.js";
import type { DocumentStageOutput } from "./document-tasks.js";
import { AppError, invariant } from "./errors.js";
import { executionJson } from "./graph-store.js";
import { ModelClient } from "./model.js";
import { RETRYABLE_CODES as retryable } from "./retry-policy.js";
import { validateSourceFields } from "./source-fields.js";
import { assertKnownUnitCalls, MAX_MODEL_CALLS, structuredCall } from "./structured-call.js";
import { UnitResults, type SavedUnit } from "./unit-results.js";
import { readTextInputs, textUnitInput } from "./text-inputs.js";
import { readRecognizedText } from "./text-inputs.js";
import { OcrStructures } from "./ocr-structures.js";
import { sourceIndexes } from "./source-selection.js";

const unitFailures = new Set([...retryable, "MODEL_BUDGET_EXCEEDED", "MODEL_INPUT_TOO_LARGE", "AI_PROVIDER_ERROR", "AI_USAGE_MISSING", "AI_USAGE_INVALID", "OUTPUT_TRUNCATED", "AI_OUTPUT_INCOMPLETE", "AI_RESPONSE_INVALID"]);
export interface StructuredText { version: 1; taskId: string; sourceSha256: string; executionFingerprint: string; chunkManifest: ArtifactReference; units: SavedUnit[] }

/** Actual model units, durable reservations and partial evidence; merge remains a separate graph stage. */
export class TextStructures {
  constructor(readonly storage: AiStorage, readonly model: ModelClient, readonly concurrency = 2) {
    invariant(Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= 16, "LOCAL_FILTER_INVALID", "Invalid document concurrency");
  }
  async structure(context: DocumentStageContext): Promise<DocumentStageOutput> {
    if (readRecognizedText(this.storage, context).recognized.textRef === null) return new OcrStructures(this.storage, this.model, this.concurrency).structure(context);
    const { task } = context, { chunks, chunkManifest } = readTextInputs(this.storage, context);
    const results = new UnitResults(context.store, this.storage, task.id, task.input.document.sha256, task.executionFingerprint!);
    const work = [];
    // Validate every chunk and cached result before the first model request.
    for (const index of sourceIndexes(task, "document_parse", chunks.chunkRefs.length)) {
      const { identity, input, scope } = textUnitInput(this.storage, task, chunks, index), cached = await results.get(identity), selected = !task.retryUnits.length || task.retryUnits.some(unit => unit.index === index);
      if (cached?.record.status === "unknown") throw new AppError("AI_RESULT_UNKNOWN", "A model unit has an unresolved outcome");
      work.push({ identity, input, scope, saved: cached && (cached.record.status === "succeeded" || cached.record.round === task.retry || !selected) ? cached.record : null });
    }
    const pending = work.filter(unit => unit.saved === null), key = (index: number) => `document_parse:${index}:${task.retry}`;
    assertKnownUnitCalls(this.model, task.id, pending.map(unit => key(unit.identity.index)));
    for (let start = 0; start < pending.length; start += this.concurrency) {
      context.execution.guard(); const batch = pending.slice(start, start + this.concurrency);
      const allowances = await context.execution.allocate(batch.map(unit => ({ key: key(unit.identity.index), calls: MAX_MODEL_CALLS })));
      const controller = new AbortController(), signal = AbortSignal.any([context.signal, controller.signal]); let failure: unknown, failed = false;
      await Promise.all(batch.map(async unit => {
        try {
          const result = await structuredCall({ ...context, signal }, this.model, key(unit.identity.index), allowances.get(key(unit.identity.index))!, unit.input, value => validateSourceFields(value, unit.scope));
          context.execution.guard(false);
          if (result.failureCode) {
            invariant(unitFailures.has(result.failureCode), result.failureCode, "Local model validation did not complete"); unit.saved = await results.failure(unit.identity, result.failureCode);
          } else unit.saved = await results.save(unit.identity, { parsed: result.parsed, visuals: [] });
        } catch (error) { if (!failed) failure = error; failed = true; controller.abort(); }
      }));
      if (failed) throw failure;
    }
    context.execution.guard(false); const units = work.map(unit => { invariant(unit.saved, "UNIT_RESULT_INVALID", "A model unit has no durable result"); return unit.saved; });
    const value: StructuredText = { version: 1, taskId: task.id, sourceSha256: task.input.document.sha256, executionFingerprint: task.executionFingerprint!, chunkManifest, units };
    const output = await this.storage.putArtifact(Buffer.from(executionJson(value)), value.sourceSha256, "structured-text", 0, "application/json");
    const failures: UnitFailure[] = units.filter(unit => unit.status !== "succeeded").map(unit => ({ stage: "document_parse", index: unit.index, code: unit.code!, retryable: retryable.has(unit.code!) })), succeeded = units.length - failures.length;
    return { manifest: output, artifacts: [output, ...units.flatMap(unit => unit.resultRef ? [unit.resultRef] : [])], failures, progress: { chunks: { total: units.length, succeeded, failed: failures.length, remaining: 0 }, visuals: { total: 0, succeeded: 0, failed: 0, remaining: 0 } } };
  }
}
