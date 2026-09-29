import { COMPOSITE_MODES } from "./contracts.generated";
import nativeMessages from "./locales/native.json";
import { t, locale, MessageError, renderMessage, type LanguageRequest, type Locale } from "./i18n";
import { invoke } from "./transport";
import type { Question, Answer, ParsedOption as Option, ParsedItem as Item, ContentBlock as Block } from "./contracts.generated";
export type { Question, Answer, Option, Item, Block };
export type Mode = NonNullable<Question["answerMode"]>;
export function isComposite(q: Question) { return COMPOSITE_MODES.includes(q.answerMode || ""); }
export function modeNames(): Record<string, string> { return {
  choice: t("选择题"),
  true_false: t("判断题"),
  fill_blank: t("填空题"),
  short_answer: t("简答题"),
  ordering: t("排序题"),
  matching: t("匹配题"),
  listening:t("听力题"), gap_fill:t("语法填空"),
  reading: t("阅读理解"), word_bank: t("选词填空"), cloze: t("完形填空"),
}; }
export function blankQuestion(): Question {
  return {
    id: crypto.randomUUID(), parentId: null, passage: [], allowReuse: false,
    stem: "",
    questionTypeId: t("单选题"),
    answerMode: "choice",
    choiceVariant: "single",
    matchingVariant: null,
    options: [
      { label: "A", content: "" },
      { label: "B", content: "" },
    ],
    items: [],
    answerPayload: null,
    analysis: null,
    sourceText: null,
    contentBlocks: [],
    needsReview: false,
    missingFields: [],
    confidence: 0,
  };
}
export interface Group {
  id: string;
  title: string;
  instructions?: string | null;
  contentBlocks?: Block[];
  questionIds: string[];
}
interface ImageReference {
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
  reviewedAt?: number | null;
  materials?: Question[];
  question: Question;
  groups: Group[];
  visuals: Visual[];
  sources: Record<string, unknown>[];
  warnings: string[];
  missingAssets: boolean;
}
export interface QuestionRow extends Snapshot {
  answerableCount?: number;
  latestScore?: { earnedCents: number; maxCents: number; gradeKind: string } | null;
  rootId?: string;
  rootType?: string;
  children?: QuestionRow[];
  id: string;
  bankId: string;
  bankTitle: string;
  favorite: boolean;
  latestResult: boolean | null;
}
export interface QuestionPage { items: QuestionRow[]; total: number; offset: number }
export interface BankChoice { id: string; title: string; count: number }
export interface BankPage { items: Bank[]; total: number; offset: number }
export interface SessionPage { items: SessionSummary[]; total: number; offset: number }
export type UnfinishedSession = Pick<SessionSummary, "id" | "title" | "count" | "answered" | "kind" | "draftAnswered" | "deadlineAt" | "lastActiveAt" | "clockNow">;
export type SessionFilter = "all" | "active" | "review" | "finished";
export interface GradingResponse {
  status: string;
  error?: string;
  appError?: unknown;
  result?: { scoreCents: number | null; maxCents: number; reason: string; evidence: string[]; reviewReasons: string[] };
}
export interface Bank extends BankChoice {
  description: string;
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
  grading?: { lastRequest?: GradingResponse; ai?: GradingResponse; manual?: {reason: string; scoreCents: number} };
  submittedAt: number | null;
  skipped: boolean;
  elapsedMs: number;
}
export type SessionKind = "practice" | "self_test" | "mock_exam";
export interface Session {
  clockNow?: number;
  snapshotKey?: string;
  bankIds?: string[];
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
  clockNow?: number;
  draftAnswered?: number;
  deadlineAt?: number | null;
  lastActiveAt?: number;
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
export interface QuestionStats { count: number; types: Record<string, number>; feasibleCounts?: number[] }
interface PaperSelection { bank_ids: string[]; search: string; mode: string; filter: string; selection: string; count: number; quotas: Record<string,number>; question_ids: string[]; random: boolean; total_cents: number; budgets?: Record<string,number> }
export interface PlaybackState { used:number; position:number; active:boolean; limit:number; restricted:boolean }
export interface AudioLink { url: string; label: string }
export interface StagedAudio { lease: string; reference: NonNullable<Question["audioRef"]>; duration: number }
export type Request =
  | { type:"pick_audio" }
  | { type:"pick_audio_qr" }
  | { type:"decode_audio_qr"; hash:string }
  | { type:"import_audio_url"; url:string }
  | { type:"release_audio"; lease:string }
  | { type:"listening_playback"; id:string; question_id:string; action:"state"|"start"|"progress"|"pause"|"end"; position?:number }
  | { type: "banks_page"; limit: number; offset: number }
  | { type: "sessions_page"; limit: number; offset: number; filter?: SessionFilter }
  | { type: "self_assess"; id: string; ordinal: number; result: boolean }
  | { type: "export_bank"; bank_id: string }
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
      type: "save_settings" | "test_settings";
      config: ConnectionSettings;
      api_key: string | null;
    }
  | {
      type:
        | "add_example_bank"
        | "pick_import"
        | "banks"
        | "unfinished_session"
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
  | ({ type: "question_stats" } & Query)
  | ({ type: "questions_page"; limit: number; offset: number } & Query)
  | { type: "favorite"; id: string; value: boolean }
  | { type: "review_question"; id: string; reviewed: boolean }
  | { type: "save_draft"; id: string; ordinal: number; answer: Answer | null; elapsed_ms: number }
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
type ResponseMap = {
  asset: ArrayBuffer;
  pick_audio: StagedAudio|null;
  pick_audio_qr: AudioLink[]|null;
  decode_audio_qr: AudioLink[];
  import_audio_url: {audio:StagedAudio|null;links:AudioLink[]};
  release_audio: null;
  listening_playback: PlaybackState;
  backup: { path: string } | null;
  banks: BankChoice[];
  banks_page: BankPage;
  complete_review: Session;
  delete_bank: null;
  delete_question: null;
  export_bank: { path: string } | null;
  favorite: boolean;
  review_question: number | null;
  finish: Session;
  flag: Session;
  import: { duplicate: boolean; bankId: string; count: number };
  info: { dataDirectory: string; version: string };
  language: Locale | null;
  manual_score: Session;
  merge_banks: { bankId: string; count: number };
  add_example_bank: { duplicate: boolean; bankId: string; count: number };
  pick_import: Preview | null;
  position: Session;
  preview_paper: PaperPreview;
  question_stats: QuestionStats;
  questions_page: QuestionPage;
  restore: { recoveryPath: string } | null;
  retry_wrong: Session;
  save_attempt: Session;
  save_bank: string;
  save_draft: void;
  save_language: Locale;
  save_question_tree: string;
  save_settings: SettingsResult;
  self_assess: Session;
  session: Session;
  sessions_page: SessionPage;
  settings: SettingsResult;
  start_paper: Session;
  submit_paper: Session;
  test_settings: null;
  unfinished_session: UnfinishedSession | null;
};
let lastSession: Session | undefined;
let sessionEpoch = 0;
export async function api<R extends Request>(request: R): Promise<ResponseMap[R["type"]]> {
  if (request.type === "asset") {
    return invoke<ArrayBuffer>("read_asset", { hash: request.hash }) as Promise<ResponseMap[R["type"]]>;
  }
  if (request.type === "restore") { lastSession = undefined; sessionEpoch++; }
  const epoch = sessionEpoch;
  const base = (request.type === "session" || request.type === "position" || request.type === "save_attempt") && lastSession?.id === request.id ? lastSession : undefined;
  let result = await invoke<ResponseMap[R["type"]]>("request", {
    request: base?.snapshotKey ? {...request, snapshot_key:base.snapshotKey} : request, locale: locale(),
  });
  if (result && typeof result === "object" && "snapshotKey" in result && "attempts" in result) {
    let session = result as Session;
    if (session.attempts.some(a => !a.snapshot)) {
      if (base?.id === session.id && base.snapshotKey === session.snapshotKey && base.attempts.length === session.attempts.length
        && session.attempts.every((a, i) => a.ordinal === base.attempts[i].ordinal)) {
        session = {...session, attempts:session.attempts.map((a, i) => ({...a, snapshot:a.snapshot ?? base.attempts[i].snapshot}))};
      } else {
        session = await invoke<Session>("request", {request:{type:"session",id:session.id},locale:locale()});
      }
      result = session as ResponseMap[R["type"]];
    }
    if (epoch === sessionEpoch) lastSession = session;
  }
  return result;
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
    const diagnostic = !code.startsWith("LOCAL_") && code !== "STALE_CHECKPOINT" && typeof object.message === "string" && !Object.values(entry).includes(object.message as never)
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
}
export interface SettingsResult {
  config: ConnectionSettings;
  /** null means unchecked; only explicit credential operations inspect the key. */
  hasApiKey: boolean | null;
}

export function missingModelSettings(settings: SettingsResult): string[] {
  return [
    !settings.config.base_url?.trim() && t("模型 API 地址"),
    !settings.config.model_id?.trim() && t("模型 ID"),
    settings.hasApiKey === false && "API Key",
  ].filter((field): field is string => !!field);
}

export function fieldName(key: string): string {
  return ({ stem: t("题干"), questionTypeId: t("题型"), answerMode: t("答题方式"), choiceVariant: t("单/多选类型"), matchingVariant: t("匹配类型"), options: t("选项"), items: t("题项"), answerPayload: t("参考答案"), analysis: t("解析"), sourceText: t("原文"), media: t("图片"), material: t("材料") })[key] || key;
}
