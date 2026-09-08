let sequence = 0;
export const newWriteKey = (now = Date.now()): string =>
  `${now}-${++sequence}-${Math.random().toString(36).slice(2)}`;

// Only unresolved attempts live here. Successful or definitive failed actions never deduplicate future actions.
export class WriteAttempts {
  private readonly pending = new Map<
    string,
    { key: string; expires: number; running?: Promise<unknown> }
  >();
  constructor(private readonly now: () => number = Date.now) {}
  clear(): void {
    this.pending.clear();
  }
  forget(keys: string[]): void {
    for (const [identity, attempt] of this.pending)
      if (keys.includes(attempt.key)) this.pending.delete(identity);
  }
  run<T>(
    identity: string,
    ttl: number,
    execute: (key: string) => Promise<T>,
    retryable: (error: unknown) => boolean,
    supplied?: string,
  ): Promise<T> {
    let attempt = this.pending.get(identity);
    if (attempt && attempt.expires <= this.now() && !attempt.running) {
      this.pending.delete(identity);
      attempt = undefined;
    }
    if (!attempt) {
      attempt = {
        key: supplied ?? newWriteKey(this.now()),
        expires: this.now() + ttl,
      };
      this.pending.set(identity, attempt);
    }
    if (attempt.running) return attempt.running as Promise<T>;
    const current = attempt;
    const promise = execute(current.key)
      .then(
        (value) => {
          if (this.pending.get(identity) === current)
            this.pending.delete(identity);
          return value;
        },
        (error: unknown) => {
          if (!retryable(error) && this.pending.get(identity) === current)
            this.pending.delete(identity);
          throw error;
        },
      )
      .finally(() => {
        if (current.running === promise) current.running = undefined;
      });
    current.running = promise;
    return promise;
  }
}
