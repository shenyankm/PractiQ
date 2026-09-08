import type { SessionSnapshot } from "./session";

export function requiresLogin(session: SessionSnapshot | null): boolean {
  return session === null;
}
