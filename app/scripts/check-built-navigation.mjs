import { test, expect } from 'playwright/test';

// Exercise the minified production assets. Native commands are mocked here;
// the installed APK still needs its own Android navigation acceptance.
const languages = [
  { locale: 'zh-CN', open: '打开主导航', drawer: '主导航', banks: '我的题库', nav: ['我的题库', '错题本', '收藏夹', '练习记录', '设置'], theme: '主题', language: '语言', close: '关闭' },
  { locale: 'en', open: 'Open navigation', drawer: 'Main navigation', banks: 'My banks', nav: ['My banks', 'Mistakes', 'Favorites', 'History', 'Settings'], theme: 'Theme', language: 'Language', close: 'Close' },
];

async function withinViewport(page, locator, name) {
  await expect(locator).toBeVisible();
  const viewport = page.viewportSize();
  await expect.poll(async () => {
    const box = await locator.boundingBox();
    return box != null && box.width > 0 && box.height > 0 && box.x >= 0 && box.y >= 0
      && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height;
  }, { message: `Visible production navigation bounds: ${name}` }).toBe(true);
}

async function openDrawer(page, names) {
  await page.getByRole('button', { name: names.open, exact: true }).tap();
  const drawer = page.getByRole('dialog', { name: names.drawer, exact: true });
  await expect(drawer).toBeVisible();
  await drawer.evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished));
  });
  await withinViewport(page, drawer, names.drawer);
  return drawer;
}

for (const names of languages) {
  test(`built touch drawer keeps navigation visible and usable (${names.locale})`, async ({ page }, testInfo) => {
    const errors = [], externalRequests = [], calls = [], unexpectedCalls = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === 'http://127.0.0.1:1423') return route.continue();
      externalRequests.push(url.href);
      return route.abort();
    });
    await page.exposeFunction('__recordBuiltNavigationCall', call => calls.push(call));
    await page.exposeFunction('__recordUnexpectedBuiltNavigationCall', call => unexpectedCalls.push(call));
    await page.addInitScript(({ locale }) => {
      window.isTauri = false;
      let language = locale;
      window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
        const request = args?.request;
        await window.__recordBuiltNavigationCall({ command, request });
        if (command !== 'request') throw Error(`Unexpected built navigation command: ${command}`);
        switch (request?.type) {
          case 'language': return language;
          case 'save_language': language = request.locale; return language;
          case 'banks': return [];
          case 'banks_page': case 'questions_page': case 'sessions_page': return { items: [], total: 0, offset: 0 };
          case 'unfinished_session': return null;
          case 'info': return { version: 'Built browser navigation mock', dataDirectory: '/mock' };
          case 'settings': return { config: { service_url: null }, hasServiceToken: false };
          default:
            await window.__recordUnexpectedBuiltNavigationCall({ command, request });
            throw Error(`Unexpected built navigation request: ${request?.type}`);
        }
      } };
    }, { locale: names.locale });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: names.banks, exact: true })).toBeVisible();
    await expect(page.locator('.preview-controls')).toHaveCount(0);
    const drawer = await openDrawer(page, names);
    for (const name of [...names.nav, names.theme, names.language]) {
      const button = drawer.getByRole('button', { name, exact: true });
      await withinViewport(page, button, name);
      await withinViewport(page, button.locator('.sidebar-label'), `${name} label`);
      await withinViewport(page, button.locator('svg'), `${name} icon`);
      const box = await button.boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(48);
      expect(box.height).toBeGreaterThanOrEqual(48);
    }
    await withinViewport(page, drawer.getByRole('button', { name: names.close, exact: true }), names.close);
    await page.screenshot({ path: testInfo.outputPath('built-navigation.png'), fullPage: true });
    await drawer.getByRole('button', { name: names.theme, exact: true }).tap();
    await expect(page.getByRole('menu', { name: names.theme, exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await drawer.getByRole('button', { name: names.language, exact: true }).tap();
    await expect(page.getByRole('menu', { name: names.language, exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    for (const name of names.nav) {
      await drawer.getByRole('button', { name, exact: true }).tap();
      await expect(drawer).toBeHidden();
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
      await openDrawer(page, names);
    }
    await drawer.getByRole('button', { name: names.close, exact: true }).tap();
    await expect(drawer).toBeHidden();
    expect(errors).toEqual([]);
    expect(externalRequests).toEqual([]);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(call => call.command === 'request')).toBe(true);
    expect(unexpectedCalls).toEqual([]);
  });
}
