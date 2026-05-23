import { query } from "@/lib/db";
import type { EmailVerificationCode } from "@/lib/types";

export const VERIFICATION_CODE_LENGTH = 6;
export const VERIFICATION_CODE_EXPIRY_MINUTES = 10;
export const VERIFICATION_MAX_ATTEMPTS = 5;
export const VERIFICATION_RATE_LIMIT_MINUTES = 1;
export const VERIFICATION_DAILY_LIMIT = 10;

export function generateVerificationCode(): string {
  const min = 100000;
  const max = 999999;
  return Math.floor(Math.random() * (max - min + 1) + min).toString();
}

export async function createVerificationCode(
  email: string,
  purpose: string = "register",
  ipAddress?: string
): Promise<{ success: boolean; code?: string; error?: string }> {
  const normalizedEmail = email.toLowerCase().trim();

  // Rate limit: check if a code was sent recently
  const { rows: recentRows } = await query<{ count: string }>(
    `SELECT COUNT(*) as count 
     FROM email_verification_codes 
     WHERE email = $1 
       AND purpose = $2 
       AND created_at > NOW() - INTERVAL '${VERIFICATION_RATE_LIMIT_MINUTES} minutes'`,
    [normalizedEmail, purpose]
  );

  if (parseInt(recentRows[0].count, 10) > 0) {
    return {
      success: false,
      error: `Please wait ${VERIFICATION_RATE_LIMIT_MINUTES} minute(s) before requesting a new code.`,
    };
  }

  // Daily limit check
  const { rows: dailyRows } = await query<{ count: string }>(
    `SELECT COUNT(*) as count 
     FROM email_verification_codes 
     WHERE email = $1 
       AND purpose = $2 
       AND created_at > NOW() - INTERVAL '24 hours'`,
    [normalizedEmail, purpose]
  );

  if (parseInt(dailyRows[0].count, 10) >= VERIFICATION_DAILY_LIMIT) {
    return {
      success: false,
      error: "Daily verification code limit reached. Please try again tomorrow.",
    };
  }

  const code = generateVerificationCode();
  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + VERIFICATION_CODE_EXPIRY_MINUTES);

  await query(
    `INSERT INTO email_verification_codes 
     (email, code, purpose, max_attempts, expires_at, ip_address) 
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [normalizedEmail, code, purpose, VERIFICATION_MAX_ATTEMPTS, expiresAt.toISOString(), ipAddress || null]
  );

  return { success: true, code };
}

export async function validateVerificationCode(
  email: string,
  code: string,
  purpose: string = "register"
): Promise<{ success: boolean; error?: string }> {
  const normalizedEmail = email.toLowerCase().trim();
  const normalizedCode = code.trim();

  const { rows } = await query<EmailVerificationCode>(
    `SELECT * FROM email_verification_codes 
     WHERE email = $1 
       AND purpose = $2 
       AND is_used = FALSE 
     ORDER BY created_at DESC 
     LIMIT 1`,
    [normalizedEmail, purpose]
  );

  if (rows.length === 0) {
    return { success: false, error: "No valid verification code found. Please request a new one." };
  }

  const record = rows[0];

  // Check if expired
  if (new Date(record.expires_at) < new Date()) {
    return { success: false, error: "Verification code has expired. Please request a new one." };
  }

  // Check max attempts
  if (record.attempts >= record.max_attempts) {
    return { success: false, error: "Too many failed attempts. Please request a new code." };
  }

  // Increment attempts
  await query(
    `UPDATE email_verification_codes 
     SET attempts = attempts + 1 
     WHERE id = $1`,
    [record.id]
  );

  // Verify code
  if (record.code !== normalizedCode) {
    const remainingAttempts = record.max_attempts - (record.attempts + 1);
    if (remainingAttempts <= 0) {
      return { success: false, error: "Too many failed attempts. Please request a new code." };
    }
    return {
      success: false,
      error: `Invalid verification code. ${remainingAttempts} attempt(s) remaining.`,
    };
  }

  // Mark as used
  await query(
    `UPDATE email_verification_codes 
     SET is_used = TRUE, used_at = NOW() 
     WHERE id = $1`,
    [record.id]
  );

  return { success: true };
}

export async function cleanupExpiredCodes(): Promise<void> {
  await query(
    `DELETE FROM email_verification_codes 
     WHERE expires_at < NOW() - INTERVAL '7 days'`
  );
}
