import type { DocumentTaskSummary, DocumentTaskReview } from "./contracts.generated";
import { invoke } from "./transport";
import { locale } from "./i18n";
import type { Preview, Session } from "./api";

export type TaskFilter = "active" | "paused" | "completed" | "cancelled" | "failed" | "review" | "interrupted" | "expired";

type Failure = {
  retryable: boolean;
  stage: string;
  index: number;
  code: string;
  message?: string;
};
export type Task = {
  expiresAt?: string;
  threadId: string;
  runId: string | null;
  checkpointId: string | null;
  state: string;
  phase: string;
  allowedActions: string[];
  blocking: unknown[];
  failures: Failure[];
  progress: Record<
    string,
    { total: number; succeeded: number; failed: number }
  >;
  usage: { inputTokens: number | null; outputTokens: number | null }[];
  unknownUsageCalls: string[];
};
export type ImportOperation = { checkpointId: string | null; state: "importing" | "failed"; error?: unknown };
export type ImportTaskContext = {
  threadId: string;
  onState: (state: "importing" | "failed", error?: unknown) => void;
  onImported: (bankId: string) => void;
};
export type Summary = DocumentTaskSummary & { importedBankId?: string | null; previouslyImported?: boolean; bankTitle?: string | null; bankDescription?: string | null };
export type Review = DocumentTaskReview;
export type PendingOperation = {
  id: string;
  label: string;
  error: { code?: string; message: string; diagnostic?: string; params?: Record<string, unknown> } | null;
};
export type Batch = {
  bankId?: string | null;
  id: string;
  status: "ready" | "running" | "paused" | "completed";
  items: {
    checkpointId: string;
    threadId: string;
    title: string;
    questionCount: number;
    reviewCount: number;
    partial: boolean;
    previousVersion: boolean;
    status: string;
    bankId: string | null;
    error: { code?: string; message: string; diagnostic?: string; params?: Record<string, unknown> } | null;
  }[];
};
export type Request =
  | { type: "grade"; id: string; ordinal: number; retry: boolean }
  | { type: "list"; offset: number; filter?: TaskFilter }
  | { type: "get" | "preview" | "review"; id: string }
  | { type: "reparse"; id: string }
  | { type: "select_document" }
  | { type: "delete"; id: string }
  | { type: "pick_document"; office_mode?: import("./office-api").OfficeMode; selection: string; details: { title: string; description: string } }
  | { type: "operations" }
  | {
      type: "control";
      id: string;
      action: string;
      run_id: string | null;
      checkpoint_id: string | null;
      units: unknown[];
    }
  | { type: "batches"; offset: number; thread_ids: string[] }
  | { type: "replay"; request_id: string }
  | { type: "prepare_batch"; ids: string[]; bank_id?: string | null }
  | { type: "run_batch"; id: string; titles: string[] | null }
  | { type: "cancel_batch"; id: string }
  | {
      type: "review_asset";
      id: string;
      checkpoint_id: string;
      unit: number;
      visual: number | null;
    };
type ResponseMap = {
  grade: Session;
  list: { items: Summary[]; hasMore: boolean };
  get: Task;
  preview: Preview;
  review: Review;
  select_document: { token: string; fileNames: string[] } | null;
  delete: { deleted: boolean };
  pick_document: { threadId: string; threadIds?: string[] } | null;
  reparse: { threadId: string } | null;
  operations: PendingOperation[];
  batches: { items: Batch[]; total: number; offset: number; operations: (ImportOperation & {threadId: string})[] };
  control: unknown;
  replay: unknown;
  prepare_batch: Batch;
  run_batch: Batch;
  cancel_batch: unknown;
  review_asset: { mediaType: string; content: string };
};
export function ai<R extends Request>(request: R): Promise<ResponseMap[R["type"]]> {
  return invoke<ResponseMap[R["type"]]>("ai_request", { request, locale: locale() });
}
export function readReviewImage(request: { id: string; checkpointId: string; unit: number; visual: number | null }): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("read_review_image", request);
}
