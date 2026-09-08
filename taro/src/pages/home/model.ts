import type { AnalyticsSnapshot } from "../../api/contracts";

export type HomePhase = "idle" | "loading" | "refreshing" | "ready" | "error";

export interface HomeState {
  phase: HomePhase;
  data: AnalyticsSnapshot | null;
  error: string | null;
}

export const initialHomeState: HomeState = {
  phase: "idle",
  data: null,
  error: null,
};

export function beginHomeLoad(state: HomeState): HomeState {
  return {
    ...state,
    phase: state.data ? "refreshing" : "loading",
    error: null,
  };
}

export function resolveHomeLoad(state: HomeState, data: AnalyticsSnapshot): HomeState {
  return { ...state, phase: "ready", data, error: null };
}

export function rejectHomeLoad(state: HomeState, message: string): HomeState {
  return { ...state, phase: state.data ? "ready" : "error", error: message };
}

export function isSnapshotEmpty(snapshot: AnalyticsSnapshot): boolean {
  return snapshot.recentSessions.length === 0 && snapshot.weakQuestions.length === 0;
}
