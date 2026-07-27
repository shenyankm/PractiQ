import type { ParsedQuestion, QuestionOption, QuestionType } from './types';

export interface QuestionInput {
  stem: string;
  type: QuestionType;
  status: 'draft' | 'active' | 'archived';
  options: QuestionOption[];
  answer: unknown;
}

export interface GradeResult {
  isCorrect: boolean | null;
  score: number | null;
  feedback: string;
}

export const MAX_QUESTION_TEXT_LENGTH = 20_000;
export const MAX_OPTION_COUNT = 26;
export const MAX_BLANK_COUNT = 100;
export const MAX_BLANK_VALUE_LENGTH = 2_000;

const record = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const normalize = (value: unknown) =>
  String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('zh-CN');

const unique = (values: string[]) => [...new Set(values.map(normalize).filter(Boolean))].sort();

export function makeAnswer(type: QuestionType, raw: string): unknown {
  if (type === 'single_choice' || type === 'multiple_choice') {
    return { values: unique(raw.split(/[,，\s]+/).map((value) => value.toUpperCase())) };
  }
  if (type === 'true_false') {
    return { values: [/(正确|对|true|yes|是|1)/i.test(raw) ? 'true' : 'false'] };
  }
  if (type === 'fill_blank') {
    return {
      blanks: raw
        .split(/[;；]/)
        .map((blank) => unique(blank.split(/[|｜/]/)))
        .filter((blank) => blank.length > 0),
    };
  }
  return { reference: raw.trim() };
}

export function answerToText(type: QuestionType, answer: unknown): string {
  const value = answer as { values?: string[]; blanks?: string[][]; reference?: string };
  if (type === 'fill_blank') return (value.blanks ?? []).map((blank) => blank.join('|')).join(';');
  if (type === 'short_answer') return value.reference ?? '';
  if (type === 'true_false') return value.values?.[0] === 'true' ? '正确' : '错误';
  return (value.values ?? []).join(',');
}

export function validateQuestion(input: QuestionInput): string[] {
  const hardErrors: string[] = [];
  const publicationErrors: string[] = [];
  if (!input.stem.trim()) hardErrors.push('题干不能为空');
  if (input.stem.trim().length > MAX_QUESTION_TEXT_LENGTH) hardErrors.push('题干不能超过 20,000 个字符');
  if (input.options.length > MAX_OPTION_COUNT) hardErrors.push('选择题最多支持 26 个选项');
  if (input.options.some((option) => option.label.length > 10 || option.content.length > MAX_QUESTION_TEXT_LENGTH)) {
    hardErrors.push('选项标签不能超过 10 个字符，内容不能超过 20,000 个字符');
  }

  const answer = record(input.answer);
  if (input.type === 'single_choice' || input.type === 'multiple_choice') {
    const options = input.options.filter((option) => option.content.trim());
    if (options.length < 2) publicationErrors.push('选择题至少需要两个选项');
    const labels = new Set(options.map((option) => option.label.toUpperCase()));
    const values = Array.isArray(answer.values)
      ? answer.values.filter((value): value is string => typeof value === 'string')
      : [];
    if (input.type === 'single_choice' && values.length !== 1) publicationErrors.push('单选题必须有一个答案');
    if (input.type === 'multiple_choice' && values.length < 1) publicationErrors.push('多选题至少需要一个答案');
    if (values.some((value) => !labels.has(value.toUpperCase()))) publicationErrors.push('答案必须对应现有选项');
  } else if (input.type === 'true_false') {
    const values = Array.isArray(answer.values) ? answer.values : [];
    if (values.length !== 1 || !['true', 'false'].includes(String(values[0]))) publicationErrors.push('判断题答案无效');
  } else if (input.type === 'fill_blank') {
    const blanks = Array.isArray(answer.blanks) ? answer.blanks : [];
    if (blanks.length > MAX_BLANK_COUNT) hardErrors.push('填空题最多支持 100 个空');
    if (blanks.some((blank) => (
      !Array.isArray(blank) || blank.length > 20 ||
      blank.some((value) => typeof value !== 'string' || value.length > MAX_BLANK_VALUE_LENGTH)
    ))) hardErrors.push('每个空最多支持 20 个答案，单个答案不能超过 2,000 个字符');
    if (!blanks.length || blanks.some((blank) => !Array.isArray(blank) || !blank.length)) {
      publicationErrors.push('每个填空都需要至少一个可接受答案');
    }
  } else {
    const reference = typeof answer.reference === 'string' ? answer.reference : '';
    if (reference.length > MAX_QUESTION_TEXT_LENGTH) hardErrors.push('参考答案不能超过 20,000 个字符');
    if (!reference.trim()) publicationErrors.push('简答题需要参考答案');
  }

  return input.status === 'active' ? [...hardErrors, ...publicationErrors] : hardErrors;
}

