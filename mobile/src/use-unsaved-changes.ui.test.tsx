import { act, renderHook } from '@testing-library/react-native';
import { Alert } from 'react-native';

import { useUnsavedChanges } from './use-unsaved-changes';

type BeforeRemoveEvent = {
  preventDefault: () => void;
  data: { action: { type: string } };
};

let mockBeforeRemove: ((event: BeforeRemoveEvent) => void) | undefined;
const mockRemoveListener = jest.fn();
const mockNavigation = {
  addListener: jest.fn((_event: string, listener: (event: BeforeRemoveEvent) => void) => {
    mockBeforeRemove = listener;
    return mockRemoveListener;
  }),
  dispatch: jest.fn(),
};

jest.mock('expo-router', () => ({
  useNavigation: () => mockNavigation,
}));

jest.mock('@/language', () => ({
  useLanguage: () => ({
    tr: (english: string) => english,
  }),
}));

describe('useUnsavedChanges', () => {
  it('blocks navigation until the user confirms discarding edits', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const { unmount } = await renderHook(() => useUnsavedChanges(true));
    const action = { type: 'GO_BACK' };
    const preventDefault = jest.fn();

    await act(() => {
      mockBeforeRemove?.({ preventDefault, data: { action } });
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledTimes(1);
    const buttons = alert.mock.calls[0][2];
    const discard = buttons?.find((button) => button.style === 'destructive');
    expect(discard).toBeDefined();

    await act(async () => {
      discard?.onPress?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mockNavigation.dispatch).toHaveBeenCalledWith(action);
    await unmount();
    expect(mockRemoveListener).toHaveBeenCalledTimes(1);
  });
});
