import nativeMessages from "./locales/native.json";
import { t, locale, MessageError, renderMessage, type LanguageRequest } from "./i18n";
import { invoke } from "@tauri-apps/api/core";
import type { Question, Answer, ParsedOption as Option, ParsedItem as Item, ContentBlock as Block } from "./contracts.generated";
export type { Question, Answer, Option, Item, Block };
export type Mode = NonNullable<Question["answerMode"]>;
export function isComposite(q: Question) { return q.answerMode === "reading" || q.answerMode === "word_bank" || q.answerMode === "cloze"; }
export function modeNames(): Record<string, string> { return {
  choice: t("选择题"),
  true_false: t("判断题"),
  fill_blank: t("填空题"),
  short_answer: t("简答题"),
  ordering: t("排序题"),
  matching: t("匹配题"),
  reading: t("阅读理解"), word_bank: t("选词填空"), cloze: t("完形填空"),
}; }
export interface Group {
  id: string;
  title: string;
  instructions?: string | null;
  questionIds: string[];
}
export interface ImageReference {
  sha256: string; objectKey: string; mediaType: string; sizeBytes: number;
}
export interface Visual {
  role?: string | null;
  id: string;
  kind: string;
  description: string;
  label?: string | null;
  extractedText?: string | null;
  questionIds: string[];
  imageRef?: ImageReference | null;
  sourceRef?: ImageReference | null;
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
  rootId?: string;
  rootType?: string;
  children?: QuestionRow[];
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
  grading?: { lastRequest?: {status: string; error?: string; appError?: unknown}; ai?: {status: string; error?: string; appError?: unknown; result?: {scoreCents: number | null; maxCents: number; reason: string; evidence: string[]; reviewReasons: string[]}}; manual?: {reason: string; scoreCents: number} };
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
  groups?: Group[];
  visuals?: Visual[];
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
export interface Paper { question_ids: string[]; kind: SessionKind; minutes: number | null; scores: number[]; total_cents: number; digest: string }
export interface PaperPreview { questionIds: string[]; digest: string; questions: QuestionRow[]; scores: number[]; count: number }
export interface PaperSelection { bank_ids: string[]; search: string; mode: string; filter: string; selection: string; count: number; quotas: Record<string,number>; question_ids: string[]; random: boolean; total_cents: number; budgets?: Record<string,number> }
type Request =
  | { type: "preview_paper"; request: PaperSelection }
  | { type: "save_question_tree"; bank_id: string; root_id: string | null; questions: Question[] }

  | LanguageRequest
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
  return invoke<T>("request", { request, locale: locale() });
}
export function errorMessage(error: unknown): string {
  if (error instanceof MessageError) return renderMessage(error.localized);
  const object = typeof error === "object" && error !== null ? error as Record<string, unknown> : {};
  const code = String(object.code ?? (typeof error === "string" && /^[A-Z_]+$/.test(error) ? error : ""));
  const entry = nativeMessages[code as keyof typeof nativeMessages];
  const params = (object.params ?? {}) as Record<string, unknown>;
  if (entry) {
    const summary = entry[locale()].replace(/\{(\w+)\}/g, (_, key: string) => String(params[key] ?? ""));
    const detail = [object.context, object.requestId, object.httpStatus].filter(v => v != null).join(" · ");
    const diagnostic = !code.startsWith("LOCAL_") && typeof object.message === "string" && !Object.values(entry).includes(object.message as never)
      ? ` ${t("诊断详情")}: ${object.message}` : "";
    return `${summary}${diagnostic}${detail ? ` (${detail})` : ""}`;
  }
  const actions: Record<string, string> = {
    STALE_CHECKPOINT: t("请刷新任务或重新创建导入批次。"),
    STALE_RUN: t("请刷新任务状态。"),
    TASK_BUSY: t("请等待当前运行结束后刷新。"),
    AI_PROVIDER_AUTH_ERROR: t("模型鉴权失败，请检查设置中的 API Key，再重试失败项。"),
    AI_PROVIDER_UNAVAILABLE: t("请稍后重试失败项。"),
    EXECUTION_VERSION_MISMATCH: t("请使用原执行版本，或重新解析文档。"),
    LOCAL_SERVICE_UNAVAILABLE: t("如有待确认操作，请从原操作重试。"),
  };
  const diagnostic = String(object.message ?? error);
  const metadata = [code, object.requestId, object.httpStatus].filter(v => v != null && v !== "").join(" · ");
  return `${actions[code] || t("操作失败，请查看诊断详情。")} ${t("诊断详情")}: ${diagnostic}${metadata ? ` (${metadata})` : ""}`;
}
export function duration(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return t("{0} 分 {1} 秒", { 0: Math.floor(seconds / 60), 1: seconds % 60 });
}
export function date(ms: number) {
  return new Date(ms).toLocaleString(locale(), { hour12: false });
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
      return q.choiceVariant === "single" ? a.correct?.length === 1 : !!a.correct?.length;
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
  oss_url: string | null;
}
export interface SettingsResult {
  config: ConnectionSettings;
  hasApiKey: boolean;
}

export function missingModelSettings(settings: SettingsResult): string[] {
  return [
    !settings.config.base_url?.trim() && t("模型 API 地址"),
    !settings.config.model_id?.trim() && t("模型 ID"),
    !settings.hasApiKey && "API Key",
  ].filter((field): field is string => !!field);
}

export function fieldName(key: string): string {
  return ({ stem: t("题干"), questionTypeId: t("题型"), answerMode: t("答题方式"), choiceVariant: t("单/多选类型"), matchingVariant: t("匹配类型"), options: t("选项"), items: t("题项"), answerPayload: t("参考答案"), analysis: t("解析"), sourceText: t("原文"), media: t("图片"), material: t("材料") })[key] || key;
}
