import { expect, test } from "playwright/test";

test("administrator empty states fill the remaining area and account forms align", async ({ page }, testInfo) => {
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify(new URL(route.request().url()).pathname === "/api/auth/session" ? { user: { id: "admin", email: "admin@example.test", name: "", role: "admin", enabled: true }, csrf: "fixture", registrationEnabled: true } : []) }));
  await page.setViewportSize({ width: 2048, height: 1100 });
  await page.goto("/admin#audit");
  const empty = page.getByText("没有匹配的审计记录。", { exact: true }); await expect(empty).toBeVisible();
  const geometry = await empty.evaluate(element => {
    const main = element.closest("main")!, filters = main.querySelector(".admin-filters")!;
    const mainBox = main.getBoundingClientRect(), filterBox = filters.getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(element); const text = range.getBoundingClientRect();
    return { x: text.x + text.width / 2, y: text.y + text.height / 2, targetX: mainBox.x + main.clientWidth / 2, targetY: (filterBox.bottom + parseFloat(getComputedStyle(filters).marginBottom) + mainBox.y + main.clientHeight - parseFloat(getComputedStyle(main).paddingBottom)) / 2 };
  });
  expect(Math.abs(geometry.x - geometry.targetX)).toBeLessThan(1); expect(Math.abs(geometry.y - geometry.targetY)).toBeLessThan(1);
  await page.screenshot({ path: testInfo.outputPath("centered-audit-empty.png") });
  await page.getByRole("button", { name: "更多筛选", exact: true }).click();
  for (const width of [2048, 1024, 800]) {
    await page.setViewportSize({ width, height: 1100 });
    const apply = (await page.getByRole("button", { name: "应用筛选", exact: true }).boundingBox())!;
    const clear = (await page.getByRole("button", { name: "清除筛选", exact: true }).boundingBox())!;
    const collapse = (await page.getByRole("button", { name: "收起筛选", exact: true }).boundingBox())!;
    expect(apply.y).toBe(clear.y); expect(clear.y).toBe(collapse.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`expanded-audit-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole("navigation", { name: "管理导航" }).getByRole("button", { name: "账户与安全", exact: true }).click();
  const profile = page.locator(".account-settings-profile"), tokens = page.locator(".account-settings-tokens");
  await expect(profile).toBeVisible(); await expect(tokens.getByText("暂无记录。", { exact: true })).toBeVisible();
  expect(Math.abs((await profile.boundingBox())!.height - (await tokens.boundingBox())!.height)).toBeLessThan(1);
  const save = (await page.getByRole("button", { name: "保存账户信息", exact: true }).boundingBox())!;
  const revoke = (await page.getByRole("button", { name: "撤销指定令牌", exact: true }).boundingBox())!;
  expect(Math.abs(save.y - revoke.y)).toBeLessThan(1);
  await page.screenshot({ path: testInfo.outputPath("aligned-account-forms.png") });
});

test("Web entry is administrator-only even when registration is enabled", async ({ page }, testInfo) => {
  const mutations: string[] = [];
  await page.route("**/api/**", async route => {
    if (route.request().method() !== "GET") mutations.push(route.request().url());
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ user: null, csrf: "fixture", registrationEnabled: true }) });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "登录管理后台" })).toBeVisible();
  await expect(page.getByRole("link", { name: "注册账户" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "个人导航" })).toHaveCount(0);
  for (const [width, height, dark] of [[2048, 1040, false], [1440, 900, true], [390, 844, false], [800, 360, false]] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate(dark => document.documentElement.classList.toggle("dark", dark), dark);
    const card = await page.locator(".account-card").boundingBox();
    const header = await page.locator(".account-header").boundingBox();
    expect(card).not.toBeNull(); expect(header).not.toBeNull();
    expect(Math.abs(card!.x + card!.width / 2 - width / 2)).toBeLessThan(1);
    if (card!.height + 64 < height - header!.height) {
      expect(Math.abs(card!.y + card!.height / 2 - (header!.height + height) / 2)).toBeLessThan(1);
    } else expect(card!.y).toBeGreaterThanOrEqual(header!.height + 32);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`admin-login-${width}-${height}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("link", { name: "PractiQ 管理" }).focus();
  await page.keyboard.press("Tab"); await expect(page.getByLabel("登录邮箱", { exact: true })).toBeFocused();
  await page.keyboard.press("Tab"); await expect(page.getByLabel("密码", { exact: true })).toBeFocused();
  await page.keyboard.press("Tab"); await expect(page.getByRole("button", { name: "登录", exact: true })).toBeFocused();
  expect(mutations).toEqual([]);
});

