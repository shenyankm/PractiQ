export type User = {
  id: number;
  username: string;
  email: string | null;
  avatar_url: string | null;
  is_active: boolean;
  role: 'admin' | 'user';
  membership: 'free' | 'plus';
  plus_trial_ends_at: string | null;
  plus_expires_at: string | null;
  created_at: string;
  updated_at: string;
};

export type Subject = {
  subject_id: string;
  display_name: string;
};

export type KnowledgePoint = {
  id: number;
  subject_id: string;
  code: string;
  display_name: string;
  parent_id: number | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
};

export type QuestionType = {
  type_id: string;
  subject_id: string;
  display_name: string;
  scope: 'question' | 'group' | 'hybrid';
  default_answer_mode: AnswerMode | null;
};

export type AnswerMode = 'choice' | 'true_false' | 'fill_blank' | 'short_answer';
export type QuestionStatus = 'draft' | 'active' | 'archived';

export type QuestionBank = {
  id: number;
  name: string;
  description: string | null;
  subject: string;
  total_count: number;
  created_by: number;
  is_public: boolean;
  created_at: string;
  updated_at: string;
  is_owner?: boolean;
  is_favorite?: boolean;
};

export type Question = {
  id: number;
  business_type: string;
  subject_id: string;
  question_type_id: string;
  answer_mode: AnswerMode;
  choice_variant: 'single' | 'multiple' | null;
  stem: string;
  analysis: string | null;
  status: QuestionStatus;
  source_type: 'manual' | 'imported' | 'parsed';
  source_ref: string | null;
  source_job_id: number | null;
  imported_by: number | null;
  created_at: string;
  updated_at: string;
};

export type BankQuestionItem = {
  bank_id: number;
  group_id: number | null;
  question_id: number;
  item_scope: 'grouped' | 'standalone';
  bank_sort_order: number;
  group_sort_order: number | null;
  question_no: string | null;
  bank_link_status: QuestionStatus;
  business_type: string;
  subject_id: string;
  question_type_id: string;
  answer_mode: AnswerMode;
  choice_variant: 'single' | 'multiple' | null;
  content_mode: string | null;
  stem: string;
  analysis: string | null;
  question_status: QuestionStatus;
  group_title: string | null;
  group_instructions: string | null;
  options?: Array<{
    id: number;
    option_label: string;
    content: string;
    is_correct: boolean;
  }>;
};

export type PracticeSession = {
  id: number;
  user_id: number;
  bank_id: number | null;
  session_type: 'practice' | 'review' | 'exam';
  status: 'active' | 'completed' | 'abandoned';
  question_count: number;
  answered_count: number;
  correct_count: number;
  wrong_count: number;
  score: number | null;
  started_at: string;
  completed_at: string | null;
};

export type PracticeMode = 'all' | 'wrong' | 'by_type' | 'exam';

export type PracticeSessionOptions = {
  mode?: PracticeMode;
  questionTypeId?: string | null;
  allQuestions?: boolean;
};

export type ImportJob = {
  id: number;
  created_by: number;
  bank_id: number | null;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  stage: string;
  request_payload: string;
  raw_result_json: string | null;
  warning_messages: string;
  total_questions: number;
  file_name: string | null;
  source_type: string | null;
  page_count: number;
  wave_count: number;
  failed_block_count: number;
  block_count: number;
  completed_block_count: number;
  retry_count: number;
  coverage_percent: number;
  quality_score: number;
  high_risk_block_count: number;
  imported_questions: number;
  review_item_count: number;
  overall_progress_percent: number | null;
  step_progress_percent: number | null;
  current_step_code: string | null;
  current_step_label: string | null;
  current_target_kind: string | null;
  current_target_name: string | null;
  last_error_code: string | null;
  risk_level: 'low' | 'medium' | 'high';
  last_error: string | null;
  last_event_id: number | null;
  last_event_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type MediaAsset = {
  id: number;
  storage_path: string;
  storage_disk: string;
  external_url: string | null;
  original_name: string | null;
  mime_type: string | null;
  width: number | null;
  height: number | null;
  size_bytes: number | null;
  duration_ms: number | null;
  created_at: string;
};

export type PracticeAnswer = {
  id: number;
  user_id: number;
  session_id: number | null;
  bank_id: number | null;
  question_id: number;
  answer_key_id: number | null;
  answer_payload: Record<string, unknown>;
  is_correct: boolean | null;
  score: number | null;
  max_score: number | null;
  duration_ms: number | null;
  answered_at: string;
};

export type ImportJobEvent = {
  id: number;
  job_id: number;
  stage: string;
  step_code: string;
  step_label: string | null;
  status: string;
  message: string | null;
  overall_progress_percent: number | null;
  step_progress_percent: number | null;
  target_kind: string | null;
  target_name: string | null;
  payload_json: string;
  created_at: string;
};
