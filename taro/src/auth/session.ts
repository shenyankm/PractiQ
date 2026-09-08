import type { AuthPayload, AuthTokens, User } from "../api/contracts";

export interface SessionSnapshot {
  user: User;
  tokens: AuthTokens;
}

type SessionListener = () => void;

export class MemorySessionStore {
  private snapshot: SessionSnapshot | null = null;
  private readonly listeners = new Set<SessionListener>();

  readonly getSnapshot = (): SessionSnapshot | null => this.snapshot;

  readonly subscribe = (listener: SessionListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  replace(payload: AuthPayload): SessionSnapshot {
    this.snapshot = {
      user: { ...payload.user },
      tokens: { ...payload.tokens },
    };
    this.emit();
    return this.snapshot;
  }

  clear(): void {
    if (this.snapshot === null) {
      return;
    }
    this.snapshot = null;
    this.emit();
  }

  updateUser(user: User): void {
    if (!this.snapshot) return;
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
