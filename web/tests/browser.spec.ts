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
