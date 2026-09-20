import { invoke } from "@tauri-apps/api/core";
export type Mode =
  | "choice"
  | "true_false"
  | "fill_blank"
  | "short_answer"
  | "ordering"
  | "matching";
export const modeNames: Record<string, string> = {
  choice: "选择题",
  true_false: "判断题",
  fill_blank: "填空题",
  short_answer: "简答题",
  ordering: "排序题",
  matching: "匹配题",
};
export type Answer = {
  correctOption?: string;
  correct?: string[];
  value?: boolean;
  answers?: string[];
  text?: string;
  order?: number[];
  matches?: { left: number; right: number }[];
};
export interface Option {
  label: string | null;
  content: string | null;
  isCorrect?: boolean | null;
}
export interface Item {
  id?: number | null;
  side?: "left" | "right" | null;
  content: string | null;
}
export interface Block {
  partType: string;
  role?: string | null;
  textValue?: string | null;
  markdownValue?: string | null;
  latexValue?: string | null;
  jsonValue?: Record<string, unknown> | null;
}
export interface Question {
  sourceScore?: number | null;
  scoringRubric?: string | null;
  scoreSourceText?: string | null;
  blankCount?: number;
  stem: string | null;
  answerMode: Mode | null;
  questionTypeId: string | null;
  choiceVariant?: "single" | "multiple" | null;
  matchingVariant?: "one_to_one" | "many_to_one" | null;
  options: Option[];
  items: Item[];
  answerPayload: Answer | null;
  analysis?: string | null;
  sourceText?: string | null;
  contentBlocks: Block[];
  needsReview: boolean;
  missingFields: string[];
  confidence: number;
}
export interface Group {
  id: string;
  title: string;
  instructions?: string | null;
  questionIds: string[];
}
export interface Visual {
  id: string;
  kind: string;
  description: string;
  label?: string | null;
  extractedText?: string | null;
  questionIds: string[];
  imageRef?: {
    sha256: string;
    objectKey: string;
    mediaType: string;
    sizeBytes: number;
  } | null;
}
export interface Snapshot {
  question: Question;
  groups: Group[];
  visuals: Visual[];
  sources: Record<string, unknown>[];
  warnings: string[];
  missingAssets: boolean;
}
export interface QuestionRow extends Snapshot {
  id: string;
  bankId: string;
  bankTitle: string;
  favorite: boolean;
  latestResult: boolean | null;
}
export interface Bank {
  id: string;
  title: string;
  description: string;
  count: number;
  createdAt: number;
}
export interface Attempt {
  favorite?: boolean | null;
  ordinal: number;
  snapshot: Snapshot & Partial<QuestionRow>;
  answer: Answer | null;
  autoResult: boolean | null;
  result: boolean | null;
  gradeKind: "auto" | "self" | "ungraded" | "ai" | "manual";
  maxCents?: number | null;
  earnedCents?: number | null;
  flagged?: boolean;
  grading?: { lastRequest?: {status: string; error?: string}; ai?: {status: string; error?: string; result?: {scoreCents: number | null; maxCents: number; reason: string; evidence: string[]; reviewReasons: string[]}}; manual?: {reason: string; scoreCents: number} };
  submittedAt: number | null;
  skipped: boolean;
  elapsedMs: number;
}
export type SessionKind = "practice" | "self_test" | "mock_exam";
export interface Session {
  kind?: SessionKind;
  deadlineAt?: number | null;
  submittedAt?: number | null;
  id: string;
  title: string;
  createdAt: number;
  finishedAt: number | null;
  position: number;
  mode: string;
  attempts: Attempt[];
}
export interface SessionSummary {
  kind?: SessionKind;
  submittedAt?: number | null;
  totalCents?: number | null;
  earnedCents?: number | null;
  pendingGrades?: number;
  id: string;
  title: string;
  createdAt: number;
  finishedAt: number | null;
  count: number;
  answered: number;
  correct: number;
  graded: number;
  skipped: number;
  elapsedMs: number;
  selfGraded: number;
  autoGraded: number;
}
export interface Preview {
  questions?: Question[];
  ticket: string;
  title: string;
  count: number;
  reviewCount: number;
  warnings: string[];
  status: string | null;
  processing: unknown;
  missingAssets: string[];
  assetCount: number;
}
type Query = {
  bank_ids?: string[];
  bank_id: string | null;
  search: string;
  mode: string;
  filter: string;
};
export interface Paper { question_ids: string[]; kind: SessionKind; minutes: number | null; scores: number[]; total_cents: number }
type Request =
  | { type: "start_paper"; paper: Paper }
  | { type: "submit_paper"; id: string; submit_drafts: boolean }
  | { type: "complete_review" | "retry_wrong"; id: string }
  | { type: "flag"; id: string; ordinal: number; value: boolean }
  | { type: "manual_score"; id: string; ordinal: number; cents: number; reason: string }
  | { type: "merge_banks"; bank_ids: string[]; title: string }
  | { type: "settings" }
  | {
      type: "save_settings";
      config: ConnectionSettings;
      api_key: string | null;
    }
  | {
      type:
        | "pick_import"
        | "pick_resources"
        | "banks"
        | "sessions"
        | "backup"
        | "restore"
        | "info";
    }
  | { type: "import"; ticket: string; bank_id: string | null; title: string }
  | { type: "save_bank"; id: string | null; title: string; description: string }
  | {
      type: "delete_bank" | "delete_question" | "session" | "finish";
      id: string;
    }
  | ({ type: "questions" } & Query)
  | {
      type: "save_question";
      id: string | null;
      bank_id: string;
      question: Question;
    }
  | { type: "favorite"; id: string; value: boolean }
  | {
      type: "save_attempt";
      id: string;
      ordinal: number;
      answer: Answer | null;
      elapsed_ms: number;
      submit: boolean;
      skip: boolean;
      self_result: boolean | null;
    }
  | { type: "position"; id: string; position: number }
  | { type: "asset"; hash: string };
