import { expect, test } from "playwright/test";

test("Web entry is administrator-only even when registration is enabled", async ({ page }) => {
  const mutations: string[] = [];
  await page.route("**/api/**", async route => {
    if (route.request().method() !== "GET") mutations.push(route.request().url());
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ user: null, csrf: "fixture", registrationEnabled: true }) });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "管理员登录 PractiQ" })).toBeVisible();
  await expect(page.getByRole("link", { name: "注册账户" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "个人导航" })).toHaveCount(0);
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
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const data = path === "/api/auth/session" ? { user: { id: "admin", email: "admin@example.test", name: "", role: "admin", enabled: true }, csrf: "fixture", registrationEnabled: true } : [];
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
  });
  await page.goto("/admin");
  const navigation = page.getByRole("navigation", { name: "管理导航" });
  await expect(navigation).toBeVisible();
  await navigation.getByRole("button", { name: "审计", exact: true }).click();
  await expect(page.getByRole("heading", { name: "审计记录" })).toBeVisible();
  await expect(page.getByRole("link", { name: "用户区", exact: true })).toHaveCount(0);
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
  await page.getByRole('navigation', { name: '管理导航' }).getByRole('button', { name: '运行状态', exact: true }).click(); await expect(page.getByText('未接入外部状态')).toBeVisible();
  for (const [width, theme] of [[1440, 'light'], [1024, 'dark'], [800, 'light']] as const) {
    await page.setViewportSize({ width, height: 1040 }); await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    await expect(page.getByRole('navigation', { name: '管理导航' }).getByRole('button', { name: '运行状态', exact: true })).toHaveCSS('color', theme === 'dark' ? 'rgb(147, 197, 253)' : 'rgb(29, 78, 216)');
    await page.screenshot({ path: testInfo.outputPath(`admin-operations-${width}-${theme}.png`), fullPage: true });
    await testInfo.attach(`navigation-${width}-${theme}.json`, { body: JSON.stringify(await page.getByRole('navigation', { name: '管理导航' }).evaluate(nav => { const button = nav.querySelector('button')!; const computed = getComputedStyle(button); return { color: computed.color, background: computed.backgroundColor, foreground: computed.getPropertyValue('--foreground'), accentForeground: computed.getPropertyValue('--accent-foreground') }; })), contentType: 'application/json' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
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
