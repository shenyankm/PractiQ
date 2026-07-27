export type QuestionType =
  | 'single_choice'
  | 'multiple_choice'
  | 'true_false'
  | 'fill_blank'
  | 'short_answer';

export type QuestionStatus = 'draft' | 'active' | 'archived';
export type PracticeMode = 'all' | 'wrong' | 'type' | 'exam';

export interface Subject {
  id: number;
  name: string;
}

export interface KnowledgePoint {
  id: number;
  name: string;
}

export interface Bank {
  id: number;
  subject_name: string;
  name: string;
  is_favorite: number;
  question_count: number;
  active_count: number;
}

export interface QuestionOption {
  id?: number;
  label: string;
  content: string;
  sort_order: number;
}

export const CONTENT_BLOCK_TYPES = [
  'text',
  'formula',
  'image',
  'table',
  'markdown',
  'html',
  'chart',
  'qrcode',
  'mathml',
] as const;

export interface ContentBlock {
  id?: number;
  kind: (typeof CONTENT_BLOCK_TYPES)[number];
  content: string;
  metadata_json?: string;
  media_asset_id?: number | null;
  media_uri?: string | null;
  media_mime_type?: string | null;
  media_file_name?: string | null;
  sort_order: number;
}

export interface MediaAttachment {
  id: number;
  file_name: string;
  uri: string;
  mime_type: string;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  metadata_json?: string | null;
}

export interface Question {
  id: number;
  question_type_code: QuestionType;
  subject_name: string;
  stem: string;
  status: QuestionStatus;
  default_score: number;
  updated_at: string;
}

export interface AnswerKey {
  id: number;
  version: number;
  answer_json: string;
  is_primary: number;
  created_at: string;
}

export interface ParsedQuestion {
  stem: string;
  type: QuestionType;
  options: QuestionOption[];
  answer: unknown;
  explanation: string;
  confidence: number;
  metadata?: Record<string, unknown>;
}

export interface ImportJob {
  id: number;
  bank_id: number;
  bank_name: string;
  file_name: string;
  file_type: string;
  parser: 'local' | 'ai';
  ai_profile: string | null;
  status: 'queued' | 'running' | 'retry_wait' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  stage: string;
  retry_count: number;
  error: string | null;
  quality_score: number | null;
  created_at: string;
}

export interface PracticeSession {
  id: number;
  bank_id: number;
  bank_name: string;
  mode: PracticeMode;
  status: 'active' | 'completed' | 'abandoned';
  exam_mode: number;
  total_questions: number;
  answered_count: number;
  correct_count: number;
  incorrect_count: number;
  score: number;
  max_score: number;
  current_index: number;
  started_at: string;
  completed_at: string | null;
}
