// 镜像仓储的纯映射层：API JSON ↔ SQLite 行参数/记录。
// 不 import expo-sqlite，可在 Jest 中直接运行（见 src/mirror.test.ts）。
import type {
  Bank,
  BankGroup,
  BankItem,
  MediaAsset,
  PracticeSession,
  QuestionDetail,
  QuestionOption,
} from './types';

export function boolToInt(value: boolean | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return value ? 1 : 0;
}

// ---------- banks ----------

export type QuestionBankRow = {
  id: number;
  name: string;
  description: string | null;
  subject: string;
  total_count: number;
  created_by: number | null;
  is_public: number;
  created_at: string | null;
  updated_at: string | null;
};

export function questionBankRowFromApi(bank: Bank): QuestionBankRow {
  return {
    id: bank.id,
    name: bank.name,
    description: bank.description,
    subject: bank.subject,
    total_count: bank.total_count,
    created_by: bank.created_by ?? null,
    is_public: bank.is_public ? 1 : 0,
    created_at: bank.created_at ?? null,
    updated_at: bank.updated_at ?? null,
  };
}

export type UserBankLinkRow = {
  user_id: number;
  bank_id: number;
  is_owner: number | null;
  is_favorite: number | null;
  updated_at: string | null;
};

// is_owner/is_favorite 都未交付时(如 POST /banks 创建响应)返回 null:
// 不动本地 link 行,避免用默认值冲掉已有归属/收藏状态。
export function userBankLinkRowFromApi(bank: Bank, userId: number): UserBankLinkRow | null {
  if (bank.is_owner === undefined && bank.is_favorite === undefined) return null;
  return {
    user_id: userId,
    bank_id: bank.id,
    is_owner: boolToInt(bank.is_owner),
    is_favorite: boolToInt(bank.is_favorite),
    updated_at: bank.updated_at ?? null,
  };
}

export type JoinedBankRow = QuestionBankRow & {
  is_owner: number | null;
  is_favorite: number | null;
};

export function bankFromRow(row: JoinedBankRow): Bank {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    subject: row.subject,
    total_count: row.total_count,
    is_public: row.is_public === 1,
    is_owner: row.is_owner === 1,
    is_favorite: row.is_favorite === 1,
    // 负数 id 是离线乐观创建、尚未拿到服务端 id 的行,还原 pending 标记供 UI 展示
    ...(row.id < 1 ? { pending: true } : {}),
    ...(row.created_by === null ? {} : { created_by: row.created_by }),
    ...(row.created_at ? { created_at: row.created_at } : {}),
    ...(row.updated_at ? { updated_at: row.updated_at } : {}),
  };
}

// ---------- questions / bank items ----------

export type QuestionRow = {
  id: number;
  business_type: string | null;
  subject_id: string | null;
  question_type_id: string;
  answer_mode: string;
  choice_variant: string | null;
  content_mode: string | null;
  stem: string;
  analysis: string | null;
  detail_payload: string | null;
  status: string;
  created_at: string | null;
  updated_at: string | null;
};

export type QuestionOptionRow = {
  id: number;
  question_id: number;
  option_label: string;
  sort_order: number;
  content: string;
  is_correct: number | null;
  created_at: string | null;
  updated_at: string | null;
};

export type AnswerKeyInput = NonNullable<QuestionDetail['answer_keys']>[number];

// 结构化定义而非 Omit<QuestionOption>(loose 索引签名会把 Omit 的属性类型冲成 unknown)
export type MergedOption = {
  id: number;
  option_label: string;
  sort_order: number;
  content: string;
  is_correct: boolean | null;
  question_id?: number;
  created_at?: string;
  updated_at?: string;
};

// 学员视角会被服务端裁剪的列(questions.analysis、question_options.is_correct、
// question_answer_keys 整表):入参键不存在(undefined,区别于显式 null)时保留本地已有值,
// 不为 undefined 才覆盖。防止 includeAnswers=false / learner 视图的普通拉取冲掉已有答案数据。
export type ExistingAnswerState = {
  analysis: string | null;
  options: { id: number; is_correct: number | null }[];
};

export type MergedAnswerColumns = {
  analysis: string | null;
  options: MergedOption[];
  // null = 入参未交付 answer_keys 键,整表保留本地;非 null = 交付了(含空数组),整体替换
  answerKeys: AnswerKeyInput[] | null;
};

