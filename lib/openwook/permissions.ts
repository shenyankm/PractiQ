import { ApiError } from './api';
import type { User } from './types';

type EntitlementUser = Pick<User, 'role' | 'membership' | 'plus_trial_ends_at' | 'plus_expires_at'>;

export function hasPlusEntitlement(user: EntitlementUser, now = new Date()) {
  if (user.role === 'admin') return true;
  if (user.membership === 'plus' || user.membership === 'enterprise') {
    if (!user.plus_expires_at) return true;
    return new Date(user.plus_expires_at).getTime() > now.getTime();
  }
  if (!user.plus_trial_ends_at) return false;
  return new Date(user.plus_trial_ends_at).getTime() > now.getTime();
}

export function requirePlusEntitlement(user: EntitlementUser, feature = 'This feature') {
  if (!hasPlusEntitlement(user)) {
    throw new ApiError(403, 'PLUS_REQUIRED', `${feature} requires Plus or Enterprise membership`);
  }
}

export function requireAdminRole(user: Pick<User, 'role'>) {
  if (user.role !== 'admin') {
    throw new ApiError(403, 'ADMIN_REQUIRED', 'Administrator privileges required');
  }
}

export function normalizeImportSourceType(sourceType?: string | null) {
  const normalized = String(sourceType || 'txt').trim().toLowerCase();
  if (normalized === 'text') return 'txt';
  if (normalized === 'txt' || normalized === 'docx') return normalized;
  return null;
}

export function requireImportSourceType(user: EntitlementUser, sourceType?: string | null) {
  const normalized = normalizeImportSourceType(sourceType);
  if (!normalized) {
    throw new ApiError(400, 'UNSUPPORTED_SOURCE_TYPE', 'Only txt and docx imports are supported');
  }
  if (normalized === 'docx') {
    requirePlusEntitlement(user, 'DOCX upload');
  }
  return normalized;
}
