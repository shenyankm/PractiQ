import { act, render } from '@testing-library/react-native';
import { HeroUINativeProvider } from 'heroui-native/provider';
import { Typography } from 'heroui-native/text';

import { LanguageProvider, useLanguage } from './language';

const mockGetFirstAsync = jest.fn();

jest.mock('expo-sqlite', () => ({
  useSQLiteContext: () => ({
    getFirstAsync: mockGetFirstAsync,
    runAsync: jest.fn(),
  }),
}));

// Pin the system-derived default so the test does not depend on the host locale.
jest.mock('./i18n', () => {
  const actual = jest.requireActual('./i18n');
  return { ...actual, systemLanguage: () => 'en' };
});

function LanguageProbe() {
  return <Typography>{useLanguage().language}</Typography>;
}

describe('LanguageProvider', () => {
  it('renders content immediately and reconciles to the persisted language', async () => {
    let resolveLanguage: (row: { value: string }) => void = () => undefined;
    mockGetFirstAsync.mockReturnValue(new Promise((resolve) => {
      resolveLanguage = resolve;
    }));
    const screen = await render(
      <HeroUINativeProvider config={{ devInfo: { stylingPrinciples: false } }}>
        <LanguageProvider>
          <LanguageProbe />
        </LanguageProvider>
      </HeroUINativeProvider>,
    );

    // Startup no longer blocks on the database read: content renders with the
    // system-derived default before the persisted language resolves.
    screen.getByText('en');
    expect(screen.queryByText('zh-CN')).toBeNull();

    await act(async () => resolveLanguage({ value: 'zh-CN' }));

    await screen.findByText('zh-CN');
    expect(screen.queryByText('en')).toBeNull();
  });
});
