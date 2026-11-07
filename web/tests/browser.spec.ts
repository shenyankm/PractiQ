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
