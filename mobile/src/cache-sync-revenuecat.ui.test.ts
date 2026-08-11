// cache.ts + db.ts + sync.ts + revenuecat.ts tests over the in-memory SQLite
// substitute (expo-sqlite moduleNameMapper) and mocked native modules.

// ------------------------------------------------------------------ cache
import { getDb } from './practiq/db';
import { MIRROR_TABLES } from './practiq/mirror-schema';
import {
  clearCloudCache,
  completeMutation,
  createMutationKey,
  enqueueMutation,
  failMutation,
  outboxCounts,
  pendingMutations,
  readResource,
  retryFailedMutations,
  writeResource,
} from './practiq/cache';

jest.mock('expo-file-system', () => ({
  Directory: class {
    exists = false;
    delete() { /* no-op */ }
  },
  Paths: { document: 'document' },
}));

beforeEach(async () => {
  const db = await getDb();
  await db.execAsync(`
    DELETE FROM resources;
    DELETE FROM outbox;
    DELETE FROM sync_state;
    ${MIRROR_TABLES.map((table) => `DELETE FROM ${table};`).join('\n    ')}
  `);
});

describe('cache', () => {
  it('round-trips resources and treats broken JSON as missing', async () => {
    expect(await readResource('missing')).toBeNull();
    await writeResource('k1', { a: 1 });
    expect(await readResource('k1')).toEqual({ a: 1 });
    await writeResource('k1', { a: 2 }); // upsert
    expect(await readResource('k1')).toEqual({ a: 2 });
    const db = await getDb();
    await db.runAsync("INSERT INTO resources(key, payload) VALUES ('bad', 'not-json')");
    expect(await readResource('bad')).toBeNull();
  });

  it('enqueues mutations with unique keys and lists pending work', async () => {
    const key1 = createMutationKey();
    const key2 = createMutationKey();
    expect(key1).not.toBe(key2);
    await enqueueMutation('POST', '/api/v1/banks', { name: 'B' });
    await enqueueMutation('DELETE', '/api/v1/banks/1', undefined, key2);
    await enqueueMutation('POST', '/api/v1/banks', { name: 'dup' }, key2); // INSERT OR IGNORE
    const pending = await pendingMutations();
    expect(pending).toHaveLength(2);
    expect(pending[0].body_json).toBe('{"name":"B"}');
    expect(pending[1].body_json).toBeNull();
    expect(await outboxCounts()).toEqual({ pending: 2, failed: 0 });
  });

  it('completes, fails, and retries mutations', async () => {
    await enqueueMutation('POST', '/p', { x: 1 });
    const [first] = await pendingMutations();
    await completeMutation(first.id);
    expect(await pendingMutations()).toHaveLength(0);
    await enqueueMutation('POST', '/p', { x: 2 });
    const [second] = await pendingMutations();
    await failMutation(second.id, 'boom');
    expect(await outboxCounts()).toEqual({ pending: 0, failed: 1 });
    await retryFailedMutations();
    expect(await outboxCounts()).toEqual({ pending: 1, failed: 0 });
    const revived = await pendingMutations();
    expect(revived[0].last_error).toBeNull();
  });

  it('clearCloudCache wipes mirror tables but keeps the language preference', async () => {
    await writeResource('setting:language', 'zh-CN');
    await writeResource('other', 1);
    await enqueueMutation('POST', '/p', {});
    await getDb().then(async (db) => {
      await db.execAsync('INSERT INTO subjects(subject_id, display_name) VALUES (\'math\', \'数学\')');
    });
    await clearCloudCache();
    expect(await readResource('setting:language')).toBe('zh-CN');
    expect(await readResource('other')).toBeNull();
    expect(await pendingMutations()).toHaveLength(0);
    expect(await (await getDb()).getAllAsync('SELECT * FROM subjects')).toHaveLength(0);
  });
});

// --------------------------------------------------------------------- db

describe('db', () => {
  it('migrates to the latest user_version and memoizes the instance', async () => {
    const db = await getDb();
    const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    expect(version?.user_version).toBe(MIRROR_TABLES.length > 0 ? 2 : 2);
    const again = await getDb();
    expect(again).toBe(db);
  });
});

// ------------------------------------------------------------------- sync
import { pullGlobalUpdates } from './practiq/sync';

const mockApiRequestPage = jest.fn<any, any[]>();

jest.mock('./practiq/api', () => ({
  apiRequestPage: (...args: unknown[]) => mockApiRequestPage(...args),
}));

