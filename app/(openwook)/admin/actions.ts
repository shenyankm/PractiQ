'use server';

import { revalidatePath } from 'next/cache';
import { requireServerActionUser } from '@/lib/openwook/server-action-auth';
import {
  createKnowledgePoint,
  setUserStatus,
  updateUserAccess,
  updateKnowledgePoint
} from '@/lib/openwook/services';

async function requireAdminAction() {
  const user = await requireServerActionUser();
  if (user.role !== 'admin') {
    throw new Error('Administrator privileges required');
  }

  return user;
}

export async function setUserStatusAction(targetUserId: number, isActive: boolean) {
  const user = await requireAdminAction();
  await setUserStatus(user, targetUserId, isActive);
  revalidatePath('/admin/users');
  revalidatePath('/admin');
}

export async function updateUserAccessAction(targetUserId: number, formData: FormData) {
  const user = await requireAdminAction();
  await updateUserAccess(user, targetUserId, {
    role: pickEnum(formData.get('role'), ['admin', 'user'] as const),
    membership: pickEnum(formData.get('membership'), ['free', 'plus'] as const)
  });
  revalidatePath('/admin/users');
  revalidatePath('/admin');
}

export async function createKnowledgePointAction(formData: FormData) {
  const user = await requireAdminAction();
  await createKnowledgePoint(user, {
    subjectId: String(formData.get('subjectId') || ''),
    code: String(formData.get('code') || ''),
    displayName: String(formData.get('displayName') || ''),
    parentId: parseOptionalNumber(formData.get('parentId')),
    metadata: parseMetadata(formData.get('metadata'))
  });
  revalidatePath('/admin/knowledge-points');
  revalidatePath('/admin');
}

export async function updateKnowledgePointAction(id: number, formData: FormData) {
  const user = await requireAdminAction();
  await updateKnowledgePoint(user, id, {
    code: stringOrUndefined(formData.get('code')),
    displayName: stringOrUndefined(formData.get('displayName')),
    parentId: parseOptionalNumber(formData.get('parentId')),
    metadata: parseMetadata(formData.get('metadata'))
  });
  revalidatePath('/admin/knowledge-points');
}

function stringOrUndefined(value: FormDataEntryValue | null) {
  const text = String(value || '').trim();
  return text || undefined;
}

function pickEnum<T extends readonly string[]>(value: FormDataEntryValue | null, allowed: T) {
  const text = String(value || '');
  return allowed.includes(text) ? text as T[number] : undefined;
}

function parseOptionalNumber(value: FormDataEntryValue | null) {
  const text = String(value || '').trim();
  if (!text) return null;
  const number = Number(text);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function parseMetadata(value: FormDataEntryValue | null) {
  const text = String(value || '').trim();
  if (!text) return {};

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return { note: text };
  }
}
