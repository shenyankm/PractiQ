import { test as runner, expect } from 'playwright/test';
import { withEvidence } from '../../shared/browser-evidence.mjs';
const base = withEvidence(runner);
import { readFileSync } from 'node:fs';


async function editQuestion(page, trigger) {
  await trigger.click();
  await page.getByRole('menuitem', {name:'编辑题目',exact:true}).click();
}

// Chromium touch previews exercise layout and user actions. Native SAF, system
// insets and the real Android keyboard belong to the emulator/device checks.
const test = base.extend({ page: async ({ page, baseURL }, use) => {
  const errors = [], externalRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(baseURL).origin) return route.continue();
    externalRequests.push(url.href);
    return route.abort();
  });
  await page.addInitScript(() => {
    window.__unexpectedAndroidNativeCalls = [];
    window.__TAURI_INTERNALS__ = { invoke: (command) => {
      window.__unexpectedAndroidNativeCalls.push(command);
      throw new Error(`Unexpected native IPC in Android preview: ${command}`);
    } };
  });
  await use(page);
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
  expect(await page.evaluate(() => window.__unexpectedAndroidNativeCalls)).toEqual([]);
} });

async function noHorizontalOverflow(page, label) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), { message: `Page overflow: ${label}` }).toBe(true);
  await expect.poll(() => page.locator('main, .app-content, fieldset, [role=dialog], [role=alertdialog], [role=menu]').evaluateAll(elements => elements.filter(element => element.clientWidth && element.scrollWidth > element.clientWidth + 2).map(element => ({ role: element.getAttribute('role') || element.tagName, width: element.clientWidth, scroll: element.scrollWidth }))), { message: `Surface overflow: ${label}` }).toEqual([]);
}

async function touchTarget(locator) {
  await expect(locator).toBeVisible();
  // Dialog and drawer transforms briefly scale their children during entry.
  // Keep the actual target threshold after the existing animation has settled.
  await expect.poll(async () => (await locator.boundingBox())?.width ?? 0, { message: 'Touch target width' }).toBeGreaterThanOrEqual(48);
  await expect.poll(async () => (await locator.boundingBox())?.height ?? 0, { message: 'Touch target height' }).toBeGreaterThanOrEqual(48);
}

