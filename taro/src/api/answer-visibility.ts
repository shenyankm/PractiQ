import type { PracticeSession } from "./modules";

export function feedbackVisible(session: PracticeSession | null, answered: boolean): boolean {
  if (!session) return false;
  return session.session_type === "exam" || session.mode === "exam" ? session.status === "completed" : answered;
}
export function correctnessLabel(value?: boolean | null): string {
  return value === true ? "正确" : value === false ? "错误" : "待公布";
}