export function mergeAnswerColumns(
  incoming: { analysis?: string | null; options?: QuestionOption[]; answer_keys?: AnswerKeyInput[] },
  existing: ExistingAnswerState | null,
): MergedAnswerColumns {
  const existingCorrect = new Map((existing?.options ?? []).map((option) => [option.id, option.is_correct]));
  return {
    analysis: incoming.analysis === undefined ? existing?.analysis ?? null : incoming.analysis,
    options: (incoming.options ?? []).map((option) => {
      const kept = existingCorrect.get(option.id);
      return {
        ...option,
        is_correct: option.is_correct === undefined
          ? kept === null || kept === undefined ? null : kept === 1
          : option.is_correct,
      };
    }),
    answerKeys: incoming.answer_keys ?? null,
  };
}

export function questionRowFromItem(item: BankItem, analysis: string | null): QuestionRow {
  return {
    id: item.question_id,
    business_type: item.business_type ?? null,
    subject_id: item.subject_id ?? null,
    question_type_id: item.question_type_id,
    answer_mode: item.answer_mode,
    choice_variant: item.choice_variant,
    content_mode: item.content_mode ?? null,
    stem: item.stem,
    analysis,
    // items API 不交付 detail_payload/created_at/updated_at,SQL 层 COALESCE 保留本地值
    detail_payload: null,
    status: item.question_status,
    created_at: null,
    updated_at: null,
  };
}

export function questionRowFromDetail(detail: QuestionDetail, analysis: string | null): QuestionRow {
  return {
    id: detail.id,
    business_type: detail.business_type ?? null,
    subject_id: detail.subject_id ?? null,
    question_type_id: detail.question_type_id,
    answer_mode: detail.answer_mode,
    choice_variant: detail.choice_variant ?? null,
    content_mode: detail.content_mode ?? null,
    stem: detail.stem,
    analysis,
    detail_payload: detail.detail_payload ?? null,
    status: detail.status,
    created_at: detail.created_at ?? null,
    updated_at: detail.updated_at ?? null,
  };
}

export function questionOptionRowFromApi(option: MergedOption, questionId: number): QuestionOptionRow {
  return {
    id: option.id,
    question_id: questionId,
    option_label: option.option_label,
    sort_order: option.sort_order,
    content: option.content,
    is_correct: boolToInt(option.is_correct),
    created_at: option.created_at ?? null,
    updated_at: option.updated_at ?? null,
  };
}

export function optionFromRow(row: QuestionOptionRow): QuestionOption {
  return {
    id: row.id,
    question_id: row.question_id,
    option_label: row.option_label,
    sort_order: row.sort_order,
    content: row.content,
    // is_correct 为 NULL 表示学员视角未知,按 schema 语义不交付该键
    ...(row.is_correct === null ? {} : { is_correct: row.is_correct === 1 }),
    ...(row.created_at ? { created_at: row.created_at } : {}),
    ...(row.updated_at ? { updated_at: row.updated_at } : {}),
  };
}

export type BankQuestionLinkRow = {
  bank_id: number;
  question_id: number;
  sort_order: number;
  question_no: string | null;
  status: string;
};

export function bankQuestionLinkRowFromItem(bankId: number, item: BankItem): BankQuestionLinkRow {
  return {
    bank_id: bankId,
    question_id: item.question_id,
    sort_order: item.bank_sort_order ?? 1,
    question_no: item.question_no ?? null,
    status: item.bank_link_status,
  };
}

export type GroupQuestionLinkRow = {
  group_id: number;
  question_id: number;
  sort_order: number;
  question_no: string | null;
};

export function groupQuestionLinkRowFromItem(groupId: number, item: BankItem): GroupQuestionLinkRow {
  return {
    group_id: groupId,
    question_id: item.question_id,
    sort_order: item.group_sort_order ?? 1,
    question_no: item.question_no ?? null,
  };
}

// items 条目携带 group_title/group_instructions,可为 question_groups 写占位行
// (group detail/list 拉取后再补齐其余列,COALESCE 保留已有值)。
export function questionGroupStubFromItem(groupId: number, item: BankItem) {
  return {
    id: groupId,
    title: item.group_title ?? null,
    instructions: item.group_instructions ?? null,
  };
}