async function nativeBack(page) {
  return page.evaluate(() => {
    const event = new CustomEvent('practiq-android-back', { cancelable: true });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

async function navigate(page, name, english = false) {
  const menu=page.getByRole('button',{name:english?'Open navigation':'打开主导航',exact:true});
  const back=page.getByRole('button',{name:english?/^Back to (banks|practice history|settings|grading)$/:/^返回(题库|练习记录|设置|评分)$/});
  await expect(menu.or(back).first()).toBeVisible();
  if (!await menu.count()) { await back.click(); await expect(menu).toBeVisible(); }
  await page.getByRole('button', { name: english ? 'Open navigation' : '打开主导航', exact: true }).tap();
  const drawer = page.getByRole('dialog', { name: english ? 'Main navigation' : '主导航', exact: true });
  await expect(drawer).toBeVisible();
  await touchTarget(drawer.getByRole('button', { name, exact: true }));
  await drawer.getByRole('button', { name, exact: true }).tap();
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}

async function startPractice(page, title = '基础知识 · 全题型', count = '9') {
  const bank = page.locator('[data-slot=card]').filter({ has: page.getByText(title, { exact: true }) });
  await bank.getByRole('button', { name: '开始练习', exact: true }).tap();
  const setup = page.getByRole('dialog');
  await expect(setup).toBeVisible();
  await touchTarget(setup.getByLabel('题目数量', { exact: true }));
  await setup.getByRole('combobox', { name: /^模式/ }).selectOption('self_test');
  await setup.getByLabel('考试总分', { exact: true }).fill('90');
  const advanced = setup.getByText('高级设置 · 题库、筛选与选题方式', { exact: true });
  await touchTarget(advanced);
  await advanced.tap();
  await setup.getByRole('combobox', { name: '选题方式', exact: true }).selectOption('quota');
  await setup.getByLabel('单选题数', { exact: true }).fill('1');
  await noHorizontalOverflow(page, 'question quotas');
  await setup.getByRole('button', { name: '预览题目与配分', exact: true }).tap();
  await setup.getByText('按题型分配总分', { exact: true }).tap();
  const budget = setup.getByLabel('单选预算', { exact: true });
  await touchTarget(budget);
  await budget.fill('90');
  await noHorizontalOverflow(page, 'score budgets');
  await setup.getByRole('button', { name: '返回设置', exact: true }).tap();
  await setup.getByRole('combobox', { name: /^模式/ }).selectOption('practice');
  await setup.getByRole('combobox', { name: '选题方式', exact: true }).selectOption('count');
  await setup.getByLabel('题目数量', { exact: true }).fill(count);
  await setup.getByLabel('出题顺序', { exact: true }).selectOption('ordered');
  await noHorizontalOverflow(page, 'practice setup');
  await touchTarget(setup.getByRole('button', { name: '立即开始', exact: true }));
  await setup.getByRole('button', { name: '立即开始', exact: true }).tap();
  await expect(setup).toBeHidden();
  await expect(page.getByRole('heading', { name: '专注练习', exact: true })).toBeVisible();
}

async function serviceMock(page, service = false) {
  const calls = [];
  await page.exposeFunction('__recordAndroidMockCall', call => calls.push(call));
  const english = JSON.parse(readFileSync('fixtures/english.json', 'utf8'));
  await page.addInitScript(({ question, service }) => {
    sessionStorage.setItem('practiq-preview', 'local');
    window.isTauri = false;
    const bank = { id: 'mobile', title: '浏览器题库', description: '', count: 1, createdAt: 1 };
    const snapshot = { question, groups: [], visuals: [], sources: [], warnings: [], missingAssets: false };
    const session = { id: 'mobile-grade', title: '浏览器评分场景', kind: 'self_test', createdAt: 1, submittedAt: 2, finishedAt: null, position: 0, mode: 'ordered', attempts: [{ ordinal: 0, snapshot, answer: { text: 'A preserved answer.' }, autoResult: null, result: null, gradeKind: 'ungraded', maxCents: 1000, earnedCents: null, submittedAt: 2, skipped: false, elapsedMs: 1000 }] };
    let settings = { config: { service_url: service ? 'https://initial-service.example.test' : null }, hasServiceToken: false };
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      const request = args?.request;
      await window.__recordAndroidMockCall({ command, request });
      if (command === 'ai_request' && request.type === 'grade') {
        Object.assign(session.attempts[0], { result: false, earnedCents: 600, gradeKind: 'ai', grading: { ai: { status: 'graded', result: { scoreCents: 600, maxCents: 1000, reason: '浏览器 mock 评分；未调用模型。', evidence: ['已有参考依据'], reviewReasons: [] } } } });
        return structuredClone(session);
      }
      if (command !== 'request') throw new Error(`Unexpected mobile mock command: ${command}`);
      switch (request.type) {
        case 'language': return 'zh-CN';
        case 'banks': return [bank];
        case 'banks_page': return { items: [bank], total: 1, offset: 0 };
        case 'sessions_page': return { items: [{ ...session, attempts: undefined, count: 1, answered: 1, draftAnswered: 1, correct: 0, graded: session.attempts[0].result == null ? 0 : 1, skipped: 0, elapsedMs: 1000, autoGraded: 0, selfGraded: 0, pendingGrades: session.attempts[0].earnedCents == null ? 1 : 0, totalCents: 1000, earnedCents: session.attempts[0].earnedCents || 0, lastActiveAt: 2 }], total: 1, offset: 0 };
        case 'unfinished_session': return null;
        case 'info': return { version: 'Android browser mock', dataDirectory: '/mock' };
        case 'settings': return settings;
        case 'save_settings': {
          const hasServiceToken = request.service_token === null ? (request.config.service_url === settings.config.service_url ? settings.hasServiceToken : null) : !!request.service_token.trim();
          const hasApiKey = request.api_key == null ? (request.config.model?.base_url === settings.config.model?.base_url ? settings.hasApiKey : null) : !!request.api_key.trim();
          settings = { config: request.config, hasServiceToken, ...(request.config.model ? {hasApiKey} : {}) };
          return settings;
        }
        case 'test_settings': case 'pick_import': return null;
        case 'session': return structuredClone(session);
        case 'manual_score': {
          Object.assign(session.attempts[0], { earnedCents: request.cents, result: request.cents === 1000, gradeKind: 'manual', grading: { ...session.attempts[0].grading, manual: { reason: request.reason, scoreCents: request.cents } } });
          return structuredClone(session);
        }
        default: throw new Error(`Unexpected mobile mock request: ${request.type}`);
      }
    } };
  }, { question: english.questions.find(question => question.questionKind === 'translation'), service });
  return calls;
}

test('review keeps readable answers and its final content above the separate navigation bar', async ({ page }) => {
  const calls = await serviceMock(page);
  await page.goto('/');
  await navigate(page, '练习记录');
  await page.getByRole('button', {name:'核对评分',exact:true}).tap();
  await expect(page.getByRole('heading', {name:'练习回顾',exact:true})).toBeVisible();
  await expect(page.getByRole('region', {name:'我的答案',exact:true})).toContainText('A preserved answer.');
  await expect(page.getByText(/草稿自动保存/)).toHaveCount(0);
  await expect(page.getByRole('button', {name:'查看原文',exact:true})).toBeVisible();
  await page.getByRole('button', {name:'查看原文',exact:true}).tap();
  await expect(page.getByRole('region', {name:'题目材料',exact:true})).toBeVisible();
  await page.getByRole('button', {name:'收起原文',exact:true}).tap();
  await page.getByRole('link',{name:'查看答题卡',exact:true}).tap();
  const legend = await page.getByLabel('本次题目状态',{exact:true}).boundingBox();
  const scrollArea = await page.locator('.practice-scroll').boundingBox();
  expect(legend.y).toBeGreaterThanOrEqual(scrollArea.y);
  await page.getByRole('link',{name:'返回当前题',exact:true}).tap();
  const body = page.locator('.practice-question-body');
  await body.locator(':scope > section').last().evaluate(node => {
    const scroller = node.closest('.practice-scroll');
    scroller.scrollTop += node.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom + 16;
  });
  const footer = await page.locator('.practice-footer').boundingBox();
  const content = await page.locator('.practice-scroll').boundingBox();
  const last = await body.locator(':scope > section').last().boundingBox();
  expect(content.y + content.height).toBeLessThanOrEqual(footer.y + 1);
  expect(last.y + last.height).toBeLessThanOrEqual(footer.y + 1);
  await noHorizontalOverflow(page, 'finished review');
  expect(calls.filter(call => ['save_draft','save_attempt','grade'].includes(call.request?.type))).toEqual([]);
});

test('sibling review retains the actual scroll offset of a long expanded passage', async ({ page }) => {
  await serviceMock(page);
  await page.goto('/');
  const fixture = JSON.parse(readFileSync('fixtures/english.json', 'utf8'));
  await page.evaluate(async fixture => {
    const original = window.__TAURI_INTERNALS__.invoke;
    const session = await original('request', {request:{type:'session',id:'mobile-grade'}});
    const parent = fixture.questions.find(question => question.id === 'read');
    const child = fixture.questions.find(question => question.id === 'read-1');
    parent.contentBlocks = [{partType:'text', markdownValue:'A long reading passage for scroll retention. '.repeat(200)}];
    session.attempts = [0,1].map(ordinal => ({...session.attempts[0],ordinal,
      snapshot:{...session.attempts[0].snapshot,question:{...child,id:`reading-${ordinal}`},materials:[parent]}}));
    window.__TAURI_INTERNALS__.invoke = async (command,args) => {
      const request = args?.request;
      if (command === 'request' && request?.type === 'position') {
        session.position = request.position;
        return structuredClone(session);
      }
      if (command === 'request' && request?.type === 'session') return structuredClone(session);
      const result = await original(command,args);
      if (request?.type === 'sessions_page') result.items = result.items.map(item => ({...item,count:2,answered:2,pendingGrades:2}));
      return result;
    };
  },fixture);
  await navigate(page,'练习记录');
  await page.getByRole('button',{name:'核对评分',exact:true}).tap();
  await page.getByRole('button',{name:'查看原文',exact:true}).tap();
  const reader = page.getByRole('region',{name:'题目材料',exact:true});
  expect(await reader.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  await reader.evaluate(node => {node.scrollTop=120;});
  await page.getByRole('button',{name:'下一题',exact:true}).tap();
  await expect(page.getByRole('heading',{name:'第 2 / 2 题',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'收起原文',exact:true})).toBeVisible();
  await expect.poll(() => reader.evaluate(node => node.scrollTop)).toBe(120);
});

test('touch navigation works in both languages and consumes back only when needed', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '我的题库', exact: true })).toBeVisible();
  expect(await nativeBack(page)).toBe(false);
  const open = page.getByRole('button', { name: '打开主导航', exact: true });
  await touchTarget(open);
  await open.tap();
  const drawer = page.getByRole('dialog', { name: '主导航', exact: true });
  await noHorizontalOverflow(page, 'navigation drawer');
  await expect.poll(async () => (await drawer.boundingBox())?.x ?? -1).toBeGreaterThanOrEqual(0);
  await expect.poll(async () => {
    const box = await drawer.boundingBox();
    return box ? box.x + box.width : Infinity;
  }).toBeLessThanOrEqual(page.viewportSize().width);
  expect(await nativeBack(page)).toBe(true);
  await expect(drawer).toBeHidden();
  for (const name of ['错题本', '收藏夹', '练习记录', '设置', '我的题库']) {
    await navigate(page, name);
    await noHorizontalOverflow(page, name);
  }
  await open.tap();
  await drawer.getByRole('button', { name: '语言', exact: true }).tap();
  await page.getByRole('menuitemradio', { name: 'English', exact: true }).tap();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByRole('dialog', { name: 'Main navigation', exact: true }).getByRole('button', { name: 'History', exact: true }).tap();
  await expect(page.getByRole('heading', { name: 'History', exact: true })).toBeVisible();
  await navigate(page, 'Settings', true);
  await noHorizontalOverflow(page, 'English settings');
  expect(await nativeBack(page)).toBe(true);
  await expect(page.getByRole('heading', { name: 'My banks', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('android-navigation.png'), fullPage: true });
});

