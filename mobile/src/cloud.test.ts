import assert from 'node:assert/strict';
import test from 'node:test';

import {
  answerFromServer,
  cloudErrorFromResponse,
  mapGeneratedAnswer,
  mapLearningReport,
  mapParsedQuestion,
  parseLearningReport,
} from './cloud';

test('server answer payload conventions map to app answer shapes', () => {
  const options = [
    { label: 'A', isCorrect: false },
    { label: 'B', isCorrect: true },
  ];
  assert.deepEqual(answerFromServer('single_choice', { correctOption: 'b' }, options), { values: ['B'] });
  assert.deepEqual(answerFromServer('multiple_choice', { correctOptions: ['a', 'B'] }, options), { values: ['A', 'B'] });
  assert.deepEqual(answerFromServer('single_choice', {}, options), { values: ['B'] });
  assert.deepEqual(answerFromServer('single_choice', {}, [{ label: 'A' }]), {});
  assert.deepEqual(answerFromServer('true_false', { value: true }, []), { values: ['true'] });
  assert.deepEqual(answerFromServer('true_false', { value: 'maybe' }, []), {});
  assert.deepEqual(answerFromServer('fill_blank', { blanks: [['4', '四'], ['8']] }, []), { blanks: [['4', '四'], ['8']] });
  assert.deepEqual(answerFromServer('fill_blank', { values: ['4'] }, []), { blanks: [['4']] });
  assert.deepEqual(answerFromServer('short_answer', {}, [], '参考答案'), { reference: '参考答案' });
});

test('parsed questions map to the app import shape with type inference', () => {
  const question = mapParsedQuestion({
    stem: '2 + 2 = ?',
    answerMode: 'choice',
    options: [
      { label: 'a', content: '3' },
      { label: 'b', content: '4' },
    ],
    answerPayload: { correctOption: 'B' },
    analysis: ' 基础加法 ',
    contentBlocks: [
      { partType: 'formula', latexValue: '2+2=4' },
      { partType: 'image', textValue: 'dropped' },
    ],
    confidence: 0.9,
  });
  assert.equal(question.type, 'single_choice');
  assert.deepEqual(question.options, [
    { label: 'A', content: '3', sort_order: 0 },
    { label: 'B', content: '4', sort_order: 1 },
  ]);
  assert.deepEqual(question.answer, { values: ['B'] });
  assert.equal(question.explanation, '基础加法');
  assert.deepEqual(question.metadata, { contentBlocks: [{ kind: 'formula', content: '2+2=4' }] });

  const multiple = mapParsedQuestion({
    stem: '选出偶数',
    answerMode: 'choice',
    options: [
      { label: 'A', content: '2', isCorrect: true },
      { label: 'B', content: '3' },
      { label: 'C', content: '4', isCorrect: true },
    ],
    answerPayload: null,
    confidence: 0.5,
  });
  assert.equal(multiple.type, 'multiple_choice');
  assert.deepEqual(multiple.answer, { values: ['A', 'C'] });
});

test('generated answers are validated before reaching the editor', () => {
  const input = {
    stem: '2 + 2 = ?',
    type: 'single_choice' as const,
    options: [
      { label: 'A', content: '3' },
      { label: 'B', content: '4' },
    ],
  };
  const result = mapGeneratedAnswer(input, {
    answerPayload: { correctOption: 'B' },
    canonicalAnswer: '4',
    explanation: '基础加法',
    confidence: 0.9,
  });
  assert.deepEqual(result, { answer: { values: ['B'] }, explanation: '基础加法', confidence: 0.9 });

  assert.throws(() => mapGeneratedAnswer(input, {
    answerPayload: { correctOption: 'C' },
    canonicalAnswer: null,
    explanation: '不存在的选项',
    confidence: 0.5,
  }), /答案无效/);
});

test('learning reports map to the saved local shape', () => {
  const report = mapLearningReport({
    summary: '基础扎实。',
    mastery: [{ label: '加法', score: 0.9, evidence: '近期作答' }],
    weakPoints: [{ label: '减法', reason: '错误率高', suggestedAction: '多做练习' }],
    recommendations: ['每天练习十题'],
  });
  assert.equal(report.weakPoints[0]?.area, '减法');
  assert.equal(report.weakPoints[0]?.evidence, '错误率高 多做练习');
  assert.deepEqual(parseLearningReport(JSON.parse(JSON.stringify(report))), report);
  assert.equal(parseLearningReport({ summary: '缺少字段' }), null);
});

test('cloud error envelopes map to actionable messages', () => {
  assert.match(cloudErrorFromResponse(401, null).message, /重新登录/);
  assert.match(cloudErrorFromResponse(403, { error: { code: 'PLUS_REQUIRED', message: 'x' } }).message, /Plus 会员/);
  assert.match(cloudErrorFromResponse(422, { error: { code: 'VALIDATION_ERROR', message: 'bad stem' } }).message, /bad stem/);
  assert.match(cloudErrorFromResponse(429, {}).message, /请求过多/);
  assert.match(cloudErrorFromResponse(500, 'not json').message, /暂时不可用/);
});
