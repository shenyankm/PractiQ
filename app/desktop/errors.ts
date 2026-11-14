export class AppError extends Error {
  constructor(readonly code: string, message: string, readonly params: Record<string, unknown> = {}) {
    super(message);
  }
  toJSON() { return { code: this.code, message: this.message, params: this.params }; }
}

export function invariant(condition: unknown, code: string, message: string, params: Record<string, unknown> = {}): asserts condition {
  if (!condition) throw new AppError(code, message, params);
}
