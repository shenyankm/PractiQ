import assert from 'node:assert/strict';

import {
  answerPayloadFromText,
  answerPayloadToText,
  bankFromRow,
  bankItemFromRow,
  bankQuestionLinkRowFromItem,
  groupQuestionLinkRowFromItem,
  mergeAnswerColumns,
  questionBankRowFromApi,
  questionOptionRowFromApi,
  questionRowFromItem,
  userBankLinkRowFromApi,
  type JoinedBankItemRow,
  type QuestionOptionRow,
} from './practiq/mirror-map';
import type { Bank, BankItem } from './practiq/types';

const apiBank: Bank = {
  id: 42,
  name: '高数题库',
  description: null,
  subject: 'math',
  total_count: 7,
  is_public: true,
  is_owner: true,
  is_favorite: false,
  created_by: 9,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-10T03:30:02.558Z',
};

test('API Bank JSON 拆成 question_banks + user_bank_links 行(布尔 → 0/1)', () => {
  const bank = questionBankRowFromApi(apiBank);
  assert.equal(bank.is_public, 1);
  assert.equal(bank.created_by, 9);
  assert.equal(bank.updated_at, '2026-08-10T03:30:02.558Z');
  const link = userBankLinkRowFromApi(apiBank, 9);
  assert.deepEqual(link, {
    user_id: 9,
    bank_id: 42,
    is_owner: 1,
    is_favorite: 0,
    updated_at: '2026-08-10T03:30:02.558Z',
  });
});

test('创建响应缺少归属标志时不动本地 link 行', () => {
  const created: Bank = {
    id: 43,
    name: '新题库',
    description: 'x',
    subject: 'general',
    total_count: 0,
    is_public: false,
  };
  assert.equal(userBankLinkRowFromApi(created, 9), null);
});

test('question_banks + link 行组装回 Bank(0/1 → 布尔、负数 id 还原 pending)', () => {
  const bank = bankFromRow({
    ...questionBankRowFromApi(apiBank),
    is_owner: 1,
    is_favorite: 0,
  });
  assert.equal(bank.is_public, true);
  assert.equal(bank.is_owner, true);
  assert.equal(bank.is_favorite, false);
  assert.equal(bank.updated_at, '2026-08-10T03:30:02.558Z');
  assert.equal(bank.pending, undefined);

  const pending = bankFromRow({
    ...questionBankRowFromApi({ ...apiBank, id: -1723 }),
    is_owner: 1,
    is_favorite: 0,
  });
  assert.equal(pending.pending, true);
});

const apiItem: BankItem = {
  bank_id: 42,
  question_id: 1001,
  group_id: null,
  stem: '1+1=?',
  analysis: '基础加法',
  answer_mode: 'choice',
  choice_variant: 'single',
  question_type_id: 'math.choice',
  question_status: 'active',
  bank_link_status: 'active',
  item_scope: 'standalone',
  bank_sort_order: 3,
  group_sort_order: null,
  question_no: 'Q3',
  business_type: 'standalone',
  subject_id: 'math',
  content_mode: 'text_only',
  options: [
    { id: 501, question_id: 1001, option_label: 'A', sort_order: 1, content: '2', is_correct: true },
    { id: 502, question_id: 1001, option_label: 'B', sort_order: 2, content: '3', is_correct: false },
  ],
};

test('BankItem 拆成 questions / question_options / link 三类行', () => {
  const merged = mergeAnswerColumns({ analysis: apiItem.analysis, options: apiItem.options ?? [] }, null);
  const question = questionRowFromItem(apiItem, merged.analysis);
  assert.equal(question.id, 1001);
  assert.equal(question.question_type_id, 'math.choice');
  assert.equal(question.analysis, '基础加法');
  assert.equal(question.status, 'active');
  // items API 不交付的列保持 null,交给 SQL COALESCE 保留本地值
  assert.equal(question.detail_payload, null);
  assert.equal(question.created_at, null);

  const options = merged.options.map((option) => questionOptionRowFromApi(option, apiItem.question_id));
  assert.deepEqual(options.map((row) => [row.id, row.is_correct]), [[501, 1], [502, 0]]);

  const standalone = bankQuestionLinkRowFromItem(42, apiItem);
  assert.deepEqual(standalone, { bank_id: 42, question_id: 1001, sort_order: 3, question_no: 'Q3', status: 'active' });

  const grouped = groupQuestionLinkRowFromItem(77, { ...apiItem, group_id: 77, group_sort_order: 5 });
  assert.deepEqual(grouped, { group_id: 77, question_id: 1001, sort_order: 5, question_no: 'Q3' });
});

