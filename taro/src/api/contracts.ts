export interface ApiEnvelope<T> {
  data: T;
  meta?: {
    pagination?: Pagination;
    [key: string]: unknown;
  } | null;
}

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string | null;
  };
}

export interface User {
  id: number;
  displayName: string | null;
  avatarUrl: string | null;
  status: "active" | "inactive";
  role: "user" | "admin";
  effectiveMembership: string;
  paidPro: boolean;
  trialEndsAt: string | null;
  paidProAt: string | null;
  creditBalance: number | string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  refreshExpiresAt: string;
  tokenType: "Bearer";
}

export interface AuthPayload {
  user: User;
  tokens: AuthTokens;
}

export interface AnalyticsSummary {
  owned_banks: number;
  favorite_banks: number;
  attempts: number;
  correct: number;
  wrong: number;
  sessions: number;
  active_sessions: number;
  active_imports: number;
  accuracy: number;
}

export interface RecentSession {
  id: number;
  user_id: number;
  bank_id: number;
  session_type: string;
  status: string;
  question_count: number;
  answered_count: number;
  correct_count: number;
  wrong_count: number;
  started_at: string;
  completed_at: string | null;
}

export interface WeakQuestion {
  question_id: number;
  attempt_count: number;
  correct_count: number;
  wrong_count: number;
  mastery_score: number | string;
  stem: string;
  question_type_id: string;
}

export interface AnalyticsSnapshot {
  summary: AnalyticsSummary;
  recentSessions: RecentSession[];
  weakQuestions: WeakQuestion[];
}

export type BankScope = "mine" | "favorites";

export interface Bank {
  id: number;
  subject_id: string;
  name: string;
  description: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  is_owner: boolean;
  is_favorite: boolean;
}

export interface Pagination {
  cursor: string;
  limit: number;
  hasMore: boolean;
}

export interface BankPage {
  items: Bank[];
  pagination: Pagination;
}
