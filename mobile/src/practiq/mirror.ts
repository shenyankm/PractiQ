// SQLite 结构化镜像的仓储层:每实体 upsert/query + useCachedResource 镜像描述符工厂。
// 纯映射逻辑在 mirror-map.ts(可单测);本文件通过 getDb() 访问 DB,只能在原生环境运行。
import { getDb } from './db';
import {
  answerKeyRowsFromDetail,
  answerPayloadToText,
  bankFromRow,
  bankGroupFromRow,
  bankGroupLinkRowFromApi,
  bankItemFromRow,
  bankQuestionLinkRowFromItem,
  groupQuestionLinkRowFromItem,
  mediaAssetRowFromApi,
  mediaLinkRowsFromDetail,
  mergeAnswerColumns,
  questionBankRowFromApi,
  questionDetailFromRows,
  questionGroupRowFromApi,
  questionGroupStubFromItem,
  questionOptionRowFromApi,
  questionRowFromDetail,
  questionRowFromItem,
  sessionFromRow,
  sessionRowFromApi,
  userBankLinkRowFromApi,
  type AnswerKeyRow,
  type ExistingAnswerState,
  type JoinedBankGroupRow,
  type JoinedBankItemRow,
  type JoinedBankRow,
  type MediaAssetRow,
  type MediaLinkRow,
  type QuestionOptionRow,
  type QuestionRow,
  type SessionRow,
} from './mirror-map';
import type {
  Bank,
  BankGroup,
  BankItem,
  MediaAsset,
  PracticeSession,
  QuestionDetail,
  QuestionType,
} from './types';
import type { ResourceMirror } from './use-resource';

export type BankScope = 'mine' | 'favorites' | 'public';

// ---------- SQL ----------

const UPSERT_BANK = `
  INSERT INTO question_banks (id, name, description, subject, total_count, created_by, is_public, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    description = excluded.description,
    subject = excluded.subject,
    total_count = excluded.total_count,
    created_by = COALESCE(excluded.created_by, question_banks.created_by),
    is_public = excluded.is_public,
    created_at = COALESCE(excluded.created_at, question_banks.created_at),
    updated_at = COALESCE(excluded.updated_at, question_banks.updated_at)
`;

// is_owner/is_favorite 未交付(null)时保留本地值;INSERT 时无本地值则落 0。
const UPSERT_BANK_LINK = `
  INSERT INTO user_bank_links (user_id, bank_id, is_owner, is_favorite, updated_at)
  VALUES (?, ?, COALESCE(?, 0), COALESCE(?, 0), ?)
  ON CONFLICT(user_id, bank_id) DO UPDATE SET
    is_owner = COALESCE(?, user_bank_links.is_owner),
    is_favorite = COALESCE(?, user_bank_links.is_favorite),
    updated_at = COALESCE(excluded.updated_at, user_bank_links.updated_at)
`;

// analysis/is_correct 已由 mergeAnswerColumns 解析(学员裁剪字段 undefined 时保留本地),直接覆盖;
// items API 不交付的列(detail_payload/created_at/updated_at)用 COALESCE 保留。
const UPSERT_QUESTION = `
  INSERT INTO questions (id, business_type, subject_id, question_type_id, answer_mode, choice_variant, content_mode, stem, analysis, detail_payload, status, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    business_type = COALESCE(excluded.business_type, questions.business_type),
    subject_id = COALESCE(excluded.subject_id, questions.subject_id),
    question_type_id = excluded.question_type_id,
    answer_mode = excluded.answer_mode,
    choice_variant = excluded.choice_variant,
    content_mode = COALESCE(excluded.content_mode, questions.content_mode),
    stem = excluded.stem,
    analysis = excluded.analysis,
    detail_payload = COALESCE(excluded.detail_payload, questions.detail_payload),
    status = excluded.status,
    created_at = COALESCE(excluded.created_at, questions.created_at),
    updated_at = COALESCE(excluded.updated_at, questions.updated_at)
`;

const UPSERT_OPTION = `
  INSERT INTO question_options (id, question_id, option_label, sort_order, content, is_correct, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    question_id = excluded.question_id,
    option_label = excluded.option_label,
    sort_order = excluded.sort_order,
    content = excluded.content,
    is_correct = excluded.is_correct,
    created_at = COALESCE(excluded.created_at, question_options.created_at),
    updated_at = COALESCE(excluded.updated_at, question_options.updated_at)
`;

