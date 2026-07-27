export type AuthUser = {
  id: number;
  username: string;
  email?: string | null;
  role: 'admin' | 'user';
  membership: string;
};

export type Bank = {
  id: number;
  name: string;
  description?: string | null;
  subject: string;
  total_count: number;
  is_public: boolean;
  is_owner?: boolean;
  is_favorite?: boolean;
};

export type BankItem = {
  bank_id: number;
  group_id?: number | null;
  question_id: number;
  item_scope: string;
  question_type_id: string;
  answer_mode: 'choice' | 'true_false' | 'fill_blank' | 'short_answer';
  choice_variant?: 'single' | 'multiple' | null;
  stem: string;
  analysis?: string | null;
  question_status: 'draft' | 'active' | 'archived';
  options?: QuestionOption[];
};

export type QuestionOption = {
  id: number;
  option_label: string;
  content: string;
  is_correct: boolean;
  sort_order: number;
};

export type Question = {
  id: number;
  stem: string;
  analysis?: string | null;
  answer_mode: BankItem['answer_mode'];
  choice_variant?: BankItem['choice_variant'];
  question_type_id: string;
  status: 'draft' | 'active' | 'archived';
  options: QuestionOption[];
  answer_keys: Array<{ answer_payload: string; explanation_payload: string }>;
};

export type PracticeSession = {
  id: number;
  bank_id: number | null;
  session_type: string;
  status: 'active' | 'completed' | 'abandoned';
  question_count: number;
  answered_count: number;
  correct_count: number;
  wrong_count: number;
  score?: number | null;
};

export type ImportJob = {
  id: number;
  bank_id: number | null;
  status: string;
  stage: string;
  file_name?: string | null;
  source_type?: string | null;
  imported_questions: number;
  total_questions: number;
  overall_progress_percent?: number | null;
  last_error?: string | null;
  created_at: string;
};

export type AnalyticsSummary = {
  owned_banks: number;
  favorite_banks: number;
  attempts: number;
  correct: number;
  wrong: number;
  sessions: number;
  active_sessions: number;
  active_imports: number;
  accuracy: number;
};