export type JoinedBankItemRow = {
  bank_id: number;
  group_id: number | null;
  question_id: number;
  item_scope: string;
  bank_sort_order: number | null;
  group_sort_order: number | null;
  question_no: string | null;
  bank_link_status: string;
  business_type: string | null;
  subject_id: string | null;
  question_type_id: string;
  answer_mode: string;
  choice_variant: string | null;
  content_mode: string | null;
  stem: string;
  analysis: string | null;
  question_status: string;
  group_title: string | null;
  group_instructions: string | null;
};

export function bankItemFromRow(row: JoinedBankItemRow, options: QuestionOptionRow[]): BankItem {
  return {
    bank_id: row.bank_id,
    group_id: row.group_id,
    question_id: row.question_id,
    item_scope: row.item_scope,
    bank_sort_order: row.bank_sort_order ?? undefined,
    group_sort_order: row.group_sort_order,
    question_no: row.question_no,
    bank_link_status: row.bank_link_status as BankItem['bank_link_status'],
    business_type: row.business_type ?? undefined,
    subject_id: row.subject_id ?? undefined,
    question_type_id: row.question_type_id,
    answer_mode: row.answer_mode as BankItem['answer_mode'],
    choice_variant: row.choice_variant as BankItem['choice_variant'],
    content_mode: row.content_mode,
    stem: row.stem,
    analysis: row.analysis,
    question_status: row.question_status as BankItem['question_status'],
    group_title: row.group_title,
    group_instructions: row.group_instructions,
    options: options.map(optionFromRow),
  };
}

// ---------- groups ----------

// list API 只交付这些列;其余镜像列由 group detail API(移动端暂未调用)补齐。
export function questionGroupRowFromApi(group: BankGroup) {
  return {
    id: group.id,
    group_type_id: group.group_type_id,
    title: group.title,
    instructions: group.instructions,
    content_mode: group.content_mode,
  };
}

export type BankGroupLinkRow = {
  bank_id: number;
  group_id: number;
  sort_order: number;
  status: string;
};

export function bankGroupLinkRowFromApi(bankId: number, group: BankGroup): BankGroupLinkRow {
  return {
    bank_id: bankId,
    group_id: group.id,
    sort_order: group.sort_order,
    status: group.status,
  };
}

export type JoinedBankGroupRow = {
  id: number;
  group_type_id: string | null;
  title: string | null;
  instructions: string | null;
  content_mode: string | null;
  status: string;
  sort_order: number;
  question_count: number;
  can_edit: number;
};

export function bankGroupFromRow(row: JoinedBankGroupRow): BankGroup {
  return {
    id: row.id,
    group_type_id: row.group_type_id ?? '',
    title: row.title,
    instructions: row.instructions,
    content_mode: row.content_mode as BankGroup['content_mode'],
    status: row.status as BankGroup['status'],
    sort_order: row.sort_order,
    question_count: row.question_count,
    can_edit: row.can_edit === 1,
  };
}

// ---------- question detail ----------

export type AnswerKeyRow = {
  id: number | null;
  question_id: number;
  answer_mode: string;
  version: number;
  is_primary: number;
  answer_payload: string;
  explanation_payload: string;
  score_payload: string;
  created_at: string | null;
  updated_at: string | null;
};

export function answerKeyRowsFromDetail(detail: QuestionDetail): AnswerKeyRow[] {
  return (detail.answer_keys ?? []).map((key) => ({
    id: key.id ?? null,
    question_id: detail.id,
    answer_mode: key.answer_mode ?? detail.answer_mode,
    version: key.version ?? 1,
    is_primary: boolToInt(key.is_primary ?? true) ?? 1,
    answer_payload: key.answer_payload,
    explanation_payload: key.explanation_payload ?? '{}',
    score_payload: key.score_payload ?? '{}',
    created_at: key.created_at ?? null,
    updated_at: key.updated_at ?? null,
  }));
}

export function answerKeyFromRow(row: AnswerKeyRow): AnswerKeyInput {
  return {
    id: row.id ?? undefined,
    question_id: row.question_id,
    answer_mode: row.answer_mode as NonNullable<QuestionDetail['answer_keys']>[number]['answer_mode'],
    version: row.version,
    is_primary: row.is_primary === 1,
    answer_payload: row.answer_payload,
    explanation_payload: row.explanation_payload,
    score_payload: row.score_payload,
    ...(row.created_at ? { created_at: row.created_at } : {}),
    ...(row.updated_at ? { updated_at: row.updated_at } : {}),
  };
}

export type MediaLinkRow = {
  id: number | null;
  question_id: number;
  media_id: number;
  media_kind: string;
  sort_order: number;
  created_at: string | null;
};