const UPSERT_BANK_QUESTION_LINK = `
  INSERT INTO bank_question_links (bank_id, question_id, sort_order, question_no, status)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(bank_id, question_id) DO UPDATE SET
    sort_order = excluded.sort_order,
    question_no = excluded.question_no,
    status = excluded.status
`;

const UPSERT_GROUP_QUESTION_LINK = `
  INSERT INTO group_question_links (group_id, question_id, sort_order, question_no)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(group_id, question_id) DO UPDATE SET
    sort_order = excluded.sort_order,
    question_no = excluded.question_no
`;

const UPSERT_GROUP_STUB = `
  INSERT INTO question_groups (id, title, instructions)
  VALUES (?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    title = COALESCE(excluded.title, question_groups.title),
    instructions = COALESCE(excluded.instructions, question_groups.instructions)
`;

const UPSERT_GROUP = `
  INSERT INTO question_groups (id, group_type_id, title, instructions, content_mode)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    group_type_id = COALESCE(excluded.group_type_id, question_groups.group_type_id),
    title = COALESCE(excluded.title, question_groups.title),
    instructions = COALESCE(excluded.instructions, question_groups.instructions),
    content_mode = COALESCE(excluded.content_mode, question_groups.content_mode)
`;

const UPSERT_BANK_GROUP_LINK = `
  INSERT INTO bank_group_links (bank_id, group_id, sort_order, status)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(bank_id, group_id) DO UPDATE SET
    sort_order = excluded.sort_order,
    status = excluded.status
`;

