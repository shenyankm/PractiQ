export * from "../../shared/cloud/test-fixtures";

import type { AdministrationUser, AdministrationUserDetail } from "./contracts.generated";
export function adminUserDetail(user: Partial<AdministrationUser> = {}): AdministrationUserDetail {
  return { user: { id: "alice", email: "alice@example.test", name: "Alice", enabled: true, role: "user", limits: { freePages: 50 }, created_at: "2026-11-09T00:00:00Z", ...user }, balance: { plan: "free", expiresAt: null, activeTasks: 1, freePages: 50, freeUsedPages: 7, freeRemainingPages: 43, remainingPages: 43, grants: [] }, limits: { freePages: 50, modelCalls: 1000, tencentCalls: 50, activeTasks: 1 }, settledPages: 0, heldPages: 7, unknownPages: 7, activeSessions: 1, activeTokens: 0 };
}
