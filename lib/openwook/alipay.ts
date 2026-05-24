import 'server-only';

import { randomUUID } from 'node:crypto';
import { AlipaySdk } from 'alipay-sdk';
import type postgres from 'postgres';
import { ApiError } from './api';
import { invalidateUserCache } from './auth';
import { sql } from './db';
import type { User } from './types';

const alipayGateway = process.env.ALIPAY_GATEWAY || 'https://openapi-sandbox.dl.alipaydev.com/gateway.do';
const paidTradeStatuses = new Set(['TRADE_SUCCESS', 'TRADE_FINISHED']);

type AlipayOrderRow = {
  id: number;
  user_id: number;
  out_trade_no: string;
  trade_no: string | null;
  product_code: string;
  subject: string;
  amount_cents: number;
  currency: string;
  status: 'created' | 'paying' | 'paid' | 'closed' | 'failed';
  alipay_trade_status: string | null;
  membership_start_at: string | Date | null;
  membership_end_at: string | Date | null;
  paid_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type AlipayNotifyParams = Record<string, string>;

export function getPlusMonthlyPlan() {
  const amountCents = Number(process.env.ALIPAY_PLUS_MONTHLY_AMOUNT_CENTS || 1900);
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new ApiError(500, 'ALIPAY_PLAN_INVALID', 'ALIPAY_PLUS_MONTHLY_AMOUNT_CENTS must be a positive integer');
  }

  return {
    productCode: 'openwook_plus_monthly',
    subject: process.env.ALIPAY_PLUS_MONTHLY_SUBJECT || 'OpenWook Plus 月付套餐',
    amountCents,
    amount: formatCnyAmount(amountCents),
    durationMonths: 1
  };
}

export function isAlipayConfigured() {
  return Boolean(
    process.env.ALIPAY_APP_ID
      && process.env.ALIPAY_PRIVATE_KEY
      && process.env.ALIPAY_PUBLIC_KEY
  );
}

export async function getAlipayBillingSummary(user: User) {
  const rows = await sql<AlipayOrderRow[]>`
    SELECT
      id, user_id, out_trade_no, trade_no, product_code, subject, amount_cents,
      currency, status, alipay_trade_status, membership_start_at,
      membership_end_at, paid_at, created_at, updated_at
    FROM alipay_payment_orders
    WHERE user_id = ${user.id}
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `;

  return {
    configured: isAlipayConfigured(),
    plan: getPlusMonthlyPlan(),
    latestOrder: rows[0] ?? null
  };
}

export async function createAlipayCheckout(user: User) {
  const plan = getPlusMonthlyPlan();
  const existingOrder = await getReusablePendingOrder(user.id, plan.productCode, plan.amountCents);
  const order = existingOrder ?? await createPaymentOrder(user.id, plan);

  return {
    order: publicOrder(order),
    paymentHtml: buildPaymentHtml(order)
  };
}

export async function handleAlipayNotify(params: AlipayNotifyParams) {
  const sdk = getAlipaySdk();
  if (!sdk.checkNotifySignV2(params)) {
    return false;
  }

  validateNotifyPayload(params);
  await syncOrderFromAlipayPayload(params.out_trade_no, {
    tradeNo: params.trade_no || null,
    tradeStatus: params.trade_status || null,
    totalAmount: params.total_amount || null,
    notifyId: params.notify_id || null,
    notifyPayload: params
  });
  return true;
}

export async function handleAlipayReturn(params: URLSearchParams) {
  const data = paramsToRecord(params);
  const outTradeNo = data.out_trade_no;
  if (!outTradeNo) {
    return { status: 'missing-order' };
  }

  const sdk = getAlipaySdk();
  const signVerified = sdk.checkNotifySign(data);
  if (!signVerified) {
    return { status: 'invalid-signature', outTradeNo };
  }

  const order = await queryAndSyncAlipayOrder(outTradeNo, data);
  return {
    status: order.status,
    outTradeNo,
    paid: order.status === 'paid'
  };
}

async function getReusablePendingOrder(userId: number, productCode: string, amountCents: number) {
  const rows = await sql<AlipayOrderRow[]>`
    SELECT
      id, user_id, out_trade_no, trade_no, product_code, subject, amount_cents,
      currency, status, alipay_trade_status, membership_start_at,
      membership_end_at, paid_at, created_at, updated_at
    FROM alipay_payment_orders
    WHERE user_id = ${userId}
      AND product_code = ${productCode}
      AND amount_cents = ${amountCents}
      AND status IN ('created', 'paying')
      AND created_at > NOW() - INTERVAL '30 minutes'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `;

  if (!rows[0]) return null;

  try {
    const synced = await queryAndSyncAlipayOrder(rows[0].out_trade_no);
    if (synced.status === 'paid') return synced;
    if (synced.status === 'closed' || synced.status === 'failed') return null;
    return synced;
  } catch {
    return rows[0];
  }
}