test("an ordinary account cannot enter the Web administration area", async ({ page }) => {
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: JSON.stringify({ user: { id: "user", email: "user@example.test", name: "", role: "user", enabled: true }, csrf: "fixture", registrationEnabled: true }) }));
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("没有管理权限");
  await expect(page.getByRole("navigation", { name: "个人导航" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "管理导航" })).toHaveCount(0);
});

test("administrators can navigate the retained console without user-area links", async ({ page }) => {
  let signedIn = true; const writes: string[] = [];
  const { adminUserDetail } = await import('../src/test-fixtures');
  const userRow = { id: 'admin', email: 'admin@example.test', name: '', role: 'admin' as const, enabled: true, limits: { freePages: 50 }, created_at: '2026-11-10T00:00:00Z' };
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") { writes.push(path); if (path === "/api/auth/logout") signedIn = false; }
    const data = path === "/api/admin/users" ? [userRow] : path === "/api/admin/users/admin" ? adminUserDetail(userRow) : path === "/api/admin/settings" ? { registrationEnabled: true, freePages: 50, modelCalls: 1000, tencentCalls: 50, activeTasks: 1 } : path === "/api/auth/session" ? { user: signedIn ? { id: "admin", email: "admin@example.test", name: "", role: "admin", enabled: true } : null, csrf: "fixture", registrationEnabled: true } : path === "/api/admin/audit" ? [{ id: 1, actor: "admin", actorEmail: "admin@example.test", action: "settings_update", target: "a-very-long-administration-target-for-spacing", created_at: "2026-11-10T00:00:00Z", detail: { reason: "fixture", before: { freePages: 50 }, after: { freePages: 75 } } }] : [];
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
  });
  await page.goto("/admin");
  const navigation = page.getByRole("navigation", { name: "管理导航" });
  await expect(navigation).toBeVisible();
  await expect(page.getByText('50 页', { exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '记录分页', exact: true })).toHaveCount(0);
  const inspect = page.getByRole('button', { name: '查看详情', exact: true }); await inspect.click();
  const userDialog = page.getByRole('dialog', { name: '用户信息', exact: true }); await expect(userDialog).toBeVisible();
  await expect(userDialog.getByRole('heading', { name: '用户详情', exact: true })).toBeVisible();
  await expect(page.locator('main .admin-section')).toHaveCount(0); expect(writes).toEqual([]);
  await userDialog.getByRole('button', { name: '关闭', exact: true }).click(); await expect(inspect).toBeFocused();
  const issue = page.getByRole("combobox", { name: "待处理类型", exact: true });
  await issue.click(); await expect(page.getByRole("listbox")).toHaveAttribute("data-slot", "select-content");
  await page.getByRole("option", { name: "识别页数已耗尽", exact: true }).click(); await expect(issue).toContainText("识别页数已耗尽");
  await issue.click(); await expect(page.getByRole("listbox")).toBeVisible(); await page.keyboard.press("Home");
  await expect(page.getByRole("option", { name: "全部", exact: true })).toBeFocused(); await page.keyboard.press("Enter"); await expect(issue).toContainText("全部");
  await navigation.getByRole("button", { name: "审计", exact: true }).click();
  await expect(page.getByRole("heading", { name: "审计记录" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "审计记录" })).toBeVisible();
  await expect(page.getByRole("link", { name: "用户区", exact: true })).toHaveCount(0);
  await page.goBack(); await expect(navigation.getByRole("button", { name: "用户", exact: true })).toHaveAttribute("aria-current", "page");
  await page.goForward(); await expect(navigation.getByRole("button", { name: "审计", exact: true })).toHaveAttribute("aria-current", "page");
  const row = page.locator(".account-table tbody tr").first(), height = (await row.boundingBox())!.height;
  await expect(row.getByRole('button', { name: 'admin@example.test', exact: true })).toBeVisible();
  await row.getByRole("button", { name: "查看详情" }).click(); const detail = page.getByRole("dialog", { name: "审计详情" }); await expect(detail).toBeVisible();
  await expect(detail.getByText("75", { exact: true })).toBeVisible(); expect((await row.boundingBox())!.height).toBe(height);
  await page.keyboard.press("Escape"); await expect(detail).toHaveCount(0); await expect(row.getByRole("button", { name: "查看详情" })).toBeFocused();
  const logout = page.getByRole("button", { name: "退出登录", exact: true }); await logout.click();
  const confirmation = page.getByRole("alertdialog", { name: "确认退出登录？" }); await expect(confirmation).toBeVisible();
  await expect(confirmation.getByRole("button", { name: "取消", exact: true })).toBeFocused(); await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  await expect(logout).toBeFocused(); expect(writes).toEqual([]);
  await logout.click(); await page.keyboard.press("Escape"); await expect(confirmation).toHaveCount(0); expect(writes).toEqual([]);
  await logout.click(); await confirmation.getByRole("button", { name: "确认退出", exact: true }).click();
  await expect(page.getByRole("heading", { name: "登录管理后台", exact: true })).toBeVisible(); expect(writes).toEqual(["/api/auth/logout"]);
});

