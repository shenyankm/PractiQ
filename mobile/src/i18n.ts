import * as OpenCC from 'opencc-js/cn2t';

export type Language = 'en' | 'zh-CN' | 'zh-TW' | 'ja';

const LANGUAGES: readonly Language[] = ['en', 'zh-CN', 'zh-TW', 'ja'];

// ponytail: zh-TW is derived from zh-CN at runtime (character/variant level, no
// Taiwan vocabulary swaps); add an override dictionary if wording complaints show up.
const toTraditional = OpenCC.Converter({ from: 'cn', to: 'tw' });

// ponytail: Japanese is looked up by the English source string and falls back to
// English for anything untranslated; grow this dictionary as strings get translated.
const JAPANESE: Record<string, string> = {
  'Single choice': '単一選択',
  'Multiple choice': '複数選択',
  'True or false': '正誤問題',
  'Fill in the blank': '穴埋め問題',
  'Short answer': '記述式',
  Queued: '待機中',
  Processing: '処理中',
  'Waiting to retry': '再試行待ち',
  Completed: '完了',
  Failed: '失敗',
  Cancelled: 'キャンセル済み',
  Waiting: '待機中',
  'Waiting for AI parsing': 'AI 解析待ち',
  'Validating sandbox file': 'サンドボックスファイルを検証中',
  'Extracting DOCX content': 'DOCX の内容を抽出中',
  'Reading TXT content': 'TXT の内容を読み込み中',
  'Waiting for the AI service': 'AI サービスの応答を待機中',
  'Identifying question structure': '問題構造を認識中',
  'Import failed': 'インポート失敗',
  'Waiting for manual retry': '手動再試行待ち',
  'Interrupted when the app last exited': '前回終了時にアプリが中断されました',
  'AI transfer must be confirmed again after restore': '復元後は AI への送信を再確認してください',
  'The app exited during import. Try again.': 'インポート中にアプリが終了しました。もう一度お試しください。',
  'Retry manually and confirm the recipient and content after restoring a backup.':
    'バックアップ復元後は手動で再試行し、送信先と内容を再確認してください。',
  'Import failed. Check the source file and try again.':
    'インポートに失敗しました。元のファイルを確認して再試行してください。',
};

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

export const languageLabels: Record<Language, string> = {
  en: 'English',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  ja: '日本語',
};

export function normalizeLanguage(value: unknown): Language {
  return LANGUAGES.includes(value as Language) ? (value as Language) : 'en';
}

export function systemLanguage(locale = Intl.DateTimeFormat().resolvedOptions().locale): Language {
  if (/^ja(?:-|_|$)/i.test(locale)) return 'ja';
  if (!/^zh(?:-|_|$)/i.test(locale)) return 'en';
  return /hant|tw|hk|mo/i.test(locale) ? 'zh-TW' : 'zh-CN';
}

export function translate(language: Language, english: string, simplifiedChinese: string) {
  if (language === 'zh-CN') return simplifiedChinese;
  if (language === 'zh-TW') return toTraditional(simplifiedChinese);
  if (language === 'ja') return JAPANESE[english] ?? english;
  return english;
}

export const formatDate = (value: string | number | Date, language: Language) => {
  const normalized = typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return '—';
  if (language !== 'en') {
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    return `${date.getMonth() + 1}月${date.getDate()}日 ${hour}:${minute}`;
  }
  return englishDateFormatter.format(date);
};

export const formatDay = (value: string, language: Language) => {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return '—';
  return language !== 'en'
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
  if (language === 'zh-TW') return toTraditional(value);
  if (/\p{Script=Han}/u.test(value)) {
    return translate(language, 'Import failed. Check the source file and try again.', value);
  }
  return value;
}
