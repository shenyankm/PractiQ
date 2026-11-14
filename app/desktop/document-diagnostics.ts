import type { DocumentTaskDetail } from "../src/contracts.generated.js";
import { AppError } from "./errors.js";

const evidenceCodes = new Set([
  "TASK_CHECKPOINT_UNREADABLE", "DOCUMENT_CHECKSUM_MISMATCH", "INVALID_REFERENCE", "INVALID_OBJECT_REFERENCE",
  "DOCUMENT_TOO_LARGE", "LOCAL_FILE_TOO_LARGE", "LOCAL_RESPONSE_INVALID", "LOCAL_SCHEMA_INVALID", "LOCAL_JSON_TOO_LARGE",
  "LOCAL_JSON_VERSION", "LOCAL_GROUP_TITLE_EMPTY", "LOCAL_PROCESSING_COUNT_INVALID", "LOCAL_QUESTION_INDEX_INVALID",
  "LOCAL_VISUAL_BBOX_INVALID", "LOCAL_VISUAL_DESCRIPTION_EMPTY", "OUTPUT_INVALID", "UNIT_RESULT_INVALID", "UNIT_NOT_COMPLETED", "CHUNK_INPUTS_INVALID",
]);
/** Storage outages must propagate; only invalid or missing saved evidence is isolated. */
export function unreadableEvidence(error: unknown): boolean {
  if (error instanceof AppError) return evidenceCodes.has(error.code);
  if (error instanceof Error && "code" in error) return ["ENOENT", "ENOTDIR", "ELOOP", "ERR_ENCODING_INVALID_ENCODED_DATA"].includes(String(error.code));
  return error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError;
}
export function unreadableDetail(detail: DocumentTaskDetail): DocumentTaskDetail {
  return { ...detail, state: ["EXPIRED", "PENDING", "RUNNING", "PAUSING"].includes(detail.state) ? detail.state : "FAILED", resumeCompatible: false,
    allowedActions: detail.allowedActions.filter(action => action === "pause" || action === "interrupt"),
    blocking: [...detail.blocking.filter(value => !(value !== null && typeof value === "object" && "code" in value && value.code === "TASK_CHECKPOINT_UNREADABLE")), { code: "TASK_CHECKPOINT_UNREADABLE" }],
    result: null, processing: null, status: null, canExportCompleted: false };
}
