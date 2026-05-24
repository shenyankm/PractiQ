import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/openwook/api';
import {
  gradeAnswerForTest,
  hasUsableAnswerPayloadForTest,
  normalizePracticeModeForTest,
  normalizeQuestionCountForTest,
  validateQuestionPayloadForTest,
  validateSubmittedAnswerForTest
} from '@/lib/openwook/services';

describe('practice mode helpers', () => {
  it('maps review and exam modes to their dedicated selection behavior', () => {
    expect(normalizePracticeModeForTest(undefined, 'review')).toBe('wrong');
    expect(normalizePracticeModeForTest(undefined, 'exam')).toBe('exam');
    expect(normalizePracticeModeForTest('by_type', 'practice')).toBe('by_type');
  });

  it('supports full-bank practice with a higher server-side cap', () => {
    expect(normalizeQuestionCountForTest(undefined, true)).toBe(500);
    expect(normalizeQuestionCountForTest(999, false)).toBe(500);
    expect(normalizeQuestionCountForTest(0, false)).toBe(1);
  });
});

describe('answer validation and grading', () => {
  it('rejects empty true/false submissions instead of treating them as false', () => {
    expect(() => validateSubmittedAnswerForTest('true_false', {})).toThrow(ApiError);
    expect(gradeAnswerForTest('true_false', JSON.stringify({ value: false }), {})).toBeNull();
  });

  it('grades explicit true/false answers', () => {
    expect(gradeAnswerForTest('true_false', JSON.stringify({ value: false }), { value: false })).toBe(true);
    expect(gradeAnswerForTest('true_false', JSON.stringify({ value: false }), { value: true })).toBe(false);
  });

  it('requires usable answer payloads before publishing or applying AI answers', () => {
    expect(hasUsableAnswerPayloadForTest('choice', { selected: ['A'] })).toBe(true);
    expect(hasUsableAnswerPayloadForTest('choice', { selected: [] })).toBe(false);
    expect(hasUsableAnswerPayloadForTest('fill_blank', { slots: [{ answers: [' 3 '] }] })).toBe(true);
    expect(hasUsableAnswerPayloadForTest('short_answer', { value: '   ' })).toBe(false);
  });

  it('validates active choice question payloads against options', () => {
    expect(() => validateQuestionPayloadForTest({
      answerMode: 'choice',
      status: 'active',
      options: [
        { label: 'A', content: 'Alpha', isCorrect: true },
        { label: 'B', content: 'Beta' }
      ],
      answerPayload: { selected: ['A'] }
    })).not.toThrow();

    expect(() => validateQuestionPayloadForTest({
      answerMode: 'choice',
      status: 'active',
      options: [
        { label: 'A', content: 'Alpha', isCorrect: true },
        { label: 'B', content: 'Beta' }
      ],
      answerPayload: { selected: ['C'] }
    })).toThrow(ApiError);
  });
});