test('administrator order inspection keeps refund submission explicit',async({page},testInfo)=>{
  const id='a'.repeat(32),refundId='11111111-1111-4111-8111-111111111111';let writes=0;
  const order={id,requestId:refundId,ownerId:'customer',createdAt:'2026-11-09T00:00:00Z',state:'PAID',amount:'39.00',subject:'Plus test order',environment:'production',refunds:[] as {id:string;amount:string;state:string}[],productId:'plus',providerClosed:false,grant:{orderId:id,productId:'plus',state:'active',totalPages:100,usedPages:0,remainingPages:100,expiresAt:'2026-12-09T00:00:00Z'}};
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    let value:unknown=[];
    if(path==='/api/auth/session') value={user:{id:'admin',email:'admin@example.test',name:'',role:'admin',enabled:true},csrf:'fixture',registrationEnabled:true};
    else if(path==='/api/admin/payments')value=[order];
    else if(path.endsWith('/refunds')) {writes++;const data=route.request().postDataJSON();order.refunds=[{id:data.requestId,amount:data.amount,state:'UNKNOWN'}];order.grant.state='refund_pending';value=order.refunds[0];}
    else if(path===`/api/admin/payments/${id}`)value=order;
    await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
  });
  await page.goto('/admin');await page.getByRole('navigation',{name:'管理导航'}).getByRole('button',{name:'订单与退款',exact:true}).click();
  await page.getByRole('button',{name:'查看订单 '+id}).click();expect(writes).toBe(0);
  await page.getByLabel('管理员当前密码',{exact:true}).fill('fixture-password');await page.getByLabel('退款原因').fill('Full unused refund');
  await page.screenshot({path:testInfo.outputPath('admin-refund-light.png'),fullPage:true});
  await page.getByRole('button',{name:'确认发起退款',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'退款结果待确认'})).toBeVisible();expect(writes).toBe(1);
  await page.reload();await page.getByRole('navigation',{name:'管理导航'}).getByRole('button',{name:'订单与退款',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'保留的退款请求'})).toBeVisible();expect(writes).toBe(1);
  await page.getByRole('button',{name:'查看订单 '+id}).click();await page.evaluate(()=>document.documentElement.classList.add('dark'));
  await page.screenshot({path:testInfo.outputPath('admin-refund-dark.png'),fullPage:true});
});

