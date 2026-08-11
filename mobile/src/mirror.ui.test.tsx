// mirror.ts repository-layer tests over an in-memory SQLite (node:sqlite via
// the expo-sqlite moduleNameMapper). The module-level database is wiped before
// each test so cases start from an empty mirror.
import { getDb } from './practiq/db';
import { MIRROR_TABLES } from './practiq/mirror-schema';
import * as mirror from './practiq/mirror';
import type { Bank, BankGroup, BankItem, MediaAsset, PracticeSession, QuestionDetail } from './practiq/types';

beforeEach(async () => {
  const db = await getDb();
  await db.execAsync(`
    DELETE FROM resources;
    DELETE FROM outbox;
    DELETE FROM sync_state;
    ${MIRROR_TABLES.map((table) => `DELETE FROM ${table};`).join('\n    ')}
  `);
});

const bank: Bank = {
  id: 42,
  name: '高数题库',
  description: null,
  subject: 'math',
  total_count: 1,
  is_public: true,
  is_owner: true,
  is_favorite: false,
  created_by: 9,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-10T03:30:02.558Z',
};

const item: BankItem = {
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
  bank_sort_order: 1,
  group_sort_order: null,
  question_no: 'Q1',
  business_type: 'standalone',
  subject_id: 'math',
  content_mode: 'text_only',
  options: [
    { id: 501, question_id: 1001, option_label: 'A', sort_order: 1, content: '2', is_correct: true },
    { id: 502, question_id: 1001, option_label: 'B', sort_order: 2, content: '3', is_correct: false },
  ],
};

const groupedItem: BankItem = {
  ...item,
  question_id: 1002,
  group_id: 77,
  group_sort_order: 1,
  item_scope: 'grouped',
  question_no: null,
  options: undefined,
};

const group: BankGroup = {
  id: 77,
  group_type_id: 'gt-1',
  title: 'G1',
  instructions: 'inst',
  content_mode: 'text_only',
  status: 'active',
  sort_order: 1,
  question_count: 0,
  can_edit: true,
};

const detail: QuestionDetail = {
  id: 1001,
  stem: '1+1=?',
  analysis: '基础加法',
  answer_mode: 'choice',
  question_type_id: 'math.choice',
  status: 'active',
  options: [
    { id: 501, question_id: 1001, option_label: 'A', sort_order: 1, content: '2', is_correct: true },
  ],
  answer_keys: [
    { id: 301, question_id: 1001, answer_mode: 'choice', version: 1, is_primary: true, answer_payload: '{"selected":["A"]}' },
  ],
  media_links: [
    { id: 601, question_id: 1001, media_id: 701, media_kind: 'image', sort_order: 1 },
  ],
  can_edit: true,
  business_type: 'standalone',
  subject_id: 'math',
  choice_variant: 'single',
  content_mode: 'text_only',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
};

const session: PracticeSession = {
  id: 5,
  bank_id: 42,
  session_type: 'practice',
  status: 'active',
  question_count: 1,
  answered_count: 1,
  correct_count: 1,
  wrong_count: 0,
  score: 50,
  started_at: '2026-08-01T00:00:00.000Z',
  completed_at: null,
};

const asset: MediaAsset = {
  id: 701,
  content_url: '/api/v1/media/701/content',
  original_name: 'a.png',
  mime_type: 'image/png',
  size_bytes: 10,
  created_by: 1,
  width: 100,
  height: 100,
};

async function seedBank() {
  await mirror.upsertBanks([bank], 9);
}

