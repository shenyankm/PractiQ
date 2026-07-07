import 'server-only';

import { Environment, Paddle } from '@paddle/paddle-node-sdk';
import type { Transaction } from '@paddle/paddle-node-sdk';
import { ApiError } from './api';
import { invalidateUserCache } from './auth';
import { sql } from './db';
import { env } from './env';
import type { User } from './types';

export type BillingEnvironment = 'sandbox' | 'production';
export type BillingPlanKey = 'plus' | 'enterprise';
export type BillingInterval = 'month' | 'year';
export type BillingStatus = 'inactive' | 'trialing' | 'active' | 'past_due' | 'canceled';
export type BillingSource = 'free' | 'paddle';
export type BillingMembership = User['membership'];

export interface BillingPlan {
  planKey: BillingPlanKey;
  label: string;
  priceId: string;
  amountCents: number;
  currencyCode: string;
  interval: BillingInterval;
  trialDays: number | null;
}

export interface BillingConfig {
  configured: boolean;
  environment: BillingEnvironment;
  plans: BillingPlan[];
}

export interface BillingSubscription {
  membership: BillingMembership;
  status: BillingStatus;
  source: BillingSource;
  currentPeriodEndsAt: string | null;
  paddleSubscriptionId: string | null;
  paddleTransactionId: string | null;
  paddlePriceId: string | null;
}

export interface BillingSummary {
  billing: BillingConfig & {
    subscription: BillingSubscription;
  };
}

export interface BillingCheckout {
  transactionId: string;
  clientToken: string;
  environment: BillingEnvironment;
}

export interface BillingCheckoutResponse {
  checkout: BillingCheckout;
}

export interface BillingSubscriptionRow {
  membership: BillingMembership;
  status: BillingStatus;
  source: BillingSource;
  paddle_subscription_id: string | null;
  paddle_transaction_id: string | null;
  paddle_price_id: string | null;
  current_period_ends_at: string | Date | null;
}

interface BillingStateRow extends BillingSubscriptionRow {
  user_id: number;
  paddle_customer_id: string | null;
  current_period_starts_at: string | Date | null;
  scheduled_change_action: string | null;
  scheduled_change_effective_at: string | Date | null;
  raw_payload: unknown;
}

interface PaddleWebhookEvent {
  eventType: string;
  data: Record<string, unknown>;
}

interface PaddleSubscriptionPayload {
  userId: number;
  membership: BillingPlanKey;
  status: BillingStatus;
  customerId: string | null;
  subscriptionId: string | null;
  transactionId: string | null;
  priceId: string | null;
  currentPeriodStartsAt: string | null;
  currentPeriodEndsAt: string | null;
  scheduledChangeAction: string | null;
  scheduledChangeEffectiveAt: string | null;
  rawPayload: Record<string, unknown>;
}

interface PaddleTransactionPayload {
  userId: number;
  membership: BillingPlanKey;
  customerId: string | null;
  transactionId: string;
  priceId: string | null;
  rawPayload: Record<string, unknown>;
}

function parseBillingEnvironment(value: string | undefined): BillingEnvironment {
  return value === 'production' ? 'production' : 'sandbox';
}

function parsePositiveInteger(value: string | undefined, variableName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ApiError(500, 'BILLING_CONFIG_INVALID', `${variableName} must be a positive integer`);
  }
  return parsed;
}

function parseOptionalNonNegativeInteger(value: string | undefined, variableName: string): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ApiError(500, 'BILLING_CONFIG_INVALID', `${variableName} must be a non-negative integer`);
  }
  return parsed;
}

function parseCurrencyCode(value: string | undefined, variableName: string) {
  const code = (value || 'USD').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new ApiError(500, 'BILLING_CONFIG_INVALID', `${variableName} must be a 3-letter currency code`);
  }
  return code;
}

