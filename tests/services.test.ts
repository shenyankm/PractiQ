import { readFileSync } from 'node:fs';
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

describe('practice page performance guardrails', () => {
  it('limits full progress rendering for large sessions by default', () => {
    const source = readFileSync('lib/openwook/services.ts', 'utf8');
    const page = readFileSync('app/(openwook)/practice/[sessionId]/page.tsx', 'utf8');

    expect(source).toContain('PRACTICE_PROGRESS_FULL_LIMIT');
    expect(source).toContain('windowedProgressIndexes');
    expect(source).toContain('progressTruncated');
    expect(source).toContain('answeredCount: answeredSummary.size');
    expect(page).toContain('仅显示当前题附近进度');
    expect(readFileSync('.env.example', 'utf8')).toContain('PRACTICE_PROGRESS_FULL_LIMIT=120');
  });
});

describe('search performance guardrails', () => {
  it('narrows question search to visible bank IDs before text matching', () => {
    const source = readFileSync('lib/openwook/services.ts', 'utf8');
    const visibleIndex = source.indexOf('visible_question_ids AS MATERIALIZED');
    const searchableIndex = source.indexOf('searchable_questions AS MATERIALIZED');
    const textMatchIndex = source.indexOf("sq.stem ILIKE '%' || query.term || '%'");

    expect(visibleIndex).toBeGreaterThan(-1);
    expect(searchableIndex).toBeGreaterThan(visibleIndex);
    expect(textMatchIndex).toBeGreaterThan(searchableIndex);
    expect(readFileSync('lib/db/migrations/0001_perf_hot_paths.sql', 'utf8')).toContain('idx_questions_stem_trgm');
    expect(readFileSync('lib/db/migrations/0001_perf_hot_paths.sql', 'utf8')).toContain('CREATE EXTENSION IF NOT EXISTS pg_trgm');
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