describe('subjects & question types', () => {
  it('upserts and lists subjects, skipping empty batches', async () => {
    await mirror.upsertSubjects([]);
    await mirror.upsertSubjects([{ subject_id: 'math', display_name: '数学' }]);
    const rows = await mirror.subjects();
    expect(rows).toEqual([{ subject_id: 'math', display_name: '数学' }]);
  });

  it('upserts and lists question types per subject', async () => {
    await mirror.upsertQuestionTypes([]);
    await mirror.upsertQuestionTypes([
      { type_id: 'math.choice', subject_id: 'math', display_name: '选择', scope: 'hybrid', default_answer_mode: 'choice' },
      { type_id: 'math.fill', subject_id: 'math', display_name: '填空', scope: 'exam', default_answer_mode: 'fill_blank' },
    ]);
    const rows = await mirror.questionTypes('math');
    expect(rows.map((row) => row.type_id)).toEqual(['math.fill', 'math.choice']);
  });
});

describe('banks', () => {
  it('upserts banks with owner/favorite links and lists by scope', async () => {
    await seedBank();
    const mine = await mirror.banksForScope('mine', 9);
    expect(mine).toHaveLength(1);
    expect(mine[0].name).toBe('高数题库');
    expect(mine[0].is_owner).toBe(true);
    const favorite = await mirror.banksForScope('favorites', 9);
    expect(favorite).toHaveLength(0);
    const publicBanks = await mirror.banksForScope('public', 9);
    expect(publicBanks).toHaveLength(1);
    // created response without ownership flags skips the link row
    const unowned: Bank = { ...bank, id: 43, is_owner: undefined, is_favorite: undefined };
    await mirror.upsertBanks([unowned], 9);
    expect(await mirror.bankForId(43, 9)).not.toBeNull();
    expect(await mirror.bankForId(999, 9)).toBeNull();
  });

  it('replaceBankListScope reconciles mine/favorites/public deletions', async () => {
    // mine: banks outside the fresh list lose ownership; private+unfavorited rows are deleted
    await mirror.upsertBanks([{ ...bank, id: 42, is_owner: true, is_favorite: false, is_public: false },
      { ...bank, id: 43, is_owner: true, is_favorite: false, is_public: false }], 9);
    await mirror.replaceBankListScope('mine', 9, [{ ...bank, id: 43, is_owner: true, is_public: false }]);
    expect((await mirror.banksForScope('mine', 9)).map((row) => row.id)).toEqual([43]);
    expect(await mirror.bankForId(42, 9)).toBeNull(); // private + unfavorited + not owned -> deleted
    // favorites: only the flag is cleared for banks outside the list
    await mirror.upsertBanks([{ ...bank, id: 42, is_owner: false, is_favorite: true, is_public: true },
      { ...bank, id: 43, is_owner: false, is_favorite: true, is_public: true }], 9);
    await mirror.replaceBankListScope('favorites', 9, [{ ...bank, id: 43, is_owner: false, is_favorite: true, is_public: true }]);
    expect((await mirror.banksForScope('favorites', 9)).map((row) => row.id)).toEqual([43]);
    expect((await mirror.bankForId(42, 9))?.is_favorite).toBe(false);
    // public: leaving the list downgrades to private, rows without any link are deleted
    await mirror.replaceBankListScope('public', 9, []);
    expect((await mirror.bankForId(43, 9))?.is_public).toBe(false);
  });
});

describe('bank items', () => {
  it('upserts standalone and grouped items, preserving learner-cropped columns', async () => {
    await mirror.upsertBankItems(42, []);
    await mirror.upsertBankGroups(42, [group]); // bank_group_links rows back the grouped items
    await mirror.upsertBankItems(42, [item, groupedItem]);
    const rows = await mirror.bankItems(42);
    expect(rows).toHaveLength(2);
    expect(rows[0].question_id).toBe(1001);
    expect(rows[0].options?.[0].is_correct).toBe(true);
    expect(rows[1].group_id).toBe(77);
    // learner pull without options keeps local options
    await mirror.upsertBankItems(42, [{ ...item, options: undefined }]);
    const after = await mirror.bankItems(42);
    expect(after[0].options).toHaveLength(2);
  });

  it('replaceBankScope reconciles items and groups', async () => {
    await mirror.upsertBankItems(42, [item, groupedItem]);
    await mirror.replaceBankScope(42, [item], null);
    const rows = await mirror.bankItems(42);
    expect(rows.map((row) => row.question_id)).toEqual([1001]);
    expect(rows[0].group_id).toBeNull();
  });
});