export function api<T>(request: Request): Promise<T> {
  return invoke<T>("request", { request });
}
export function errorMessage(error: unknown): string {
  const message = typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : String(error);
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const action: Record<string, string> = {
    STALE_CHECKPOINT: "请刷新任务或重新创建导入批次。",
    STALE_RUN: "请刷新任务状态。",
    TASK_BUSY: "请等待当前运行结束后刷新。",
    AI_PROVIDER_AUTH_ERROR: "请在设置中修正密钥，再重试失败项。",
    AI_PROVIDER_UNAVAILABLE: "请稍后重试失败项。",
    EXECUTION_VERSION_MISMATCH: "请使用原执行版本，或重新解析文档。",
    LOCAL_SERVICE_UNAVAILABLE: "如有待确认操作，请从原操作重试。",
  };
  return action[code] ? `${message} ${action[code]}` : message;
}
export function duration(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
export function date(ms: number) {
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}
export function itemIds(q: Question, side?: "left" | "right") {
  return q.items
    .filter((i) => !side || i.side === side)
    .map((item, i) => ({ ...item, id: item.id ?? i }));
}
export function answerReady(q: Question, a: Answer | null): boolean {
  if (!a) return false;
  switch (q.answerMode) {
    case "choice":
      return q.choiceVariant === "multiple"
        ? !!a.correct?.length
        : !!a.correctOption;
    case "true_false":
      return typeof a.value === "boolean";
    case "fill_blank":
      return !!a.answers?.length && a.answers.every((s) => s.trim());
    case "ordering":
      return !!a.order?.length;
    case "matching":
      return (
        !!a.matches?.length && a.matches.length === itemIds(q, "left").length
      );
    default:
      return !!a.text?.trim();
  }
}
export function canInteract(q: Question) {
  if (!q.answerMode) return false;
  if (q.answerMode === "choice")
    return (
      !!q.choiceVariant &&
      q.options.length >= 2 &&
      q.options.every((o) => o.label && o.content)
    );
  if (q.answerMode === "ordering")
    return (
      q.items.length >= 2 &&
      q.items.every((i) => i.content) &&
      new Set(itemIds(q).map((i) => i.id)).size === q.items.length
    );
  if (q.answerMode === "matching")
    return (
      !!q.matchingVariant &&
      ["left", "right"].every((s) => {
        const items = itemIds(q, s as "left" | "right");
        return (
          items.length >= 2 &&
          items.every((i) => i.content) &&
          new Set(items.map((i) => i.id)).size === items.length
        );
      })
    );
  return true;
}

export interface ConnectionSettings {
  base_url: string | null;
  model_id: string | null;
  text_model: string | null;
  vision_model: string | null;
  oss_url: string | null;
}
export interface SettingsResult {
  config: ConnectionSettings;
  hasApiKey: boolean;
}

export function missingModelSettings(settings: SettingsResult): string[] {
  return [
    !settings.config.base_url?.trim() && "模型 API 地址",
    !settings.config.text_model?.trim() && "文本模型",
    !settings.config.vision_model?.trim() && "视觉模型",
    !settings.hasApiKey && "API Key",
  ].filter((field): field is string => !!field);
}
