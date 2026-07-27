import { act, renderHook, waitFor } from '@testing-library/react-native';

import { invalidateDatabaseQueries, useLiveQuery, writeTransaction } from './database';

const mockGetAllAsync = jest.fn();
const mockDatabase = {
  databasePath: '/data/application.db',
  getAllAsync: mockGetAllAsync,
};

jest.mock('expo-sqlite', () => ({
  useSQLiteContext: () => mockDatabase,
}));

describe('database query invalidation', () => {
  beforeEach(() => {
    mockGetAllAsync.mockReset();
  });

  it('refetches mounted live queries after a database restore', async () => {
    mockGetAllAsync
      .mockResolvedValueOnce([{ value: 'before' }])
      .mockResolvedValueOnce([{ value: 'after' }]);
    const hook = await renderHook(() => (
      useLiveQuery<{ value: string }>('SELECT value FROM settings', [], ['settings'])
    ));

    await waitFor(() => expect(hook.result.current.data).toEqual([{ value: 'before' }]));

    await act(() => {
      invalidateDatabaseQueries();
    });

    await waitFor(() => expect(hook.result.current.data).toEqual([{ value: 'after' }]));
    expect(mockGetAllAsync).toHaveBeenCalledTimes(2);
    await hook.unmount();
  });

  it('only refetches queries subscribed to changed tables', async () => {
    mockGetAllAsync.mockResolvedValue([{ value: 'row' }]);
    const hook = await renderHook(() => (
      useLiveQuery<{ value: string }>('SELECT value FROM settings', [], ['settings'])
    ));
    await waitFor(() => expect(hook.result.current.data).toEqual([{ value: 'row' }]));

    await act(() => invalidateDatabaseQueries(['other']));
    expect(mockGetAllAsync).toHaveBeenCalledTimes(1);

    await act(() => invalidateDatabaseQueries(['settings']));
    await waitFor(() => expect(mockGetAllAsync).toHaveBeenCalledTimes(2));
    await hook.unmount();
  });

  it('does not run or subscribe a disabled live query', async () => {
    mockGetAllAsync.mockResolvedValue([{ value: 'row' }]);
    const hook = await renderHook(() => (
      useLiveQuery<{ value: string }>('SELECT value FROM settings', [], ['settings'], { enabled: false })
    ));

    expect(hook.result.current.loading).toBe(false);
    expect(mockGetAllAsync).not.toHaveBeenCalled();
    await act(() => invalidateDatabaseQueries(['settings']));
    expect(mockGetAllAsync).not.toHaveBeenCalled();
    await hook.unmount();
  });

  it('invalidates once after a checked write transaction commits', async () => {
    const order: string[] = [];
    const transaction = {
      execAsync: jest.fn(async () => { order.push('busy-timeout'); }),
      getFirstAsync: jest.fn(async () => ({ foreign_keys: 1 })),
    };
    const db = {
      withExclusiveTransactionAsync: async (work: (value: typeof transaction) => Promise<void>) => {
        order.push('begin');
        await work(transaction);
        order.push('commit');
      },
    };
    mockGetAllAsync.mockResolvedValue([{ value: 'row' }]);
    const hook = await renderHook(() => (
      useLiveQuery<{ value: string }>('SELECT value FROM settings', [], ['settings'])
    ));
    await waitFor(() => expect(mockGetAllAsync).toHaveBeenCalledTimes(1));

    await act(async () => {
      await writeTransaction(
        db as never,
        ['settings'],
        async () => { order.push('write'); },
      );
    });

    await waitFor(() => expect(mockGetAllAsync).toHaveBeenCalledTimes(2));
    expect(order).toEqual(['begin', 'busy-timeout', 'write', 'commit']);
    await hook.unmount();
  });
});