test('ZIP and service settings stay local until an explicit connection test', async ({ page }) => {
  const calls = await serviceMock(page, true);
  await page.goto('/');
  const directImport = page.getByRole('button', { name: '导入', exact: true });
  await touchTarget(directImport);
  await directImport.tap();
  expect(calls.filter(call => call.request.type === 'pick_import')).toHaveLength(0);
  const zip = page.getByRole('menuitem', { name: '导入题库 ZIP', exact: true });
  await touchTarget(zip);
  await expect(page.getByRole('menuitem', { name: '恢复学习数据备份', exact: true })).toBeVisible();
  await touchTarget(page.getByRole('menuitem', { name: '修复资源并恢复备份', exact: true }));
  await zip.tap();
  await expect.poll(() => calls.filter(call => call.request.type === 'pick_import').length).toBe(1);
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '配置', exact: true }).tap();
  const url = page.getByLabel('AI 服务地址', { exact: true });
  const token = page.getByLabel('AI 服务访问令牌', { exact: true });
  await touchTarget(url);
  await touchTarget(token);
  await expect(token).toHaveAttribute('type', 'password');
  await url.fill('https://service.example.test');
  await token.focus();
  await expect.poll(() => calls.filter(call => call.request.type === 'save_settings').length).toBe(1);
  await token.fill('fake-android-browser-token');
  const connectionTest = page.getByRole('button', { name: '测试连接', exact: true });
  await connectionTest.focus();
  await expect(token).toHaveValue('');
  expect(calls.some(call => call.command === 'ai_request')).toBe(false);
  expect(calls.some(call => call.request.type === 'test_settings')).toBe(false);
  await touchTarget(connectionTest);
  await connectionTest.tap();
  await expect(page.getByRole('status').filter({ hasText: '连接测试通过' })).toBeVisible();
  await url.fill('https://service-latest.example.test');
  expect(await nativeBack(page)).toBe(true);
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  expect(calls.filter(call => call.request.type === 'save_settings').at(-1).request.config.service_url).toBe('https://service-latest.example.test');
  await noHorizontalOverflow(page, 'saved service settings');
  expect(calls.every(call => call.command === 'request')).toBe(true);
});

