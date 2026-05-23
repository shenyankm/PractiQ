import nodemailer from "nodemailer";

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
const APP_NAME = process.env.APP_NAME || "OpenWook";

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: process.env.NODE_ENV === "production",
  },
});

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(
  options: SendEmailOptions
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    return {
      success: false,
      error: "Email service is not configured. Please set SMTP_HOST, SMTP_USER, and SMTP_PASS environment variables.",
    };
  }

  try {
    const info = await transporter.sendMail({
      from: `"${APP_NAME}" <${SMTP_FROM}>`,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
    });

    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error("Failed to send email:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to send email",
    };
  }
}

export function generateVerificationEmailHtml(code: string, expiresMinutes: number): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 480px; margin: 0 auto; padding: 32px 24px; }
    .logo { font-size: 20px; font-weight: 700; color: #111; margin-bottom: 24px; }
    .code-box { background: #f4f4f5; border-radius: 8px; padding: 20px; text-align: center; margin: 20px 0; }
    .code { font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #111; font-family: ui-monospace, monospace; }
    .footer { margin-top: 24px; font-size: 12px; color: #71717a; }
    .warning { color: #dc2626; font-weight: 500; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">${APP_NAME}</div>
    <p>您好，</p>
    <p>感谢您注册 ${APP_NAME}。您的邮箱验证码如下：</p>
    <div class="code-box">
      <div class="code">${code}</div>
    </div>
    <p>此验证码将在 <strong>${expiresMinutes} 分钟</strong> 后过期，请尽快使用。</p>
    <p class="warning">如果您没有请求此验证码，请忽略此邮件。</p>
    <div class="footer">
      <p>此邮件由系统自动发送，请勿回复。</p>
    </div>
  </div>
</body>
</html>
  `;
}

export function generateVerificationEmailText(code: string, expiresMinutes: number): string {
  return `【${APP_NAME}】您的邮箱验证码是：${code}\n\n此验证码将在 ${expiresMinutes} 分钟后过期。如果您没有请求此验证码，请忽略此邮件。`;
}

export async function sendVerificationEmail(
  to: string,
  code: string,
  expiresMinutes: number = 10
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  return sendEmail({
    to,
    subject: `【${APP_NAME}】邮箱验证码`,
    html: generateVerificationEmailHtml(code, expiresMinutes),
    text: generateVerificationEmailText(code, expiresMinutes),
  });
}
