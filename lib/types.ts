export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface User {
  id: number;
  name: string;
  email: string;
  created_at: string;
}

export interface CreateUserRequest {
  name: string;
  email: string;
  verificationCode: string;
}

export interface HealthCheck {
  status: string;
  timestamp: string;
  database: boolean;
  version: string;
}

// Email Verification Types
export interface EmailVerificationCode {
  id: number;
  email: string;
  code: string;
  purpose: string;
  attempts: number;
  max_attempts: number;
  expires_at: string;
  created_at: string;
  used_at: string | null;
  is_used: boolean;
  ip_address: string | null;
}

export interface SendVerificationRequest {
  email: string;
  purpose?: string;
}

export interface VerifyCodeRequest {
  email: string;
  code: string;
  purpose?: string;
}

export type VerificationPurpose = 'register' | 'reset_password';
