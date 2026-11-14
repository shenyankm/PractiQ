import type { ArtifactReference, UnitFailure } from "../src/contracts.generated.js";
import { AiStorage } from "./ai-storage.js";
import ocrPrompts from "./ocr-prompts.json" with { type: "json" };
import type { DocumentStageContext } from "./document-runtime.js";
import type { DocumentStageOutput } from "./document-tasks.js";
import { AppError, invariant } from "./errors.js";
import { executionJson } from "./graph-store.js";
import { compactModel } from "./model-defaults.js";
import { ModelClient, ModelOutputError } from "./model.js";
import { validateOcrPageAssociations } from "./ocr-associations.js";
import { ocrModelEvidence, ocrUnitInput, readOcrInputs } from "./ocr-inputs.js";
import { ocrPreviews } from "./ocr-previews.js";
import { completePageResult } from "./page-projection.js";
import { RETRYABLE_CODES as retryable } from "./retry-policy.js";
import { SourceText } from "./source-text.js";
import { assertKnownUnitCalls, MAX_MODEL_CALLS, MAX_OCR_MODEL_CALLS, MODEL_MAX_INPUT_CHARS, structuredCall } from "./structured-call.js";
import { UnitResults, type SavedUnit } from "./unit-results.js";
import { sourceIndexes } from "./source-selection.js";

export interface StructuredOcr { version: 1; taskId: string; sourceSha256: string; executionFingerprint: string; recognitionManifest: ArtifactReference; units: SavedUnit[] }
const unitFailures = new Set([...retryable, "MODEL_BUDGET_EXCEEDED", "MODEL_INPUT_TOO_LARGE", "AI_PROVIDER_ERROR", "AI_USAGE_MISSING", "AI_USAGE_INVALID", "OUTPUT_TRUNCATED", "AI_OUTPUT_INCOMPLETE", "AI_RESPONSE_INVALID"]);