function parseInterval(value: string | undefined, variableName: string): BillingInterval {
  if (!value || value === 'month' || value === 'year') return (value || 'month') as BillingInterval;
  throw new ApiError(500, 'BILLING_CONFIG_INVALID', `${variableName} must be month or year`);
}

function buildPlan(
  planKey: BillingPlanKey,
  options: {
    label: string | undefined;
    priceId: string | undefined;
    amountCents: string | undefined;
    currencyCode: string | undefined;
    interval: string | undefined;
    trialDays: string | undefined;
    fallbackLabel: string;
  }
): BillingPlan {
  return {
    planKey,
    label: (options.label || options.fallbackLabel).trim(),
    priceId: (options.priceId || '').trim(),
    amountCents: parsePositiveInteger(options.amountCents, `PADDLE_${planKey.toUpperCase()}_AMOUNT_CENTS`),
    currencyCode: parseCurrencyCode(options.currencyCode, `PADDLE_${planKey.toUpperCase()}_CURRENCY_CODE`),
    interval: parseInterval(options.interval, `PADDLE_${planKey.toUpperCase()}_INTERVAL`),
    trialDays: parseOptionalNonNegativeInteger(options.trialDays, `PADDLE_${planKey.toUpperCase()}_TRIAL_DAYS`)
  };
}

export function getBillingConfig(): BillingConfig {
  const plans = [
    buildPlan('plus', {
      label: env.PADDLE_PLUS_LABEL,
      priceId: env.PADDLE_PLUS_PRICE_ID,
      amountCents: env.PADDLE_PLUS_AMOUNT_CENTS || '1900',
      currencyCode: env.PADDLE_PLUS_CURRENCY_CODE || 'USD',
      interval: env.PADDLE_PLUS_INTERVAL || 'month',
      trialDays: env.PADDLE_PLUS_TRIAL_DAYS || '7',
      fallbackLabel: 'Plus'
    }),
    buildPlan('enterprise', {
      label: env.PADDLE_ENTERPRISE_LABEL,
      priceId: env.PADDLE_ENTERPRISE_PRICE_ID,
      amountCents: env.PADDLE_ENTERPRISE_AMOUNT_CENTS || '9900',
      currencyCode: env.PADDLE_ENTERPRISE_CURRENCY_CODE || 'USD',
      interval: env.PADDLE_ENTERPRISE_INTERVAL || 'year',
      trialDays: env.PADDLE_ENTERPRISE_TRIAL_DAYS || '14',
      fallbackLabel: 'Enterprise'
    })
  ];

  return {
    configured: Boolean(
      env.PADDLE_API_KEY
        && env.PADDLE_CLIENT_TOKEN
        && env.PADDLE_WEBHOOK_SECRET
        && plans.every((plan) => Boolean(plan.priceId))
    ),
    environment: parseBillingEnvironment(env.PADDLE_ENVIRONMENT),
    plans
  };
}

function getPaddleClient() {
  const apiKey = env.PADDLE_API_KEY;
  if (!apiKey) {
    throw new ApiError(500, 'BILLING_NOT_CONFIGURED', 'Paddle API key is not configured');
  }

  return new Paddle(apiKey, {
    environment: getBillingConfig().environment === 'production' ? Environment.production : Environment.sandbox
  });
}

function requireConfiguredBilling() {
  const config = getBillingConfig();
  if (!config.configured || !env.PADDLE_CLIENT_TOKEN) {
    throw new ApiError(503, 'BILLING_NOT_CONFIGURED', 'Paddle billing is not configured');
  }
  return config;
}

function toIsoString(value: string | Date | null | undefined) {
  if (!value) return null;
  return new Date(value).toISOString();
}

function normalizeBillingStatus(status: string | null | undefined): BillingStatus {
  if (status === 'active' || status === 'trialing' || status === 'past_due') return status;
  if (status === 'inactive') return 'inactive';
  return 'canceled';
}

