import type { AiSnapshot } from "./ai-settings.js";
import { AiDatabase } from "./ai-database.js";
import { hash } from "./assets.js";
import { schemaFor, type Schema } from "./contract-source.js";
import { validateContract } from "./contracts.js";
import { AppError, invariant } from "./errors.js";
import { jsonResponse, type HttpFetch } from "./ai-http.js";
import { parseModelJson } from "./ai-json.js";
import { canonical } from "./questions.js";
import { list, object, text } from "./question-contract.js";
import { validateImage } from "./media.js";
import { guardModelCall, reserveModelCall } from "./document-execution.js";
import { modelSlots } from "./provider-slots.js";
import { CostBudget, costSettings, modelEstimate } from "./cost-budget.js";

export interface StructuredInput { schema: string; promptVersion: string; system: string; text: string; images?: { mediaType: "image/png" | "image/jpeg"; bytes: Uint8Array; label?: string }[]; correction?: { output: string; feedback: string } }
export interface ModelUsage { inputTokens: number; outputTokens: number; cachedInputTokens: number }
export class ModelOutputError extends AppError {
  constructor(readonly feedback: string) { super("OUTPUT_INVALID", "Model output did not preserve the supplied source"); invariant(typeof feedback === "string" && feedback.length > 0 && feedback.length <= 20000, "AI_RESPONSE_INVALID", "Invalid model validation feedback"); }
}
const extractionDescriptions: Record<string, string> = {
  stem: "Remove only the leading question number and exercise-type prefix, then preserve the printed exercise title or question wording literally; do not substitute a generic exercise name. This applies to composite parent titles too; keep the separate passage out of stem. When a gap child has no printed prompt, use its local source wording or hint, not just the gap number. For example, a gap in 'Ice is [1]' has stem 'Ice is', not '1'.",
  questionKind: "Null for ordinary choice, true_false, fill_blank, short_answer, ordering, matching. Specialized kind only when explicitly supported; must match answerMode. Never propagate a parent kind to a child.",
  parentId: "ID of an actual composite material parent in this document; null for ALL standalone questions. Never use a section heading or previous standalone question as parent.",
  choiceVariant: "single/multiple ONLY for answerMode=choice. Null for every other answerMode, including true_false and short_answer.",
  options: "Choice options, or shared word_bank options; [] for every other answerMode. Shared-option children have [] and optionSourceId=parent ID.",
  matchingVariant: "one_to_one/many_to_one ONLY for matching; null otherwise.",
  blankCount: "Positive number ONLY for fill_blank children or standalone fill blanks; null for all other modes, including composite parents.",
  passage: "Shared material ONLY for reading, word_bank, cloze, listening, gap_fill parents. Empty for standalone questions and children. Listening transcript belongs in transcript instead. Replace the entire printed gap marker, including its local number, with one blank block; never leave the marker number in adjacent text.",
  items: "Ordering or matching items ONLY; [] otherwise. Matching IDs are independent zero-based integers within each side; labels preserve printed letters/numbers.",
  sourceLanguage: "Only for translation and only when source direction is explicit; null for ordinary questions and writing.",
  targetLanguage: "Only for translation/writing; explicit in English means en, in Chinese means zh. Null for other kinds or absent direction.",
  minWords: "Only explicitly printed writing word limits; null otherwise. Do not supply 0 as an absent value.",
  maxWords: "Only explicitly printed writing word limits; null otherwise. Do not supply 0 or 1 as an absent value.",
  missingFields: "Only media/material when source resources are missing. The service computes other review fields; do not list scores, language or optional metadata.",
};
export function modelSchema(name: string): Schema {
  const schema = structuredClone(schemaFor(name));
  function visit(value: unknown): void {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === "object") {
      const node = value as Schema, properties = node.properties ?? {}; delete node.multipleOf;
      if (Object.hasOwn(properties, "answerMode") && Object.hasOwn(properties, "sourceText")) {
        node.required = ["stem", "answerMode", "answerPayload", "sourceText", "passage", "contentBlocks"];
        if (properties.missingFields?.items) properties.missingFields.items.enum = ["media", "material"];
        for (const [field, description] of Object.entries(extractionDescriptions)) if (properties[field]) properties[field].description = description;
      } else if (["side", "id", "content", "label"].every(field => Object.hasOwn(properties, field))) {
        node.required = Object.keys(properties);
        properties.side.description = "Required left/right for each matching item; null for ordering.";
        properties.id.description = "Always supply an integer ID for ordering/matching items: zero-based position for ordering, independently from zero within each matching side. Answers reference these IDs, not printed labels or the global matching array position.";
      } else if (["questions", "groups"].every(field => Object.hasOwn(properties, field)) || ["bbox", "description", "kind"].every(field => Object.hasOwn(properties, field))) node.required = Object.keys(properties);
      Object.values(node).forEach(visit);
    }
  }
  visit(schema); return schema;
}
function usageOf(value: unknown): ModelUsage {
  const usage = object(value);
  invariant(Object.hasOwn(usage, "input_tokens") && Object.hasOwn(usage, "output_tokens"), "AI_USAGE_MISSING", "Provider token usage is missing");
  const input = usage.input_tokens, output = usage.output_tokens, cached = object(usage.input_tokens_details).cached_tokens ?? 0;
  invariant([input, output, cached].every(value => Number.isSafeInteger(value) && Number(value) >= 0) && Number(cached) <= Number(input), "AI_USAGE_INVALID", "Provider token usage is invalid");
  return { inputTokens: Number(input), outputTokens: Number(output), cachedInputTokens: Number(cached) };
}

