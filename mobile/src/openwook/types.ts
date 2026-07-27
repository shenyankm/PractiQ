export type CloudUser = {
  id?: number;
  username: string;
  email?: string | null;
  role?: 'admin' | 'user';
  membership?: string;
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
  pending?: boolean;
};

export type QuestionOption = {
  id: number;
  option_label: string;
  content: string;
  is_correct: boolean;
};

export type BankItem = {
  question_id: number;
  group_id?: number | null;
  stem: string;
  analysis?: string | null;
  answer_mode: 'choice' | 'true_false' | 'fill_blank' | 'short_answer';
  choice_variant?: 'single' | 'multiple' | null;
  question_type_id: string;
  question_status: string;
  options?: QuestionOption[];
};

export type PracticeSession = {
  id: number;
  bank_id: number | null;
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
  imported_questions: number;
  total_questions: number;
  overall_progress_percent?: number | null;
  last_error?: string | null;
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

export type SearchQuestion = {
  id: number;
  stem: string;
  analysis?: string | null;
  answer_mode: BankItem['answer_mode'];
  choice_variant?: BankItem['choice_variant'];
  question_type_id: string;
  status: string;
};
