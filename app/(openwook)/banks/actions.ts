'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { comparePasswords, getUserPasswordById, hashPassword } from '@/lib/openwook/auth';
import { requireServerActionUser } from '@/lib/openwook/server-action-auth';
import { inferImportSourceType, isUploadedFile, storeAvatarFile } from '@/lib/openwook/object-storage';
import type { AnswerMode } from '@/lib/openwook/types';
import {
  addImportJobUploadedFile,
  completePracticeSession,
  createBank,
  createImportJob,
  createQuestion,
  resolveImportReviewItem,
  setFavorite,
  startPracticeSession,
  submitAnswer,
  updateCurrentUser,
  updateImportJobStatus,
  updateQuestion
} from '@/lib/openwook/services';

const answerModes = ['choice', 'true_false', 'fill_blank', 'short_answer'] as const;
const questionStatuses = ['draft', 'active', 'archived'] as const;
const sessionTypes = ['practice', 'review', 'exam'] as const;
const practiceModes = ['all', 'wrong', 'by_type', 'exam'] as const;

export type SettingsActionState = {
  error?: string;
  success?: string;
  email?: string;
  username?: string;
};


export async function createBankAction(formData: FormData) {
  const user = await requireServerActionUser();

  const bank = await createBank(user, {
    name: String(formData.get('name') || ''),
    description: String(formData.get('description') || '') || null,
    subject: String(formData.get('subject') || 'general'),
    isPublic: formData.get('isPublic') === 'on'
  });
  redirect(`/banks/${bank.id}`);
}

export async function createQuestionAction(bankId: number, formData: FormData) {
  const user = await requireServerActionUser();

  const answerMode = pickEnum(formData.get('answerMode'), answerModes, 'short_answer');
  const optionA = String(formData.get('optionA') || '');
  const optionB = String(formData.get('optionB') || '');
  const optionC = String(formData.get('optionC') || '');
  const optionD = String(formData.get('optionD') || '');
  const correct = String(formData.get('correctOption') || formData.get('answer') || 'A');
  const options = answerMode === 'choice'
    ? [
        { label: 'A', content: optionA || '选项 A', isCorrect: correct === 'A' },
        { label: 'B', content: optionB || '选项 B', isCorrect: correct === 'B' },
        ...(optionC ? [{ label: 'C', content: optionC, isCorrect: correct === 'C' }] : []),
        ...(optionD ? [{ label: 'D', content: optionD, isCorrect: correct === 'D' }] : [])
      ]
    : undefined;

  await createQuestion(user, bankId, {
    questionTypeId: String(formData.get('questionTypeId') || 'generic_answer_mode'),
    answerMode,
    stem: String(formData.get('stem') || ''),
    analysis: String(formData.get('analysis') || '') || null,
    choiceVariant: answerMode === 'choice' ? 'single' : null,
    status: pickEnum(formData.get('status'), questionStatuses, 'draft'),
    options,
    answerPayload: buildAnswerPayload(answerMode, correct, formData)
  });
  redirect(`/banks/${bankId}/manage`);
}

function buildAnswerPayload(answerMode: AnswerMode, correct: string, formData: FormData) {
  if (answerMode === 'choice') return { selected: [correct] };
  if (answerMode === 'true_false') return { value: String(formData.get('answer') || 'true') === 'true' };
  return { value: String(formData.get('answer') || '') };
}

export async function updateQuestionAction(bankId: number, questionId: number, formData: FormData) {
  const user = await requireServerActionUser();

  await updateQuestion(user, questionId, {
    stem: String(formData.get('stem') || ''),
    analysis: String(formData.get('analysis') || '') || null,
    status: String(formData.get('status') || 'draft')
  });
  revalidatePath(`/banks/${bankId}/manage`);
}

export async function favoriteBankAction(bankId: number, favorite: boolean) {
  const user = await requireServerActionUser();
  await setFavorite(user, bankId, favorite);
  revalidatePath(`/banks/${bankId}`);
  revalidatePath('/banks');
}

export async function startPracticeAction(bankId: number, formData: FormData) {
  const user = await requireServerActionUser();
  const mode = pickEnum(formData.get('mode'), practiceModes, 'all');
  const allQuestions = formData.get('allQuestions') === 'on' || mode === 'all' && !formData.get('questionCount');
  const questionTypeId = String(formData.get('questionTypeId') || '');
  const session = await startPracticeSession(user, {
    bankId,
    sessionType: mode === 'exam' ? 'exam' : mode === 'wrong' ? 'review' : pickEnum(formData.get('sessionType'), sessionTypes, 'practice'),
    questionCount: Number(formData.get('questionCount') || 10),
    mode,
    questionTypeId: questionTypeId && questionTypeId !== 'all' ? questionTypeId : null,
    allQuestions
  });
  redirect(`/practice/${session.id}`);
}

