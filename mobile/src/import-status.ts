export const IMPORT_STAGE = {
  queued: 'stage:queued',
  waitingAi: 'stage:waiting_ai',
  validatingFile: 'stage:validating_file',
  readingDocx: 'stage:reading_docx',
  readingTxt: 'stage:reading_txt',
  waitingAiService: 'stage:waiting_ai_service',
  recognizingQuestions: 'stage:recognizing_questions',
  cancelled: 'stage:cancelled',
  failed: 'stage:failed',
  manualRetry: 'stage:manual_retry',
  interrupted: 'stage:interrupted',
  restoreAiConfirmation: 'stage:restore_ai_confirmation',
} as const;

export const importWritingStage = (questionCount: number) => `stage:writing:${questionCount}`;
export const importCompletedStage = (questionCount: number) => `stage:completed:${questionCount}`;
export const importRetryStage = (delaySeconds: number) => `stage:retry_wait:${delaySeconds}`;