test('support console links balances, usage and reasoned recovery', async ({ page }, testInfo) => {
  const { adminUserDetail } = await import('../src/test-fixtures');
  let detail = adminUserDetail(); const writes: Record<string, unknown>[] = [], queries: string[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    let value: unknown = [];
    if (request.method() === 'GET') queries.push(path + url.search);
    else writes.push(request.postDataJSON());
    if (path === '/api/auth/session') value = { user: { id: 'admin', email: 'admin@example.test', name: '管理员', role: 'admin', enabled: true }, csrf: 'fixture', registrationEnabled: true };
    else if (path === '/api/admin/settings') value = { registrationEnabled: true, freePages: 50, modelCalls: 1000, tencentCalls: 50, activeTasks: 1 };
    else if (path === '/api/admin/users') value = [detail.user];
    else if (path === '/api/admin/users/alice') value = detail;
    else if (path === '/api/admin/users/alice/allowance') { detail = { ...detail, balance: { ...detail.balance, freePages: 75, freeRemainingPages: 68, remainingPages: 68 } }; value = detail; }
    else if (path === '/api/admin/usage/summary') value = { totals: { calls: 1, failedCalls: 0, unknownCalls: 1, pendingCalls: 0, pages: 7, inputTokens: 0, outputTokens: 0, unknownTokenCalls: 1 }, items: [], hasMore: false };
    else if (path === '/api/admin/calls') value = [{ call_key: 'fixture-call', user_id: 'alice', email: 'alice@example.test', scope: 'grade:example', day: '2026-11-09', kind: 'modelCalls', provider: 'fixture-model', state: 'unknown', status: 'failed', record: { error: 'MODEL_RESULT_UNKNOWN' } }];
    else if (path === '/api/admin/operations') value = { observedAt: '2026-11-09T03:00:00Z', codeVersion: 'fixture-source', schemaVersion: 8, maintenance: false, readOnly: false, accepting: true, broker: { publisher: true, consumer: true }, runs: { pending: 2, running: 1 }, outboxPending: 2, oldestPendingSeconds: 42, queueCapacity: 300, workersAvailable: 7, storageHealthy: true, storageFreeBytes: 32 * 1024 ** 3, modelId: 'fixture-model', parserConfigured: true, costCurrency: 'CNY', dailyCostLimitMicros: 20_000_000, dailyReservedMicros: 2_000_000, taskCostLimitMicros: 5_000_000, monitoringState: 'not_configured', monitoring: null };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
  });
  await page.goto('/admin'); await page.getByLabel('搜索邮箱、昵称或用户编号').fill('alice');
  await page.getByRole('button', { name: '应用筛选', exact: true }).click(); await page.getByRole('button', { name: '选择', exact: true }).click();
  await expect(page.getByRole('heading', { name: '用户详情', exact: true })).toBeVisible();
  expect(queries.some(path => path.includes('q=alice'))).toBe(true); expect(writes).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath('admin-user-detail-light.png'), fullPage: true });
  await page.getByLabel('新的免费总额度（页）').fill('75'); await page.getByLabel('调整原因').fill('补偿已确认的平台故障'); await page.locator('#allowance-password').fill('synthetic-password');
  await expect(page.getByRole('status').filter({ hasText: '全部可用页数 68 页' })).toBeVisible(); expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: '确认调整总额度', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '当前总额度 75 页' })).toBeVisible(); expect(writes).toHaveLength(1); expect(writes[0]).toMatchObject({ expectedFreePages: 50, reason: '补偿已确认的平台故障' });
  await page.getByRole('button', { name: '查看该用户用量', exact: true }).click(); await expect(page.getByText('1 次调用', { exact: true })).toBeVisible();
  expect(queries.some(path => path.startsWith('/api/admin/calls?') && path.includes('userId=alice'))).toBe(true);
  await page.getByRole('navigation', { name: '管理导航' }).getByRole('button', { name: '运行状态', exact: true }).click(); await expect(page.getByRole('heading', { name: '服务与队列', exact: true })).toBeVisible();
  for (const [width, theme] of [[1440, 'light'], [1024, 'dark'], [800, 'light']] as const) {
    await page.setViewportSize({ width, height: 1040 }); await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    await expect(page.getByRole('navigation', { name: '管理导航' }).getByRole('button', { name: '运行状态', exact: true })).toHaveCSS('color', theme === 'dark' ? 'rgb(147, 197, 253)' : 'rgb(29, 78, 216)');
    await page.screenshot({ path: testInfo.outputPath(`admin-operations-${width}-${theme}.png`), fullPage: true });
    await testInfo.attach(`navigation-${width}-${theme}.json`, { body: JSON.stringify(await page.getByRole('navigation', { name: '管理导航' }).evaluate(nav => { const button = nav.querySelector('button')!; const computed = getComputedStyle(button); return { color: computed.color, background: computed.backgroundColor, foreground: computed.getPropertyValue('--foreground'), accentForeground: computed.getPropertyValue('--accent-foreground') }; })), contentType: 'application/json' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const headerBefore = await page.locator('.account-header').boundingBox(), navBefore = await page.getByRole('navigation', { name: '管理导航' }).boundingBox();
    const scroll = await page.locator('main').evaluate(main => { main.scrollTop = 500; return { top: main.scrollTop, more: main.scrollHeight > main.clientHeight }; });
    if (scroll.more) expect(scroll.top).toBeGreaterThan(0);
    expect(await page.locator('.account-header').boundingBox()).toEqual(headerBefore); expect(await page.getByRole('navigation', { name: '管理导航' }).boundingBox()).toEqual(navBefore);
    expect(await page.evaluate(() => window.scrollY)).toBe(0); await page.locator('main').evaluate(main => { main.scrollTop = 0; });
  }
  expect(writes).toHaveLength(1);
});