/** PRIMARY and CONTEXT share one durable eight-call allowance and retain independent receipts. */
export class OcrStructures {
  constructor(readonly storage: AiStorage, readonly model: ModelClient, readonly concurrency = 2) { invariant(Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= 16, "LOCAL_FILTER_INVALID", "Invalid document concurrency"); }
  async structure(context: DocumentStageContext): Promise<DocumentStageOutput> {
    const { task } = context, source = readOcrInputs(this.storage, context), results = new UnitResults(context.store, this.storage, task.id, task.input.document.sha256, task.executionFingerprint!);
    const work = [];
    for (const index of sourceIndexes(task, "vision_parse", source.pages.length, source.recognized.version === 2 ? source.recognized.inputParts : [])) {
      const page = source.pages[index];
      const { scope, input, primaryText, identity, neighbors } = ocrUnitInput(task, source, index), cached = await results.get(identity), selected = !task.retryUnits.length || task.retryUnits.some(unit => unit.stage === "vision_parse" && unit.index === index);
      if (cached?.record.status === "unknown") throw new AppError("AI_RESULT_UNKNOWN", "An OCR unit has an unresolved outcome");
      work.push({ page, scope, input, primaryText, identity, neighbors, saved: cached && (cached.record.status === "succeeded" || cached.record.round === task.retry || !selected) ? cached.record : null });
    }
    for (const unit of work) if (!unit.saved && "failed" in unit.page) unit.saved = await results.failure(unit.identity, "TENCENT_PAGE_FAILED");
    const pending = work.filter(unit => unit.saved === null), key = (index: number) => `vision_parse:${index}:${task.retry}`;
    assertKnownUnitCalls(this.model, task.id, pending.map(unit => key(unit.identity.index)));
    for (let start = 0; start < pending.length; start += this.concurrency) {
      context.execution.guard(); const batch = pending.slice(start, start + this.concurrency), allowances = await context.execution.allocate(batch.map(unit => ({ key: key(unit.identity.index), calls: unit.neighbors.length ? MAX_OCR_MODEL_CALLS : MAX_MODEL_CALLS }))), controller = new AbortController(), signal = AbortSignal.any([context.signal, controller.signal]); let failed = false, firstError: unknown;
      await Promise.all(batch.map(async unit => {
        try {
          invariant(unit.scope && !("failed" in unit.page), "CHUNK_INPUTS_INVALID", "Failed OCR pages cannot start model work");
          const page = unit.page, images = await ocrPreviews(this.storage, page, signal), input = { ...unit.input, images }, allowance = allowances.get(key(unit.identity.index))!;
          if (new SourceText(input.system + input.text + images.map(image => image.label ?? "").join("")).length > MODEL_MAX_INPUT_CHARS) input.text = unit.primaryText;
          let projection: ReturnType<typeof validateOcrPageAssociations> | undefined;
          const validate = (primary?: ReturnType<typeof validateOcrPageAssociations>["page"]) => (value: unknown): unknown => {
            try { projection = validateOcrPageAssociations(value, page.figures, unit.scope!, primary, page); return { questions: projection.page.questions, groups: projection.page.groups, figures: projection.associations }; }
            catch (error) { if (error instanceof ModelOutputError) throw error; if (error instanceof AppError && ["UNIT_RESULT_INVALID", "LOCAL_SCHEMA_INVALID"].includes(error.code)) throw new ModelOutputError(error.message.slice(0, 20000)); throw error; }
          };
          const primary = await structuredCall({ ...context, signal }, this.model, key(unit.identity.index), allowance, input, validate(), "primary"); let failure = primary.failureCode, contextSkipped = false;
          if (!failure) {
            invariant(projection, "UNIT_RESULT_INVALID", "Validated PRIMARY projection is missing");
            const primaryProjection = projection, neighbors = primaryProjection.page.questions.length && primaryProjection.page.questions.every(question => question.id !== null) ? unit.neighbors : [];
            if (neighbors.length) {
              const text = ocrPrompts.context.replace(/\{(context|draft)\}/g, (_match, field) => field === "context" ? JSON.stringify(neighbors.map(index => ocrModelEvidence(source.pages[index], index))) : JSON.stringify(compactModel("OcrPageParseResult", primary.parsed as Record<string, unknown>)));
              projection = undefined;
              const enriched = await structuredCall({ ...context, signal }, this.model, key(unit.identity.index), allowance, { ...input, text: input.text + "\n" + text }, validate(primaryProjection.page), "context");
              if (enriched.failureCode === "MODEL_INPUT_TOO_LARGE") { projection = primaryProjection; contextSkipped = true; }
              else failure = enriched.failureCode;
            }
          }
          context.execution.guard(false);
          if (failure) { invariant(unitFailures.has(failure), failure, "Local OCR validation did not complete"); unit.saved = await results.failure(unit.identity, failure); return; }
          invariant(projection, "UNIT_RESULT_INVALID", "Validated OCR projection is missing");
          if (contextSkipped || source.recognized.inputParts.length || source.incomplete.includes(unit.identity.index)) for (const question of projection.page.questions) question.needsReview = true;
          for (const figure of projection.page.figures) for (const index of figure.questionIndexes ?? []) projection.page.questions[index].needsReview = true;
          const payload = completePageResult(projection.page, unit.identity.index, projection.page.figures.map((_, index) => index)); if (contextSkipped) payload.contextSkipped = true;
          const byId = new Map(page.figures.map(figure => [figure.elementIndex, figure]));
          payload.visuals.forEach((visual, index) => { const original = byId.get(projection!.associations[index].elementIndex)!; if (original.imageRef) visual.imageRef = original.imageRef; if (original.cropBbox) visual.cropBbox = original.cropBbox; });
          unit.saved = await results.save(unit.identity, payload);
        } catch (error) { if (!failed) firstError = error; failed = true; controller.abort(); }
      }));
      if (failed) throw firstError;
    }
    context.execution.guard(false); const units = work.map(unit => { invariant(unit.saved, "UNIT_RESULT_INVALID", "An OCR page has no durable outcome"); return unit.saved; });
    const value: StructuredOcr = { version: 1, taskId: task.id, sourceSha256: task.input.document.sha256, executionFingerprint: task.executionFingerprint!, recognitionManifest: source.manifest, units }, output = await this.storage.putArtifact(Buffer.from(executionJson(value)), value.sourceSha256, "structured-ocr", 0, "application/json"), failures: UnitFailure[] = units.filter(unit => unit.status !== "succeeded").map(unit => ({ stage: "vision_parse", index: unit.index, code: unit.code!, retryable: retryable.has(unit.code!) }));
    return { manifest: output, artifacts: [output, ...units.flatMap(unit => unit.resultRef ? [unit.resultRef] : [])], failures, progress: { chunks: { total: 0, succeeded: 0, failed: 0, remaining: 0 }, visuals: { total: units.length, succeeded: units.length - failures.length, failed: failures.length, remaining: 0 } } };
  }
}