describe('sync', () => {
  beforeEach(() => {
    mockApiRequestPage.mockReset();
  });

  it('pulls banks across pages and advances the anchor', async () => {
    const bankRow = (id: number, updatedAt: string) => ({
      id, name: 'B', description: null, subject: 'math', total_count: 0,
      is_public: false, updated_at: updatedAt,
    });
    const sessionRow = {
      id: 5, bank_id: 1, session_type: 'practice', status: 'active',
      question_count: 1, answered_count: 0, correct_count: 0, wrong_count: 0,
      score: null, started_at: '2026-08-03T00:00:00.000Z', completed_at: null,
    };
    mockApiRequestPage
      .mockResolvedValueOnce({ data: [bankRow(1, '2026-08-01T00:00:00.000Z')], cursor: 'c1', hasMore: true, limit: 100 })
      .mockResolvedValueOnce({ data: [bankRow(2, '2026-08-02T00:00:00.000Z')], cursor: '', hasMore: false, limit: 100 })
      .mockResolvedValueOnce({ data: [sessionRow], cursor: '', hasMore: false, limit: 100 });
    await pullGlobalUpdates(9);
    expect(mockApiRequestPage).toHaveBeenCalledTimes(3);
    expect(mockApiRequestPage.mock.calls[0][0]).toBe('/api/v1/banks?scope=all&limit=100');
    expect(mockApiRequestPage.mock.calls[1][0]).toContain('cursor=c1');
    const banks = await (await getDb()).getAllAsync<{ id: number }>('SELECT id FROM question_banks ORDER BY id');
    expect(banks).toEqual([{ id: 1 }, { id: 2 }]);
    const anchor = await (await getDb()).getFirstAsync<{ synced_at: string }>('SELECT synced_at FROM sync_state WHERE scope = ?', 'banks');
    expect(anchor?.synced_at).toBe('2026-08-02T00:00:00.000Z');
  });

  it('does not regress the anchor and swallows per-scope failures', async () => {
    mockApiRequestPage
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ data: [], cursor: '', hasMore: false, limit: 100 });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await pullGlobalUpdates(9); // banks fails, sessions still runs
    expect(mockApiRequestPage).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalled();
    const anchors = await (await getDb()).getAllAsync('SELECT * FROM sync_state');
    expect(anchors).toHaveLength(0); // empty batch -> no anchor write
    warn.mockRestore();
  });
});

// ------------------------------------------------------------- revenuecat
import { Platform } from 'react-native';
import {
  REVENUECAT_ENTITLEMENT_ID,
  customerHasPro,
  identifyRevenueCat,
  listenForCustomerInfo,
  presentProPaywall,
  presentRevenueCatCustomerCenter,
  restoreRevenueCatPurchases,
} from './practiq/revenuecat';

jest.mock('react-native-purchases', () => ({
  __esModule: true,
  LOG_LEVEL: { DEBUG: 'debug' },
  default: {
    isConfigured: jest.fn<any, any[]>(async () => false),
    configure: jest.fn<any, any[]>(),
    setLogLevel: jest.fn<any, any[]>(),
    logIn: jest.fn<any, any[]>(async () => ({})),
    getCustomerInfo: jest.fn<any, any[]>(async () => ({ entitlements: { active: {} } })),
    addCustomerInfoUpdateListener: jest.fn<any, any[]>(() => 1),
    removeCustomerInfoUpdateListener: jest.fn<any, any[]>(),
    restorePurchases: jest.fn<any, any[]>(async () => ({ entitlements: { active: {} } })),
  },
}));

jest.mock('react-native-purchases-ui', () => ({
  __esModule: true,
  default: {
    presentPaywallIfNeeded: jest.fn<any, any[]>(async () => undefined),
    presentCustomerCenter: jest.fn<any, any[]>(async () => undefined),
  },
}));

describe('revenuecat', () => {
  const Purchases = jest.requireMock('react-native-purchases').default;
  const RevenueCatUI = jest.requireMock('react-native-purchases-ui').default;

  it('detects the pro entitlement', () => {
    expect(customerHasPro({ entitlements: { active: { pro: {} } } } as never)).toBe(true);
    expect(customerHasPro({ entitlements: { active: {} } } as never)).toBe(false);
    expect(customerHasPro(null)).toBe(false);
    expect(REVENUECAT_ENTITLEMENT_ID).toBe('pro');
  });

  it('configures on first identify and logs in for a different user', async () => {
    process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY = 'ios-key';
    Purchases.isConfigured.mockResolvedValueOnce(false);
    await identifyRevenueCat('user-1');
    expect(Purchases.configure).toHaveBeenCalledWith({ apiKey: expect.any(String), appUserID: 'user-1' });
    Purchases.isConfigured.mockResolvedValueOnce(true);
    await identifyRevenueCat('user-2');
    expect(Purchases.logIn).toHaveBeenCalledWith('user-2');
    Purchases.isConfigured.mockResolvedValueOnce(true);
    await identifyRevenueCat('user-2'); // same user: no logIn
    expect(Purchases.logIn).toHaveBeenCalledTimes(1);
  });

  it('throws when the platform API key is missing', async () => {
    const original = Platform.OS;
    Platform.OS = 'ios' as never;
    delete process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY;
    await expect(identifyRevenueCat('user-1')).rejects.toThrow('RevenueCat is not configured');
    Platform.OS = original;
  });

  it('wires listeners and delegates paywall/restore/customer-center calls', async () => {
    const listener = jest.fn<any, any[]>();
    const remove = listenForCustomerInfo(listener);
    expect(Purchases.addCustomerInfoUpdateListener).toHaveBeenCalledWith(listener);
    remove();
    expect(Purchases.removeCustomerInfoUpdateListener).toHaveBeenCalledWith(listener);
    await presentProPaywall();
    expect(RevenueCatUI.presentPaywallIfNeeded).toHaveBeenCalledWith({ requiredEntitlementIdentifier: 'pro' });
    await restoreRevenueCatPurchases();
    expect(Purchases.restorePurchases).toHaveBeenCalled();
    await presentRevenueCatCustomerCenter();
    expect(RevenueCatUI.presentCustomerCenter).toHaveBeenCalled();
  });
});