describe('bank groups', () => {
  it('upserts groups and lists them with counts', async () => {
    await seedBank(); // owner link drives can_edit
    await mirror.upsertBankGroups(42, []);
    await mirror.upsertBankGroups(42, [group]);
    const rows = await mirror.bankGroups(42, 9);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('G1');
    expect(rows[0].can_edit).toBe(true);
  });

  it('replaceBankScope reconciles groups when items are untouched', async () => {
    await mirror.upsertBankGroups(42, [group]);
    await mirror.replaceBankScope(42, null, []);
    expect(await mirror.bankGroups(42, 9)).toHaveLength(0);
  });
});

describe('question detail', () => {
  it('upserts full detail: options, answer keys, media stubs', async () => {
    await seedBank();
    await mirror.upsertBankItems(42, [item]); // owner link + bank_question_link drive can_edit
    await mirror.upsertQuestionDetail(detail);
    const loaded = await mirror.questionDetail(1001, 9);
    expect(loaded?.stem).toBe('1+1=?');
    expect(loaded?.options).toHaveLength(1);
    expect(loaded?.answer_keys).toHaveLength(1);
    expect(loaded?.media_links).toHaveLength(1);
    expect(loaded?.can_edit).toBe(true);
    // owner link missing -> can_edit false
    const stranger = await mirror.questionDetail(1001, 99);
    expect(stranger?.can_edit).toBe(false);
    expect(await mirror.questionDetail(404, 9)).toBeNull();
  });

  it('keeps existing answer keys when the detail omits them', async () => {
    await mirror.upsertQuestionDetail(detail);
    await mirror.upsertQuestionDetail({ ...detail, answer_keys: undefined });
    const loaded = await mirror.questionDetail(1001, 9);
    expect(loaded?.answer_keys).toHaveLength(1);
  });

  it('upserts media assets', async () => {
    await mirror.upsertMediaAsset(asset);
    await mirror.upsertQuestionDetail(detail);
    const withAsset = await mirror.questionDetail(1001, 9);
    expect(withAsset?.media_links[0].media_id).toBe(701);
  });
});

describe('practice sessions & answers', () => {
  it('upserts sessions and lists recent ones newest first', async () => {
    await mirror.upsertSessions([], 9);
    await mirror.upsertSessions([
      { ...session, id: 5, started_at: '2026-08-01T00:00:00.000Z' },
      { ...session, id: 6, started_at: '2026-08-02T00:00:00.000Z' },
    ], 9);
    const rows = await mirror.recentSessions(9, 1);
    expect(rows.map((row) => row.id)).toEqual([6]);
    expect(rows[0].status).toBe('active');
  });

  it('upserts answers with boolean normalization', async () => {
    await mirror.upsertAnswers([], 9);
    await mirror.upsertAnswers([
      {
        id: 11, session_id: 5, bank_id: 42, question_id: 1001,
        answer_payload: { selected: ['A'] }, is_correct: true, score: 1, max_score: 1,
        duration_ms: 100, answered_at: '2026-08-01T00:00:00.000Z',
      },
      {
        id: 12, session_id: 5, question_id: 1002,
        answer_payload: { selected: [] }, is_correct: null,
      },
    ], 9);
    const db = await getDb();
    const stored = await db.getAllAsync<{ id: number; is_correct: number | null }>('SELECT id, is_correct FROM user_question_answers ORDER BY id');
    expect(stored).toEqual([
      { id: 11, is_correct: 1 },
      { id: 12, is_correct: null },
    ]);
  });
});

