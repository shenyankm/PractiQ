import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { errorToLog, logger } from './logger';
import { getCurrentRequestId, jsonWithRequestId } from './observability';

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function responseBody(data: unknown, meta?: Record<string, unknown>, requestId?: string) {
  const resolvedMeta = {
    ...(meta ?? {}),
    ...(requestId ? { requestId } : {})
  };
  return {
    data,
    ...(Object.keys(resolvedMeta).length > 0 ? { meta: resolvedMeta } : {})
  };
}

export function ok(data: unknown, meta?: Record<string, unknown>, requestId = getCurrentRequestId()) {
  const body = responseBody(data, meta, requestId);
  return requestId ? jsonWithRequestId(body, undefined, requestId) : NextResponse.json(body);
}

export function created(data: unknown, meta?: Record<string, unknown>, requestId = getCurrentRequestId()) {
  const body = responseBody(data, meta, requestId);
  return requestId
    ? jsonWithRequestId(body, { status: 201 }, requestId)
    : NextResponse.json(body, { status: 201 });
}

export function noContent(requestId = getCurrentRequestId()) {
  const response = new NextResponse(null, { status: 204 });
  if (requestId) response.headers.set('x-request-id', requestId);
  return response;
}

function apiErrorResponse(body: unknown, status: number, requestId?: string) {
  return requestId ? jsonWithRequestId(body, { status }, requestId) : NextResponse.json(body, { status });
}

export function handleApiError(error: unknown, requestId = getCurrentRequestId()) {
  if (error instanceof ApiError) {
    return apiErrorResponse(
      {
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          ...(requestId ? { requestId } : {})
        }
      },
      error.status,
      requestId
    );
  }

  if (error instanceof ZodError) {
    return apiErrorResponse(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
          details: error.errors.map((item) => ({
            field: item.path.join('.'),
            message: item.message
          })),
          ...(requestId ? { requestId } : {})
        }
      },
      422,
      requestId
    );
  }

  logger.error({ ...errorToLog(error), requestId }, 'Unhandled API error');
  const fallbackRequestId = requestId ?? 'unknown';
  return jsonWithRequestId(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Unexpected server error',
        ...(requestId ? { requestId } : {})
      }
    },
    { status: 500 },
    fallbackRequestId
  );
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'Request body must be valid JSON');
  }
}

export function parseId(value: string | undefined, label = 'id') {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ApiError(422, 'VALIDATION_ERROR', `Invalid ${label}`);
  }
  return id;
}
