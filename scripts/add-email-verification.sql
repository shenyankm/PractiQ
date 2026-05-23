-- Email Verification Codes Table
-- Add this to your database to support email verification during registration

CREATE TABLE IF NOT EXISTS email_verification_codes (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    code VARCHAR(6) NOT NULL,
    purpose VARCHAR(32) NOT NULL DEFAULT 'register',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    used_at TIMESTAMP WITH TIME ZONE,
    is_used BOOLEAN NOT NULL DEFAULT FALSE,
    ip_address VARCHAR(45),
    CONSTRAINT chk_email_verification_codes_attempts_nonnegative CHECK (attempts >= 0),
    CONSTRAINT chk_email_verification_codes_max_attempts CHECK (max_attempts > 0)
);

CREATE INDEX idx_email_verification_codes_email_purpose 
    ON email_verification_codes (email, purpose, created_at DESC);
CREATE INDEX idx_email_verification_codes_expires_at 
    ON email_verification_codes (expires_at) WHERE is_used = FALSE;

COMMENT ON TABLE email_verification_codes IS '邮箱验证码表';
COMMENT ON COLUMN email_verification_codes.email IS '目标邮箱地址';
COMMENT ON COLUMN email_verification_codes.code IS '6位数字验证码';
COMMENT ON COLUMN email_verification_codes.purpose IS '用途：register / reset_password';
COMMENT ON COLUMN email_verification_codes.attempts IS '已尝试验证次数';
COMMENT ON COLUMN email_verification_codes.max_attempts IS '最大允许尝试次数';
COMMENT ON COLUMN email_verification_codes.expires_at IS '验证码过期时间';
COMMENT ON COLUMN email_verification_codes.used_at IS '验证码使用时间';
COMMENT ON COLUMN email_verification_codes.is_used IS '是否已使用';
COMMENT ON COLUMN email_verification_codes.ip_address IS '请求者IP地址（用于限流）';