const INSERT_ANSWER_KEY = `
  INSERT INTO question_answer_keys (id, question_id, answer_mode, version, is_primary, answer_payload, explanation_payload, score_payload, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_MEDIA_LINK = `
  INSERT INTO question_media_links (id, question_id, media_id, media_kind, sort_order, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`;

// detail API 的 media_links 不内嵌 asset 行,先写占位 asset 满足 FK;
// content_url 约定与服务端 _scan_media_asset 一致,asset 详情由 upsertMediaAsset 后补。
const UPSERT_MEDIA_STUB = `
  INSERT INTO media_assets (id, content_url) VALUES (?, ?)
  ON CONFLICT(id) DO NOTHING
`;

const UPSERT_MEDIA_ASSET = `
  INSERT INTO media_assets (id, created_by, external_url, content_url, original_name, mime_type, width, height, size_bytes, duration_ms, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    created_by = COALESCE(excluded.created_by, media_assets.created_by),
    external_url = excluded.external_url,
    content_url = excluded.content_url,
    original_name = excluded.original_name,
    mime_type = excluded.mime_type,
    width = excluded.width,
    height = excluded.height,
    size_bytes = excluded.size_bytes,
    duration_ms = excluded.duration_ms,
    created_at = COALESCE(excluded.created_at, media_assets.created_at)
`;

const UPSERT_SESSION = `
  INSERT INTO user_practice_sessions (id, user_id, bank_id, session_type, status, question_count, answered_count, correct_count, wrong_count, score, started_at, completed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    user_id = excluded.user_id,
    bank_id = excluded.bank_id,
    session_type = excluded.session_type,
    status = excluded.status,
    question_count = excluded.question_count,
    answered_count = excluded.answered_count,
    correct_count = excluded.correct_count,
    wrong_count = excluded.wrong_count,
    score = excluded.score,
    started_at = COALESCE(excluded.started_at, user_practice_sessions.started_at),
    completed_at = COALESCE(excluded.completed_at, user_practice_sessions.completed_at)
`;

const UPSERT_ANSWER = `
  INSERT INTO user_question_answers (id, user_id, session_id, bank_id, question_id, answer_key_id, answer_payload, is_correct, score, max_score, duration_ms, answered_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    user_id = excluded.user_id,
    session_id = excluded.session_id,
    bank_id = excluded.bank_id,
    question_id = excluded.question_id,
    answer_key_id = excluded.answer_key_id,
    answer_payload = excluded.answer_payload,
    is_correct = excluded.is_correct,
    score = excluded.score,
    max_score = excluded.max_score,
    duration_ms = excluded.duration_ms,
    answered_at = excluded.answered_at
`;

function notInClause(ids: number[], column: string) {
  return ids.length ? ` AND ${column} NOT IN (${ids.map(() => '?').join(',')})` : '';
}

// ---------- subjects / question types ----------

export async function upsertSubjects(rows: { subject_id: string; display_name: string }[]) {
  if (!rows.length) return;
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    for (const row of rows) {
      await db.runAsync(
        `INSERT INTO subjects (subject_id, display_name) VALUES (?, ?)
         ON CONFLICT(subject_id) DO UPDATE SET display_name = excluded.display_name`,
        row.subject_id,
        row.display_name,
      );
    }
  });
}

export async function subjects() {
  return (await getDb()).getAllAsync<{ subject_id: string; display_name: string }>(
    'SELECT subject_id, display_name FROM subjects ORDER BY display_name',
  );
}

export async function upsertQuestionTypes(rows: QuestionType[]) {
  if (!rows.length) return;
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    for (const row of rows) {
      await db.runAsync(
        `INSERT INTO question_types (type_id, subject_id, display_name, scope, default_answer_mode)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(type_id) DO UPDATE SET
           subject_id = excluded.subject_id,
           display_name = excluded.display_name,
           scope = excluded.scope,
           default_answer_mode = excluded.default_answer_mode`,
        row.type_id,
        row.subject_id,
        row.display_name,
        row.scope,
        row.default_answer_mode,
      );
    }
  });
}

export async function questionTypes(subject: string) {
  const rows = await (await getDb()).getAllAsync<{
    type_id: string;
    subject_id: string;
    display_name: string;
    scope: string;
    default_answer_mode: string | null;
  }>(
    'SELECT type_id, subject_id, display_name, scope, default_answer_mode FROM question_types WHERE subject_id = ? ORDER BY display_name',
    subject,
  );
  return rows.map((row) => ({
    ...row,
    default_answer_mode: row.default_answer_mode as QuestionType['default_answer_mode'],
  }));
}

// ---------- banks ----------

export async function upsertBanks(rows: Bank[], userId: number) {
  if (!rows.length) return;
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    for (const row of rows) {
      const bank = questionBankRowFromApi(row);
      await db.runAsync(
        UPSERT_BANK,
        bank.id, bank.name, bank.description, bank.subject, bank.total_count,
        bank.created_by, bank.is_public, bank.created_at, bank.updated_at,
      );
      const link = userBankLinkRowFromApi(row, userId);
      if (link) {
        await db.runAsync(
          UPSERT_BANK_LINK,
          link.user_id, link.bank_id, link.is_owner, link.is_favorite, link.updated_at,
          link.is_owner, link.is_favorite,
        );
      }
    }
  });
}

const BANK_SELECT = `
  SELECT b.id, b.name, b.description, b.subject, b.total_count, b.created_by, b.is_public, b.created_at, b.updated_at,
         COALESCE(ubl.is_owner, 0) AS is_owner, COALESCE(ubl.is_favorite, 0) AS is_favorite
  FROM question_banks b
`;

// 排序与 API 一致:updated_at DESC, id DESC
export async function banksForScope(scope: BankScope, userId: number): Promise<Bank[]> {
  const db = await getDb();
  const rows = scope === 'public'
    ? await db.getAllAsync<JoinedBankRow>(
      `${BANK_SELECT}
       LEFT JOIN user_bank_links ubl ON ubl.bank_id = b.id AND ubl.user_id = ?
       WHERE b.is_public = 1
       ORDER BY b.updated_at DESC, b.id DESC`,
      userId,
    )
    : await db.getAllAsync<JoinedBankRow>(
      `${BANK_SELECT}
       JOIN user_bank_links ubl ON ubl.bank_id = b.id AND ubl.user_id = ?
       WHERE ubl.${scope === 'mine' ? 'is_owner' : 'is_favorite'} = 1
       ORDER BY b.updated_at DESC, b.id DESC`,
      userId,
    );
  return rows.map(bankFromRow);
}

export async function bankForId(bankId: number, userId: number): Promise<Bank | null> {
  const row = await (await getDb()).getFirstAsync<JoinedBankRow>(
    `${BANK_SELECT}
     LEFT JOIN user_bank_links ubl ON ubl.bank_id = b.id AND ubl.user_id = ?
     WHERE b.id = ?
     LIMIT 1`,
    userId,
    bankId,
  );
  return row ? bankFromRow(row) : null;
}

// 完整拉取(第一页且 hasMore=false)后的删除传播:服务端不再属于该 scope 的题库本地同步移除。
// 只清关系/可见性标记或删除彻底不可见的行;题库内容行(questions 等)保留,孤儿行无害。
export async function replaceBankListScope(scope: BankScope, userId: number, rows: Bank[]) {
  await upsertBanks(rows, userId);
  const ids = rows.map((row) => row.id);
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    if (scope === 'mine') {
      await db.runAsync(
        `UPDATE user_bank_links SET is_owner = 0 WHERE user_id = ? AND is_owner = 1${notInClause(ids, 'bank_id')}`,
        userId, ...ids,
      );
      // 非公开、不归属、未收藏的题库彻底不可见,删除行(link 随 FK 级联)
      await db.runAsync(
        `DELETE FROM question_banks WHERE is_public = 0 AND id IN (
           SELECT bank_id FROM user_bank_links WHERE user_id = ? AND is_owner = 0 AND is_favorite = 0
         )`,
        userId,
      );
    } else if (scope === 'favorites') {
      // 取消收藏只清 link 标记,题库行可能仍归属或公开,不删
      await db.runAsync(
        `UPDATE user_bank_links SET is_favorite = 0 WHERE user_id = ? AND is_favorite = 1${notInClause(ids, 'bank_id')}`,
        userId, ...ids,
      );
    } else {
      // 退出公开范围且与用户无关联的删行;仍有关联的降级为非公开保留
      await db.runAsync(
        `DELETE FROM question_banks WHERE is_public = 1${notInClause(ids, 'id')}
           AND id NOT IN (SELECT bank_id FROM user_bank_links WHERE user_id = ?)`,
        ...ids, userId,
      );
      await db.runAsync(
        `UPDATE question_banks SET is_public = 0 WHERE is_public = 1${notInClause(ids, 'id')}`,
        ...ids,
      );
    }
  });
}

// ---------- bank items ----------

export async function upsertBankItems(bankId: number, items: BankItem[]) {
  if (!items.length) return;
  const db = await getDb();
  const ids = items.map((item) => item.question_id);
  const marks = ids.map(() => '?').join(',');
  // 读出本地已有答案列,学员裁剪字段(analysis/is_correct)在入参 undefined 时保留
  const existing = new Map<number, ExistingAnswerState>();
  for (const row of await db.getAllAsync<{ id: number; analysis: string | null }>(
    `SELECT id, analysis FROM questions WHERE id IN (${marks})`,
    ...ids,
  )) {
    existing.set(row.id, { analysis: row.analysis, options: [] });
  }
  for (const row of await db.getAllAsync<{ question_id: number; id: number; is_correct: number | null }>(
    `SELECT question_id, id, is_correct FROM question_options WHERE question_id IN (${marks})`,
    ...ids,
  )) {
    const state = existing.get(row.question_id) ?? { analysis: null, options: [] };
    state.options.push({ id: row.id, is_correct: row.is_correct });
    existing.set(row.question_id, state);
  }
  await db.withTransactionAsync(async () => {
    for (const item of items) {
      const merged = mergeAnswerColumns(
        { analysis: item.analysis, options: item.options ?? [] },
        existing.get(item.question_id) ?? null,
      );
      const question = questionRowFromItem(item, merged.analysis);
      await db.runAsync(
        UPSERT_QUESTION,
        question.id, question.business_type, question.subject_id, question.question_type_id,
        question.answer_mode, question.choice_variant, question.content_mode, question.stem,
        question.analysis, question.detail_payload, question.status, question.created_at, question.updated_at,
      );
      if (item.options) {
        for (const option of merged.options) {
          const row = questionOptionRowFromApi(option, item.question_id);
          await db.runAsync(
            UPSERT_OPTION,
            row.id, row.question_id, row.option_label, row.sort_order, row.content,
            row.is_correct, row.created_at, row.updated_at,
          );
        }
      }
      if (item.group_id) {
        const stub = questionGroupStubFromItem(item.group_id, item);
        await db.runAsync(UPSERT_GROUP_STUB, stub.id, stub.title, stub.instructions);
        const link = groupQuestionLinkRowFromItem(item.group_id, item);
        await db.runAsync(UPSERT_GROUP_QUESTION_LINK, link.group_id, link.question_id, link.sort_order, link.question_no);
      } else {
        const link = bankQuestionLinkRowFromItem(bankId, item);
        await db.runAsync(UPSERT_BANK_QUESTION_LINK, link.bank_id, link.question_id, link.sort_order, link.question_no, link.status);
      }
    }
  });
}

// 组装排序与 API 一致:bank_sort_order, group_sort_order NULLS FIRST(SQLite ASC 默认 NULL 在前), question_id
export async function bankItems(bankId: number): Promise<BankItem[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<JoinedBankItemRow>(
    `
    SELECT item.bank_id, item.group_id, item.question_id, item.item_scope, item.bank_sort_order, item.group_sort_order,
           item.question_no, item.bank_link_status,
           q.business_type, q.subject_id, q.question_type_id, q.answer_mode, q.choice_variant, q.content_mode,
           q.stem, q.analysis, q.status AS question_status,
           g.title AS group_title, g.instructions AS group_instructions
    FROM (
      SELECT bql.bank_id, NULL AS group_id, bql.question_id, 'standalone' AS item_scope,
             bql.sort_order AS bank_sort_order, NULL AS group_sort_order, bql.question_no, bql.status AS bank_link_status
      FROM bank_question_links bql
      WHERE bql.bank_id = ?
      UNION ALL
      SELECT bgl.bank_id, gql.group_id, gql.question_id, 'grouped' AS item_scope,
             bgl.sort_order AS bank_sort_order, gql.sort_order AS group_sort_order, gql.question_no, bgl.status AS bank_link_status
      FROM bank_group_links bgl
      JOIN group_question_links gql ON gql.group_id = bgl.group_id
      WHERE bgl.bank_id = ?
    ) item
    JOIN questions q ON q.id = item.question_id
    LEFT JOIN question_groups g ON g.id = item.group_id
    ORDER BY item.bank_sort_order, item.group_sort_order, item.question_id
    `,
    bankId,
    bankId,
  );
  if (!rows.length) return [];
  const options = await db.getAllAsync<QuestionOptionRow>(
    `
    SELECT o.id, o.question_id, o.option_label, o.sort_order, o.content, o.is_correct, o.created_at, o.updated_at
    FROM question_options o
    WHERE o.question_id IN (
      SELECT question_id FROM bank_question_links WHERE bank_id = ?
      UNION
      SELECT gql.question_id FROM bank_group_links bgl
      JOIN group_question_links gql ON gql.group_id = bgl.group_id
      WHERE bgl.bank_id = ?
    )
    ORDER BY o.question_id, o.sort_order
    `,
    bankId,
    bankId,
  );
  const optionsByQuestion = new Map<number, QuestionOptionRow[]>();
  for (const option of options) {
    const list = optionsByQuestion.get(option.question_id) ?? [];
    list.push(option);
    optionsByQuestion.set(option.question_id, list);
  }
  return rows.map((row) => bankItemFromRow(row, optionsByQuestion.get(row.question_id) ?? []));
}

// ---------- bank groups ----------

export async function upsertBankGroups(bankId: number, groups: BankGroup[]) {
  if (!groups.length) return;
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    for (const group of groups) {
      const row = questionGroupRowFromApi(group);
      await db.runAsync(UPSERT_GROUP, row.id, row.group_type_id, row.title, row.instructions, row.content_mode);
      const link = bankGroupLinkRowFromApi(bankId, group);
      await db.runAsync(UPSERT_BANK_GROUP_LINK, link.bank_id, link.group_id, link.sort_order, link.status);
    }
  });
}

// 排序与 API 一致:bgl.sort_order, g.id
export async function bankGroups(bankId: number, userId: number | null): Promise<BankGroup[]> {
  const rows = await (await getDb()).getAllAsync<JoinedBankGroupRow>(
    `
    SELECT g.id, g.group_type_id, g.title, g.instructions, g.content_mode,
           bgl.status, bgl.sort_order,
           (SELECT COUNT(*) FROM group_question_links gql WHERE gql.group_id = g.id) AS question_count,
           COALESCE((
             SELECT ubl.is_owner FROM user_bank_links ubl
             WHERE ubl.bank_id = bgl.bank_id AND ubl.user_id = ?
           ), 0) AS can_edit
    FROM bank_group_links bgl
    JOIN question_groups g ON g.id = bgl.group_id
    WHERE bgl.bank_id = ?
    ORDER BY bgl.sort_order, g.id
    `,
    userId,
    bankId,
  );
  return rows.map(bankGroupFromRow);
}

// 题库维度全量拉齐后的删除传播。upsert 之后删除该 bank 下不在结果集的 link 行;
// 孤儿 questions/question_groups 行保留(可能被其他题库引用,本地残留无害),只删 link。
export async function replaceBankScope(bankId: number, items: BankItem[] | null, groups: BankGroup[] | null) {
  if (items) await upsertBankItems(bankId, items);
  if (groups) await upsertBankGroups(bankId, groups);
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    if (items) {
      const standaloneIds = items.filter((item) => !item.group_id).map((item) => item.question_id);
      await db.runAsync(
        `DELETE FROM bank_question_links WHERE bank_id = ?${notInClause(standaloneIds, 'question_id')}`,
        bankId, ...standaloneIds,
      );
      // 组合成员按组精确 reconcile;完整拉取中未出现的成员一律移除(空组即清空其 link)
      const groupedIds = new Map<number, number[]>();
      for (const item of items) {
        if (!item.group_id) continue;
        const list = groupedIds.get(item.group_id) ?? [];
        list.push(item.question_id);
        groupedIds.set(item.group_id, list);
      }
      const localGroups = await db.getAllAsync<{ group_id: number }>(
        'SELECT group_id FROM bank_group_links WHERE bank_id = ?',
        bankId,
      );
      for (const { group_id: groupId } of localGroups) {
        const ids = groupedIds.get(groupId) ?? [];
        await db.runAsync(
          `DELETE FROM group_question_links WHERE group_id = ?${notInClause(ids, 'question_id')}`,
          groupId, ...ids,
        );
      }
    }
    if (groups) {
      const groupIds = groups.map((group) => group.id);
      await db.runAsync(
        `DELETE FROM bank_group_links WHERE bank_id = ?${notInClause(groupIds, 'group_id')}`,
        bankId, ...groupIds,
      );
    }
  });
}

// ---------- question detail ----------

// options/answer_keys/media_links 子集合整体替换(delete 不在交付集合中的行);
// answer_keys 仅在入参交付该键时替换,否则整表保留(见 mergeAnswerColumns)。
export async function upsertQuestionDetail(detail: QuestionDetail) {
  const db = await getDb();
  const existingQuestion = await db.getFirstAsync<{ analysis: string | null }>(
    'SELECT analysis FROM questions WHERE id = ?',
    detail.id,
  );
  const existingOptions = await db.getAllAsync<{ id: number; is_correct: number | null }>(
    'SELECT id, is_correct FROM question_options WHERE question_id = ?',
    detail.id,
  );
  const merged = mergeAnswerColumns(
    { analysis: detail.analysis, options: detail.options, answer_keys: detail.answer_keys },
    existingQuestion ? { analysis: existingQuestion.analysis, options: existingOptions } : null,
  );
  await db.withTransactionAsync(async () => {
    const question = questionRowFromDetail(detail, merged.analysis);
    await db.runAsync(
      UPSERT_QUESTION,
      question.id, question.business_type, question.subject_id, question.question_type_id,
      question.answer_mode, question.choice_variant, question.content_mode, question.stem,
      question.analysis, question.detail_payload, question.status, question.created_at, question.updated_at,
    );
    for (const option of merged.options) {
      const row = questionOptionRowFromApi(option, detail.id);
      await db.runAsync(
        UPSERT_OPTION,
        row.id, row.question_id, row.option_label, row.sort_order, row.content,
        row.is_correct, row.created_at, row.updated_at,
      );
    }
    const optionIds = merged.options.map((option) => option.id);
    await db.runAsync(
      `DELETE FROM question_options WHERE question_id = ?${notInClause(optionIds, 'id')}`,
      detail.id, ...optionIds,
    );
    if (merged.answerKeys !== null) {
      await db.runAsync('DELETE FROM question_answer_keys WHERE question_id = ?', detail.id);
      for (const key of answerKeyRowsFromDetail({ ...detail, answer_keys: merged.answerKeys })) {
        await db.runAsync(
          INSERT_ANSWER_KEY,
          key.id, key.question_id, key.answer_mode, key.version, key.is_primary,
          key.answer_payload, key.explanation_payload, key.score_payload, key.created_at, key.updated_at,
        );
      }
    }
    await db.runAsync('DELETE FROM question_media_links WHERE question_id = ?', detail.id);
    for (const link of mediaLinkRowsFromDetail(detail)) {
      await db.runAsync(UPSERT_MEDIA_STUB, link.media_id, `/api/v1/media/${link.media_id}/content`);
      await db.runAsync(
        INSERT_MEDIA_LINK,
        link.id, link.question_id, link.media_id, link.media_kind, link.sort_order, link.created_at,
      );
    }
  });
}

export async function questionDetail(questionId: number, userId: number | null): Promise<QuestionDetail | null> {
  const db = await getDb();
  const question = await db.getFirstAsync<QuestionRow>('SELECT * FROM questions WHERE id = ?', questionId);
  if (!question) return null;
  const options = await db.getAllAsync<QuestionOptionRow>(
    'SELECT * FROM question_options WHERE question_id = ? ORDER BY sort_order',
    questionId,
  );
  const answerKeys = await db.getAllAsync<AnswerKeyRow>(
    'SELECT * FROM question_answer_keys WHERE question_id = ? ORDER BY version',
    questionId,
  );
  const mediaLinks = await db.getAllAsync<MediaLinkRow>(
    'SELECT * FROM question_media_links WHERE question_id = ? ORDER BY sort_order',
    questionId,
  );
  // can_edit 按本地 link 推导(拥有任一包含该题的题库);归属题库未同步前可能为 false
  const ownerLink = userId === null ? null : await db.getFirstAsync<{ found: number }>(
    `
    SELECT 1 AS found WHERE EXISTS (
      SELECT 1 FROM bank_question_links bql
      JOIN user_bank_links ubl ON ubl.bank_id = bql.bank_id AND ubl.user_id = ?
      WHERE bql.question_id = ? AND ubl.is_owner = 1
    ) OR EXISTS (
      SELECT 1 FROM group_question_links gql
      JOIN bank_group_links bgl ON bgl.group_id = gql.group_id
      JOIN user_bank_links ubl ON ubl.bank_id = bgl.bank_id AND ubl.user_id = ?
      WHERE gql.question_id = ? AND ubl.is_owner = 1
    ) LIMIT 1
    `,
    userId, questionId, userId, questionId,
  );
  return questionDetailFromRows(question, options, answerKeys, mediaLinks, ownerLink !== null);
}

// ---------- media ----------

export async function upsertMediaAsset(asset: MediaAsset) {
  const row: MediaAssetRow = mediaAssetRowFromApi(asset);
  await (await getDb()).runAsync(
    UPSERT_MEDIA_ASSET,
    row.id, row.created_by, row.external_url, row.content_url, row.original_name, row.mime_type,
    row.width, row.height, row.size_bytes, row.duration_ms, row.created_at,
  );
}

// ---------- practice sessions / answers ----------

export async function upsertSessions(rows: PracticeSession[], userId: number) {
  if (!rows.length) return;
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    for (const session of rows) {
      const row = sessionRowFromApi(session, userId);
      await db.runAsync(
        UPSERT_SESSION,
        row.id, row.user_id, row.bank_id, row.session_type, row.status,
        row.question_count, row.answered_count, row.correct_count, row.wrong_count,
        row.score, row.started_at, row.completed_at,
      );
    }
  });
}

// 排序与 API 一致:started_at DESC
export async function recentSessions(userId: number, limit: number): Promise<PracticeSession[]> {
  const rows = await (await getDb()).getAllAsync<SessionRow>(
    'SELECT * FROM user_practice_sessions WHERE user_id = ? ORDER BY started_at DESC LIMIT ?',
    userId,
    limit,
  );
  return rows.map(sessionFromRow);
}

export type UserAnswerInput = {
  id: number;
  session_id: number;
  bank_id?: number | null;
  question_id: number;
  answer_key_id?: number | null;
  answer_payload: Record<string, unknown>;
  is_correct?: boolean | null;
  score?: number | null;
  max_score?: number | null;
  duration_ms?: number | null;
  answered_at?: string | null;
};

export async function upsertAnswers(answers: UserAnswerInput[], userId: number) {
  if (!answers.length) return;
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    for (const answer of answers) {
      await db.runAsync(
        UPSERT_ANSWER,
        answer.id, userId, answer.session_id, answer.bank_id ?? null, answer.question_id,
        answer.answer_key_id ?? null, answerPayloadToText(answer.answer_payload),
        answer.is_correct === null || answer.is_correct === undefined ? null : answer.is_correct ? 1 : 0,
        answer.score ?? null, answer.max_score ?? null, answer.duration_ms ?? null, answer.answered_at ?? null,
      );
    }
  });
}

// ---------- sync anchors ----------

export async function getSyncAnchor(scope: string): Promise<string | null> {
  const row = await (await getDb()).getFirstAsync<{ synced_at: string }>(
    'SELECT synced_at FROM sync_state WHERE scope = ?',
    scope,
  );
  return row?.synced_at ?? null;
}

export async function setSyncAnchor(scope: string, syncedAt: string) {
  await (await getDb()).runAsync(
    `INSERT INTO sync_state (scope, synced_at) VALUES (?, ?)
     ON CONFLICT(scope) DO UPDATE SET synced_at = excluded.synced_at`,
    scope,
    syncedAt,
  );
}

// ---------- useCachedResource 镜像描述符工厂 ----------

// userId 为 null(未登录或用户信息未加载)时 read 返回 null、write 空操作,退化为纯网络资源。
export function banksResourceMirror(scope: BankScope, userId: number | null, limit?: number): ResourceMirror<Bank[]> {
  return {
    read: async () => {
      if (userId === null) return null;
      const rows = await banksForScope(scope, userId);
      return limit === undefined ? rows : rows.slice(0, limit);
    },
    write: async (value, options) => {
      if (userId === null) return;
      // 仅第一页且 hasMore=false 的完整拉取做删除传播;分页合并写只 upsert
      if (options?.reconcile) await replaceBankListScope(scope, userId, value);
      else await upsertBanks(value, userId);
    },
  };
}

export function bankResourceMirror(bankId: number, userId: number | null): ResourceMirror<Bank> {
  return {
    read: () => (userId === null ? Promise.resolve(null) : bankForId(bankId, userId)),
    write: async (value) => {
      if (userId !== null) await upsertBanks([value], userId);
    },
  };
}

export function bankItemsResourceMirror(bankId: number, options?: { reconcile?: boolean }): ResourceMirror<BankItem[]> {
  return {
    read: () => bankItems(bankId),
    write: async (value, writeOptions) => {
      // 带过滤条件的拉取变体(如 status=active)不得触发删除传播
      if ((options?.reconcile ?? true) && writeOptions?.reconcile) await replaceBankScope(bankId, value, null);
      else await upsertBankItems(bankId, value);
    },
  };
}

export function bankGroupsResourceMirror(bankId: number, userId: number | null): ResourceMirror<BankGroup[]> {
  return {
    read: () => bankGroups(bankId, userId),
    write: async (value, writeOptions) => {
      if (writeOptions?.reconcile) await replaceBankScope(bankId, null, value);
      else await upsertBankGroups(bankId, value);
    },
  };
}

export function subjectsResourceMirror(): ResourceMirror<{ subject_id: string; display_name: string }[]> {
  return {
    read: () => subjects(),
    write: upsertSubjects,
  };
}

export function questionTypesResourceMirror(subject: string): ResourceMirror<QuestionType[]> {
  return {
    read: () => questionTypes(subject),
    write: upsertQuestionTypes,
  };
}

export function sessionsResourceMirror(userId: number | null, limit = 20): ResourceMirror<PracticeSession[]> {
  return {
    read: () => (userId === null ? Promise.resolve(null) : recentSessions(userId, limit)),
    write: async (value) => {
      if (userId !== null) await upsertSessions(value, userId);
    },
  };
}

export function questionDetailResourceMirror(questionId: number, userId: number | null): ResourceMirror<QuestionDetail> {
  return {
    read: () => questionDetail(questionId, userId),
    write: upsertQuestionDetail,
  };
}
