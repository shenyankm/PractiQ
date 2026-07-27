import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatDate,
  formatDay,
  importStatusLabel,
  importStatusText,
  normalizeLanguage,
  questionTypeLabel,
  systemLanguage,
  translate,
} from './i18n';

test('language defaults to English and only accepts supported values', () => {
  assert.equal(normalizeLanguage(undefined), 'en');
  assert.equal(normalizeLanguage('en'), 'en');
  assert.equal(normalizeLanguage('zh-CN'), 'zh-CN');
  assert.equal(normalizeLanguage('zh'), 'en');
  assert.equal(systemLanguage('zh-Hans-CN'), 'zh-CN');
  assert.equal(systemLanguage('en-US'), 'en');
});

test('translations switch between English and Simplified Chinese', () => {
  assert.equal(translate('en', 'Settings', '设置'), 'Settings');
  assert.equal(translate('zh-CN', 'Settings', '设置'), '设置');
  assert.equal(questionTypeLabel('single_choice', 'en'), 'Single choice');
  assert.equal(questionTypeLabel('single_choice', 'zh-CN'), '单选题');
  assert.equal(importStatusLabel('retry_wait', 'en'), 'Waiting to retry');
  assert.equal(importStatusLabel('retry_wait', 'zh-CN'), '等待重试');
  assert.equal(importStatusText('stage:writing:12', 'en'), 'Writing 12 questions');
  assert.equal(importStatusText('stage:completed:12', 'zh-CN'), '已导入 12 道题');
  assert.equal(importStatusText('error:interrupted', 'en'), 'The app exited during import. Try again.');
});

test('Chinese dates do not depend on platform locale data', () => {
  assert.match(formatDate('2026-07-18T02:52:00Z', 'zh-CN'), /^\d+月\d+日 \d{2}:\d{2}$/);
  assert.equal(formatDay('2026-07-18', 'zh-CN'), '7月18日');
});
