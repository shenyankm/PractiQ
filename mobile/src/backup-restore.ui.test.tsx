const mockPickFileAsync = jest.fn();

jest.mock('expo-file-system', () => ({
  File: class MockFile {
    static pickFileAsync(...args: unknown[]) {
      return mockPickFileAsync(...args);
    }
  },
  Directory: class MockDirectory {},
  FileMode: { ReadOnly: 'read-only' },
  Paths: {
    cache: { uri: 'file:///cache/' },
    document: { uri: 'file:///documents/', list: () => [] },
  },
}));

jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async () => undefined),
}));

jest.mock('./database', () => ({
  SQLITE_OPEN_OPTIONS: {},
}));

import { restoreDatabase } from './files/backup';

describe('backup restore entry guards', () => {
  beforeEach(() => {
    mockPickFileAsync.mockReset();
  });

  it('blocks normal restore while an import is queued', async () => {
    const database = {
      getFirstAsync: jest.fn(async () => ({ count: 1 })),
    };

    await expect(restoreDatabase(database as never)).rejects.toThrow(/等待或取消.*导入任务/);
    expect(mockPickFileAsync).not.toHaveBeenCalled();
  });

  it('treats picker cancellation as a no-op and lets recovery mode skip the import gate', async () => {
    mockPickFileAsync.mockResolvedValue({ canceled: true });
    const normal = {
      getFirstAsync: jest.fn(async () => ({ count: 0 })),
    };
    await expect(restoreDatabase(normal as never)).resolves.toBe(false);
    expect(normal.getFirstAsync).toHaveBeenCalledTimes(1);

    const recovery = {
      getFirstAsync: jest.fn(async () => ({ count: 1 })),
    };
    await expect(restoreDatabase(recovery as never, { recoveryMode: true })).resolves.toBe(false);
    expect(recovery.getFirstAsync).not.toHaveBeenCalled();
  });
});
