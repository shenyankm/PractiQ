'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getCurrentUser, hashPassword } from '@/lib/openwook/auth';
import type { AnswerMode } from '@/lib/openwook/types';
import {
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

export async function createBankAction(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');

  const bank = await createBank(user, {
    name: String(formData.get('name') || ''),
    description: String(formData.get('description') || '') || null,
    subject: String(formData.get('subject') || 'general'),
    isPublic: formData.get('isPublic') === 'on'
  });
  redirect(`/banks/${bank.id}`);
}

export async function createQuestionAction(bankId: number, formData: FormData) {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');

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
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');

  await updateQuestion(user, questionId, {
    stem: String(formData.get('stem') || ''),
    analysis: String(formData.get('analysis') || '') || null,
    status: String(formData.get('status') || 'draft')
  });
  revalidatePath(`/banks/${bankId}/manage`);
}

export async function favoriteBankAction(bankId: number, favorite: boolean) {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');
  await setFavorite(user, bankId, favorite);
  revalidatePath(`/banks/${bankId}`);
  revalidatePath('/banks');
}

export async function startPracticeAction(bankId: number, formData: FormData) {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');
  const session = await startPracticeSession(user, {
    bankId,
    sessionType: pickEnum(formData.get('sessionType'), sessionTypes, 'practice'),
    questionCount: Number(formData.get('questionCount') || 10)
  });
  redirect(`/practice/${session.id}`);
}

export async function submitPracticeAnswerAction(sessionId: number, questionId: number, answerMode: string, formData: FormData) {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');

  await submitAnswer(user, sessionId, {
    questionId,
    answerPayload: buildSubmittedAnswer(answerMode, formData),
    durationMs: Number(formData.get('durationMs') || 0)
  });
  revalidatePath(`/practice/${sessionId}`);
}

function buildSubmittedAnswer(answerMode: string, formData: FormData) {
  if (answerMode === 'choice') return { selected: formData.getAll('selected').map(String) };
  if (answerMode === 'true_false') return { value: String(formData.get('value') || 'false') === 'true' };
  return { value: String(formData.get('value') || '') };
}

export async function completePracticeAction(sessionId: number) {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');
  await completePracticeSession(user, sessionId, 'completed');
  revalidatePath(`/practice/${sessionId}`);
}

export async function abandonPracticeAction(sessionId: number) {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');
  await completePracticeSession(user, sessionId, 'abandoned');
  redirect('/dashboard');
}

export async function createImportJobAction(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');
  const bankIdValue = String(formData.get('bankId') || '');
  const job = await createImportJob(user, {
    bankId: bankIdValue ? Number(bankIdValue) : null,
    fileName: String(formData.get('fileName') || '') || null,
    sourceType: String(formData.get('sourceType') || '') || null,
    requestPayload: {
      parseMode: String(formData.get('parseMode') || 'layout'),
      defaultQuestionTypeId: String(formData.get('defaultQuestionTypeId') || '')
    }
  });
  redirect(`/imports/${job.id}`);
}

export async function updateImportStatusAction(jobId: number, action: 'start' | 'retry' | 'cancel') {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');
  await updateImportJobStatus(user, jobId, action);
  revalidatePath(`/imports/${jobId}`);
  revalidatePath('/imports');
}

export async function resolveReviewItemAction(jobId: number, itemId: number, formData: FormData) {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');
  await resolveImportReviewItem(user, jobId, itemId, String(formData.get('note') || '') || null);
  revalidatePath(`/imports/${jobId}`);
}

export async function updateProfileAction(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');
  const password = String(formData.get('password') || '');
  await updateCurrentUser(user, {
    username: String(formData.get('username') || '') || undefined,
    email: String(formData.get('email') || '') || null,
    passwordHash: password ? await hashPassword(password) : undefined
  });
  revalidatePath('/settings');
}

function pickEnum<T extends readonly string[]>(value: FormDataEntryValue | null, allowed: T, fallback: T[number]) {
  const stringValue = String(value || '');
  return (allowed as readonly string[]).includes(stringValue) ? stringValue as T[number] : fallback;
}
