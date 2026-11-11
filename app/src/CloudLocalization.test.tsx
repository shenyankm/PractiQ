// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Markdown } from "../../shared/cloud/ResultReview";
import Portal from "../../shared/cloud/AccountPortal";
import { setCloudLocale, t } from "../../shared/cloud/i18n";
import en from "../../shared/cloud/locales/en.json";
import zhTW from "../../shared/cloud/locales/zh-TW.json";
import { setAccount } from "../../shared/cloud/accountClient";
afterEach(() => { cleanup(); setCloudLocale("zh-CN"); setAccount(null); vi.restoreAllMocks(); });
it.each([['en', 'Sign in to PractiQ', 'Login email'], ['zh-TW', '登入 PractiQ', '登入電子郵件']] as const)("localizes cloud account entry in %s", async (locale, heading, label) => {
  setCloudLocale(locale);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({user:null,csrf:'test',registrationEnabled:true})));
  render(<Portal />);
  await screen.findByRole('heading',{name:heading});
  expect(screen.getByLabelText(label)).toBeTruthy();
});
it('localizes the personal area navigation in English', async () => {
  setCloudLocale('en');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/api/auth/session')) return Response.json({ user: { id: 'u1', email: 'ada@example.test', name: 'Ada', role: 'user', enabled: true }, csrf: 'token', registrationEnabled: true });
    return Response.json({});
  }));
  render(<Portal />);
  expect(await screen.findByRole('button', { name: 'Import results' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Import workspace' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '我的题库' })).toBeNull();
});

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
