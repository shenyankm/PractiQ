import type { SQLiteDatabase } from 'expo-sqlite';

import { writeTransaction } from '../../database-core';
import { MAX_QUESTION_TEXT_LENGTH, validateQuestion } from '../../logic';
import { CONTENT_BLOCK_TYPES } from '../../types';
import type {
  ContentBlock,
  QuestionOption,
  QuestionStatus,
  QuestionType,
} from '../../types';

export interface QuestionDraft {
  id?: number;
  bankId: number;
  subjectId: number;
  type: QuestionType;
  stem: string;
  explanation: string;
  status: QuestionStatus;
  difficulty: number;
  score: number;
  options: QuestionOption[];
  answer: unknown;
  knowledgePointIds: number[];
  groupId?: number | null;
  blocks: ContentBlock[];
}

function contentBlocksForSave(blocks: ContentBlock[], owner: '试题' | '题组') {
  const kinds = new Set<ContentBlock['kind']>(CONTENT_BLOCK_TYPES);
  const saved = blocks.filter((block) => block.content.trim() || block.media_asset_id);
  for (const block of saved) {
    if (!kinds.has(block.kind)) throw new Error('内容块类型无效');
    if (block.content.length > 50_000) throw new Error('单个内容块不能超过 50,000 个字符');
    if (block.kind === 'image' && !block.media_asset_id) throw new Error(`图片内容块必须选择${owner}图片`);
    if (block.metadata_json) {
      try {
        JSON.parse(block.metadata_json);
      } catch {
        throw new Error('内容块辅助说明无效');
      }
    }
  }
  return saved;
}

async function replaceContentBlocks(
  db: SQLiteDatabase,
  ownerColumn: 'question_id' | 'group_id',
  ownerId: number,
  blocks: ContentBlock[],
) {
  const owner = ownerColumn === 'question_id' ? '试题' : '题组';
  for (const block of blocks) {
    if (!block.media_asset_id) continue;
    const linked = await db.getFirstAsync<{ id: number }>(
      `SELECT id FROM media_links WHERE media_asset_id = ? AND ${ownerColumn} = ?`,
      block.media_asset_id,
      ownerId,
    );
    if (!linked) throw new Error(`内容块图片未关联到当前${owner}`);
  }
  await db.runAsync(`DELETE FROM question_content_blocks WHERE ${ownerColumn} = ?`, ownerId);
  for (const [index, block] of blocks.entries()) {
    await db.runAsync(
      `INSERT INTO question_content_blocks
       (${ownerColumn}, kind, content, media_asset_id, metadata_json, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ownerId,
      block.kind,
      block.content.trim(),
      ['image', 'chart', 'qrcode'].includes(block.kind) ? block.media_asset_id ?? null : null,
      block.metadata_json ?? null,
      index,
    );
  }
}

export async function saveQuestionBank(
  db: SQLiteDatabase,
  bankId: number,
  subjectId: number,
  name: string,
  description: string,
) {
  if (bankId) {
    const result = await writeTransaction(db, ['question_banks'], (transaction) => (
      transaction.runAsync(
        `UPDATE question_banks SET subject_id = ?, name = ?, description = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        subjectId,
        name,
        description,
        bankId,
      )
    ));
    return result.changes ? bankId : null;
  }

  const result = await writeTransaction(db, ['question_banks'], (transaction) => transaction.runAsync(
      'INSERT INTO question_banks(subject_id, name, description) VALUES (?, ?, ?)',
      subjectId,
      name,
      description,
    ));
  return result.lastInsertRowId;
}

export async function saveQuestionGroup(
  db: SQLiteDatabase,
  bankId: number,
  groupId: number | null,
  stem: string,
) {
  await writeTransaction(db, ['question_groups', 'bank_group_links'], async (transaction) => {
    if (groupId) {
      await transaction.runAsync(
        'UPDATE question_groups SET stem = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        stem,
        groupId,
      );
      return;
    }
    const inserted = await transaction.runAsync(
      `INSERT INTO question_groups(subject_id, stem)
       SELECT subject_id, ? FROM question_banks WHERE id = ?`,
      stem,
      bankId,
    );
    await transaction.runAsync(
      `INSERT INTO bank_group_links(bank_id, group_id, sort_order)
       VALUES (?, ?, COALESCE((SELECT MAX(sort_order) + 1 FROM bank_group_links WHERE bank_id = ?), 0))`,
      bankId,
      inserted.lastInsertRowId,
      bankId,
    );
  });
}