test('行组装回 BankItem(布尔还原、options 按行聚合)', () => {
  const joinedRow: JoinedBankItemRow = {
    bank_id: 42,
    group_id: null,
    question_id: 1001,
    item_scope: 'standalone',
    bank_sort_order: 3,
    group_sort_order: null,
    question_no: 'Q3',
    bank_link_status: 'active',
    business_type: 'standalone',
    subject_id: 'math',
    question_type_id: 'math.choice',
    answer_mode: 'choice',
    choice_variant: 'single',
    content_mode: 'text_only',
    stem: '1+1=?',
    analysis: '基础加法',
    question_status: 'active',
    group_title: null,
    group_instructions: null,
  };
  const optionRows: QuestionOptionRow[] = [
    { id: 501, question_id: 1001, option_label: 'A', sort_order: 1, content: '2', is_correct: 1, created_at: null, updated_at: null },
    { id: 502, question_id: 1001, option_label: 'B', sort_order: 2, content: '3', is_correct: null, created_at: null, updated_at: null },
  ];
  const item = bankItemFromRow(joinedRow, optionRows);
  assert.equal(item.question_status, 'active');
  assert.equal(item.options?.[0]?.is_correct, true);
  // is_correct 为 NULL 表示学员视角未知,还原为键不存在
  assert.equal(item.options?.[1] && 'is_correct' in item.options[1], false);
});

test('user_question_answers 的 answer_payload stringify/parse 往返', () => {
  const payload = { selected: ['A', 'C'], note: 'round trip' };
  assert.deepEqual(answerPayloadFromText(answerPayloadToText(payload)), payload);
  assert.equal(answerPayloadToText(undefined), '{}');
  assert.deepEqual(answerPayloadFromText('not json'), {});
  assert.deepEqual(answerPayloadFromText('[1,2]'), {});
  assert.deepEqual(answerPayloadFromText(null), {});
});

test('学员裁剪列:undefined 保留本地值,显式交付(含 null)才覆盖', () => {
  const existing = {
    analysis: '已有解析',
    options: [{ id: 501, is_correct: 1 }, { id: 502, is_correct: 0 }],
  };
  // 学员拉取:analysis 键不存在、options 无 is_correct、无 answer_keys → 全部保留
  const learnerPull = mergeAnswerColumns(
    { options: [{ id: 501, option_label: 'A', sort_order: 1, content: '2' }] },
    existing,
  );
  assert.equal(learnerPull.analysis, '已有解析');
  assert.equal(learnerPull.options[0]?.is_correct, true);
  assert.equal(learnerPull.answerKeys, null);

  // 显式 null 是真实交付,覆盖本地
  const cleared = mergeAnswerColumns({ analysis: null, options: [] }, existing);
  assert.equal(cleared.analysis, null);

  // 归属者拉取:字段都交付 → 覆盖;answer_keys 交付(含空数组)→ 整体替换
  const ownerPull = mergeAnswerColumns(
    {
      analysis: '新解析',
      options: [{ id: 502, option_label: 'B', sort_order: 2, content: '3', is_correct: false }],
      answer_keys: [{ answer_payload: '{"selected":["B"]}' }],
    },
    existing,
  );
  assert.equal(ownerPull.analysis, '新解析');
  assert.equal(ownerPull.options[0]?.is_correct, false);
  assert.equal(ownerPull.answerKeys?.length, 1);

  // 本地无任何记录时 undefined 落 null
  const fresh = mergeAnswerColumns({}, null);
  assert.equal(fresh.analysis, null);
  assert.equal(fresh.options.length, 0);
});
