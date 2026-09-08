import type { AuthPayload, Bank } from "../src/api/contracts";

export function authPayload(
  accessToken = "access-1",
  refreshToken = "refresh-1",
  accessExpiresAt = "2030-01-01T00:10:00.000Z",
  refreshExpiresAt = "2030-02-01T00:00:00.000Z",
): AuthPayload {
  return {
    user: {
      id: 7,
      displayName: "练习者",
      avatarUrl: null,
      status: "active",
      role: "user",
      effectiveMembership: "free",
      paidPro: false,
      trialEndsAt: null,
      paidProAt: null,
      creditBalance: 0,
    },
    tokens: {
      accessToken,
      refreshToken,
      expiresAt: accessExpiresAt,
      refreshExpiresAt,
      tokenType: "Bearer",
    },
  };
}

export function bank(id: number, name = `题库 ${id}`): Bank {
  return {
    id,
    subject_id: "general",
    name,
    description: null,
    status: "private",
    created_at: "2030-01-01T00:00:00Z",
    updated_at: "2030-01-01T00:00:00Z",
    is_owner: true,
    is_favorite: false,
  };
}