describe('sync anchors', () => {
  it('reads and writes anchors', async () => {
    expect(await mirror.getSyncAnchor('banks')).toBeNull();
    await mirror.setSyncAnchor('banks', '2026-08-01T00:00:00.000Z');
    expect(await mirror.getSyncAnchor('banks')).toBe('2026-08-01T00:00:00.000Z');
    await mirror.setSyncAnchor('banks', '2026-08-02T00:00:00.000Z');
    expect(await mirror.getSyncAnchor('banks')).toBe('2026-08-02T00:00:00.000Z');
  });
});

describe('resource mirrors', () => {
  it('banksResourceMirror: null user degrades to network-only', async () => {
    await seedBank();
    const mirrorBanks = mirror.banksResourceMirror('mine', null);
    expect(await mirrorBanks.read()).toBeNull();
    await mirrorBanks.write([{ ...bank, id: 99 }]); // no-op
    expect(await mirror.banksForScope('mine', 9)).toHaveLength(1);
    const loggedIn = mirror.banksResourceMirror('mine', 9, 1);
    expect((await loggedIn.read())).toHaveLength(1);
    await loggedIn.write([{ ...bank, id: 42, name: '改名' }], { reconcile: true });
    expect((await mirror.banksForScope('mine', 9))[0].name).toBe('改名');
  });

  it('bankResourceMirror reads and writes one bank', async () => {
    await seedBank();
    const m = mirror.bankResourceMirror(42, 9);
    expect((await m.read())?.id).toBe(42);
    const anonymous = mirror.bankResourceMirror(42, null);
    expect(await anonymous.read()).toBeNull();
    await anonymous.write(bank); // no-op
    await m.write({ ...bank, id: 42, name: '新名' });
    expect((await mirror.bankForId(42, 9))?.name).toBe('新名');
  });

  it('bankItemsResourceMirror reads and writes with/without reconcile', async () => {
    await mirror.upsertBankGroups(42, [group]);
    await mirror.upsertBankItems(42, [item, groupedItem]);
    const m = mirror.bankItemsResourceMirror(42);
    expect((await m.read())).toHaveLength(2);
    await m.write([item], { reconcile: true });
    expect(await mirror.bankItems(42)).toHaveLength(1);
    const noReconcile = mirror.bankItemsResourceMirror(42, { reconcile: false });
    await noReconcile.write([groupedItem], { reconcile: true });
    expect(await mirror.bankItems(42)).toHaveLength(2);
  });

  it('bankGroupsResourceMirror reads and writes groups', async () => {
    await mirror.upsertBankGroups(42, [group]);
    const m = mirror.bankGroupsResourceMirror(42, 9);
    expect(await m.read()).toHaveLength(1);
    await m.write([], { reconcile: true });
    expect(await mirror.bankGroups(42, 9)).toHaveLength(0);
  });

  it('subjects/questionTypes/sessions/questionDetail mirrors', async () => {
    await mirror.upsertSubjects([{ subject_id: 'math', display_name: '数学' }]);
    expect(await mirror.subjectsResourceMirror().read()).toHaveLength(1);
    await mirror.subjectsResourceMirror().write([{ subject_id: 'eng', display_name: '英语' }]);
    expect(await mirror.subjects()).toHaveLength(2);

    await mirror.upsertQuestionTypes([{ type_id: 't', subject_id: 'math', display_name: 'T', scope: 'hybrid', default_answer_mode: 'choice' }]);
    expect(await mirror.questionTypesResourceMirror('math').read()).toHaveLength(1);

    await mirror.upsertSessions([session], 9);
    const sessions = mirror.sessionsResourceMirror(9, 1);
    expect(await sessions.read()).toHaveLength(1);
    expect(await mirror.sessionsResourceMirror(null).read()).toBeNull();
    await sessions.write([{ ...session, id: 7, started_at: '2026-08-03T00:00:00.000Z' }]);
    expect(await mirror.recentSessions(9, 5)).toHaveLength(2);

    const qd = mirror.questionDetailResourceMirror(1001, 9);
    expect(await qd.read()).toBeNull();
    await qd.write(detail);
    expect((await qd.read())?.stem).toBe('1+1=?');
  });
});