function keepsPaidAccess(status: BillingStatus, currentPeriodEndsAt: string | null) {
  if (status === 'active' || status === 'trialing' || status === 'past_due') return true;
  if (!currentPeriodEndsAt) return false;
  return new Date(currentPeriodEndsAt).getTime() > Date.now();
}

function userMembershipFromState(membership: BillingMembership, status: BillingStatus, currentPeriodEndsAt: string | null): BillingMembership {
  return keepsPaidAccess(status, currentPeriodEndsAt) ? membership : 'free';
}

export function planKeyForPriceId(priceId: string | null | undefined): BillingPlanKey | null {
  if (!priceId) return null;
  const match = getBillingConfig().plans.find((plan) => plan.priceId === priceId);
  return match?.planKey ?? null;
}

export function normalizeBillingSubscription(userMembership: BillingMembership, row: BillingSubscriptionRow | null): BillingSubscription {
  if (!row) {
    return {
      membership: userMembership,
      status: userMembership === 'free' ? 'inactive' : 'active',
      source: userMembership === 'free' ? 'free' : 'paddle',
      currentPeriodEndsAt: null,
      paddleSubscriptionId: null,
      paddleTransactionId: null,
      paddlePriceId: null
    };
  }

  return {
    membership: row.membership,
    status: row.status,
    source: row.source,
    currentPeriodEndsAt: toIsoString(row.current_period_ends_at),
    paddleSubscriptionId: row.paddle_subscription_id,
    paddleTransactionId: row.paddle_transaction_id,
    paddlePriceId: row.paddle_price_id
  };
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readItems(value: unknown) {
  return Array.isArray(value) ? value.map((item) => readObject(item)).filter(Boolean) as Record<string, unknown>[] : [];
}

function readUserId(value: unknown) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

function firstPriceId(data: Record<string, unknown>) {
  return readString(readItems(data.items)[0]?.priceId);
}

async function findExistingBillingRow(keys: {
  userId?: number | null;
  subscriptionId?: string | null;
  customerId?: string | null;
}) {
  if (keys.userId) {
    const rows = await sql<BillingStateRow[]>`
      SELECT user_id, membership, status, source, paddle_subscription_id, paddle_transaction_id,
             paddle_customer_id, paddle_price_id, current_period_starts_at, current_period_ends_at,
             scheduled_change_action, scheduled_change_effective_at, raw_payload
      FROM billing_subscriptions
      WHERE user_id = ${keys.userId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  if (keys.subscriptionId) {
    const rows = await sql<BillingStateRow[]>`
      SELECT user_id, membership, status, source, paddle_subscription_id, paddle_transaction_id,
             paddle_customer_id, paddle_price_id, current_period_starts_at, current_period_ends_at,
             scheduled_change_action, scheduled_change_effective_at, raw_payload
      FROM billing_subscriptions
      WHERE paddle_subscription_id = ${keys.subscriptionId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  if (keys.customerId) {
    const rows = await sql<BillingStateRow[]>`
      SELECT user_id, membership, status, source, paddle_subscription_id, paddle_transaction_id,
             paddle_customer_id, paddle_price_id, current_period_starts_at, current_period_ends_at,
             scheduled_change_action, scheduled_change_effective_at, raw_payload
      FROM billing_subscriptions
      WHERE paddle_customer_id = ${keys.customerId}
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  return null;
}

async function upsertBillingState(payload: PaddleSubscriptionPayload | PaddleTransactionPayload) {
  await sql.begin(async (tx) => {
    if ('status' in payload) {
      await tx`
        INSERT INTO billing_subscriptions (
          user_id, membership, status, source, paddle_subscription_id, paddle_transaction_id,
          paddle_customer_id, paddle_price_id, current_period_starts_at, current_period_ends_at,
          scheduled_change_action, scheduled_change_effective_at, raw_payload
        )
        VALUES (
          ${payload.userId}, ${payload.membership}, ${payload.status}, 'paddle', ${payload.subscriptionId}, ${payload.transactionId},
          ${payload.customerId}, ${payload.priceId}, ${payload.currentPeriodStartsAt}, ${payload.currentPeriodEndsAt},
          ${payload.scheduledChangeAction}, ${payload.scheduledChangeEffectiveAt}, ${tx.json(payload.rawPayload as never)}
        )
        ON CONFLICT (user_id) DO UPDATE SET
          membership = EXCLUDED.membership,
          status = EXCLUDED.status,
          source = EXCLUDED.source,
          paddle_subscription_id = COALESCE(EXCLUDED.paddle_subscription_id, billing_subscriptions.paddle_subscription_id),
          paddle_transaction_id = COALESCE(EXCLUDED.paddle_transaction_id, billing_subscriptions.paddle_transaction_id),
          paddle_customer_id = COALESCE(EXCLUDED.paddle_customer_id, billing_subscriptions.paddle_customer_id),
          paddle_price_id = COALESCE(EXCLUDED.paddle_price_id, billing_subscriptions.paddle_price_id),
          current_period_starts_at = COALESCE(EXCLUDED.current_period_starts_at, billing_subscriptions.current_period_starts_at),
          current_period_ends_at = COALESCE(EXCLUDED.current_period_ends_at, billing_subscriptions.current_period_ends_at),
          scheduled_change_action = EXCLUDED.scheduled_change_action,
          scheduled_change_effective_at = EXCLUDED.scheduled_change_effective_at,
          raw_payload = EXCLUDED.raw_payload
      `;

      const nextMembership = userMembershipFromState(payload.membership, payload.status, payload.currentPeriodEndsAt);
      const nextExpiry = nextMembership === 'free' ? null : payload.currentPeriodEndsAt;
      await tx`
        UPDATE users
        SET membership = ${nextMembership},
            plus_expires_at = ${nextExpiry}
        WHERE id = ${payload.userId}
      `;
      return;
    }

    await tx`
      INSERT INTO billing_subscriptions (
        user_id, membership, status, source, paddle_transaction_id, paddle_customer_id,
        paddle_price_id, raw_payload
      )
      VALUES (
        ${payload.userId}, ${payload.membership}, 'inactive', 'paddle', ${payload.transactionId}, ${payload.customerId},
        ${payload.priceId}, ${tx.json(payload.rawPayload as never)}
      )
      ON CONFLICT (user_id) DO UPDATE SET
        membership = EXCLUDED.membership,
        source = EXCLUDED.source,
        paddle_transaction_id = EXCLUDED.paddle_transaction_id,
        paddle_customer_id = COALESCE(EXCLUDED.paddle_customer_id, billing_subscriptions.paddle_customer_id),
        paddle_price_id = COALESCE(EXCLUDED.paddle_price_id, billing_subscriptions.paddle_price_id),
        raw_payload = EXCLUDED.raw_payload
    `;
  });

  await invalidateUserCache(payload.userId);
}

async function subscriptionPayloadFromEvent(data: Record<string, unknown>): Promise<PaddleSubscriptionPayload | null> {
  const subscriptionId = readString(data.id);
  const customerId = readString(data.customerId);
  const priceId = firstPriceId(data);
  const membership = planKeyForPriceId(priceId) ?? readString(readObject(data.customData)?.planKey) as BillingPlanKey | null;
  const customData = readObject(data.customData);
  const period = readObject(data.currentBillingPeriod);
  const scheduledChange = Array.isArray(data.scheduledChanges) ? readObject(data.scheduledChanges[0]) : null;
  const row = await findExistingBillingRow({
    userId: readUserId(customData?.userId),
    subscriptionId,
    customerId
  });
  const userId = readUserId(customData?.userId) ?? row?.user_id ?? null;

  if (!userId || !membership) return null;

  return {
    userId,
    membership,
    status: normalizeBillingStatus(readString(data.status)),
    customerId,
    subscriptionId,
    transactionId: readString(data.transactionId),
    priceId,
    currentPeriodStartsAt: toIsoString(period?.startsAt as string | null | undefined),
    currentPeriodEndsAt: toIsoString((period?.endsAt as string | null | undefined) ?? readString(data.nextBilledAt)),
    scheduledChangeAction: readString(scheduledChange?.action),
    scheduledChangeEffectiveAt: toIsoString(scheduledChange?.effectiveAt as string | null | undefined),
    rawPayload: data
  };
}

async function transactionPayloadFromEvent(data: Record<string, unknown>): Promise<PaddleTransactionPayload | null> {
  const customData = readObject(data.customData);
  const row = await findExistingBillingRow({
    userId: readUserId(customData?.userId),
    subscriptionId: readString(data.subscriptionId),
    customerId: readString(data.customerId)
  });
  const userId = readUserId(customData?.userId) ?? row?.user_id ?? null;
  const priceId = firstPriceId(data);
  const membership = planKeyForPriceId(priceId) ?? readString(customData?.planKey) as BillingPlanKey | null;
  const transactionId = readString(data.id);

  if (!userId || !membership || !transactionId) return null;

  return {
    userId,
    membership,
    customerId: readString(data.customerId),
    transactionId,
    priceId,
    rawPayload: data
  };
}

export async function getBillingSummary(user: User): Promise<BillingSummary> {
  const rows = await sql<BillingSubscriptionRow[]>`
    SELECT membership, status, source, paddle_subscription_id, paddle_transaction_id, paddle_price_id, current_period_ends_at
    FROM billing_subscriptions
    WHERE user_id = ${user.id}
    LIMIT 1
  `;

  return {
    billing: {
      ...getBillingConfig(),
      subscription: normalizeBillingSubscription(user.membership, rows[0] ?? null)
    }
  };
}

export async function createBillingCheckout(user: User, planKey: BillingPlanKey): Promise<BillingCheckoutResponse> {
  const config = requireConfiguredBilling();
  const plan = config.plans.find((item) => item.planKey === planKey);
  if (!plan || !plan.priceId) {
    throw new ApiError(422, 'INVALID_PLAN', 'Unknown paid plan');
  }

  const transaction = await getPaddleClient().transactions.create({
    items: [{ priceId: plan.priceId, quantity: 1 }],
    collectionMode: 'automatic',
    customData: {
      userId: user.id,
      planKey
    }
  }) as Transaction;

  await upsertBillingState({
    userId: user.id,
    membership: planKey,
    customerId: readString(transaction.customerId),
    transactionId: transaction.id,
    priceId: plan.priceId,
    rawPayload: transaction as unknown as Record<string, unknown>
  });

  return {
    checkout: {
      transactionId: transaction.id,
      clientToken: env.PADDLE_CLIENT_TOKEN!,
      environment: config.environment
    }
  };
}

export async function handleBillingWebhook(rawBody: string, signature: string | null) {
  if (!signature) {
    throw new ApiError(400, 'PADDLE_SIGNATURE_MISSING', 'Missing paddle-signature header');
  }

  const webhookSecret = env.PADDLE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new ApiError(500, 'BILLING_NOT_CONFIGURED', 'Paddle webhook secret is not configured');
  }

  const event = await getPaddleClient().webhooks.unmarshal(rawBody, webhookSecret, signature) as unknown as PaddleWebhookEvent;
  if (event.eventType.startsWith('subscription.')) {
    const payload = await subscriptionPayloadFromEvent(event.data);
    if (payload) {
      await upsertBillingState(payload);
    }
    return;
  }

  if (event.eventType.startsWith('transaction.')) {
    const payload = await transactionPayloadFromEvent(event.data);
    if (payload) {
      await upsertBillingState(payload);
    }
  }
}