export async function swapGroupQuestionOrder(
  db: SQLiteDatabase,
  groupId: number,
  questionId: number,
  sortOrder: number,
  neighborQuestionId: number,
  neighborSortOrder: number,
) {
  await writeTransaction(db, ['group_question_links'], async (transaction) => {
    await transaction.runAsync(
      'UPDATE group_question_links SET sort_order = ? WHERE group_id = ? AND question_id = ?',
      neighborSortOrder,
      groupId,
      questionId,
    );
    await transaction.runAsync(
      'UPDATE group_question_links SET sort_order = ? WHERE group_id = ? AND question_id = ?',
      sortOrder,
      groupId,
      neighborQuestionId,
    );
  });
}

export async function saveKnowledgePoint(
  db: SQLiteDatabase,
  bankId: number,
  parentId: number | null,
  pointId: number | null,
  name: string,
): Promise<'saved' | 'duplicate' | 'missing'> {
  let result: 'saved' | 'duplicate' | 'missing' = 'saved';
  await writeTransaction(db, ['knowledge_points'], async (transaction) => {
    const duplicate = await transaction.getFirstAsync<{ id: number }>(
      `SELECT kp.id FROM knowledge_points kp
       WHERE kp.subject_id = (SELECT subject_id FROM question_banks WHERE id = ?)
         AND kp.parent_id IS ? AND kp.name = ? AND kp.id <> ? LIMIT 1`,
      bankId,
      parentId,
      name,
      pointId ?? -1,
    );
    if (duplicate) {
      result = 'duplicate';
      return;
    }
    if (pointId) {
      const updated = await transaction.runAsync(
        `UPDATE knowledge_points SET name = ?
         WHERE id = ? AND subject_id = (SELECT subject_id FROM question_banks WHERE id = ?)`,
        name,
        pointId,
        bankId,
      );
      if (!updated.changes) result = 'missing';
      return;
    }
    const inserted = await transaction.runAsync(
      `INSERT INTO knowledge_points(subject_id, parent_id, name, sort_order)
       SELECT qb.subject_id, ?, ?, COALESCE((
         SELECT MAX(kp.sort_order) + 1 FROM knowledge_points kp
         WHERE kp.subject_id = qb.subject_id AND kp.parent_id IS ?
       ), 0)
       FROM question_banks qb
       WHERE qb.id = ? AND (? IS NULL OR EXISTS (
         SELECT 1 FROM knowledge_points parent
         WHERE parent.id = ? AND parent.subject_id = qb.subject_id
       ))`,
      parentId,
      name,
      parentId,
      bankId,
      parentId,
      parentId,
    );
    if (!inserted.changes) result = 'missing';
  });
  return result;
}

export async function deleteQuestionBank(db: SQLiteDatabase, bankId: number) {
  let importUris: string[] = [];
  await writeTransaction(db, undefined, async (transaction) => {
    const activeImport = await transaction.getFirstAsync<{ id: number }>(
      `SELECT id FROM question_import_jobs
       WHERE bank_id = ? AND status IN ('queued', 'running', 'retry_wait') LIMIT 1`,
      bankId,
    );
    if (activeImport) throw new Error('题库仍有导入任务，请先在导入页取消后再删除');
    importUris = (await transaction.getAllAsync<{ uri: string }>(
      'SELECT stored_uri AS uri FROM question_import_jobs WHERE bank_id = ?',
      bankId,
    )).map((row) => row.uri);
    const questions = await transaction.getAllAsync<{ id: number }>(
      `SELECT question_id AS id FROM bank_question_links WHERE bank_id = ?
       UNION
       SELECT gql.question_id FROM bank_group_links bgl
       JOIN group_question_links gql ON gql.group_id = bgl.group_id
       WHERE bgl.bank_id = ?`,
      bankId,
      bankId,
    );
    const groups = await transaction.getAllAsync<{ id: number }>(
      'SELECT group_id AS id FROM bank_group_links WHERE bank_id = ?',
      bankId,
    );
    await transaction.runAsync('DELETE FROM question_banks WHERE id = ?', bankId);
    for (const group of groups) {
      await transaction.runAsync(
        `DELETE FROM question_groups WHERE id = ?
         AND NOT EXISTS (SELECT 1 FROM bank_group_links WHERE group_id = ?)`,
        group.id,
        group.id,
      );
    }
    for (const question of questions) {
      await transaction.runAsync(
        `DELETE FROM questions WHERE id = ?
         AND NOT EXISTS (SELECT 1 FROM bank_question_links WHERE question_id = ?)
         AND NOT EXISTS (
           SELECT 1 FROM group_question_links gql
           JOIN bank_group_links bgl ON bgl.group_id = gql.group_id
           WHERE gql.question_id = ?
         )`,
        question.id,
        question.id,
        question.id,
      );
    }
  });
  return [...new Set(importUris)];
}

