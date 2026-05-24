import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

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

export function ok(data: unknown, meta?: Record<string, unknown>) {
  return NextResponse.json({
    data,
    ...(meta ? { meta } : {})
  });
}

export function created(data: unknown, meta?: Record<string, unknown>) {
  return NextResponse.json(
    {
      data,
      ...(meta ? { meta } : {})
    },
    { status: 201 }
  );
}

export function noContent() {
  return new NextResponse(null, { status: 204 });
}

export function handleApiError(error: unknown) {
  if (error instanceof ApiError) {
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          details: error.details
        }
      },
      { status: error.status }
    );
  }

  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
          details: error.errors.map((item) => ({
            field: item.path.join('.'),
            message: item.message
          }))
        }
      },
      { status: 422 }
    );
  }

  console.error(error);
  return NextResponse.json(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Unexpected server error'
      }
    },
    { status: 500 }
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
