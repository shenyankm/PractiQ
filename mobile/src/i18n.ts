export type Language = 'en' | 'zh-CN';

const englishDateFormatter = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const englishDayFormatter = new Intl.DateTimeFormat('en', {
  month: 'numeric',
  day: 'numeric',
});
const percentFormatters: Record<Language, Intl.NumberFormat> = {
  en: new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 0 }),
  'zh-CN': new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 0 }),
};

export function normalizeLanguage(value: unknown): Language {
  return value === 'zh-CN' ? 'zh-CN' : 'en';
}

export function systemLanguage(locale = Intl.DateTimeFormat().resolvedOptions().locale): Language {
  return /^zh(?:-|_|$)/i.test(locale) ? 'zh-CN' : 'en';
}

export function translate(language: Language, english: string, simplifiedChinese: string) {
  return language === 'zh-CN' ? simplifiedChinese : english;
}

export const formatDate = (value: string | number | Date, language: Language) => {
  const normalized = typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return '—';
  if (language === 'zh-CN') {
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    return `${date.getMonth() + 1}月${date.getDate()}日 ${hour}:${minute}`;
  }
  return englishDateFormatter.format(date);
};

export const formatPercent = (value: number, language: Language) =>
  percentFormatters[language].format(Number.isFinite(value) ? value : 0);

export const formatDay = (value: string, language: Language) => {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return '—';
  return language === 'zh-CN'
    ? `${month}月${day}日`
    : englishDayFormatter.format(new Date(year, month - 1, day));
};

export function questionTypeLabel(code: string, language: Language) {
  const labels: Record<string, [string, string]> = {
    single_choice: ['Single choice', '单选题'],
    multiple_choice: ['Multiple choice', '多选题'],
    true_false: ['True or false', '判断题'],
    fill_blank: ['Fill in the blank', '填空题'],
    short_answer: ['Short answer', '简答题'],
  };
  const label = labels[code];
  return label ? translate(language, label[0], label[1]) : code;
}

export function importStatusLabel(
  status: 'queued' | 'running' | 'retry_wait' | 'completed' | 'failed' | 'cancelled',
  language: Language,
) {
  const labels = {
    queued: ['Queued', '等待处理'],
    running: ['Processing', '处理中'],
    retry_wait: ['Waiting to retry', '等待重试'],
    completed: ['Completed', '已完成'],
    failed: ['Failed', '失败'],
    cancelled: ['Cancelled', '已取消'],
  } as const;
  const [english, simplifiedChinese] = labels[status];
  return translate(language, english, simplifiedChinese);
}

export function importStatusText(value: string, language: Language): string {
  const coded: Record<string, [string, string]> = {
    'stage:queued': ['Waiting', '等待处理'],
    'stage:waiting_ai': ['Waiting for AI parsing', '等待 AI 解析'],
    'stage:validating_file': ['Validating sandbox file', '正在验证沙盒文件'],
    'stage:reading_docx': ['Extracting DOCX content', '正在提取 DOCX 内容'],
    'stage:reading_txt': ['Reading TXT content', '正在读取 TXT 内容'],
    'stage:waiting_ai_service': ['Waiting for the AI service', '正在等待 AI 服务解析'],
    'stage:recognizing_questions': ['Identifying question structure', '正在识别题目结构'],
    'stage:cancelled': ['Cancelled', '已取消'],
    'stage:failed': ['Import failed', '导入失败'],
    'stage:manual_retry': ['Waiting for manual retry', '等待手动重试'],
    'stage:interrupted': ['Interrupted when the app last exited', '应用上次处理中断'],
    'stage:restore_ai_confirmation': ['AI transfer must be confirmed again after restore', '恢复后需要重新确认 AI 传输'],
    'error:interrupted': ['The app exited during import. Try again.', '应用在导入期间退出，请重试'],
    'error:restore_ai_confirmation': [
      'Retry manually and confirm the recipient and content after restoring a backup.',
      '备份恢复后请手动重试并重新确认接收方与发送内容',
    ],
  };
  const codedLabel = coded[value];
  if (codedLabel) return translate(language, codedLabel[0], codedLabel[1]);
  const parameterized = value.match(/^stage:(writing|completed|retry_wait):(\d+)$/);
  if (parameterized) {
    const count = Number(parameterized[2]);
    if (parameterized[1] === 'writing') {
      return translate(language, `Writing ${count} questions`, `正在写入 ${count} 道题`);
    }
    if (parameterized[1] === 'completed') {
      return translate(language, `Imported ${count} questions`, `已导入 ${count} 道题`);
    }
    return translate(
      language,
      `Failed; retrying in ${count} seconds`,
      `失败，${count} 秒后重试`,
    );
  }
  if (language === 'zh-CN') return value;
  if (/\p{Script=Han}/u.test(value)) return 'Import failed. Check the source file and try again.';
  return value;
}