test('direct model settings fit touch screens and never start grading', async ({ page }, testInfo) => {
  const calls = await serviceMock(page);
  await page.goto('/');
  await navigate(page, '设置');
  await page.getByRole('button', {name:'配置',exact:true}).tap();
  const address=page.getByLabel('模型 API 地址',{exact:true});
  const model=page.getByLabel('模型 ID',{exact:true});
  const key=page.getByLabel('模型 API Key',{exact:true});
  for (const field of [address,model,key]) await touchTarget(field);
  await address.fill('https://models.example.test/v1');
  await model.fill('fixture-model');
  await key.fill('fixture-key-never-a-real-credential');
  const testConnection=page.getByRole('button',{name:'测试连接',exact:true});
  await testConnection.focus();
  await expect(key).toHaveValue('');
  await expect.poll(()=>calls.filter(call=>call.request.type==='save_settings').at(-1)?.request.api_key).toBe('fixture-key-never-a-real-credential');
  expect(calls.some(call=>call.command==='ai_request' || call.request.type==='test_settings')).toBe(false);
  await testConnection.tap();
  await expect(page.getByRole('status').filter({hasText:'连接测试通过'})).toBeVisible();
  const testCall=calls.filter(call=>call.request.type==='test_settings').at(-1).request;
  expect(testCall).toEqual({type:'test_settings',config:{service_url:null,model:{base_url:'https://models.example.test/v1',model_id:'fixture-model'}},service_token:null,api_key:null});
  const clear=page.getByRole('button',{name:'清除已保存的 API Key',exact:true});
  await touchTarget(clear);
  await clear.tap();
  await expect(clear).toBeDisabled();
  await noHorizontalOverflow(page,'direct model settings');
  expect(calls.every(call=>call.command==='request')).toBe(true);
  await page.screenshot({path:testInfo.outputPath('direct-model-settings.png'),fullPage:true});
});