export async function saveQuestion(db: SQLiteDatabase, draft: QuestionDraft) {
  if (draft.explanation.length > MAX_QUESTION_TEXT_LENGTH) throw new Error('解析不能超过 20,000 个字符');
  const errors = validateQuestion({
    stem: draft.stem,
    type: draft.type,
    status: draft.status,
    options: draft.options,
    answer: draft.answer,
  });
  if (errors.length) throw new Error(errors.join('\n'));
  let answerJson: string;
  try {
    answerJson = JSON.stringify(draft.answer);
  } catch {
    throw new Error('答案格式无法保存');
  }
  if (!answerJson || answerJson.length > MAX_QUESTION_TEXT_LENGTH) {
    throw new Error('答案不能超过 20,000 个字符');
  }
  const savedBlocks = contentBlocksForSave(draft.blocks, '试题');

  let questionId = draft.id ?? 0;
  await writeTransaction(db, [
    'questions',
    'bank_question_links',
    'question_options',
    'question_answer_keys',
    'question_knowledge_links',
    'group_question_links',
    'question_groups',
    'question_content_blocks',
    'question_banks',
  ], async (transaction) => {
    const bank = await transaction.getFirstAsync<{ subject_id: number }>(
      'SELECT subject_id FROM question_banks WHERE id = ?',
      draft.bankId,
    );
    if (!bank) throw new Error('题库不存在');
    if (bank.subject_id !== draft.subjectId) throw new Error('试题学科必须与题库学科一致');
    if (questionId) {
      await transaction.runAsync(
        `UPDATE questions
         SET subject_id = ?, question_type_code = ?, stem = ?, explanation = ?,
             difficulty = ?, default_score = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        draft.subjectId,
        draft.type,
        draft.stem.trim(),
        draft.explanation.trim(),
        draft.difficulty,
        draft.score,
        questionId,
      );
    } else {
      const result = await transaction.runAsync(
        `INSERT INTO questions
         (subject_id, question_type_code, stem, explanation, status, difficulty, default_score)
         VALUES (?, ?, ?, ?, 'draft', ?, ?)`,
        draft.subjectId,
        draft.type,
        draft.stem.trim(),
        draft.explanation.trim(),
        draft.difficulty,
        draft.score,
      );
      questionId = result.lastInsertRowId;
    }

    await transaction.runAsync(
      `INSERT INTO bank_question_links(bank_id, question_id, sort_order)
       VALUES (?, ?, COALESCE((SELECT MAX(sort_order) + 1 FROM bank_question_links WHERE bank_id = ?), 0))
       ON CONFLICT(bank_id, question_id) DO NOTHING`,
      draft.bankId,
      questionId,
      draft.bankId,
    );

    const savedOptions = draft.options.filter((option) => option.content.trim());
    const keptOptionIds = savedOptions
      .map((option) => option.id)
      .filter((id): id is number => Number.isInteger(id) && Number(id) > 0);
    await transaction.runAsync(
      keptOptionIds.length
        ? `DELETE FROM question_options WHERE question_id = ? AND id NOT IN (${keptOptionIds.map(() => '?').join(',')})`
        : 'DELETE FROM question_options WHERE question_id = ?',
      questionId,
      ...keptOptionIds,
    );
    for (const [index, option] of savedOptions.entries()) {
      if (option.id) {
        const updated = await transaction.runAsync(
          `UPDATE question_options SET label = ?, content = ?, sort_order = ?
           WHERE id = ? AND question_id = ?`,
          option.label.toUpperCase(),
          option.content.trim(),
          index,
          option.id,
          questionId,
        );
        if (!updated.changes) throw new Error('试题选项已被删除，请重新加载后再试');
      } else {
        await transaction.runAsync(
          'INSERT INTO question_options(question_id, label, content, sort_order) VALUES (?, ?, ?, ?)',
          questionId,
          option.label.toUpperCase(),
          option.content.trim(),
          index,
        );
      }
    }

    const primary = await transaction.getFirstAsync<{ answer_json: string }>(
      'SELECT answer_json FROM question_answer_keys WHERE question_id = ? AND is_primary = 1',
      questionId,
    );
    if (!primary || primary.answer_json !== answerJson) {
      const version = await transaction.getFirstAsync<{ next_version: number }>(
        'SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM question_answer_keys WHERE question_id = ?',
        questionId,
      );
      await transaction.runAsync('UPDATE question_answer_keys SET is_primary = 0 WHERE question_id = ?', questionId);
      await transaction.runAsync(
        'INSERT INTO question_answer_keys(question_id, version, answer_json, is_primary) VALUES (?, ?, ?, 1)',
        questionId,
        version?.next_version ?? 1,
        answerJson,
      );
    }

    await transaction.runAsync('DELETE FROM question_knowledge_links WHERE question_id = ?', questionId);
    for (const knowledgePointId of [...new Set(draft.knowledgePointIds)]) {
      const linked = await transaction.runAsync(
        `INSERT INTO question_knowledge_links(question_id, knowledge_point_id)
         SELECT ?, id FROM knowledge_points WHERE id = ? AND subject_id = ?`,
        questionId,
        knowledgePointId,
        draft.subjectId,
      );
      if (!linked.changes) throw new Error('知识点不存在或不属于试题学科');
    }

    await transaction.runAsync(
      `DELETE FROM group_question_links
       WHERE question_id = ? AND group_id IN (
         SELECT group_id FROM bank_group_links WHERE bank_id = ?
       ) AND (? IS NULL OR group_id <> ?)`,
      questionId,
      draft.bankId,
      draft.groupId ?? null,
      draft.groupId ?? null,
    );
    if (draft.groupId) {
      const group = await transaction.getFirstAsync<{ status: QuestionStatus; has_question: number }>(
        `SELECT qg.status, EXISTS(
           SELECT 1 FROM group_question_links gql
           WHERE gql.group_id = qg.id AND gql.question_id = ?
         ) AS has_question
         FROM question_groups qg
         JOIN bank_group_links bgl ON bgl.group_id = qg.id
         WHERE qg.id = ? AND bgl.bank_id = ?`,
        questionId,
        draft.groupId,
        draft.bankId,
      );
      if (!group) throw new Error('所选题组不属于当前题库');
      if (group.status === 'archived' && !group.has_question) throw new Error('已归档题组不能添加试题');
      await transaction.runAsync(
        `INSERT INTO group_question_links(group_id, question_id, sort_order)
         VALUES (?, ?, COALESCE((SELECT MAX(sort_order) + 1 FROM group_question_links WHERE group_id = ?), 0))
         ON CONFLICT(group_id, question_id) DO NOTHING`,
        draft.groupId,
        questionId,
        draft.groupId,
      );
      if (draft.status === 'active') {
        await transaction.runAsync(
          "UPDATE question_groups SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'draft'",
          draft.groupId,
        );
      }
    }

    await replaceContentBlocks(transaction, 'question_id', questionId, savedBlocks);

    await transaction.runAsync(
      'UPDATE questions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      draft.status,
      questionId,
    );
    await transaction.runAsync('UPDATE question_banks SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', draft.bankId);
  });
  return questionId;
}

export async function saveGroupContentBlocks(db: SQLiteDatabase, groupId: number, blocks: ContentBlock[]) {
  if (!Number.isInteger(groupId) || groupId <= 0) throw new Error('题组无效');
  const saved = contentBlocksForSave(blocks, '题组');
  await writeTransaction(db, ['question_content_blocks', 'question_groups'], async (transaction) => {
    const group = await transaction.getFirstAsync<{ status: QuestionStatus }>(
      'SELECT status FROM question_groups WHERE id = ?',
      groupId,
    );
    if (!group) throw new Error('题组不存在');
    if (group.status === 'archived') throw new Error('已归档题组不能编辑');
    await replaceContentBlocks(transaction, 'group_id', groupId, saved);
    await transaction.runAsync('UPDATE question_groups SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', groupId);
  });
}

export async function setPrimaryAnswerKey(db: SQLiteDatabase, questionId: number, answerKeyId: number) {
  await writeTransaction(db, ['question_answer_keys'], async (transaction) => {
    const key = await transaction.getFirstAsync<{
      answer_json: string;
      stem: string;
      question_type_code: QuestionType;
    }>(
      `SELECT ak.answer_json, q.stem, q.question_type_code
       FROM question_answer_keys ak
       JOIN questions q ON q.id = ak.question_id
       WHERE ak.id = ? AND ak.question_id = ?`,
      answerKeyId,
      questionId,
    );
    if (!key) throw new Error('答案版本不存在');
    const options = await transaction.getAllAsync<QuestionOption>(
      'SELECT id, label, content, sort_order FROM question_options WHERE question_id = ? ORDER BY sort_order, id',
      questionId,
    );
    let answer: unknown;
    try {
      answer = JSON.parse(key.answer_json);
    } catch {
      throw new Error('答案版本数据无效');
    }
    const errors = validateQuestion({
      stem: key.stem,
      type: key.question_type_code,
      status: 'active',
      options,
      answer,
    });
    if (errors.length) throw new Error(`该答案版本与当前试题不兼容：${errors.join('；')}`);
    await transaction.runAsync('UPDATE question_answer_keys SET is_primary = 0 WHERE question_id = ?', questionId);
    await transaction.runAsync('UPDATE question_answer_keys SET is_primary = 1 WHERE id = ?', answerKeyId);
  });
}