export async function submitPracticeAnswerAction(sessionId: number, questionId: number, answerMode: string, formData: FormData) {
  const user = await requireServerActionUser();

  await submitAnswer(user, sessionId, {
    questionId,
    answerPayload: buildSubmittedAnswer(answerMode, formData),
    durationMs: Number(formData.get('durationMs') || 0)
  });
  revalidatePath(`/practice/${sessionId}`);
}

function buildSubmittedAnswer(answerMode: string, formData: FormData) {
  if (answerMode === 'choice') return { selected: formData.getAll('selected').map(String) };
  if (answerMode === 'true_false') {
    const value = formData.get('value');
    return value === null ? {} : { value: String(value) === 'true' };
  }
  return { value: String(formData.get('value') || '') };
}

export async function completePracticeAction(sessionId: number) {
  const user = await requireServerActionUser();
  await completePracticeSession(user, sessionId, 'completed');
  revalidatePath(`/practice/${sessionId}`);
}

export async function abandonPracticeAction(sessionId: number) {
  const user = await requireServerActionUser();
  await completePracticeSession(user, sessionId, 'abandoned');
  redirect('/dashboard');
}

export async function createImportJobAction(formData: FormData) {
  const user = await requireServerActionUser();
  const bankIdValue = String(formData.get('bankId') || '');
  const sourceFile = formData.get('sourceFile');
  const hasSourceFile = isUploadedFile(sourceFile);
  const uploadedSourceType = hasSourceFile ? inferImportSourceType(sourceFile) : null;
  if (!hasSourceFile) {
    throw new Error('Please upload a TXT or DOCX source file before creating an import job.');
  }
  if (uploadedSourceType === 'unknown') {
    throw new Error('Only TXT and DOCX import source files are supported.');
  }
  const job = await createImportJob(user, {
    bankId: bankIdValue ? Number(bankIdValue) : null,
    fileName: hasSourceFile ? sourceFile.name : String(formData.get('fileName') || '') || null,
    sourceType: hasSourceFile ? uploadedSourceType : String(formData.get('sourceType') || '') || null,
    requestPayload: {
      parseMode: String(formData.get('parseMode') || 'layout'),
      defaultQuestionTypeId: String(formData.get('defaultQuestionTypeId') || '')
    }
  });
  if (hasSourceFile) {
    await addImportJobUploadedFile(user, job.id, sourceFile);
  }
  redirect(`/imports/${job.id}`);
}

export async function updateImportStatusAction(jobId: number, action: 'start' | 'retry' | 'cancel') {
  const user = await requireServerActionUser();
  await updateImportJobStatus(user, jobId, action);
  revalidatePath(`/imports/${jobId}`);
  revalidatePath('/imports');
}

export async function resolveReviewItemAction(jobId: number, itemId: number, formData: FormData) {
  const user = await requireServerActionUser();
  await resolveImportReviewItem(user, jobId, itemId, String(formData.get('note') || '') || null);
  revalidatePath(`/imports/${jobId}`);
}

export async function updateProfileAction(_prevState: SettingsActionState, formData: FormData): Promise<SettingsActionState> {
  const user = await requireServerActionUser();
  const username = String(formData.get('username') || '') || undefined;
  const email = String(formData.get('email') || '') || null;

  try {
    const avatarFile = formData.get('avatar');
    const avatarUrl = isUploadedFile(avatarFile)
      ? (await storeAvatarFile(user.id, avatarFile)).objectUrl
      : undefined;
    await updateCurrentUser(user, {
      username,
      email,
      avatarUrl
    });
    revalidatePath('/settings');
    return {
      success: '设置已保存。',
      email: email ?? '',
      username: username ?? user.username
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : '保存失败，请稍后重试。',
      email: email ?? '',
      username: username ?? user.username
    };
  }
}

export async function updatePasswordAction(_prevState: SettingsActionState, formData: FormData): Promise<SettingsActionState> {
  const user = await requireServerActionUser();
  const currentPassword = String(formData.get('currentPassword') || '');
  const password = String(formData.get('password') || '');
  const confirmPassword = String(formData.get('confirmPassword') || '');

  if (password.length < 8 || password.length > 100) {
    return { error: '新密码长度必须在 8 到 100 位之间。' };
  }
  if (password !== confirmPassword) {
    return { error: '两次输入的新密码不一致。' };
  }

  const found = await getUserPasswordById(user.id);
  if (!found?.passwordHash || !(await comparePasswords(currentPassword, found.passwordHash))) {
    return { error: '当前密码不正确。' };
  }

  await updateCurrentUser(user, {
    passwordHash: await hashPassword(password)
  });
  revalidatePath('/settings');
  return { success: '密码已更新。' };
}

function pickEnum<T extends readonly string[]>(value: FormDataEntryValue | null, allowed: T, fallback: T[number]) {
  const stringValue = String(value || '');
  return (allowed as readonly string[]).includes(stringValue) ? stringValue as T[number] : fallback;
}