test('remote grading requires the explicit action and manual review remains usable', async ({ page }) => {
  const calls = await serviceMock(page);
  await page.goto('/');
  await navigate(page, '练习记录');
  await page.getByRole('button', { name: '核对评分', exact: true }).tap();
  await expect(page.getByText('尚未请求 AI 评分。', { exact: true })).toBeVisible();
  expect(calls.filter(call => call.command === 'ai_request')).toEqual([]);
  const grade = page.getByRole('button', { name: 'AI 评分/继续（1 题，将调用模型）', exact: true });
  await touchTarget(grade);
  await noHorizontalOverflow(page, 'explicit grading');
  await grade.tap();
  await expect(page.getByText('浏览器 mock 评分；未调用模型。', { exact: true })).toBeVisible();
  expect(calls.filter(call => call.command === 'ai_request').map(call => call.request)).toEqual([{ type: 'grade', id: 'mobile-grade', ordinal: 0, retry: false }]);
  await page.getByLabel('人工得分', { exact: true }).fill('7.5');
  const reason = page.getByLabel('改分原因', { exact: true });
  await touchTarget(reason);
  await reason.fill('移动端人工复核');
  await page.getByRole('button', { name: '保存人工评分', exact: true }).tap();
  await expect(page.getByText('人工改分原因：移动端人工复核', { exact: true })).toBeVisible();
  expect(calls.filter(call => call.command === 'ai_request')).toHaveLength(1);
});

test('question summaries stay readable and sequential practice controls stay together on touch screens', async ({ page }) => {
  await page.goto('/');
  const bank = page.locator('[data-slot=card]').filter({ has: page.getByText('基础知识 · 全题型', { exact: true }) });
  await bank.getByRole('button', { name: '查看题目', exact: true }).tap();
  const summary = page.getByRole('button').filter({ has: page.getByText('下面哪一个是质数？', { exact: true }) });
  await expect(summary).toBeVisible();
  await expect.poll(async () => (await summary.boundingBox())?.width ?? 0, { message: 'Question summary needs readable space beside its number' }).toBeGreaterThan(page.viewportSize().width * 0.6);
  await summary.tap();
  await expect(page.getByRole('dialog', { name: '题目详情', exact: true })).toBeVisible();
  expect(await nativeBack(page)).toBe(true);
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByRole('button', { name: '返回题库', exact: true }).tap();
  await page.getByRole('button', { name: '继续练习', exact: true }).tap();
  const previous = page.getByRole('button', { name: '上一题', exact: true });
  const next = page.getByRole('button', { name: '下一题', exact: true });
  await touchTarget(previous);
  await touchTarget(next);
  await expect.poll(async () => {
    const before = await previous.boundingBox(), after = await next.boundingBox();
    return before && after ? Math.abs(before.y - after.y) : Infinity;
  }, { message: 'Previous and Next should share a row' }).toBeLessThanOrEqual(1);
  await next.tap();
  await expect(page.getByRole('heading', { name: '第 2 / 9 题', exact: true })).toBeVisible();
  await previous.tap();
  await expect(page.getByRole('heading', { name: '第 1 / 9 题', exact: true })).toBeVisible();
  await noHorizontalOverflow(page, 'readable summaries and sequential practice');
});

