import 'server-only';

import pino, { type Logger, type LoggerOptions } from 'pino';

const redactPaths = [
  'password',
  'passwordHash',
  '*.password',
  '*.passwordHash',
  'body.password',
  'body.passwordHash',
  'body.fileBase64',
  'fileBase64',
  'authorization',
  'headers.authorization',
  'headers.cookie',
  'headers.set-cookie',
  'cookie',
  'set-cookie',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'secret',
  'privateKey',
  'alipayPrivateKey',
  'MOONSHOT_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY'
];

const loggerOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  base: {
    service: process.env.OTEL_SERVICE_NAME || 'openwook',
    env: process.env.NODE_ENV || 'development'
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: redactPaths,
    censor: '[Redacted]'
  },
  serializers: {
    err: pino.stdSerializers.err
  }
};

export const logger = pino(loggerOptions);

export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}

export function errorToLog(error: unknown) {
  if (error instanceof Error) return { err: error };
  return { err: { message: String(error) } };
}

export function safePublicErrorMessage(_error: unknown, fallback = '操作失败，请稍后重试。') {
  return fallback;
}