async function createPaymentOrder(
  userId: number,
  plan: ReturnType<typeof getPlusMonthlyPlan>
) {
  const outTradeNo = `OW${Date.now()}${userId}${randomUUID().replaceAll('-', '').slice(0, 18)}`;
  const rows = await sql<AlipayOrderRow[]>`
    INSERT INTO alipay_payment_orders (
      user_id, out_trade_no, product_code, subject, amount_cents, currency, status
    )
    VALUES (
      ${userId}, ${outTradeNo}, ${plan.productCode}, ${plan.subject},
      ${plan.amountCents}, 'CNY', 'created'
    )
    RETURNING
      id, user_id, out_trade_no, trade_no, product_code, subject, amount_cents,
      currency, status, alipay_trade_status, membership_start_at,
      membership_end_at, paid_at, created_at, updated_at
  `;
  return rows[0];
}

function buildPaymentHtml(order: AlipayOrderRow) {
  const sdk = getAlipaySdk();
  const appUrl = getAppUrl();

  return sdk.pageExec('alipay.trade.page.pay', 'POST', {
    notifyUrl: `${appUrl}/api/v1/billing/alipay/notify`,
    returnUrl: `${appUrl}/api/v1/billing/alipay/return`,
    bizContent: {
      out_trade_no: order.out_trade_no,
      total_amount: formatCnyAmount(order.amount_cents),
      subject: order.subject,
      body: 'OpenWook Plus monthly membership',
      product_code: 'FAST_INSTANT_TRADE_PAY',
      timeout_express: '30m'
    }
  });
}

async function queryAndSyncAlipayOrder(outTradeNo: string, returnPayload?: Record<string, string>) {
  const result = await getAlipaySdk().exec(
    'alipay.trade.query',
    {
      bizContent: {
        out_trade_no: outTradeNo,
        query_options: ['fund_bill_list']
      }
    },
    { validateSign: true }
  );

  return syncOrderFromAlipayPayload(outTradeNo, {
    tradeNo: typeof result.trade_no === 'string' ? result.trade_no : null,
    tradeStatus: typeof result.trade_status === 'string' ? result.trade_status : null,
    totalAmount: typeof result.total_amount === 'string' ? result.total_amount : null,
    queryPayload: result,
    returnPayload
  });
}

async function syncOrderFromAlipayPayload(
  outTradeNo: string,
  data: {
    tradeNo?: string | null;
    tradeStatus?: string | null;
    totalAmount?: string | null;
    notifyId?: string | null;
    notifyPayload?: Record<string, string>;
    queryPayload?: unknown;
    returnPayload?: Record<string, string>;
  }
) {
  return sql.begin(async (tx) => {
    const rows = await tx<AlipayOrderRow[]>`
      SELECT
        id, user_id, out_trade_no, trade_no, product_code, subject, amount_cents,
        currency, status, alipay_trade_status, membership_start_at,
        membership_end_at, paid_at, created_at, updated_at
      FROM alipay_payment_orders
      WHERE out_trade_no = ${outTradeNo}
      FOR UPDATE
    `;
    const order = rows[0];
    if (!order) throw new ApiError(404, 'ALIPAY_ORDER_NOT_FOUND', 'Alipay order not found');

    if (data.totalAmount && amountToCents(data.totalAmount) !== Number(order.amount_cents)) {
      throw new ApiError(400, 'ALIPAY_AMOUNT_MISMATCH', 'Alipay amount does not match the local order');
    }

    if (order.status === 'paid') {
      return order;
    }

    const tradeStatus = data.tradeStatus;
    if (tradeStatus && paidTradeStatuses.has(tradeStatus)) {
      return markOrderPaid(tx, order, data);
    }

    const nextStatus = tradeStatus === 'WAIT_BUYER_PAY'
      ? 'paying'
      : tradeStatus === 'TRADE_CLOSED'
        ? 'closed'
        : order.status;

    const updated = await tx<AlipayOrderRow[]>`
      UPDATE alipay_payment_orders
      SET
        trade_no = COALESCE(${data.tradeNo ?? null}, trade_no),
        status = ${nextStatus},
        alipay_trade_status = COALESCE(${tradeStatus ?? null}, alipay_trade_status),
        notify_id = COALESCE(${data.notifyId ?? null}, notify_id),
        notify_payload = COALESCE(${data.notifyPayload ? tx.json(data.notifyPayload) : null}, notify_payload),
        query_payload = COALESCE(${data.queryPayload ? tx.json(data.queryPayload as never) : null}, query_payload),
        return_payload = COALESCE(${data.returnPayload ? tx.json(data.returnPayload) : null}, return_payload)
      WHERE id = ${order.id}
      RETURNING
        id, user_id, out_trade_no, trade_no, product_code, subject, amount_cents,
        currency, status, alipay_trade_status, membership_start_at,
        membership_end_at, paid_at, created_at, updated_at
    `;
    return updated[0];
  });
}

