import type { ContentBlock, MediaAttachment, QuestionOption, QuestionType } from '@/types';

export interface SessionQuestion {
  id: number;
  position: number;
  question_type_code: QuestionType;
  type_name: string;
  stem: string;
  explanation: string;
  max_score: number;
  answer_json: string;
  options_json: string;
  submitted_answer_json: string | null;
  is_correct: number | null;
  earned_score: number | null;
  feedback: string | null;
  group_stem: string | null;
  blocks_json: string;
  media_json: string;
  group_blocks_json: string;
  group_media_json: string;
}

interface PracticeOption extends QuestionOption {
  media_json?: unknown;
}

interface StoredAnswer {
  values?: unknown;
  blanks?: unknown;
  text?: unknown;
  reference?: unknown;
}

export interface DraftAnswer {
  values: string[];
  blanks: string[];
  text: string;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function readAnswer(value: string | null): StoredAnswer {
  const parsed = parseJson(value);
  return parsed && typeof parsed === 'object' ? parsed as StoredAnswer : {};
}

function stringValues(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function readOptions(value: string): PracticeOption[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is PracticeOption => Boolean(
      item && typeof item === 'object' && typeof item.label === 'string' && typeof item.content === 'string',
    ))
    : [];
}

export function readBlocks(value: string): ContentBlock[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is ContentBlock => Boolean(
      item && typeof item === 'object' && typeof item.kind === 'string' && typeof item.content === 'string',
    ))
    : [];
}

export function readMedia(value: unknown): MediaAttachment[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is MediaAttachment => Boolean(
      item && typeof item === 'object' && typeof item.id === 'number'
      && typeof item.uri === 'string' && typeof item.mime_type === 'string',
    ))
    : [];
}

export function mediaOutsideBlocks(media: MediaAttachment[], blocks: ContentBlock[]) {
  const embedded = new Set(blocks.map((block) => block.media_asset_id).filter(Boolean));
  return media.filter((item) => !embedded.has(item.id));
}

export function draftFor(question: SessionQuestion): DraftAnswer {
  const submitted = readAnswer(question.submitted_answer_json);
  const key = readAnswer(question.answer_json);
  const storedBlanks = Array.isArray(submitted.blanks) ? submitted.blanks : [];
  const blankCount = Math.max(1, Array.isArray(key.blanks) ? key.blanks.length : 0);
  return {
    values: stringValues(submitted.values),
    blanks: Array.from({ length: blankCount }, (_, index) => (
      typeof storedBlanks[index] === 'string' ? storedBlanks[index] : ''
    )),
    text: typeof submitted.text === 'string' ? submitted.text : '',
  };
}

export function formatAnswer(
  type: QuestionType,
  answer: StoredAnswer,
  options: QuestionOption[],
  tr: (english: string, simplifiedChinese: string) => string,
) {
  if (type === 'short_answer') {
    const value = typeof answer.text === 'string' ? answer.text : answer.reference;
    return typeof value === 'string' && value.trim() ? value : tr('Not answered', '未作答');
  }
  if (type === 'fill_blank') {
    const blanks = Array.isArray(answer.blanks) ? answer.blanks : [];
    if (!blanks.length) return tr('Not answered', '未作答');
    return blanks.map((blank) => (
      Array.isArray(blank) ? stringValues(blank).join(' / ') : String(blank ?? '')
    )).join(tr('; ', '；')) || tr('Not answered', '未作答');
  }
  const values = stringValues(answer.values);
  if (!values.length) return tr('Not answered', '未作答');
  if (type === 'true_false') return values[0] === 'true' ? tr('True', '正确') : tr('False', '错误');
  return values.map((value) => {
    const option = options.find((item) => item.label.toUpperCase() === value.toUpperCase());
    return option ? `${option.label}. ${option.content}` : value;
  }).join(tr('; ', '；'));
}

export function formatScore(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
