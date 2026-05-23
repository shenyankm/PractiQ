-- OpenWook Database Schema
-- Run this script to initialize the database

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Email verification codes table (required for email verification during registration)
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

CREATE INDEX IF NOT EXISTS idx_email_verification_codes_email_purpose 
    ON email_verification_codes (email, purpose, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_verification_codes_expires_at 
    ON email_verification_codes (expires_at) WHERE is_used = FALSE;

-- Insert sample data
INSERT INTO users (name, email) VALUES
    ('Alice Johnson', 'alice@example.com'),
    ('Bob Smith', 'bob@example.com'),
    ('Charlie Brown', 'charlie@example.com')
ON CONFLICT (email) DO NOTHING;
