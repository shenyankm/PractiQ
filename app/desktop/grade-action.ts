import type { GradingResponse } from "../src/api.js";
import type { AiClient } from "./ai-client.js";
import type { AiSettings } from "./ai-settings.js";
import type { DatabaseClient } from "./client.js";
import { AppError, invariant } from "./errors.js";
import { GRADING_PROMPT_VERSION } from "./grading-result.js";
import { unknownGrade, type GradeTarget, type PreparedGrade } from "./grading.js";
import { object } from "./question-contract.js";
import type { SessionWire } from "./sessions.js";

export async function gradeAction(input: unknown, locale: string, settings: Pick<AiSettings, "snapshot">, database: Pick<DatabaseClient, "request">, runtime: () => Pick<AiClient, "call">): Promise<SessionWire> {
  const request = object(input);
  invariant(input !== null && typeof input === "object" && !Array.isArray(input) && Object.keys(request).every(key => ["type", "id", "ordinal", "retry", "snapshot_key"].includes(key)) && request.type === "grade" && typeof request.id === "string" && request.id.length > 0 && request.id.length <= 128 && Number.isSafeInteger(request.ordinal) && Number(request.ordinal) >= 0 && typeof request.retry === "boolean" && (request.snapshot_key === undefined || typeof request.snapshot_key === "string" && request.snapshot_key.length <= 256), "LOCAL_FILTER_INVALID", "Invalid grading fields");
  const config = await settings.snapshot(), model = config.preferences.model;
  invariant(model.baseUrl, "LOCAL_MODEL_URL_REQUIRED", "Configure the model endpoint in Settings");
  invariant(model.modelId, "LOCAL_MODEL_ID_REQUIRED", "Configure a model ID in Settings");
  invariant(config.secrets.modelApiKey, "LOCAL_MODEL_KEY_REQUIRED", "Configure a model API key in Settings");
  const target: GradeTarget = { kind: "electron", endpoint: `${model.baseUrl}/responses`, modelId: model.modelId, promptVersion: GRADING_PROMPT_VERSION };
  const preparedReply = await database.request({ type: "_prepare_grade", id: request.id, ordinal: request.ordinal, retry: request.retry, target }, locale);
  if (!preparedReply.ok) throw new AppError(preparedReply.error.code, preparedReply.error.message, preparedReply.error.params);
  const prepared = preparedReply.value as PreparedGrade;
  let operation: unknown = { type: "session", id: request.id, snapshot_key: request.snapshot_key };
  if (prepared.previous === undefined) {
    let response: GradingResponse;
    try { response = await runtime().call<GradingResponse>({ type: "grade", prepared, config }); }
    catch { response = unknownGrade(); }
    operation = { type: "_record_grade", id: request.id, ordinal: request.ordinal, prepared, response, snapshot_key: request.snapshot_key };
  }
  const reply = await database.request(operation, locale);
  if (!reply.ok) throw new AppError(reply.error.code, reply.error.message, reply.error.params);
  return reply.value as SessionWire;
}
