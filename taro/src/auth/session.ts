import type { AuthPayload, AuthTokens, User } from "../api/contracts";

export interface SessionSnapshot {
  user: User;
  tokens: AuthTokens;
}

type SessionListener = () => void;

export class MemorySessionStore {
  private generation = 0;
  private readonly resetListeners = new Set<
    (previous: SessionSnapshot | null) => void
  >();
  readonly getGeneration = (): number => this.generation;
  readonly onReset = (
    listener: (previous: SessionSnapshot | null) => void,
  ): (() => void) => {
    this.resetListeners.add(listener);
    return () => {
      this.resetListeners.delete(listener);
    };
  };
  private reset(): void {
    const previous = this.snapshot;
    this.snapshot = null;
    this.generation += 1;
    let failure: unknown;
    for (const listener of this.resetListeners) {
      try {
        listener(previous);
      } catch (error) {
        failure = error;
      }
    }
    if (failure) {
      this.emit();
      throw failure;
    } // Failed cleanup must never retain the old session or admit a new one.
  }

  private snapshot: SessionSnapshot | null = null;
  private readonly listeners = new Set<SessionListener>();

  readonly getSnapshot = (): SessionSnapshot | null => this.snapshot;

  readonly subscribe = (listener: SessionListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  replace(payload: AuthPayload): SessionSnapshot {
    this.reset();
    this.snapshot = null;
    return this.rotate(payload);
  }

  rotate(payload: AuthPayload): SessionSnapshot {
    if (this.snapshot && this.snapshot.user.id !== payload.user.id)
      throw new Error("Refresh cannot switch accounts");
    this.snapshot = {
      user: { ...payload.user },
      tokens: { ...payload.tokens },
    };
    this.emit();
    return this.snapshot;
  }

  clear(): void {
    this.reset();
    this.snapshot = null;
    this.emit();
  }

  updateUser(user: User): void {
    if (!this.snapshot || this.snapshot.user.id !== user.id) return;
    this.snapshot = { ...this.snapshot, user: { ...user } };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const sessionStore = new MemorySessionStore();
