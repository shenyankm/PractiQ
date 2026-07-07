import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { hash } from '@node-rs/bcrypt';
import { SignJWT } from 'jose';
import postgres from 'postgres';

const runIntegration = process.env.OPENWOOK_ALLOW_INTEGRATION_TESTS === '1';
const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL || 'postgres://test:test@127.0.0.1:5432/openwook_test';
const appUrl = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';
const db = postgres(databaseUrl, { max: 1 });
const unique = `pw${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
const userIds: number[] = [];
const bankIds: number[] = [];

type E2eUser = {
  id: number;
  username: string;
  email: string | null;
  avatar_url: string | null;
  is_active: boolean;
  role: 'admin' | 'user';
  membership: 'free' | 'plus';
  plus_trial_ends_at: string | null;
  plus_expires_at: string | null;
  created_at: string;
  updated_at: string;
};

async function createE2eUser() {
  const password = await hash('openwook123', 4);
  const rows = await db<E2eUser[]>`
    INSERT INTO users (username, email, password, role, membership, plus_trial_ends_at, plus_expires_at)
    VALUES (
      ${`${unique}_user`},
      ${`${unique}_user@example.test`},
      ${password},
      'user',
      'free',
      NOW() + INTERVAL '1 day',
      NULL
    )
    RETURNING id, username, email, avatar_url, is_active, role, membership, plus_trial_ends_at, plus_expires_at, created_at, updated_at
  `;
  userIds.push(rows[0].id);
  return rows[0];
}

async function createE2eBank(user: E2eUser) {
  const bankRows = await db<Array<{ id: number }>>`
    INSERT INTO question_banks (name, description, subject, created_by, is_public)
    VALUES (${`${unique} bank`}, ${'Playwright smoke bank'}, ${'math'}, ${user.id}, false)
    RETURNING id
  `;
  const bankId = bankRows[0].id;
  bankIds.push(bankId);
  await db`
    INSERT INTO user_bank_links (user_id, bank_id, is_owner)
    VALUES (${user.id}, ${bankId}, true)
  `;
  return bankId;
}

async function sessionCookie(userId: number) {
  const secret = new TextEncoder().encode(process.env.AUTH_SECRET || 'test-auth-secret-for-vitest-only');
  const token = await new SignJWT({
    user: { id: userId },
    expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    jti: randomUUID()
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1 hour')
    .sign(secret);

  return {
    name: 'session',
    value: token,
    url: appUrl,
    httpOnly: true,
    sameSite: 'Lax' as const,
    secure: false
  };
}

test.afterAll(async () => {
  if (runIntegration) {
    if (bankIds.length) {
      await db`DELETE FROM question_banks WHERE id = ANY(${db.array(bankIds)}::bigint[])`;
    }
    if (userIds.length) {
      await db`DELETE FROM users WHERE id = ANY(${db.array(userIds)}::bigint[])`;
    }
  }
  await db.end({ timeout: 1 }).catch(() => {});
});

test('auth redirect sends unauthenticated dashboard traffic to sign-in', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/sign-in/);
});

test('bank detail links point to normalized practice/manage/import URLs', async ({ browser }) => {
  test.skip(!runIntegration, 'requires OPENWOOK_ALLOW_INTEGRATION_TESTS=1 with a live database');

  const user = await createE2eUser();
  const bankId = await createE2eBank(user);
  const context = await browser.newContext();
  await context.addCookies([await sessionCookie(user.id)]);
  const page = await context.newPage();

  await page.goto(`/banks/${bankId}`);
  await expect(page.getByRole('link', { name: '开始练习' })).toHaveAttribute('href', `/banks/${bankId}/practice`);
  await expect(page.getByRole('link', { name: '管理题目' })).toHaveAttribute('href', `/banks/${bankId}/manage`);
  await expect(page.getByRole('link', { name: '导入题目' }).first()).toHaveAttribute('href', `/imports?bankId=${bankId}`);

  await context.close();
});

test('settings password form shows validation feedback without crashing', async ({ browser }) => {
  test.skip(!runIntegration, 'requires OPENWOOK_ALLOW_INTEGRATION_TESTS=1 with a live database');

  const user = await createE2eUser();
  const context = await browser.newContext();
  await context.addCookies([await sessionCookie(user.id)]);
  const page = await context.newPage();

  await page.goto('/settings');
  await page.getByRole('tab', { name: '安全' }).click();
  await page.getByLabel('当前密码').fill('openwook123');
  await page.getByLabel('新密码').fill('next-password-123');
  await page.getByLabel('确认新密码').fill('mismatch-password-456');
  await page.getByRole('button', { name: '更新密码' }).click();
  await expect(page.getByText('两次输入的新密码不一致。')).toBeVisible();

  await context.close();
});