export function mediaLinkRowsFromDetail(detail: QuestionDetail): MediaLinkRow[] {
  return detail.media_links.map((link) => ({
    id: link.id,
    question_id: detail.id,
    media_id: link.media_id,
    media_kind: link.media_kind,
    sort_order: link.sort_order,
    created_at: link.created_at ?? null,
  }));
}

export function questionDetailFromRows(
  question: QuestionRow,
  options: QuestionOptionRow[],
  answerKeys: AnswerKeyRow[],
  mediaLinks: MediaLinkRow[],
  canEdit: boolean,
): QuestionDetail {
  return {
    id: question.id,
    stem: question.stem,
    analysis: question.analysis,
    answer_mode: question.answer_mode as QuestionDetail['answer_mode'],
    question_type_id: question.question_type_id,
    status: question.status as QuestionDetail['status'],
    options: options.map(optionFromRow),
    // answer_keys 键的存在性与 API 一致:本地有答案行才交付(学员视角该键不出现)
    ...(answerKeys.length ? { answer_keys: answerKeys.map(answerKeyFromRow) } : {}),
    media_links: mediaLinks.map((link) => ({
      id: link.id ?? 0,
      media_id: link.media_id,
      media_kind: link.media_kind,
      sort_order: link.sort_order,
      question_id: link.question_id,
      ...(link.created_at ? { created_at: link.created_at } : {}),
    })),
    can_edit: canEdit,
    ...(question.business_type ? { business_type: question.business_type } : {}),
    ...(question.subject_id ? { subject_id: question.subject_id } : {}),
    choice_variant: question.choice_variant as QuestionDetail['choice_variant'],
    content_mode: question.content_mode,
    ...(question.detail_payload ? { detail_payload: question.detail_payload } : {}),
    ...(question.created_at ? { created_at: question.created_at } : {}),
    ...(question.updated_at ? { updated_at: question.updated_at } : {}),
  };
}

// ---------- media ----------

export type MediaAssetRow = {
  id: number;
  created_by: number | null;
  external_url: string | null;
  content_url: string;
  original_name: string | null;
  mime_type: string | null;
  width: number | null;
  height: number | null;
  size_bytes: number | null;
  duration_ms: number | null;
  created_at: string | null;
};

export function mediaAssetRowFromApi(asset: MediaAsset): MediaAssetRow {
  return {
    id: asset.id,
    created_by: asset.created_by ?? null,
    external_url: asset.external_url ?? null,
    content_url: asset.content_url,
    original_name: asset.original_name,
    mime_type: asset.mime_type,
    width: asset.width ?? null,
    height: asset.height ?? null,
    size_bytes: asset.size_bytes,
    duration_ms: asset.duration_ms ?? null,
    created_at: asset.created_at ?? null,
  };
}

// ---------- practice sessions / answers ----------

export type SessionRow = {
  id: number;
  user_id: number;
  bank_id: number | null;
  session_type: string;
  status: string;
  question_count: number;
  answered_count: number;
  correct_count: number;
  wrong_count: number;
  score: number | null;
  started_at: string | null;
  completed_at: string | null;
};

export function sessionRowFromApi(session: PracticeSession, userId: number): SessionRow {
  return {
    id: session.id,
    user_id: userId,
    bank_id: session.bank_id,
    session_type: session.session_type,
    status: session.status,
    question_count: session.question_count,
    answered_count: session.answered_count,
    correct_count: session.correct_count,
    wrong_count: session.wrong_count,
    score: session.score,
    started_at: session.started_at ?? null,
    completed_at: session.completed_at ?? null,
  };
}

export function sessionFromRow(row: SessionRow): PracticeSession {
  return {
    id: row.id,
    bank_id: row.bank_id,
    session_type: row.session_type,
    status: row.status as PracticeSession['status'],
    question_count: row.question_count,
    answered_count: row.answered_count,
    correct_count: row.correct_count,
    wrong_count: row.wrong_count,
    score: row.score,
    user_id: row.user_id,
    ...(row.started_at ? { started_at: row.started_at } : {}),
    completed_at: row.completed_at,
  };
}

// user_question_answers.answer_payload 在 PG 是 JSONB,本地存 JSON 字符串,读出时 parse。
export function answerPayloadToText(payload: Record<string, unknown> | null | undefined): string {
  return JSON.stringify(payload ?? {});
}

export function answerPayloadFromText(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