/** One bounded Responses request; workflow retries must use separately authorized call identities. */
export class ModelClient {
  private costs?: CostBudget;
  bindCosts(costs: CostBudget): void { invariant(!this.costs || this.costs === costs, "COST_STORE_REQUIRED", "Model cost admission must retain its original Store"); this.costs = costs; }
  constructor(readonly database: AiDatabase, private readonly http: HttpFetch = fetch) {}
  async structured(taskId: string, key: string, input: StructuredInput, config: AiSnapshot, signal?: AbortSignal, validate?: (value: unknown) => unknown): Promise<{ value: unknown; usage: ModelUsage }> {
    signal = guardModelCall(taskId, config, signal);
    return modelSlots.run(16, signal, () => this.perform(taskId, key, input, config, signal, validate));
  }
  private async perform(taskId: string, key: string, input: StructuredInput, config: AiSnapshot, signal?: AbortSignal, validate?: (value: unknown) => unknown): Promise<{ value: unknown; usage: ModelUsage }> {
    signal = guardModelCall(taskId, config, signal);
    const model = config.preferences.model, schema = modelSchema(input.schema);
    invariant(model.modelId && model.baseUrl && config.secrets.modelApiKey, "MODEL_NOT_CONFIGURED", "Configure model settings and an API key");
    invariant(typeof input.system === "string" && typeof input.text === "string" && input.system.length + input.text.length <= 32 * 1024 * 1024 && (input.images?.length ?? 0) <= 50 && (input.images ?? []).every(image => ["image/png", "image/jpeg"].includes(image.mediaType) && image.bytes instanceof Uint8Array && image.bytes.length <= 25 * 1024 * 1024 && (image.label === undefined || typeof image.label === "string" && image.label.length <= 2048)) && (input.images ?? []).reduce((sum, image) => sum + image.bytes.length, 0) <= 24 * 1024 * 1024, "AI_INPUT_TOO_LARGE", "Split the model input before sending");
    invariant(input.correction === undefined || input.correction !== null && typeof input.correction === "object" && Object.keys(input.correction).length === 2 && typeof input.correction.output === "string" && input.correction.output.length <= 8 * 1024 * 1024 && typeof input.correction.feedback === "string" && input.correction.feedback.length > 0 && input.correction.feedback.length <= 20000, "AI_INPUT_TOO_LARGE", "Invalid bounded model correction context");
    for (const image of input.images ?? []) await validateImage(image.bytes, image.mediaType);
    const content = [{ type: "input_text", text: input.text }, ...(input.images ?? []).flatMap(image => [...(image.label === undefined ? [] : [{ type: "input_text", text: image.label }]), { type: "input_image", image_url: `data:${image.mediaType};base64,${Buffer.from(image.bytes).toString("base64")}`, detail: "auto" }])];
    const payload = { model: model.modelId, input: [{ role: "system", content: [{ type: "input_text", text: input.system }] }, { role: "user", content }, ...(input.correction ? [{ role: "assistant", content: input.correction.output }, { role: "user", content: input.correction.feedback }] : [])], store: false, stream: false, max_output_tokens: model.maxOutputTokens,
      tools: [{ type: "function", name: input.schema, description: "Return the structured result", parameters: schema, strict: false }], tool_choice: { type: "function", name: input.schema }, parallel_tool_calls: false,
      ...(model.provider === "deepseek" ? { reasoning: { effort: "none" } } : {}), ...(model.baseUrl === "https://dashscope.aliyuncs.com/compatible-mode/v1" && model.modelId.startsWith("qwen3.7-") ? { enable_thinking: false } : {}) };
    const serialized = JSON.stringify(payload); invariant(Buffer.byteLength(serialized) <= 32 * 1024 * 1024, "AI_INPUT_TOO_LARGE", "Model request exceeds its byte limit");
    const target = { inputDigest: hash(canonical(payload)), endpoint: `${model.baseUrl}/responses`, model: model.modelId, promptVersion: input.promptVersion }, previous = this.database.receipt(taskId, key);
    if (previous) {
      invariant(previous.inputDigest === target.inputDigest && previous.endpoint === target.endpoint && previous.model === target.model && previous.promptVersion === target.promptVersion, "AI_CALL_CONFLICT", "Saved model call targets different input or configuration");
      invariant(previous.status === "succeeded", previous.status === "unknown" ? "AI_RESULT_UNKNOWN" : "AI_CALL_FAILED", "A saved call cannot be replayed; use an explicit retry");
      const value = validate ? validate(structuredClone(previous.result)) : previous.result; validateContract(input.schema, value); return { value, usage: previous.usage as ModelUsage };
    }
    const cost = this.costs ? this.costs.policy(config.preferences.cost, true) : costSettings(config.preferences.cost);
    if (cost.enabled) {
      await reserveModelCall(taskId, config, true); invariant(this.costs, "COST_STORE_REQUIRED", "Enabled cost limits require their durable Store");
      this.costs.reserve(cost, `${input.schema === "GradeResult" ? "grading" : "task"}:${taskId}`, key, modelEstimate(Buffer.byteLength(serialized), model.maxOutputTokens, cost), "model", hash(canonical(target)));
    }
    await reserveModelCall(taskId, config); signal?.throwIfAborted(); this.database.claim(taskId, key, target);
    const timeout = AbortSignal.timeout(model.timeoutSeconds * 1000), abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let body: Record<string, unknown>, response: Response;
    try {
      response = await this.http(target.endpoint, { method: "POST", body: serialized, headers: { Authorization: `Bearer ${config.secrets.modelApiKey}`, "Content-Type": "application/json", "Accept-Encoding": "identity" }, redirect: "error", signal: abort });
    } catch { throw new AppError("AI_RESULT_UNKNOWN", "Provider outcome is unknown; the request will not be automatically replayed"); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if ([400, 401, 402, 403, 404, 409, 413, 422, 429].includes(response.status)) { this.database.finish(taskId, key, "failed", { code: "AI_REQUEST_REJECTED", status: response.status }, { status: "unknown" }); throw new AppError("AI_REQUEST_REJECTED", "Provider rejected the model request", { status: response.status }); }
      throw new AppError("AI_RESULT_UNKNOWN", "Provider outcome is unknown; the request will not be automatically replayed");
    }
    try { body = object(await jsonResponse(response, 8 * 1024 * 1024)); }
    catch { throw new AppError("AI_RESULT_UNKNOWN", "Provider outcome is unknown; the request will not be automatically replayed"); }
    if (body.error != null) throw new AppError("AI_RESULT_UNKNOWN", "Provider returned an ambiguous response envelope");
    let usage: ModelUsage | undefined, value: unknown;
    const calls = list(body, "output").filter(item => text(item, "type") === "function_call"), output = calls.length === 1 && typeof object(calls[0]).arguments === "string" ? String(object(calls[0]).arguments) : JSON.stringify(calls.map(call => ({ name: text(call, "name"), arguments: object(call).arguments ?? null })));
    try {
      usage = usageOf(body.usage);
      invariant(body.status === "completed", "AI_OUTPUT_INCOMPLETE", "Provider output was not completed");
      invariant(calls.length === 1 && text(calls[0], "name") === input.schema && typeof object(calls[0]).arguments === "string", "AI_RESPONSE_INVALID", "Expected one result matching the requested schema");
      value = parseModelJson(String(object(calls[0]).arguments), schema);
      // Preserve the original grading contract's bounded decimal-string normalization.
      if (input.schema === "GradeResult" && typeof object(value).scoreCents === "string" && /^[0-9]{1,9}$/.test(String(object(value).scoreCents))) object(value).scoreCents = Number(object(value).scoreCents);
      if (validate) {
        try { value = validate(value); }
        catch (error) { if (error instanceof AppError) throw error; throw new AppError("AI_VALIDATOR_FAILED", "Local output validation failed"); }
      }
      validateContract(input.schema, value);
    } catch (error) {
      const code = error instanceof AppError ? error.code : "AI_RESPONSE_INVALID";
      const validationCode = !["OUTPUT_INVALID", "AI_RESPONSE_INVALID", "LOCAL_SCHEMA_INVALID", "AI_OUTPUT_INCOMPLETE"].includes(code) ? "NOT_RUN" : code === "AI_OUTPUT_INCOMPLETE" && object(body.incomplete_details).reason === "max_output_tokens" ? "OUTPUT_TRUNCATED" : "OUTPUT_INVALID";
      this.database.finish(taskId, key, "failed", { code, output, validationCode, feedback: error instanceof ModelOutputError ? error.feedback : "Return one complete result matching the declared schema. Preserve source content and use actual JSON arrays for array fields." }, usage ?? { status: "unknown" }); throw new AppError(code, "Model output or usage did not pass validation");
    }
    this.database.finish(taskId, key, "succeeded", value, usage); return { value, usage };
  }
}