test('all answer controls and answer-card navigation preserve drafts on touch screens', async ({ page }, testInfo) => {
  await page.goto('/');
  await startPractice(page);
  await page.getByRole('link', {name:'查看答题卡',exact:true}).tap();
  const card = page.getByRole('region', { name: '答题卡', exact: true });
  await expect(card.getByRole('button')).toHaveCount(9);
  const go = async number => {
    if (!await page.locator(".practice-answer-card").evaluate(node => node.open)) await page.getByRole("link", {name:"查看答题卡",exact:true}).tap();
    const button = card.getByRole('button', { name: new RegExp(`^转到第 ${number} 题，`) });
    await touchTarget(button);
    await button.tap();
    await expect(page.getByRole('heading', { name: `第 ${number} / 9 题`, exact: true })).toBeVisible();
    await noHorizontalOverflow(page, `question ${number}`);
  };
  const choice = page.getByRole('radiogroup', { name: '选择答案', exact: true }).getByRole('radio').first();
  await touchTarget(choice.locator('..'));
  await choice.locator('..').tap();
  await page.getByRole('button', { name: '提交答案', exact: true }).tap();
  await go(2);
  await page.getByRole('checkbox').first().locator('..').tap();
  await expect(page.getByRole('checkbox').first()).toBeChecked();
  await go(3);
  await page.getByRole('radiogroup', { name: '判断答案', exact: true }).getByRole('radio').first().locator('..').tap();
  await go(4);
  await touchTarget(page.getByLabel('第 1 空', { exact: true }));
  await page.getByLabel('第 1 空', { exact: true }).fill('北京');
  await go(5);
  await page.getByLabel('作答内容', { exact: true }).fill('每天阅读，保留这个草稿。');
  await go(6);
  const down = page.getByRole('button', { name: '第 1 项下移', exact: true });
  await touchTarget(down);
  await down.tap();
  await go(7);
  const match = page.getByRole('combobox').first();
  await touchTarget(match);
  await match.selectOption({ index: 1 });
  await go(8);
  await page.getByRole('combobox').first().selectOption({ index: 1 });
  await go(9);
  await page.getByLabel('作答内容', { exact: true }).fill('图标让我想到循序渐进。');
  await go(5);
  await page.getByRole('button', { name: '返回练习记录', exact: true }).tap();
  await expect(page.getByRole('heading', { name: '练习记录', exact: true })).toBeVisible();
  const session = page.locator('[data-slot=card]').filter({ has: page.getByRole('heading', { name: '示例练习', exact: true }) });
  await session.getByRole('button', { name: '继续练习', exact: true }).tap();
  await expect(page.getByLabel('作答内容', { exact: true })).toHaveValue('每天阅读，保留这个草稿。');
  await page.screenshot({ path: testInfo.outputPath('android-practice.png'), fullPage: true });
  await go(4);
  await expect(page.getByLabel('第 1 空', { exact: true })).toHaveValue('北京');
});