test('account and administration controls share geometry after explicit session recovery', async ({ page }, testInfo) => {
  const { adminUserDetail } = await import('../src/test-fixtures');
  let sessionAvailable = false, signedIn = false;
  const writes: string[] = [];
  await page.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (req.method() !== 'GET') writes.push(path);
    const account = { user: signedIn ? { id: 'admin', name: '管理员', email: 'admin@example.test', role: 'admin', enabled: true } : null, csrf: 'fixture', registrationEnabled: true };
    let value: unknown = [];
    if (path === '/api/auth/session') {
      if (!sessionAvailable) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: { code: 'SERVICE_UNAVAILABLE' } }) });
      value = account;
    } else if (path === '/api/auth/login') { signedIn = true; value = { ...account, user: { id: 'admin', name: '管理员', email: 'admin@example.test', role: 'admin', enabled: true } }; }
    else if (path === '/api/admin/users') value = [adminUserDetail().user];
    else if (path === '/api/admin/settings') value = { registrationEnabled: true, freePages: 50, modelCalls: 1000, tencentCalls: 50, activeTasks: 1 };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
  });
  await page.goto('/admin');
  const error = page.getByRole('alert');
  await expect(error).toContainText('请求未完成，请核对状态后再决定是否重试。');
  await expect(error.locator('details')).not.toHaveAttribute('open', '');
  await expect(page.locator('.account-card')).toContainText('诊断详情');
  expect(writes).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('admin-session-error-light.png'), fullPage: true });
  sessionAvailable = true;
  await page.getByRole('button', { name: '重新读取登录状态', exact: true }).click();
  const email = page.getByLabel('登录邮箱', { exact: true });
  await expect(email).toBeVisible(); await expect(error).toHaveCount(0);
  const geometry = (element: HTMLElement) => { const style = getComputedStyle(element); return { height: element.getBoundingClientRect().height, radius: style.borderRadius, font: style.fontFamily, size: style.fontSize }; };
  const loginInput = await email.evaluate(geometry);
  const loginButton = await page.getByRole('button', { name: '登录', exact: true }).evaluate(geometry);
  await email.fill('admin@example.test'); await page.getByLabel('密码', { exact: true }).fill('synthetic-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const filters = page.getByLabel('搜索邮箱、昵称或用户编号');
  await expect(filters).toBeVisible();
  expect(await filters.evaluate(geometry)).toEqual(loginInput);
  expect(await page.getByRole('button', { name: '应用筛选', exact: true }).evaluate(geometry)).toEqual(loginButton);
  expect(await page.getByRole('button', { name: '选择', exact: true }).evaluate(geometry)).toEqual(loginButton);
  await page.getByRole('navigation', { name: '管理导航' }).getByRole('button', { name: '账户与安全', exact: true }).click();
  expect(await page.getByLabel('昵称', { exact: true }).evaluate(geometry)).toEqual(loginInput);
  expect(await page.getByRole('button', { name: '保存账户信息', exact: true }).evaluate(geometry)).toEqual(loginButton);
  for (const [width, theme] of [[1440, 'light'], [1024, 'dark'], [800, 'dark']] as const) {
    await page.setViewportSize({ width, height: 1040 });
    await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    await expect(page.getByRole('heading', { name: '账户与安全', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`consistent-account-${width}-${theme}.png`), fullPage: true });
  }
  expect(writes).toEqual(['/api/auth/login']);
});
