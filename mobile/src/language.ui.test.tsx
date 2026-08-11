import { act, render } from '@testing-library/react-native';
import { HeroUINativeProvider } from 'heroui-native/provider';
import { Typography } from 'heroui-native/text';

import { LanguageProvider, useLanguage } from './language';

// heroui-native ships ESM modules that fail to load under
// --experimental-vm-modules; stub the two subpaths this test touches.
jest.mock('heroui-native/provider', () => ({
  HeroUINativeProvider: ({ children }: { children: unknown }) => children,
}));

jest.mock('heroui-native/text', () => {
  const { Text } = require('react-native');
  const Typography: any = ({ children }: any) => <Text>{children}</Text>;
  Typography.Heading = Typography;
  return { Typography };
});

const mockReadResource = jest.fn<any, any[]>();

jest.mock('./practiq/cache', () => ({
  readResource: (...args: unknown[]) => mockReadResource(...args),
  writeResource: jest.fn<any, any[]>(),
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
    let resolveLanguage: (value: string) => void = () => undefined;
    mockReadResource.mockReturnValue(new Promise((resolve) => {
      resolveLanguage = resolve;
    }));
    const screen = await render(
      <HeroUINativeProvider config={{ devInfo: { stylingPrinciples: false } }}>
        <LanguageProvider>
          <LanguageProbe />
        </LanguageProvider>
      </HeroUINativeProvider>,
    );

    // Startup no longer blocks on the cache read: content renders with the
    // system-derived default before the persisted language resolves.
    screen.getByText('en');
    expect(screen.queryByText('zh-CN')).toBeNull();

    await act(async () => resolveLanguage('zh-CN'));

    await screen.findByText('zh-CN');
    expect(screen.queryByText('en')).toBeNull();
  });
});