test('listening uses local audio with touch-sized playback, speed and seek controls', async ({ page }) => {
  await page.goto('/');
  const bank = page.locator('[data-slot=card]').filter({ has: page.getByText('英语专项 · 听力与写作', { exact: true }) });
  await bank.getByRole('button', { name: '开始练习', exact: true }).tap();
  const setup = page.getByRole('dialog');
  await setup.getByLabel('出题顺序', { exact: true }).selectOption('ordered');
  await setup.getByText('高级设置 · 题库、筛选与选题方式', { exact: true }).tap();
  await setup.getByRole('combobox', { name: '题型', exact: true }).selectOption('listening');
  await setup.getByLabel('题目数量', { exact: true }).fill('2');
  await setup.getByRole('button', { name: '立即开始', exact: true }).tap();
  const player = page.getByRole('region', { name: '听力播放器', exact: true });
  const play = player.getByRole('button', { name: '播放听力', exact: true });
  const next = await page.getByRole('button', {name:'下一题',exact:true}).boundingBox();
  expect(next.y + next.height).toBeLessThanOrEqual(page.viewportSize().height);
  await expect(play).toBeEnabled();
  await touchTarget(play);
  const speed = player.getByRole('combobox', { name: '播放速度', exact: true });
  const seek = player.getByRole('slider', { name: '听力播放进度', exact: true });
  await touchTarget(speed);
  await touchTarget(seek);
  await speed.selectOption('0.75');
  await play.tap();
  await expect(player.getByRole('button', { name: '暂停播放', exact: true })).toBeVisible();
  await player.getByRole('button', { name: '暂停播放', exact: true }).tap();
  await expect(play).toBeVisible();
  await seek.tap();
  await expect.poll(() => player.locator('audio').evaluate(audio => audio.currentTime)).toBeGreaterThan(0.5);
  await expect.poll(async () => {
    const position = await player.locator('audio').evaluate(audio => audio.currentTime);
    return Math.abs(position - Number(await seek.inputValue()));
  }).toBeLessThan(0.05);
  await expect(player.locator('audio')).toHaveJSProperty('playbackRate', 0.75);
  await player.getByRole('button', { name: '从头重听', exact: true }).tap();
  await expect.poll(() => player.locator('audio').evaluate(audio => audio.currentTime)).toBeCloseTo(0, 1);
  // The preview accepts playback requests; this checks real Chromium EOF/UI
  // replay, while strict native End/Pause state is verified separately.
  await play.tap();
  await expect.poll(() => player.locator('audio').evaluate(audio => audio.ended && audio.paused)).toBe(true);
  await expect(play).toBeEnabled();
  await expect(player.getByRole('alert')).toHaveCount(0);
  await play.tap();
  await expect(player.getByRole('button', { name: '暂停播放', exact: true })).toBeVisible();
  await expect.poll(() => player.locator('audio').evaluate(audio => !audio.ended && !audio.paused && audio.currentTime > 0.1)).toBe(true);
  await player.getByRole('button', { name: '暂停播放', exact: true }).tap();
  await expect(play).toBeVisible();
  await noHorizontalOverflow(page, 'listening controls');
});

test('dirty dialogs retain and save edits after a shortened viewport', async ({ page }, testInfo) => {
  await page.goto('/');
  const bank = page.locator('[data-slot=card]').filter({ has: page.getByText('英语专项 · 听力与写作', { exact: true }) });
  await bank.getByRole('button', { name: '查看题目', exact: true }).tap();
  const writing = page.getByRole('button', { name: /Write an invitation to a reading club\./ }).locator('..');
  await editQuestion(page, writing.getByRole('button', {name:/^题目更多操作/}));
  const editor = page.getByRole('dialog', { name: '编辑题目', exact: true });
  const stem = editor.getByRole('textbox', { name: '题干（支持 Markdown 和公式）', exact: true });
  const original = await stem.inputValue();
  await stem.fill(`${original} 移动端保存`);
  const maximum = editor.getByLabel('最多词数', { exact: true });
  await touchTarget(editor.getByLabel('写作文体', { exact: true }));
  await touchTarget(maximum);
  await maximum.fill('180');
  await noHorizontalOverflow(page, 'English writing metadata');
  const viewport = page.viewportSize();
  // A resize is a browser layout probe, not evidence of the native IME policy.
  await page.setViewportSize({ width: viewport.width, height: 400 });
  await noHorizontalOverflow(page, 'shortened editor viewport');
  expect(await nativeBack(page)).toBe(true);
  const confirmation = page.getByRole('alertdialog', { name: '放弃未保存的更改？', exact: true });
  await expect(confirmation).toBeVisible();
  const resume = confirmation.getByRole('button', { name: '继续编辑', exact: true });
  await touchTarget(resume);
  await resume.tap();
  await expect(stem).toHaveValue(`${original} 移动端保存`);
  const save = editor.getByRole('button', { name: '保存题目', exact: true });
  await touchTarget(save);
  await save.tap();
  await expect(editor).toBeHidden();
  await page.setViewportSize(viewport);
  const row = page.getByRole('button', { name: new RegExp(`^${original} 移动端保存`) }).locator('..');
  await editQuestion(page, row.getByRole('button', {name:/^题目更多操作/}));
  await expect(stem).toHaveValue(`${original} 移动端保存`);
  await expect(maximum).toHaveValue('180');
  await page.screenshot({ path: testInfo.outputPath('android-saved-editor.png'), fullPage: true });
  const close = editor.getByRole('button', { name: '关闭', exact: true });
  await touchTarget(close);
  await close.tap();
  await expect(editor).toBeHidden();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});