async function markOrderPaid(
  tx: postgres.TransactionSql,
  order: AlipayOrderRow,
  data: {
    tradeNo?: string | null;
    tradeStatus?: string | null;
    notifyId?: string | null;
    notifyPayload?: Record<string, string>;
    queryPayload?: unknown;
    returnPayload?: Record<string, string>;
  }
) {
  const userRows = await tx<Array<{ plus_expires_at: string | Date | null }>>`
    SELECT plus_expires_at
    FROM users
    WHERE id = ${order.user_id}
    FOR UPDATE
  `;
  const now = new Date();
  const currentExpiry = userRows[0]?.plus_expires_at ? new Date(userRows[0].plus_expires_at) : null;
  const startsAt = currentExpiry && currentExpiry.getTime() > now.getTime() ? currentExpiry : now;
  const endsAt = addMonths(startsAt, 1);

  const updated = await tx<AlipayOrderRow[]>`
    UPDATE alipay_payment_orders
    SET
      trade_no = COALESCE(${data.tradeNo ?? null}, trade_no),
      status = 'paid',
      alipay_trade_status = COALESCE(${data.tradeStatus ?? null}, alipay_trade_status),
      notify_id = COALESCE(${data.notifyId ?? null}, notify_id),
      notify_payload = COALESCE(${data.notifyPayload ? tx.json(data.notifyPayload) : null}, notify_payload),
      query_payload = COALESCE(${data.queryPayload ? tx.json(data.queryPayload as never) : null}, query_payload),
      return_payload = COALESCE(${data.returnPayload ? tx.json(data.returnPayload) : null}, return_payload),
      paid_at = COALESCE(paid_at, ${now}),
      membership_start_at = COALESCE(membership_start_at, ${startsAt}),
      membership_end_at = COALESCE(membership_end_at, ${endsAt})
    WHERE id = ${order.id}
    RETURNING
      id, user_id, out_trade_no, trade_no, product_code, subject, amount_cents,
      currency, status, alipay_trade_status, membership_start_at,
      membership_end_at, paid_at, created_at, updated_at
  `;

  await tx`
    UPDATE users
    SET membership = 'plus',
        plus_expires_at = ${endsAt}
    WHERE id = ${order.user_id}
  `;
  await invalidateUserCache(order.user_id);
  return updated[0];
}

function validateNotifyPayload(params: AlipayNotifyParams) {
  const config = getAlipayConfig();
  if (params.app_id !== config.appId) {
    throw new ApiError(400, 'ALIPAY_APP_ID_MISMATCH', 'Alipay app_id does not match local config');
  }
  if (params.seller_id && config.pid && params.seller_id !== config.pid) {
    throw new ApiError(400, 'ALIPAY_SELLER_MISMATCH', 'Alipay seller_id does not match local config');
  }
  if (!params.out_trade_no) {
    throw new ApiError(400, 'ALIPAY_OUT_TRADE_NO_MISSING', 'Alipay notify payload is missing out_trade_no');
  }
}

function getAlipaySdk() {
  const config = getAlipayConfig();
  return new AlipaySdk({
    appId: config.appId,
    privateKey: config.privateKey,
    alipayPublicKey: config.alipayPublicKey,
    gateway: config.gateway,
    signType: 'RSA2',
    keyType: 'PKCS1',
    charset: 'utf-8',
    version: '1.0',
    camelcase: false
  });
}

function getAlipayConfig() {
  const appId = process.env.ALIPAY_APP_ID;
  const privateKey = process.env.ALIPAY_PRIVATE_KEY;
  const alipayPublicKey = process.env.ALIPAY_PUBLIC_KEY;
  if (!appId || !privateKey || !alipayPublicKey) {
    throw new ApiError(500, 'ALIPAY_NOT_CONFIGURED', 'Alipay environment variables are not configured');
  }

  return {
    appId,
    privateKey,
    alipayPublicKey,
    gateway: alipayGateway,
    pid: process.env.ALIPAY_PID || null
  };
}

function getAppUrl() {
  const value = process.env.NEXT_PUBLIC_APP_URL || process.env.BASE_URL;
  if (!value) {
    throw new ApiError(500, 'APP_URL_NOT_CONFIGURED', 'NEXT_PUBLIC_APP_URL or BASE_URL is required for Alipay callbacks');
  }
  return value.replace(/\/$/, '');
}

function publicOrder(order: AlipayOrderRow) {
  return {
    id: order.id,
    outTradeNo: order.out_trade_no,
    subject: order.subject,
    amount: formatCnyAmount(order.amount_cents),
    status: order.status,
    alipayTradeStatus: order.alipay_trade_status,
    paidAt: order.paid_at,
    membershipEndAt: order.membership_end_at
  };
}

function formatCnyAmount(amountCents: number) {
  return (amountCents / 100).toFixed(2);
}

function amountToCents(value: string) {
  const normalized = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const [yuan, fraction = ''] = normalized.split('.');
  return Number(yuan) * 100 + Number(fraction.padEnd(2, '0'));
}

function paramsToRecord(params: URLSearchParams) {
  const data: Record<string, string> = {};
  params.forEach((value, key) => {
    data[key] = value;
  });
  return data;
}

function addMonths(value: Date, months: number) {
  const next = new Date(value);
  next.setMonth(next.getMonth() + months);
  return next;
}
