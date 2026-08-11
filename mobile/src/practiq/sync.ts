// 云端增量同步:banks / practice-sessions 按 sync_state 锚点拉取 updated_since 之后的变化。
// 题库内容(items/groups)不走增量,由屏幕 focus 全量拉取 + replaceBankScope reconcile 覆盖。
import { apiRequestPage } from './api';
import { getSyncAnchor, setSyncAnchor, upsertBanks, upsertSessions } from './mirror';
import { banksSchema, practiceSessionsSchema, type Bank, type PracticeSession } from './types';

// 服务端时间戳统一为 ISO 毫秒 Z 格式,字典序比较即可
function maxTimestamp(values: (string | undefined)[]): string | null {
  let max: string | null = null;
  for (const value of values) {
    if (value && (!max || value > max)) max = value;
  }
  return max;
}

async function pullBanks(userId: number) {
  const scope = 'banks';
  const anchor = await getSyncAnchor(scope);
  // scope=all 一次覆盖 mine+favorites+public 可见范围;updated_since 为含边界比较
  // (updated_at >= since),末行会重复拉取,upsert 幂等无害
  const base = `/api/v1/banks?scope=all&limit=100${anchor ? `&updated_since=${encodeURIComponent(anchor)}` : ''}`;
  let cursor = '';
  let next = anchor;
  for (;;) {
    const page = await apiRequestPage<Bank[]>(
      cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base,
      { schema: banksSchema },
    );
    await upsertBanks(page.data, userId);
    const batchMax = maxTimestamp(page.data.map((bank) => bank.updated_at));
    if (batchMax && (!next || batchMax > next)) next = batchMax;
    if (!page.hasMore || !page.cursor) break;
    cursor = page.cursor;
  }
  // 空批或未推进不写锚点
  if (next && next !== anchor) await setSyncAnchor(scope, next);
}

async function pullSessions(userId: number) {
  const scope = 'practice-sessions';
  const anchor = await getSyncAnchor(scope);
  const base = `/api/v1/practice-sessions?limit=100${anchor ? `&updated_since=${encodeURIComponent(anchor)}` : ''}`;
  let cursor = '';
  let next = anchor;
  for (;;) {
    const page = await apiRequestPage<PracticeSession[]>(
      cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base,
      { schema: practiceSessionsSchema },
    );
    await upsertSessions(page.data, userId);
    // 服务端按 updated_at 过滤但响应不含 updated_at,锚点用 started_at 近似推进:
    // started_at <= updated_at 恒成立,近似只会多拉(幂等无害)不会漏拉
    const batchMax = maxTimestamp(page.data.map((session) => session.started_at));
    if (batchMax && (!next || batchMax > next)) next = batchMax;
    if (!page.hasMore || !page.cursor) break;
    cursor = page.cursor;
  }
  if (next && next !== anchor) await setSyncAnchor(scope, next);
}

export async function pullGlobalUpdates(userId: number): Promise<void> {
  // 单 scope 失败不阻塞另一个,只记录不抛出
  await pullBanks(userId).catch((reason) => {
    console.warn('[sync] banks 增量拉取失败:', reason instanceof Error ? reason.message : reason);
  });
  await pullSessions(userId).catch((reason) => {
    console.warn('[sync] practice-sessions 增量拉取失败:', reason instanceof Error ? reason.message : reason);
  });
}