export function serializePracticeAnswer(type: QuestionType, submitted: unknown) {
  const answer = record(submitted);
  if (type === 'short_answer') {
    if (typeof answer.text !== 'string' || !answer.text.trim() || answer.text.length > MAX_QUESTION_TEXT_LENGTH) {
      throw new Error('简答作答必须为 1 到 20,000 个字符');
    }
  } else if (type === 'fill_blank') {
    if (
      !Array.isArray(answer.blanks) || !answer.blanks.length || answer.blanks.length > MAX_BLANK_COUNT ||
      answer.blanks.some((blank) => typeof blank !== 'string' || !blank.trim() || blank.length > MAX_BLANK_VALUE_LENGTH)
    ) throw new Error('填空作答格式无效或超过长度限制');
  } else {
    const values = Array.isArray(answer.values) ? answer.values : [];
    const maximum = type === 'multiple_choice' ? MAX_OPTION_COUNT : 1;
    if (
      !values.length || values.length > maximum ||
      values.some((value) => typeof value !== 'string' || !value || value.length > 10) ||
      (type === 'true_false' && !['true', 'false'].includes(String(values[0])))
    ) throw new Error('选择答案格式无效');
  }
  const json = JSON.stringify(submitted);
  if (json.length > MAX_QUESTION_TEXT_LENGTH) throw new Error('作答内容不能超过 20,000 个字符');
  return json;
}

export function gradeAnswer(
  type: QuestionType,
  submitted: unknown,
  answerKey: unknown,
  maxScore: number,
): GradeResult {
  const submission = submitted as { values?: string[]; blanks?: string[]; text?: string };
  const key = answerKey as { values?: string[]; blanks?: string[][]; reference?: string };

  if (type === 'short_answer') {
    return { isCorrect: null, score: null, feedback: key.reference ?? '请对照参考答案自评。' };
  }

  let isCorrect = false;
  if (type === 'single_choice' || type === 'multiple_choice' || type === 'true_false') {
    isCorrect = JSON.stringify(unique(submission.values ?? [])) === JSON.stringify(unique(key.values ?? []));
  } else {
    const answers = submission.blanks ?? [];
    const expected = key.blanks ?? [];
    isCorrect =
      answers.length === expected.length &&
      expected.every((accepted, index) => accepted.map(normalize).includes(normalize(answers[index])));
  }

  return {
    isCorrect,
    score: isCorrect ? maxScore : 0,
    feedback: isCorrect ? '回答正确' : '回答错误，请查看解析和参考答案。',
  };
}

function parseMetadata(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = value ? JSON.parse(value) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function metadataText(value: string | null | undefined) {
  const label = parseMetadata(value).alt;
  return typeof label === 'string' ? label : '';
}

export function withMetadataText(value: string | null | undefined, alt: string) {
  const metadata = parseMetadata(value);
  if (alt.trim()) metadata.alt = alt.trim();
  else delete metadata.alt;
  return Object.keys(metadata).length ? JSON.stringify(metadata) : undefined;
}

function inferType(stem: string, options: QuestionOption[], answer: string): QuestionType {
  if (options.length) {
    return unique(answer.match(/[A-Z]/gi) ?? []).length > 1 ? 'multiple_choice' : 'single_choice';
  }
  if (/(判断|正确|错误|对错)/.test(stem) || /^(正确|错误|对|错|true|false)$/i.test(answer.trim())) {
    return 'true_false';
  }
  if (/_{2,}|（\s*）|\(\s*\)|填空/.test(stem)) return 'fill_blank';
  return 'short_answer';
}

function parseChunk(lines: string[]): ParsedQuestion | null {
  const stem: string[] = [];
  const explanation: string[] = [];
  const options: QuestionOption[] = [];
  let answer = '';
  let section: 'stem' | 'answer' | 'explanation' = 'stem';

  for (const sourceLine of lines) {
    const line = sourceLine.trim();
    if (!line) continue;
    const option = line.match(/^([A-H])[.、．)）:]\s*(.+)$/i);
    const answerLine = line.match(/^(?:参考)?答案\s*[:：]\s*(.*)$/i);
    const explanationLine = line.match(/^(?:解析|解答|说明)\s*[:：]\s*(.*)$/i);
    if (option) {
      options.push({ label: option[1].toUpperCase(), content: option[2].trim(), sort_order: options.length });
      continue;
    }
    if (answerLine) {
      answer = answerLine[1].trim();
      section = 'answer';
      continue;
    }
    if (explanationLine) {
      explanation.push(explanationLine[1].trim());
      section = 'explanation';
      continue;
    }
    if (section === 'explanation') explanation.push(line);
    else if (section === 'answer') answer += `${answer ? ' ' : ''}${line}`;
    else stem.push(line.replace(/^\s*(?:第\s*)?\d+\s*[.、．)）]\s*/, ''));
  }

  const stemText = stem.join('\n').trim();
  if (!stemText) return null;
  const type = inferType(stemText, options, answer);
  const parsedAnswer = makeAnswer(type, answer);
  const confidence = Math.min(
    1,
    0.35 + (answer ? 0.3 : 0) + (options.length >= 2 ? 0.2 : 0) + (explanation.length ? 0.1 : 0),
  );
  return {
    stem: stemText,
    type,
    options,
    answer: parsedAnswer,
    explanation: explanation.join('\n'),
    confidence,
  };
}

export function parsePlainText(source: string): ParsedQuestion[] {
  const text = source.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').trim();
  if (!text) return [];

  const chunks: string[][] = [];
  let current: string[] = [];
  for (const line of text.split('\n')) {
    const startsQuestion = /^\s*(?:第\s*)?\d+\s*[.、．)）]\s*\S+/.test(line);
    const hasAnswer = current.some((value) => /^(?:参考)?答案\s*[:：]/i.test(value.trim()));
    if ((startsQuestion && current.length) || (!line.trim() && hasAnswer)) {
      chunks.push(current);
      current = [];
    }
    if (line.trim()) current.push(line);
  }
  if (current.length) chunks.push(current);

  return chunks.map(parseChunk).filter((question): question is ParsedQuestion => question !== null);
}
