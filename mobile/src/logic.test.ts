import assert from 'node:assert/strict';
import test from 'node:test';

import {
  gradeAnswer,
  makeAnswer,
  metadataText,
  parsePlainText,
  serializePracticeAnswer,
  validateQuestion,
  withMetadataText,
} from './logic';

test('grades all supported answer shapes', () => {
  assert.equal(gradeAnswer('single_choice', { values: ['b'] }, { values: ['B'] }, 2).score, 2);
  assert.equal(gradeAnswer('multiple_choice', { values: ['C', 'A'] }, { values: ['A', 'C'] }, 3).isCorrect, true);
  assert.equal(gradeAnswer('true_false', { values: ['false'] }, { values: ['true'] }, 1).isCorrect, false);
  assert.equal(gradeAnswer('fill_blank', { blanks: [' 四 '] }, { blanks: [['4', '四']] }, 2).isCorrect, true);
  assert.equal(gradeAnswer('short_answer', { text: '任意回答' }, { reference: '参考答案' }, 4).isCorrect, null);
});

test('only complete questions can be published', () => {
  const errors = validateQuestion({
    stem: '2 + 2 = ?',
    type: 'single_choice',
    status: 'active',
    options: [
      { label: 'A', content: '3', sort_order: 0 },
      { label: 'B', content: '4', sort_order: 1 },
    ],
    answer: makeAnswer('single_choice', ''),
  });
  assert.deepEqual(errors, ['单选题必须有一个答案']);
});

test('persistent question and practice answers enforce bounded shapes', () => {
  assert.match(serializePracticeAnswer('short_answer', { text: '作答' }), /作答/);
  assert.throws(() => serializePracticeAnswer('short_answer', { text: 'x'.repeat(20_001) }), /20,000/);
  assert.throws(() => serializePracticeAnswer('fill_blank', { blanks: Array(101).fill('x') }), /长度限制/);
  assert.deepEqual(validateQuestion({
    stem: '草稿',
    type: 'single_choice',
    status: 'draft',
    options: [{ label: 'A', content: 'x'.repeat(20_001), sort_order: 0 }],
    answer: {},
  }), ['选项标签不能超过 10 个字符，内容不能超过 20,000 个字符']);
  assert.deepEqual(validateQuestion({
    stem: '草稿简答题',
    type: 'short_answer',
    status: 'draft',
    options: [],
    answer: { reference: 'x'.repeat(20_001) },
  }), ['参考答案不能超过 20,000 个字符']);
});

test('plain-text import is deterministic', () => {
  const questions = parsePlainText(`1. 计算 2 + 2\nA. 3\nB. 4\n答案：B\n解析：基础加法\n\n2. 水在标准大气压下 100℃ 沸腾。\n答案：正确`);
  assert.equal(questions.length, 2);
  assert.equal(questions[0].type, 'single_choice');
  assert.deepEqual(questions[0].answer, { values: ['b'] });
  assert.equal(questions[1].type, 'true_false');
});

test('plain-text import infers every supported question type', () => {
  const questions = parsePlainText(`
1. 2 + 2 = ?
A. 3
B. 4
答案：B

2. 哪些是质数？
A. 2
B. 4
C. 5
答案：A,C

3. 两个奇数之和是偶数。
答案：正确

4. 2 + 2 = ____
答案：4|四

5. 简述勾股定理。
答案：两直角边平方和等于斜边平方
  `);

  assert.deepEqual(questions.map((question) => question.type), [
    'single_choice',
    'multiple_choice',
    'true_false',
    'fill_blank',
    'short_answer',
  ]);
  assert.deepEqual(questions[1].answer, { values: ['a', 'c'] });
  assert.deepEqual(questions[3].answer, { blanks: [['4', '四']] });
  assert.deepEqual(questions[4].answer, { reference: '两直角边平方和等于斜边平方' });
});

test('media metadata annotations survive edits and malformed values', () => {
  assert.equal(metadataText(withMetadataText('{"source":"docx"}', '示意图')), '示意图');
  assert.equal(metadataText('{'), '');
  assert.equal(withMetadataText('{', '替换文本'), '{"alt":"替换文本"}');
});
