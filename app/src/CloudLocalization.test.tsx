// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Markdown } from "../../shared/cloud/ResultReview";
import { setCloudLocale, t } from "../../shared/cloud/i18n";
import en from "../../shared/cloud/locales/en.json";
import zhTW from "../../shared/cloud/locales/zh-TW.json";
afterEach(() => { cleanup(); setCloudLocale("zh-CN");  vi.restoreAllMocks(); });
it('keeps every cloud message and placeholder translated without touching source content', () => {
  for (const [key, value] of Object.entries(en)) {
    expect(value, key).toBeTruthy(); expect(zhTW[key as keyof typeof zhTW], key).toBeTruthy();
    expect(value.match(/\{\d+\}/g)?.sort() ?? [], key).toEqual(key.match(/\{\d+\}/g)?.sort() ?? []);
    expect(zhTW[key as keyof typeof zhTW].match(/\{\d+\}/g)?.sort() ?? [], key).toEqual(key.match(/\{\d+\}/g)?.sort() ?? []);
  }
  setCloudLocale('en'); expect(t('恢复第 {0} 题草稿', 3)).toBe('Restore draft for question 3');
  expect(t('未收录的原始文档内容')).toBe('未收录的原始文档内容');
  setCloudLocale('zh-CN'); expect(t(' 题型')).toBe(' 题型');
});

it('updates memoized cloud labels on language changes without remounting content', () => {
  setCloudLocale('zh-CN');
  render(<Markdown text={null}/>);
  expect(screen.getByText('未提供（null）')).toBeTruthy();
  act(() => setCloudLocale('en'));
  expect(screen.getByText('Not supplied (null)')).toBeTruthy();
  act(() => setCloudLocale('zh-TW'));
  expect(screen.getByText('未提供（null）')).toBeTruthy();
});
